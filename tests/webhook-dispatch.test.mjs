/* tests/webhook-dispatch.test.mjs — unit tests for the webhook's decisions.
 *
 * The handler itself (supabase/functions/hitpay-webhook/index.ts) is TypeScript
 * running under Deno, which is not installed here. Its judgements therefore live
 * in the pure module beside it — which SQL function an outcome dispatches to,
 * the timeout per function, whether a result settled or faulted, and what a
 * refused delivery may log — and that is what this file exercises.
 *
 * The three behaviours worth breaking a build over:
 *
 *   an `ignored` outcome produces no call at all, so an unrelated event type
 *   cannot reach a row (Requirement 16.3);
 *
 *   an incident outcome answers 200 and a fault answers 5xx, never the reverse
 *   (Requirements 15.3, 15.4, 16.3, 16.9, 16.10, 17.7, 17.8, 17.12);
 *
 *   a rejection log entry carries the reported payment identifier and no salt
 *   (Requirement 14.5).
 *
 * Requirements 14.2, 14.5, 15.9, 16.3, 16.7, 17.12.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHitpayPayload } from '../supabase/functions/_shared/hitpay.mjs';
import {
  FULFIL_TIMEOUT_MS,
  REFUND_TIMEOUT_MS,
  REJECTION_LOG_FIELDS,
  RPC_BY_OUTCOME,
  RPC_NAMES,
  SETTLED_OUTCOMES,
  WebhookDispatchError,
  rejectionLogEntry,
  rpcCallFor,
  rpcTimeoutMs,
  rpcUrl,
  statusForRpcResult,
} from '../supabase/functions/hitpay-webhook/dispatch.mjs';

const SALT = 'salt_that_must_never_be_logged_9f2c';

// ---------------------------------------------------------------------------
// Dispatch: outcome → SQL function (Requirement 16.7)

test('a completed payment dispatches to fulfil_payment with the reported values', () => {
  const call = rpcCallFor({
    status: 'completed',
    paymentId: 'pr_abc123',
    amount: 900,
    currency: 'php',
    raw: { id: 'pr_abc123', status: 'completed' },
  });

  assert.equal(call.fn, 'fulfil_payment');
  assert.deepEqual(call.body, {
    p_payment_id: 'pr_abc123',
    p_reported_amount: 900,
    // Verbatim: the SQL side owns the trim-and-upper compare, and the incident
    // record should say what actually arrived (Requirement 15.2).
    p_reported_currency: 'php',
    p_payload: { id: 'pr_abc123', status: 'completed' },
  });
});

test('a refund dispatches to refund_payment', () => {
  const call = rpcCallFor({
    status: 'refunded',
    paymentId: 'pr_ref',
    amount: 450,
    currency: 'PHP',
    raw: { status: 'refunded' },
  });

  assert.equal(call.fn, 'refund_payment');
  assert.equal(call.body.p_payment_id, 'pr_ref');
});

test('a failure dispatches to fail_payment', () => {
  const call = rpcCallFor({
    status: 'failed',
    paymentId: 'pr_fail',
    amount: null,
    currency: null,
    raw: { status: 'failed' },
  });

  assert.equal(call.fn, 'fail_payment');
  assert.equal(call.body.p_payment_id, 'pr_fail');
});

test('an ignored outcome produces no call, so zero rows can change', () => {
  assert.equal(
    rpcCallFor({ status: 'ignored', reason: 'unhandled_event:payout.created', raw: {} }),
    null,
  );
});

test('the dispatch table covers exactly the three acting outcomes', () => {
  assert.deepEqual(Object.keys(RPC_BY_OUTCOME).sort(), ['completed', 'failed', 'refunded']);
  assert.deepEqual([...RPC_NAMES].sort(), ['fail_payment', 'fulfil_payment', 'refund_payment']);
});

test('an absent amount or currency travels as null, never as a zero', () => {
  // Requirement 15.3: an unparseable amount is a mismatch to be recorded, not a
  // zero to be compared. Coercing here would hide it.
  const call = rpcCallFor({
    status: 'completed',
    paymentId: 'pr_no_amount',
    amount: null,
    currency: null,
    raw: { id: 'pr_no_amount' },
  });

  assert.equal(call.body.p_reported_amount, null);
  assert.equal(call.body.p_reported_currency, null);
});

test('a status outside the normalised vocabulary is refused rather than guessed', () => {
  assert.throws(() => rpcCallFor({ status: 'pending', paymentId: 'pr_1' }), WebhookDispatchError);
  assert.throws(() => rpcCallFor(null), WebhookDispatchError);
});

test('an acting outcome with no payment identifier is refused', () => {
  assert.throws(
    () => rpcCallFor({ status: 'completed', paymentId: '   ', amount: 1, currency: 'PHP' }),
    WebhookDispatchError,
  );
});

test('the parser and the dispatcher agree on a real completed charge', async () => {
  const raw = JSON.stringify({
    payment_request_id: 'pr_live',
    status: 'completed',
    amount: '900.00',
    currency: 'php',
  });
  const parsed = parseHitpayPayload(raw, { 'Hitpay-Event-Object': 'charge', 'Hitpay-Event-Type': 'created' });

  const call = rpcCallFor(parsed);
  assert.equal(call.fn, 'fulfil_payment');
  assert.equal(call.body.p_payment_id, 'pr_live');
  assert.equal(call.body.p_reported_amount, 900);
});

// ---------------------------------------------------------------------------
// Timeouts (Requirements 16.2 and 17.12)

test('the refund call is bounded at 15 seconds and the others at 10', () => {
  assert.equal(rpcTimeoutMs('refund_payment'), REFUND_TIMEOUT_MS);
  assert.equal(REFUND_TIMEOUT_MS, 15_000);

  assert.equal(rpcTimeoutMs('fulfil_payment'), FULFIL_TIMEOUT_MS);
  assert.equal(rpcTimeoutMs('fail_payment'), FULFIL_TIMEOUT_MS);
  assert.equal(FULFIL_TIMEOUT_MS, 10_000);
});

// ---------------------------------------------------------------------------
// RPC URL

test('rpcUrl builds the service-role RPC path for a known function', () => {
  assert.equal(
    rpcUrl('https://project.supabase.co', 'fulfil_payment'),
    'https://project.supabase.co/rest/v1/rpc/fulfil_payment',
  );
  assert.equal(
    rpcUrl('https://project.supabase.co///', 'refund_payment'),
    'https://project.supabase.co/rest/v1/rpc/refund_payment',
  );
});

test('rpcUrl refuses any function name outside the closed set', () => {
  assert.throws(() => rpcUrl('https://project.supabase.co', 'drop_everything'), WebhookDispatchError);
  assert.throws(() => rpcUrl('', 'fulfil_payment'), TypeError);
});

// ---------------------------------------------------------------------------
// Settled versus fault (Requirement 16.3)

test('every outcome the SQL functions return answers HTTP 200', () => {
  for (const [fn, outcomes] of Object.entries(SETTLED_OUTCOMES)) {
    for (const outcome of outcomes) {
      const decision = statusForRpcResult({ outcome, order_id: 'ord_1' });
      assert.equal(decision.status, 200, `${fn}/${outcome} should settle`);
      assert.equal(decision.outcome, outcome);
      assert.equal(decision.recognised, true);
      assert.equal(decision.orderId, 'ord_1');
    }
  }
});

test('an incident outcome settles at 200 so HitPay does not redeliver forever', () => {
  // Requirements 15.3, 15.4, 16.9, 16.10, 17.8: the incident is recorded and the
  // transaction committed, so the call is finished even though nothing was granted.
  for (const outcome of ['unmatched', 'amount_mismatch', 'currency_mismatch', 'unmatched_refund']) {
    assert.equal(statusForRpcResult({ outcome }).status, 200);
  }
});

test('a replay outcome settles at 200 with no order id required', () => {
  const decision = statusForRpcResult({ outcome: 'already_paid' });
  assert.equal(decision.status, 200);
  assert.equal(decision.orderId, null);
});

test('a single-row array answer is unwrapped', () => {
  assert.equal(statusForRpcResult([{ outcome: 'fulfilled' }]).status, 200);
});

test('anything that is not a returned outcome is a fault, so HitPay retries', () => {
  for (const body of [null, undefined, '', 'fulfilled', 42, [], {}, { outcome: '' }, { outcome: 7 }]) {
    const decision = statusForRpcResult(body);
    assert.equal(decision.status, 500, `${JSON.stringify(body ?? null)} should fault`);
    assert.equal(decision.outcome, null);
  }
});

test('an outcome the SQL side grew later still settles, flagged as unrecognised', () => {
  const decision = statusForRpcResult({ outcome: 'partially_refunded' });
  assert.equal(decision.status, 200);
  assert.equal(decision.recognised, false);
});

// ---------------------------------------------------------------------------
// Rejection logging (Requirement 14.5)

test('a rejection log entry names the reported payment identifier', () => {
  const raw = JSON.stringify({
    payment_request_id: 'pr_forged',
    status: 'completed',
    amount: '900.00',
    currency: 'PHP',
  });

  const entry = rejectionLogEntry(raw, { 'Hitpay-Event-Object': 'charge', 'Hitpay-Event-Type': 'created' });

  assert.equal(entry.payment_id, 'pr_forged');
  assert.equal(entry.event_name, 'charge.created');
  assert.equal(entry.reason, 'signature_mismatch');
});

test('a rejection log entry carries no field outside the allowlist and no salt', () => {
  const raw = JSON.stringify({ payment_request_id: 'pr_x', status: 'completed', hmac: SALT });
  const entry = rejectionLogEntry(raw, null);

  assert.deepEqual(Object.keys(entry).sort(), [...REJECTION_LOG_FIELDS].sort());
  assert.ok(!JSON.stringify(entry).includes(SALT));
});

test('an unparseable body still yields a usable rejection entry', () => {
  const entry = rejectionLogEntry('<html>not json</html>', { 'Hitpay-Event-Object': 'charge' });

  assert.equal(entry.payment_id, null);
  assert.equal(entry.event_name, 'charge');
  assert.equal(entry.body_bytes, '<html>not json</html>'.length);
});
