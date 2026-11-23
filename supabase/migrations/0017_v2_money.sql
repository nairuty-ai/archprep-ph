-- 0017_v2_money.sql
-- v2 money (BACKEND_RULES.md §4-§7, §10):
--   orders          AP-xxxxx order_no, price snapshot, coupon, referrer,
--                   access snapshot, method, PayMongo refs, expiry, new states
--   payment_events  webhook dedupe by provider_event_id
--   incidents       (was payment_incidents) + ticket numbers
--   issues          student payment reports
--   coupons / coupon_reservations  reserve -> use | release
--   bank_deposits   proof uploads and review
--   referrals       status available|redeemed|void, whole pesos
--   balance_ledger  one balance per user = sum of rows
--   payouts         (was payout_requests)
-- HitPay columns are dropped: PayMongo replaces HitPay.

-- The v1 payment functions read the columns replaced below; the v2 functions
-- (0020) replace them.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('fulfil_payment', 'refund_payment', 'fail_payment')
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- coupons (before orders, which reference them)
-- ---------------------------------------------------------------------------
create table public.coupons (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code = upper(btrim(code)) and code ~ '^[A-Z0-9_-]{3,32}$'),
  type           text not null check (type in ('percent','fixed')),
  value          integer not null check (value > 0 and (type <> 'percent' or value <= 100)),
  product_ids    uuid[],   -- null = every product
  usage_limit    integer check (usage_limit is null or usage_limit > 0),
  used_count     integer not null default 0 check (used_count >= 0),
  reserved_count integer not null default 0 check (reserved_count >= 0),
  starts_at      timestamptz,
  expires_at     timestamptz,
  active         boolean not null default true,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create sequence public.order_no_seq start 20001;

alter table public.orders add column order_no text;
with o as (select id, row_number() over (order by created_at, id) as rn from public.orders)
update public.orders set order_no = 'AP-' || (20000 + o.rn) from o where o.id = orders.id;
do $$ begin perform setval('public.order_no_seq', 20001 + (select count(*) from public.orders), false); end $$;
alter table public.orders
  alter column order_no set default ('AP-' || nextval('public.order_no_seq')),
  alter column order_no set not null,
  add constraint orders_order_no_key unique (order_no);

alter table public.orders alter column status drop default;
alter table public.orders
  alter column status type text
  using (case status::text when 'pending' then 'awaiting_payment' else status::text end);
drop type public.order_status;
alter table public.orders
  alter column status set default 'created',
  add constraint orders_status_check check (status in (
    'created','awaiting_payment','awaiting_proof','pending_approval',
    'on_hold','paid','failed','expired','refunded'));

alter table public.orders
  add column price_php           integer,
  add column discount_php        integer not null default 0 check (discount_php >= 0),
  add column coupon_id           uuid references public.coupons(id) on delete restrict,
  add column total_php           integer,
  add column referrer_user_id    uuid references public.profiles(id) on delete set null,
  add column access_snapshot     jsonb not null default '{}'::jsonb,
  add column method              text check (method in ('gcash','maya','qrph','bank')),
  add column provider_ref        text,
  add column provider_payment_id text,
  add column checkout_url        text,
  add column expires_at          timestamptz,
  add column terms_accepted_at   timestamptz,
  add column refunded_at         timestamptz,
  add column updated_at          timestamptz not null default now();

update public.orders o set
  price_php        = round(o.amount_php)::integer,
  total_php        = round(o.amount_php)::integer,
  provider_ref     = o.hitpay_payment_id,
  referrer_user_id = (select r.id from public.profiles r
                       where r.ref_code = o.ref_code and r.id <> o.user_id),
  access_snapshot  = (select jsonb_build_object(
                        'type', p.type, 'title', p.title, 'access_mode', p.access_mode,
                        'attempts', p.attempts_per_purchase)
                        from public.products p where p.id = o.product_id);

alter table public.orders
  drop column amount_php,
  drop column hitpay_payment_id,
  drop column hitpay_reference,
  alter column price_php set not null,
  alter column total_php set not null,
  add constraint orders_amounts_check
    check (price_php >= 0 and total_php >= 0 and total_php = price_php - discount_php);

create unique index orders_provider_ref_key on public.orders (provider_ref) where provider_ref is not null;
create unique index orders_provider_payment_id_key on public.orders (provider_payment_id)
  where provider_payment_id is not null;
create index orders_status_idx on public.orders (status, created_at);

create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

create table public.coupon_reservations (
  order_id   uuid primary key references public.orders(id) on delete cascade,
  coupon_id  uuid not null references public.coupons(id) on delete restrict,
  status     text not null default 'reserved' check (status in ('reserved','used','released')),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- payment_events
-- ---------------------------------------------------------------------------
create table public.payment_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null default 'paymongo',
  provider_event_id text not null unique,
  type              text not null,
  order_id          uuid references public.orders(id) on delete set null,
  payload           jsonb not null,
  outcome           text,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz
);
create index payment_events_order_idx on public.payment_events (order_id);

-- ---------------------------------------------------------------------------
-- incidents (was payment_incidents) and issues share one INC-#### sequence
-- ---------------------------------------------------------------------------
create sequence public.ticket_no_seq start 401;

