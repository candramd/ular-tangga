#!/usr/bin/env python3
"""Restore a private snapshot into a disposable loopback PostgreSQL database.

This exercises the legacy Go service as the only writer. It never targets a
non-loopback database and prints only aggregate counts and SHA-256 digests.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


ROOT = pathlib.Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    raise RuntimeError(message)


def run(args: list[str], *, input_text: str | None = None, env=None, capture=False, cwd=None):
    try:
        result = subprocess.run(
            args,
            input=input_text,
            text=True,
            env=env,
            cwd=cwd,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        return result.stdout if capture else None
    except (subprocess.CalledProcessError, OSError):
        fail("a local rehearsal command failed; details were suppressed to protect snapshot contents")


def psql(database: str, sql: str, *, env, capture=False) -> str:
    return run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-d", database], input_text=sql, env=env, capture=capture) or ""


def postgres_env(parsed):
    env = os.environ.copy()
    # Do not let ambient libpq service, hostaddr, or other PG* settings reroute
    # the connection away from the loopback hostname validated above.
    for key in tuple(env):
        if key.startswith("PG"):
            env.pop(key, None)
    env["PGHOST"] = parsed.hostname
    env["PGPORT"] = str(parsed.port or 5432)
    env["PGUSER"] = urllib.parse.unquote(parsed.username or "postgres")
    env["PGPASSWORD"] = urllib.parse.unquote(parsed.password or "")
    env["PGDATABASE"] = urllib.parse.unquote(parsed.path.lstrip("/"))
    allowed = {
        "application_name", "channel_binding", "connect_timeout", "gssencmode",
        "keepalives", "keepalives_count", "keepalives_idle", "keepalives_interval",
        "options", "sslcert", "sslcrl", "sslcrldir", "sslkey", "sslmode",
        "sslrootcert", "target_session_attrs", "tcp_user_timeout",
    }
    for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True):
        if key not in allowed:
            fail("unsupported PostgreSQL URL option for local rehearsal")
        env["PG" + key.upper()] = value
    return env


def request(url: str, method="GET", body=None, cookie=None):
    headers = {"Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read()


def wait_ready(proc, base_url):
    for _ in range(100):
        if proc.poll() is not None:
            fail("Go server exited during isolated restore")
        try:
            status, _, body = request(base_url + "/readyz")
            if status == 200 and json.loads(body).get("status") == "ready":
                return
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(0.1)
    fail("Go server did not become ready on the isolated database")


def start_server(binary, db_url):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    env = os.environ.copy()
    env.update({"DATABASE_URL": db_url, "ADDR": f"127.0.0.1:{port}", "ADMIN_SECRET": ""})
    log = tempfile.TemporaryFile()
    proc = None
    try:
        proc = subprocess.Popen([binary], cwd=ROOT / "server", env=env, stdout=log, stderr=log)
        base_url = f"http://127.0.0.1:{port}"
        wait_ready(proc, base_url)
        return proc, base_url, log
    except Exception:
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.terminate()
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            finally:
                log.close()
        else:
            log.close()
        raise


def stop_server(proc, log):
    try:
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    finally:
        log.close()
    if proc.returncode not in (0, -15):
        fail("Go server failed during the isolated round-trip")


def counts(state):
    return {
        "users": len(state.get("users") or {}),
        "rooms": len(state.get("rooms") or {}),
        "games": len(state.get("games") or {}),
        "questions": len(state.get("questions") or {}),
        "roster": len(state.get("localStudentRoster") or {}),
        "roster_owners": len(state.get("localStudentOwners") or {}),
    }


def main():
    if len(sys.argv) != 2:
        fail("usage: scripts/rehearse-go-rollback.py PRIVATE_SNAPSHOT.json")
    snapshot_path = pathlib.Path(sys.argv[1]).resolve()
    if not snapshot_path.is_file():
        fail("snapshot file is missing")
    root_url = os.environ.get("ROLLBACK_REHEARSAL_DATABASE_URL", "")
    parsed = urllib.parse.urlsplit(root_url)
    if parsed.scheme not in ("postgres", "postgresql") or parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        fail("set ROLLBACK_REHEARSAL_DATABASE_URL to a local loopback PostgreSQL maintenance database")
    if not all(shutil.which(tool) for tool in ("psql", "createdb", "dropdb", "go")):
        fail("psql, createdb, dropdb, and Go are required")

    with snapshot_path.open("r", encoding="utf-8") as stream:
        backup = json.load(stream)
    if not isinstance(backup, dict):
        fail("snapshot root must be a JSON object")
    state = backup.get("state", backup)
    if not isinstance(state, dict) or not all(isinstance(state.get(key), dict) for key in ("users", "sessions", "rooms", "games", "requests")):
        fail("snapshot does not have the expected Go server state structure")
    snapshot_version = backup.get("version", 1)
    if not isinstance(snapshot_version, int):
        fail("snapshot version is invalid")
    canonical = json.dumps(state, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    initial_digest = hashlib.sha256(canonical.encode()).hexdigest()

    db_name = "rollback_rehearsal_" + uuid.uuid4().hex[:12]
    isolated_url = urllib.parse.urlunsplit(parsed._replace(path="/" + db_name))
    cli_env = postgres_env(parsed)
    database_env = cli_env | {"PGDATABASE": db_name}

    database_created = False
    server_proc = None
    server_log = None
    try:
        run(["createdb", db_name], env=cli_env)
        database_created = True
        sql_literal = canonical.replace("'", "''")
        psql(db_name, """
