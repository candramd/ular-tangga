#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHONPATH="$script_dir${PYTHONPATH:+:$PYTHONPATH}" exec python3 "$script_dir/supabase-migrate.py" "$@"
