/* supabase/functions/hitpay-webhook/dispatch.mjs — the webhook's decisions, as
 * pure functions.
 *
 * Four of them, and between them they hold every judgement this endpoint makes
 * once the signature has verified:
 *
 *   rpcCallFor()          normalised outcome → which SQL function, with what
 *                         arguments (Requirement 16.7, 17.12, 15.9)
 *   rpcTimeoutMs()        the bound the SQL side said it could not express
 *                         inside its own body (Requirement 16.2, 17.12)
 *   rpcUrl()              the service-role PostgREST RPC endpoint
 *   statusForRpcResult()  settled → 200, fault → 5xx (Requirement 16.3)
 *   rejectionLogEntry()   what a refused delivery is allowed to log
 *                         (Requirement 14.5)
 *
 * Why `.mjs` next to a `.ts` handler: the same split scrub.mjs, jwt.mjs, and
 * postgrest.mjs use. Deno is not installed in this repo, so anything that can be
 * a function of its arguments lives in a module `node --test` can load
 * (tests/webhook-dispatch.test.mjs), and index.ts keeps only what cannot be —
 * reading the environment, the HMAC check against a live `Request`, and the
 * outbound `fetch`.
 *
 * Nothing in this file reads the environment, so `HITPAY_WEBHOOK_SALT` is not
 * merely absent from the log entry below: it is unreachable from here. That is
 * Requirement 14 criterion 5 held structurally rather than by remembering.
 */

import { eventNameFrom, paymentIdFrom } from '../_shared/hitpay.mjs';

/**
 * Normalised outcome → SQL function. The whole dispatch table.
 *
 * `ignored` is deliberately absent: it maps to no function at all, which is how
 * Requirement 16 criterion 3's "zero writes" becomes structural for an unrelated
 * event type — there is no call to make, not a call that happens to do nothing.
 */
export const RPC_BY_OUTCOME = Object.freeze({
  completed: 'fulfil_payment',
  refunded: 'refund_payment',
  failed: 'fail_payment',
});

/** The three names this function may ever POST to, as a closed set. */
export const RPC_NAMES = Object.freeze(Object.values(RPC_BY_OUTCOME));

/**
 * Every outcome token the SQL functions in migrations 0011 and 0012 return.
 *
 * Recorded for the log line, not for the status decision. A function that
 * returned at all committed its transaction, so an outcome this list has not
 * heard of is still a settled call (see {@link statusForRpcResult}); it is worth
 * saying so in the logs, because it means the SQL side grew a branch and this
 * file has not caught up.
 */
export const SETTLED_OUTCOMES = Object.freeze({
  fulfil_payment: Object.freeze([
    'unmatched',
    'already_paid',
    'already_refunded',
    'amount_mismatch',
    'currency_mismatch',
    'fulfilled',
  ]),
  refund_payment: Object.freeze(['unmatched_refund', 'already_refunded', 'refunded']),
  fail_payment: Object.freeze([
    'unmatched',
    'already_paid',
    'already_refunded',
    'already_failed',
    'failed',
  ]),
});

/**
 * Requirement 16 criterion 2: the completed-payment answer inside 10 seconds.
 * `fail_payment` is a single-row update and shares the bound.
 */
export const FULFIL_TIMEOUT_MS = 10_000;

/**
 * Requirement 17 criterion 12: the refund transaction commits within 15 seconds
 * or is rolled back and retried.
 *
 * The SQL side noted this bound is not expressible inside a function body — a
 * plpgsql function cannot time itself out — so it is enforced here, by aborting
 * the request. Aborting drops the connection, Postgres cancels the backend, and
 * the transaction rolls back whole, which is exactly what criterion 12 asks for.
 */
export const REFUND_TIMEOUT_MS = 15_000;

