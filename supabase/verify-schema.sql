-- verify-schema.sql
-- Platform v2 post-apply verification for migrations 0001-0010.
--
-- Run this BY HAND against a database that has had 0001-0010 applied. It is
-- read-only apart from objects it creates in pg_temp, so it is safe to run
-- against staging or production.
--
--   psql "$DATABASE_URL" -f supabase/verify-schema.sql
--
-- or paste the whole file into the Supabase SQL editor. In the SQL editor only
-- the last statement's result is shown, so the file ends with two selects: the
-- full assertion list, then a failures-only list. In psql both appear.
--
-- Every assertion prints one row: check name, expected, actual, PASS or FAIL.
-- Nothing here reads questions.correct_key or questions.explanation; the
-- assertions are all against the system catalogs and public.settings.
--
-- What it asserts:
--   A. All 13 tables exist, and no extra table snuck into schema public
--   B. RLS enabled on all 13; FORCE RLS on the four identity/money tables;
--      postgres and service_role still hold BYPASSRLS, which FORCE RLS makes
--      load-bearing for the whole webhook path
--   C. The six enum types from 0001 exist
--   D. questions: zero policies, zero client grants on every column,
--      service_role can still read it, no view or definer routine over it
--   E. The 11 expected policies exist by name/command/role, and nothing else
--   F. Effective client SELECT column sets match the declared inventory,
--      computed from the live column list so a column added later and left out
--      of a grant is caught
--   G. Zero client INSERT/UPDATE/DELETE/TRUNCATE anywhere, except the
--      profiles UPDATE(display_name, gcash_number) grant
--   H. Zero client EXECUTE on any routine in schema public
--   I. The ten seeded settings rows are present, answer_reveal_mode is
--      display_safe = false, and the other nine are display_safe = true
--   J. The three database-level idempotency guarantees behind Requirement 16.1
--      plus the referrals_no_self check
--
-- Known deviation, reported rather than enforced: 0008 grants 14 products
-- columns including created_at. The design.md prose snippet lists 13 and omits
-- created_at, while the design's policy inventory table says only "SELECT" for
-- products. This script follows the migration (all columns except
-- material_path). See the report accompanying task 4.

-- No psql meta-commands are used, so the file pastes cleanly into the Supabase
-- SQL editor. Under psql, add -v ON_ERROR_STOP=1 if you want it to stop early.

-- ---------------------------------------------------------------------------
-- Scaffolding (pg_temp only)
-- ---------------------------------------------------------------------------

drop table if exists pg_temp.verify_results;

create temp table verify_results (
  seq      serial primary key,
  section  text not null,
  check_name text not null,
  expected text not null,
  actual   text not null,
  status   text not null
);

create or replace function pg_temp.chk(p_section text, p_name text, p_expected text, p_actual text)
returns void language plpgsql as $$
begin
  insert into verify_results (section, check_name, expected, actual, status)
  values (
    p_section, p_name,
    coalesce(p_expected, '<null>'), coalesce(p_actual, '<null>'),
    case when coalesce(p_expected, '<null>') = coalesce(p_actual, '<null>')
         then 'PASS' else 'FAIL' end
  );
end $$;

-- Every live column of a public table, alphabetically, minus an exclusion list.
-- Driven by the catalog so a column added in a later migration and forgotten in
-- a grant list shows up as a FAIL here rather than as a silent omission.
create or replace function pg_temp.cols_except(p_table text, p_except text[] default '{}'::text[])
returns text language sql stable as $$
  select coalesce(string_agg(att.attname, ',' order by att.attname), '(none)')
  from pg_attribute att
  join pg_class c     on c.oid = att.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = p_table
    and att.attnum > 0
    and not att.attisdropped
    and not (att.attname = any (p_except));
$$;

-- Effective privilege, not just the explicit grant: has_column_privilege folds
-- in table-level grants, column-level grants, and anything inherited through
-- PUBLIC or role membership. That is the question we actually care about.
create or replace function pg_temp.granted_cols(p_table text, p_role text, p_priv text)
returns text language sql stable as $$
  select coalesce(string_agg(att.attname, ',' order by att.attname), '(none)')
  from pg_attribute att
  join pg_class c     on c.oid = att.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = p_table
    and att.attnum > 0
    and not att.attisdropped
    and has_column_privilege(p_role::name, c.oid, att.attname, p_priv);
