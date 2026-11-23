-- 0020_fn_v2_orders.sql
-- Orders, PayMongo events, bank deposits, refunds and admin access changes
-- (BACKEND_RULES.md §2, §4, §5, §6, §7, §10). Each function is one
-- transaction; status guards (WHERE status = 'expected') make retries,
-- double clicks, duplicate webhooks and two admins harmless. Errors raise a
-- short code (ALREADY_OWNED, COUPON_UNAVAILABLE, ...) that the Edge Function
-- maps to an HTTP response. fulfil_order is the only place that grants
-- access for an order.

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------
-- An active enrollment past its expiry or out of attempts no longer counts
-- as owned; end it so the partial unique index frees up for a re-buy.
create or replace function public.end_lapsed_enrollments(p_uid uuid, p_product_id uuid)
returns void
language sql
set search_path = public, pg_temp
as $$
  update public.enrollments
     set status = 'ended', ended_at = now()
   where user_id = p_uid and product_id = p_product_id and status = 'active'
     and ((expires_at is not null and expires_at <= now())
       or (attempts_allowed is not null and attempts_used >= attempts_allowed));
$$;

create or replace function public.release_coupon(p_order_id uuid) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_coupon uuid;
begin
  update public.coupon_reservations
     set status = 'released', updated_at = now()
   where order_id = p_order_id and status = 'reserved'
  returning coupon_id into v_coupon;
  if found then
    update public.coupons set reserved_count = greatest(reserved_count - 1, 0) where id = v_coupon;
  end if;
end $$;

create or replace function public.use_coupon(p_order_id uuid) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_res public.coupon_reservations;
begin
  select * into v_res from public.coupon_reservations where order_id = p_order_id for update;
  if not found or v_res.status = 'used' then
    return;
  end if;
  update public.coupons
     set used_count = used_count + 1,
         reserved_count = case when v_res.status = 'reserved'
                               then greatest(reserved_count - 1, 0) else reserved_count end
   where id = v_res.coupon_id;
  update public.coupon_reservations set status = 'used', updated_at = now()
   where order_id = p_order_id;
end $$;

create or replace function public.open_incident(
  p_kind text, p_order_id uuid, p_provider_ref text, p_reported numeric,
  p_currency text, p_stored numeric, p_payload jsonb
) returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ticket text;
begin
  insert into public.incidents
    (kind, order_id, provider_ref, reported_amount, reported_currency,
     stored_amount, stored_currency, payload)
  values (p_kind, p_order_id, p_provider_ref,
          case when p_reported is not null and p_reported <> 'NaN'::numeric
                and abs(p_reported) < 10000000000 then round(p_reported, 2) end,
          left(p_currency, 10), p_stored, case when p_stored is not null then 'PHP' end, p_payload)
  returning ticket_no into v_ticket;
  return v_ticket;
end $$;

