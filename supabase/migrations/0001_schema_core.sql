-- 0001_schema_core.sql
-- Platform v2 core schema: enum types, profiles, admin bootstrap list, and the
-- catalog tables (products, quizzes, pack_quizzes, questions).
--
-- Grants and RLS are deliberately NOT in this file. The revoke-first baseline,
-- the questions lockdown, and every policy live in the 0005-0010 migrations.
-- Triggers and helper functions live in 0003.
--
-- Requirements: 3.3, 9.8, 26.1, 27.11, 35.1, 35.2, 35.3

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------
-- Statuses are enums rather than text-with-check so an invalid value cannot be
-- written even by the service role.

create type product_type      as enum ('material', 'quiz_pack');
create type order_status      as enum ('pending', 'paid', 'failed', 'refunded');
create type enrollment_source as enum ('purchase', 'comp', 'credit');
create type referral_status   as enum ('available', 'paid', 'void');
create type reward_type       as enum ('cash', 'credit');
create type incident_kind     as enum ('amount_mismatch', 'currency_mismatch',
                                       'unmatched_payment', 'unmatched_refund',
                                       'out_of_order_status', 'self_referral');

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- One row per auth.users row, inserted by the on_auth_user_created trigger
-- (migration 0003). Requirement 3.3: ref_code uniqueness is a constraint, not a
-- convention.

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

comment on column public.profiles.is_admin is
  'Set by handle_new_user() from admin_bootstrap_emails. Never writable by a client role: see the column-level update grant and guard_profile_columns().';

-- ---------------------------------------------------------------------------
-- admin_bootstrap_emails
-- ---------------------------------------------------------------------------
-- Requirement 26.1. Admin bootstrap is data, not a hardcoded list inside the
-- trigger, so appointing an admin before their first login is a service-role
-- insert rather than a migration edit. Service-role only: no grants, no
-- policies (migrations 0005 and 0009).

create table public.admin_bootstrap_emails (
  email text primary key
);

insert into public.admin_bootstrap_emails (email)
values ('rehinaneel@gmail.com'), ('nairutya.84@gmail.com')
on conflict (email) do nothing;

-- Requirement 26.1 for profiles that already exist when this migration runs.
-- A no-op on a fresh database; the trigger in 0003 covers rows created later.
update public.profiles p
set is_admin = true
where exists (
  select 1 from public.admin_bootstrap_emails b
  where b.email = lower(p.email)
) and p.is_admin = false;

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
-- Requirement 27.11: price_php is a positive integer, slug is unique, and type
-- is constrained by the enum, so an invalid product save fails at the database
-- even if the Admin_Function validation is bypassed.
-- Requirement 35.1: the seed import maps v1 'material'/'quiz' onto
-- 'material'/'quiz_pack' and preserves title, subject, description, price, and
-- sort order.
-- material_path is never granted to a client role (migration 0008);
-- thumbnail_path is, because thumbnails live in a separate public bucket.

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

comment on column public.products.material_path is
  'Object path in the private Materials_Bucket. Withheld from the anon/authenticated select grant so the browser never learns the object layout.';

-- Supports the published-only catalog read ordered by sort_order.
create index products_published_sort_idx on public.products (published, sort_order);

-- ---------------------------------------------------------------------------
-- quizzes
-- ---------------------------------------------------------------------------
-- Requirement 9.8: metadata only. Question content lives in public.questions,
-- which no client role can reach at all.
-- Requirement 35.2: one row per distinct v1 quiz_id, preserving title, subject,
-- and timer_minutes.

create table public.quizzes (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  title         text not null,
  subject       text,
  timer_minutes integer not null default 0 check (timer_minutes >= 0),
  published     boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- pack_quizzes
-- ---------------------------------------------------------------------------
-- Maps quiz-pack products to the quizzes they unlock. Visibility follows the
-- parent product's published flag (policy in migration 0008).

create table public.pack_quizzes (
  product_id uuid not null references public.products(id) on delete cascade,
  quiz_id    uuid not null references public.quizzes(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (product_id, quiz_id)
);

-- ---------------------------------------------------------------------------
-- questions
-- ---------------------------------------------------------------------------
-- Requirement 35.3: one row per v1 question, preserving text, options, the
-- correct option as correct_key, and the explanation.
-- The answer-key guarantee (Requirement 6) is enforced in migration 0006 by
-- granting nothing to anon/authenticated and defining zero policies. Do not add
-- a client grant or policy here.

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

comment on table public.questions is
  'Answer keys. Reachable only by service_role. No anon/authenticated grant and no RLS policy may ever be added: see migration 0006.';
