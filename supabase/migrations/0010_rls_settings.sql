-- 0010_rls_settings.sql
-- Platform v2 settings allowlist: the one client privilege on public.settings.
--
-- Depends on 0004 (creates the table and seeds the ten rows) and 0005 (revokes
-- every client privilege in the public schema and enables RLS on settings).
-- After 0005, settings is reachable by no client role at all; this file hands
-- back exactly one capability — read the rows an admin has marked display-safe.
--
-- Read-only by design. There is no insert, update, or delete grant and no such
-- policy, so the only write path to settings is the admin-settings Edge
-- Function running as the service role, which also carries the per-key
-- validation (accepting cash/credit for reward_type and
-- answered_only/full_reveal for answer_reveal_mode).
--
-- Re-runnable: the grant is idempotent by nature and the policy is dropped
-- before it is created.
--
-- Requirements: 9.6, 9.7, 6.13

-- ---------------------------------------------------------------------------
-- 1. Grant
-- ---------------------------------------------------------------------------
-- A whole-table select grant rather than a column list. Unlike products, where
-- material_path is withheld (0008), and referrals, where the buyer and referrer
-- identifiers are withheld (0009), settings has no column worth hiding from a
-- row the role is already allowed to see: key, value, display_safe, and
-- updated_at are all safe once the row itself is public. Withholding
-- display_safe in particular would buy nothing, since every visible row has it
-- true by definition of the policy below.
--
-- The grant alone discloses nothing. With RLS enabled and no policy, the select
-- privilege returns zero rows; the privilege and the policy have to agree
-- before a single row is visible.

grant select on public.settings to anon, authenticated;

-- Belt and braces on the absence of a write path. 0005 already revoked these,
-- so this changes nothing today — it states the intent in the file a reader
-- will open when they ask "can a client write a setting?", and it survives a
-- later accidental blanket grant in the schema.

revoke insert, update, delete, truncate, references, trigger
  on public.settings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The allowlist policy
-- ---------------------------------------------------------------------------
-- Requirement 9.6 asks for a select policy permitting rows whose key is a
-- member of Display_Safe_Keys, and 9.7 requires zero rows for anything outside
-- that set. The allowlist lives in the data as settings.display_safe (0004),
-- not as a literal key list inside this policy, for two reasons: an admin can
-- publish or unpublish a key without a migration, and a key added later
-- defaults to false, so a new setting is service-role only until someone
-- deliberately publishes it. A hard-coded list would instead have to be edited
-- in lockstep with every key change, and a forgotten edit fails open.
--
-- Requirement 6.13: answer_reveal_mode is seeded display_safe = false, so
-- settings?key=eq.answer_reveal_mode returns zero rows to anon and to
-- authenticated. That setting decides how much of the answer key grade-quiz
-- returns, and grade-quiz reads it through the service role, which is not
-- subject to this policy. Nothing in the database forces that row to stay
-- false — the admin-settings function is what refuses to publish it — but the
-- policy needs no exception for it, and the inventory test (task 3.13) plus the
-- settings allowlist property test (task 3.12) are what keep it honest.
--
-- FOR SELECT only. No `for all`, which would silently create an insert,
-- update, and delete policy too; harmless while the write grants are absent,
-- but it would turn one future careless grant into a write path.
--
-- USING (display_safe = true) is written against the boolean rather than as a
-- bare `using (display_safe)` so a null could never be mistaken for true. The
-- column is NOT NULL, so this is style, not a live hazard.

drop policy if exists settings_select_display_safe on public.settings;

create policy settings_select_display_safe on public.settings
  for select to anon, authenticated
  using (display_safe = true);

comment on policy settings_select_display_safe on public.settings is
  'Requirements 9.6, 9.7, 6.13. Client roles read only rows marked display_safe. answer_reveal_mode is seeded false, so it returns zero rows to every client role.';