-- ---------------------------------------------------------------------------
-- create_order (§4 create-payment steps 1-5). Step 6, the PayMongo checkout,
-- happens in the Edge Function after this commits, then attach_checkout.
-- ---------------------------------------------------------------------------
create or replace function public.create_order(
  p_uid            uuid,
  p_product_id     uuid,
  p_method         text,
  p_coupon_code    text,
  p_ref_code       text,
  p_terms_accepted boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_buyer      public.profiles;
  v_product    public.products;
  v_coupon     public.coupons;
  v_referrer   public.profiles;
  v_ref_id     uuid;
  v_discount   integer := 0;
  v_access_exp timestamptz;
  v_expires    timestamptz;
  v_open       record;
  v_order      public.orders;
begin
  if not coalesce(p_terms_accepted, false) then
    raise exception 'TERMS_REQUIRED';
  end if;
  if p_method is null or p_method not in ('gcash','maya','qrph','bank') then
    raise exception 'METHOD_INVALID';
  end if;

  -- Locking the buyer serialises double clicks from one account.
  select * into v_buyer from public.profiles where id = p_uid for update;
  if not found then
    raise exception 'PROFILE_NOT_FOUND';
  end if;
  if v_buyer.signup_completed_at is null then
    raise exception 'SIGNUP_INCOMPLETE';
  end if;

  select * into v_product from public.products where id = p_product_id and status = 'published';
  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  if v_product.type = 'free' then
    raise exception 'PRODUCT_IS_FREE';
  end if;

  perform public.end_lapsed_enrollments(p_uid, p_product_id);
  if exists (select 1 from public.enrollments
              where user_id = p_uid and product_id = p_product_id and status = 'active') then
    raise exception 'ALREADY_OWNED';
  end if;

  if v_product.access_mode = 'exam_date' then
    v_access_exp := public.exam_date_ts();
    if v_access_exp is null or v_access_exp <= now() then
      raise exception 'EXAM_DATE_NOT_SET';
    end if;
  end if;

  -- An abandoned checkout for the same product gives its coupon back.
  for v_open in
    select id from public.orders
     where user_id = p_uid and product_id = p_product_id
       and status in ('created','awaiting_payment','awaiting_proof')
     for update
  loop
    update public.orders set status = 'expired' where id = v_open.id;
    perform public.release_coupon(v_open.id);
  end loop;

  if nullif(btrim(coalesce(p_coupon_code, '')), '') is not null then
    select * into v_coupon from public.coupons
     where code = upper(btrim(p_coupon_code)) for update;
    if not found or not v_coupon.active
       or (v_coupon.starts_at is not null and v_coupon.starts_at > now())
       or (v_coupon.expires_at is not null and v_coupon.expires_at <= now()) then
      raise exception 'COUPON_INVALID';
    end if;
    if v_coupon.product_ids is not null and not (p_product_id = any (v_coupon.product_ids)) then
      raise exception 'COUPON_NOT_APPLICABLE';
    end if;
    -- Percent discounts round to the nearest peso (10% of 49 = 5).
    v_discount := case v_coupon.type
                    when 'percent' then round(v_product.price_php * v_coupon.value / 100.0)::integer
                    else v_coupon.value end;
    if v_product.price_php - v_discount < 1 then
      raise exception 'COUPON_TOTAL_TOO_LOW';
    end if;
    update public.coupons set reserved_count = reserved_count + 1
     where id = v_coupon.id
       and (usage_limit is null or used_count + reserved_count < usage_limit);
    if not found then
      raise exception 'COUPON_UNAVAILABLE';
    end if;
  end if;

  -- Referrer: the one bound at signup wins over a first-touch code. Self,
  -- same email and same mobile are dropped silently.
  v_ref_id := v_buyer.referred_by_user_id;
  if v_ref_id is null and nullif(btrim(coalesce(p_ref_code, '')), '') is not null then
    select id into v_ref_id from public.profiles where ref_code = upper(btrim(p_ref_code));
  end if;
  if v_ref_id is not null then
    select * into v_referrer from public.profiles where id = v_ref_id;
    if v_referrer.id = p_uid
       or lower(v_referrer.email) = lower(v_buyer.email)
       or (v_referrer.mobile is not null and v_referrer.mobile = v_buyer.mobile) then
      v_ref_id := null;
    end if;
  end if;

  v_expires := now() + case when p_method = 'bank'
                            then public.setting_int('order_ttl_bank_h', 48) * interval '1 hour'
                            else public.setting_int('order_ttl_online_min', 60) * interval '1 minute' end;

  insert into public.orders
    (user_id, product_id, status, price_php, discount_php, coupon_id, total_php,
     referrer_user_id, ref_code, access_snapshot, method, expires_at, terms_accepted_at)
  values
    (p_uid, p_product_id,
     case when p_method = 'bank' then 'awaiting_proof' else 'created' end,
     v_product.price_php, v_discount, v_coupon.id, v_product.price_php - v_discount,
     v_ref_id, nullif(upper(btrim(coalesce(p_ref_code, ''))), ''),
     jsonb_build_object('type', v_product.type, 'title', v_product.title,
                        'subject', v_product.subject, 'access_mode', v_product.access_mode,
                        'attempts', v_product.attempts_per_purchase, 'expires_at', v_access_exp),
     p_method, v_expires, now())
  returning * into v_order;

  if v_coupon.id is not null then
    insert into public.coupon_reservations (order_id, coupon_id) values (v_order.id, v_coupon.id);
  end if;

  return jsonb_build_object(
    'order_id', v_order.id, 'order_no', v_order.order_no, 'status', v_order.status,
    'price_php', v_order.price_php, 'discount_php', v_order.discount_php,
    'total_php', v_order.total_php, 'coupon_code', v_coupon.code,
    'expires_at', v_order.expires_at, 'product_title', v_product.title,
    'referred', v_ref_id is not null);
end $$;

create or replace function public.attach_checkout(
  p_order_id uuid, p_provider_ref text, p_checkout_url text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.orders
     set status = 'awaiting_payment', provider_ref = p_provider_ref, checkout_url = p_checkout_url
   where id = p_order_id and status = 'created';
  return found;
end $$;

-- ---------------------------------------------------------------------------
-- PayMongo webhook
-- ---------------------------------------------------------------------------
-- True when the event is new; a duplicate delivery returns false and the
-- webhook answers 200 without doing anything else.
create or replace function public.record_payment_event(
  p_event_id text, p_type text, p_payload jsonb, p_order_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.payment_events (provider_event_id, type, payload, order_id)
  values (p_event_id, p_type, p_payload, p_order_id)
  on conflict (provider_event_id) do nothing;
  return found;
end $$;

create or replace function public.finish_payment_event(p_event_id text, p_outcome text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.payment_events set processed_at = now(), outcome = p_outcome
   where provider_event_id = p_event_id;
$$;

-- payment.paid: amount or currency off -> on_hold + incident, never fulfil.
create or replace function public.apply_payment_paid(
  p_order_id            uuid,
  p_amount_php          numeric,
  p_currency            text,
  p_provider_payment_id text,
  p_payload             jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order  public.orders;
  v_ticket text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    v_ticket := public.open_incident('unmatched_payment', null, p_provider_payment_id,
                                     p_amount_php, p_currency, null, p_payload);
    return jsonb_build_object('outcome', 'unmatched', 'ticket', v_ticket);
  end if;

  if v_order.status = 'paid' then
    if v_order.provider_payment_id is not null
       and p_provider_payment_id is distinct from v_order.provider_payment_id then
      v_ticket := public.open_incident('duplicate_payment', v_order.id, p_provider_payment_id,
                                       p_amount_php, p_currency, v_order.total_php, p_payload);
      return jsonb_build_object('outcome', 'duplicate', 'ticket', v_ticket);
    end if;
    return jsonb_build_object('outcome', 'already_paid');
  end if;

  if v_order.status = 'refunded' then
    v_ticket := public.open_incident('out_of_order_status', v_order.id, p_provider_payment_id,
                                     p_amount_php, p_currency, v_order.total_php, p_payload);
    return jsonb_build_object('outcome', 'already_refunded', 'ticket', v_ticket);
  end if;

  update public.orders set provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id)
   where id = v_order.id;

  if p_currency is null or upper(btrim(p_currency)) <> 'PHP' then
    update public.orders set status = 'on_hold' where id = v_order.id;
    v_ticket := public.open_incident('currency_mismatch', v_order.id, p_provider_payment_id,
                                     p_amount_php, p_currency, v_order.total_php, p_payload);
    perform public.write_audit(null, 'payments', 'order_on_hold', v_order.order_no,
                               jsonb_build_object('ticket', v_ticket, 'currency', p_currency));
    return jsonb_build_object('outcome', 'currency_mismatch', 'ticket', v_ticket);
  end if;

  if p_amount_php is null or p_amount_php = 'NaN'::numeric
     or round(p_amount_php, 2) <> v_order.total_php then
    update public.orders set status = 'on_hold' where id = v_order.id;
    v_ticket := public.open_incident('amount_mismatch', v_order.id, p_provider_payment_id,
                                     p_amount_php, p_currency, v_order.total_php, p_payload);
    perform public.write_audit(null, 'payments', 'order_on_hold', v_order.order_no,
                               jsonb_build_object('ticket', v_ticket, 'reported', p_amount_php,
                                                  'expected', v_order.total_php));
    return jsonb_build_object('outcome', 'amount_mismatch', 'ticket', v_ticket);
  end if;

  return public.fulfil_order(v_order.id, null, 'PayMongo payment.paid');
end $$;

-- ---------------------------------------------------------------------------
-- fulfil_order (§4): paid -> enrollment from the snapshot -> coupon use ->
-- referral reward (unique per order) -> receipt email -> audit.
-- p_actor null = system (webhook, reconciliation); an admin needs a reason.
-- A paid order for a product the buyer already holds is a duplicate charge:
-- it is marked paid, no second enrollment, and an incident opens for refund.
-- ---------------------------------------------------------------------------
create or replace function public.fulfil_order(p_order_id uuid, p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.orders;
  v_buyer    public.profiles;
  v_referrer public.profiles;
  v_amount   integer;
  v_ref_row  uuid;
  v_dup      boolean := false;
  v_mode     text;
  v_ticket   text;
begin
  if p_actor is not null and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('outcome', 'already_paid', 'order_id', v_order.id);
  end if;
  if v_order.status = 'refunded' then
    raise exception 'ORDER_NOT_FULFILLABLE';
  end if;

  update public.orders set status = 'paid', paid_at = now() where id = v_order.id;
  select * into v_buyer from public.profiles where id = v_order.user_id;

  perform public.end_lapsed_enrollments(v_order.user_id, v_order.product_id);
  if exists (select 1 from public.enrollments
              where user_id = v_order.user_id and product_id = v_order.product_id
                and status = 'active') then
    v_dup := true;
    v_ticket := public.open_incident('duplicate_payment', v_order.id, v_order.provider_payment_id,
                                     v_order.total_php, 'PHP', v_order.total_php, null);
  else
    v_mode := coalesce(v_order.access_snapshot->>'access_mode', 'unlimited');
    insert into public.enrollments
      (user_id, product_id, source, order_id, access_mode, attempts_allowed, expires_at)
    values
      (v_order.user_id, v_order.product_id, 'purchase', v_order.id, v_mode,
       nullif(v_order.access_snapshot->>'attempts', '')::integer,
       case when v_mode = 'exam_date' then public.exam_date_ts() end);
  end if;

  perform public.use_coupon(v_order.id);

  if v_order.referrer_user_id is not null then
    v_amount := public.setting_int('referral_amount', 9);
    select * into v_referrer from public.profiles where id = v_order.referrer_user_id;
    if v_amount > 0 and found then
      insert into public.referrals
        (referrer_ref_code, referrer_user_id, buyer_user_id, buyer_masked, order_id,
         product_id, product_title, amount_php, reward_type, status)
      values
        (v_referrer.ref_code, v_referrer.id, v_order.user_id,
         coalesce(public.mask_email(v_buyer.email), '***'), v_order.id, v_order.product_id,
         coalesce(v_order.access_snapshot->>'title', 'Product'), v_amount,
         coalesce((select case when value in ('cash','credit') then value end
                     from public.settings where key = 'reward_type'), 'cash')::public.reward_type,
         'available')
      on conflict (order_id) do nothing
      returning id into v_ref_row;
      if v_ref_row is not null then
        insert into public.balance_ledger (user_id, amount_php, source, ref_id)
        values (v_referrer.id, v_amount, 'referral', v_ref_row);
        perform public.enqueue_email('E6', v_referrer.email,
          jsonb_build_object('name', v_referrer.display_name, 'amount', v_amount,
                             'product', v_order.access_snapshot->>'title',
                             'balance', public.balance_of(v_referrer.id),
                             'threshold', public.setting_int('payout_threshold', 100),
                             'ref_code', v_referrer.ref_code),
          'E6:' || v_ref_row);
      end if;
    end if;
  end if;

  if v_order.method is distinct from 'bank' then
    perform public.enqueue_email('E2', v_buyer.email,
      jsonb_build_object('name', v_buyer.display_name, 'order_no', v_order.order_no,
                         'product', v_order.access_snapshot->>'title',
                         'price', v_order.price_php, 'discount', v_order.discount_php,
                         'total', v_order.total_php, 'method', v_order.method,
                         'access', v_order.access_snapshot),
      'E2:' || v_order.id);
  end if;

  perform public.write_audit(p_actor, 'payments',
    case when p_actor is null then 'order_fulfilled' else 'manual_fulfil' end,
    v_order.order_no,
    jsonb_build_object('reason', p_reason, 'total', v_order.total_php,
                       'duplicate', v_dup, 'ticket', v_ticket,
                       'referral', v_ref_row is not null));

  return jsonb_build_object('outcome', 'fulfilled', 'order_id', v_order.id,
                            'duplicate', v_dup, 'ticket', v_ticket);
end $$;

create or replace function public.fail_order(p_order_id uuid, p_reason text) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.orders set status = 'failed'
   where id = p_order_id and status in ('created','awaiting_payment','awaiting_proof');
  if not found then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;
  perform public.release_coupon(p_order_id);
  return jsonb_build_object('ok', true, 'noop', false, 'reason', p_reason);
end $$;

-- Job: unpaid orders past expires_at -> expired, coupon released. Orders with
-- proof under review (pending_approval) never expire.
create or replace function public.expire_orders() returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_n  integer := 0;
begin
  for v_id in
    select id from public.orders
     where status in ('created','awaiting_payment','awaiting_proof') and expires_at < now()
     for update skip locked
  loop
    update public.orders set status = 'expired' where id = v_id;
    perform public.release_coupon(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Bank deposits (§5)
-- ---------------------------------------------------------------------------
create or replace function public.submit_bank_proof(
  p_uid          uuid,
  p_order_id     uuid,
  p_bank         text,
  p_amount       integer,
  p_reference_no text,
  p_proof_path   text,
  p_sha256       text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_buyer public.profiles;
  v_dep   uuid;
  v_dup   boolean;
  v_admin text;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = p_uid for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if v_order.method is distinct from 'bank' then
    raise exception 'METHOD_INVALID';
  end if;
  if v_order.status not in ('awaiting_proof','pending_approval') then
    raise exception 'ORDER_NOT_AWAITING_PROOF';
  end if;
  if v_order.status = 'awaiting_proof' and v_order.expires_at < now() then
    raise exception 'ORDER_EXPIRED';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'AMOUNT_INVALID';
  end if;

  -- A replacement proof while one is pending supersedes the old one.
  update public.bank_deposits set status = 'superseded'
   where order_id = p_order_id and status = 'pending_approval';

  insert into public.bank_deposits
    (order_id, user_id, bank, amount_received, reference_no, proof_path, proof_sha256)
  values (p_order_id, p_uid, lower(p_bank), p_amount, btrim(p_reference_no), p_proof_path, lower(p_sha256))
  returning id into v_dep;

  update public.orders set status = 'pending_approval' where id = p_order_id;

  select exists (
    select 1 from public.bank_deposits d
     where d.id <> v_dep and d.order_id <> p_order_id
       and ((d.bank = lower(p_bank) and lower(d.reference_no) = lower(btrim(p_reference_no)))
         or d.proof_sha256 = lower(p_sha256))) into v_dup;

  select * into v_buyer from public.profiles where id = p_uid;
  perform public.enqueue_email('E3', v_buyer.email,
    jsonb_build_object('name', v_buyer.display_name, 'order_no', v_order.order_no,
                       'product', v_order.access_snapshot->>'title', 'amount', p_amount,
                       'bank', lower(p_bank), 'sla_hours', public.setting_int('bank_sla_hours', 24)),
    'E3:' || v_dep);
  for v_admin in select email from public.admins loop
    perform public.enqueue_email('A1', v_admin,
      jsonb_build_object('order_no', v_order.order_no, 'amount', p_amount,
                         'total', v_order.total_php, 'bank', lower(p_bank), 'duplicate', v_dup),
      'A1:' || v_dep || ':' || v_admin);
  end loop;

  return jsonb_build_object('deposit_id', v_dep, 'duplicate_warning', v_dup);
end $$;

create or replace function public.approve_deposit(p_deposit_id uuid, p_admin uuid) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dep   public.bank_deposits;
  v_order public.orders;
  v_buyer public.profiles;
  v_extra integer;
begin
  select * into v_dep from public.bank_deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'DEPOSIT_NOT_FOUND';
  end if;
  if v_dep.status <> 'pending_approval' then
    return jsonb_build_object('ok', true, 'noop', true, 'status', v_dep.status);
  end if;

  select * into v_order from public.orders where id = v_dep.order_id for update;
  if v_dep.amount_received < v_order.total_php then
    raise exception 'DEPOSIT_UNDERPAID';
  end if;

  update public.bank_deposits
     set status = 'approved', reviewed_by = p_admin, reviewed_at = now()
   where id = v_dep.id;

  perform public.fulfil_order(v_order.id, p_admin, 'Bank deposit approved');

  v_extra := v_dep.amount_received - v_order.total_php;
  if v_extra > 0 then
    insert into public.balance_ledger (user_id, amount_php, source, ref_id, note, created_by)
    values (v_order.user_id, v_extra, 'deposit_credit', v_dep.id,
            'Overpayment on ' || v_order.order_no, p_admin);
  end if;

  select * into v_buyer from public.profiles where id = v_order.user_id;
  perform public.enqueue_email('E4', v_buyer.email,
    jsonb_build_object('name', v_buyer.display_name, 'order_no', v_order.order_no,
                       'product', v_order.access_snapshot->>'title',
                       'amount', v_dep.amount_received, 'bank', v_dep.bank,
                       'credit', v_extra, 'access', v_order.access_snapshot),
    'E4:' || v_dep.id);
  perform public.write_audit(p_admin, 'payments', 'deposit_approved', v_order.order_no,
    jsonb_build_object('amount', v_dep.amount_received, 'bank', v_dep.bank, 'credit', v_extra));

  return jsonb_build_object('ok', true, 'noop', false, 'credit', v_extra);
end $$;

-- Underpaid: rejecting credits the full amount received to the balance (E12).
create or replace function public.reject_deposit(
  p_deposit_id uuid, p_admin uuid, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dep    public.bank_deposits;
  v_order  public.orders;
  v_buyer  public.profiles;
  v_credit integer := 0;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;
  select * into v_dep from public.bank_deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'DEPOSIT_NOT_FOUND';
  end if;
  if v_dep.status <> 'pending_approval' then
    return jsonb_build_object('ok', true, 'noop', true, 'status', v_dep.status);
  end if;
  select * into v_order from public.orders where id = v_dep.order_id for update;

  update public.bank_deposits
     set status = 'rejected', reject_reason = btrim(p_reason),
         reviewed_by = p_admin, reviewed_at = now()
   where id = v_dep.id;

  update public.orders
     set status = 'awaiting_proof',
         expires_at = now() + public.setting_int('order_ttl_bank_h', 48) * interval '1 hour'
   where id = v_order.id and status = 'pending_approval';

  select * into v_buyer from public.profiles where id = v_order.user_id;
  if v_dep.amount_received < v_order.total_php then
    v_credit := v_dep.amount_received;
    insert into public.balance_ledger (user_id, amount_php, source, ref_id, note, created_by)
    values (v_order.user_id, v_credit, 'deposit_credit', v_dep.id,
            'Short deposit on ' || v_order.order_no, p_admin);
    perform public.enqueue_email('E12', v_buyer.email,
      jsonb_build_object('name', v_buyer.display_name, 'order_no', v_order.order_no,
                         'product', v_order.access_snapshot->>'title',
                         'received', v_dep.amount_received, 'total', v_order.total_php,
                         'short_by', v_order.total_php - v_dep.amount_received),
      'E12:' || v_dep.id);
  else
    perform public.enqueue_email('E5', v_buyer.email,
      jsonb_build_object('name', v_buyer.display_name, 'order_no', v_order.order_no,
                         'bank', v_dep.bank, 'reason', btrim(p_reason)),
      'E5:' || v_dep.id);
  end if;

  perform public.write_audit(p_admin, 'payments', 'deposit_rejected', v_order.order_no,
    jsonb_build_object('reason', btrim(p_reason), 'amount', v_dep.amount_received,
                       'bank', v_dep.bank, 'credit', v_credit));
  return jsonb_build_object('ok', true, 'noop', false, 'credit', v_credit);
end $$;

-- Job: admin reminder for deposits waiting more than half the SLA.
create or replace function public.deposit_sla_reminders() returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dep   record;
  v_admin text;
  v_n     integer := 0;
begin
  for v_dep in
    select d.id, o.order_no, d.created_at from public.bank_deposits d
      join public.orders o on o.id = d.order_id
     where d.status = 'pending_approval'
       and d.created_at < now() - public.setting_int('bank_sla_hours', 24) * interval '30 minutes'
  loop
    for v_admin in select email from public.admins loop
      perform public.enqueue_email('A1', v_admin,
        jsonb_build_object('order_no', v_dep.order_no, 'reminder', true,
                           'submitted_at', v_dep.created_at),
        'A1R:' || v_dep.id || ':' || v_admin);
    end loop;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Refunds (§10): only failed-but-charged and duplicate payments. Voids the
-- referral reward; revokes an enrollment only if this order granted it.
-- The PayMongo refund call happens in the Edge Function first.
-- ---------------------------------------------------------------------------
create or replace function public.refund_order(
  p_order_id uuid, p_admin uuid, p_reason text, p_issue_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_buyer public.profiles;
  v_ref   record;
  v_rev   integer;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if v_order.status = 'refunded' then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;
  if v_order.status not in ('paid','on_hold','failed','expired') then
    raise exception 'ORDER_NOT_REFUNDABLE';
  end if;

  update public.orders set status = 'refunded', refunded_at = now() where id = v_order.id;

  for v_ref in
    update public.referrals set status = 'void', voided_at = now()
     where order_id = v_order.id and status <> 'void'
    returning id, referrer_user_id, amount_php
  loop
    insert into public.balance_ledger (user_id, amount_php, source, ref_id, note, created_by)
    values (v_ref.referrer_user_id, -v_ref.amount_php, 'adjustment', v_ref.id,
            'Referral voided: refund of ' || v_order.order_no, p_admin);
  end loop;

  update public.enrollments
     set status = 'revoked', ended_at = now(), revoked_reason = 'Refund of ' || v_order.order_no
   where order_id = v_order.id and status = 'active';
  get diagnostics v_rev = row_count;

  update public.incidents set resolved_at = now(), resolved_by = p_admin
   where order_id = v_order.id and resolved_at is null;
  if p_issue_id is not null then
    update public.issues
       set status = 'refunded', resolution = btrim(p_reason), resolved_by = p_admin, resolved_at = now()
     where id = p_issue_id and status = 'open';
  end if;

  select * into v_buyer from public.profiles where id = v_order.user_id;
  perform public.enqueue_email('E8', v_buyer.email,
    jsonb_build_object('name', v_buyer.display_name, 'order_no', v_order.order_no,
                       'product', v_order.access_snapshot->>'title',
                       'amount', v_order.total_php, 'method', v_order.method,
                       'access_kept', v_rev = 0),
    'E8:' || v_order.id);
  perform public.write_audit(p_admin, 'payments', 'refund_issued', v_order.order_no,
    jsonb_build_object('reason', btrim(p_reason), 'amount', v_order.total_php,
                       'enrollment_revoked', v_rev > 0));
  return jsonb_build_object('ok', true, 'noop', false, 'enrollment_revoked', v_rev > 0);
end $$;

-- ---------------------------------------------------------------------------
-- Admin access changes (§11) and the referral ledger Void action (§7)
-- ---------------------------------------------------------------------------
create or replace function public.grant_access(
  p_admin uuid, p_user_id uuid, p_product_id uuid, p_source text,
  p_expires_at timestamptz, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products;
  v_id      uuid;
  v_mode    text;
begin
  if p_source not in ('comp','credit') then
    raise exception 'SOURCE_INVALID';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;
  select * into v_product from public.products where id = p_product_id;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  perform public.end_lapsed_enrollments(p_user_id, p_product_id);
  if exists (select 1 from public.enrollments
              where user_id = p_user_id and product_id = p_product_id and status = 'active') then
    raise exception 'ALREADY_OWNED';
  end if;

  v_mode := case when p_expires_at is not null then 'fixed' else v_product.access_mode end;
  insert into public.enrollments
    (user_id, product_id, source, access_mode, attempts_allowed, expires_at)
  values (p_user_id, p_product_id, p_source::public.enrollment_source, v_mode,
          v_product.attempts_per_purchase,
          case when p_expires_at is not null then p_expires_at
               when v_mode = 'exam_date' then public.exam_date_ts() end)
  returning id into v_id;

  perform public.write_audit(p_admin, 'access', 'grant_access',
    (select email from public.profiles where id = p_user_id),
    jsonb_build_object('product', v_product.title, 'source', p_source,
                       'reason', btrim(p_reason), 'enrollment_id', v_id));
  return jsonb_build_object('ok', true, 'enrollment_id', v_id);
end $$;

create or replace function public.revoke_access(
  p_admin uuid, p_enrollment_id uuid, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_e public.enrollments;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;
  update public.enrollments
     set status = 'revoked', ended_at = now(), revoked_reason = btrim(p_reason)
   where id = p_enrollment_id and status = 'active'
  returning * into v_e;
  if not found then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;
  perform public.write_audit(p_admin, 'access', 'revoke_access',
    (select email from public.profiles where id = v_e.user_id),
    jsonb_build_object('product', (select title from public.products where id = v_e.product_id),
                       'reason', btrim(p_reason), 'enrollment_id', v_e.id));
  return jsonb_build_object('ok', true, 'noop', false);
end $$;

create or replace function public.void_referral(
  p_admin uuid, p_referral_id uuid, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r public.referrals;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;
  update public.referrals set status = 'void', voided_at = now(), notes = btrim(p_reason)
   where id = p_referral_id and status <> 'void'
  returning * into v_r;
  if not found then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;
  insert into public.balance_ledger (user_id, amount_php, source, ref_id, note, created_by)
  values (v_r.referrer_user_id, -v_r.amount_php, 'adjustment', v_r.id,
          'Referral voided: ' || btrim(p_reason), p_admin);
  perform public.write_audit(p_admin, 'referrals', 'referral_voided', v_r.referrer_ref_code,
    jsonb_build_object('referral_id', v_r.id, 'amount', v_r.amount_php, 'reason', btrim(p_reason)));
  return jsonb_build_object('ok', true, 'noop', false);
end $$;

-- ---------------------------------------------------------------------------
-- Exam date (§1): moving it moves every active exam_date enrollment.
-- ---------------------------------------------------------------------------
create or replace function public.set_exam_date(p_admin uuid, p_date date) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old text;
  v_n   integer;
begin
  if p_date is null or p_date <= current_date then
    raise exception 'EXAM_DATE_INVALID';
  end if;
  select value into v_old from public.settings where key = 'exam_date' for update;
  update public.settings set value = to_char(p_date, 'YYYY-MM-DD'), updated_at = now()
   where key = 'exam_date';
  update public.enrollments set expires_at = public.exam_date_ts()
   where status = 'active' and access_mode = 'exam_date';
  get diagnostics v_n = row_count;
  perform public.write_audit(p_admin, 'settings', 'exam_date_changed', 'exam_date',
    jsonb_build_object('from', v_old, 'to', to_char(p_date, 'YYYY-MM-DD'), 'enrollments_moved', v_n));
  return jsonb_build_object('ok', true, 'enrollments_moved', v_n);
end $$;

-- Job (nightly): end enrollments past their expiry.
create or replace function public.expire_enrollments() returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  update public.enrollments set status = 'ended', ended_at = now()
   where status = 'active' and expires_at is not null and expires_at <= now();
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.write_audit(null, 'access', 'enrollments_expired', null,
                               jsonb_build_object('count', v_n));
  end if;
  return v_n;
end $$;
