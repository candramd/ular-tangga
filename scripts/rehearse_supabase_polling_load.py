#!/usr/bin/env python3
"""Run a bounded, synthetic Supabase RPC polling rehearsal on local PostgreSQL.

This script requires a numeric loopback host and creates/drops only a uniquely
named disposable database. It never reads the project .env or prints SQL data,
session tokens, response bodies, or database credentials.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import ipaddress
import json
import math
import os
import pathlib
import re
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
PREFIX = "ular_polling_"
END_MARKER = "__ULAR_POLL_DONE__"


def fail(message: str) -> None:
    raise RuntimeError(message)


def numeric_loopback(value: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        fail("host must be a numeric loopback IP address")
    if not address.is_loopback:
        fail("host must be a numeric loopback IP address")
    return str(address)


def libpq_env(host: str, port: int, user: str, database: str) -> dict[str, str]:
    """Use only explicit connection settings, ignoring inherited libpq routing."""
    env = os.environ.copy()
    for key in tuple(env):
        if key.startswith("PG"):
            env.pop(key, None)
    env.update({"PGHOST": numeric_loopback(host), "PGPORT": str(port), "PGUSER": user, "PGDATABASE": database, "PGCONNECT_TIMEOUT": "5"})
    return env


def command(args: list[str], *, env: dict[str, str], input_text: str | None = None, capture=False) -> str:
    try:
        result = subprocess.run(
            args, env=env, input=input_text, text=True, check=True,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=120,
        )
    except (OSError, subprocess.SubprocessError):
        fail("a local PostgreSQL rehearsal command failed; diagnostics were suppressed")
    return result.stdout if capture else ""


def psql(database: str, sql: str, *, env: dict[str, str], capture=False) -> str:
    return command(["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", database], env=env, input_text=sql, capture=capture).strip()


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def call_once(db: str, env: dict[str, str], path: str, method: str, body: dict, token: str | None, request_id: str | None = None, admin_token: str | None = None) -> dict:
    token_sql = sql_text(token) if token else "NULL"
    admin_sql = sql_text(admin_token) if admin_token else "NULL"
    request_sql = sql_text(request_id) if request_id else "NULL"
    body_sql = sql_text(json.dumps(body, separators=(",", ":"), ensure_ascii=False)) + "::jsonb"
    query = "SELECT public.ular_api(" + ",".join([
        sql_text(path), sql_text(method), body_sql, token_sql, admin_sql, request_sql,
    ]) + ")::text;"
    raw = psql(db, query, env=env, capture=True)
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        fail("synthetic RPC setup returned an invalid response")
    if not isinstance(value, dict):
        fail("synthetic RPC setup returned an unexpected envelope")
    return value


class PersistentPsql:
    """One real PostgreSQL connection per simulated browser client."""
    def __init__(self, database: str, env: dict[str, str]):
        self.proc = subprocess.Popen(
            ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", database],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )
        self.lock = threading.Lock()
        self.nonce = 0
        self._query("SET statement_timeout = '15s'; SELECT 1;")

    def _query(self, sql: str) -> str:
        if self.proc.poll() is not None or self.proc.stdin is None or self.proc.stdout is None:
            fail("a local benchmark PostgreSQL client exited")
        self.nonce += 1
        marker = END_MARKER + str(self.nonce)
        self.proc.stdin.write(sql + "\n\\echo " + marker + "\n")
        self.proc.stdin.flush()
        rows = []
        while True:
            line = self.proc.stdout.readline()
            if line == "":
                fail("a local benchmark PostgreSQL client closed unexpectedly")
            line = line.rstrip("\r\n")
            if line == marker:
                return "\n".join(rows)
            if line:
                rows.append(line)

    def rpc(self, path: str, token: str, body: dict, request_id: str, method: str = "POST") -> dict:
        with self.lock:
            query = "SELECT public.ular_api(" + ",".join([
                sql_text(path), sql_text(method), sql_text(json.dumps(body, separators=(",", ":"))) + "::jsonb",
                sql_text(token), "NULL", sql_text(request_id),
            ]) + ")::text;"
            try:
                return json.loads(self._query(query))
            except (ValueError, TypeError):
                fail("a local benchmark RPC returned an invalid envelope")

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write("\\q\n")
                self.proc.stdin.flush()
                self.proc.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=3)
        if self.proc.stdin:
            self.proc.stdin.close()
        if self.proc.stdout:
            self.proc.stdout.close()


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(p * len(ordered)) - 1)]


def summarize(name: str, elapsed: float, target_duration: float, interval: float, client_count: int, values: list[float], successful_values: list[float], errors_by_code: dict[str, int], gaps: list[float], staggered=False) -> dict:
    offsets = [interval * index / client_count if staggered else 0.0 for index in range(client_count)]
    expected = sum(math.ceil(max(0.0, target_duration - offset) / interval) for offset in offsets)
    return {
        "phase": name,
        "duration_seconds": round(elapsed, 2),
        "clients": client_count,
        "target_interval_ms": round(interval * 1000),
        "request_attempts": len(values),
        "successful_rpc_calls": len(successful_values),
        "ideal_target_calls_upper_bound": expected,
        "missed_polls_vs_ideal_upper_bound": max(0, expected - len(values)),
        "attempts_per_second": round(len(values) / elapsed, 2) if elapsed else 0,
        "successful_calls_per_second": round(len(successful_values) / elapsed, 2) if elapsed else 0,
        "attempt_latency_ms_all_responses_and_client_errors": {
            "p50": round(percentile(values, 0.50), 2),
            "p95": round(percentile(values, 0.95), 2),
            "max": round(max(values), 2) if values else 0,
        },
        "successful_envelope_latency_ms": {
            "p50": round(percentile(successful_values, 0.50), 2),
            "p95": round(percentile(successful_values, 0.95), 2),
            "max": round(max(successful_values), 2) if successful_values else 0,
        },
        "poll_start_gap_ms": {
            "mean": round(statistics.fmean(gaps), 2) if gaps else 0,
            "max": round(max(gaps), 2) if gaps else 0,
        },
        "envelope_errors": sum(errors_by_code.values()),
        "envelope_errors_by_code": dict(sorted(errors_by_code.items())),
        "successful_p95_within_1200ms_diagnostic_budget": percentile(successful_values, 0.95) <= 1200 if successful_values else False,
    }


def check_envelope(reply: dict, expected_code: str | None = None, context: str = "RPC") -> None:
    if expected_code:
        if reply.get("ok") is not False or reply.get("status") != 401 or reply.get("error", {}).get("code") != expected_code:
            fail("unauthenticated RPC was not rejected with the expected envelope")
    elif reply.get("ok") is not True:
        code = (reply.get("error") or {}).get("code", "UNKNOWN")
        status = reply.get("status", "UNKNOWN")
        fail(f"authenticated synthetic {context} RPC rejected (status={status}, code={code})")


def create_clients(db: str, env: dict[str, str], run_id: str, count: int) -> list[dict]:
    users = []
    for i in range(count):
        reply = call_once(db, env, "/auth/guest", "POST", {"username": f"Load Client {i:02d}"}, None, f"{run_id}-auth-{i}")
        check_envelope(reply)
        users.append({"token": reply["meta"]["sessionToken"], "id": reply["data"]["id"], "room_id": "", "room_status": "waiting", "sequence": 0})
    for i in range(0, count, 2):
        host, guest = users[i], users[i + 1]
        room = call_once(db, env, "/rooms", "POST", {}, host["token"], f"{run_id}-room-{i}")
        check_envelope(room)
        room_data = room["data"]
        room_id = room_data["id"]
        joined = call_once(db, env, f"/rooms/{room_data['code']}/join", "POST", {}, guest["token"], f"{run_id}-join-{i}")
        check_envelope(joined)
        for client in (host, guest):
            client["room_id"] = room_id
    return users


def start_games(db: str, env: dict[str, str], run_id: str, users: list[dict]) -> None:
    for i in range(0, len(users), 2):
        host = users[i]
        game = call_once(db, env, f"/rooms/{host['room_id']}/start", "POST", {}, host["token"], f"{run_id}-start-{i}")
        check_envelope(game)
        for client in users[i:i + 2]:
            client["game_id"] = game["data"]["id"]
            client["room_status"] = "playing"


def run_poll_phase(name: str, users: list[dict], db: str, env: dict[str, str], duration: float, interval: float, staggered=False) -> dict:
    clients = [PersistentPsql(db, env) for _ in users]
    start_barrier = threading.Barrier(len(users))
    phase_start = time.perf_counter()
    result_lock = threading.Lock()
    all_latencies: list[float] = []
    all_success_latencies: list[float] = []
    all_gaps: list[float] = []
    errors_by_code: dict[str, int] = {}

    def run_client(index, client, user):
        local_latencies = []
        local_success_latencies = []
        local_gaps = []
        prev_start = None
        path = f"/rooms/{user['room_id']}/sync"
        deadline = phase_start + duration
        try:
            start_barrier.wait(timeout=10)
            if staggered:
                time.sleep(interval * index / len(users))
            while time.perf_counter() < deadline:
                call_start = time.perf_counter()
                if prev_start is not None:
                    local_gaps.append((call_start - prev_start) * 1000)
                prev_start = call_start
                try:
                    reply = client.rpc(path, user["token"], {"afterSequence": user["sequence"], "gameId": user.get("game_id")}, f"poll-{uuid.uuid4().hex}")
                    if reply.get("ok") is True:
                        data = reply.get("data") or {}
                        user["sequence"] = max(user["sequence"], int(data.get("sequence", 0)))
                        local_success_latencies.append((time.perf_counter() - call_start) * 1000)
                    else:
                        code = str((reply.get("error") or {}).get("code", "UNKNOWN"))
                        with result_lock:
                            errors_by_code[code] = errors_by_code.get(code, 0) + 1
                    local_latencies.append((time.perf_counter() - call_start) * 1000)
                except Exception:
                    local_latencies.append((time.perf_counter() - call_start) * 1000)
                    with result_lock:
                        errors_by_code["CLIENT_ERROR"] = errors_by_code.get("CLIENT_ERROR", 0) + 1
                remaining = deadline - time.perf_counter()
                if remaining > 0:
                    time.sleep(min(interval, remaining))
        finally:
            client.close()
            with result_lock:
                all_latencies.extend(local_latencies)
                all_success_latencies.extend(local_success_latencies)
                all_gaps.extend(local_gaps)

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(users)) as pool:
            futures = [pool.submit(run_client, i, client, user) for i, (client, user) in enumerate(zip(clients, users))]
            for future in futures:
                future.result()
    finally:
        for client in clients:
            client.close()
    elapsed = time.perf_counter() - phase_start
    return summarize(name, elapsed, duration, interval, len(users), all_latencies, all_success_latencies, errors_by_code, all_gaps, staggered)


def run_reconnect_phase(users: list[dict], db: str, env: dict[str, str], rounds: int = 3) -> dict:
    latencies: list[float] = []
    successful_latencies: list[float] = []
    gaps: list[float] = []
    connect_times: list[float] = []
    errors_by_code: dict[str, int] = {}
    start = time.perf_counter()
    path_by_index = [f"/rooms/{user['room_id']}/sync" for user in users]

    def reconnect_one(i: int):
        user = users[i]
        connect_start = time.perf_counter()
        client = PersistentPsql(db, env)
        connected = time.perf_counter()
        response_start = time.perf_counter()
        try:
            reply = client.rpc(path_by_index[i], user["token"], {"afterSequence": user["sequence"], "gameId": user.get("game_id")}, f"reconnect-{uuid.uuid4().hex}")
            response_ms = (time.perf_counter() - response_start) * 1000
            if reply.get("ok") is True:
                user["sequence"] = max(user["sequence"], int((reply.get("data") or {}).get("sequence", 0)))
                return (response_ms, (connected - connect_start) * 1000, None, True)
            return (response_ms, (connected - connect_start) * 1000, str((reply.get("error") or {}).get("code", "UNKNOWN")), False)
        except Exception as exc:
            return ((time.perf_counter() - response_start) * 1000, (connected - connect_start) * 1000, "CLIENT_ERROR_" + type(exc).__name__, False)
        finally:
            client.close()

    for round_index in range(rounds):
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(users)) as pool:
            results = list(pool.map(reconnect_one, range(len(users))))
        latencies.extend(item[0] for item in results)
        successful_latencies.extend(item[0] for item in results if item[3])
        connect_times.extend(item[1] for item in results)
        for item in results:
            if item[2] is not None:
                errors_by_code[item[2]] = errors_by_code.get(item[2], 0) + 1
        if round_index + 1 < rounds:
            time.sleep(6.0)
    elapsed = time.perf_counter() - start
    record = summarize("reconnect", elapsed, (rounds - 1) * 6.0, 6.0, len(users) * rounds, latencies, successful_latencies, errors_by_code, gaps)
    record["rounds"] = rounds
    record["request_attempts"] = len(users) * rounds
    record["expected_calls"] = len(users) * rounds
    record["ideal_target_calls_upper_bound"] = len(users) * rounds
    record["missed_polls_vs_ideal_upper_bound"] = max(0, len(users) * rounds - len(latencies))
    record["connection_setup_ms"] = {
        "p50": round(percentile(connect_times, 0.50), 2),
        "p95": round(percentile(connect_times, 0.95), 2),
        "max": round(max(connect_times), 2) if connect_times else 0,
    }
    return record


def mutation_burst(users: list[dict], db: str, env: dict[str, str], run_id: str) -> dict:
    start = time.perf_counter()
    def mutate(i: int) -> tuple[float, str | None]:
        user = users[i]
        client = PersistentPsql(db, env)
        try:
            t0 = time.perf_counter()
            reply = client.rpc("/profile", user["token"], {"username": f"Load Rename {i:02d}"}, f"write-{run_id}-{i}", "PATCH")
            code = None if reply.get("ok") is True else str((reply.get("error") or {}).get("code", "UNKNOWN"))
            return (time.perf_counter() - t0) * 1000, code
        except Exception as exc:
            return (time.perf_counter() - t0) * 1000, "CLIENT_ERROR_" + type(exc).__name__
        finally:
            client.close()
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(users)) as pool:
        results = list(pool.map(mutate, range(len(users))))
    values = [item[0] for item in results]
    errors_by_code: dict[str, int] = {}
    for _, code in results:
        if code:
            errors_by_code[code] = errors_by_code.get(code, 0) + 1
    elapsed = time.perf_counter() - start
    successes = [latency for latency, code in results if code is None]
    return {
        "phase": "authenticated_profile_write_contention",
        "clients": len(users),
        "calls": len(values),
        "duration_seconds": round(elapsed, 2),
        "request_attempts_per_second": round(len(values) / elapsed, 2) if elapsed else 0,
        "attempt_latency_ms_all_responses_and_client_errors": {"p50": round(percentile(values, .50), 2), "p95": round(percentile(values, .95), 2), "max": round(max(values), 2)},
        "successful_rpc_calls": len(successes),
        "successful_envelope_latency_ms": {"p50": round(percentile(successes, .50), 2), "p95": round(percentile(successes, .95), 2), "max": round(max(successes), 2) if successes else 0},
        "envelope_errors": sum(errors_by_code.values()),
        "envelope_errors_by_code": dict(sorted(errors_by_code.items())),
    }


def apply_migrations(db: str, env: dict[str, str], through: int) -> list[str]:
    files = sorted(file for file in MIGRATIONS.glob("*.sql") if file.name[:3].isdigit() and 2 <= int(file.name[:3]) <= through)
    expected = [f"{number:03d}" for number in range(2, through + 1)]
    if [file.name[:3] for file in files] != expected:
        fail(f"expected checked-in migrations 002 through {through:03d}")

    def apply(batch: list[pathlib.Path]) -> None:
        args = ["psql", "-X", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-d", db]
        for file in batch:
            args.extend(["--file", str(file)])
        command(args, env=env)

    if through == 8:
        # Migration 008 verifies/restores semantic state parity, so model the
        # already-existing production singleton before applying it.
        apply(files[:-1])
        psql(db, """
