-- 0022_fn_v2_payouts_jobs.sql
-- Payouts (BACKEND_RULES.md §7), the pg_cron schedule for the SQL-only jobs
-- (§4, §5, §8), and the final EXECUTE lockdown for every v2 routine.

-- ---------------------------------------------------------------------------
-- Payouts: the request and its negative ledger row commit together, which
-- locks the amount; the buyer row lock makes a double click a no-op.
-- ---------------------------------------------------------------------------
create or replace function public.request_payout(p_uid uuid) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p       public.profiles;
  v_balance integer;
  v_min     integer := public.setting_int('payout_threshold', 100);
  v_id      uuid;
begin
  select * into v_p from public.profiles where id = p_uid for update;
  if not found then
    raise exception 'PROFILE_NOT_FOUND';
  end if;
  if v_p.mobile is null then
    raise exception 'MOBILE_REQUIRED';
  end if;
  if exists (select 1 from public.payouts where user_id = p_uid and status = 'requested') then
    raise exception 'PAYOUT_PENDING';
  end if;
  v_balance := public.balance_of(p_uid);
  if v_balance < v_min then
    raise exception 'BELOW_THRESHOLD';
  end if;

  insert into public.payouts (user_id, amount_php, mobile)
  values (p_uid, v_balance, v_p.mobile)
  returning id into v_id;
  insert into public.balance_ledger (user_id, amount_php, source, ref_id)
  values (p_uid, -v_balance, 'payout', v_id);
  update public.referrals set status = 'redeemed', redeemed_at = now()
   where referrer_user_id = p_uid and status = 'available';

  perform public.enqueue_email('E11', v_p.email,
    jsonb_build_object('name', v_p.display_name, 'amount', v_balance, 'mobile', v_p.mobile),
    'E11:' || v_id);
  perform public.write_audit(p_uid, 'referrals', 'payout_requested', v_p.ref_code,
                             jsonb_build_object('amount', v_balance, 'payout_id', v_id));
  return jsonb_build_object('ok', true, 'payout_id', v_id, 'amount', v_balance);
end $$;

create or replace function public.mark_payout_sent(
  p_payout_id uuid, p_admin uuid, p_gcash_ref text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.payouts;
  v_p  public.profiles;
begin
  if nullif(btrim(coalesce(p_gcash_ref, '')), '') is null then
    raise exception 'GCASH_REF_REQUIRED';
  end if;
  update public.payouts
     set status = 'sent', gcash_ref = btrim(p_gcash_ref), sent_at = now(), handled_by = p_admin
   where id = p_payout_id and status = 'requested'
  returning * into v_po;
  if not found then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;
  select * into v_p from public.profiles where id = v_po.user_id;
  perform public.enqueue_email('E7', v_p.email,
    jsonb_build_object('name', v_p.display_name, 'amount', v_po.amount_php,
                       'mobile', v_po.mobile, 'gcash_ref', v_po.gcash_ref),
    'E7:' || v_po.id);
  perform public.write_audit(p_admin, 'referrals', 'payout_sent', v_p.ref_code,
    jsonb_build_object('amount', v_po.amount_php, 'gcash_ref', v_po.gcash_ref));
  return jsonb_build_object('ok', true, 'noop', false);
end $$;

-- A payout that failed (wrong number) goes back on the balance.
create or replace function public.reverse_payout(
  p_payout_id uuid, p_admin uuid, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.payouts;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;
  update public.payouts
     set status = 'reversed', notes = btrim(p_reason), handled_by = p_admin
   where id = p_payout_id and status in ('requested','sent')
  returning * into v_po;
  if not found then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;
  insert into public.balance_ledger (user_id, amount_php, source, ref_id, note, created_by)
  values (v_po.user_id, v_po.amount_php, 'payout_reversal', v_po.id, btrim(p_reason), p_admin);
  perform public.write_audit(p_admin, 'referrals', 'payout_reversed',
    (select ref_code from public.profiles where id = v_po.user_id),
    jsonb_build_object('amount', v_po.amount_php, 'reason', btrim(p_reason)));
  return jsonb_build_object('ok', true, 'noop', false);
end $$;

-- ---------------------------------------------------------------------------
-- pg_cron. Reconciliation with PayMongo and the outbox sender need HTTP and
-- are scheduled from the Edge Functions phase. Without pg_cron (some local
-- stacks) the schedule is skipped and the jobs can be run by hand.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pg_cron with schema pg_catalog;
  exception when others then
    raise notice 'pg_cron not available (%); jobs not scheduled', sqlerrm;
    return;
  end;
  perform cron.schedule('arkiprep-auto-submit',     '* * * * *',    'select public.auto_submit_due()');
  perform cron.schedule('arkiprep-expire-orders',   '* * * * *',    'select public.expire_orders()');
  perform cron.schedule('arkiprep-stale-sessions',  '*/5 * * * *',  'select public.end_stale_sessions()');
  perform cron.schedule('arkiprep-deposit-sla',     '*/15 * * * *', 'select public.deposit_sla_reminders()');
  -- 00:05 Asia/Manila
  perform cron.schedule('arkiprep-expire-enrollments', '5 16 * * *', 'select public.expire_enrollments()');
exception when others then
  raise notice 'pg_cron scheduling skipped: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- EXECUTE lockdown: every routine in public is service-role only, except the
-- public leaderboard.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.leaderboard(uuid, integer) to anon, authenticated;
