#!/usr/bin/env bash
# Tests the migrations on a temporary local Postgres (no Docker needed):
#   ./test/run.sh
# Needs PostgreSQL 17 (brew install postgresql@17) or PG_BIN pointing to its
# binaries.
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
DATA=$(mktemp -d)
PORT=54329
trap '"$PG_BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT

"$PG_BIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=''" -l "$DATA/log" -w start >/dev/null
psql=("$PG_BIN/psql" -h "$DATA" -p $PORT -U postgres -X -q -v ON_ERROR_STOP=1)

"${psql[@]}" -f test/supabase_stub.sql
for migration in supabase/migrations/*.sql; do
  # pg_cron, pg_net and Vault only exist on Supabase
  [[ $migration == *_schedule.sql ]] && continue
  "${psql[@]}" -f "$migration"
done
"${psql[@]}" -f test/checks.sql
