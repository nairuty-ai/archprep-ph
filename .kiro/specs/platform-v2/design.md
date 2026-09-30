# Design Document

## Overview

Platform v2 replaces the Google Apps Script + Sheets backend with Supabase and converts the purchase model from emailed access codes to account-linked enrollments. The front end stays a static, build-step-free site on Cloudflare Pages; everything that needs a secret, a privileged write, or an answer key moves into Supabase Edge Functions.

The design is organised around one principle: **the browser is never trusted with anything that controls money, access, or answers.** That principle is enforced in three layers, and each layer is independently sufficient to stop the attack it guards against:

1. **Grants.** Postgres column and table privileges are revoked from `anon` and `authenticated` before any policy is written. A table with no grant is unreachable even if a policy is later added by mistake.
2. **RLS policies.** Default-deny, with a small enumerated set of policies. The catalog is the only broad public read.
3. **Server-side checks in Edge Functions.** Enrollment, admin status, payment amounts, and grading are all resolved from the database against a JWT-derived user id.

Two design decisions carry most of the security weight and are worth stating up front:

**Fulfilment runs inside a single Postgres function, not in Edge Function JavaScript.** `supabase-js` cannot open a multi-statement transaction, so orchestrating the order update, enrollment insert, and referral insert from Deno would leave gaps where a crash grants access without recording the referral, or credits a referral twice. Instead the webhook verifies the HMAC signature in Deno and then makes exactly one RPC call to a `SECURITY DEFINER` Postgres function. The function body is one implicit transaction, and it takes a row lock on the order, which is what makes concurrent duplicate webhooks safe rather than merely unlikely.

**`questions` has no grants and no policies.** Not a filtered policy — no `GRANT SELECT` to client roles at all, and no policy rows. A hand-crafted `supabase-js` query with a valid session for a user who legitimately owns the quiz still returns zero rows, because the client role has no privilege on the table. Answer keys leave the database only through two service-role code paths.

## Architecture

```
Browser (static site, Cloudflare Pages, no build step)
  │
  ├── supabase-js (CDN, ESM) ──────────► Supabase Auth       email OTP, JWT session
  │                             └─────► PostgREST            reads permitted by RLS:
  │                                                          published catalog, own rows
  │
  └── fetch() with Authorization: Bearer <JWT> ──► Edge Functions (Deno)
                                                   │  hold every secret
                                                   │  verify JWT, derive uid
                                                   │  use service role
                                                   ▼
                                              Postgres + RLS
                                                   │
                                              SECURITY DEFINER fns
                                              (fulfilment / refund)

HitPay ──── create payment request ────► Edge Function create-payment
       ◄─── HMAC-signed webhook ────────  Edge Function hitpay-webhook (verify_jwt = false)
```

### Trust boundaries

| Boundary | What crosses it | What is enforced at the crossing |
| --- | --- | --- |
| Browser → PostgREST | Anon key + optional user JWT | Table/column grants, then RLS policies |
| Browser → Edge Function | User JWT in `Authorization` header | Signature, issuer, expiry; uid taken from token claims only |
| HitPay → Edge Function | Unauthenticated POST | HMAC-SHA256 over raw body, constant-time compare, before any DB access |
| Edge Function → Postgres | Service-role key | Bypasses RLS by design; correctness enforced by the SQL functions |

### Repository layout

```
/                          static site root (Cloudflare Pages)
  index.html               home + featured catalog
  catalog.html             full published catalog
  product.html             product detail + Buy
  login.html               email → OTP
  my-learning.html         owned materials + quizzes
  quiz.html                quiz runner + results
  earnings.html            referral dashboard
  account.html             profile settings
  enrolled.html            post-payment confirmation (replaces thank-you.html)
  faq.html                 corrected copy
  admin.html               admin portal
  config.js                PUBLIC config only: Supabase URL + anon key
  css/styles.css           carried over, extended
  js/
    supabase.js            client singleton
    auth.js                OTP flow, session, account menu, route guards
    api.js                 typed wrappers for every Edge Function call
    dom.js                 safe DOM helpers (textContent only)
    states.js              loading / empty / error renderers
    referral.js            ?ref capture, 30-day first-touch
    catalog.js  product.js my-learning.js quiz-runner.js
    earnings.js account.js
    admin/                 products.js quizzes.js questions.js
                           enrollments.js referrals.js settings.js incidents.js
supabase/
  migrations/              ordered SQL, applied by the Supabase CLI
  functions/
    _shared/               auth.ts admin.ts hitpay.ts http.ts
    create-payment/  hitpay-webhook/  get-quiz/  grade-quiz/
    issue-material-url/  request-payout/  admin-*/
  seed/                    import script + sample data
tests/                     node:test suites (RLS, money, answer-key, output safety)
apps-script/               RETIRED — retained unmodified, excluded from runtime
```

`js/dom.js` is a deliberate narrowing of v1's `js/ui.js`. The v1 `el()` helper accepts an `html` option that assigns `innerHTML`; v2 drops that option entirely so there is no code path from database content to `innerHTML` (Requirement 29).

## Data Models

Concrete DDL follows. Types are enums rather than text-with-check so an invalid status cannot be written even by the service role.

```sql
create extension if not exists pgcrypto;

create type product_type       as enum ('material','quiz_pack');
create type order_status       as enum ('pending','paid','failed','refunded');
create type enrollment_source  as enum ('purchase','comp','credit');
create type referral_status    as enum ('available','paid','void');
create type reward_type        as enum ('cash','credit');
create type incident_kind      as enum ('amount_mismatch','currency_mismatch',
                                        'unmatched_payment','unmatched_refund',
                                        'out_of_order_status','self_referral');
```

### profiles

```sql
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text,
  is_admin     boolean not null default false,
  ref_code     text not null unique,
  referred_by  text references public.profiles(ref_code),
  gcash_number text,
  created_at   timestamptz not null default now()
);
```

Referral codes avoid `I`, `O`, `0`, `1` so they survive being read aloud or hand-typed. The generator retries on collision, satisfying Requirement 3 criterion 4 without relying on the unique constraint raising:

```sql
create or replace function public.gen_ref_code() returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
begin
  loop
    candidate := '';
    for i in 1..8 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.profiles where ref_code = candidate);
  end loop;
  return candidate;
end $$;
```

Admin bootstrap lives in a table rather than a hardcoded list inside the trigger, so appointing an admin before their first login is a service-role insert instead of a migration edit:

```sql
create table public.admin_bootstrap_emails (email text primary key);
insert into public.admin_bootstrap_emails (email)
values ('rehinaneel@gmail.com'), ('nairutya.84@gmail.com');
```

```sql
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, ref_code, is_admin)
  values (
    new.id,
    new.email,
    public.gen_ref_code(),
    exists (select 1 from public.admin_bootstrap_emails
            where email = lower(new.email))
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
```

### products, quizzes, pack_quizzes

```sql
create table public.products (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  type           product_type not null,
  subject        text,
  title          text not null,
  subtitle       text,
  description    text,
  price_php      integer not null check (price_php > 0),
  currency       char(3) not null default 'PHP' check (currency = 'PHP'),
  thumbnail_path text,
  material_path  text,
  includes       jsonb not null default '[]'::jsonb,
  published      boolean not null default false,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now()
);
create index products_published_sort_idx on public.products (published, sort_order);

create table public.quizzes (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  title         text not null,
  subject       text,
  timer_minutes integer not null default 0 check (timer_minutes >= 0),
  published     boolean not null default false,
  created_at    timestamptz not null default now()
);

create table public.pack_quizzes (
  product_id uuid not null references public.products(id) on delete cascade,
  quiz_id    uuid not null references public.quizzes(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (product_id, quiz_id)
);
```

`price_php` stays an integer, matching Requirement 27 criterion 11. `orders.amount_php` is `numeric(12,2)` because HitPay reports decimal amounts and Requirement 15 compares at two decimal places; the integer price widens losslessly into it.

### questions

```sql
create table public.questions (
  id              uuid primary key default gen_random_uuid(),
  quiz_id         uuid not null references public.quizzes(id) on delete cascade,
  question_number integer not null,
  question_text   text not null,
  options         jsonb not null,
  correct_key     text not null,
  explanation     text,
  created_at      timestamptz not null default now(),
  unique (quiz_id, question_number)
);
```

### orders, enrollments, quiz_attempts

