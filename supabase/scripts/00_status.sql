-- 00_status.sql — which migrations have been applied to this database?
--
-- Read-only. Paste into Supabase SQL Editor → Run. One row per migration.
-- 0006 has no object of its own to detect (it only revokes/grants and asserts),
-- so it is reported as applied when 0007 is.

with checks(migration, applied) as (
  values
  ('0001_schema_core',           to_regclass('public.questions') is not null
                                 and to_regtype('public.incident_kind') is not null),
  ('0002_schema_money',          to_regclass('public.payout_requests') is not null),
  ('0003_functions_triggers',    exists (select 1 from pg_trigger where tgname = 'on_auth_user_created')),
  ('0004_settings_seed',         to_regclass('public.settings') is not null),
  ('0005_rls_baseline',          coalesce((select relrowsecurity from pg_class
                                           where oid = to_regclass('public.settings')), false)),
  ('0006_rls_questions',         exists (select 1 from pg_policies where policyname = 'profiles_update_own')),
  ('0007_rls_profiles',          exists (select 1 from pg_policies where policyname = 'profiles_update_own')),
  ('0008_rls_catalog',           exists (select 1 from pg_policies where policyname = 'pack_quizzes_select_published')),
  ('0009_rls_owner_scoped',      exists (select 1 from pg_policies where policyname = 'payout_requests_select_own')),
  ('0010_rls_settings',          exists (select 1 from pg_policies where policyname = 'settings_select_display_safe')),
  ('0011_fn_fulfil_payment',     exists (select 1 from pg_proc where proname = 'fulfil_payment')),
  ('0012_fn_refund_fail_payment',exists (select 1 from pg_proc where proname = 'fail_payment'))
)
select migration, case when applied then 'yes' else '— NOT APPLIED' end as applied
from checks
union all
select 'auth users (signed-in test accounts)', (select count(*)::text from auth.users);
