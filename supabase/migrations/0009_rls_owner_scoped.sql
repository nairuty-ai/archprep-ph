-- 0009_rls_owner_scoped.sql
-- Platform v2 owner-scoped reads and the service-role-only write model for the
-- money and access tables: orders, enrollments, quiz_attempts, referrals,
-- payout_requests, payment_incidents, admin_bootstrap_emails.
--
-- Depends on 0002 for the tables and on 0005 for the revoke-first baseline
-- (every client privilege in the public schema is already revoked and RLS is
-- already enabled on all 13 tables). Everything granted below is therefore
-- additive and deliberate: if a table or a column is not named in this file, no
-- client role can reach it.
--
-- The shape of this file is five SELECT grants, five own-row SELECT policies,
-- and two tables that are named only in comments because they get nothing at
-- all. There is no INSERT, UPDATE, or DELETE grant and no such policy anywhere
-- in it. Every write to these tables goes through the service role inside an
-- Edge Function (create-payment, hitpay-webhook, grade-quiz, request-payout,
-- admin-*), which is what Requirement 8 asks for.
--
-- Re-runnable: each policy is dropped first, and GRANT is idempotent.
--
-- Requirements: 7.2, 8.1, 8.5

-- ---------------------------------------------------------------------------
-- 1. orders, enrollments, quiz_attempts — read own, never write
-- ---------------------------------------------------------------------------
-- SELECT only, and only for `authenticated`. `anon` gets nothing on any of the
-- three, so an unauthenticated read fails at the privilege layer before RLS is
-- consulted (Requirement 7.6). auth.uid() is null for anon anyway, so the row
-- filter would return zero rows even if the grant existed — withholding the
-- grant means the answer is "no privilege", not "no matching rows".

grant select on public.orders        to authenticated;
grant select on public.enrollments   to authenticated;
grant select on public.quiz_attempts to authenticated;

-- Requirement 7.2. `user_id = auth.uid()` is the whole filter. A request that
-- asks for another user's rows (`orders?user_id=eq.<other>`) is not an error —
-- the filter is ANDed with the policy, so it returns zero rows (Requirement
-- 7.5). That is the correct behaviour: a 200 with an empty array discloses
-- nothing, not even whether the other user's row exists.

drop policy if exists orders_select_own on public.orders;
create policy orders_select_own on public.orders
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists enrollments_select_own on public.enrollments;
create policy enrollments_select_own on public.enrollments
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists quiz_attempts_select_own on public.quiz_attempts;
create policy quiz_attempts_select_own on public.quiz_attempts
  for select to authenticated
  using (user_id = auth.uid());

-- No INSERT, UPDATE, or DELETE grant and no such policy on any of the three
-- (Requirement 8.1). Both halves matter and neither is redundant:
--   * no grant  -> the statement is rejected with "permission denied for table"
--   * no policy -> even if a grant were added later, the write is still
--                  rejected with a policy-violation error (Requirements 8.2,
--                  8.3), because RLS is enabled with zero permissive policies
--                  for the operation.
-- Writes come from: orders and enrollments via create-payment and
-- hitpay-webhook (service role, Requirement 8.4), quiz_attempts via grade-quiz
-- only — the client never inserts an attempt, so a client cannot fabricate a
-- score.
--
-- Deliberately absent: an `enrollments` insert policy of the shape
-- `with check (user_id = auth.uid())`. It looks safe and is not. It would let
-- any logged-in user grant themselves access to any product for free, which is
-- exactly the attack Requirement 8.6 tests for. Do not add it.

-- ---------------------------------------------------------------------------
-- 2. referrals — read own, buyer identity withheld at the grant
-- ---------------------------------------------------------------------------
-- A column-level grant naming 12 of the table's 14 columns. The two withheld
-- are `buyer_user_id` and `referrer_user_id`.
--
-- `buyer_user_id` is withheld because the referrer has no business learning who
-- bought through their link. The ledger renders `buyer_masked`
-- (juan****@gmail.com), computed once by the service role at insert time, so
-- the front end has nothing to display beyond it and nothing to leak.
--
-- `referrer_user_id` is withheld because it is the referrer's own id, already
-- known to them from their session, so granting it buys nothing while widening
-- the surface.
--
-- Column-level GRANT rather than a view: PostgREST honours column privileges
-- directly, so `referrals?select=buyer_user_id` is rejected with "permission
-- denied for column buyer_user_id" and `select=*` expands to the granted
-- columns only. A view would need its own grant, its own RLS consideration, and
-- would still leave the base table one grant away from exposure.

