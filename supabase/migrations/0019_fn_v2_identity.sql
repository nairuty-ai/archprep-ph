-- 0019_fn_v2_identity.sql
-- Signup, OTP limits and the one-active-session rule (BACKEND_RULES.md §3, §7).
-- Every function here is service-role only: Edge Functions call them after
-- verifying the caller's token.

-- ---------------------------------------------------------------------------
-- complete_signup: first login = signup. Idempotent: a second call on a
-- completed profile is a no-op. The referral binds here, once (first touch),
-- and never to the user themselves, their email or their mobile.
-- ---------------------------------------------------------------------------
create or replace function public.complete_signup(
  p_uid          uuid,
  p_display_name text,
  p_mobile       text,
  p_consents     text[],
  p_version      text,
  p_ref_code     text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile  public.profiles;
  v_referrer public.profiles;
  v_name     text := btrim(coalesce(p_display_name, ''));
  v_mobile   text := regexp_replace(coalesce(p_mobile, ''), '[^0-9]', '', 'g');
  v_type     text;
begin
  select * into v_profile from public.profiles where id = p_uid for update;
  if not found then
    raise exception 'PROFILE_NOT_FOUND';
  end if;
  if v_profile.signup_completed_at is not null then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 40 then
    raise exception 'DISPLAY_NAME_INVALID';
  end if;
  if v_mobile ~ '^639[0-9]{9}$' then
    v_mobile := '0' || substr(v_mobile, 3);
  end if;
  if v_mobile !~ '^09[0-9]{9}$' then
    raise exception 'MOBILE_INVALID';
  end if;
  if not (p_consents @> array['terms_refund','privacy','public_leaderboard']) then
    raise exception 'CONSENT_REQUIRED';
  end if;

  update public.profiles
     set display_name = v_name, mobile = v_mobile, signup_completed_at = now()
   where id = p_uid;

  foreach v_type in array p_consents loop
    if v_type in ('terms_refund','privacy','public_leaderboard','marketing_email') then
      insert into public.consents (user_id, type, version)
      values (p_uid, v_type, coalesce(nullif(btrim(p_version), ''), 'v1'))
      on conflict do nothing;
    end if;
  end loop;

  if v_profile.referred_by is null and nullif(btrim(coalesce(p_ref_code, '')), '') is not null then
    select * into v_referrer from public.profiles where ref_code = upper(btrim(p_ref_code));
    if found
       and v_referrer.id <> p_uid
       and lower(v_referrer.email) <> lower(v_profile.email)
       and v_referrer.mobile is distinct from v_mobile then
      update public.profiles
         set referred_by = v_referrer.ref_code, referred_by_user_id = v_referrer.id
       where id = p_uid;
    end if;
  end if;

  perform public.write_audit(p_uid, 'auth', 'signup', v_profile.email,
                             jsonb_build_object('consents', p_consents));
  return jsonb_build_object('ok', true, 'already', false);
end $$;

-- ---------------------------------------------------------------------------
-- OTP limits: resend after 60s, max 5 sends/hour per email and per IP,
-- 5 wrong codes lock the email for 15 minutes.
-- ---------------------------------------------------------------------------
create or replace function public.otp_send_check(p_email text, p_ip text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := lower(btrim(p_email));
  v_locked timestamptz;
  v_last   timestamptz;
begin
  select locked_until into v_locked from public.auth_locks
   where email = v_email and locked_until > now();
  if found then
    return jsonb_build_object('ok', false, 'reason', 'locked',
      'retry_after_sec', ceil(extract(epoch from v_locked - now())));
  end if;

  select max(created_at) into v_last from public.auth_events
   where email = v_email and kind = 'otp_send';
  if v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'too_soon',
      'retry_after_sec', ceil(extract(epoch from v_last + interval '60 seconds' - now())));
  end if;

  if (select count(*) from public.auth_events
       where email = v_email and kind = 'otp_send' and created_at > now() - interval '1 hour') >= 5
  or (p_ip is not null and
      (select count(*) from public.auth_events
        where ip = p_ip and kind = 'otp_send' and created_at > now() - interval '1 hour') >= 5) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited', 'retry_after_sec', 3600);
  end if;

  insert into public.auth_events (kind, email, ip) values ('otp_send', v_email, p_ip);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.otp_verify_allowed(p_email text) returns boolean
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (select 1 from public.auth_locks
                      where email = lower(btrim(p_email)) and locked_until > now());
$$;

create or replace function public.otp_record_failure(p_email text, p_ip text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(p_email));
  v_fails integer;
begin
  insert into public.auth_events (kind, email, ip) values ('otp_fail', v_email, p_ip);
  select count(*) into v_fails from public.auth_events
   where email = v_email and kind = 'otp_fail' and created_at > now() - interval '15 minutes';
  if v_fails >= 5 then
    insert into public.auth_locks (email, locked_until)
    values (v_email, now() + interval '15 minutes')
    on conflict (email) do update set locked_until = excluded.locked_until;
    return jsonb_build_object('locked', true);
  end if;
  return jsonb_build_object('locked', false, 'remaining', 5 - v_fails);
end $$;

create or replace function public.otp_record_success(p_email text) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.auth_events where email = lower(btrim(p_email)) and kind = 'otp_fail';
$$;

-- ---------------------------------------------------------------------------
-- Sessions. Students idle out after session_idle_min (30), admins after 8h.
-- ---------------------------------------------------------------------------
create or replace function public.session_idle_limit(p_is_admin boolean) returns interval
language sql stable
set search_path = public, pg_temp
as $$
  select case when p_is_admin then interval '8 hours'
              else public.setting_int('session_idle_min', 30) * interval '1 minute' end;
$$;

create or replace function public.start_session(
  p_uid uuid, p_is_admin boolean, p_ua text, p_ip_city text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_other public.sessions;
  v_id    uuid;
begin
  update public.sessions
     set ended_at = now(), ended_reason = 'idle'
   where user_id = p_uid and ended_at is null
     and last_seen_at < now() - public.session_idle_limit(is_admin);

  select * into v_other from public.sessions where user_id = p_uid and ended_at is null;
  if found then
    return jsonb_build_object('ok', false, 'code', 'SESSION_ACTIVE',
      'other', jsonb_build_object('ua', v_other.ua, 'ip_city', v_other.ip_city,
                                  'last_seen_at', v_other.last_seen_at,
                                  'created_at', v_other.created_at));
  end if;

  begin
    insert into public.sessions (user_id, is_admin, ua, ip_city)
    values (p_uid, coalesce(p_is_admin, false), left(p_ua, 300), left(p_ip_city, 100))
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'SESSION_ACTIVE');
  end;
  return jsonb_build_object('ok', true, 'session_id', v_id);
end $$;

-- Heartbeat and per-request check. Returns false when the session is gone,
-- idle or belongs to someone else; an idle session is ended on the way.
create or replace function public.touch_session(p_uid uuid, p_session_id uuid) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s public.sessions;
begin
  select * into v_s from public.sessions
   where id = p_session_id and user_id = p_uid and ended_at is null
   for update;
  if not found then
    return false;
  end if;
  if v_s.last_seen_at < now() - public.session_idle_limit(v_s.is_admin) then
    update public.sessions set ended_at = now(), ended_reason = 'idle' where id = v_s.id;
    return false;
  end if;
  update public.sessions set last_seen_at = now() where id = v_s.id;
  return true;
end $$;

-- p_actor = the user (logout) or an admin (End session: audited + email E9).
create or replace function public.end_session(
  p_session_id uuid, p_actor uuid, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s     public.sessions;
  v_email text;
begin
  update public.sessions set ended_at = now(), ended_reason = p_reason
   where id = p_session_id and ended_at is null
  returning * into v_s;
  if not found then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;
  if p_reason = 'admin' then
    select email into v_email from public.profiles where id = v_s.user_id;
    perform public.write_audit(p_actor, 'access', 'session_ended', v_email,
                               jsonb_build_object('session_id', v_s.id, 'ua', v_s.ua));
    perform public.enqueue_email('E9', v_email,
      jsonb_build_object('name', (select display_name from public.profiles where id = v_s.user_id)),
      'E9:' || v_s.id);
  end if;
  return jsonb_build_object('ok', true, 'noop', false);
end $$;

create or replace function public.end_stale_sessions() returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with ended as (
    update public.sessions set ended_at = now(), ended_reason = 'idle'
     where ended_at is null and last_seen_at < now() - public.session_idle_limit(is_admin)
    returning 1)
  select count(*)::integer from ended;
$$;
