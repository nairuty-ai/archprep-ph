-- 0005_rls_baseline.sql
-- Platform v2 default-deny baseline: revoke every client privilege in the
-- public schema, stop future objects from inheriting one, and enable RLS on
-- every table.
--
-- This migration grants NOTHING back. Every deliberate client privilege is
-- added by 0006-0010:
--   0006  questions lockdown (service_role select only, no client grant ever)
--   0007  profiles select + column-level update
--   0008  catalog select (products minus material_path, quizzes, pack_quizzes)
--   0009  owner-scoped select on orders, enrollments, quiz_attempts,
--         payout_requests, referrals (column-restricted)
--   0010  settings display-safe allowlist
-- If a table or column is not named in one of those files, no client role can
-- reach it. That is the whole point of this file: a policy is powerless without
-- a grant, and a grant is powerless without a policy.
--
-- Runs after 0003, so the function revokes below also cover gen_ref_code(),
-- handle_new_user(), mask_email(), and guard_profile_columns(). Re-runnable:
-- every statement here is idempotent.
--
-- Requirements: 5.1, 5.2

-- ---------------------------------------------------------------------------
-- 1. Default privileges — close the door on objects that do not exist yet
-- ---------------------------------------------------------------------------
-- Supabase ships permissive default privileges on the public schema, so a table
-- created by a later migration would silently arrive with client privileges
-- attached. These statements flip that default to "nothing", which makes every
-- grant in 0006-0010 a deliberate, reviewable act.
--
-- ALTER DEFAULT PRIVILEGES applies only to objects created by the role that
-- runs it (FOR ROLE defaults to the current role). Migrations are applied as
-- `postgres`, which is the same role Supabase's permissive defaults are
-- attached to, so the plain form is the correct one here. An object created by
-- some other role from the dashboard is outside its reach — hence the blanket
-- revokes in section 2, which catch whatever already exists.

alter default privileges in schema public
  revoke all on tables from anon, authenticated;

alter default privileges in schema public
  revoke all on sequences from anon, authenticated;

-- Functions are the important one. A new function's EXECUTE privilege is
-- granted to PUBLIC by default, and PostgREST exposes every function in the
-- public schema as an RPC endpoint. Without this, a SECURITY DEFINER function
-- added later (fulfil_payment, which writes orders, enrollments, and referrals
-- as its owner) would be callable by `authenticated` through PUBLIC even after
-- an explicit `revoke ... from anon, authenticated`. Revoking from anon and
-- authenticated alone is not enough; PUBLIC has to go too.

alter default privileges in schema public
  revoke execute on functions from anon, authenticated;

alter default privileges in schema public
  revoke execute on functions from public;

-- Deliberately NOT touched: default privileges ON TYPES and ON SCHEMAS.
-- PUBLIC holds USAGE on types by default, and the client roles need that USAGE
-- to read and filter the enum-typed columns created in 0001 (products.type,
-- orders.status, referrals.status, and the rest). Revoking it would break the
-- published-catalog read in 0008 at the type layer, not the privilege layer,
-- which is a confusing failure for zero security gain — enum USAGE discloses
-- nothing on its own.

-- ---------------------------------------------------------------------------
-- 2. Revoke what already exists
-- ---------------------------------------------------------------------------
-- Every table from 0001, 0002, and 0004 was created under Supabase's permissive
-- defaults. This is the sweep that undoes that. It is a blanket revoke rather
-- than a per-table list on purpose: a table someone forgets to add to a list
-- stays exposed, whereas ALL TABLES cannot be forgotten.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ALL FUNCTIONS covers functions, aggregates, and window functions but not
-- procedures; ALL ROUTINES covers procedures as well. Using ROUTINES means a
-- procedure added later is caught by the same sweep.
--
-- PUBLIC is included for the reason given in section 1. This does not disturb
-- the trigger functions from 0003: EXECUTE on a trigger function is checked
-- when the trigger is CREATED, not each time it fires, so revoking EXECUTE
-- from the client roles leaves on_auth_user_created and
-- profiles_guard_columns working exactly as before. Those functions are never
-- called directly by a client role, which is why revoking is not merely safe
-- but correct — a client-callable path into handle_new_user() or
-- guard_profile_columns() would be a hole, not a feature.
--
-- Function bodies are unaffected too: a SECURITY DEFINER function runs as its
-- owner, and an owner keeps its privileges regardless of what PUBLIC holds, so
-- mask_email() stays callable from inside fulfil_payment().

