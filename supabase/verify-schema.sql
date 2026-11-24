-- verify-schema.sql
-- Post-apply verification for the v2 schema (migrations 0001-0024).
--
-- Read-only apart from objects in pg_temp, so it is safe to run against
-- staging or production:
--   psql "$DATABASE_URL" -f supabase/verify-schema.sql
-- or paste the whole file into the Supabase SQL editor (it shows only the last
-- result: the failures-only list, empty when everything passes; the summary
-- row before it says ALL CHECKS PASSED).
--
-- What it asserts:
--   A. The 27 v2 tables exist, and no extra table snuck into schema public
--   B. RLS enabled on every table; FORCE RLS on the identity/money tables
--   C. Only the two remaining enum types
--   D. questions: zero policies and zero client grants (answer keys)
--   E. The exact policy inventory, by table, name, command and roles
--   F. Client SELECT column sets match the declared inventory
--   G. Zero client writes, except profiles UPDATE(display_name, mobile)
--   H. Zero client EXECUTE, except the public leaderboard
--   I. Settings rows present; only answer_reveal_mode is hidden from clients
--   J. Database-level idempotency guarantees (unique keys, partial indexes)
--   K. audit_log is append-only (triggers present)

drop table if exists pg_temp.verify_results;
create temp table verify_results (
  seq        serial primary key,
  section    text not null,
  check_name text not null,
  expected   text not null,
  actual     text not null,
  status     text not null
);

create or replace function pg_temp.chk(p_section text, p_name text, p_expected text, p_actual text)
returns void language sql as $$
  insert into verify_results (section, check_name, expected, actual, status)
  values (p_section, p_name, coalesce(p_expected, '<null>'), coalesce(p_actual, '<null>'),
          case when coalesce(p_expected, '<null>') = coalesce(p_actual, '<null>') then 'PASS' else 'FAIL' end);
$$;

-- Effective column privilege (table grants, column grants, PUBLIC, membership).
create or replace function pg_temp.granted_cols(p_table text, p_role text, p_priv text)
returns text language sql stable as $$
  select coalesce(string_agg(att.attname, ',' order by att.attname), '(none)')
    from pg_attribute att
    join pg_class c on c.oid = att.attrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = p_table
     and att.attnum > 0 and not att.attisdropped
     and has_column_privilege(p_role::name, c.oid, att.attname, p_priv);
$$;

create or replace function pg_temp.cols_except(p_table text, p_except text[] default '{}')
returns text language sql stable as $$
  select coalesce(string_agg(att.attname, ',' order by att.attname), '(none)')
    from pg_attribute att
    join pg_class c on c.oid = att.attrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = p_table
     and att.attnum > 0 and not att.attisdropped
     and not (att.attname = any (p_except));
$$;

create or replace function pg_temp.v2_tables() returns text[] language sql immutable as $$
  select array[
    'admins','attempt_answers','attempts','audit_log','auth_events','auth_locks',
    'balance_ledger','bank_deposits','consents','coupon_reservations','coupons',
    'enrollments','incidents','issues','job_interests','orders','outbox','pack_quizzes',
    'payment_events','payouts','products','profiles','questions','quizzes',
    'referrals','sessions','settings']::text[];
$$;

-- ---------------------------------------------------------------------------
-- A + B. Tables, RLS, FORCE RLS
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  v_actual text;
  v_force constant text[] := array['admins','audit_log','balance_ledger','bank_deposits',
    'enrollments','job_interests','orders','payouts','profiles','referrals','sessions'];
begin
  foreach t in array pg_temp.v2_tables() loop
    select case when count(*) = 1 then 'present' else 'MISSING' end into v_actual
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t and c.relkind = 'r';
    perform pg_temp.chk('A. tables', format('public.%s exists', t), 'present', v_actual);

    select coalesce(max(case when relrowsecurity then 'on' else 'off' end), 'missing') into v_actual
      from pg_class where oid = to_regclass('public.' || t);
    perform pg_temp.chk('B. rls', format('RLS enabled on %s', t), 'on', v_actual);
  end loop;

  select coalesce(string_agg(c.relname, ',' order by c.relname), '(none)') into v_actual
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not (c.relname = any (pg_temp.v2_tables()));
  perform pg_temp.chk('A. tables', 'no unexpected tables in schema public', '(none)', v_actual);

  select coalesce(string_agg(c.relname, ',' order by c.relname), '(none)') into v_actual
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity;
  perform pg_temp.chk('B. rls', 'FORCE RLS set', array_to_string(v_force, ','), v_actual);

  -- postgres and service_role must still bypass RLS: the Edge Functions and
  -- the security definer functions depend on it under FORCE RLS.
  select string_agg(rolname || '=' || rolbypassrls, ',' order by rolname) into v_actual
    from pg_roles where rolname in ('postgres','service_role');
  perform pg_temp.chk('B. rls', 'postgres and service_role bypass RLS',
                      'postgres=true,service_role=true', v_actual);
