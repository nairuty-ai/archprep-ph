-- 0007_rls_profiles.sql
-- Platform v2 profiles access: own-row read, own-row update of exactly two
-- columns, and nothing else. This is the first migration after the 0005
-- baseline to grant a client privilege back, so every statement below is a
-- deliberate, reviewable widening of a default-deny table.
--
-- Declared client surface for public.profiles (design policy inventory):
--   policies : profiles_select_own, profiles_update_own
--   grants   : SELECT; UPDATE(display_name, gcash_number)
-- Nothing else. The 3.13 inventory test asserts equality against exactly that,
-- so an extra policy or a widened grant added later fails the suite.
--
-- Depends on 0001 (public.profiles), 0003 (guard_profile_columns() and the
-- profiles_guard_columns before-update trigger, the defence-in-depth layer
-- behind the column-level grant here), and 0005 (RLS enabled, FORCE RLS, and
-- every client privilege revoked). Re-runnable: the grants are idempotent and
-- each policy is dropped before it is created.
--
-- Requirements: 7.1, 9.1, 9.2, 9.3, 3.5

-- ---------------------------------------------------------------------------
-- 1. Grants — the column-level guard that Postgres actually provides
-- ---------------------------------------------------------------------------
-- Postgres has no column-level RLS, so Requirements 9.2 and 9.3 are enforced
-- with column-level GRANT, which is the mechanism designed for this job.
-- `authenticated` may write display_name and gcash_number and no other column.
--
-- UPDATE profiles SET is_admin = true WHERE id = auth.uid() is rejected with
-- "permission denied for column is_admin" at the privilege layer, before any
-- policy runs and regardless of what the row filter would have allowed.
-- ref_code, referred_by, email, and id are withheld the same way (9.3). The
-- trigger from 0003 repeats the check inside the statement so the guarantee
-- survives someone widening this grant later; it is the backstop, not the
-- primary control.
--
-- SELECT is granted on the whole table rather than a column list. Withholding
-- a column here would buy nothing: profiles_select_own restricts the reader to
-- their own row, and is_admin, ref_code, referred_by, and email on that row are
-- all values the front end legitimately renders (the account menu, the referral
-- link, the admin shell's is_admin check). Unreadable is not the requirement;
-- unwritable is, and that is what the UPDATE grant delivers.

grant select on public.profiles to authenticated;

grant update (display_name, gcash_number) on public.profiles to authenticated;

-- Deliberately NOT granted:
--   * anything at all to anon. Requirement 7.6: an unauthenticated select from
--     profiles returns zero rows, which it does at the privilege layer.
--   * INSERT. See section 3.
--   * DELETE. See section 3.

-- ---------------------------------------------------------------------------
-- 2. Policies — own row only
-- ---------------------------------------------------------------------------
-- Requirement 7.1 (read) and 9.1 (update). Both are scoped to `authenticated`,
-- so anon has no policy on this table even if a grant were ever added by
-- accident. FORCE RLS from 0005 means the table owner is filtered by these
-- policies too; service_role and postgres pass through on BYPASSRLS, which is
-- how handle_new_user() and the admin functions keep working.

drop policy if exists profiles_select_own on public.profiles;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

-- USING filters the rows the update may target; WITH CHECK re-validates the
-- post-update row. Both are needed: without WITH CHECK a user could move their
-- own row to another id and keep it, and with the grant covering only
-- display_name and gcash_number that is already impossible, but the policy
-- should not depend on the grant to stay correct.

drop policy if exists profiles_update_own on public.profiles;

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Requirement 3.5 is satisfied by the pair above plus the column grant: the
-- Account settings view updates display_name and gcash_number on the user's own
-- row through PostgREST, with no Edge Function in the path.

-- ---------------------------------------------------------------------------
-- 3. No INSERT policy and no DELETE policy — both absences are the design
-- ---------------------------------------------------------------------------
-- NO INSERT POLICY, and no INSERT grant. A profiles row is created only by
-- handle_new_user() firing on the auth.users insert (migration 0003,
-- Requirements 3.1 and 3.2). That trigger is the single writer, which is what
-- makes "exactly one profile per user, with a unique ref_code and is_admin
-- derived from admin_bootstrap_emails" true by construction. A client-side
-- insert path would let a user create a second profile row, choose their own
-- ref_code, or set is_admin on the way in — none of which the update guard in
-- section 1 can catch, because that guard only compares an old row to a new
-- one. The absence of the insert path is therefore load-bearing, not an
-- omission.
--
-- NO DELETE POLICY, and no DELETE grant. A profiles row is removed only by
-- cascade from auth.users (profiles.id references auth.users(id) on delete
-- cascade, migration 0001), so account deletion is an auth-layer action and the
-- profile follows it. Allowing a client delete would orphan the rows that point
-- at the profile — orders, enrollments, quiz_attempts, referrals, and the
-- referred_by self-reference other profiles hold on this row's ref_code — and
-- would hand a user a way to erase their own referral attribution after a
-- purchase. Deletion belongs to auth.users alone.
--
-- Requirement 5.3 supplies the behaviour for both: with RLS enabled and no
-- policy, a client insert or delete is rejected with a policy-violation error.
-- The missing grants mean it is rejected one layer earlier still.

comment on table public.profiles is
  'Requirements 7.1, 9.1. Client surface: profiles_select_own (own row read), profiles_update_own with UPDATE granted on display_name and gcash_number only. No insert policy - rows come from handle_new_user() alone. No delete policy - rows go by cascade from auth.users alone.';
