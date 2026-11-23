#!/usr/bin/env bash
# BACKEND_RULES.md §14 tests 3 and 5 with two real, overlapping sessions.
# Session A holds its transaction open for 2s; session B starts during it.
# Expects the acceptance fixture (run.sh runs this after acceptance.sql).
set -euo pipefail
NAME=${NAME:-arkiprep-test-db}
psqlq() { docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -U postgres -h localhost -v ON_ERROR_STOP=1 -qtA "$@"; }
ADMIN=10000000-0000-0000-0000-000000000009
fail=0

psqlq <<'SQL' >/dev/null
insert into auth.users (id, email, instance_id, aud, role) values
  ('10000000-0000-0000-0000-000000000004', 'dee@test.ph', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('10000000-0000-0000-0000-000000000005', 'eli@test.ph', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
select public.complete_signup('10000000-0000-0000-0000-000000000004', 'Dee', '09170000004',
  array['terms_refund','privacy','public_leaderboard'], 'v1', null);
select public.complete_signup('10000000-0000-0000-0000-000000000005', 'Eli', '09170000005',
  array['terms_refund','privacy','public_leaderboard'], 'v1', null);
insert into public.coupons (code, type, value, usage_limit) values ('RACE1', 'fixed', 5, 1);
SQL

# --- 3. Two admins approve the same deposit at once ------------------------
DEP=$(psqlq -c "select (public.submit_bank_proof('10000000-0000-0000-0000-000000000004',
  (public.create_order('10000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000003',
   'bank', null, null, true)->>'order_id')::uuid, 'bdo', 19, 'RACE-REF', 'p/r.jpg', repeat('d', 64))->>'deposit_id')")
A=$(mktemp); B=$(mktemp)
psqlq -c "begin; select public.approve_deposit('$DEP', '$ADMIN')->>'noop'; select pg_sleep(2); commit;" > "$A" &
sleep 0.5
psqlq -c "select public.approve_deposit('$DEP', '$ADMIN')->>'noop'" > "$B"
wait
RES="$(grep -E 'true|false' "$A" | head -1) $(grep -E 'true|false' "$B" | head -1)"
ENR=$(psqlq -c "select count(*) from public.enrollments e join public.bank_deposits d on d.order_id = e.order_id where d.id = '$DEP'")
if [[ "$RES" == "false true" && "$ENR" == "1" ]]; then echo "PASS 3. concurrent approve: one fulfils, one no-op"
else echo "FAIL 3. concurrent approve: noop=[$RES] enrollments=$ENR"; fail=1; fi

# --- 5. Coupon with 1 use left, two simultaneous checkouts ------------------
psqlq -c "begin; select public.create_order('10000000-0000-0000-0000-000000000004',
  '20000000-0000-0000-0000-000000000001', 'gcash', 'RACE1', null, true)->>'order_no'; select pg_sleep(2); commit;" > "$A" 2>&1 &
sleep 0.5
psqlq -c "select public.create_order('10000000-0000-0000-0000-000000000005',
  '20000000-0000-0000-0000-000000000001', 'gcash', 'RACE1', null, true)->>'order_no'" > "$B" 2>&1 || true
wait
if grep -q '^AP-' "$A" && grep -q 'COUPON_UNAVAILABLE' "$B"; then echo "PASS 5. concurrent coupon: only one checkout gets it"
else echo "FAIL 5. concurrent coupon: A=[$(cat "$A")] B=[$(cat "$B")]"; fail=1; fi

rm -f "$A" "$B"
exit $fail
