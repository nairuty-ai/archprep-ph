-- 0012_fn_refund_fail_payment.sql
-- Platform v2 reversal and failure paths:
--   public.refund_payment(text, numeric, text, jsonb)
--   public.fail_payment(text, numeric, text, jsonb)
--
-- Both functions are the mirror image of 0011's fulfilment: one function body,
-- therefore ONE transaction, so the order status change, the enrollment
-- revocation and the referral void either all commit or all roll back
-- (Requirement 17.12). supabase-js issues each statement as its own transaction
-- over PostgREST, so this cannot be assembled correctly in Deno; the
-- hitpay-webhook Edge Function verifies the HMAC, normalises the payload, and
-- hands the whole decision to one of these RPCs.
--
-- Depends on:
--   0001  enum types order_status, referral_status, incident_kind
--   0002  orders (partial unique index on hitpay_payment_id), enrollments
--         (enrollments_user_product_key), referrals (unique order_id),
--         payment_incidents
--   0005  the revoke-first baseline and FORCE RLS on orders/enrollments/
--         referrals
--   0011  fulfil_payment, whose conventions these two follow exactly
--
-- Privileges: SECURITY DEFINER, owned by the migration role (postgres), EXECUTE
-- granted to service_role only (Requirement 8.4). 0005 already flipped default
-- privileges so these functions arrive closed to anon, authenticated and
-- PUBLIC; the revokes at the bottom are stated explicitly anyway, because
-- PostgREST exposes every public-schema function as an RPC endpoint and these
-- two delete access rows and cancel rewards.
--
-- RLS note: orders, enrollments and referrals are FORCE ROW LEVEL SECURITY with
-- zero policies, so these bodies work because the owner role holds BYPASSRLS on
-- Supabase (the deploy-time check is stated in 0005). If the owner lacked it,
-- the writes would fail closed and roll back the whole reversal rather than
-- half-applying it.
--
-- search_path note: pinned to `public, pg_temp` with pg_temp LAST, so a caller
-- cannot redirect these definer functions at a shadowed table and a temp object
-- cannot shadow a public one. pg_catalog is searched first implicitly, so the
-- built-ins used here (round, abs, concat_ws) cannot be shadowed either.
--
-- Signature note: the reported amount and currency carry defaults, because a
-- refund is accepted for ANY reported amount (Requirement 17.1) and a failure
-- reports no amount at all, so neither value is needed to make the decision.
-- They are accepted so the reported figures can be retained on an incident row
-- (Requirement 15.8) when the payment identifier matches no order. The webhook
-- may therefore call either shape by name:
--   rpc('refund_payment', { p_payment_id, p_payload })
--   rpc('refund_payment', { p_payment_id, p_reported_amount,
--                           p_reported_currency, p_payload })
--
-- Requirements: 17.1, 17.2, 17.4, 17.5, 17.7, 17.8, 17.10, 17.11, 17.12,
--               16.8, 16.9, 15.8, 8.4

-- ---------------------------------------------------------------------------
-- refund_payment
-- ---------------------------------------------------------------------------

