-- 01_reset.sql — WIPE every ArkiPrep object in schema public.
--
-- !! DESTRUCTIVE: deletes all products, quizzes, questions, orders, enrollments,
-- attempts, referrals, payouts, deposits, coupons, settings, profiles and the
-- audit log. Use only while the database holds test data. auth.users
-- (sign-in accounts) is left alone; 02_all_migrations.sql recreates their
-- profiles.
--
-- Safe to run on a database where some, all or none of the migrations ran.
-- Objects that belong to a Postgres extension are never touched.

do $$
declare r record;
begin
  -- Scheduled jobs (pg_cron may not be installed).
  if to_regclass('cron.job') is not null then
    for r in execute $q$select jobname from cron.job where jobname like 'arkiprep-%'$q$ loop
      perform cron.unschedule(r.jobname);
    end loop;
  end if;

  for r in
    select c.oid::regclass as obj from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p','v','m')
       and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  loop
    execute format('drop table if exists %s cascade', r.obj);
  end loop;

  -- CASCADE on handle_new_user also removes the on_auth_user_created trigger
  -- on auth.users, which cannot be dropped directly (auth.users is not ours).
  for r in
    select p.oid::regprocedure as sig from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;

  for r in
    select c.oid::regclass as obj from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
       and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  loop
    execute format('drop sequence if exists %s cascade', r.obj);
  end loop;

  for r in
    select t.oid::regtype as typ from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' and t.typtype = 'e'
       and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
  loop
    execute format('drop type if exists %s cascade', r.typ);
  end loop;
end $$;
