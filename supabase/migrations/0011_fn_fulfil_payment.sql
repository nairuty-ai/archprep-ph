-- 0011_fn_fulfil_payment.sql
-- Platform v2 fulfilment: public.fulfil_payment(text, numeric, text, jsonb).
--
-- The whole pay -> enrol -> attribute decision lives in ONE function body so it
-- is ONE transaction (Requirement 16.2). supabase-js issues each statement as
-- its own transaction over PostgREST, so this cannot be built correctly in
-- Deno. The hitpay-webhook Edge Function verifies the HMAC, normalises the
-- payload, and hands the entire decision to this RPC.
--
-- Depends on:
--   0001  enum types order_status, enrollment_source, referral_status,
--         reward_type, incident_kind; profiles; products
--   0002  orders (partial unique index on hitpay_payment_id), enrollments
--         (enrollments_user_product_key), referrals (unique order_id,
--         referrals_no_self), payment_incidents
--   0003  mask_email()
--   0004  settings and its seeded referral configuration
--   0005  the revoke-first baseline and FORCE RLS on orders/enrollments/
--         referrals/profiles
--
-- Privileges: SECURITY DEFINER, owned by the migration role (postgres), EXECUTE
-- granted to service_role only (Requirement 8.4). 0005 already flipped default
-- privileges to deny EXECUTE to anon, authenticated and PUBLIC for functions
-- created later, so this function arrives closed; the revokes at the bottom are
-- stated explicitly anyway, because PostgREST exposes every public-schema
-- function as an RPC endpoint and this one writes money and access rows.
--
-- RLS note: orders, enrollments and referrals are FORCE ROW LEVEL SECURITY with
-- zero policies. This body works because the owner role holds BYPASSRLS on
-- Supabase. That is the deploy-time check called out in 0005:
--   select rolname, rolbypassrls from pg_roles
--    where rolname in ('postgres', 'service_role');
-- Both must be true. If the owner lacked BYPASSRLS the writes would fail closed
-- (no silent partial fulfilment), but fulfilment would stop entirely.
--
-- search_path note: pinned to `public, pg_temp` with pg_temp LAST, so a caller
-- cannot redirect this definer function at a shadowed table, and a temp object
-- cannot shadow a public one. pg_catalog is implicitly searched first, so the
-- built-ins used here (round, upper, btrim, now) cannot be shadowed either.
-- mask_email() in 0003 has no search_path of its own, so it inherits this one
-- when called from here; the call is schema-qualified as public.mask_email so
-- resolution of the call itself cannot be diverted. Pinning search_path on
-- mask_email would be the belt-and-braces fix, but 0003 is already applied and
-- is not edited by this task.
--
-- Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.8, 15.9, 16.2, 16.4, 16.5,
--               16.6, 16.10, 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8,
--               24.3, 24.4, 8.4

