-- 0013_v2_ops.sql
-- v2 foundations (BACKEND_RULES.md §0, §11, §12): the extra settings keys,
-- small helpers the later v2 functions share, the append-only audit_log and
-- the email outbox.

-- ---------------------------------------------------------------------------
-- Settings keys (§11). Existing rows keep their values; the brand moves from
-- ArchPrep PH to ArkiPrep only where the old default is still in place.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, display_safe) values
  ('reward_hold_days',     '0',          true),
  ('ref_ttl_days',         '30',         true),
  ('exam_date',            '2027-01-25', true),
  ('quiz_attempts',        '2',          true),
  ('session_idle_min',     '30',         true),
  ('leaderboard_mode',     'public',     true),
  ('bank_bdo',             '',           true),
  ('bank_bpi',             '',           true),
  ('bank_metrobank',       '',           true),
  ('bank_unionbank',       '',           true),
  ('bank_landbank',        '',           true),
  ('bank_account_name',    'ArkiPrep',   true),
  ('bank_sla_hours',       '24',         true),
  ('order_ttl_online_min', '60',         true),
  ('order_ttl_bank_h',     '48',         true)
on conflict (key) do nothing;

update public.settings set value = 'ArkiPrep', updated_at = now()
 where key = 'brand_name' and value = 'ArchPrep PH';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Integer setting with a fallback when the row is missing or malformed.
create or replace function public.setting_int(p_key text, p_default integer)
returns integer
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case when btrim(value) ~ '^-?[0-9]{1,9}$' then btrim(value)::integer end
       from public.settings where key = p_key),
    p_default);
$$;

-- Access for exam_date products ends when the ALE day ends in Manila.
create or replace function public.exam_date_ts() returns timestamptz
language sql stable
set search_path = public, pg_temp
as $$
  select case when btrim(value) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              then ((btrim(value)::date + 1)::timestamp at time zone 'Asia/Manila') end
    from public.settings where key = 'exam_date';
$$;

-- ---------------------------------------------------------------------------
-- audit_log (§0.7): append-only for every role, the service role included.
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_email text,
  area        text not null check (area in ('payments','access','content','referrals','settings','auth','system')),
  action      text not null,
  target      text,
  details     jsonb not null default '{}'::jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);

create or replace function public.audit_log_append_only() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;

create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_log_append_only();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_log_append_only();

-- p_actor null = system.
create or replace function public.write_audit(
  p_actor uuid, p_area text, p_action text, p_target text, p_details jsonb default '{}'::jsonb
) returns void
language sql
set search_path = public, pg_temp
as $$
  insert into public.audit_log (actor_id, actor_email, area, action, target, details)
  values (p_actor,
          coalesce((select email from public.profiles where id = p_actor), 'system'),
          p_area, p_action, p_target, coalesce(p_details, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- outbox (§0.6, §12): emails are queued inside the money/access transaction
-- and sent after commit by the outbox worker. E1 (login code) is sent by
-- Supabase Auth itself; A1 is the admin alert for a new bank deposit.
-- ---------------------------------------------------------------------------
create table public.outbox (
  id          uuid primary key default gen_random_uuid(),
  template    text not null check (template ~ '^(E([2-9]|1[0-2])|A1)$'),
  to_email    text not null,
  payload     jsonb not null default '{}'::jsonb,
  dedupe_key  text unique,
  status      text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempts    integer not null default 0 check (attempts >= 0),
  last_error  text,
  send_after  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index outbox_due_idx on public.outbox (send_after) where status = 'pending';

create or replace function public.enqueue_email(
  p_template text, p_to text, p_payload jsonb, p_dedupe text default null
) returns void
language sql
set search_path = public, pg_temp
as $$
  insert into public.outbox (template, to_email, payload, dedupe_key)
  select p_template, p_to, coalesce(p_payload, '{}'::jsonb), p_dedupe
   where p_to is not null and btrim(p_to) <> ''
  on conflict (dedupe_key) do nothing;
$$;