end $$;

-- ---------------------------------------------------------------------------
-- C. Enum types
-- ---------------------------------------------------------------------------
select pg_temp.chk('C. enums', 'remaining enum types', 'enrollment_source,reward_type',
  (select coalesce(string_agg(typname, ',' order by typname), '(none)')
     from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e'));

-- ---------------------------------------------------------------------------
-- D. Answer keys
-- ---------------------------------------------------------------------------
select pg_temp.chk('D. questions', 'policies on questions', '0',
  (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'questions'));
select pg_temp.chk('D. questions', 'anon columns readable', '(none)', pg_temp.granted_cols('questions', 'anon', 'SELECT'));
select pg_temp.chk('D. questions', 'authenticated columns readable', '(none)', pg_temp.granted_cols('questions', 'authenticated', 'SELECT'));
select pg_temp.chk('D. questions', 'service_role can read', 'true',
  has_table_privilege('service_role', 'public.questions', 'select')::text);

-- ---------------------------------------------------------------------------
-- E. Policy inventory
-- ---------------------------------------------------------------------------
select pg_temp.chk('E. policies', 'exact policy inventory',
  'attempt_answers.attempt_answers_select_own:SELECT:authenticated|'
  || 'attempts.attempts_select_own:SELECT:authenticated|'
  || 'balance_ledger.balance_ledger_select_own:SELECT:authenticated|'
  || 'bank_deposits.bank_deposits_select_own:SELECT:authenticated|'
  || 'consents.consents_select_own:SELECT:authenticated|'
  || 'enrollments.enrollments_select_own:SELECT:authenticated|'
  || 'issues.issues_select_own:SELECT:authenticated|'
  || 'orders.orders_select_own:SELECT:authenticated|'
  || 'pack_quizzes.pack_quizzes_select_published:SELECT:anon+authenticated|'
  || 'payouts.payouts_select_own:SELECT:authenticated|'
  || 'products.products_select_enrolled:SELECT:authenticated|'
  || 'products.products_select_published:SELECT:anon+authenticated|'
  || 'profiles.profiles_select_own:SELECT:authenticated|'
  || 'profiles.profiles_update_own:UPDATE:authenticated|'
  || 'quizzes.quizzes_select_published:SELECT:anon+authenticated|'
  || 'referrals.referrals_select_own:SELECT:authenticated|'
  || 'sessions.sessions_select_own:SELECT:authenticated|'
  || 'settings.settings_select_display_safe:SELECT:anon+authenticated',
  (select string_agg(tablename || '.' || policyname || ':' || cmd || ':'
                     || array_to_string(array(select unnest(roles) order by 1), '+'),
                     '|' order by tablename, policyname)
     from pg_policies where schemaname = 'public'));

-- ---------------------------------------------------------------------------
-- F. Client SELECT column sets
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select * from (values
      -- table, role, expected (null = every column)
      ('products',        'anon',          pg_temp.cols_except('products', array['material_path'])),
      ('products',        'authenticated', pg_temp.cols_except('products', array['material_path'])),
      ('quizzes',         'anon',          null),
      ('quizzes',         'authenticated', null),
      ('pack_quizzes',    'anon',          null),
      ('settings',        'anon',          null),
      ('profiles',        'authenticated', null),
      ('orders',          'authenticated', null),
      ('enrollments',     'authenticated', null),
      ('attempts',        'authenticated', null),
      ('consents',        'authenticated', null),
      ('balance_ledger',  'authenticated', null),
      ('payouts',         'authenticated', null),
      ('issues',          'authenticated', null),
      ('attempt_answers', 'authenticated', null),
      ('sessions',        'authenticated', null),
      ('bank_deposits',   'authenticated', pg_temp.cols_except('bank_deposits', array['proof_path','proof_sha256','reviewed_by'])),
      ('referrals',       'authenticated', pg_temp.cols_except('referrals', array['buyer_user_id','referrer_user_id'])),
      ('orders',          'anon',          '(none)'),
      ('profiles',        'anon',          '(none)'),
      ('coupons',         'authenticated', '(none)'),
      ('admins',          'authenticated', '(none)'),
      ('incidents',       'authenticated', '(none)'),
      ('payment_events',  'authenticated', '(none)'),
      ('audit_log',       'authenticated', '(none)'),
      ('outbox',          'authenticated', '(none)'),
      ('auth_events',     'authenticated', '(none)'),
      ('auth_locks',      'authenticated', '(none)'),
      ('coupon_reservations', 'authenticated', '(none)'),
      ('job_interests',   'anon',          '(none)'),
      ('job_interests',   'authenticated', '(none)')
    ) v(tbl, role, expected)
  loop
    perform pg_temp.chk('F. select columns', format('%s readable by %s', r.tbl, r.role),
                        coalesce(r.expected, pg_temp.cols_except(r.tbl)),
                        pg_temp.granted_cols(r.tbl, r.role, 'SELECT'));
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- G. Client writes
-- ---------------------------------------------------------------------------
select pg_temp.chk('G. writes', 'client INSERT/UPDATE/DELETE/TRUNCATE anywhere',
  'profiles.display_name:authenticated:UPDATE,profiles.mobile:authenticated:UPDATE',
  (select coalesce(string_agg(x, ',' order by x), '(none)') from (
     select distinct c.relname || '.' || att.attname || ':' || r.rolname || ':' || p.priv as x
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
       cross join (values ('anon'), ('authenticated')) r(rolname)
       cross join (values ('INSERT'), ('UPDATE')) p(priv)
      where n.nspname = 'public' and c.relkind = 'r'
        and has_column_privilege(r.rolname, c.oid, att.attname, p.priv)
     union
     select distinct c.relname || ':' || r.rolname || ':' || p.priv
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join (values ('anon'), ('authenticated')) r(rolname)
       cross join (values ('DELETE'), ('TRUNCATE')) p(priv)
      where n.nspname = 'public' and c.relkind = 'r'
        and has_table_privilege(r.rolname, c.oid, p.priv)) s));

-- ---------------------------------------------------------------------------
-- H. Routine EXECUTE
-- ---------------------------------------------------------------------------
select pg_temp.chk('H. routines', 'routines executable by anon/authenticated',
  'leaderboard',
  (select coalesce(string_agg(distinct p.proname, ',' order by p.proname), '(none)')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))));

