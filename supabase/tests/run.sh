#!/usr/bin/env bash
# Database test run on a throwaway local Supabase Postgres (Docker):
#   1. v1 migrations 0001-0012, then v1-shaped rows (v1_fixture.sql)
#   2. v2 migrations 0013+ on top, so the data transforms run
#   3. reset + combined file twice (repeatability)
#   4. verify-schema.sql, then acceptance.sql (BACKEND_RULES.md §14) on the clean v2 schema
#   5. concurrency.sh (tests 3 and 5 with real parallel sessions)
# Usage: bash supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=supabase/postgres:15.8.1.085
NAME=arkiprep-test-db

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=pw "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done
sleep 5

psqlq() { docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -U postgres -h localhost -v ON_ERROR_STOP=1 -q "$@"; }

echo "== v1 migrations + v1 data"
for f in migrations/000*.sql migrations/001[0-2]_*.sql; do psqlq < "$f" >/dev/null; done
psqlq < tests/v1_fixture.sql
echo "== v2 migrations over v1 data"
for f in migrations/001[3-9]_*.sql migrations/00[2-9]*_*.sql; do psqlq < "$f" >/dev/null; done
psqlq -tA -c "select 'transformed: ' || count(*) || ' orders, ' || (select count(*) from public.balance_ledger) || ' ledger rows' from public.orders"

echo "== reset + all migrations, twice"
bash scripts/build_all.sh >/dev/null
for _ in 1 2; do
  psqlq < scripts/01_reset.sql >/dev/null
  psqlq < scripts/02_all_migrations.sql >/dev/null
done
psqlq -c "delete from auth.users" >/dev/null

echo "== verify-schema"
psqlq -tA < verify-schema.sql | grep -E "CHECKS PASSED|VERIFICATION FAILED|\|" | grep -v "^$" | head -20
psqlq -tA < verify-schema.sql | grep -q "ALL CHECKS PASSED" || { echo "verify-schema failed"; exit 1; }

echo "== acceptance"
OUT=$(psqlq < tests/acceptance.sql 2>&1 || true)
grep -E "FAIL|PASSED|ERROR" <<<"$OUT" || true
grep -q "ACCEPTANCE CHECKS PASSED" <<<"$OUT" || { echo "acceptance failed"; exit 1; }

echo "== concurrency"
NAME="$NAME" bash tests/concurrency.sh