$$;

create or replace function pg_temp.tables13() returns text[] language sql immutable as $$
  select array[
    'profiles', 'admin_bootstrap_emails', 'products', 'quizzes',
    'pack_quizzes', 'questions', 'orders', 'enrollments', 'quiz_attempts',
    'referrals', 'payment_incidents', 'payout_requests', 'settings'
  ]::text[];
$$;

-- ---------------------------------------------------------------------------
-- A. Tables exist, and only those tables
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  v_actual text;
begin
  foreach t in array pg_temp.tables13() loop
    select case when count(*) = 1 then 'present' else 'MISSING' end into v_actual
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t and c.relkind = 'r';
    perform pg_temp.chk('A. tables', format('table public.%s exists', t),
                        'present', v_actual);
  end loop;

  select coalesce(string_agg(c.relname, ',' order by c.relname), '(none)')
    into v_actual
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and not (c.relname = any (pg_temp.tables13()));
  perform pg_temp.chk('A. tables', 'no unexpected tables in schema public',
                      '(none)', v_actual);
end $$;

-- ---------------------------------------------------------------------------
-- B. RLS enabled on all 13; FORCE RLS on the four identity/money tables
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  v_rls boolean;
  v_force boolean;
  v_forced constant text[] := array['profiles', 'orders', 'enrollments', 'referrals'];
begin
  foreach t in array pg_temp.tables13() loop
    select c.relrowsecurity, c.relforcerowsecurity into v_rls, v_force
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t;

    perform pg_temp.chk('B. rls', format('RLS enabled on %s', t),
                        'true', coalesce(v_rls::text, 'table absent'));

    perform pg_temp.chk('B. rls', format('FORCE RLS on %s', t),
                        (t = any (v_forced))::text,
                        coalesce(v_force::text, 'table absent'));
  end loop;

  -- FORCE RLS removes the table owner's exemption, so the whole money path
  -- depends on postgres and service_role holding BYPASSRLS instead. If either
  -- is false, fulfil_payment's writes to orders, enrollments, and referrals hit
  -- tables with zero permissive write policies and fail closed — the webhook
  -- stops fulfilling payments. This is the one deploy-time check worth doing
  -- before the first real payment, which is why it is asserted here.
  perform pg_temp.chk('B. rls', 'role postgres holds BYPASSRLS',
    'true', coalesce((select rolbypassrls::text from pg_roles where rolname = 'postgres'), 'role absent'));
  perform pg_temp.chk('B. rls', 'role service_role holds BYPASSRLS',
    'true', coalesce((select rolbypassrls::text from pg_roles where rolname = 'service_role'), 'role absent'));
end $$;

-- ---------------------------------------------------------------------------
-- C. Enum types from 0001
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  v_actual text;
  v_enums constant text[] := array['product_type', 'order_status',
    'enrollment_source', 'referral_status', 'reward_type', 'incident_kind'];
begin
  foreach t in array v_enums loop
    select case when count(*) = 1 then 'present' else 'MISSING' end into v_actual
      from pg_type ty join pg_namespace n on n.oid = ty.typnamespace
     where n.nspname = 'public' and ty.typname = t and ty.typtype = 'e';
    perform pg_temp.chk('C. enums', format('enum type %s exists', t),
                        'present', v_actual);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- D. The answer-key guarantee
-- ---------------------------------------------------------------------------

do $$
declare
  v_actual text;
  v_n integer;