INSERT INTO public.ular_server_state(id,version,state) VALUES
(1,1,'{"users":{},"sessions":{},"rooms":{},"games":{},"requests":{},"stats":{},"questions":{},"adminSessions":{},"localStudentOwners":{},"localStudentRoster":{}}'::jsonb)
ON CONFLICT(id) DO NOTHING;
""", env=env)
        apply(files[-1:])
    else:
        apply(files)
    return [file.name for file in files]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=15432)
    parser.add_argument("--user", default="postgres")
    parser.add_argument("--maintenance-db", default="postgres")
    parser.add_argument("--clients", type=int, default=30)
    parser.add_argument("--duration-seconds", type=int, default=36)
    parser.add_argument("--through-migration", type=int, choices=(7, 8), default=7, help="Apply migrations through 007 (baseline) or 008 (comparison).")
    parser.add_argument("--inject-failure-after-create", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    host = numeric_loopback(args.host)
    if not 1 <= args.port <= 65535 or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", args.user) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", args.maintenance_db):
        fail("invalid local PostgreSQL connection setting")
    if not 2 <= args.clients <= 100 or args.clients % 2:
        fail("client count must be an even number from 2 to 100")
    if not 30 <= args.duration_seconds <= 60:
        fail("duration must be between 30 and 60 seconds")
    if not all(shutil.which(tool) for tool in ("psql", "createdb", "dropdb")):
        fail("psql, createdb, and dropdb are required")
    socket.getaddrinfo(host, args.port, type=socket.SOCK_STREAM)

    run_id = uuid.uuid4().hex
    db_name = PREFIX + run_id[:16]
    maintenance_env = libpq_env(host, args.port, args.user, args.maintenance_db)
    db_env = maintenance_env | {"PGDATABASE": db_name}
    created = False
    report = None
    try:
        command(["createdb", db_name], env=maintenance_env)
        created = True
        if args.inject_failure_after_create:
            fail("injected test failure after disposable database creation")
        migrations = apply_migrations(db_name, db_env, args.through_migration)
        psql(db_name, """
