-- 0008_rls_catalog.sql
-- Platform v2 public catalog read: the only three tables a visitor with no
-- session may read. Runs after 0005, which revoked every client privilege in
-- the public schema and enabled RLS everywhere, so these grants and policies
-- are additive on top of a default-deny baseline.
--
-- Two halves, both required. A grant without a policy returns zero rows because
-- RLS is enabled; a policy without a grant fails at the privilege layer before
-- the row filter is consulted. The catalog is readable only because both halves
-- are present, and only for the rows and columns named here.
--
-- Requirements: 9.4, 9.5, 18.7

-- ---------------------------------------------------------------------------
-- 1. products — column-level select, material_path deliberately withheld
-- ---------------------------------------------------------------------------
-- Requirement 18.7: the browser must hold zero Storage object paths that
-- resolve without a signature. A private-bucket path resolves to nothing
-- without a signature, so exposing material_path would arguably satisfy the
-- criterion on its own — but withholding it means the browser never learns the
-- object layout at all, and the criterion becomes flatly testable as "the
-- client-visible product payload contains no material path". Materials are
-- reached one way only: issue-material-url, which checks enrollments for the
-- verified uid and mints a 300-second signed URL.
--
-- This is a column-level grant precisely so the omission is enforced by the
-- privilege layer rather than by every caller remembering to write an explicit
-- column list. `select *` from a client role returns the granted columns via
-- PostgREST; an explicit `select=material_path` is rejected with
-- `permission denied for column material_path`. Postgres has no column-level
-- RLS, so a grant is the mechanism actually designed for this.
--
-- thumbnail_path IS granted. Thumbnails live in a separate PUBLIC bucket and
-- have to render for anonymous visitors, so that path is not a secret.
--
-- Every other column in the 0001 definition is named below, including
-- created_at. Adding a column to products in a later migration does NOT widen
-- this grant — the new column stays unreadable by client roles until someone
-- adds it here on purpose, which is the behaviour we want.

grant select (
  id,
  slug,
  type,
  subject,
  title,
  subtitle,
  description,
  price_php,
  currency,
  thumbnail_path,
  includes,
  published,
  sort_order,
  created_at
) on public.products to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. quizzes and pack_quizzes — full table select
-- ---------------------------------------------------------------------------
-- Requirement 9.8: quizzes holds metadata only (slug, title, subject,
-- timer_minutes, published). Question text, correct_key, and explanation live
-- in public.questions, which carries zero client grants and zero policies, so
-- a full select grant here discloses nothing an answer key depends on.
--
-- pack_quizzes is a join table of two foreign keys and a sort order. It carries
-- no secret of its own; its rows are gated by the parent product's published
-- flag in section 3.

grant select on public.quizzes      to anon, authenticated;
grant select on public.pack_quizzes to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Published-only select policies
-- ---------------------------------------------------------------------------
-- Requirements 9.4 and 9.5: client reads return exactly the published subset.
-- Policy names are fixed by the design's policy inventory table and are
-- asserted by the rls-policy-inventory suite; renaming one is a test failure.
--
-- SELECT only. No INSERT, UPDATE, or DELETE policy and no such grant exists on
-- any of the three tables — the catalog is written only through the admin-*
-- Edge Functions using the service role.
--
-- The drop-then-create form keeps this migration re-runnable; Postgres has no
-- `create policy if not exists`.

drop policy if exists products_select_published on public.products;

create policy products_select_published on public.products
  for select to anon, authenticated
  using (published = true);

drop policy if exists quizzes_select_published on public.quizzes;

create policy quizzes_select_published on public.quizzes
  for select to anon, authenticated
  using (published = true);

-- Requirement 9.4: pack_quizzes has no published column of its own, so
-- visibility resolves through the PARENT PRODUCT's flag. A quiz mapped only to
-- unpublished packs is therefore invisible to client roles, and unpublishing a
-- product immediately hides its mappings without touching pack_quizzes rows.
--
-- The subquery runs as the querying role, which is why it works: section 1
-- granted that role select on products.id and products.published. It is also
-- subject to products' own RLS, so products_select_published filters it a
-- second time — the predicate and the parent policy agree, which makes the
-- rule fail closed from both directions.
--
-- Qualifying the outer table as `pack_quizzes.product_id` (and aliasing the
-- inner one as `p`) keeps the correlation unambiguous; an unqualified
-- `product_id` would resolve against the subquery's table if products ever
-- gained a column by that name, silently turning the filter into a tautology.

drop policy if exists pack_quizzes_select_published on public.pack_quizzes;

create policy pack_quizzes_select_published on public.pack_quizzes
  for select to anon, authenticated
  using (exists (
    select 1
    from public.products p
    where p.id = pack_quizzes.product_id
      and p.published = true
  ));
