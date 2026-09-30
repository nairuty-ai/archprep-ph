-- 0002_schema_money.sql
-- Platform v2 money and access schema: orders, enrollments, quiz_attempts,
-- referrals, payment_incidents, payout_requests.
--
-- Depends on 0001_schema_core.sql for pgcrypto, the enum types
-- (order_status, enrollment_source, referral_status, reward_type,
-- incident_kind) and the profiles/products/quizzes tables. Those types are
-- reused here, never redeclared.
--
-- Grants and RLS are deliberately NOT in this file. The revoke-first baseline
-- and every policy live in the 0005-0010 migrations; fulfil_payment,
-- refund_payment and fail_payment live in 0011-0012.
--
-- Requirements: 16.1, 15.8, 25.7

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
-- amount_php is numeric(12,2), not integer: HitPay reports decimal amounts and
-- Requirement 15.1 compares at 2-decimal-place precision, so the stored value
-- has to hold two decimals to be comparable with zero tolerance. The integer
-- products.price_php widens losslessly into it (Requirement 15.5: the compared
-- value comes from the database, never from the payload).
--
-- on delete restrict on both references: an order is a financial record, so
-- deleting a buyer or a product must not silently erase it.
--
-- currency carries no check constraint here, matching the design. Orders record
-- what was charged, and Requirement 15.2 compares the reported currency against
-- this stored value at webhook time rather than constraining it at write time.

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

comment on column public.orders.amount_php is
  'Written by the Create_Payment_Function from products.price_php at order creation. Requirement 15.5: no part of the webhook cross-check value may come from the payload.';

-- Requirement 16.1: unique over non-null payment ids only, so many pending
-- orders may coexist before HitPay assigns an id. A plain unique constraint
-- would work in Postgres (nulls are distinct) but a partial index states the
-- intent and keeps the index off the pending rows.
create unique index orders_hitpay_payment_id_key
  on public.orders (hitpay_payment_id)
  where hitpay_payment_id is not null;

-- Supports the buyer's own order history and the enrolled-confirmation poll.
create index orders_user_idx on public.orders (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- enrollments
-- ---------------------------------------------------------------------------
-- Requirement 16.1: unique (user_id, product_id) is what makes replayed
-- fulfilment idempotent at the database level, so `on conflict do nothing` in
-- fulfil_payment is a guarantee rather than a hope.
--
-- Revoking an enrollment deletes the row (design decision), which keeps this a
-- plain constraint rather than a partial index and lets a refunded buyer
-- purchase the same product again later.
--
-- order_id is nullable with on delete set null: comp and credit enrollments
-- have no order behind them.

create table public.enrollments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  source     enrollment_source not null,
  order_id   uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint enrollments_user_product_key unique (user_id, product_id)
);

comment on constraint enrollments_user_product_key on public.enrollments is
  'Requirement 16.1. Database-level idempotency for fulfilment: at most one enrollment per user per product, however many times a webhook is replayed.';

-- ---------------------------------------------------------------------------
-- quiz_attempts
-- ---------------------------------------------------------------------------
-- score and total are computed by grade-quiz from questions.correct_key with
-- the service role; any score, total, or correctness field in the request body
-- is ignored. Requirement 17.2 preserves these rows across a refund.

create table public.quiz_attempts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  quiz_id    uuid not null references public.quizzes(id) on delete cascade,
  score      integer not null check (score >= 0),
  total      integer not null check (total >= 0),
  answers    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- referrals
-- ---------------------------------------------------------------------------
-- Requirement 16.1: unique order_id is the exactly-once guarantee for referral
-- attribution under webhook replay.
--
-- buyer_masked is computed once by the service role at insert time
-- (juan****@gmail.com) so buyer_user_id can be withheld from the client grant
-- entirely (migration 0009) and the referrer never receives the buyer's
-- identity. product_title is denormalised so the ledger still renders after the
-- product is unpublished and therefore invisible to the referrer's catalog read.
--
-- referrals_no_self makes the self-referral guard a database invariant, not
-- only a branch in the webhook.
--
-- amount_php allows 0 (>= 0) because a credit-mode or zero-configured reward is
-- still a valid ledger row; orders.amount_php stays strictly positive.

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

comment on column public.referrals.buyer_user_id is
  'Service-role only. Withheld from the column-level select grant in migration 0009; the ledger renders buyer_masked instead.';

-- Supports the earnings dashboard: available and paid balances per referrer.
create index referrals_referrer_idx on public.referrals (referrer_user_id, status);

-- ---------------------------------------------------------------------------
-- payment_incidents
-- ---------------------------------------------------------------------------
-- Requirement 15.8: the store behind every "record for admin review" clause.
-- Retains the reported amount, reported currency, reported payment identifier,
-- the stored amount and currency, and the recording time, associated with the
-- matching order where one exists, until an admin marks it resolved.
--
-- order_id is nullable: unmatched payments and unmatched refunds have no order
-- to point at, which is precisely why they are incidents.
--
-- payload holds the webhook body for forensics and can contain payer details,
-- so this table gets zero grants and zero policies (migrations 0005 and 0009);
-- the admin portal reads it through admin-incidents, never through PostgREST.

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

comment on table public.payment_incidents is
  'Requirement 15.8. Service-role only: payload may contain payer details. No anon/authenticated grant and no policy may be added.';

-- Supports the admin review list: unresolved incidents, newest first, paged at 50.
create index payment_incidents_open_idx
  on public.payment_incidents (created_at desc) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- payout_requests
-- ---------------------------------------------------------------------------
-- Requirement 25.7: request-payout recomputes the available balance from
-- referrals server-side and inserts exactly one row here with the supplied
-- GCash number. amount_php > 0 so a zero-balance request cannot be recorded.
-- status is text-with-check rather than an enum because it is a workflow label
-- the admin portal owns, not a value any money path branches on.

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