```sql
create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete restrict,
  product_id        uuid not null references public.products(id) on delete restrict,
  amount_php        numeric(12,2) not null check (amount_php > 0),
  currency          char(3) not null default 'PHP',
  status            order_status not null default 'pending',
  hitpay_payment_id text,
  hitpay_reference  text,
  ref_code          text,
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);

-- Requirement 16.1: unique over non-null payment ids only, so many pending
-- orders may coexist before HitPay assigns an id.
create unique index orders_hitpay_payment_id_key
  on public.orders (hitpay_payment_id)
  where hitpay_payment_id is not null;

create index orders_user_idx on public.orders (user_id, created_at desc);

create table public.enrollments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  source     enrollment_source not null,
  order_id   uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint enrollments_user_product_key unique (user_id, product_id)
);

create table public.quiz_attempts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  quiz_id    uuid not null references public.quizzes(id) on delete cascade,
  score      integer not null check (score >= 0),
  total      integer not null check (total >= 0),
  answers    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

Revoking an enrollment **deletes the row**. That keeps the unique constraint in Requirement 16 criterion 1 a plain constraint rather than a partial index, keeps the enrollment check a simple existence test, satisfies Requirement 17 criterion 13's assertion of zero rows, and lets a refunded buyer purchase the same product again later. The audit trail is not lost: `orders` retains the `refunded` row, and `quiz_attempts` rows are explicitly preserved by Requirement 17 criterion 2.

### referrals

```sql
create table public.referrals (
  id                uuid primary key default gen_random_uuid(),
  referrer_ref_code text not null,
  referrer_user_id  uuid not null references public.profiles(id) on delete cascade,
  buyer_user_id     uuid not null references public.profiles(id) on delete cascade,
  buyer_masked      text not null,
  order_id          uuid not null unique references public.orders(id) on delete cascade,
  product_id        uuid not null references public.products(id) on delete restrict,
  product_title     text not null,
  amount_php        numeric(12,2) not null check (amount_php >= 0),
  reward_type       reward_type not null,
  status            referral_status not null default 'available',
  created_at        timestamptz not null default now(),
  paid_at           timestamptz,
  notes             text,
  constraint referrals_no_self check (referrer_user_id <> buyer_user_id)
);
create index referrals_referrer_idx on public.referrals (referrer_user_id, status);
```

Three things here are deliberate:

- `buyer_masked` is computed once by the service role at insert time (`juan••••@gmail.com`). Requirement 7 criterion 7 asks the front end to mask the buyer, but a front-end mask is cosmetic — the raw id would still be in the response. Storing the mask lets us withhold `buyer_user_id` from the client grant entirely, so the referrer never receives the buyer's identity at all.
- `product_title` is denormalised for the same reason in reverse: the ledger must render even when the product has since been unpublished and is therefore invisible to the referrer's catalog read.
- `referrals_no_self` makes the self-referral guard a database invariant, not only a branch in the webhook.

### settings

```sql
create table public.settings (
  key          text primary key,
  value        text not null,
  display_safe boolean not null default false,
  updated_at   timestamptz not null default now()
);
```

The `display_safe` boolean *is* the Display_Safe_Keys allowlist from the requirements, expressed as data rather than as a literal list inside a policy. A new setting is private by default, which is the safe direction to fail.

```sql
insert into public.settings (key, value, display_safe) values
  ('referral_amount',    '9',                 true),
  ('reward_type',        'cash',              true),
  ('payout_threshold',   '100',               true),
  ('reward_on',          'every_purchase',    true),
  ('answer_reveal_mode', 'answered_only',     false),   -- Requirement 20.12
  ('brand_name',         'ArchPrep PH',       true),
  ('contact_email',      'rehinaneel@gmail.com', true),
  ('announcement_banner','',                  true),
  ('hero_headline',      'Pass the Architect Licensure Exam with confidence.', true),
  ('hero_subhead',       'Focused review materials and exam-style practice quizzes for Filipino architecture graduates.', true);
```

`answer_reveal_mode` is seeded `display_safe = false` so no client can read it, satisfying Requirement 9 criterion 9 and Requirement 6 criterion 13.

### payment_incidents, payout_requests

`payment_incidents` is the store behind every "record for admin review" clause (Requirement 15 criteria 3, 4, 7, 8; Requirement 16 criteria 9, 10; Requirement 17 criterion 8; Requirement 23 criterion 3). Without it those clauses have nowhere to write.

```sql
create table public.payment_incidents (
  id                uuid primary key default gen_random_uuid(),
  kind              incident_kind not null,
  order_id          uuid references public.orders(id) on delete set null,
  hitpay_payment_id text,
  reported_amount   numeric(12,2),
  reported_currency text,
  stored_amount     numeric(12,2),
  stored_currency   char(3),
  payload           jsonb,
  resolved_at       timestamptz,
  resolved_by       uuid references public.profiles(id),
  created_at        timestamptz not null default now()
);
create index payment_incidents_open_idx
  on public.payment_incidents (created_at desc) where resolved_at is null;

create table public.payout_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  amount_php   numeric(12,2) not null check (amount_php > 0),
  gcash_number text not null,
  status       text not null default 'requested'
               check (status in ('requested','paid','rejected')),
  created_at   timestamptz not null default now(),
  handled_at   timestamptz,
  notes        text
);
```

`payload` on `payment_incidents` stores the webhook body for forensics. It can contain payer details, so it is service-role only and never granted to a client role — the admin portal reads it through `admin-incidents`, not through PostgREST.

## Row-Level Security — exact policies

### Step 0: revoke first

Supabase's default grants on the `public` schema are permissive. Every migration that creates a table is followed by a revoke, so the baseline is "no privilege" and each grant below is deliberate. This is what makes Requirement 5's default-deny real rather than aspirational — a policy is powerless without a grant, and a grant is powerless without a policy.

```sql
alter default privileges in schema public revoke all on tables from anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
```

Then RLS is enabled on every table, including the ones that will never get a client policy:

```sql
alter table public.profiles            enable row level security;
alter table public.products            enable row level security;
alter table public.quizzes             enable row level security;
alter table public.pack_quizzes        enable row level security;
alter table public.questions           enable row level security;
alter table public.orders              enable row level security;
alter table public.enrollments         enable row level security;
alter table public.quiz_attempts       enable row level security;
alter table public.referrals           enable row level security;
alter table public.settings            enable row level security;
alter table public.payment_incidents   enable row level security;
alter table public.payout_requests     enable row level security;
alter table public.admin_bootstrap_emails enable row level security;

alter table public.profiles            force row level security;
alter table public.orders              force row level security;
alter table public.enrollments         force row level security;
alter table public.referrals           force row level security;
```

### questions — the answer-key guarantee

This is the whole of it. No grant, no policy:

```sql
-- Requirement 6.1. Intentionally NO grant and NO policy for anon/authenticated.
-- questions is reachable only by service_role (and by SECURITY DEFINER
-- functions owned by postgres). Do not add a policy here — a filtered policy
-- would weaken the guarantee to "trust the filter" instead of "no access".
revoke all on public.questions from anon, authenticated;
grant select on public.questions to service_role;
```

Two supporting rules make the guarantee hold against indirect reads (Requirement 6 criterion 9):

```sql
-- No view or routine may re-expose questions to a client role.
-- Enforced by convention + the policy-enumeration test; any view over
-- questions must be created with security_invoker = true so RLS still applies.
```

Because `authenticated` has no `SELECT` privilege on `questions`, a PostgREST embedded-resource request such as `quizzes?select=*,questions(*)` fails at the privilege layer before RLS is consulted, and a join written inside a client-callable function fails unless that function is `SECURITY DEFINER` — which is why no client-callable `SECURITY DEFINER` function touches `questions`.

### profiles — owner-scoped, with the is_admin column guard

Postgres has no column-level RLS, so the guard in Requirement 9 criterion 2 is implemented with column-level `GRANT`, which is the mechanism actually designed for this. A user may update exactly two columns:

```sql
grant select on public.profiles to authenticated;
grant update (display_name, gcash_number) on public.profiles to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
```

An `UPDATE profiles SET is_admin = true WHERE id = auth.uid()` is rejected with `permission denied for column is_admin` — before any policy runs, and regardless of what the row filter would have allowed. `ref_code`, `referred_by`, and `email` are guarded the same way (Requirement 9 criterion 3).

A trigger backs this up as defence in depth, so the guard survives someone widening the grant later:

```sql
create or replace function public.guard_profile_columns() returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and current_setting('role') <> 'service_role' then
    if new.is_admin    is distinct from old.is_admin
    or new.ref_code    is distinct from old.ref_code
    or new.referred_by is distinct from old.referred_by
    or new.email       is distinct from old.email
    or new.id          is distinct from old.id then
      raise exception 'protected profile column' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger profiles_guard_columns
before update on public.profiles
for each row execute function public.guard_profile_columns();
```

There is no `INSERT` and no `DELETE` policy on `profiles`; rows arrive only via the `auth.users` trigger.

### products, quizzes, pack_quizzes — published-only public read

```sql
-- Column-level on products: material_path is deliberately NOT granted.
grant select (id, slug, type, subject, title, subtitle, description,
              price_php, currency, thumbnail_path, includes, published, sort_order)
  on public.products to anon, authenticated;
grant select on public.quizzes      to anon, authenticated;
grant select on public.pack_quizzes to anon, authenticated;

create policy products_select_published on public.products
  for select to anon, authenticated
  using (published = true);

create policy quizzes_select_published on public.quizzes
  for select to anon, authenticated
  using (published = true);

-- Requirement 9.4: pack_quizzes visibility follows the PARENT PRODUCT's
-- published flag.
create policy pack_quizzes_select_published on public.pack_quizzes
  for select to anon, authenticated
  using (exists (
    select 1 from public.products p
    where p.id = pack_quizzes.product_id and p.published = true
  ));
```

`quizzes` exposes only metadata by construction (Requirement 9 criterion 8) — there is no question content in the table.

`material_path` is withheld from the grant. Requirement 18 criterion 7 would technically be satisfied by exposing it, since a private-bucket path resolves to nothing without a signature, but withholding it means the browser never learns the object layout at all and the criterion becomes testable as "the client-visible product payload contains no object path". `thumbnail_path` stays granted because thumbnails live in a separate **public** bucket and must render for anonymous visitors.

### orders, enrollments, quiz_attempts — read own, never write

```sql
grant select on public.orders        to authenticated;
grant select on public.enrollments   to authenticated;
grant select on public.quiz_attempts to authenticated;

create policy orders_select_own on public.orders
  for select to authenticated using (user_id = auth.uid());

create policy enrollments_select_own on public.enrollments
  for select to authenticated using (user_id = auth.uid());

create policy quiz_attempts_select_own on public.quiz_attempts
  for select to authenticated using (user_id = auth.uid());
```

No `INSERT`, `UPDATE`, or `DELETE` grant and no such policy exists on any of the three (Requirement 8 criteria 1–3). `quiz_attempts` is written only by `grade-quiz`, which resolves Requirement 20's "choose one path" instruction in favour of the server-authoritative one: the client never inserts an attempt, so a client cannot fabricate a score.

### referrals — read own, buyer identity withheld at the grant

```sql
-- buyer_user_id and payload-ish columns are deliberately omitted from the grant.
grant select (id, referrer_ref_code, order_id, product_id, product_title,
              amount_php, reward_type, status, created_at, paid_at,
              buyer_masked, notes)
  on public.referrals to authenticated;

create policy referrals_select_own on public.referrals
  for select to authenticated
  using (referrer_user_id = auth.uid());
