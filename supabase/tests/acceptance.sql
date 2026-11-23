-- acceptance.sql: BACKEND_RULES.md §14 acceptance tests at the database level.
--
-- Run against a THROWAWAY database with every migration applied:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/acceptance.sql
-- Every check prints PASS/FAIL; the script raises at the end if any failed.
-- Test 2 (missed webhook -> reconciliation) needs PayMongo and is covered by
-- the Edge Function tests; its database half (fulfil from the job) is #2b.
-- The truly concurrent versions of tests 3 and 5 are in concurrency.sh.

create temp table t_results (n serial, name text, ok boolean, detail text);

create function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into t_results (name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail) $$;

-- Runs a statement and returns 'OK' or the exception message.
create function pg_temp.try(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- Fixture: three students, products, a quiz, a coupon
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, instance_id, aud, role) values
  ('10000000-0000-0000-0000-000000000001', 'ana@test.ph',   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('10000000-0000-0000-0000-000000000002', 'ben@test.ph',   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('10000000-0000-0000-0000-000000000003', 'cora@test.ph',  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('10000000-0000-0000-0000-000000000009', 'rehinaneel@gmail.com', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

select public.complete_signup('10000000-0000-0000-0000-000000000001', 'Ana', '09170000001',
  array['terms_refund','privacy','public_leaderboard'], 'v1', null);
select public.complete_signup('10000000-0000-0000-0000-000000000002', 'Ben', '09170000002',
  array['terms_refund','privacy','public_leaderboard'], 'v1',
  (select ref_code from public.profiles where id = '10000000-0000-0000-0000-000000000001'));
select public.complete_signup('10000000-0000-0000-0000-000000000003', 'Cora', '09170000003',
  array['terms_refund','privacy','public_leaderboard'], 'v1', null);

insert into public.products (id, slug, type, subject, title, price_php, status, access_mode, attempts_per_purchase) values
  ('20000000-0000-0000-0000-000000000001', 't-mock',     'mock',     'ALL', 'Full Mock Board', 49, 'published', 'attempts', 2),
  ('20000000-0000-0000-0000-000000000002', 't-material', 'material', 'A',   'Subject A Reviewer', 49, 'published', 'exam_date', null),
  ('20000000-0000-0000-0000-000000000003', 't-quiz',     'quiz',     'B',   'Subject B Quiz Pack', 19, 'published', 'attempts', 2);
insert into public.quizzes (id, slug, title, subject, time_limit_sec, status) values
  ('30000000-0000-0000-0000-000000000001', 't-mock-quiz', 'Full Mock Board', 'ALL', 600, 'published');
insert into public.pack_quizzes (product_id, quiz_id) values
  ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001');
insert into public.questions (id, quiz_id, question_number, question_text, options, correct_index, subject, status) values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 1, 'Q1', '["a","b","c","d"]', 1, 'A', 'published'),
  ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 2, 'Q2', '["a","b","c","d"]', 2, 'B', 'published');
insert into public.coupons (id, code, type, value, usage_limit) values
  ('50000000-0000-0000-0000-000000000001', 'ALE2027', 'percent', 10, 1000),
  ('50000000-0000-0000-0000-000000000002', 'LASTONE', 'fixed', 5, 1);

-- ---------------------------------------------------------------------------
-- 1. Webhook delivered twice -> 1 enrollment, 1 coupon use, 1 reward
-- ---------------------------------------------------------------------------
do $$
declare
  v_order jsonb;
  v_id    uuid;
  r1 jsonb; r2 jsonb;
begin
  v_order := public.create_order('10000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001', 'gcash', 'ALE2027', null, true);
  v_id := (v_order->>'order_id')::uuid;
  perform pg_temp.check('1. coupon 10% of 49 rounds to 5, total 44', (v_order->>'total_php')::int = 44, v_order::text);
  perform pg_temp.check('1. referrer bound at signup is used', (v_order->>'referred')::boolean);
  perform public.attach_checkout(v_id, 'cs_test_1', 'https://checkout.test/1');

  if public.record_payment_event('evt_1', 'payment.paid', '{}', v_id) then
    r1 := public.apply_payment_paid(v_id, 44, 'PHP', 'pay_1', '{}');
  end if;
  if public.record_payment_event('evt_1', 'payment.paid', '{}', v_id) then
    r2 := public.apply_payment_paid(v_id, 44, 'PHP', 'pay_1', '{}');
  end if;
  perform pg_temp.check('1. second delivery of the same event is dropped', r2 is null);
  -- even a replay that bypasses event dedupe is a no-op
  r2 := public.apply_payment_paid(v_id, 44, 'PHP', 'pay_1', '{}');
  perform pg_temp.check('1. replayed paid -> already_paid', r2->>'outcome' = 'already_paid', r2::text);
  perform pg_temp.check('1. exactly one enrollment',
    (select count(*) from public.enrollments where order_id = v_id) = 1);
  perform pg_temp.check('1. exactly one coupon use',
    (select used_count from public.coupons where code = 'ALE2027') = 1
    and (select reserved_count from public.coupons where code = 'ALE2027') = 0);
  perform pg_temp.check('1. exactly one ₱9 reward + ledger row',
    (select count(*) from public.referrals where order_id = v_id) = 1
    and (select count(*) from public.balance_ledger where source = 'referral'
          and ref_id = (select id from public.referrals where order_id = v_id)) = 1);
  perform pg_temp.check('1. receipt E2 queued once',
    (select count(*) from public.outbox where dedupe_key = 'E2:' || v_id) = 1);
end $$;

-- 1b. Amount mismatch -> on_hold + incident, no access
do $$
declare v_id uuid; r jsonb;
begin
  v_id := (public.create_order('10000000-0000-0000-0000-000000000003',
            '20000000-0000-0000-0000-000000000001', 'gcash', null, null, true)->>'order_id')::uuid;
  r := public.apply_payment_paid(v_id, 40, 'PHP', 'pay_mismatch', '{}');
  perform pg_temp.check('1b. amount ≠ total -> on_hold, not fulfilled',
    r->>'outcome' = 'amount_mismatch'
    and (select status from public.orders where id = v_id) = 'on_hold'
    and not exists (select 1 from public.enrollments where order_id = v_id), r::text);
  -- 2b. the admin manual fulfil needs a reason
  perform pg_temp.check('2b. manual fulfil without reason refused',
    pg_temp.try(format('select public.fulfil_order(%L, %L, %L)', v_id, '10000000-0000-0000-0000-000000000009', '')) = 'REASON_REQUIRED');
  r := public.fulfil_order(v_id, '10000000-0000-0000-0000-000000000009', 'Verified ₱49 in PayMongo');
  perform pg_temp.check('2b. manual fulfil with reason grants access + audit',
    r->>'outcome' = 'fulfilled'
    and exists (select 1 from public.audit_log where action = 'manual_fulfil'), r::text);
end $$;

-- ---------------------------------------------------------------------------
-- 3 + 4. Bank deposits: double approve is a no-op; underpaid can't approve,
-- rejecting credits the amount received.
-- ---------------------------------------------------------------------------
do $$
declare v_id uuid; v_dep uuid; r jsonb; v_sha text := repeat('a', 64);
begin
  v_id := (public.create_order('10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000003', 'bank', null, null, true)->>'order_id')::uuid;
  v_dep := (public.submit_bank_proof('10000000-0000-0000-0000-000000000001', v_id, 'bdo', 19,
             'REF-1', 'proofs/x.jpg', v_sha)->>'deposit_id')::uuid;
  perform pg_temp.check('3. order pending_approval after proof',
    (select status from public.orders where id = v_id) = 'pending_approval');
  r := public.approve_deposit(v_dep, '10000000-0000-0000-0000-000000000009');
  perform pg_temp.check('3. first approve fulfils', (r->>'noop')::boolean = false, r::text);
  r := public.approve_deposit(v_dep, '10000000-0000-0000-0000-000000000009');
  perform pg_temp.check('3. second approve is a no-op', (r->>'noop')::boolean = true, r::text);
  perform pg_temp.check('3. still one enrollment',
    (select count(*) from public.enrollments where order_id = v_id) = 1);
end $$;

do $$
declare v_id uuid; v_dep uuid; r jsonb; v_before int;
begin
  v_id := (public.create_order('10000000-0000-0000-0000-000000000003',
            '20000000-0000-0000-0000-000000000002', 'bank', null, null, true)->>'order_id')::uuid;
  v_dep := (public.submit_bank_proof('10000000-0000-0000-0000-000000000003', v_id, 'bpi', 40,
             'REF-2', 'proofs/y.jpg', repeat('b', 64))->>'deposit_id')::uuid;
  v_before := public.balance_of('10000000-0000-0000-0000-000000000003');
  perform pg_temp.check('4. ₱40 for ₱49: approve impossible',
    pg_temp.try(format('select public.approve_deposit(%L, %L)', v_dep, '10000000-0000-0000-0000-000000000009')) = 'DEPOSIT_UNDERPAID');
  r := public.reject_deposit(v_dep, '10000000-0000-0000-0000-000000000009', 'Deposit was ₱9 short');
  perform pg_temp.check('4. reject credits ₱40 to the balance',
    public.balance_of('10000000-0000-0000-0000-000000000003') = v_before + 40
    and (select status from public.orders where id = v_id) = 'awaiting_proof'
    and exists (select 1 from public.outbox where dedupe_key = 'E12:' || v_dep), r::text);

  -- overpaid: approve + credit the extra
  v_dep := (public.submit_bank_proof('10000000-0000-0000-0000-000000000003', v_id, 'bpi', 60,
             'REF-3', 'proofs/z.jpg', repeat('c', 64))->>'deposit_id')::uuid;
  r := public.approve_deposit(v_dep, '10000000-0000-0000-0000-000000000009');
  perform pg_temp.check('4b. overpaid ₱60 for ₱49: approve + ₱11 credit',
    (r->>'credit')::int = 11
    and public.balance_of('10000000-0000-0000-0000-000000000003') = v_before + 40 + 11, r::text);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Coupon with 1 use left: the second checkout can't get it
-- ---------------------------------------------------------------------------
do $$
begin
  perform public.create_order('10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001', 'gcash', 'LASTONE', null, true);
  perform pg_temp.check('5. second checkout: COUPON_UNAVAILABLE',
    pg_temp.try($q$select public.create_order('10000000-0000-0000-0000-000000000003',
      '20000000-0000-0000-0000-000000000003', 'gcash', 'LASTONE', null, true)$q$) = 'COUPON_UNAVAILABLE');
  perform public.expire_orders();
  update public.orders set expires_at = now() - interval '1 minute'
   where coupon_id = '50000000-0000-0000-0000-000000000002';
  perform public.expire_orders();
  perform pg_temp.check('5. expiry releases the reservation',
    (select reserved_count from public.coupons where code = 'LASTONE') = 0);
end $$;

-- ---------------------------------------------------------------------------
-- 6 + 7. Attempts: closing the browser -> auto-submit at ends_at; attempt 2
-- of 2 ends the enrollment.
-- ---------------------------------------------------------------------------
do $$
declare a jsonb; r jsonb; v_aid uuid;
begin
  -- Ben owns the mock from test 1.
  a := public.start_attempt('10000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001');
  v_aid := (a->>'attempt_id')::uuid;
  perform public.save_answers('10000000-0000-0000-0000-000000000002', v_aid,
    '[{"question_id":"40000000-0000-0000-0000-000000000001","choice":1,"flagged":false}]');
  perform pg_temp.check('8b. answer keys never in the start payload', a::text !~ 'correct');
  -- "close the browser": the timer runs out on the server
  update public.attempts set ends_at = now() - interval '1 minute' where id = v_aid;
  perform pg_temp.check('6. saving after ends_at is refused',
    pg_temp.try(format($q$select public.save_answers(%L, %L, '[]')$q$,
      '10000000-0000-0000-0000-000000000002', v_aid)) = 'ATTEMPT_CLOSED');
  perform public.auto_submit_due();
  perform pg_temp.check('6. auto-submitted with the saved answer graded',
    (select status = 'submitted' and auto_submitted and score = 1 and total = 2
       from public.attempts where id = v_aid));
  perform pg_temp.check('6. E10 (1 attempt left) queued',
    exists (select 1 from public.outbox where template = 'E10'));

  a := public.start_attempt('10000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001');
  perform pg_temp.check('7. starting attempt 2 of 2 ends the enrollment',
    (select status from public.enrollments
      where user_id = '10000000-0000-0000-0000-000000000002'
        and product_id = '20000000-0000-0000-0000-000000000001'
      order by created_at desc limit 1) = 'ended');
  perform pg_temp.check('7. resume returns the same open attempt',
    (public.start_attempt('10000000-0000-0000-0000-000000000002',
       '30000000-0000-0000-0000-000000000001')->>'attempt_id') = a->>'attempt_id');
  r := public.submit_attempt((a->>'attempt_id')::uuid, '10000000-0000-0000-0000-000000000002', false);
  perform pg_temp.check('7. submit is idempotent',
    public.submit_attempt((a->>'attempt_id')::uuid, '10000000-0000-0000-0000-000000000002', false) = r);
  perform pg_temp.check('7. no third attempt: ATTEMPTS_USED',
    pg_temp.try($q$select public.start_attempt('10000000-0000-0000-0000-000000000002',
      '30000000-0000-0000-0000-000000000001')$q$) = 'ATTEMPTS_USED');
  perform pg_temp.check('7. can buy 2 more once both are used',
    pg_temp.try($q$select public.create_order('10000000-0000-0000-0000-000000000002',
      '20000000-0000-0000-0000-000000000001', 'gcash', null, null, true)$q$) = 'OK');
end $$;

-- ---------------------------------------------------------------------------
-- 8. Buying an owned active product -> ALREADY_OWNED
-- ---------------------------------------------------------------------------
select pg_temp.check('8. ALREADY_OWNED',
  pg_temp.try($q$select public.create_order('10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000003', 'gcash', null, null, true)$q$) = 'ALREADY_OWNED');

-- ---------------------------------------------------------------------------
-- 9. Payout: ₱99 rejected; ₱108 succeeds once; double click -> no second
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.balance_ledger (user_id, amount_php, source, note)
  values ('10000000-0000-0000-0000-000000000001', 99 - public.balance_of('10000000-0000-0000-0000-000000000001'), 'adjustment', 'test');
  perform pg_temp.check('9. ₱99 -> BELOW_THRESHOLD',
    pg_temp.try($q$select public.request_payout('10000000-0000-0000-0000-000000000001')$q$) = 'BELOW_THRESHOLD');
  insert into public.balance_ledger (user_id, amount_php, source, note)
  values ('10000000-0000-0000-0000-000000000001', 9, 'adjustment', 'test');
  perform pg_temp.check('9. ₱108 -> payout requested',
    (public.request_payout('10000000-0000-0000-0000-000000000001')->>'amount')::int = 108);
  perform pg_temp.check('9. double click -> PAYOUT_PENDING, one payout',
    pg_temp.try($q$select public.request_payout('10000000-0000-0000-0000-000000000001')$q$) = 'PAYOUT_PENDING'
    and (select count(*) from public.payouts where user_id = '10000000-0000-0000-0000-000000000001') = 1);
  perform pg_temp.check('9. balance locked to 0',
    public.balance_of('10000000-0000-0000-0000-000000000001') = 0);
end $$;

-- ---------------------------------------------------------------------------
-- 10. One active session
-- ---------------------------------------------------------------------------
do $$
declare s jsonb;
begin
  s := public.start_session('10000000-0000-0000-0000-000000000003', false, 'Chrome', 'Makati');
  perform pg_temp.check('10. first login gets a session', (s->>'ok')::boolean);
  perform pg_temp.check('10. second login blocked',
    public.start_session('10000000-0000-0000-0000-000000000003', false, 'Safari', 'QC')->>'code' = 'SESSION_ACTIVE');
  update public.sessions set last_seen_at = now() - interval '31 minutes'
   where id = (s->>'session_id')::uuid;
  perform pg_temp.check('10. allowed 30 min after the last heartbeat',
    (public.start_session('10000000-0000-0000-0000-000000000003', false, 'Safari', 'QC')->>'ok')::boolean);
  perform pg_temp.check('10. old session no longer passes a heartbeat',
    not public.touch_session('10000000-0000-0000-0000-000000000003', (s->>'session_id')::uuid));
end $$;

-- ---------------------------------------------------------------------------
-- 11. Refunding a duplicate voids the ₱9 and keeps access from the original
-- ---------------------------------------------------------------------------
do $$
declare v_dup uuid; r jsonb; v_bal int;
begin
  -- Ben (referred by Ana) pays twice: the new mock order from test 7 is
  -- paid, then a second order for the same product is paid too.
  perform public.apply_payment_paid(id, total_php, 'PHP', 'pay_ben_2', '{}')
     from public.orders
    where user_id = '10000000-0000-0000-0000-000000000002' and status = 'created';
  insert into public.orders (user_id, product_id, status, price_php, total_php, referrer_user_id,
                             access_snapshot, method, expires_at)
  values ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
          'awaiting_payment', 49, 49, '10000000-0000-0000-0000-000000000001',
          '{"access_mode":"attempts","attempts":2,"title":"Full Mock Board"}', 'gcash', now() + interval '1 hour')
  returning id into v_dup;
  r := public.apply_payment_paid(v_dup, 49, 'PHP', 'pay_ben_dup', '{}');
  perform pg_temp.check('11. duplicate charge opens an incident, no second enrollment',
    (r->>'duplicate')::boolean
    and (select count(*) from public.enrollments
          where user_id = '10000000-0000-0000-0000-000000000002' and status = 'active') = 1, r::text);
  v_bal := public.balance_of('10000000-0000-0000-0000-000000000001');
  r := public.refund_order(v_dup, '10000000-0000-0000-0000-000000000009', 'Charged twice');
  perform pg_temp.check('11. refund voids the ₱9 reward',
    (select status from public.referrals where order_id = v_dup) = 'void'
    and public.balance_of('10000000-0000-0000-0000-000000000001') = v_bal - 9, r::text);
  perform pg_temp.check('11. access from the original order is kept',
    not (r->>'enrollment_revoked')::boolean
    and (select count(*) from public.enrollments
          where user_id = '10000000-0000-0000-0000-000000000002' and status = 'active') = 1);
end $$;

-- ---------------------------------------------------------------------------
-- 12. Changing exam_date moves active material expiries; prices unchanged
-- ---------------------------------------------------------------------------
do $$
declare v_id uuid; r jsonb; v_price int;
begin
  v_id := (public.create_order('10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000002', 'gcash', null, null, true)->>'order_id')::uuid;
  perform public.apply_payment_paid(v_id, 49, 'PHP', 'pay_mat', '{}');
  update public.products set price_php = 59 where id = '20000000-0000-0000-0000-000000000002';
  r := public.set_exam_date('10000000-0000-0000-0000-000000000009', date '2027-06-20');
  perform pg_temp.check('12. material expiry follows the new exam date',
    (select expires_at from public.enrollments where order_id = v_id)
      = ((date '2027-06-21')::timestamp at time zone 'Asia/Manila'), r::text);
  perform pg_temp.check('12. existing order keeps its price',
    (select total_php from public.orders where id = v_id) = 49);
end $$;

-- ---------------------------------------------------------------------------
-- Security spot checks
-- ---------------------------------------------------------------------------
select pg_temp.check('sec. leaderboard callable by anon, shows display names only',
  has_function_privilege('anon', 'public.leaderboard(uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.create_order(uuid,uuid,text,text,text,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.fulfil_order(uuid,uuid,text)', 'execute'));
select pg_temp.check('sec. coupons and questions unreadable by clients',
  not has_table_privilege('anon', 'public.coupons', 'select')
  and not has_table_privilege('authenticated', 'public.questions', 'select'));
select pg_temp.check('sec. audit_log is append-only even for the owner',
  pg_temp.try('delete from public.audit_log') = 'audit_log is append-only');

-- ---------------------------------------------------------------------------
select n, case when ok then 'PASS' else 'FAIL' end as result, name, detail from t_results order by n;
do $$
declare v_fail int;
begin
  select count(*) into v_fail from t_results where not ok;
  if v_fail > 0 then
    raise exception '% acceptance check(s) failed', v_fail;
  end if;
  raise warning 'ALL % ACCEPTANCE CHECKS PASSED', (select count(*) from t_results);
end $$;