create or replace function public.fulfil_payment(
  p_payment_id        text,
  p_reported_amount   numeric,
  p_reported_currency text,
  p_payload           jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order      public.orders;
  v_referrer   public.profiles;
  v_reported   numeric;             -- unconstrained: an absurd payload value
  v_fit        numeric(12,2);       -- must not overflow before it is judged
  v_reward_amt numeric(12,2);
  v_reward_ty  public.reward_type;
  v_reward_on  text;
  v_setting    text;
  v_mask       text;
  v_title      text;
begin
  -- (1) Resolve the order and LOCK it. The lock is what serialises overlapping
  --     duplicate deliveries (Requirement 16.6): the second call resumes only
  --     after the first commits, then re-reads the row under READ COMMITTED and
  --     sees status = 'paid'. The unique constraints still backstop it.
  --     The partial unique index on hitpay_payment_id guarantees at most one
  --     matching row (Requirement 15.1: "the single orders row").
  select * into v_order
  from public.orders
  where hitpay_payment_id = p_payment_id
  for update;

  -- (2) Unknown payment identifier (Requirements 15.7, 16.10). Zero writes to
  --     orders, enrollments and referrals; the incident is the only row added,
  --     and it commits so the webhook can answer 200.
  if not found then
    insert into public.payment_incidents
      (kind, hitpay_payment_id, reported_amount, reported_currency, payload)
    values ('unmatched_payment', p_payment_id,
            case when p_reported_amount is not null
                  and p_reported_amount <> 'NaN'::numeric
                  and abs(p_reported_amount) < 10000000000
                 then round(p_reported_amount, 2) end,
            p_reported_currency, p_payload);
    return jsonb_build_object('outcome', 'unmatched');
  end if;

  -- (3) Replay of an already-fulfilled order (Requirement 16.5). Return BEFORE
  --     touching anything, so paid_at stays exactly as the first delivery left
  --     it and the enrollment and referral rows keep every column. A blind
  --     `update ... set paid_at = now()` would satisfy the row counts and still
  --     violate 16.5.
  if v_order.status = 'paid' then
    return jsonb_build_object('outcome', 'already_paid', 'order_id', v_order.id);
  end if;

  -- (4) A completed payment reported against a refunded order is out of order
  --     (Requirement 16.9 in spirit, recorded for admin review). Leave the
  --     order, the enrollment and the referral alone.
  if v_order.status = 'refunded' then
    insert into public.payment_incidents
      (kind, order_id, hitpay_payment_id, reported_amount, reported_currency,
       stored_amount, stored_currency, payload)
    values ('out_of_order_status', v_order.id, p_payment_id,
            case when p_reported_amount is not null
                  and p_reported_amount <> 'NaN'::numeric
                  and abs(p_reported_amount) < 10000000000
                 then round(p_reported_amount, 2) end,
            p_reported_currency, v_order.amount_php, v_order.currency, p_payload);
    return jsonb_build_object('outcome', 'already_refunded', 'order_id', v_order.id);
  end if;

  -- (5) Paid-amount cross-check (Requirement 15), before any enrollment row,
  --     any referral row, and any status change (15.1).
  --
  --     The comparison value is v_order.amount_php, written by create-payment
  --     from products.price_php. Zero part of it comes from the payload (15.5).
  --     Zero tolerance at two decimals, so an overpayment is a mismatch too
  --     (15.3). A null or NaN reported amount is a mismatch, which is how
  --     "absent or not parseable as a decimal number" lands here.
  --
  --     v_reported is unconstrained numeric and v_fit is the value narrowed for
  --     storage, because payment_incidents.reported_amount is numeric(12,2): an
  --     out-of-range payload amount must be recorded as a mismatch, not raise a
  --     numeric overflow that would roll back the incident and make HitPay
  --     retry a call that can never succeed. The full payload is stored either
  --     way, so nothing is lost when v_fit is null.
  v_reported := p_reported_amount;

  if v_reported is not null
     and v_reported <> 'NaN'::numeric
     and abs(v_reported) < 10000000000 then
    v_fit := round(v_reported, 2);
  else
    v_fit := null;
  end if;

  if v_reported is null
     or v_reported = 'NaN'::numeric
     or round(v_reported, 2) <> round(v_order.amount_php, 2) then
    insert into public.payment_incidents
      (kind, order_id, hitpay_payment_id, reported_amount, reported_currency,
       stored_amount, stored_currency, payload)
    values ('amount_mismatch', v_order.id, p_payment_id, v_fit,
            p_reported_currency, v_order.amount_php, v_order.currency, p_payload);
    return jsonb_build_object('outcome', 'amount_mismatch', 'order_id', v_order.id);
  end if;

  -- Currency compared as three-letter codes, trimmed, case-insensitive
  -- (Requirement 15.2). HitPay reports lower case; orders.currency is 'PHP'.
  -- Absent currency is a mismatch (15.4). The status is still 'pending' at this
  -- point, and stays that way (15.3, 15.4).
  if p_reported_currency is null
     or upper(btrim(p_reported_currency)) <> upper(btrim(v_order.currency)) then
    insert into public.payment_incidents
      (kind, order_id, hitpay_payment_id, reported_amount, reported_currency,
       stored_amount, stored_currency, payload)
    values ('currency_mismatch', v_order.id, p_payment_id, v_fit,
            p_reported_currency, v_order.amount_php, v_order.currency, p_payload);
    return jsonb_build_object('outcome', 'currency_mismatch', 'order_id', v_order.id);
  end if;

  -- From here the amount and the currency both matched, so zero incident rows
  -- are recorded for this order and fulfilment proceeds (Requirement 15.9).

  -- (6) Mark paid. now() is the transaction timestamp, stored as UTC by
  --     timestamptz (Requirement 16.2).
  update public.orders
     set status  = 'paid',
         paid_at = now()
   where id = v_order.id;

  -- (7) Grant access. The unique constraint IS the idempotency mechanism rather
  --     than a prior-existence check, so it holds under overlapping calls too
  --     (Requirements 16.4, 16.6). do nothing leaves every column of an
  --     existing enrollment untouched, including a comp enrollment for the same
  --     product.
  insert into public.enrollments (user_id, product_id, source, order_id)
  values (v_order.user_id, v_order.product_id, 'purchase', v_order.id)
  on conflict (user_id, product_id) do nothing;

  -- (8) Referral attribution (Requirement 23), inside this same transaction.
  --     No ref_code on the order: zero referral rows, enrollment already
  --     granted above (Requirement 23.8).
  if v_order.ref_code is not null and btrim(v_order.ref_code) <> '' then

    -- Requirement 23.1. Trimmed lookup so stray whitespace captured with the
    -- link cannot silently cost a referrer their credit. Case is NOT folded:
    -- ref_code is generated over an upper-case alphabet and is unique, so
    -- exact-code matching is the specified behaviour.
    select * into v_referrer
    from public.profiles
    where ref_code = btrim(v_order.ref_code);

    if not found then
      -- Requirement 23.4: unknown code, zero referral rows, enrollment stands.
      null;

    elsif v_referrer.id = v_order.user_id then
      -- Requirement 23.3: self-referral. Zero referral rows (the
      -- referrals_no_self constraint would refuse one anyway) and the attempt
      -- is recorded against the order for admin review.
      insert into public.payment_incidents
        (kind, order_id, hitpay_payment_id, payload)
      values ('self_referral', v_order.id, p_payment_id, p_payload);

    else
      -- Referral configuration is read from settings with the definer's
      -- privileges (Requirement 24.3). Every read falls back to the seeded
      -- default when the row is absent OR unusable (Requirement 24.4): a bad
      -- value must not raise, because a raise here would roll back a payment
      -- that has already been taken and make HitPay retry it forever.
      select value into v_setting from public.settings where key = 'reward_on';
      v_reward_on := lower(btrim(coalesce(v_setting, '')));
      if v_reward_on = '' then
        v_reward_on := 'every_purchase';
      end if;

      -- Requirement 23.6. The current order is already 'paid' by step 6, so it
      -- must be excluded; created_at scopes the test to a PRECEDING paid order.
      if v_reward_on = 'first_purchase_only'
         and exists (
           select 1
           from public.orders o
           where o.user_id = v_order.user_id
             and o.status  = 'paid'
             and o.id     <> v_order.id
             and o.created_at <= v_order.created_at
         ) then
        null;

      else
        -- Requirement 23.7 for 'every_purchase', and for any unrecognised
        -- reward_on value, which falls back to the seeded default behaviour.
        select value into v_setting
          from public.settings where key = 'referral_amount';
        v_setting := btrim(coalesce(v_setting, ''));
        if v_setting ~ '^[0-9]{1,10}(\.[0-9]+)?$' then
          v_reward_amt := round(v_setting::numeric, 2);
        else
          v_reward_amt := 9;                       -- seeded default (24.1, 24.4)
        end if;

        select value into v_setting
          from public.settings where key = 'reward_type';
        v_setting := lower(btrim(coalesce(v_setting, '')));
        if v_setting in ('cash', 'credit') then
          v_reward_ty := v_setting::public.reward_type;
        else
          v_reward_ty := 'cash';                   -- seeded default (24.1, 24.4)
        end if;

        -- Requirement 7.7: the buyer's identity is masked once, here, so
        -- buyer_user_id can stay outside the client grant entirely.
        v_mask := public.mask_email(
                    (select email from public.profiles where id = v_order.user_id));

        -- Denormalised so the ledger still renders after the product is
        -- unpublished. products.title is not null and the order's FK
        -- guarantees the row exists.
        select title into v_title
          from public.products where id = v_order.product_id;

        insert into public.referrals
          (referrer_ref_code, referrer_user_id, buyer_user_id, buyer_masked,
           order_id, product_id, product_title, amount_php, reward_type, status)
        values
          (v_referrer.ref_code, v_referrer.id, v_order.user_id,
           coalesce(v_mask, '***'),
           v_order.id, v_order.product_id, coalesce(v_title, 'Product'),
           v_reward_amt, v_reward_ty, 'available')
        on conflict (order_id) do nothing;   -- Requirements 23.5, 16.4
      end if;
    end if;
  end if;

  return jsonb_build_object('outcome', 'fulfilled', 'order_id', v_order.id);
end $$;

comment on function public.fulfil_payment(text, numeric, text, jsonb) is
  'Requirements 15, 16, 23, 24. One transaction: lock the order, cross-check the reported amount and currency against the stored values at two decimals with zero tolerance, mark paid, grant the enrollment, attribute the referral. Replays return at the already-paid branch with paid_at untouched. Every non-fulfilment branch returns normally so the incident row commits and the webhook can answer HTTP 200; a genuine fault raises and rolls back the whole body. Service role only.';

-- ---------------------------------------------------------------------------
-- Privileges (Requirement 8.4)
-- ---------------------------------------------------------------------------
-- PUBLIC is revoked as well as anon and authenticated. A new function's EXECUTE
-- is granted to PUBLIC by default, and both client roles inherit through it, so
-- revoking the two named roles alone would leave this function callable from a
-- browser as `POST /rest/v1/rpc/fulfil_payment`. 0005 already set the default
-- privileges that close this; these statements are the explicit belt.

revoke all on function public.fulfil_payment(text, numeric, text, jsonb) from public;
revoke all on function public.fulfil_payment(text, numeric, text, jsonb) from anon;
revoke all on function public.fulfil_payment(text, numeric, text, jsonb) from authenticated;

grant execute on function public.fulfil_payment(text, numeric, text, jsonb) to service_role;