revoke all on all routines in schema public from anon, authenticated;
revoke all on all routines in schema public from public;

-- ---------------------------------------------------------------------------
-- 3. USAGE on schema public is RETAINED
-- ---------------------------------------------------------------------------
-- No revoke of `usage on schema public` from anon or authenticated, and this is
-- deliberate. Schema USAGE is a prerequisite for exercising any privilege on an
-- object inside that schema, so dropping it would break the published-catalog
-- read (0008) and every owner-scoped read (0007, 0009, 0010) that the front end
-- depends on, and PostgREST itself needs it to resolve names for the roles it
-- switches into.
--
-- Retaining USAGE costs nothing here. USAGE alone confers no ability to read,
-- write, or even confirm the contents of a single row — it only permits name
-- resolution. With sections 1 and 2 applied, a client role holds schema USAGE
-- and zero object privileges, which is exactly the intended baseline: the door
-- to the building is open, every room inside is locked.

-- ---------------------------------------------------------------------------
-- 4. Enable RLS on every table — all 13, no exceptions
-- ---------------------------------------------------------------------------
-- Including the tables that will never get a client policy (questions,
-- payment_incidents, admin_bootstrap_emails). Enabling RLS on a table with no
-- policies is the strongest state available: zero rows for a select, a
-- policy-violation error for a write (Requirement 5.3). Leaving RLS off on a
-- service-role-only table would mean a single accidental future grant exposes
-- the whole table.

alter table public.profiles                enable row level security;
alter table public.admin_bootstrap_emails  enable row level security;
alter table public.products                enable row level security;
alter table public.quizzes                 enable row level security;
alter table public.pack_quizzes            enable row level security;
alter table public.questions               enable row level security;
alter table public.orders                  enable row level security;
alter table public.enrollments             enable row level security;
alter table public.quiz_attempts           enable row level security;
alter table public.referrals               enable row level security;
alter table public.payment_incidents       enable row level security;
alter table public.payout_requests         enable row level security;
alter table public.settings                enable row level security;

-- ---------------------------------------------------------------------------
-- 5. Force RLS on the four tables that carry identity, money, and access
-- ---------------------------------------------------------------------------
-- A table owner normally bypasses RLS. FORCE ROW LEVEL SECURITY removes that
-- exemption, so the owner is filtered by the same policies as everyone else.
-- Applied to the tables where an owner-privileged query that quietly ignored
-- the row filter would be worst: profiles (identity and is_admin), orders and
-- enrollments (money and access), referrals (rewards).
--
-- Roles holding the BYPASSRLS attribute are unaffected by FORCE — that is how
-- the Edge Functions keep working. `service_role` has BYPASSRLS, so the
-- webhook's writes to orders, enrollments, and referrals proceed, and
-- fulfil_payment runs as its owner `postgres`, which also holds BYPASSRLS on
-- Supabase. Verify both on first apply with:
--   select rolname, rolbypassrls from pg_roles
--    where rolname in ('postgres', 'service_role');
-- If either came back false, fulfil_payment's writes would fail closed against
-- zero policies rather than fail open, but the webhook would stop fulfilling
-- payments, so this is a deploy-time check worth doing once.

alter table public.profiles     force row level security;
alter table public.orders       force row level security;
alter table public.enrollments  force row level security;
alter table public.referrals    force row level security;
