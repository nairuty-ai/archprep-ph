-- 0018_v2_rls.sql
-- Row-Level Security for the v2 schema (BACKEND_RULES.md §13).
-- Students read only their own rows; every write goes through an Edge
-- Function (service role) or a security definer function. New tables get no
-- client grant by default (0005 default privileges), so each grant below is
-- deliberate.

-- ---------------------------------------------------------------------------
-- RLS on every new table; FORCE on the money and identity tables.
-- ---------------------------------------------------------------------------
alter table public.admins              enable row level security;
alter table public.consents            enable row level security;
alter table public.sessions            enable row level security;
alter table public.auth_events         enable row level security;
alter table public.auth_locks          enable row level security;
alter table public.attempts            enable row level security;
alter table public.attempt_answers     enable row level security;
alter table public.coupons             enable row level security;
alter table public.coupon_reservations enable row level security;
alter table public.payment_events      enable row level security;
alter table public.issues              enable row level security;
alter table public.bank_deposits       enable row level security;
alter table public.balance_ledger      enable row level security;
alter table public.payouts             enable row level security;
alter table public.audit_log           enable row level security;
alter table public.outbox              enable row level security;

alter table public.admins         force row level security;
alter table public.sessions       force row level security;
alter table public.bank_deposits  force row level security;
alter table public.balance_ledger force row level security;
alter table public.payouts        force row level security;
alter table public.audit_log      force row level security;

-- ---------------------------------------------------------------------------
-- Catalog: published rows for everyone; a student also keeps seeing a product
-- they hold an active enrollment for after it is unpublished (§1).
-- material_path stays server-only.
-- ---------------------------------------------------------------------------
revoke select on public.products from anon, authenticated;
grant select (
  id, slug, type, subject, title, subtitle, description, price_php, currency,
  thumbnail_path, includes, status, sort_order, created_at, access_mode,
  attempts_per_purchase, material_pages, updated_at
) on public.products to anon, authenticated;

create policy products_select_published on public.products
  for select to anon, authenticated
  using (status = 'published');

create policy products_select_enrolled on public.products
  for select to authenticated
  using (exists (select 1 from public.enrollments e
                  where e.product_id = products.id
                    and e.user_id = auth.uid()
                    and e.status = 'active'));

create policy quizzes_select_published on public.quizzes
  for select to anon, authenticated
  using (status = 'published');

create policy pack_quizzes_select_published on public.pack_quizzes
  for select to anon, authenticated
  using (exists (select 1 from public.products p
                  where p.id = pack_quizzes.product_id and p.status = 'published')
     and exists (select 1 from public.quizzes q
                  where q.id = pack_quizzes.quiz_id and q.status = 'published'));

-- ---------------------------------------------------------------------------
-- Profiles: the user may edit only display_name and mobile; everything else
-- goes through complete_signup() or the admin functions.
-- ---------------------------------------------------------------------------
revoke update on public.profiles from authenticated;
grant update (display_name, mobile) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Owner-scoped reads
-- ---------------------------------------------------------------------------
grant select on public.attempts       to authenticated;
grant select on public.consents       to authenticated;
grant select on public.balance_ledger to authenticated;
grant select on public.payouts        to authenticated;
grant select on public.issues         to authenticated;
grant select (id, user_id, is_admin, created_at, last_seen_at, ended_at, ended_reason, ua, ip_city)
  on public.sessions to authenticated;
grant select (id, order_id, user_id, bank, amount_received, reference_no, status,
              reject_reason, reviewed_at, created_at)
  on public.bank_deposits to authenticated;
grant select (attempt_id, question_id, choice, flagged, updated_at)
  on public.attempt_answers to authenticated;
grant select (voided_at) on public.referrals to authenticated;

create policy attempts_select_own       on public.attempts       for select to authenticated using (user_id = auth.uid());
create policy consents_select_own       on public.consents       for select to authenticated using (user_id = auth.uid());
create policy balance_ledger_select_own on public.balance_ledger for select to authenticated using (user_id = auth.uid());
create policy payouts_select_own        on public.payouts        for select to authenticated using (user_id = auth.uid());
create policy issues_select_own         on public.issues         for select to authenticated using (user_id = auth.uid());
create policy sessions_select_own       on public.sessions       for select to authenticated using (user_id = auth.uid());
create policy bank_deposits_select_own  on public.bank_deposits  for select to authenticated using (user_id = auth.uid());
create policy attempt_answers_select_own on public.attempt_answers for select to authenticated
  using (exists (select 1 from public.attempts a
                  where a.id = attempt_answers.attempt_id and a.user_id = auth.uid()));

-- admins, auth_events, auth_locks, coupons, coupon_reservations,
-- payment_events, incidents, audit_log and outbox: no client grant, no policy.
-- Coupons are validated by create-payment; the code list is never readable.