INSERT INTO public.ular_server_state(id,version,state) VALUES
(1,1,'{"users":{},"sessions":{},"rooms":{},"games":{},"requests":{},"stats":{},"questions":{},"adminSessions":{},"localStudentOwners":{},"localStudentRoster":{}}'::jsonb)
ON CONFLICT(id) DO NOTHING;
INSERT INTO public.ular_admin_config(singleton,secret_hash)
VALUES(true,extensions.crypt('local-only-polling-benchmark-secret',extensions.gen_salt('bf')))
ON CONFLICT(singleton) DO UPDATE SET secret_hash=excluded.secret_hash,login_attempts=0,locked_until=NULL;
""", env=db_env)
        denied = call_once(db_name, db_env, "/leaderboard", "GET", {}, None)
        check_envelope(denied, "UNAUTHORIZED")
        admin = call_once(db_name, db_env, "/admin/session", "POST", {"secret": "local-only-polling-benchmark-secret"}, None, f"{run_id}-admin")
        check_envelope(admin)
        question = call_once(db_name, db_env, "/admin/questions", "POST", {
            "question": "Synthetic local load question?", "options": ["A", "B"], "answer": 0,
            "explanation": "Synthetic benchmark fixture", "category": "Load QA", "difficulty": "mudah", "timeLimit": 120, "active": True,
        }, None, f"{run_id}-question", admin["meta"]["adminToken"])
        check_envelope(question)
        users = create_clients(db_name, db_env, run_id, args.clients)
        wait_seconds = args.duration_seconds / 3
        active_seconds = args.duration_seconds / 6
        reconnect_rounds = 3
        reconnect_seconds = args.duration_seconds / 3
        waiting_report = run_poll_phase("waiting_sync_synchronized", users, db_name, db_env, wait_seconds, 2.0)
        start_games(db_name, db_env, run_id, users)
        active_sync_report = run_poll_phase("active_sync_synchronized", users, db_name, db_env, active_seconds, 1.2)
        active_staggered_report = run_poll_phase("active_sync_staggered", users, db_name, db_env, active_seconds, 1.2, staggered=True)
        reconnect_report = run_reconnect_phase(users, db_name, db_env, rounds=reconnect_rounds)
        mutation_report = mutation_burst(users, db_name, db_env, run_id)
        workload_errors = sum(item["envelope_errors"] for item in (waiting_report, active_sync_report, active_staggered_report, reconnect_report, mutation_report))
        report = {
            "result": "completed",
            "scope": "local PostgreSQL SQL-RPC only; no hosted latency or quota claim",
            "database": "disposable loopback database (removed after run)",
            "migrations_applied": migrations,
            "clients": args.clients,
            "synthetic_games": args.clients // 2,
            "unauthenticated_rpc_rejected": True,
            "workload_rpc_error_count": workload_errors,
            "polling_phases": [waiting_report, active_sync_report, active_staggered_report, reconnect_report],
            "phase_design_seconds": {"waiting": round(wait_seconds, 2), "active_synchronized": round(active_seconds, 2), "active_staggered": round(active_seconds, 2), "reconnect_window": round(reconnect_seconds, 2)},
            "mutation_contention": mutation_report,
            "interpretation": "Diagnostic sample only; does not establish hosted Supabase quota, network latency, or production capacity.",
        }
    finally:
        cleanup_error = None
        if created:
            try:
                command(["dropdb", "--force", db_name], env=maintenance_env)
            except Exception:
                cleanup_error = "disposable benchmark database cleanup failed"
        if cleanup_error:
            if sys.exc_info()[0] is not None:
                print(cleanup_error, file=sys.stderr)
            else:
                fail(cleanup_error)
    if report is not None:
        print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"local Supabase polling rehearsal failed: {error}", file=sys.stderr)
        sys.exit(1)