```

The policy's `USING` clause may reference `referrer_user_id` even though the role has no `SELECT` privilege on that column, so the row filter works while the column stays unreadable. A referrer sees `buyer_masked`, never `buyer_user_id`.

### settings — allowlist read

```sql
grant select on public.settings to anon, authenticated;

create policy settings_select_display_safe on public.settings
  for select to anon, authenticated
  using (display_safe = true);
```

`answer_reveal_mode` is seeded `display_safe = false`, so `settings?key=eq.answer_reveal_mode` returns zero rows to every client role (Requirement 9 criteria 9–10).

### payout_requests, payment_incidents, admin_bootstrap_emails

```sql
grant select on public.payout_requests to authenticated;

create policy payout_requests_select_own on public.payout_requests
  for select to authenticated using (user_id = auth.uid());

-- payment_incidents and admin_bootstrap_emails: RLS enabled, zero grants,
-- zero policies. Service role only; the admin portal reads them through
-- admin-* Edge Functions.
revoke all on public.payment_incidents      from anon, authenticated;
revoke all on public.admin_bootstrap_emails from anon, authenticated;
```

A user can read their own payout requests to see status, but cannot insert one — that goes through `request-payout`, which recomputes the eligible balance server-side so a client cannot request more than it has earned.

### Policy inventory

Requirement 5 criterion 4 requires a test that enumerates live policies and compares them to what the migrations declare. This is the declared set, and the test asserts equality against exactly this table:

| Table | Client policies | Client grants |
| --- | --- | --- |
| `profiles` | `profiles_select_own`, `profiles_update_own` | SELECT; UPDATE(`display_name`,`gcash_number`) |
| `products` | `products_select_published` | SELECT |
| `quizzes` | `quizzes_select_published` | SELECT |
| `pack_quizzes` | `pack_quizzes_select_published` | SELECT |
| `questions` | **none** | **none** |
| `orders` | `orders_select_own` | SELECT |
| `enrollments` | `enrollments_select_own` | SELECT |
| `quiz_attempts` | `quiz_attempts_select_own` | SELECT |
| `referrals` | `referrals_select_own` | SELECT on 12 named columns (not `buyer_user_id`, not `referrer_user_id`) |
| `settings` | `settings_select_display_safe` | SELECT |
| `payout_requests` | `payout_requests_select_own` | SELECT |
| `payment_incidents` | **none** | **none** |
| `admin_bootstrap_emails` | **none** | **none** |

Any policy or grant not in this table is a test failure. That is the mechanism that stops a later task from quietly weakening the model.

## The webhook transaction

### Why it is a Postgres function

Requirement 16 criterion 2 requires the order update, enrollment insert, and referral insert to happen in **one** transaction, and criterion 6 requires exactly-once behaviour under overlapping calls. `supabase-js` issues each statement as its own transaction over PostgREST, so this cannot be built correctly in Deno. The Edge Function therefore does signature verification and nothing else before handing the entire decision to one RPC call.

The function is `SECURITY DEFINER`, owned by `postgres`, with `EXECUTE` granted only to `service_role`:

```sql
revoke all on function public.fulfil_payment(text, numeric, text, jsonb)
  from anon, authenticated;
grant execute on function public.fulfil_payment(text, numeric, text, jsonb)
  to service_role;
