-- 0015_v2_identity.sql
-- v2 identity (BACKEND_RULES.md §3, §7):
--   admins    server-side allowlist by email; replaces profiles.is_admin and
--             admin_bootstrap_emails
--   profiles  required mobile (PH 09XXXXXXXXX, not OTP-verified), signup
--             completion, referral bound at signup
--   consents  terms_refund, privacy, public_leaderboard, marketing_email
--   sessions  one active session per account
--   auth_events / auth_locks  OTP send and wrong-code limits

-- ---------------------------------------------------------------------------
-- admins
-- ---------------------------------------------------------------------------
create table public.admins (
  email      text primary key check (email = lower(btrim(email))),
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

insert into public.admins (email)
select lower(btrim(email)) from public.admin_bootstrap_emails
union
select lower(btrim(email)) from public.profiles where is_admin
on conflict (email) do nothing;

create or replace function public.is_admin(p_uid uuid) returns boolean
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
      join public.admins a on a.email = lower(btrim(p.email))
     where p.id = p_uid);
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
alter table public.profiles rename column gcash_number to mobile;

update public.profiles set mobile = case
    when regexp_replace(mobile, '[^0-9]', '', 'g') ~ '^(63|0)?9[0-9]{9}$'
    then '0' || right(regexp_replace(mobile, '[^0-9]', '', 'g'), 10)
  end
 where mobile is not null;

alter table public.profiles
  add constraint profiles_mobile_check check (mobile is null or mobile ~ '^09[0-9]{9}$'),
  add column signup_completed_at timestamptz,
  add column referred_by_user_id uuid references public.profiles(id) on delete set null;

update public.profiles p set referred_by_user_id = r.id
  from public.profiles r
 where r.ref_code = p.referred_by and r.id <> p.id;

update public.profiles set signup_completed_at = created_at
 where display_name is not null and btrim(display_name) <> '' and mobile is not null;

alter table public.profiles drop column is_admin;
drop table public.admin_bootstrap_emails;

create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, ref_code)
  values (new.id, new.email, public.gen_ref_code())
  on conflict (id) do nothing;
  return new;
end $$;

create or replace function public.guard_profile_columns() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and current_setting('role') <> 'service_role' then
    if new.ref_code            is distinct from old.ref_code
    or new.referred_by         is distinct from old.referred_by
    or new.referred_by_user_id is distinct from old.referred_by_user_id
    or new.signup_completed_at is distinct from old.signup_completed_at
    or new.email               is distinct from old.email
    or new.id                  is distinct from old.id then
      raise exception 'protected profile column' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- consents
-- ---------------------------------------------------------------------------
create table public.consents (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  type        text not null
              check (type in ('terms_refund','privacy','public_leaderboard','marketing_email')),
  version     text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, type, version)
);

-- ---------------------------------------------------------------------------
-- sessions: the partial unique index is what makes "one active session" hold
-- under concurrent logins.
-- ---------------------------------------------------------------------------
create table public.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at     timestamptz,
  ended_reason text check (ended_reason in ('logout','idle','admin','browser_closed')),
  ua           text,
  ip_city      text
);
create unique index sessions_one_active_key on public.sessions (user_id) where ended_at is null;
create index sessions_user_idx on public.sessions (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- OTP limits
-- ---------------------------------------------------------------------------
create table public.auth_events (
  id         bigserial primary key,
  kind       text not null check (kind in ('otp_send','otp_fail')),
  email      text not null,
  ip         text,
  created_at timestamptz not null default now()
);
create index auth_events_email_idx on public.auth_events (email, kind, created_at desc);
create index auth_events_ip_idx    on public.auth_events (ip, kind, created_at desc);

create table public.auth_locks (
  email        text primary key,
  locked_until timestamptz not null
);
