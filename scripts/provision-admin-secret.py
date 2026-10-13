#!/usr/bin/env python3
"""Set private ADMIN_SECRET in .env and provision its bcrypt hash in Supabase.

Reads the secret with terminal echo disabled, accepts no secret argument, and
sends SQL to psql over stdin so the secret is absent from argv and logs.
"""
from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
import argparse
import re
import subprocess
import sys
import tempfile
from urllib.parse import parse_qsl, unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"


def env_value(lines: list[str], name: str) -> str | None:
    for line in lines:
        match = re.match(rf"^\s*{re.escape(name)}\s*=\s*(.*)\s*$", line)
        if not match:
            continue
        value = match.group(1).strip()
        if value.startswith('"') and value.endswith('"'):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return value[1:-1]
        if value.startswith("'") and value.endswith("'"):
            return value[1:-1]
        return value
    return None


def read_env(path: Path) -> tuple[list[str], str | None, str | None, str | None]:
    lines = path.read_text().splitlines() if path.exists() else []
    return lines, env_value(lines, "SUPABASE_DB_URL") or env_value(lines, "DATABASE_URL"), env_value(lines, "ADMIN_SECRET"), env_value(lines, "SUPABASE_CA_CERT_PATH")


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def write_private_env(lines: list[str], secret: str) -> None:
    kept = [line for line in lines if not re.match(r"^\s*ADMIN_SECRET\s*=", line)]
    kept.append("ADMIN_SECRET=" + json.dumps(secret, ensure_ascii=False))
    data = "\n".join(kept) + "\n"
    fd, temp_name = tempfile.mkstemp(prefix=".env.admin.", dir=ROOT, text=True)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temp_name, ENV_FILE)
        os.chmod(ENV_FILE, 0o600)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def database_environment(database_url: str, cert_override: str | None) -> dict[str, str]:
    env = os.environ.copy()
    parsed = urlsplit(database_url)
    query = parse_qsl(parsed.query, keep_blank_values=True)
    local_cert = cert_override or str(ROOT / ".certs" / "supabase-ca.crt")
    if parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname or not parsed.path:
        raise ValueError(".env database URL must use a PostgreSQL URI.")
    # libpq's PGDATABASE is a database name, not a reliably parsed connection
    # URI. Split credentials and options into libpq environment fields instead
    # of placing the URI (which contains a password) in process arguments.
    env["PGHOST"] = unquote(parsed.hostname)
    if parsed.port:
        env["PGPORT"] = str(parsed.port)
    if parsed.username:
        env["PGUSER"] = unquote(parsed.username)
    if parsed.password is not None:
        env["PGPASSWORD"] = unquote(parsed.password)
    env["PGDATABASE"] = unquote(parsed.path.lstrip("/"))
    for key, value in query:
        env_names = {
            "sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT", "sslcert": "PGSSLCERT",
            "sslkey": "PGSSLKEY", "sslcrl": "PGSSLCRL", "sslcrldir": "PGSSLCRLDIR",
            "sslcompression": "PGSSLCOMPRESSION", "application_name": "PGAPPNAME",
            "connect_timeout": "PGCONNECT_TIMEOUT", "options": "PGOPTIONS",
            "target_session_attrs": "PGTARGETSESSIONATTRS", "channel_binding": "PGCHANNELBINDING",
        }
        if key in env_names:
            env[env_names[key]] = value
    uri_cert = next((value for key, value in query if key == "sslrootcert"), None)
    if uri_cert and local_cert and Path(local_cert).is_file() and not Path(uri_cert).is_file():
        env["PGSSLROOTCERT"] = local_cert
    elif cert_override and uri_cert:
        env["PGSSLROOTCERT"] = cert_override
    elif local_cert and Path(local_cert).is_file():
        env["PGSSLROOTCERT"] = local_cert
    env.pop("PGSERVICE", None)
    env.pop("DATABASE_URL", None)
    env.pop("SUPABASE_DB_URL", None)
    return env


def safe_database_error(stderr: str | None) -> str:
    message = (stderr or "").lower()
    if any(part in message for part in ("certificate", "ssl error", "root certificate", "ssl SYSCALL".lower())):
        return "Database TLS certificate validation failed; check the local CA path."
    if any(part in message for part in ("could not connect", "connection to server", "could not translate host", "timeout expired", "no route to host")):
        return "Database connection failed; check the configured endpoint and network."
    if "ular_admin_config" in message or "does not exist" in message:
        return "Admin configuration table is unavailable; confirm all migrations are installed."
    if "permission denied" in message or "must be owner" in message:
        return "Database role cannot update the private admin configuration."
    return "Database hash provisioning failed; .env was not changed."


def main() -> int:
    parser = argparse.ArgumentParser(description="Provision the admin secret without exposing it in shell history.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--from-env", action="store_true", help="Hash the existing ADMIN_SECRET from .env without changing it.")
    mode.add_argument("--rotate", action="store_true", help="Prompt securely for a new secret and update .env after successful seeding.")
    args = parser.parse_args()
    if args.rotate and not sys.stdin.isatty():
        print("Run this command in an interactive terminal.", file=sys.stderr)
        return 2
    lines, database_url, existing_secret, cert_override = read_env(ENV_FILE)
    if not database_url:
        print("SUPABASE_DB_URL (or DATABASE_URL) is required in .env.", file=sys.stderr)
        return 2
    if args.from_env:
        secret = existing_secret
        if not secret:
            print("ADMIN_SECRET is missing from .env.", file=sys.stderr)
            return 2
    else:
        secret = getpass.getpass("New admin secret (minimum 16 characters): ")
        confirm = getpass.getpass("Confirm admin secret: ")
        if secret != confirm:
            print("Secrets must match and contain at least 16 characters.", file=sys.stderr)
            return 2
    if len(secret) < 16 or "\n" in secret or "\r" in secret:
        print("ADMIN_SECRET must contain at least 16 characters.", file=sys.stderr)
        return 2
    statement = (
        "INSERT INTO public.ular_admin_config(singleton,secret_hash,login_attempts,locked_until,updated_at) "
        "VALUES(true,extensions.crypt(" + sql_literal(secret) + ",extensions.gen_salt('bf',12)),0,NULL,clock_timestamp()) "
        "ON CONFLICT(singleton) DO UPDATE SET secret_hash=EXCLUDED.secret_hash,login_attempts=0,locked_until=NULL,updated_at=EXCLUDED.updated_at;\n"
    )
    env = database_environment(database_url, cert_override)
    try:
        subprocess.run(["psql", "-X", "--set", "ON_ERROR_STOP=1", "--quiet", "--no-align", "--tuples-only"], input=statement, text=True, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
    except FileNotFoundError:
        print("psql is required to provision the database hash.", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as error:
        print(safe_database_error(error.stderr), file=sys.stderr)
        return 1
    if args.rotate:
        write_private_env(lines, secret)
        print("Admin secret rotated. .env permissions set to 0600; the database stores only a bcrypt hash.")
    else:
        print("Existing ADMIN_SECRET bcrypt hash provisioned; .env was preserved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