```

### fulfil_payment

```sql
create or replace function public.fulfil_payment(
  p_payment_id       text,
  p_reported_amount  numeric,
  p_reported_currency text,
  p_payload          jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order      public.orders;
  v_referrer   public.profiles;
  v_amount     numeric(12,2);
  v_reward_amt numeric(12,2);
  v_reward_ty  reward_type;
  v_reward_on  text;
  v_mask       text;
  v_title      text;
begin
  -- (1) Resolve the order and LOCK it. The lock is what serialises
  --     overlapping duplicate webhooks (Requirement 16.6).
  select * into v_order
  from public.orders
  where hitpay_payment_id = p_payment_id
  for update;

  -- (2) Unknown payment id (Requirement 16.10)
  if not found then
    insert into public.payment_incidents
      (kind, hitpay_payment_id, reported_amount, reported_currency, payload)
    values ('unmatched_payment', p_payment_id, p_reported_amount,
            p_reported_currency, p_payload);
    return jsonb_build_object('outcome','unmatched');
  end if;

  -- (3) Replay of an already-fulfilled order (Requirement 16.5).
  --     Return before touching anything so paid_at stays put.
  if v_order.status = 'paid' then
    return jsonb_build_object('outcome','already_paid','order_id',v_order.id);
  end if;

  -- (4) Out-of-order report against a refunded order (Requirement 16.9)
  if v_order.status = 'refunded' then
    insert into public.payment_incidents
      (kind, order_id, hitpay_payment_id, payload)
    values ('out_of_order_status', v_order.id, p_payment_id, p_payload);
    return jsonb_build_object('outcome','already_refunded');
  end if;

  -- (5) Paid-amount cross-check (Requirement 15). Overpayment is a mismatch
  --     too. The comparison value comes from the order row, never the payload.
  v_amount := round(coalesce(p_reported_amount, -1), 2);
  if v_amount is null or v_amount <> round(v_order.amount_php, 2) then
    insert into public.payment_incidents
      (kind, order_id, hitpay_payment_id, reported_amount, reported_currency,
       stored_amount, stored_currency, payload)
    values ('amount_mismatch', v_order.id, p_payment_id, p_reported_amount,
            p_reported_currency, v_order.amount_php, v_order.currency, p_payload);
    return jsonb_build_object('outcome','amount_mismatch');
  end if;

  if p_reported_currency is null
     or upper(btrim(p_reported_currency)) <> upper(v_order.currency) then
    insert into public.payment_incidents
      (kind, order_id, hitpay_payment_id, reported_amount, reported_currency,
       stored_amount, stored_currency, payload)
    values ('currency_mismatch', v_order.id, p_payment_id, p_reported_amount,
            p_reported_currency, v_order.amount_php, v_order.currency, p_payload);
    return jsonb_build_object('outcome','currency_mismatch');
  end if;

  -- (6) Mark paid.
  update public.orders
     set status = 'paid', paid_at = now()
   where id = v_order.id;

  -- (7) Grant access. ON CONFLICT makes the DB constraint the idempotency
  --     mechanism rather than a prior existence check (Requirement 16.4).
  insert into public.enrollments (user_id, product_id, source, order_id)
  values (v_order.user_id, v_order.product_id, 'purchase', v_order.id)
  on conflict (user_id, product_id) do nothing;

  -- (8) Referral attribution (Requirement 23), inside the same transaction.
  if v_order.ref_code is not null and length(btrim(v_order.ref_code)) > 0 then
    select * into v_referrer
    from public.profiles
    where ref_code = v_order.ref_code;

    if not found then
      null;                                        -- Requirement 23.4
    elsif v_referrer.id = v_order.user_id then     -- Requirement 23.3
      insert into public.payment_incidents (kind, order_id, hitpay_payment_id)
      values ('self_referral', v_order.id, p_payment_id);
    else
      select value into v_reward_on   from public.settings where key = 'reward_on';
      v_reward_on := coalesce(v_reward_on, 'every_purchase');

      if v_reward_on = 'first_purchase_only'
         and exists (select 1 from public.orders o
                     where o.user_id = v_order.user_id
                       and o.status  = 'paid'
                       and o.id     <> v_order.id) then
        null;                                      -- Requirement 23.6
      else
        select coalesce(value::numeric, 9) into v_reward_amt
          from public.settings where key = 'referral_amount';
        select coalesce(value, 'cash')::reward_type into v_reward_ty
          from public.settings where key = 'reward_type';

        v_mask  := public.mask_email(
                     (select email from public.profiles where id = v_order.user_id));
        v_title := (select title from public.products where id = v_order.product_id);

        insert into public.referrals
          (referrer_ref_code, referrer_user_id, buyer_user_id, buyer_masked,
           order_id, product_id, product_title, amount_php, reward_type, status)
        values
          (v_referrer.ref_code, v_referrer.id, v_order.user_id, v_mask,
           v_order.id, v_order.product_id, v_title,
           coalesce(v_reward_amt, 9), coalesce(v_reward_ty, 'cash'), 'available')
        on conflict (order_id) do nothing;         -- Requirement 23.5 / 16.4
      end if;
    end if;
  end if;

  return jsonb_build_object('outcome','fulfilled','order_id',v_order.id);
end $$;
```

Points worth noting, because they are the difference between this being correct and merely looking correct:

- **`FOR UPDATE` before any decision.** Two webhooks arriving in the same millisecond serialise on the order row. The second one resumes after the first commits, reads `status = 'paid'`, and returns at step 3. That is why exactly-once holds rather than depending on the unique constraints alone — though the constraints still backstop it.
- **Step 3 returns before the update.** Requirement 16 criterion 5 requires `paid_at` to stay unchanged on replay, so a blind `UPDATE ... SET paid_at = now()` would violate it even though the row count would look right.
- **Every non-fulfilment branch still returns normally**, so the transaction commits the incident row and the webhook answers HTTP 200. Returning an error would make HitPay retry a call that will never succeed.
- **A genuine fault raises** and Postgres rolls back the whole function, at which point the Edge Function returns 5xx and HitPay retries (Requirement 16 criterion 3). The rollback is automatic and total because everything happened in one function body.

### refund_payment

```sql
create or replace function public.refund_payment(
  p_payment_id text,
  p_payload    jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  select * into v_order
  from public.orders
  where hitpay_payment_id = p_payment_id
  for update;

  if not found then                                -- Requirement 17.8
    insert into public.payment_incidents
      (kind, hitpay_payment_id, payload)
    values ('unmatched_refund', p_payment_id, p_payload);
    return jsonb_build_object('outcome','unmatched_refund');
  end if;

  if v_order.status = 'refunded' then              -- Requirement 17.7
    return jsonb_build_object('outcome','already_refunded');
  end if;

  -- Requirement 17.1: any refunded amount, partial or full.
  update public.orders set status = 'refunded' where id = v_order.id;

  -- Requirement 17.2 / 17.10: revoke access; zero rows is not an error.
  delete from public.enrollments
   where user_id = v_order.user_id
     and product_id = v_order.product_id
     and (order_id = v_order.id or order_id is null);

  -- Requirement 17.4 / 17.5 / 17.11: void the referral, noting an
  -- already-paid reward, leaving paid_at intact.
  update public.referrals
     set status = 'void',
         notes  = concat_ws(' | ', notes,
                    case when status = 'paid'
                      then 'Voided after refund; reward had already been paid out.'
                      else 'Voided after refund.' end)
   where order_id = v_order.id;

  return jsonb_build_object('outcome','refunded','order_id',v_order.id);
end $$;
```

The `DELETE` is scoped to the enrollment created by this order, so a comp enrollment granted separately for the same product is not collaterally revoked. Requirement 17 criterion 2's "leave every other Enrollment held by that user unchanged" is satisfied by the `user_id`/`product_id` scoping.

### HitPay's wire format, from the official docs

Requirement 13 criteria 2 and 4 forbid guessing, so the adapter is built from HitPay's published behaviour rather than inference. Payment requests are created with `POST {base}/v1/payment-requests`, authenticated with the business API key in an `X-BUSINESS-API-KEY` header; production and sandbox differ only in base URL ([create payment request](https://docs.hitpayapp.com/apis/payment-request/create-request), [platform API examples](https://docs.hitpayapp.com/apis/guide/platform-apis)). HitPay offers **two distinct signing schemes** ([webhooks guide](https://docs.hitpayapp.com/apis/guide/events)):

| | Event webhooks | Legacy payment-request callbacks |
| --- | --- | --- |
| Salt | One per registered webhook endpoint | One per business API key |
| Signature location | `Hitpay-Signature` header | `hmac` field inside the payload |
| What is signed | The raw JSON body | Sorted, concatenated parameters |

This design uses the **event-webhook scheme**, because signing the raw body is what makes Requirement 14 criterion 1 achievable — the signature can be checked before the payload is parsed, so no field is ever read from an unverified call. Relevant event types are `charge.created` for a completed payment, `charge.updated` for a refund or partial refund, and `payment_request.failed` for a failure; the `Hitpay-Event-Object` header names the object type. Content was rephrased for compliance with licensing restrictions.

```ts
export async function verifyHitpaySignature(raw: string, req: Request, salt: string) {
  const supplied = req.headers.get("Hitpay-Signature");
  if (!supplied) return false;                        // Requirement 14.3
  const key = await crypto.subtle.importKey("raw", enc(salt),
                { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc(raw));
  return timingSafeEqual(hex(mac), supplied.trim().toLowerCase());   // Requirement 14.4
}
```

`parseHitpayPayload` normalises whatever arrived into one shape before any database access, so the SQL functions never see a vendor field:

```ts
type Normalised =
  | { status: "completed"; paymentId: string; amount: number; currency: string; raw: unknown }
  | { status: "refunded";  paymentId: string; raw: unknown }
  | { status: "failed";    paymentId: string; raw: unknown }
  | { status: "ignored" };
```

`paymentId` is the payment-request identifier stored on the order at creation, which is the field the charge payload carries back. HitPay reports currency codes in lower case, which is exactly why `fulfil_payment` upper-cases and trims both sides of the comparison. An `ignored` outcome returns 200 with zero writes, so unrelated event types registered on the same endpoint cannot disturb any order.

### hitpay-webhook (Deno side)

```ts
Deno.serve(async (req) => {
  // Raw body FIRST — HMAC is computed over exact bytes, not over a re-serialised object.
  const raw = await req.text();

  const ok = await verifyHitpaySignature(raw, req, Deno.env.get("HITPAY_WEBHOOK_SALT")!);
  if (!ok) {
    // Requirement 14.2/14.3/14.5: zero DB access, salt never logged.
    console.warn("hitpay webhook rejected: signature mismatch");
    return new Response("invalid signature", { status: 400 });
  }

  const p = parseHitpayPayload(raw);
  const db = serviceClient();               // service role, only after verification

  const fn = p.status === "refunded" ? "refund_payment" : null;
  let result;
  if (fn) {
    ({ data: result, error } = await db.rpc("refund_payment", {
      p_payment_id: p.paymentId, p_payload: p.raw,
    }));
  } else if (p.status === "completed") {
    ({ data: result, error } = await db.rpc("fulfil_payment", {
      p_payment_id: p.paymentId,
      p_reported_amount: p.amount,
      p_reported_currency: p.currency,
      p_payload: p.raw,
    }));
  } else {
    ({ data: result, error } = await db.rpc("fail_payment", {
      p_payment_id: p.paymentId, p_payload: p.raw,
    }));
  }

  if (error) return new Response("retry", { status: 500 });   // Requirement 16.3
  return new Response(JSON.stringify(result), { status: 200 });
});
```

`verify_jwt = false` is set for this function only, in `supabase/config.toml`. It is the single unauthenticated endpoint in the system, which is why the HMAC check runs before anything else and why nothing downstream trusts a field it did not verify.

## Components and Interfaces

| Component | Kind | Consumes | Exposes |
| --- | --- | --- | --- |
| `js/supabase.js` | Browser module | `config.js` public values | Shared `supabase-js` client |
| `js/auth.js` | Browser module | Supabase Auth | `signIn(email)`, `verify(code)`, `signOut()`, `requireSession()`, `requireAdmin()` |
| `js/api.js` | Browser module | Session JWT | One typed wrapper per Edge Function; attaches `Authorization` |
| `js/dom.js` | Browser module | — | `el()`, `$`, `$$`, `peso()`; no `innerHTML` path |
| `js/states.js` | Browser module | — | `renderLoading()`, `renderEmpty()`, `renderError()` |
| `js/referral.js` | Browser module | `localStorage` | `captureRef()`, `currentRef()` with 30-day first-touch |
| `_shared/auth.ts` | Edge module | `Authorization` header | `requireUser(req) → uid` |
| `_shared/admin.ts` | Edge module | `profiles.is_admin` | `requireAdmin(req) → uid` |
| `_shared/hitpay.ts` | Edge module | `HITPAY_*` env vars | `createPaymentRequest()`, `verifyHitpaySignature()` |
| `_shared/http.ts` | Edge module | — | `json()`, `HttpError`, secret-free error shaping |
| `public.fulfil_payment` | SQL function | Service role only | Atomic pay → enrol → attribute |
| `public.refund_payment` | SQL function | Service role only | Atomic refund → revoke → void |
| `public.mask_email` | SQL function | — | Buyer mask for the referral ledger |

Interface contracts between the browser and the server are the Edge Function request/response shapes below, plus the RLS-permitted PostgREST reads listed in the policy inventory. There is no third channel.

### Edge Functions

#### Shared modules

`_shared/auth.ts` holds the one function every user-facing endpoint starts with:

```ts
export async function requireUser(req: Request): Promise<string> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "authentication required");

  // Verifies signature, issuer, and expiry against this project.
  const { data, error } = await anonClient().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "authentication required");

  return data.user.id;                 // the ONLY source of identity
}
```

Requirement 4 criterion 4 is satisfied structurally rather than by a check: no handler accepts a user id parameter, so there is no field to ignore. Handlers destructure only the fields they need (`product_id`, `quiz_id`, `answers`) and pass `uid` from `requireUser`.

`_shared/admin.ts` adds the admin gate, which re-reads the flag from the database on every call rather than trusting a JWT claim:

```ts
export async function requireAdmin(req: Request): Promise<string> {
  const uid = await requireUser(req);
  const { data } = await serviceClient()
    .from("profiles").select("is_admin").eq("id", uid).single();
  if (!data?.is_admin) throw new HttpError(403, "not permitted");
  return uid;
}
```

`_shared/http.ts` centralises error shaping so Requirement 28 criterion 5 holds everywhere: responses carry a short code and message, never a stack trace or an environment value.

#### Function inventory

| Function | Auth | Responsibility |
| --- | --- | --- |
| `create-payment` | JWT | Derive price from `products`, insert `pending` order, call HitPay, return checkout URL |
| `hitpay-webhook` | HMAC only | Verify signature, dispatch to `fulfil_payment` / `refund_payment` / `fail_payment` |
| `get-quiz` | JWT | Enrollment check, return questions with answer fields stripped |
| `grade-quiz` | JWT | Enrollment check, grade server-side, insert attempt, reveal per `answer_reveal_mode` |
| `issue-material-url` | JWT | Enrollment check, return 300-second signed URL |
| `request-payout` | JWT | Recompute available balance server-side, insert `payout_requests` row |
| `admin-products` | Admin | Product CRUD, publish, thumbnail + material upload |
| `admin-quizzes` | Admin | Quiz CRUD, `pack_quizzes` mapping |
| `admin-questions` | Admin | Question CRUD including `correct_key` and `explanation` |
| `admin-enrollments` | Admin | Grant (`comp`/`credit`) and revoke |
| `admin-referrals` | Admin | Ledger, mark paid, void |
| `admin-settings` | Admin | Settings edit with per-key validation |
| `admin-incidents` | Admin | Mismatch/unmatched review list, mark resolved |
| `admin-users` | Admin | Grant `is_admin` to another email |

#### create-payment

Price derivation is the security-relevant part. The handler reads `product_id` and nothing else that affects money:

```ts
const uid = await requireUser(req);
const { product_id, ref_code } = await req.json();

const { data: product } = await db.from("products")
  .select("id, price_php, published, title")
  .eq("id", product_id).single();

if (!product || !product.published) throw new HttpError(404, "product not found");

const { data: owned } = await db.from("enrollments")
  .select("id").eq("user_id", uid).eq("product_id", product_id).maybeSingle();
if (owned) return json({ already_owned: true });          // Requirement 11.6