-- ---------------------------------------------------------------------------
-- I. Settings
-- ---------------------------------------------------------------------------
do $$
declare
  k text;
begin
  foreach k in array array[
    'referral_amount','payout_threshold','reward_hold_days','ref_ttl_days','exam_date',
    'quiz_attempts','session_idle_min','answer_reveal_mode','leaderboard_mode',
    'bank_bdo','bank_bpi','bank_metrobank','bank_unionbank','bank_landbank',
    'bank_account_name','bank_sla_hours','order_ttl_online_min','order_ttl_bank_h',
    'brand_name','announcement_banner','contact_email'] loop
    perform pg_temp.chk('I. settings', format('setting %s present', k), 'present',
      (select case when count(*) = 1 then 'present' else 'MISSING' end from public.settings where key = k));
  end loop;
end $$;
select pg_temp.chk('I. settings', 'settings hidden from clients', 'answer_reveal_mode',
  (select coalesce(string_agg(key, ',' order by key), '(none)') from public.settings where not display_safe));

-- ---------------------------------------------------------------------------
-- J. Idempotency guarantees
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select * from (values
      ('orders',          'orders_provider_ref_key'),
      ('orders',          'orders_provider_payment_id_key'),
      ('orders',          'orders_order_no_key'),
      ('referrals',       'referrals_order_id_key'),
      ('enrollments',     'enrollments_one_active_key'),
      ('enrollments',     'enrollments_order_product_key'),
      ('payment_events',  'payment_events_provider_event_id_key'),
      ('balance_ledger',  'balance_ledger_once_key'),
      ('payouts',         'payouts_one_open_key'),
      ('bank_deposits',   'bank_deposits_one_pending_key'),
      ('sessions',        'sessions_one_active_key'),
      ('attempts',        'attempts_one_open_key'),
      ('coupons',         'coupons_code_key'),
      ('outbox',          'outbox_dedupe_key_key'),
      ('job_interests',   'job_interests_email_key')
    ) v(tbl, idx)
  loop
    perform pg_temp.chk('J. idempotency', format('unique %s on %s', r.idx, r.tbl), 'present',
      (select case when count(*) = 1 then 'present' else 'MISSING' end
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = r.idx and i.indisunique
          and i.indrelid = to_regclass('public.' || r.tbl)));
  end loop;
end $$;
select pg_temp.chk('J. idempotency', 'check constraint referrals_no_self', 'present',
  (select case when count(*) = 1 then 'present' else 'MISSING' end
     from pg_constraint where conname = 'referrals_no_self' and contype = 'c'));

-- ---------------------------------------------------------------------------
-- K. audit_log append-only
-- ---------------------------------------------------------------------------
select pg_temp.chk('K. audit', 'append-only triggers on audit_log',
  'audit_log_no_truncate,audit_log_no_update',
  (select coalesce(string_agg(tgname, ',' order by tgname), '(none)')
     from pg_trigger where tgrelid = 'public.audit_log'::regclass and not tgisinternal));

-- ---------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------
select case when count(*) filter (where status = 'FAIL') = 0
            then 'ALL CHECKS PASSED' else 'VERIFICATION FAILED' end as summary,
       count(*) as checks,
       count(*) filter (where status = 'PASS') as passed,
       count(*) filter (where status = 'FAIL') as failed
  from verify_results;

select section, check_name, expected, actual
  from verify_results where status = 'FAIL' order by seq;
