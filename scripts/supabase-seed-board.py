#!/usr/bin/env python3
"""Seed the private board config from .env without evaluating shell syntax."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from supabase_db_config import connection_environment, read_env_file

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SNAKES = {17: 7, 54: 34, 62: 19, 87: 24, 93: 73, 98: 79}
DEFAULT_LADDERS = {3: 22, 8: 30, 20: 41, 28: 55, 50: 69, 71: 92}


def default_board(total_steps: int) -> dict:
    return {
        "totalSteps": total_steps,
        "snakes": {str(start): end for start, end in DEFAULT_SNAKES.items() if start < total_steps},
        "ladders": {str(start): end for start, end in DEFAULT_LADDERS.items() if end < total_steps},
    }


def validate_board(board: dict) -> None:
    total = board.get("totalSteps")
    if not isinstance(total, int) or isinstance(total, bool) or not 10 <= total <= 1000:
        raise ValueError("totalSteps must be an integer between 10 and 1000")
    snakes = board.get("snakes")
    ladders = board.get("ladders")
    if not isinstance(snakes, dict) or not isinstance(ladders, dict):
        raise ValueError("snakes and ladders must be objects")
    occupied: set[int] = set()
    for name, jumps in (("snakes", snakes), ("ladders", ladders)):
        for start_text, end in jumps.items():
            if not isinstance(start_text, str) or not re.fullmatch(r"0|[1-9][0-9]*", start_text):
                raise ValueError(f"invalid {name} start square {start_text!r}")
            start = int(start_text)
            if not isinstance(end, int) or isinstance(end, bool) or not 1 <= start < total or not 1 <= end <= total or start == end:
                raise ValueError(f"invalid {name} jump {start_text!r}")
            if (name == "snakes" and end >= start) or (name == "ladders" and end <= start):
                raise ValueError(f"invalid {name} direction at {start_text}")
            if start in occupied:
                raise ValueError(f"overlapping jump at {start_text}")
            occupied.add(start)
    destinations = {value for value in snakes.values()} | {value for value in ladders.values()}
    if destinations & occupied:
        raise ValueError("chained jumps are not supported")


def main() -> int:
    values = read_env_file(ROOT)
    for name in ("SUPABASE_DB_URL", "DATABASE_URL", "TOTAL_STEPS", "BOARD_JSON"):
        if os.environ.get(name):
            values[name] = os.environ[name]
    try:
        db_env = connection_environment(ROOT)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    try:
        total = int(values.get("TOTAL_STEPS", "100"))
    except ValueError:
        print("TOTAL_STEPS must be an integer", file=sys.stderr)
        return 2
    board = default_board(total)
    if values.get("BOARD_JSON"):
        try:
            supplied = json.loads(values["BOARD_JSON"])
        except json.JSONDecodeError as exc:
            print(f"BOARD_JSON is invalid JSON: {exc.msg}", file=sys.stderr)
            return 2
        if not isinstance(supplied, dict):
            print("BOARD_JSON must be an object", file=sys.stderr)
            return 2
        board.update(supplied)
    try:
        validate_board(board)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    env = db_env
    payload = json.dumps(board, separators=(",", ":"), sort_keys=True)
    sql = "INSERT INTO public.ular_game_config(singleton,board,updated_at) VALUES(true, :'board_json'::jsonb, clock_timestamp()) ON CONFLICT(singleton) DO UPDATE SET board=excluded.board,updated_at=excluded.updated_at;"
    result = subprocess.run(
        ["psql", "--set", "ON_ERROR_STOP=1", "--set", "board_json=" + payload, "--file", "-"],
        input=sql + "\n",
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode:
        # Avoid echoing connection strings or server diagnostics that could contain them.
        print("could not seed private game board configuration", file=sys.stderr)
        return result.returncode
    print(f"Seeded private board configuration ({board['totalSteps']} squares).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