create or replace function public.refund_payment(
  p_payment_id        text,
  p_reported_amount   numeric default null,
  p_reported_currency text    default null,
  p_payload           jsonb   default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_round numeric;               -- unconstrained: an absurd payload value must
  v_fit   numeric(12,2);         -- not overflow before it is recorded
begin
  -- (0) Narrow the reported amount for storage BEFORE anything else. There is
  --     no amount cross-check on a refund (Requirement 17.1), so this value
  --     never influences the decision; it only has to be storable in
  --     payment_incidents.reported_amount, which is numeric(12,2). An absurd
  --     payload figure must land as a null reported amount on an incident row,
  --     not raise a numeric overflow that would roll back the incident and make
  --     HitPay retry a call that can never succeed. The full payload is stored
  --     either way, so nothing is lost when v_fit is null.
  --
  --     abs() of Infinity fails the bound, so infinities narrow to null too,
  --     and the bound is re-tested AFTER rounding because a value just under
  --     10^10 can round up past what numeric(12,2) holds.
  v_fit := null;
  if p_reported_amount is not null
     and p_reported_amount <> 'NaN'::numeric
     and abs(p_reported_amount) < 10000000000 then
    v_round := round(p_reported_amount, 2);
    if abs(v_round) < 10000000000 then
      v_fit := v_round;
    end if;
  end if;

  -- (1) Resolve the order and LOCK it. The lock is what makes repeated and
  --     concurrent refund deliveries safe (Requirement 17.7): the second call
  --     resumes only after the first commits, then re-reads the row under READ
  --     COMMITTED and sees status = 'refunded'. The partial unique index on
  --     hitpay_payment_id guarantees at most one matching row.
  select * into v_order
  from public.orders
  where hitpay_payment_id = p_payment_id
  for update;

  -- (2) Refund for an unknown payment identifier (Requirement 17.8). Zero
  --     writes to orders, enrollments and referrals; the incident is the only
  --     row added, and it commits so the webhook can answer HTTP 200. The
  --     reported amount and currency are retained on it (Requirement 15.8).
  if not found then
    insert into public.payment_incidents
      (kind, hitpay_payment_id, reported_amount, reported_currency, payload)
    values ('unmatched_refund', p_payment_id, v_fit, p_reported_currency,
            p_payload);
    return jsonb_build_object('outcome', 'unmatched_refund');
  end if;

  -- (3) Repeat delivery for an already-refunded order (Requirement 17.7).
  --     Return BEFORE touching anything: the order row, the enrollment row
  --     count for that user and product, and the referral's status AND note all
  --     have to be exactly what the first refund left behind. Re-running the
  --     referral update would satisfy the status assertion and still violate
  --     17.7, because concat_ws would append the void note a second time.
  if v_order.status = 'refunded' then
    return jsonb_build_object('outcome', 'already_refunded',
                              'order_id', v_order.id);
  end if;

  -- (4) Requirement 17.1: the status change applies for ANY reported refunded
  --     amount, partial or full, because a partial refund still reverses the
  --     purchase. There is deliberately no amount comparison here, unlike
  --     fulfilment in 0011.
  --
  --     paid_at is left exactly as it was. The order row is retained as the
  --     financial record of a purchase that happened and was then reversed
  --     (Requirement 17.2), so erasing when it was paid would destroy audit
  --     history.
  update public.orders
     set status = 'refunded'
   where id = v_order.id;

  -- (5) Revoke access (Requirement 17.2). Scoped to THIS order's user and
  --     product, never a blanket delete, so every other enrollment held by that
  --     user survives untouched. enrollments_user_product_key means this
  --     matches at most one row.
  --
  --     Scoping deliberately stops at (user_id, product_id) and does NOT also
  --     require order_id = this order: Requirement 17.13 asserts ZERO
  --     enrollments rows for that pair after the refund, and Requirement 17.3
  --     requires the 403 to hold for every later request. An enrollment for the
  --     same pair carrying a different order_id (or a null one from a comp
  --     grant) would otherwise survive and keep the content unlocked after the
  --     money was returned.
  --
  --     Zero rows deleted is not an error (Requirement 17.10): an order with no
  --     enrollment still becomes refunded and still returns HTTP 200.
  --
  --     quiz_attempts is NOT touched. Requirement 17.2 preserves the affected
  --     user's attempt history across a refund; the 403 comes from the missing
  --     enrollment, not from erased history.
  delete from public.enrollments
   where user_id    = v_order.user_id
     and product_id = v_order.product_id;

  -- (6) Void the referral (Requirements 17.4, 17.5, 17.11).
  --
  --     status and notes on the right-hand side read the OLD row, which is what
  --     lets one statement cover both cases: an 'available' reward is simply
  --     cancelled, and a reward already paid out is cancelled WITH a note
  --     saying the money has already left, appended to whatever note was there
  --     before. concat_ws skips a null note, so a first note is not prefixed
  --     with a separator.
  --
  --     paid_at is not in the SET list, so the recorded payout timestamp
  --     survives untouched (Requirement 17.5). The platform really did send
  --     that money; the row has to keep saying so even though it is now void.
  --
  --     Requirement 17.11: zero matching rows is not an error, and zero
  --     referrals rows are ever created here.
  update public.referrals
     set status = 'void',
         notes  = concat_ws(' | ', notes,
                    case when status = 'paid'
                      then 'Voided after refund; reward had already been paid out.'
                      else 'Voided after refund.' end)
   where order_id = v_order.id;

  return jsonb_build_object('outcome', 'refunded', 'order_id', v_order.id);
end $$;

comment on function public.refund_payment(text, numeric, text, jsonb) is
  'Requirement 17. One transaction: lock the order, set status refunded for any reported refunded amount, delete the enrollment for that order''s user and product, void that order''s referral preserving paid_at and appending the already-paid note. Repeat deliveries return at the already-refunded branch with the order, enrollment count, referral status and referral note untouched. An unknown payment identifier records an unmatched_refund incident and writes nothing else. Every settled branch returns normally so the incident commits and the webhook answers HTTP 200; a genuine fault raises and rolls the whole reversal back together. Service role only.';

-- ---------------------------------------------------------------------------
-- fail_payment
-- ---------------------------------------------------------------------------

create or replace function public.fail_payment(
  p_payment_id        text,
  p_reported_amount   numeric default null,
  p_reported_currency text    default null,
  p_payload           jsonb   default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_round numeric;
  v_fit   numeric(12,2);
begin
  -- (0) Same defensive narrowing as above. A failure payload usually reports no
  --     amount at all, which narrows to null and is stored as null.
  v_fit := null;
  if p_reported_amount is not null
     and p_reported_amount <> 'NaN'::numeric
     and abs(p_reported_amount) < 10000000000 then
    v_round := round(p_reported_amount, 2);
    if abs(v_round) < 10000000000 then
      v_fit := v_round;
    end if;
  end if;

  -- (1) Resolve and LOCK, so a failure report racing a completed-payment
  --     delivery for the same identifier cannot interleave with fulfilment.
  --     Whichever call takes the lock first decides; the second re-reads the
  --     committed status and lands on the matching branch below.
  select * into v_order
  from public.orders
  where hitpay_payment_id = p_payment_id
  for update;

  -- (2) Unknown payment identifier: zero writes to orders, enrollments and
  --     referrals, one incident row, HTTP 200 (Requirement 16.10 in spirit,
  --     recorded the same way fulfilment records it).
  if not found then
    insert into public.payment_incidents
      (kind, hitpay_payment_id, reported_amount, reported_currency, payload)
    values ('unmatched_payment', p_payment_id, v_fit, p_reported_currency,
            p_payload);
    return jsonb_build_object('outcome', 'unmatched');
  end if;

  -- (3) Requirement 16.9: a failed or cancelled payment reported against an
  --     order that is already paid is out of order. The order status, the
  --     enrollment and the referral are left ENTIRELY unchanged - the status is
  --     never downgraded from paid, because that would silently strip a buyer
  --     of access on the strength of a late or misrouted event. The incident is
  --     the only row written, and it commits so the webhook answers 200.
  if v_order.status = 'paid' then
    insert into public.payment_incidents
      (kind, order_id, hitpay_payment_id, reported_amount, reported_currency,
       stored_amount, stored_currency, payload)
    values ('out_of_order_status', v_order.id, p_payment_id, v_fit,
            p_reported_currency, v_order.amount_php, v_order.currency,
            p_payload);
    return jsonb_build_object('outcome', 'already_paid',
                              'order_id', v_order.id);
  end if;

  -- (4) Requirement 16.9, refunded arm. Same treatment: record it, change
  --     nothing. A refunded order must not be rewritten to failed, or the
  --     reversal audit trail would be lost.
  if v_order.status = 'refunded' then
    insert into public.payment_incidents
      (kind, order_id, hitpay_payment_id, reported_amount, reported_currency,
       stored_amount, stored_currency, payload)
    values ('out_of_order_status', v_order.id, p_payment_id, v_fit,
            p_reported_currency, v_order.amount_php, v_order.currency,
            p_payload);
    return jsonb_build_object('outcome', 'already_refunded',
                              'order_id', v_order.id);
  end if;

  -- (5) Repeat delivery of the same failure. Requirement 16.9 names only paid
  --     and refunded as out of order, so a second failure report for an
  --     already-failed order is a plain replay: no incident, no write, HTTP
  --     200.
  if v_order.status = 'failed' then
    return jsonb_build_object('outcome', 'already_failed',
                              'order_id', v_order.id);
  end if;

  -- (6) Requirement 16.8: the order was pending, so it moves to failed. Zero
  --     enrollments rows and zero referrals rows are created - there is no
  --     insert in this branch at all, which is the strongest form of that
  --     guarantee. paid_at stays null, because nothing was ever paid.
  update public.orders
     set status = 'failed'
   where id = v_order.id;

  return jsonb_build_object('outcome', 'failed', 'order_id', v_order.id);
end $$;

comment on function public.fail_payment(text, numeric, text, jsonb) is
  'Requirements 16.8, 16.9. One transaction: lock the order, move a pending order to failed granting nothing, and for an order already paid or refunded change nothing at all while recording an out_of_order_status incident for admin review. A repeated failure report for an already-failed order writes nothing. An unknown payment identifier records an unmatched_payment incident. Every settled branch returns normally so the incident commits and the webhook answers HTTP 200. Service role only.';

-- ---------------------------------------------------------------------------
-- Privileges (Requirement 8.4)
-- ---------------------------------------------------------------------------
-- PUBLIC is revoked as well as anon and authenticated. A new function's EXECUTE
-- is granted to PUBLIC by default and both client roles inherit through it, so
-- revoking the two named roles alone would leave these callable from a browser
-- as `POST /rest/v1/rpc/refund_payment`. 0005 already set the default
-- privileges that close this; these statements are the explicit belt. A client
-- reaching refund_payment could delete another user's enrollment, which is why
-- it is stated rather than assumed.

revoke all on function public.refund_payment(text, numeric, text, jsonb) from public;
revoke all on function public.refund_payment(text, numeric, text, jsonb) from anon;
revoke all on function public.refund_payment(text, numeric, text, jsonb) from authenticated;

revoke all on function public.fail_payment(text, numeric, text, jsonb) from public;
revoke all on function public.fail_payment(text, numeric, text, jsonb) from anon;
revoke all on function public.fail_payment(text, numeric, text, jsonb) from authenticated;

grant execute on function public.refund_payment(text, numeric, text, jsonb) to service_role;
grant execute on function public.fail_payment(text, numeric, text, jsonb) to service_role;
