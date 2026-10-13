#!/usr/bin/env python3
"""Apply every checked-in migration in order in one atomic PostgreSQL transaction."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from supabase_db_config import connection_environment

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    try:
        env = connection_environment(ROOT)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    migrations = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
    if not migrations:
        print("no Supabase migrations found", file=sys.stderr)
        return 2
    args = ["psql", "--set", "ON_ERROR_STOP=1", "--single-transaction"]
    for path in migrations:
        args.extend(["--file", str(path)])
    result = subprocess.run(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, check=False)
    if result.returncode:
        # Keep the URI and driver diagnostics private; only the exit code escapes.
        print(f"migration transaction failed (psql exit {result.returncode})", file=sys.stderr)
        return result.returncode
    print(f"Applied {len(migrations)} Supabase migrations atomically.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