CREATE TABLE public.ular_server_state (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
""" + f"INSERT INTO public.ular_server_state (id, version, state) VALUES (1, {snapshot_version}, '{sql_literal}'::jsonb);\n", env=database_env)
        restored_text = psql(db_name, "SELECT state::text FROM public.ular_server_state WHERE id=1;", env=database_env, capture=True).strip()
        restored_state = json.loads(restored_text)
        restored_digest = hashlib.sha256(json.dumps(restored_state, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
        restored_version = psql(db_name, "SELECT version FROM public.ular_server_state WHERE id=1;", env=database_env, capture=True).strip()
        if restored_digest != initial_digest or restored_version != str(snapshot_version) or counts(restored_state) != counts(state):
            fail("restored snapshot version, aggregate counts, or digest did not match the private input")
        with tempfile.TemporaryDirectory(prefix="ular-rollback-build-") as build_dir:
            binary = str(pathlib.Path(build_dir) / "ular-tangga-server")
            run(["go", "build", "-o", binary, "./cmd/server"], env=os.environ.copy(), cwd=ROOT / "server")
            server_proc, base_url, server_log = start_server(binary, isolated_url)
            status, _, _ = request(base_url + "/healthz")
            if status != 200:
                fail("restored Go server health check failed")
            stop_server(server_proc, server_log)
            server_proc = server_log = None

            # A real guest login writes through the Go store, including its
            # roster-key normalization, while this process owns the sole lock.
            server_proc, base_url, server_log = start_server(binary, isolated_url)
            status, headers, body = request(base_url + "/api/auth/guest", "POST", {
                "username": "Rollback rehearsal",
                "requestId": "rollback-rehearsal-" + uuid.uuid4().hex,
            })
            if status not in (200, 201):
                fail("isolated Go writer mutation failed")
            try:
                reply = json.loads(body)
            except ValueError:
                fail("isolated Go writer returned an invalid response")
            if reply.get("username") != "Rollback rehearsal" or not reply.get("id"):
                fail("isolated Go writer mutation was rejected")
            cookie = headers.get("Set-Cookie", "").split(";", 1)[0]
            if not cookie:
                fail("isolated Go writer did not return a resumable guest session")
            stop_server(server_proc, server_log)
            server_proc = server_log = None

            server_proc, base_url, server_log = start_server(binary, isolated_url)
            status, _, _ = request(base_url + "/api/profile", cookie=cookie)
            if status != 200:
                fail("persisted guest session did not survive the Go writer restart")
            persisted_text = psql(db_name, "SELECT state::text FROM public.ular_server_state WHERE id=1;", env=database_env, capture=True).strip()
            persisted_state = json.loads(persisted_text)
            persisted_counts = counts(persisted_state)
            if persisted_counts["users"] != counts(state)["users"] + 1:
                fail("snapshot user count did not survive one isolated Go write")
            if any("\x00" in key for key in persisted_state.get("localStudentRoster", {})):
                fail("legacy NUL roster key remained after Go restore/write")
            after_digest = hashlib.sha256(json.dumps(persisted_state, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
            version = psql(db_name, "SELECT version FROM public.ular_server_state WHERE id=1;", env=database_env, capture=True).strip()
            if version != str(snapshot_version):
                fail("snapshot version changed during Go writer round-trip")
            print(json.dumps({
                "result": "passed",
                "scope": "local disposable PostgreSQL; Go service as sole writer",
                "snapshot_version": snapshot_version,
                "snapshot_sha256": initial_digest,
                "restore_parity": True,
                "restored_sha256": restored_digest,
                "restored_counts": counts(restored_state),
                "round_trip_sha256": after_digest,
                "snapshot_counts": counts(state),
                "round_trip_counts": persisted_counts,
                "guest_session_survived_restart": True,
                "roster_keys_nul_free": True,
                "database_name": db_name,
            }, sort_keys=True))
    finally:
        cleanup_errors = []
        active_error = sys.exc_info()[0] is not None
        if server_proc is not None:
            try:
                stop_server(server_proc, server_log)
            except Exception:
                cleanup_errors.append("could not stop the isolated Go process")
        if database_created:
            try:
                run(["dropdb", "--force", db_name], env=cli_env)
            except Exception:
                cleanup_errors.append(f"could not remove disposable database {db_name}")
        if cleanup_errors:
            if active_error:
                print("rollback rehearsal cleanup warning: " + "; ".join(cleanup_errors), file=sys.stderr)
            else:
                fail("rollback rehearsal cleanup failed: " + "; ".join(cleanup_errors))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"rollback rehearsal failed: {error}", file=sys.stderr)
        sys.exit(1)