/** A dispatch that cannot be made, as opposed to one that settled badly. */
export class WebhookDispatchError extends Error {
  /** @param {'unknown_outcome'|'unknown_function'|'missing_payment_id'} reason */
  constructor(reason, message) {
    super(message);
    this.name = 'WebhookDispatchError';
    this.reason = reason;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The SQL call for one normalised payload, or `null` when there is nothing to
 * call.
 *
 * ```js
 * rpcCallFor({ status: 'completed', paymentId: 'pr_1', amount: 900, currency: 'php', raw })
 * // → { fn: 'fulfil_payment', body: { p_payment_id: 'pr_1', p_reported_amount: 900,
 * //                                   p_reported_currency: 'php', p_payload: raw } }
 * ```
 *
 * `amount` and `currency` travel as `null` when the payload did not carry a
 * usable one. They are **not** coerced to a zero or an empty string: the SQL
 * side treats a null reported amount as a mismatch and records an incident
 * (Requirements 15.3 and 15.4), whereas a coerced `0` would be indistinguishable
 * from a genuinely reported zero. The currency goes through verbatim, casing and
 * padding intact, because `fulfil_payment` owns the trim-and-upper comparison
 * and the incident row is evidence of what actually arrived.
 *
 * @param {{status: string, paymentId?: string, amount?: number|null, currency?: string|null, raw?: unknown}} parsed
 *   the result of `parseHitpayPayload`, from a call whose signature already verified
 * @returns {{fn: string, body: Record<string, unknown>}|null} `null` for `ignored`
 * @throws {WebhookDispatchError} for a status outside the normalised vocabulary
 */
export function rpcCallFor(parsed) {
  if (!isPlainObject(parsed) || typeof parsed.status !== 'string') {
    throw new WebhookDispatchError(
      'unknown_outcome',
      'rpcCallFor requires a normalised payload with a status.',
    );
  }

  if (parsed.status === 'ignored') return null;

  const fn = RPC_BY_OUTCOME[parsed.status];
  if (!fn) {
    throw new WebhookDispatchError(
      'unknown_outcome',
      `No SQL function handles the outcome "${parsed.status}".`,
    );
  }

  const paymentId = typeof parsed.paymentId === 'string' ? parsed.paymentId.trim() : '';
  if (paymentId === '') {
    // parseHitpayPayload already downgrades an unidentifiable payload to
    // `ignored`, so reaching here means a caller built the argument by hand.
    // Refusing beats passing a blank id that would match no order and
    // manufacture one incident per delivery.
    throw new WebhookDispatchError(
      'missing_payment_id',
      'A dispatched outcome must carry a reported payment identifier.',
    );
  }

  return {
    fn,
    body: {
      p_payment_id: paymentId,
      p_reported_amount: typeof parsed.amount === 'number' && Number.isFinite(parsed.amount)
        ? parsed.amount
        : null,
      p_reported_currency: typeof parsed.currency === 'string' ? parsed.currency : null,
      p_payload: parsed.raw ?? null,
    },
  };
}

/**
 * The wall-clock ceiling on one SQL call.
 *
 * @param {string} fn one of {@link RPC_NAMES}
 * @returns {number} milliseconds
 */
export function rpcTimeoutMs(fn) {
  return fn === 'refund_payment' ? REFUND_TIMEOUT_MS : FULFIL_TIMEOUT_MS;
}

/**
 * The PostgREST RPC URL for one of this function's three SQL calls.
 *
 * The name is checked against {@link RPC_NAMES} rather than interpolated as
 * given: the only caller passes a value from {@link RPC_BY_OUTCOME}, and keeping
 * the set closed means no webhook payload can ever influence which function the
 * service role invokes.
 *
 * @param {string} supabaseUrl project URL
 * @param {string} fn SQL function name
 * @returns {string} absolute PostgREST URL
 */
export function rpcUrl(supabaseUrl, fn) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new TypeError('rpcUrl requires the project URL');
  }
  if (!RPC_NAMES.includes(fn)) {
    throw new WebhookDispatchError('unknown_function', `Refusing to call "${fn}".`);
  }

