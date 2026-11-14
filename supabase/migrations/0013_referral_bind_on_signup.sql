-- ---------------------------------------------------------------------------
-- 0013 — bind a referral to the account at sign-up
-- ---------------------------------------------------------------------------
-- profiles.referred_by has existed since 0001 and is protected from client
-- writes by 0003 and 0007, but nothing ever populated it: a referral lived only
-- in the referred visitor's localStorage. That loses the referrer their credit
-- whenever the buyer finishes on a different browser or device from the one
-- that opened the link — signing up in an in-app browser and buying on a
-- laptop is the common case, not an edge case.
--
-- The code the visitor arrived with is carried into sign-up as user metadata
-- and written here, in the same insert that creates the profile. Capture stays
-- first-touch and 30-day in the browser; this is the durable copy.
--
-- The metadata is supplied by the client and is therefore untrusted. Two
-- guards apply, and both fail to null rather than raising, because a bad
-- referral must never block an account from being created:
--
--   * the code must match an existing profile, so a typo or a probe cannot
--     violate the foreign key on profiles(ref_code);
--   * self-referral cannot arise here — the new row's own ref_code is
--     generated in this same statement and does not yet exist to be claimed.
--
-- fulfil_payment still re-checks self-referral and unknown codes at payment
-- time (0011), so this is an additional binding, not a replacement for it.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ref text;
begin
  v_ref := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'ref_code', '')), '');

  -- An unknown code is discarded rather than stored: the foreign key would
  -- refuse it, and refusing it here keeps account creation working.
  if v_ref is not null
     and not exists (select 1 from public.profiles where ref_code = v_ref) then
    v_ref := null;
  end if;

  insert into public.profiles (id, email, ref_code, is_admin, referred_by)
  values (
    new.id,
    new.email,
    public.gen_ref_code(),
    exists (
      select 1 from public.admin_bootstrap_emails
      where email = lower(new.email)
    ),
    v_ref
  )
  on conflict (id) do nothing;

  return new;
end
$function$;

comment on function public.handle_new_user() is
  'Creates the profile row for a new auth user. Also binds the referral code '
  'carried in sign-up metadata to profiles.referred_by, after checking it '
  'names a real referrer; an unknown code is stored as null so account '
  'creation never fails on a bad referral.';