begin
  -- Zero policies (Requirement 6.1).
  select count(*) into v_n
    from pg_policies where schemaname = 'public' and tablename = 'questions';
  perform pg_temp.chk('D. questions', 'policy count on public.questions',
                      '0', v_n::text);

  -- Zero client-readable columns, for anon and for authenticated. This folds in
  -- PUBLIC-inherited grants, so it is the whole question, not part of it.
  perform pg_temp.chk('D. questions', 'columns anon can SELECT',
                      '(none)', pg_temp.granted_cols('questions', 'anon', 'SELECT'));
  perform pg_temp.chk('D. questions', 'columns authenticated can SELECT',
                      '(none)', pg_temp.granted_cols('questions', 'authenticated', 'SELECT'));
  perform pg_temp.chk('D. questions', 'columns anon can INSERT',
                      '(none)', pg_temp.granted_cols('questions', 'anon', 'INSERT'));
  perform pg_temp.chk('D. questions', 'columns authenticated can INSERT',
                      '(none)', pg_temp.granted_cols('questions', 'authenticated', 'INSERT'));
  perform pg_temp.chk('D. questions', 'columns anon can UPDATE',
                      '(none)', pg_temp.granted_cols('questions', 'anon', 'UPDATE'));
  perform pg_temp.chk('D. questions', 'columns authenticated can UPDATE',
                      '(none)', pg_temp.granted_cols('questions', 'authenticated', 'UPDATE'));

  perform pg_temp.chk('D. questions', 'anon table-level DELETE on questions',
    'false', has_table_privilege('anon'::name, 'public.questions'::regclass::oid, 'DELETE')::text);
  perform pg_temp.chk('D. questions', 'authenticated table-level DELETE on questions',
    'false', has_table_privilege('authenticated'::name, 'public.questions'::regclass::oid, 'DELETE')::text);

  -- The one read path that must exist (Requirement 6.6).
  perform pg_temp.chk('D. questions', 'service_role can SELECT questions',
    'true', has_table_privilege('service_role'::name, 'public.questions'::regclass::oid, 'SELECT')::text);

  -- No view or materialised view anywhere in public depends on questions.
  -- A security_invoker view would be harmless, but the rule in 0006 is simply
  -- "no view over this table", so that is what is checked.
  select coalesce(string_agg(distinct v.relname, ',' order by v.relname), '(none)')
    into v_actual
    from pg_depend d
    join pg_rewrite r  on r.oid = d.objid
    join pg_class v    on v.oid = r.ev_class
    join pg_class q    on q.oid = d.refobjid
    join pg_namespace qn on qn.oid = q.relnamespace
   where d.classid    = 'pg_rewrite'::regclass
     and d.refclassid = 'pg_class'::regclass
     and qn.nspname = 'public' and q.relname = 'questions'
     and v.relkind in ('v', 'm')
     and v.relname <> 'questions';
  perform pg_temp.chk('D. questions', 'views depending on questions',
                      '(none)', v_actual);

  -- No routine in public is both SECURITY DEFINER and client-executable.
  -- That is the shape 0006 forbids: a definer routine hands a client role its
  -- owner's privileges, which is exactly the read the missing grant denies.
  select coalesce(string_agg(distinct p.proname, ',' order by p.proname), '(none)')
    into v_actual
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and (has_function_privilege('anon'::name, p.oid, 'EXECUTE')
       or has_function_privilege('authenticated'::name, p.oid, 'EXECUTE'));
  perform pg_temp.chk('D. questions',
                      'client-executable SECURITY DEFINER routines in public',
                      '(none)', v_actual);
end $$;

-- ---------------------------------------------------------------------------
-- E. Policy inventory — exactly 11 policies, by name, command, and role
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  v_actual text;
  v_extra text;
begin
  for r in
    select * from (values
      ('profiles',        'profiles_select_own',           'SELECT', 'authenticated'),
      ('profiles',        'profiles_update_own',           'UPDATE', 'authenticated'),
      ('products',        'products_select_published',     'SELECT', 'anon,authenticated'),
      ('quizzes',         'quizzes_select_published',      'SELECT', 'anon,authenticated'),
      ('pack_quizzes',    'pack_quizzes_select_published', 'SELECT', 'anon,authenticated'),
      ('orders',          'orders_select_own',             'SELECT', 'authenticated'),
      ('enrollments',     'enrollments_select_own',        'SELECT', 'authenticated'),
      ('quiz_attempts',   'quiz_attempts_select_own',      'SELECT', 'authenticated'),
      ('referrals',       'referrals_select_own',          'SELECT', 'authenticated'),
      ('payout_requests', 'payout_requests_select_own',    'SELECT', 'authenticated'),
      ('settings',        'settings_select_display_safe',  'SELECT', 'anon,authenticated')
    ) as e(tbl, pol, cmd, roles)
  loop
    select coalesce(
             pp.cmd || ' to ' || array_to_string(
               (select array_agg(u.rolename order by u.rolename)
                  from unnest(pp.roles) as u(rolename)), ','),
             'MISSING')
      into v_actual
      from pg_policies pp
     where pp.schemaname = 'public'
       and pp.tablename = r.tbl
       and pp.policyname = r.pol;

    perform pg_temp.chk('E. policies',
                        format('%s.%s', r.tbl, r.pol),
                        format('%s to %s', r.cmd, r.roles),
                        coalesce(v_actual, 'MISSING'));
  end loop;

  -- Nothing beyond those 11. An extra permissive policy is how the model gets
  -- quietly widened later, so the absence is asserted, not assumed.
  select coalesce(string_agg(pp.tablename || '.' || pp.policyname, ',' order by pp.tablename || '.' || pp.policyname), '(none)')
    into v_extra
    from pg_policies pp
   where pp.schemaname = 'public'
     and pp.policyname not in (
       'profiles_select_own', 'profiles_update_own', 'products_select_published',
       'quizzes_select_published', 'pack_quizzes_select_published',
       'orders_select_own', 'enrollments_select_own', 'quiz_attempts_select_own',
       'referrals_select_own', 'payout_requests_select_own',
       'settings_select_display_safe');
  perform pg_temp.chk('E. policies', 'no unexpected policies in schema public',
                      '(none)', v_extra);

  select count(*)::text into v_actual
    from pg_policies where schemaname = 'public';
  perform pg_temp.chk('E. policies', 'total policy count in schema public',
                      '11', v_actual);
