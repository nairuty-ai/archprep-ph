-- 01_reset.sql — WIPE every ArchPrep object in schema public.
--
-- !! DESTRUCTIVE: deletes all products, quizzes, questions, orders, enrollments,
-- referrals, payouts, settings and profiles. Use only while the database holds
-- test data. auth.users (sign-in accounts) is left alone; 02_all_migrations.sql
-- recreates their profiles.
--
-- Safe to run on a database where some or none of the migrations ran.

drop table if exists
  public.payout_requests,
  public.payment_incidents,
  public.referrals,
  public.quiz_attempts,
  public.enrollments,
  public.orders,
  public.questions,
  public.pack_quizzes,
  public.quizzes,
  public.products,
  public.settings,
  public.admin_bootstrap_emails,
  public.profiles
cascade;

-- CASCADE on handle_new_user also removes the on_auth_user_created trigger on
-- auth.users, which cannot be dropped directly (auth.users is not ours).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('gen_ref_code', 'handle_new_user', 'mask_email',
                         'guard_profile_columns', 'fulfil_payment',
                         'refund_payment', 'fail_payment')
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

drop type if exists
  public.product_type,
  public.order_status,
  public.enrollment_source,
  public.referral_status,
  public.reward_type,
  public.incident_kind
cascade;
