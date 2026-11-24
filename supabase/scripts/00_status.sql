-- 00_status.sql — which migrations have been applied to this database?
--
-- Read-only. Paste into Supabase SQL Editor → Run. One row per migration.
-- v2 (0013+) replaces some v1 objects, so a v1 row also reads "yes" when its
-- v2 replacement is present. 0006 has no object of its own to detect (it only
-- revokes/grants and asserts), so it is reported as applied when 0007 is.

with checks(migration, applied) as (
  values
  ('0001_schema_core',            to_regclass('public.questions') is not null),
  ('0002_schema_money',           to_regclass('public.referrals') is not null),
  ('0003_functions_triggers',     exists (select 1 from pg_trigger where tgname = 'on_auth_user_created')),
  ('0004_settings_seed',          to_regclass('public.settings') is not null),
  ('0005_rls_baseline',           coalesce((select relrowsecurity from pg_class
                                            where oid = to_regclass('public.settings')), false)),
  ('0006_rls_questions',          exists (select 1 from pg_policies where policyname = 'profiles_update_own')),
  ('0007_rls_profiles',           exists (select 1 from pg_policies where policyname = 'profiles_update_own')),
  ('0008_rls_catalog',            exists (select 1 from pg_policies where policyname = 'pack_quizzes_select_published')),
  ('0009_rls_owner_scoped',       exists (select 1 from pg_policies where policyname = 'orders_select_own')),
  ('0010_rls_settings',           exists (select 1 from pg_policies where policyname = 'settings_select_display_safe')),
  ('0011_fn_fulfil_payment',      exists (select 1 from pg_proc where proname in ('fulfil_payment','fulfil_order'))),
  ('0012_fn_refund_fail_payment', exists (select 1 from pg_proc where proname in ('fail_payment','refund_order'))),
  ('0013_v2_ops',                 to_regclass('public.audit_log') is not null),
  ('0014_v2_catalog',             exists (select 1 from information_schema.columns
                                           where table_schema = 'public' and table_name = 'products'
                                             and column_name = 'access_mode')),
  ('0015_v2_identity',            to_regclass('public.admins') is not null),
  ('0016_v2_learning',            to_regclass('public.attempts') is not null),
  ('0017_v2_money',               to_regclass('public.balance_ledger') is not null),
  ('0018_v2_rls',                 exists (select 1 from pg_policies where policyname = 'products_select_enrolled')),
  ('0019_fn_v2_identity',         exists (select 1 from pg_proc where proname = 'complete_signup')),
  ('0020_fn_v2_orders',           exists (select 1 from pg_proc where proname = 'fulfil_order')),
  ('0021_fn_v2_learning',         exists (select 1 from pg_proc where proname = 'start_attempt')),
  ('0022_fn_v2_payouts_jobs',     exists (select 1 from pg_proc where proname = 'request_payout')),
  ('0023_setting_login_email_code', exists (select 1 from public.settings where key = 'login_email_code')),
  ('0024_job_interests',          to_regclass('public.job_interests') is not null)
)
select migration, case when applied then 'yes' else '— NOT APPLIED' end as applied
from checks
union all
select 'auth users (signed-in test accounts)', (select count(*)::text from auth.users);