alter table public.payment_incidents rename to incidents;
alter table public.incidents alter column kind type text using kind::text;
drop type public.incident_kind;
alter table public.incidents
  add constraint incidents_kind_check check (kind in (
    'amount_mismatch','currency_mismatch','unmatched_payment','unmatched_refund',
    'out_of_order_status','self_referral','duplicate_payment'));
alter table public.incidents rename column hitpay_payment_id to provider_ref;
alter table public.incidents
  add column ticket_no text not null default ('INC-' || lpad(nextval('public.ticket_no_seq')::text, 4, '0')),
  add column notes text,
  add constraint incidents_ticket_no_key unique (ticket_no);

create table public.issues (
  id          uuid primary key default gen_random_uuid(),
  ticket_no   text not null unique default ('INC-' || lpad(nextval('public.ticket_no_seq')::text, 4, '0')),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  order_id    uuid not null references public.orders(id) on delete cascade,
  type        text not null check (type in ('not_unlocked','duplicate','failed_but_charged')),
  details     text,
  proof_path  text,
  status      text not null default 'open' check (status in ('open','resolved','refunded','rejected')),
  resolution  text,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index issues_status_idx on public.issues (status, created_at);

-- ---------------------------------------------------------------------------
-- bank_deposits
-- ---------------------------------------------------------------------------
create table public.bank_deposits (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  bank            text not null check (bank in ('bdo','bpi','metrobank','unionbank','landbank')),
  amount_received integer not null check (amount_received > 0),
  reference_no    text not null check (btrim(reference_no) <> ''),
  proof_path      text not null,
  proof_sha256    text not null check (proof_sha256 ~ '^[0-9a-f]{64}$'),
  status          text not null default 'pending_approval'
                  check (status in ('pending_approval','approved','rejected','superseded')),
  reject_reason   text,
  reviewed_by     uuid references public.profiles(id) on delete set null,
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now()
);
create unique index bank_deposits_one_pending_key on public.bank_deposits (order_id)
  where status = 'pending_approval';
create index bank_deposits_ref_idx on public.bank_deposits (bank, reference_no);
create index bank_deposits_sha_idx on public.bank_deposits (proof_sha256);

-- ---------------------------------------------------------------------------
-- referrals: available | redeemed | void, whole pesos
-- ---------------------------------------------------------------------------
alter table public.referrals alter column status drop default;
alter table public.referrals
  alter column status type text
  using (case status::text when 'paid' then 'redeemed' else status::text end);
drop type public.referral_status;
alter table public.referrals
  alter column status set default 'available',
  add constraint referrals_status_check check (status in ('available','redeemed','void')),
  alter column amount_php type integer using round(amount_php)::integer;
alter table public.referrals rename column paid_at to redeemed_at;
alter table public.referrals add column voided_at timestamptz;

-- ---------------------------------------------------------------------------
-- balance_ledger and payouts
-- ---------------------------------------------------------------------------
create table public.balance_ledger (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  amount_php integer not null check (amount_php <> 0),
  source     text not null
             check (source in ('referral','deposit_credit','payout','payout_reversal','adjustment')),
  ref_id     uuid,
  note       text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
-- Each referral, deposit credit, payout and reversal posts at most once.
create unique index balance_ledger_once_key on public.balance_ledger (source, ref_id)
  where ref_id is not null;
create index balance_ledger_user_idx on public.balance_ledger (user_id, created_at desc);

create table public.payouts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  amount_php   integer not null check (amount_php > 0),
  mobile       text not null,
  status       text not null default 'requested' check (status in ('requested','sent','reversed')),
  gcash_ref    text,
  requested_at timestamptz not null default now(),
  sent_at      timestamptz,
  handled_by   uuid references public.profiles(id) on delete set null,
  notes        text
);
create index payouts_status_idx on public.payouts (status, requested_at);

insert into public.payouts (id, user_id, amount_php, mobile, status, requested_at, sent_at, notes)
select id, user_id, round(amount_php)::integer, gcash_number,
       case status when 'paid' then 'sent' when 'rejected' then 'reversed' else 'requested' end,
       created_at, case when status = 'paid' then handled_at end, notes
  from public.payout_requests;

create unique index payouts_one_open_key on public.payouts (user_id) where status = 'requested';

-- Opening balances from v1 history.
insert into public.balance_ledger (user_id, amount_php, source, ref_id, created_at)
select referrer_user_id, amount_php, 'referral', id, created_at
  from public.referrals where status in ('available','redeemed') and amount_php > 0;
insert into public.balance_ledger (user_id, amount_php, source, ref_id, created_at)
select user_id, -amount_php, 'payout', id, requested_at from public.payouts;
insert into public.balance_ledger (user_id, amount_php, source, ref_id, created_at)
select user_id, amount_php, 'payout_reversal', id, requested_at
  from public.payouts where status = 'reversed';

drop table public.payout_requests;

create or replace function public.balance_of(p_uid uuid) returns integer
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(amount_php), 0)::integer from public.balance_ledger where user_id = p_uid;
$$;