const { data: order } = await db.from("orders").insert({
  user_id: uid,
  product_id: product.id,
  amount_php: product.price_php,       // from the DB, never the request
  currency: "PHP",
  status: "pending",
  ref_code: sanitiseRefCode(ref_code),
}).select().single();
```

The HitPay call then uses `order.amount_php`. Base URL and key come from `HITPAY_API_BASE_URL` and `HITPAY_API_KEY`; if either is absent the function returns an error naming the missing variable and makes no outbound call (Requirement 13 criterion 5). Endpoint paths are resolved against the configured base URL and are recorded in SETUP rather than hardcoded, so sandbox-to-live is an environment change only.

#### get-quiz and grade-quiz

Enrollment is resolved through `pack_quizzes`, since a quiz is owned by way of a pack:

```sql
select 1
from public.pack_quizzes pq
join public.enrollments e on e.product_id = pq.product_id
where pq.quiz_id = $1 and e.user_id = $2
limit 1;
```

`get-quiz` selects explicit columns — `id, question_number, question_text, options` — rather than `select('*')` with a delete pass. Omitting the answer fields from the query means they are never in the function's memory, so there is no object for a future refactor to accidentally serialise. Requirement 6 criterion 11's fail-closed clause is satisfied by a final assertion that the serialised payload contains neither field before it is returned.

`grade-quiz` grades against `correct_key` and then applies the reveal rule:

```ts
const mode = await readSetting("answer_reveal_mode", "answered_only");

const results = questions.map((q) => {
  const submitted = answers[q.id];                 // may be undefined
  const answered  = submitted !== undefined && submitted !== null && submitted !== "";
  const correct   = answered && submitted === q.correct_key;

  // Requirement 6.10 / 20.5: reveal only for answered questions.
  // Requirement 6.12 / 20.9: full_reveal overrides.
  const reveal = mode === "full_reveal" || answered;

  return {
    question_number: q.question_number,
    answered,
    correct,
    ...(reveal ? { correct_key: q.correct_key, explanation: q.explanation } : {}),
  };
});
```

A submitted key that is not in the question's `options` counts as *answered* for reveal purposes and *incorrect* for scoring (Requirement 20 criterion 10). A deliberately blank submission gets `answered: false` on every question, so the response carries zero keys and zero explanations — which is the exact assertion in Requirement 6 criterion 14.

`answer_reveal_mode` is read through the service role, and the setting row is not `display_safe`, so the client cannot discover which mode is active.

### Front-end

#### Session and route classes

Three route classes, enforced in `auth.js`:

- **Public** — `index`, `catalog`, `product`, `faq`, `login`. Render fully without a session.
- **Session-required** — `my-learning`, `earnings`, `account`, `enrolled`, `quiz`. Redirect to login with a `next` parameter.
- **Admin-required** — `admin`. Requires a session and `profiles.is_admin = true`; otherwise renders an access-denied state and zero management views.

The account menu renders from the session plus a single `profiles` read. Catalog rendering is identical in both states (Requirement 10 criterion 4) — the only difference is the top bar and the CTA label.

#### Purchase flow

```
product.html  Buy
   │
   ├─ no session ─► store {product_id} in sessionStorage ─► login.html
   │                        │ OTP verified
   │                        ▼
   │                 resume: back to checkout for the stored product_id
   │
   └─ session ─► api.createPayment(product_id, refCode) ─► redirect to HitPay
                                                                │
                            enrolled.html ◄── HitPay redirect ──┘
                              poll orders + enrollments every 2s, cap 30s
