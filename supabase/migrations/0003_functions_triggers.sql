-- 0003_functions_triggers.sql
-- Platform v2 provisioning functions and triggers:
--   gen_ref_code()          unambiguous referral code with collision retry
--   handle_new_user()       one profiles row per auth.users row, admin bootstrap
--   on_auth_user_created    the auth.users trigger that calls it
--   mask_email()            buyer mask stored on referrals.buyer_masked
--   guard_profile_columns() + profiles_guard_columns trigger
--
-- Depends on 0001_schema_core.sql for public.profiles and
-- public.admin_bootstrap_emails.
--
-- Grants and RLS are deliberately NOT in this file. The revoke-first baseline
-- (migration 0005) revokes execute on every function in schema public from
-- anon and authenticated; none of the functions here needs a client grant,
-- because Postgres checks EXECUTE on a trigger function when the trigger is
-- created, not each time it fires. mask_email() is called by the service role
-- from inside fulfil_payment (migration 0011), which is SECURITY DEFINER.
--
-- Requirements: 3.1, 3.2, 3.4, 9.2, 9.3, 26.2, 7.7

-- ---------------------------------------------------------------------------
-- gen_ref_code
-- ---------------------------------------------------------------------------
-- Requirement 3.2: ref_code is unique across profiles.
-- Requirement 3.4: on collision the function generates a replacement and the
-- insert completes, so uniqueness does not depend on the constraint raising.
--
-- The alphabet omits I, O, 0 and 1 so a code survives being read aloud or
-- hand-typed. 32 symbols over 8 positions is ~1.1e12 codes, so the retry loop
-- is a correctness guarantee rather than a hot path.

create or replace function public.gen_ref_code() returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
begin
  loop
    candidate := '';
    for i in 1..8 loop
      candidate := candidate
        || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (
      select 1 from public.profiles where ref_code = candidate
    );
  end loop;
  return candidate;
end $$;

comment on function public.gen_ref_code() is
  'Requirement 3.4. Generates an 8-character referral code over the unambiguous alphabet and retries until it does not collide with an existing profiles.ref_code.';

-- ---------------------------------------------------------------------------
-- handle_new_user
-- ---------------------------------------------------------------------------
-- Requirement 3.1: one profiles row per auth.users insert, by way of a trigger.
-- Requirement 3.2: email copied from auth.users, ref_code unique.
-- Requirement 26.2: is_admin is true exactly when the address is in
-- admin_bootstrap_emails, which is data rather than a list inside this body, so
-- appointing an admin before their first login is a service-role insert.
--
-- SECURITY DEFINER because the trigger fires as the auth admin role, which has
-- no privilege on public.profiles. search_path is pinned so a definer function
-- cannot be redirected at a shadowed table by the caller's search_path.
--
-- Bootstrap addresses are stored lower-case in 0001, so the comparison
-- lower-cases the incoming address rather than trusting its case.
--
-- on conflict (id) do nothing keeps a re-inserted or replayed auth row from
-- raising, which would otherwise fail the signup itself.

create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, ref_code, is_admin)
  values (
    new.id,
    new.email,
    public.gen_ref_code(),
    exists (
      select 1 from public.admin_bootstrap_emails
      where email = lower(new.email)
    )
  )
  on conflict (id) do nothing;
  return new;
end $$;

comment on function public.handle_new_user() is
  'Requirements 3.1, 3.2, 26.2. Inserts the profiles row for a new auth.users row and sets is_admin from admin_bootstrap_emails.';

-- No drop-if-exists guard here: auth.users is owned by the auth admin role, and
-- DROP TRIGGER requires ownership of the table while CREATE TRIGGER needs only
-- the TRIGGER privilege. The migration ledger applies this file once.

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- mask_email
-- ---------------------------------------------------------------------------
-- Requirement 7.7: the referrer sees the buyer in masked form. The mask is
-- computed once by the service role at insert time and stored in
-- referrals.buyer_masked, so buyer_user_id can be withheld from the client
-- grant entirely (migration 0009) and the raw identity never reaches the
-- browser at all.
--
-- Shape, per the design: up to the first four characters of the local part,
-- four mask characters, then the domain -> juan****@gmail.com with U+2022
-- bullets. The bullets are produced with chr(8226) so this file stays pure
-- ASCII and cannot be corrupted by a re-encode; the value stored is the bullet
-- character itself. A local part shorter than four characters is shown in full,
-- which is the same amount of information the mask shape already implies.
--
-- Anything that is not recognisably an address (null, blank, no '@', nothing
-- before the '@', nothing after it) masks to '***' rather than to null, because
-- referrals.buyer_masked is not null.

create or replace function public.mask_email(p_email text) returns text
language plpgsql
immutable
as $$
declare
  v_input  text := btrim(coalesce(p_email, ''));
  v_at     int;
  v_local  text;
  v_domain text;
begin
  v_at := position('@' in v_input);
  if v_at < 2 then
    return '***';
  end if;

  v_local  := left(v_input, v_at - 1);
  v_domain := substr(v_input, v_at + 1);

  if v_domain = '' then
    return '***';
  end if;

  return left(v_local, 4) || repeat(chr(8226), 4) || '@' || v_domain;
end $$;

comment on function public.mask_email(text) is
  'Requirement 7.7. Buyer mask stored on referrals.buyer_masked: up to four characters of the local part, four bullet characters, then the domain.';

-- ---------------------------------------------------------------------------
-- guard_profile_columns
-- ---------------------------------------------------------------------------
-- Requirements 9.2 and 9.3 are enforced first by the column-level update grant
-- in migration 0007, which permits display_name and gcash_number only. An
-- attempt to set is_admin is rejected with "permission denied for column
-- is_admin" before any policy runs.
--
-- This trigger is defence in depth behind that grant: if the grant were ever
-- widened, a client-side update of is_admin, ref_code, referred_by, email or id
-- would still be rejected, here with SQLSTATE 42501 (insufficient_privilege) so
-- the client sees the same class of error either way.
--
-- The guard applies only when a request carries a user identity. auth.uid() is
-- null for the service role, so fulfil_payment, refund_payment and the admin
-- functions can still maintain these columns; the role check is a second
-- shortcut for the same case. Comparisons use IS DISTINCT FROM so a null-to-null
-- no-op update is not mistaken for a change.

create or replace function public.guard_profile_columns() returns trigger
language plpgsql
set search_path = public, pg_temp
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

comment on function public.guard_profile_columns() is
  'Requirements 9.2, 9.3. Defence in depth behind the column-level update grant on profiles: blocks a user-identified update of is_admin, ref_code, referred_by, email or id.';

drop trigger if exists profiles_guard_columns on public.profiles;

create trigger profiles_guard_columns
before update on public.profiles
for each row execute function public.guard_profile_columns();
