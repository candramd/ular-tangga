"""Safe .env and libpq connection helpers used by Supabase maintenance scripts."""
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit


def read_env_file(root: Path) -> dict[str, str]:
    path = root / ".env"
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def connection_environment(root: Path, explicit_url: str | None = None) -> dict[str, str]:
    values = read_env_file(root)
    env = os.environ.copy()
    db_url = explicit_url or env.get("SUPABASE_DB_URL") or env.get("DATABASE_URL") or values.get("SUPABASE_DB_URL") or values.get("DATABASE_URL")
    if not db_url:
        raise ValueError("SUPABASE_DB_URL or DATABASE_URL is missing from .env")
    parts = urlsplit(db_url)
    if parts.scheme not in ("postgres", "postgresql") or not parts.hostname:
        raise ValueError("database URL must be a PostgreSQL URI")

    configured_cert = env.get("SUPABASE_CA_CERT_PATH") or values.get("SUPABASE_CA_CERT_PATH")
    if not configured_cert:
        default_cert = root / ".certs" / "supabase-ca.crt"
        configured_cert = str(default_cert) if default_cert.exists() else None
    if configured_cert and not Path(configured_cert).is_file():
        raise ValueError("SUPABASE_CA_CERT_PATH does not point to a readable CA certificate")

    # Pass connection fields through libpq's environment interface. Keeping the
    # URI out of argv avoids exposing a password in process listings and also
    # lets us replace an in-container sslrootcert URI value with the host path.
    for key in ("PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE", "PGAPPNAME", "PGOPTIONS", "PGTARGETSESSIONATTRS", "PGSSLROOTCERT"):
        env.pop(key, None)
    env["PGHOST"] = parts.hostname
    if parts.port is not None:
        env["PGPORT"] = str(parts.port)
    if parts.username is not None:
        env["PGUSER"] = unquote(parts.username)
    if parts.password is not None:
        env["PGPASSWORD"] = unquote(parts.password)
    database = unquote(parts.path.lstrip("/"))
    if database:
        env["PGDATABASE"] = database

    query = parse_qsl(parts.query, keep_blank_values=True)
    mappings = {
        "sslmode": "PGSSLMODE",
        "application_name": "PGAPPNAME",
        "options": "PGOPTIONS",
        "target_session_attrs": "PGTARGETSESSIONATTRS",
    }
    for name, value in query:
        mapped = mappings.get(name.lower())
        if mapped:
            env[mapped] = value
    if configured_cert:
        env["PGSSLROOTCERT"] = str(Path(configured_cert).resolve())
    else:
        cert = next((value for key, value in query if key.lower() == "sslrootcert"), None)
        if cert:
            env["PGSSLROOTCERT"] = unquote(cert)
    return env