  const base = supabaseUrl.trim().replace(/\/+$/, '');
  return `${base}/rest/v1/rpc/${fn}`;
}

/**
 * Did this call settle, or did it fault?
 *
 * The whole retry contract turns on this one decision, and it runs in the
 * direction the SQL functions were written for: **every branch of
 * `fulfil_payment`, `refund_payment`, and `fail_payment` returns normally**, so
 * an incident recorded for an unmatched payment, an amount mismatch, an
 * out-of-order failure, or a replay all arrive here as a returned outcome with a
 * committed transaction behind them. Those are settled. HTTP 200
 * (Requirements 15.3, 15.4, 16.4, 16.5, 16.9, 16.10, 17.7, 17.8).
 *
 * A fault looks different: the function raised, Postgres rolled the whole body
 * back, and PostgREST answered with an error instead of a jsonb object. Nothing
 * was written, so HitPay must try again. HTTP 5xx (Requirement 16.3, 17.12).
 *
 * Getting this backwards in either direction is expensive. Answering 5xx to a
 * settled incident invites HitPay to redeliver a call that will never succeed;
 * answering 200 to a rolled-back transaction loses a payment silently. Hence the
 * rule stated positively: a jsonb object carrying an `outcome` string is a
 * commit, whatever the outcome says, and anything else is a fault.
 *
 * @param {unknown} result parsed PostgREST response body
 * @returns {{status: number, outcome: string|null, recognised: boolean, orderId: string|null}}
 */
export function statusForRpcResult(result) {
  // A jsonb-returning function answers with the object itself; a single-element
  // array is tolerated for the same reason postgrest.mjs tolerates one.
  const body = Array.isArray(result) && result.length === 1 ? result[0] : result;

  if (!isPlainObject(body) || typeof body.outcome !== 'string' || body.outcome.trim() === '') {
    return { status: 500, outcome: null, recognised: false, orderId: null };
  }

  const outcome = body.outcome.trim();
  const recognised = Object.values(SETTLED_OUTCOMES).some((list) => list.includes(outcome));
  const orderId = typeof body.order_id === 'string' && body.order_id !== '' ? body.order_id : null;

  return { status: 200, outcome, recognised, orderId };
}

/** The fields a rejection log line may carry. Everything else is excluded. */
export const REJECTION_LOG_FIELDS = Object.freeze([
  'event',
  'reason',
  'payment_id',
  'event_name',
  'body_bytes',
]);

/**
 * The log entry for a delivery this function refused (Requirement 14.5).
 *
 * Carries the reported payment identifier, so the owner can line a forged or
 * misconfigured delivery up against a real order, and the event name, so a
 * wrong-salt endpoint is distinguishable from a genuine forgery attempt. It
 * carries no body text and no header values, and it cannot carry the salt: this
 * module never receives one.
 *
 * The identifier is read out of an **unverified** body, which is safe because
 * reading it touches no database row and grants nothing — Requirement 14
 * criterion 1's "before reading or writing any Database row" is about the
 * database, and this is a string headed for a log line.
 *
 * @param {string} rawBody exact bytes posted
 * @param {Headers|Record<string,string>|null} [headers] event headers
 * @param {string} [reason] why the call was refused
 * @returns {{event: string, reason: string, payment_id: string|null, event_name: string|null, body_bytes: number}}
 */
export function rejectionLogEntry(rawBody, headers = null, reason = 'signature_mismatch') {
  const raw = typeof rawBody === 'string' ? rawBody : '';

  let body = null;
  try {
    const parsed = JSON.parse(raw);
    body = isPlainObject(parsed) ? parsed : null;
  } catch {
    body = null;
  }

  const eventName = body ? eventNameFrom(body, headers) : eventNameFrom(null, headers);

  return {
    event: 'hitpay_webhook_rejected',
    reason,
    payment_id: body ? paymentIdFrom(body, eventName) : null,
    event_name: eventName,
    body_bytes: raw.length,
  };
}