```

The poll exists because the browser redirect and the webhook race. It reads the user's own rows through RLS, so no new endpoint is needed. On timeout the page shows a confirmation-pending state with a link to My Learning rather than an error, because the webhook will land regardless.

#### Quiz runner

One question per screen, progress indicator, optional countdown from `timer_minutes`, review screen listing unanswered questions with the warning that they score as incorrect, then submit. Answers accumulate in memory and are posted once. Results render score, total, per-question correctness, and whatever explanations the server chose to return — the client displays what it is given and has no notion of a hidden key.

#### Output safety

`js/dom.js` exposes `el(tag, { class, text, attrs, children })` with no `html` option. Attribute values reject any scheme other than `https` for `href` and `src`. Every list and card is built by element creation, so a product title containing markup renders as literal text (Requirement 29).

#### Design pass

The v1 WebGL hero, `js/hero3d.js`, `js/fx.js`, and `js/cursor.js` are dropped from page loads. The palette (terracotta, slate, off-white) and fonts (Fraunces display, Manrope body) carry over. Spacing is an 8px scale; the catalog is single-column at ≤480px and a multi-column grid at ≥768px. `prefers-reduced-motion: reduce` disables decorative transitions. Every view implements loading, empty, and error states from `states.js`.

## Migration and seed

The cutover is a replacement, not a dual-run. The v1 backend is authoritative until the moment DNS-level traffic moves to the v2 site, and `apps-script/` is retained unmodified so a rollback means re-pointing `config.js` at the Web App (Requirement 35 criterion 9).

**Step 1 — export.** A Node script calls the v1 Web App's read endpoints (`getProducts`, `getQuizList`, `getQuiz` needs a code, so questions come from a one-off `adminListQuestions` pass using an admin token) and writes `supabase/seed/v1-export.json`. Running against the live endpoints rather than a manual CSV export avoids transcription drift.

**Step 2 — shape.** The importer maps v1 to v2:

| v1 | v2 |
| --- | --- |
| `Products.product_id` | `products.slug` |
| `Products.type` `material` / `quiz` | `products.type` `material` / `quiz_pack` |
| `Products.active` | `products.published` |
| `Products.price_php`, `subject`, `title`, `description`, `sort_order` | same columns |
| `Products.drive_note` | operator note; the actual file is uploaded to `products.material_path` |
| `Products.unlock_scope` | expanded to `pack_quizzes` rows (scope `structural` → every quiz whose slug is `structural` or starts `structural-`; scope `all` → every quiz) |
| distinct `Quizzes.quiz_id` | one `quizzes` row; `timer_minutes` from the first non-blank value |
| each `Quizzes` row | one `questions` row; `option_a..option_d` → `options` jsonb `[{key,label}]` omitting blanks; `correct_option` → `correct_key`; `explanation` preserved |
| `AccessCodes` | **not migrated** — superseded by enrollments |
| `Attempts` | **not migrated** — anonymous, code-keyed, no user to attach to |

Scope expansion is the one lossy step, because v1 encoded the pack→quiz relationship as a string prefix. The importer prints the expansion it derived per product for review before insert, and the mapping is editable afterwards through `admin-quizzes`.

**Step 3 — idempotent import.** Every insert is `on conflict (slug) do nothing` for products and quizzes and `on conflict (quiz_id, question_number) do nothing` for questions, so a second run leaves row counts unchanged (Requirement 35 criterion 8). The script prints per-table created counts and an uploaded-file count (criterion 6).

**Step 4 — files.** Material PDFs move from Drive into the private `materials` bucket, path `materials/{product_slug}/{filename}`, recorded on `products.material_path`. Thumbnails go to a separate **public** `thumbnails` bucket, since a catalog thumbnail must render for anonymous visitors and carries nothing sensitive — that separation is why `thumbnail_path` can be granted to client roles while `material_path` cannot.

**Step 5 — verification before cutover.** Seed one test account with one purchase enrollment and one comp enrollment (criterion 7), then walk the sandbox sequence end to end: browse anonymously, log in with OTP, pay in HitPay sandbox, observe the webhook grant, open a material, take a quiz, confirm the referral row. Switch `HITPAY_API_BASE_URL` and the keys to live values only after that passes.

**Retired v1 surfaces.** `apps-script/Code.gs` and `Setup.gs` (unmodified but unused), the access-code flow, `materials.html` and `quizzes.html` in their catalog form, `thank-you.html` (replaced by `enrolled.html`), `js/config-loader.js`, `js/hero3d.js`, and the WebGL hero assets (Requirement 32 criterion 3). Copy that promised "no account needed" or email-delivered materials is rewritten across `index.html`, `faq.html`, and the Docs (Requirement 34).

## Decisions that differ from a literal reading of the requirements

These are refinements made while designing. Each strengthens the requirement it touches, but they are deviations and should be confirmed:

1. **`buyer_masked` is stored rather than masked in the browser.** Requirement 7 criterion 7 asks the front end to mask the buyer. A front-end mask still ships the raw id to the client. Storing the mask lets `buyer_user_id` be withheld at the grant, so the referrer never receives it.
2. **`product_title` is denormalised onto `referrals`.** Without it, a referral for a since-unpublished product would render with a blank title, because the referrer's catalog read is `published`-gated.
3. **Display_Safe_Keys is a `display_safe` boolean, not a literal key list.** New settings are private by default, which fails in the safe direction.
4. **Two tables exist that the requirements imply but do not name:** `payment_incidents` (the destination for every "record for admin review" clause) and `payout_requests` (Requirement 25 criterion 7). Also `admin_bootstrap_emails`, so appointing an admin pre-login is a data change rather than a migration edit.
5. **Enrollment revocation is a hard delete.** Chosen so the unique constraint in Requirement 16 criterion 1 stays a plain constraint, Requirement 17 criterion 13's zero-rows assertion holds, and a refunded buyer can repurchase. Audit history lives on `orders` and `quiz_attempts`.
6. **Requirement 3 criterion 2 and Requirement 26 criterion 2 conflict on `is_admin` at signup.** Requirement 3 says the trigger sets `is_admin` to `false`; Requirement 26 says an owner email gets `true`. The trigger implements Requirement 26 as the exception and Requirement 3 as the default. Requirement 3 criterion 2 should be reworded to "false unless the email is present in the admin bootstrap list."
7. **`orders.amount_php` is `numeric(12,2)` while `products.price_php` stays `integer`.** Requirement 15 compares at two decimal places against a decimal HitPay amount; the integer price widens losslessly.

## Requirements not yet addressed by this design

Deferred to tasks, with no design risk: the SMTP and Google OAuth project configuration (Requirements 2, 30) are console settings documented in SETUP rather than code; the documentation rewrites (Requirement 36) and copy corrections (Requirement 34) are content work.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

The acceptance criteria were classified before these were written. Criteria that are configuration checks (RLS enabled, seeded rows, private bucket), documentation content, external-service behaviour (Supabase Auth code issuance, HitPay's own API, SMTP delivery, Storage expiry enforcement), or single-branch UI wiring are covered by smoke, integration, and example tests in the Testing Strategy rather than by properties. What follows is the consolidated set after removing overlaps — for instance, the three enrollment gates became one property, and the six answer-key criteria became one.

### Property 1: Answer keys are unreachable from every client query shape

*For any* quiz, *for any* client role state (no session, a valid session without an enrollment, a valid session with an enrollment covering that quiz), and *for any* query shape against `questions` (any subset of requested columns including `correct_key` alone and `explanation` alone, any filter, any ordering, any row limit, any aggregate, and any path that reaches the table through a join, an embedded resource, a view, or a routine), the query returns zero rows and zero answer values.

**Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.9**

### Property 2: Quiz payloads never carry answer fields

*For any* quiz — any number of questions, any number of options per question, blank or populated explanations, any unicode content — the serialised `get-quiz` response contains zero occurrences of the `correct_key` field name, zero occurrences of the `explanation` field name, and zero stored answer values; and where the payload cannot be built without them, the response carries zero question objects.

**Validates: Requirements 6.7, 6.11, 19.3, 19.6**

### Property 3: Answer reveal is scoped exactly to the submitted set

*For any* quiz, *for any* submission, and *for any* `answer_reveal_mode` value, the set of questions whose grading result carries `correct_key` and `explanation` equals the set of questions the submission answered when the mode is `answered_only`, equals the full question set when the mode is `full_reveal`, and equals the `answered_only` behaviour when the setting row is absent. A submission answering zero questions reveals zero answer values.

**Validates: Requirements 6.10, 6.12, 6.14, 20.5, 20.9, 20.14**

### Property 4: The policy matrix is default-deny

*For any* table in the schema, *for any* client role, and *for any* operation in {select, insert, update, delete}, the operation either appears in the declared policy set or returns zero rows (select) or a policy violation with unchanged row counts (insert, update, delete). In particular, every insert, update, and delete attempted by a client role against `orders`, `enrollments`, and `referrals` is rejected, including an insert of an `enrollments` row for the caller's own id.

**Validates: Requirements 5.3, 8.2, 8.3, 8.6**

### Property 5: Reads are isolated to the owning user

*For any* two distinct users and *for any* generated set of their `profiles`, `orders`, `enrollments`, `quiz_attempts`, and `referrals` rows, a select by one user returns exactly that user's rows, returns zero rows when filtered to the other user's identifiers, and returns zero fields identifying the other user; the same selects issued without a session return zero rows.

**Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.7, 7.8**

### Property 6: Protected profile columns cannot be changed by their owner

*For any* update payload a user submits against their own `profiles` row, the update succeeds only where it touches `display_name` and `gcash_number` alone, is rejected where it touches `is_admin`, `ref_code`, `referred_by`, `email`, or `id`, and leaves the stored values of those columns identical to their pre-update values in every case.

**Validates: Requirements 9.2, 9.3**

### Property 7: Client catalog reads return exactly the published subset

*For any* generated set of `products`, `quizzes`, and `pack_quizzes` rows with arbitrary `published` flags, a client select on `products` and `quizzes` returns exactly the rows whose `published` value is `true`, and a client select on `pack_quizzes` returns exactly the rows whose parent product is published.

**Validates: Requirements 9.4, 9.5**

### Property 8: Settings visibility equals the allowlist

*For any* generated set of `settings` rows with arbitrary `display_safe` flags, the key set a client role can read equals the set of keys whose `display_safe` value is `true`, and never includes `answer_reveal_mode`.

**Validates: Requirements 9.6, 9.7, 9.9, 9.10**

### Property 9: Identity comes only from a validated token

*For any* request to `create-payment`, `get-quiz`, `grade-quiz`, `issue-material-url`, or an `admin-*` function: where the bearer token is absent, malformed, expired, unsigned, signed by another issuer, or carries no user id claim, the function returns 401 having read zero rows, written zero rows, and requested zero Storage objects; and *for any* request-body field, query parameter, or header naming a user, profile, or email, every query and write the function performs resolves against the token's user id, a reference to another user's resource yields 403 with zero foreign fields, and no error response contains the supplied token, a token claim, another user's identifier, a configured secret value, or a stack frame.

**Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 28.5**

### Property 10: Admin authorisation is total over admin functions

*For any* `admin-*` function and *for any* caller, the write proceeds only where the caller's stored `profiles.is_admin` value is `true`; every other caller receives 403 with zero target rows changed, and *for any* `is_admin`, `role`, or `privilege` value supplied in a request body or header, the outcome is identical to the same request without it.

**Validates: Requirements 26.4, 26.5, 26.6, 26.7, 26.8**

### Property 11: Signup provisions exactly one profile with a unique code

*For any* sequence of `auth.users` inserts, each insert produces exactly one `profiles` row whose `id` matches, whose `email` is copied, whose `ref_code` is unique across the table and drawn only from the unambiguous alphabet, and whose `is_admin` is `true` if and only if the normalised email is an owner email; a forced code collision still completes the insert.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 26.1, 26.2**

### Property 12: Order amounts derive from the database, never the request

*For any* published product and *for any* request payload — including one carrying `amount`, `price`, and `currency` fields differing from the stored values — the created order's `amount_php` equals that product's `price_php`, its `currency` equals `PHP`, its `user_id` equals the token's user id, its `status` is `pending`, and its `ref_code` equals the submitted referral code where one was supplied and is null otherwise.

**Validates: Requirements 11.1, 11.2, 11.4, 11.5, 11.7**

### Property 13: Unverified webhook calls change nothing

*For any* webhook payload and *for any* supplied signature that differs from the HMAC-SHA256 of the raw body under the configured salt — including a bit-flipped digest, a truncated digest, a differently-cased digest, and an absent header — the call is rejected with zero rows changed in `orders`, `enrollments`, `referrals`, and `payment_incidents`, the rejection log records the reported payment identifier and contains zero occurrences of the salt, and a correctly computed signature is accepted.

**Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5**

### Property 14: Access is granted only on an exact amount and currency match

*For any* verified completed-payment call and *for any* reported amount and currency, fulfilment proceeds if and only if the reported amount equals the matching order's `amount_php` at two-decimal precision and the reported currency equals that order's `currency` ignoring case and surrounding spaces; otherwise zero `enrollments` rows and zero `referrals` rows are created, the order `status` remains `pending`, exactly one incident record is stored retaining the reported amount, reported currency, reported payment identifier, stored amount, stored currency, and recording time, and the response is HTTP 200. A reported payment identifier matching zero orders produces the same outcome with zero order rows changed.

**Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.7, 15.8, 15.9, 15.10, 16.10**

### Property 15: Fulfilment is idempotent under any delivery sequence

*For any* number of verified completed-payment deliveries for the same payment identifier, delivered sequentially or with overlapping processing windows, the final state contains exactly one order with `status = 'paid'` whose `paid_at` equals the value written by the first successful delivery, exactly one `enrollments` row for that order's user and product, and at most one `referrals` row for that order, with every column of the existing enrollment and referral unchanged by later deliveries, and HTTP 200 returned for every delivery.

**Validates: Requirements 16.2, 16.4, 16.5, 16.6, 16.7**

### Property 16: Non-completed outcomes respect the order's current state

*For any* order status and *for any* verified call reporting a failed or cancelled payment, the order moves to `failed` with zero enrollments and zero referrals created where its status was `pending`, and is left entirely unchanged with an incident recorded where its status was already `paid` or `refunded`; the response is HTTP 200 in every case.

**Validates: Requirements 16.8, 16.9**

### Property 17: A refund leaves no unearned benefit

*For any* starting order state — enrollment present or absent, referral absent, available, or paid — and *for any* reported refunded amount, a verified refund sets that order's `status` to `refunded`, leaves zero `enrollments` rows for that order's user and product while leaving that user's other enrollments and all of that user's `quiz_attempts` rows unchanged, sets that order's referral `status` to `void` while preserving its `paid_at` and adding a note where it had been paid, and causes every subsequent `get-quiz`, `grade-quiz`, and `issue-material-url` request from that user for the revoked product to return 403 with zero question objects, zero correctness data, and zero signed URLs. Repeated and concurrent refund deliveries for the same payment identifier leave that state unchanged and return HTTP 200.

**Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5, 17.7, 17.10, 17.11, 17.13**

### Property 18: Referral attribution is exactly-once and predicate-driven

*For any* confirmed order and *for any* referral configuration, exactly one `referrals` row exists for that order if and only if the order carries a referral code resolving to a profile whose id differs from the buyer's, no referral row already exists for that order, and the `reward_on` setting permits the reward for that buyer's purchase history; that row's `amount_php` and `reward_type` equal the settings values in force at insert time, its `status` is `available`, and previously inserted rows are unaffected by later configuration changes. In every excluded case zero referral rows are inserted, the self-referral case is recorded, and the enrollment grant still completes.

**Validates: Requirements 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8, 24.2, 24.4**

### Property 19: Ledger balances follow from row status

*For any* generated referral ledger, the displayed available balance equals the sum of `amount_php` over rows with `status = 'available'`, the displayed paid balance equals the sum over rows with `status = 'paid'`, rows with `status = 'void'` contribute to neither while still appearing in the listing, the referral count equals the number of attributed rows, every listed row shows its created date, product title, amount, status, and a masked buyer, and a submitted payout request produces exactly one `payout_requests` row carrying the supplied GCash number and the requested amount.

**Validates: Requirements 17.6, 25.1, 25.2, 25.3, 25.7, 25.8**

### Property 20: Payout eligibility is a strict threshold test

*For any* available balance, *for any* payout threshold, and *for any* reward type, the payout-request control is enabled if and only if the reward type is `cash` and the balance is greater than or equal to the threshold; below the threshold the shortfall displayed equals threshold minus balance, and in `credit` mode the balance is presented as redeemable credit with the payout control absent.

**Validates: Requirements 25.4, 25.5, 25.6**

### Property 21: Content access requires a matching enrollment

*For any* user, product, and quiz configuration — including a quiz belonging to several packs, a quiz belonging to none, and a user enrolled in one of several packs containing the quiz — `get-quiz`, `grade-quiz`, and `issue-material-url` each succeed if and only if the user holds an enrollment for at least one product covering the requested item; where they succeed, `issue-material-url` returns a freshly minted signed URL with a 300-second expiry and `get-quiz` returns the quiz title, subject, timer, and ordered questions; where they do not, the response is 403 with zero question objects, zero attempt rows inserted, and zero signed URLs, and no client-visible product payload ever contains a Storage object path.

**Validates: Requirements 18.2, 18.3, 18.4, 18.6, 18.7, 19.1, 19.2, 19.4, 20.6**

### Property 22: Grading is computed from the database alone

*For any* quiz and *for any* submission — including blank answers, answer keys absent from a question's options, and hostile `score`, `total`, or correctness fields in the request body — the returned score equals the number of questions whose submitted key equals the stored `correct_key`, the returned total equals the question count, every unanswered and out-of-options question is counted incorrect, the client-supplied fields have no effect on the result, and exactly one `quiz_attempts` row is inserted carrying the token's user id, the quiz id, that score and total, and the submitted answers.

**Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.7, 20.8, 20.10**

### Property 23: Enumerated settings reject every other value

*For any* string submitted as `reward_type` or `answer_reveal_mode`, the save succeeds if and only if the value is one of that setting's two accepted values, and otherwise returns a validation message leaving the stored value unchanged.

**Validates: Requirements 20.13, 24.5**

### Property 24: Product saves validate price, slug, and type

*For any* product payload and *for any* existing catalog, the save succeeds if and only if `price_php` is a positive integer, `slug` is used by no other product, and `type` is `material` or `quiz_pack`; otherwise it returns a validation message and writes zero rows.

**Validates: Requirements 27.11**

### Property 25: Question numbering stays contiguous

*For any* sequence of question add, delete, and reorder operations on a quiz, the resulting `question_number` values are exactly 1 through N with no gaps and no duplicates, and the resulting order matches the last requested order.

**Validates: Requirements 27.4**

### Property 26: Referral capture is first-touch with a 30-day life

*For any* sequence of page visits carrying referral parameters interleaved with arbitrary clock advances, the stored referral code is the first one captured within the preceding 30 days, later visits leave it unchanged, it is discarded once its capture timestamp is older than 30 days, the checkout request carries it if and only if a stored code is unexpired, and the referral link presented to a user is that user's own code appended to the site origin as a `ref` parameter.

**Validates: Requirements 22.1, 22.2, 22.3, 22.4, 22.5**

### Property 27: The catalog renders the published set identically for every visitor

*For any* generated catalog, the set of products rendered on the catalog view equals the set of published products for a visitor with a session and for a visitor without one, the rendered order is non-decreasing in `sort_order`, each card shows thumbnail, title, subtitle, subject, PHP price, and contents with a keyboard-reachable primary action whose accessible name includes the product title, and each product detail view shows description, price, contents, refund information, and the secure-payment note.

**Validates: Requirements 10.1, 10.2, 10.3, 10.4, 31.7, 32.7, 32.8**

### Property 28: Checkout survives the login detour

*For any* published product, selecting Buy without a session records that product, routes to login, and after a completed login lands on the checkout step for that same product with the record cleared; where no product was recorded, a completed login lands on My Learning.

**Validates: Requirements 10.5, 10.6, 31.6**

### Property 29: The quiz runner state follows the quiz and the answers

*For any* quiz and *for any* sequence of navigation and answer actions, exactly one question is displayed at a time, the progress indicator shows the current position and the total question count, a countdown is displayed if and only if `timer_minutes` is greater than zero and is initialised to that value, the review screen lists every question with its answered state and warns if and only if at least one is unanswered, and the results view shows the score, the total, and an explanation for every revealed question.

**Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.6, 21.7, 21.8**

### Property 30: The confirmation view resolves within its polling window

*For any* delay between the buyer's return and the webhook's completion, the enrolled-confirmation view shows the enrolled state if and only if a paid order and its enrollment become visible within 30 seconds, shows the pending state with a My Learning link otherwise, and stops polling in both cases.

**Validates: Requirements 12.6, 12.7**

### Property 31: Database content renders as literal text

*For any* string stored in a product title, subtitle, description, or contents list — including HTML markup, quotes, angle brackets, and control characters — the rendered node's text content equals the stored string and the rendered subtree contains zero elements originating from that string.

**Validates: Requirements 29.1, 29.2, 29.4**

### Property 32: Only https values reach link and image attributes

*For any* string read from the database and destined for an `href` or `src` attribute, the attribute is set if and only if the value's scheme is `https`, and rejected values leave the attribute absent.

**Validates: Requirements 29.3**

### Property 33: The shell and My Learning reflect session and enrollment state

*For any* session and profile state, the top bar shows the user's `display_name` where present and the email otherwise together with an account menu containing My Learning, Earnings, Account settings, and Log out, and shows a Log in control where no session exists; and *for any* generated enrollment set, My Learning lists exactly the products covered by those enrollments, grouped into materials and quizzes, with no expiry filtering applied to purchase-sourced enrollments.

**Validates: Requirements 31.1, 31.2, 31.3, 31.8**

### Property 34: Every view region shows exactly one state

*For any* sequence of in-flight, success, empty, and error outcomes for a view region, exactly one of the loading, content, empty, and error states is rendered at each point; the error state names the failed action and offers a retry control; a 401 routes to the login view with a session-expired message; and a 403 for a material or a quiz shows the purchase-required state with a link to that product's detail view.

**Validates: Requirements 33.1, 33.5, 33.6, 33.7**

### Property 35: The import maps v1 content faithfully and is idempotent

*For any* v1 export, the import creates one product per active v1 product preserving title, subject, description, price, and sort order with `material` and `quiz` mapped to `material` and `quiz_pack`, one quiz per distinct v1 quiz id preserving title, subject, and timer, one question per v1 question row preserving text, non-blank options, correct key, and explanation, and pack links covering exactly the quizzes the product's unlock scope matched; the reported per-table counts equal the observed row-count deltas; and a second run over the same database leaves the row counts of `products`, `quizzes`, `questions`, and `pack_quizzes` unchanged.

**Validates: Requirements 35.1, 35.2, 35.3, 35.4, 35.6, 35.8**

### Property 36: HitPay URLs resolve against the configured base

*For any* configured base URL, with or without a trailing slash, the request URL equals that base joined to the documented endpoint path with exactly one separator and no duplicated path segment.

**Validates: Requirements 13.4**

### Property 37: Login input validation and resend timing follow their rules

*For any* string submitted on the email step, a one-time code is requested if and only if the string matches the accepted email shape and is at most 254 characters, and a rejected value stays in the field; and *for any* elapsed time since a code request, the resend control is disabled with the remaining whole seconds displayed while that elapsed time is under 60 seconds, and enabled at and beyond 60 seconds.

**Validates: Requirements 1.7, 1.9**

## Error Handling

### Response shape

Every Edge Function returns JSON, never HTML, and uses one envelope:

```json
{ "ok": false, "code": "not_enrolled", "message": "This item isn't in your library yet." }
```

`code` is a stable machine token the front end branches on; `message` is copy safe to show a student. The scrubber in `_shared/http.ts` runs over every outbound body and strips any substring equal to a configured secret value, plus anything resembling a stack frame, so a thrown library error cannot leak a key or an internal path (Requirement 28 criterion 5).

| `code` | HTTP | Front-end response |
| --- | --- | --- |
| `auth_required` | 401 | Route to login with "Your session expired. Please sign in again." |
| `not_admin` | 403 | Access-denied state, zero management views |
| `not_enrolled` | 403 | Purchase-required state with a link to the product detail view |
| `not_found` | 404 | "This item isn't available." |
| `already_owned` | 409 | "You already own this — open it in My Learning." |
| `below_threshold` | 409 | Show the shortfall, keep the control disabled |
| `validation_failed` | 422 | Inline field message, no navigation |
| `config_missing` | 500 | Admin-facing message naming the absent variable |
| `upstream_failed` | 502 | "We couldn't reach the payment provider. Please try again." |

### Webhook error policy

The webhook has a deliberately inverted convention: **2xx means "I have finished thinking about this call," not "everything was fine."** An amount mismatch, a currency mismatch, an unmatched payment, an unmatched refund, a self-referral, and an out-of-order status change all return 200 with an incident recorded, because a retry would produce the same outcome and HitPay would keep retrying forever. Only an unexpected fault — a rolled-back transaction, a database outage, an unhandled exception — returns 5xx, which is the one case where a retry can help (Requirement 16 criteria 3, 4 and Requirement 17 criterion 12). A signature failure returns 401 and is never retried into a write.

### Money failure modes, and what each leaves behind

| Failure | Order | Enrollment | Referral | Recorded |
| --- | --- | --- | --- | --- |
| Forged signature | unchanged | none | none | log line only, no row |
| Underpayment or overpayment | stays `pending` | none | none | `amount_mismatch` incident |
| Wrong currency | stays `pending` | none | none | `currency_mismatch` incident |
| Unknown payment id | no row touched | none | none | `unmatched_payment` incident |
| Replay of a paid order | unchanged | unchanged | unchanged | nothing |
| Fault mid-transaction | rolled back | rolled back | rolled back | HitPay retries |
| Refund | `refunded` | deleted | `void` | note where already paid |
| Self-referral | `paid` | granted | none | `self_referral` incident |

Leaving a mismatched order at `pending` rather than marking it `failed` is intentional: the payment may be genuine and recoverable, and an admin resolving the incident can grant access manually. Marking it `failed` would discard that context.

### Front-end error handling

`js/api.js` centralises the mapping so no view repeats it. A 401 clears the session and routes to login once, even if three parallel calls all return 401. Network failures and timeouts surface as a retryable error state naming the action ("Couldn't load your library"), never a blank region. Loading states are scoped per region so one slow call does not blank a page that has already rendered its catalog.

### Logging

Webhook rejections log the reported payment identifier and the reason. The webhook salt, the HitPay API key, the service-role key, and payer detail never appear in a log line; the full payload is stored in `payment_incidents.payload`, which no client role can read and which the admin portal reaches only through `admin-incidents`.

### Database-level guards as the last line

Several error conditions cannot be reached at all because the schema forbids them: `price_php > 0`, `amount_php > 0`, `currency = 'PHP'` on products, the enum types on every status column, `referrals_no_self`, and the three uniqueness rules behind idempotency. A logic bug in an Edge Function surfaces as a constraint violation and a rolled-back transaction rather than as bad data.

## Testing Strategy

Tests run under `node:test` with no framework dependency, matching the repository's existing `tests/backend-test.js` habit of a committed, runnable harness. Property-based tests use **fast-check**, added as the single new dev dependency, pinned to an exact version. Properties are not hand-rolled; generators and shrinking come from the library.

### Layers

**1. Database tests against a local Supabase instance.** `supabase start` provides Postgres with the migration set applied. Three clients are constructed: anon, authenticated (one per test user, via a real sign-in), and service role. This layer owns Properties 1, 4, 5, 6, 7, 8, 11, 15, 16, 17, 18, 22, 25, and the schema smoke checks. The RLS properties must run against real Postgres — a mock would test the mock's idea of policy evaluation, which is worth nothing here.

**2. Edge Function tests.** Functions are imported directly and invoked with constructed `Request` objects, with the HitPay HTTP client injected. Tokens are minted locally with the project's JWT secret so invalid-token variants can be generated freely. This layer owns Properties 2, 3, 9, 10, 12, 13, 14, 21, 23, 24, 36.

**3. Front-end tests.** jsdom plus a stub Supabase client and stub function responses. This layer owns Properties 26 through 34, 37, and the output-safety properties.

**4. Integration tests against sandbox.** One-to-three examples each, run on demand rather than in the default suite: HitPay sandbox payment creation, a real webhook delivery, OTP email delivery through SMTP, Storage signed-URL expiry, and the material upload path.

**5. Smoke checks.** RLS enabled per table, the policy enumeration equality check, seeded settings rows, private-bucket refusal of an unsigned fetch, the secret scan over the built front end and the repository, the absence of the WebGL hero script, and the v1-copy absence scan.

### Property test configuration

- Each correctness property is implemented as **exactly one** property-based test.
- Minimum **100 iterations** per property (`fc.assert(..., { numRuns: 100 })`); the money and answer-key properties (1, 3, 13, 14, 15, 17, 18, 22) run at 500 because their failure cost is highest.
- Every property test carries a tag comment naming the feature, the property number, and the property text:

```js
// Feature: platform-v2, Property 15: Fulfilment is idempotent under any delivery sequence
```

- A failing run's counterexample is recorded verbatim in the task list rather than paraphrased, so shrunk inputs are reproducible.

### Generators worth building once

Shared generators live in `tests/generators.js`, because most properties need the same shapes:

- `arbQuiz` — question counts 0–30, option counts 2–4, unicode text, blank and populated explanations, a `correct_key` always present in `options`.
- `arbSubmission(quiz)` — complete, partial, empty, and out-of-options answer maps.
- `arbCatalog` — products and quizzes with random `published`, `sort_order` (including ties and negatives), prices, and titles containing markup.
- `arbQueryShape` — column subsets, filters, orderings, limits, and embed paths, used to attack `questions`.
- `arbTokenVariant` — absent, malformed, expired, unsigned, foreign-issuer, and missing-claim tokens.
- `arbWebhookDelivery` — payload plus outcome kind, amount delta around the stored amount, currency spelling and casing, and a delivery schedule for sequential or overlapping replay.
- `arbLedger` — referral rows across all three statuses with arbitrary amounts.

The overlapping-replay generator is the one that earns its keep: it produces interleavings that a hand-written duplicate-webhook test will not, and it is the only automated way to gain confidence in the `for update` lock.

### Unit and example tests, kept deliberately few

Example tests cover the single-branch behaviours the prework classified as EXAMPLE or EDGE_CASE — logout clearing the session, a 404 on an unpublished product, timer expiry submitting, HitPay timeout marking an order failed, each empty state's copy, the reduced-motion branch, responsive column counts at 480 px and 768 px, admin form round trips, and the admin revoke and void actions. They are one case each. The property tests already cover the input space; adding more examples on top of them buys coverage numbers rather than confidence.

### What is explicitly not property-tested

Supabase Auth's code generation and expiry, HitPay's API behaviour, Storage's signature enforcement, SMTP delivery, CSS and visual layout, and documentation content. These are either external services (where 100 iterations cost real quota and test someone else's code) or facts with no varying input.

### Named suites for the criteria that ask for a specific test

Several criteria name a test explicitly. These are the suites that satisfy them, each built on the property or example above rather than duplicating it:

| Suite | Asserts | Criterion |
| --- | --- | --- |
| `rls-policy-inventory` | Live policies and grants equal the declared inventory table | 5.4 |
| `rls-answer-key` | Zero rows for `questions` across all six named client cases, including as an enrolled user and via an embedded resource | 6.8 |
| `quiz-blank-submission` | A submission answering zero questions returns zero keys and zero explanations | 6.14 |
| `rls-cross-tenant` | Every A-reads-B pairing over five tables returns zero rows | 7.8 |
| `rls-writes` | A client insert into `enrollments` for the caller's own id is rejected | 8.6 |
| `rls-admin-flag` | Self-service `is_admin = true` rejected, `answer_reveal_mode` unreadable, unpublished products hidden | 9.10 |
| `edge-auth-negative` | 401 for absent, malformed, and expired tokens and 403 for a foreign resource, on all five gated functions, with zero row changes | 4.7 |
| `money-price-derivation` | A request carrying a lower amount, price, and currency still yields the stored price and `PHP` | 11.7 |
| `money-signature` | A well-formed completed-payment payload with an invalid signature changes zero rows | 14.6 |
| `money-amount-mismatch` | A mismatch grants nothing, leaves the order `pending`, and records exactly one incident | 15.10 |
| `money-idempotency` | Five sequential and five overlapping replays yield exactly one paid order, enrollment, and referral with `paid_at` unchanged | 16.7 |
| `money-refund` | Order `refunded`, enrollment gone, referral `void`, and a subsequent `get-quiz` returns 403 with zero questions | 17.13 |
| `quiz-answer-stripping` | The `get-quiz` body contains neither answer field | 19.6 |
| `referral-attribution` | A valid foreign code inserts one `available` row; the buyer's own code inserts zero | 23.9 |
| `admin-authorization` | A non-admin receives 403 from every `admin-*` function with target rows unchanged | 26.8 |
| `secrets-scan` | The deployed front-end files contain no configured secret variable name | 28.4 |
| `output-safety` | A product title containing markup renders as literal text | 29.4 |

`rls-policy-inventory` is the structural guard: if a later task adds a convenience policy to `questions` or widens a grant, that suite fails even when every functional test still passes.

### Definition of done for the test suite

- Every property above has one implemented property test, tagged, passing at its configured iteration count.
- The answer-key property (1) and the payload property (2) also run as regression guards in CI on every change, since they are the guarantees most likely to be broken by a future convenience.
- The policy enumeration check passes, meaning no policy exists that this design did not declare.
- The secret scan passes against the built front end.
- Sandbox integration tests pass once before the switch to live HitPay credentials.

## Requirements Traceability

| Design area | Requirements |
| --- | --- |
| Supabase Auth config, OTP front-end flow, resend timing | R1, R2 |
| `handle_new_user` trigger, `gen_ref_code`, `admin_bootstrap_emails` | R3, R26.1, R26.2 |
| `_shared/auth.ts`, `requireUser`, token-only identity | R4 |
| Grant baseline, policy matrix, `pg_policies` check | R5, R8 |
| No grant and no policy on `questions`; `get-quiz` strip assertion; reveal policy | R6, R19.3, R20.5 |
| Owner-scoped policies, `buyer_masked`, withheld `buyer_user_id` | R7 |
| Column-level update grant plus `guard_profile_columns`; published-only and `display_safe` policies | R9 |
| `js/catalog.js`, `js/product.js`, login gate with pending checkout | R10, R31 |
| `create-payment` price derivation, already-owned check | R11 |
| HitPay adapter, `HITPAY_API_BASE_URL`, checkout redirect, `enrolled.html` polling | R12, R13 |
| `verifyHitpaySignature`, raw-body HMAC, constant-time compare | R14 |
| `fulfil_payment` amount and currency cross-check, `payment_incidents`, `admin-incidents` | R15 |
| `fulfil_payment` single transaction, `for update` lock, unique constraints | R16 |
| `refund_payment`, enrollment delete, referral void | R17 |
| Private `materials` bucket, `issue-material-url`, 300 s expiry, withheld `material_path` | R18 |
| `get-quiz`, `pack_quizzes` resolution | R19 |
| `grade-quiz`, `quiz_attempts`, `answer_reveal_mode` | R20 |
| `js/quiz-runner.js` | R21 |
| `js/referral.js`, first-touch capture | R22 |
| Referral attribution block in `fulfil_payment`, `setting_*` readers | R23, R24 |
| `js/earnings.js`, `request-payout`, `payout_requests`, `admin-referrals` | R25 |
| `requireAdmin`, `admin-users` | R26 |
| `admin.html`, `js/admin/*`, the `admin-*` function set | R27 |
| Env-only secrets, `config.js` contents, scrubber, secret scan | R28 |
| `js/dom.js` with no `html` option, `setAttr` scheme check | R29 |
| Free-tier choices, custom SMTP, docs notes | R30 |
| Account menu, My Learning | R31 |
| Static hero, 8 px system, responsive card grid, no build step | R32 |
| `js/states.js`, `js/api.js` status mapping | R33 |
| Copy rewrite across pages and docs, v1-phrase absence scan | R34 |
| Export script, importer mapping table, idempotent inserts, bucket upload, retained `apps-script/` | R35 |
| SETUP, ADMIN_GUIDE, README updates | R36 |