end $$;

-- ---------------------------------------------------------------------------
-- F. Client SELECT column sets — computed from the live column list
-- ---------------------------------------------------------------------------
-- Expected values are derived with cols_except(), not hard-coded. A column
-- added to products in a later migration and left out of the 0008 grant list
-- therefore fails here, which is the whole point of checking it this way.

do $$
begin
  -- profiles: whole-table SELECT to authenticated, nothing to anon.
  perform pg_temp.chk('F. select grants', 'profiles / authenticated SELECT',
    pg_temp.cols_except('profiles'), pg_temp.granted_cols('profiles', 'authenticated', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'profiles / anon SELECT',
    '(none)', pg_temp.granted_cols('profiles', 'anon', 'SELECT'));

  -- products: every column except material_path, to both client roles.
  perform pg_temp.chk('F. select grants', 'products / anon SELECT (minus material_path)',
    pg_temp.cols_except('products', array['material_path']),
    pg_temp.granted_cols('products', 'anon', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'products / authenticated SELECT (minus material_path)',
    pg_temp.cols_except('products', array['material_path']),
    pg_temp.granted_cols('products', 'authenticated', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'products.material_path unreadable by anon',
    'false', has_column_privilege('anon'::name, 'public.products'::regclass::oid, 'material_path', 'SELECT')::text);
  perform pg_temp.chk('F. select grants', 'products.material_path unreadable by authenticated',
    'false', has_column_privilege('authenticated'::name, 'public.products'::regclass::oid, 'material_path', 'SELECT')::text);

  -- quizzes and pack_quizzes: whole table to both client roles.
  perform pg_temp.chk('F. select grants', 'quizzes / anon SELECT',
    pg_temp.cols_except('quizzes'), pg_temp.granted_cols('quizzes', 'anon', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'quizzes / authenticated SELECT',
    pg_temp.cols_except('quizzes'), pg_temp.granted_cols('quizzes', 'authenticated', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'pack_quizzes / anon SELECT',
    pg_temp.cols_except('pack_quizzes'), pg_temp.granted_cols('pack_quizzes', 'anon', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'pack_quizzes / authenticated SELECT',
    pg_temp.cols_except('pack_quizzes'), pg_temp.granted_cols('pack_quizzes', 'authenticated', 'SELECT'));

  -- orders, enrollments, quiz_attempts, payout_requests: whole table to
  -- authenticated, nothing to anon.
  perform pg_temp.chk('F. select grants', 'orders / authenticated SELECT',
    pg_temp.cols_except('orders'), pg_temp.granted_cols('orders', 'authenticated', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'orders / anon SELECT',
    '(none)', pg_temp.granted_cols('orders', 'anon', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'enrollments / authenticated SELECT',
    pg_temp.cols_except('enrollments'), pg_temp.granted_cols('enrollments', 'authenticated', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'enrollments / anon SELECT',
    '(none)', pg_temp.granted_cols('enrollments', 'anon', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'quiz_attempts / authenticated SELECT',
    pg_temp.cols_except('quiz_attempts'), pg_temp.granted_cols('quiz_attempts', 'authenticated', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'quiz_attempts / anon SELECT',
    '(none)', pg_temp.granted_cols('quiz_attempts', 'anon', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'payout_requests / authenticated SELECT',
    pg_temp.cols_except('payout_requests'), pg_temp.granted_cols('payout_requests', 'authenticated', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'payout_requests / anon SELECT',
    '(none)', pg_temp.granted_cols('payout_requests', 'anon', 'SELECT'));

  -- referrals: every column except the two identity columns.
  perform pg_temp.chk('F. select grants', 'referrals / authenticated SELECT (minus buyer_user_id, referrer_user_id)',
    pg_temp.cols_except('referrals', array['buyer_user_id', 'referrer_user_id']),
    pg_temp.granted_cols('referrals', 'authenticated', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'referrals / anon SELECT',
    '(none)', pg_temp.granted_cols('referrals', 'anon', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'referrals.buyer_user_id unreadable by authenticated',
    'false', has_column_privilege('authenticated'::name, 'public.referrals'::regclass::oid, 'buyer_user_id', 'SELECT')::text);
  perform pg_temp.chk('F. select grants', 'referrals.referrer_user_id unreadable by authenticated',
    'false', has_column_privilege('authenticated'::name, 'public.referrals'::regclass::oid, 'referrer_user_id', 'SELECT')::text);

  -- settings: whole table to both client roles; the row filter is the control.
  perform pg_temp.chk('F. select grants', 'settings / anon SELECT',
    pg_temp.cols_except('settings'), pg_temp.granted_cols('settings', 'anon', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'settings / authenticated SELECT',
    pg_temp.cols_except('settings'), pg_temp.granted_cols('settings', 'authenticated', 'SELECT'));

  -- payment_incidents and admin_bootstrap_emails: nothing, to either role.
  perform pg_temp.chk('F. select grants', 'payment_incidents / anon SELECT',
    '(none)', pg_temp.granted_cols('payment_incidents', 'anon', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'payment_incidents / authenticated SELECT',
    '(none)', pg_temp.granted_cols('payment_incidents', 'authenticated', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'admin_bootstrap_emails / anon SELECT',
    '(none)', pg_temp.granted_cols('admin_bootstrap_emails', 'anon', 'SELECT'));
  perform pg_temp.chk('F. select grants', 'admin_bootstrap_emails / authenticated SELECT',
    '(none)', pg_temp.granted_cols('admin_bootstrap_emails', 'authenticated', 'SELECT'));
end $$;

-- ---------------------------------------------------------------------------
-- G. Write privileges — one exception in the whole schema
-- ---------------------------------------------------------------------------
-- Column-level grants do not show up in has_table_privilege, so INSERT and
-- UPDATE are checked per column and DELETE/TRUNCATE/TRIGGER/REFERENCES at the
-- table level. The single permitted client write is
-- profiles UPDATE(display_name, gcash_number).

do $$
declare
  t text;
  rl text;
  v_expected text;
begin
  foreach t in array pg_temp.tables13() loop
    foreach rl in array array['anon', 'authenticated'] loop

      perform pg_temp.chk('G. write grants', format('%s / %s INSERT columns', t, rl),
        '(none)', pg_temp.granted_cols(t, rl, 'INSERT'));

      v_expected := case
        when t = 'profiles' and rl = 'authenticated' then 'display_name,gcash_number'
        else '(none)' end;
      perform pg_temp.chk('G. write grants', format('%s / %s UPDATE columns', t, rl),
        v_expected, pg_temp.granted_cols(t, rl, 'UPDATE'));

      perform pg_temp.chk('G. write grants', format('%s / %s REFERENCES columns', t, rl),
        '(none)', pg_temp.granted_cols(t, rl, 'REFERENCES'));

      perform pg_temp.chk('G. write grants', format('%s / %s DELETE', t, rl),
        'false', has_table_privilege(rl::name, ('public.' || quote_ident(t))::regclass::oid, 'DELETE')::text);

      perform pg_temp.chk('G. write grants', format('%s / %s TRUNCATE', t, rl),
        'false', has_table_privilege(rl::name, ('public.' || quote_ident(t))::regclass::oid, 'TRUNCATE')::text);

      perform pg_temp.chk('G. write grants', format('%s / %s TRIGGER', t, rl),
        'false', has_table_privilege(rl::name, ('public.' || quote_ident(t))::regclass::oid, 'TRIGGER')::text);

    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- H. Routine EXECUTE — no client-callable RPC in schema public
-- ---------------------------------------------------------------------------
-- PostgREST publishes every function in schema public as an RPC endpoint, so a
-- surviving EXECUTE grant is a reachable endpoint. 0005 revokes from anon,
-- authenticated, and PUBLIC; this confirms it held, including for functions
-- added after 0005 (fulfil_payment, refund_payment, fail_payment).

do $$
declare
  v_actual text;
begin
  select coalesce(string_agg(distinct p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'), '(none)')
    into v_actual
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and has_function_privilege('anon'::name, p.oid, 'EXECUTE');
  perform pg_temp.chk('H. routines', 'routines in public executable by anon',
                      '(none)', v_actual);

  select coalesce(string_agg(distinct p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'), '(none)')
    into v_actual
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and has_function_privilege('authenticated'::name, p.oid, 'EXECUTE');
  perform pg_temp.chk('H. routines', 'routines in public executable by authenticated',
                      '(none)', v_actual);

  -- The provisioning functions and triggers from 0003 are still in place.
  select coalesce(string_agg(p.proname, ',' order by p.proname), '(none)') into v_actual
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('gen_ref_code', 'handle_new_user', 'mask_email', 'guard_profile_columns');
  perform pg_temp.chk('H. routines', '0003 functions present',
    'gen_ref_code,guard_profile_columns,handle_new_user,mask_email', v_actual);

  select case when count(*) = 1 then 'present' else 'MISSING' end into v_actual
    from pg_trigger where tgname = 'on_auth_user_created' and not tgisinternal;
  perform pg_temp.chk('H. routines', 'trigger on_auth_user_created', 'present', v_actual);

  select case when count(*) = 1 then 'present' else 'MISSING' end into v_actual
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
   where tg.tgname = 'profiles_guard_columns' and not tg.tgisinternal
     and c.relname = 'profiles';
  perform pg_temp.chk('H. routines', 'trigger profiles_guard_columns', 'present', v_actual);

  -- 0005 section 1: default privileges in schema public must grant nothing to
  -- anon, authenticated, or PUBLIC, so a table or function added later arrives
  -- with no client privilege attached. This is what makes 0011+ safe by
  -- default rather than safe by remembering.
  -- A FAIL here names the owning role of the surviving default. 0005's ALTER
  -- DEFAULT PRIVILEGES applies only to objects created by the role that ran the
  -- migration (postgres). If the reported owner is another role — on Supabase,
  -- usually supabase_admin — repeat the four revokes from 0005 section 1 with
  -- FOR ROLE <that role>.
  select coalesce(string_agg(
           'owner=' || da.defaclrole::regrole::text
             || ' objtype=' || da.defaclobjtype
             || ' grantee=' || a.grantee::regrole::text
             || ' priv=' || a.privilege_type,
           ', ' order by da.defaclrole::regrole::text || da.defaclobjtype || a.privilege_type),
         '(none)')
    into v_actual
    from pg_default_acl da
    join pg_namespace n on n.oid = da.defaclnamespace
    cross join lateral aclexplode(da.defaclacl) a
   where n.nspname = 'public'
     and (a.grantee = 0
       or a.grantee = to_regrole('anon')::oid
       or a.grantee = to_regrole('authenticated')::oid);
  perform pg_temp.chk('H. routines',
    'default privileges in public granted to anon/authenticated/PUBLIC',
    '(none)', v_actual);
end $$;

-- ---------------------------------------------------------------------------
-- I. Seeded settings
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  v_actual text;
  v_n integer;
begin
  select count(*) into v_n from public.settings;
  perform pg_temp.chk('I. settings', 'seeded settings row count', '10', v_n::text);

  for r in
    select * from (values
      ('referral_amount',     '9'::text,              true),
      ('reward_type',         'cash'::text,           true),
      ('payout_threshold',    '100'::text,            true),
      ('reward_on',           'every_purchase'::text, true),
      ('answer_reveal_mode',  'answered_only'::text,  false),
      ('brand_name',          null::text,             true),
      ('contact_email',       null::text,             true),
      ('announcement_banner', null::text,             true),
      ('hero_headline',       null::text,             true),
      ('hero_subhead',        null::text,             true)
    ) as e(k, v, safe)
  loop
    -- Value is asserted only where the requirement fixes it. The copy keys are
    -- admin-editable, so only presence and display_safe are checked for those.
    select coalesce(
             case when r.v is null then '' else s.value || ' / ' end
             || 'display_safe=' || s.display_safe::text,
             'MISSING')
      into v_actual
      from public.settings s where s.key = r.k;

    perform pg_temp.chk('I. settings', format('settings[%s]', r.k),
      case when r.v is null then '' else r.v || ' / ' end
        || 'display_safe=' || r.safe::text,
      coalesce(v_actual, 'MISSING'));
  end loop;

  -- Stated on its own because it is the load-bearing one: Requirements 6.13 and
  -- 9.9 both hang on answer_reveal_mode never being display-safe.
  select coalesce(display_safe::text, 'row missing') into v_actual
    from public.settings where key = 'answer_reveal_mode';
  perform pg_temp.chk('I. settings',
    'answer_reveal_mode is NOT display-safe (Req 6.13, 9.9)',
    'false', coalesce(v_actual, 'row missing'));

  -- And the row filter that depends on it: no client-visible row may be one of
  -- the private keys.
  select coalesce(string_agg(key, ',' order by key), '(none)') into v_actual
    from public.settings where display_safe and key = 'answer_reveal_mode';
  perform pg_temp.chk('I. settings',
    'answer_reveal_mode absent from the display-safe set', '(none)', v_actual);
end $$;

-- ---------------------------------------------------------------------------
-- J. The three database-level idempotency guarantees
-- ---------------------------------------------------------------------------
-- Requirement 16.1. fulfil_payment's `on conflict do nothing` is only a
-- guarantee because these three exist; without them a replayed webhook
-- double-enrolls or double-credits. Cheap to assert, expensive to discover
-- missing.

do $$
declare
  v_actual text;
begin
  select case when count(*) = 1 then 'present' else 'MISSING' end into v_actual
    from pg_constraint con join pg_class c on c.oid = con.conrelid
   where c.relname = 'enrollments' and con.conname = 'enrollments_user_product_key'
     and con.contype = 'u';
  perform pg_temp.chk('J. idempotency', 'unique (user_id, product_id) on enrollments',
                      'present', v_actual);

  select case when count(*) = 1 then 'present' else 'MISSING' end into v_actual
    from pg_constraint con join pg_class c on c.oid = con.conrelid
   where c.relname = 'referrals' and con.contype = 'u'
     and (select array_agg(att.attname order by att.attname)
            from pg_attribute att
           where att.attrelid = con.conrelid and att.attnum = any (con.conkey)) = array['order_id'];
  perform pg_temp.chk('J. idempotency', 'unique (order_id) on referrals',
                      'present', v_actual);

  select case when count(*) = 1 then 'present' else 'MISSING' end into v_actual
    from pg_class i join pg_namespace n on n.oid = i.relnamespace
   where n.nspname = 'public' and i.relname = 'orders_hitpay_payment_id_key'
     and i.relkind = 'i';
  perform pg_temp.chk('J. idempotency', 'partial unique index on orders.hitpay_payment_id',
                      'present', v_actual);

  select case when count(*) = 1 then 'present' else 'MISSING' end into v_actual
    from pg_constraint con join pg_class c on c.oid = con.conrelid
   where c.relname = 'referrals' and con.conname = 'referrals_no_self'
     and con.contype = 'c';
  perform pg_temp.chk('J. idempotency', 'check constraint referrals_no_self',
                      'present', v_actual);
end $$;

-- ---------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------

select
  status,
  section,
  check_name,
  expected,
  actual
from verify_results
order by (status = 'PASS'), seq;

select
  case when count(*) filter (where status = 'FAIL') = 0
       then 'ALL CHECKS PASSED'
       else 'VERIFICATION FAILED' end                    as result,
  count(*)                                              as total,
  count(*) filter (where status = 'PASS')               as passed,
  count(*) filter (where status = 'FAIL')               as failed,
  coalesce(string_agg(section || ' :: ' || check_name, ' | ')
           filter (where status = 'FAIL'), '')          as failures
from verify_results;

-- Uncomment to make the script exit non-zero under psql when anything failed.
-- The two selects above have already printed by the time this runs.
--
-- do $$
-- declare v_n integer;
-- begin
--   select count(*) into v_n from verify_results where status = 'FAIL';
--   if v_n > 0 then
--     raise exception 'verify-schema: % assertion(s) failed', v_n;
--   end if;
-- end $$;
