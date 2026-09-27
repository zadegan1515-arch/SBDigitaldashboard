#!/usr/bin/env bash
# scripts/e2e-postgres.sh — a throwaway Postgres for scripts/test-li-e2e.js
# in Claude's cloud container (Postgres is installed there, not running).
# Starts it if needed and prints the database URL. Never Neon, never
# production: the test wipes whatever database it's given.
#
#   E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-li-e2e.js
#   bash scripts/e2e-postgres.sh stop      # when done
set -euo pipefail
PORT="${E2E_PG_PORT:-5499}"
DIR=/var/lib/postgresql/sb-e2e
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$BIN" ]; then
  echo "No Postgres here — point E2E_DATABASE_URL at a local test database instead." >&2
  exit 1
fi
as_pg() { su postgres -s /bin/bash -c "$1"; }

if [ "${1:-}" = "stop" ]; then
  as_pg "$BIN/pg_ctl -D $DIR -m fast stop" >/dev/null 2>&1 || true
  echo "stopped" >&2
  exit 0
fi

if ! as_pg "$BIN/pg_ctl -D $DIR status" >/dev/null 2>&1; then
  [ -f "$DIR/PG_VERSION" ] || as_pg "$BIN/initdb -D $DIR -A trust -U postgres" >/dev/null
  as_pg "$BIN/pg_ctl -D $DIR -l $DIR/log -o '-p $PORT -k $DIR' -w start" >/dev/null
fi
as_pg "$BIN/psql -h 127.0.0.1 -p $PORT -U postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='sbe2e'\"" | grep -q 1 \
  || as_pg "$BIN/createdb -h 127.0.0.1 -p $PORT -U postgres sbe2e"
echo "postgresql://postgres@127.0.0.1:$PORT/sbe2e"
