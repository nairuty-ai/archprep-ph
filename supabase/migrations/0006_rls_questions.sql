-- 0006_rls_questions.sql
-- The answer-key guarantee, stated in full.
--
-- public.questions holds correct_key and explanation — the Answer_Fields. This
-- file is the auditable statement that no browser-reachable role can read them:
--   * zero grants to anon, to authenticated, and to PUBLIC
--   * zero RLS policies (RLS itself was enabled in 0005)
--   * select granted to service_role only
--
-- That combination is stronger than a filtered policy. Postgres checks table
-- privileges BEFORE it consults RLS, so a client request never reaches a row
-- filter that could be wrong: `quizzes?select=*,questions(*)` through PostgREST,
-- a select of correct_key alone, an aggregate over explanation, an order-by on
-- either column — all fail at the privilege layer, for every session state,
-- including a session belonging to a user who legitimately owns the quiz
-- (Requirements 6.2, 6.3, 6.4, 6.5, 6.9).
--
-- DO NOT, IN ANY FUTURE MIGRATION:
--   1. grant any privilege on public.questions to anon, authenticated, or
--      PUBLIC — not even a column-level grant on question_text or options.
--      Question content reaches the browser only through get-quiz, which strips
--      the Answer_Fields server-side (Requirement 6.7).
--   2. create any RLS policy on public.questions. A policy is useless without a
--      grant, so a policy here can only be a step towards adding one. There is
--      no legitimate reason for either.
--   3. create a client-callable SECURITY DEFINER function, procedure, or view
--      that reads public.questions. A definer routine runs with its owner's
--      privileges, which is precisely the hole this file exists to prevent: it
--      would hand a client role the read that the missing grant denies. Every
--      routine that touches this table must be callable by service_role only
--      (`revoke all on function ... from anon, authenticated, public`), and any
--      view over it must be created `with (security_invoker = true)` so the
--      caller's own (absent) privileges apply.
--
-- Requirement 6.6: the Answer_Fields are read through the Service_Role inside
-- the get-quiz and grade-quiz Edge Functions only. The grant below is what
-- makes those two paths work and is the complete set of read paths that exist.
-- admin-questions writes the table through the same role.
--
-- Requirements: 6.1, 6.6
-- Declared in design.md "Policy inventory": questions — client policies: none,
-- client grants: none. The test for Requirement 5.4 asserts exactly that.
-- Re-runnable: every statement is idempotent.

-- ---------------------------------------------------------------------------
-- 1. Zero client privileges
-- ---------------------------------------------------------------------------
-- 0005 already swept every table in the schema with a blanket revoke. This
-- repeats it for this one table on purpose: the guarantee should be readable in
-- one file rather than inferred from a wildcard three migrations back, and a
-- privilege granted out-of-band (a dashboard session, a hotfix) is removed
-- again the next time the migration set is applied to a fresh database.
--
-- PUBLIC is named explicitly because a grant to PUBLIC is inherited by every
-- role, so revoking from anon and authenticated alone would not close it.

revoke all on public.questions from anon, authenticated;
revoke all on public.questions from public;

-- ---------------------------------------------------------------------------
-- 2. service_role only
-- ---------------------------------------------------------------------------
-- The read path for get-quiz and grade-quiz (Requirement 6.6).

grant select on public.questions to service_role;

-- Writes for admin-questions (Requirement 8.5). Supabase's default privileges
-- already give service_role full access to tables in the public schema; naming
-- the write privileges here means the admin path does not depend on that
-- default surviving, and it keeps every privilege this table has in one place.
-- service_role is never exposed to a browser — it lives in Edge Function
-- secrets — so this widens nothing that section 1 closed.

grant insert, update, delete on public.questions to service_role;

-- ---------------------------------------------------------------------------
-- 3. The prohibition, recorded on the objects themselves
-- ---------------------------------------------------------------------------
-- 0001 set a table comment pointing here; this replaces it with the full rule,
-- so anyone who inspects the table from psql or the dashboard sees the
-- constraint before they consider adding a policy.

comment on table public.questions is
  'Answer keys (correct_key, explanation). Readable by service_role only, through the get-quiz and grade-quiz Edge Functions. NEVER add a grant to anon/authenticated/PUBLIC, NEVER add an RLS policy, and NEVER add a client-callable SECURITY DEFINER routine or non-security_invoker view over this table. See migration 0006_rls_questions.sql.';

comment on column public.questions.correct_key is
  'Answer_Field. Omitted from every get-quiz payload (Requirement 6.7) and revealed by grade-quiz only per answer_reveal_mode (Requirements 6.10, 6.12). Never selectable by a client role.';

comment on column public.questions.explanation is
  'Answer_Field. Same exposure rules as correct_key: service_role reads it, grade-quiz decides whether it is revealed, and no client role may select it.';

-- ---------------------------------------------------------------------------
-- 4. Fail-closed self-check
-- ---------------------------------------------------------------------------
-- Asserts the two claims this file makes, at apply time, against the live
-- catalog: zero policies on the table, and zero table-level or column-level
-- privileges held by anon, authenticated, or PUBLIC. If a policy or grant was
-- added out-of-band and somehow survived section 1, the migration aborts rather
-- than reporting success over a weakened model.
--
-- This is a point-in-time assertion: it sees only what exists when it runs, and
-- on a fresh apply that is migrations 0001-0005. The enduring check is the
-- policy-enumeration test for Requirement 5.4, which runs against the deployed
-- database and compares every live policy and grant to the declared inventory.
-- The two are complementary, not redundant — this one fails the deploy, that
-- one fails the build.

do $$
declare
  v_policies       integer;
  v_table_grants   integer;
  v_column_grants  integer;
  v_client_roles   text[] := array['anon', 'authenticated'];
begin
  select count(*) into v_policies
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'questions';

  if v_policies > 0 then
    raise exception
      'questions lockdown violated: % RLS policy(ies) exist on public.questions. Requirement 6.1 allows zero.',
      v_policies;
  end if;

  -- grantee 0 in an aclitem is PUBLIC.
  select count(*) into v_table_grants
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, '{}'::aclitem[])) a
   where n.nspname = 'public'
     and c.relname = 'questions'
     and (a.grantee = 0 or a.grantee::regrole::text = any (v_client_roles));

  select count(*) into v_column_grants
    from pg_attribute att
    join pg_class c     on c.oid = att.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(att.attacl, '{}'::aclitem[])) a
   where n.nspname = 'public'
     and c.relname = 'questions'
     and att.attnum > 0
     and not att.attisdropped
     and (a.grantee = 0 or a.grantee::regrole::text = any (v_client_roles));

  if v_table_grants > 0 or v_column_grants > 0 then
    raise exception
      'questions lockdown violated: % table privilege(s) and % column privilege(s) held by anon/authenticated/PUBLIC on public.questions. Requirement 6.1 allows zero.',
      v_table_grants, v_column_grants;
  end if;

  raise notice
    'questions lockdown verified: zero policies, zero client grants, select granted to service_role.';
end;
$$;