grant select (id, referrer_ref_code, order_id, product_id, product_title,
              amount_php, reward_type, status, created_at, paid_at,
              buyer_masked, notes)
  on public.referrals to authenticated;

-- Requirement 7.2 for referrals: the owner is the REFERRER, not the buyer, so
-- the filter is `referrer_user_id = auth.uid()` rather than `user_id`.
--
-- This looks wrong at first read and is not: the USING clause references
-- `referrer_user_id`, a column the role has NO select privilege on. That is
-- legal and intended. Column privileges govern what a query may return;
-- an RLS policy expression is evaluated by the system as part of the row
-- filter, not as part of the user's select list, so it may read any column of
-- the table. The row filter therefore works while the column itself stays
-- unreadable. Removing `referrer_user_id` from the policy to "match the grant"
-- would break owner scoping entirely — leave it.

drop policy if exists referrals_select_own on public.referrals;
create policy referrals_select_own on public.referrals
  for select to authenticated
  using (referrer_user_id = auth.uid());

-- No write grant and no write policy on referrals (Requirement 8.1). Rows are
-- inserted by fulfil_payment inside the webhook transaction and updated by
-- admin-* functions when a payout is marked paid.

-- ---------------------------------------------------------------------------
-- 3. payout_requests — read own status, request through the Edge Function
-- ---------------------------------------------------------------------------
-- A user may watch their own payout requests move from requested to paid or
-- rejected, and may not create one. `request-payout` recomputes the eligible
-- balance from `referrals` server-side before inserting, so a client cannot
-- request more than it has earned; a client-side insert grant would make that
-- recomputation bypassable and the amount client-supplied.

grant select on public.payout_requests to authenticated;

drop policy if exists payout_requests_select_own on public.payout_requests;
create policy payout_requests_select_own on public.payout_requests
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. payment_incidents — zero grants, zero policies, stated explicitly
-- ---------------------------------------------------------------------------
-- There are no statements for this table below, and the absence is the point.
-- An absence is invisible to a reviewer, so it is written down here instead:
--
--   payment_incidents: ZERO grants to anon, ZERO grants to authenticated,
--   ZERO policies. Service role only.
--
-- `payload` holds the raw HitPay webhook body for forensics and can contain
-- payer details, so no client role may reach this table by any route. RLS is
-- already enabled on it by 0005, so the state is the strongest available: zero
-- rows for a select, a policy-violation error for a write. The admin portal
-- reads incidents through the `admin-incidents` Edge Function, never through
-- PostgREST.
--
-- The revoke below is a no-op after 0005's blanket sweep. It is kept anyway so
-- this file states the intent for the table it is responsible for, and so the
-- intent survives someone granting a privilege from the dashboard between
-- migrations. Do not replace it with a grant.

revoke all on public.payment_incidents from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. admin_bootstrap_emails — zero grants, zero policies, stated explicitly
-- ---------------------------------------------------------------------------
--   admin_bootstrap_emails: ZERO grants to anon, ZERO grants to authenticated,
--   ZERO policies. Service role only.
--
-- The table holds the owner email addresses that `handle_new_user()` checks to
-- set `is_admin` at signup. It is read by that trigger function, which runs as
-- its owner and therefore needs no client privilege, and it is edited by an
-- admin function. Exposing it to a client role would publish the owners' email
-- addresses and hand an attacker the exact list of addresses worth taking over.

revoke all on public.admin_bootstrap_emails from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. What this file deliberately does not do
-- ---------------------------------------------------------------------------
-- Requirement 8.5 covers products, pack_quizzes, quizzes, questions, and
-- settings: zero client insert, update, and delete policies, written through
-- admin functions with the service role. Their SELECT grants and policies live
-- in 0006 (questions: none at all), 0008 (catalog), and 0010 (settings); none
-- of those files issues a write grant either, and this file adds none on their
-- behalf. The declared client-privilege set across 0006-0010 is exactly the
-- policy inventory table in the design, and the inventory test in task 3.13
-- asserts equality against it — so a convenience policy added here later fails
-- that test even when every functional test still passes.
--
-- Policies declared by this file, for that test:
--   orders          orders_select_own           SELECT
--   enrollments     enrollments_select_own      SELECT
--   quiz_attempts   quiz_attempts_select_own    SELECT
--   referrals       referrals_select_own        SELECT on 12 named columns
--   payout_requests payout_requests_select_own  SELECT
--   payment_incidents        none               none
--   admin_bootstrap_emails   none               none
