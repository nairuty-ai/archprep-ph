-- 0026_referral_reward_by_product.sql
-- Referral commission per product (marketing decision, Nov 2026):
--   quiz packs                 referral_amount_quiz (default 5)
--   reviewers and mock boards  referral_amount      (default 9)
--   free products, or any order that was paid ₱0      no commission
-- The commission is only ever created by fulfil_order, i.e. after the
-- referred student's payment is confirmed; nothing is earned on sign-up or on
-- free quizzes. fulfil_order is unchanged except for where the amount comes
-- from. The amounts are deliberately not shown in marketing copy; they are
-- stated in the referral terms (faq.html#referral-terms).

insert into public.settings (key, value, display_safe) values
  ('referral_amount_quiz', '5', true)
on conflict (key) do nothing;

create or replace function public.referral_reward_for(p_product_id uuid, p_total_php integer)
returns integer
language sql stable
set search_path = public, pg_temp
as $$
  select case
    when coalesce(p_total_php, 0) <= 0 then 0
    when p.type = 'free' then 0
    when p.type = 'quiz' then greatest(public.setting_int('referral_amount_quiz', 5), 0)
    else greatest(public.setting_int('referral_amount', 9), 0)
  end
  from public.products p where p.id = p_product_id;
$$;
revoke execute on function public.referral_reward_for(uuid, integer) from public, anon, authenticated;

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
    v_amount := public.referral_reward_for(v_order.product_id, v_order.total_php);
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

revoke execute on function public.fulfil_order(uuid, uuid, text) from public, anon, authenticated;
