/* supabase/functions/_shared/hitpay.mjs — HitPay's wire format, as pure logic.
 *
 * Three jobs, none of which touch the network or the environment:
 *
 *   resolveHitpayUrl()      the documented endpoint path against the configured
 *                           base URL (Requirement 13.4, Property 36)
 *   verifyHitpaySignatureHex()  HMAC-SHA256 over the raw body, constant-time
 *                           compare (Requirement 14.1, 14.3, 14.4)
 *   parseHitpayPayload()    one normalised outcome out of whatever arrived
 *
 * Why this file is `.mjs` and not part of hitpay.ts: exactly the reason
 * scrub.mjs and jwt.mjs are. Everything here is a function of its arguments
 * over WebCrypto only — no `Deno.env`, no `fetch` — so `tests/hitpay.test.mjs`
 * exercises it under `node --test` while Deno loads the same file at the edge.
 * hitpay.ts owns the impure half: reading `HITPAY_*` out of the environment and
 * making the outbound call.
 *
 * Wire format, from the official docs (Requirement 13.2 and 13.4 forbid
 * guessing, so nothing here is inferred):
 *
 *   POST {base}/v1/payment-requests, `X-BUSINESS-API-KEY` header; the response
 *   carries `id`, `url`, `reference_number`, `amount`, `currency`, `status`
 *   (https://docs.hitpayapp.com/apis/payment-request/create-request).
 *
 *   Event webhooks sign the raw JSON body with the endpoint's own salt and send
 *   the digest in the `Hitpay-Signature` header; `Hitpay-Event-Object` names the
 *   object type (https://docs.hitpayapp.com/apis/guide/events).
 *
 *   Philippine method enums are `gcash` for the GCash redirect and
 *   `qrph_netbank` for QR Ph
 *   (https://docs.hitpayapp.com/apis/guide/payment-methods-reference,
 *   https://docs.hitpayapp.com/apis/guide/embedded-qr-code-payments/domestic-qr).
 *
 * Content was rephrased for compliance with licensing restrictions.
 *
 * Zero base URLs are hardcoded anywhere in this file (Requirement 13.2): the
 * sandbox and live hosts differ by environment value only (Requirement 13.7).
 */

/** Environment variables the HitPay adapter reads. Names only, never values. */
export const HITPAY_ENV_NAMES = Object.freeze([
  'HITPAY_API_KEY',
  'HITPAY_WEBHOOK_SALT',
  'HITPAY_API_BASE_URL',
]);

/** The two variables a payment-request call cannot proceed without (13.5). */
export const PAYMENT_REQUEST_ENV_NAMES = Object.freeze([
  'HITPAY_API_KEY',
  'HITPAY_API_BASE_URL',
]);

/** Documented create-payment-request path, resolved against the configured base. */
export const PAYMENT_REQUEST_PATH = 'v1/payment-requests';

/** Header carrying the business API key. */
export const API_KEY_HEADER = 'X-BUSINESS-API-KEY';

/** Header carrying the event-webhook signature. */
export const SIGNATURE_HEADER = 'Hitpay-Signature';

/** Requirement 12.4's ceiling on the outbound call. */
export const HITPAY_TIMEOUT_MS = 15_000;

/** GCash and QR Ph, the two methods Requirement 12.1 names. */
export const PHP_PAYMENT_METHODS = Object.freeze(['gcash', 'qrph_netbank']);

/** Currency every order is priced in (Requirement 11.4). */
export const ORDER_CURRENCY = 'PHP';

/** A malformed configuration value or an unusable upstream response. */
export class HitpayWireError extends Error {
  /**
   * @param {'invalid_base_url'|'invalid_amount'|'malformed_response'} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = 'HitpayWireError';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* URL resolution                                                             */
/* -------------------------------------------------------------------------- */

function splitSegments(path) {
  return String(path)
    .split('/')
    .filter((segment) => segment !== '');
}

/**
 * Join the configured base URL to a documented endpoint path.
 *
 * Property 36: exactly one separator, and no duplicated path segment. A base
 * written as `https://host`, `https://host/`, and `https://host/v1` all resolve
 * to the same URL for the `v1/payment-requests` path, because any trailing
 * segments of the base that already spell the head of the path are consumed
 * rather than repeated. That is what makes the sandbox-to-live switch a pure
 * environment change (Requirement 13.7): whatever spelling the owner pastes in,
 * the path lands exactly once.
 *
 * @param {string} baseUrl value of HITPAY_API_BASE_URL
 * @param {string} [path] documented endpoint path
 * @returns {string} absolute URL
 * @throws {HitpayWireError} when the base URL is unusable
 */
export function resolveHitpayUrl(baseUrl, path = PAYMENT_REQUEST_PATH) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new HitpayWireError('invalid_base_url', 'HITPAY_API_BASE_URL is empty.');
  }

  let base;
  try {
    base = new URL(baseUrl.trim());
  } catch {
    throw new HitpayWireError('invalid_base_url', 'HITPAY_API_BASE_URL is not a valid URL.');
  }

  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    // http is tolerated so a local mock can stand in for HitPay; anything else
    // (file:, data:) is a configuration mistake, not an endpoint.
    throw new HitpayWireError('invalid_base_url', 'HITPAY_API_BASE_URL must be an http(s) URL.');
  }

  const baseSegments = splitSegments(base.pathname);
  const pathSegments = splitSegments(path);

  // Consume the longest overlap between the tail of the base and the head of
  // the path, so `…/v1` + `v1/payment-requests` never becomes `…/v1/v1/…`.
  let overlap = Math.min(baseSegments.length, pathSegments.length);
  while (overlap > 0) {
    const tail = baseSegments.slice(baseSegments.length - overlap).join('/');
    const head = pathSegments.slice(0, overlap).join('/');
    if (tail === head) break;
    overlap -= 1;
  }

  const segments = [...baseSegments, ...pathSegments.slice(overlap)];
  const resolved = new URL(base.origin);
  resolved.pathname = `/${segments.join('/')}`;
  return resolved.toString();
}

/* -------------------------------------------------------------------------- */
/* Payment-request body                                                       */
/* -------------------------------------------------------------------------- */

const AMOUNT_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * A decimal amount as a number, or null when the value is absent or unusable.
 *
 * Accepts the string form HitPay reports (`"900.00"`) and the number form it
 * sometimes reports (`913.84`). Rejects `NaN`, the infinities, exponent
 * notation, and anything else, because Requirement 15.3 treats an unparseable
 * amount as a mismatch rather than as a zero.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function toDecimalOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!AMOUNT_PATTERN.test(trimmed)) return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Two-decimal string, the spelling HitPay's own examples use for `amount`. */
export function formatAmount(value) {
  const amount = toDecimalOrNull(value);
  if (amount === null) {
    throw new HitpayWireError('invalid_amount', 'Order amount is not a decimal number.');
  }
  return (Math.round(amount * 100) / 100).toFixed(2);
}

/**
 * The JSON body of a create-payment-request call.
 *
 * `amount` is derived from the caller's value, which `create-payment` reads from
 * `products.price_php` — Requirement 11.1 keeps the browser out of it, and this
 * function has no access to a request body to be tempted by.
 *
 * @param {{
 *   amountPhp: number|string,
 *   referenceNumber?: string|null,
 *   redirectUrl?: string|null,
 *   webhookUrl?: string|null,
 *   purpose?: string|null,
 *   email?: string|null,
 *   name?: string|null,
 *   currency?: string,
 *   paymentMethods?: readonly string[],
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildPaymentRequestBody({
  amountPhp,
  referenceNumber = null,
  redirectUrl = null,
  webhookUrl = null,
  purpose = null,
  email = null,
  name = null,
  currency = ORDER_CURRENCY,
  paymentMethods = PHP_PAYMENT_METHODS,
} = {}) {
  /** @type {Record<string, unknown>} */
  const body = {
    amount: formatAmount(amountPhp),
    currency,
    payment_methods: [...paymentMethods],
  };

  if (referenceNumber) body.reference_number = String(referenceNumber).slice(0, 255);
  // Requirement 12.5: HitPay sends the buyer here after payment.
  if (redirectUrl) body.redirect_url = String(redirectUrl);
  if (webhookUrl) body.webhook = String(webhookUrl);
  if (purpose) body.purpose = String(purpose).slice(0, 255);
  if (email) body.email = String(email);
  if (name) body.name = String(name);

  return body;
}

/**
 * The three fields the Order needs out of a create-payment-request response
 * (Requirement 12.2): the payment identifier, the reference, the checkout URL.
 *
 * @param {unknown} payload parsed response JSON
 * @returns {{paymentId: string, reference: string|null, checkoutUrl: string, status: string|null, raw: unknown}}
 * @throws {HitpayWireError} when either required field is absent
 */
export function parsePaymentRequestResponse(payload) {
  const body = isPlainObject(payload) ? payload : null;
  const paymentId = body && typeof body.id === 'string' ? body.id.trim() : '';
  const checkoutUrl = body && typeof body.url === 'string' ? body.url.trim() : '';

  if (paymentId === '' || checkoutUrl === '') {
    throw new HitpayWireError(
      'malformed_response',
      'HitPay did not return a payment identifier and a checkout URL.',
    );
  }

  return {
    paymentId,
    reference: typeof body.reference_number === 'string' && body.reference_number !== ''
      ? body.reference_number
      : null,
    checkoutUrl,
    status: typeof body.status === 'string' ? body.status : null,
    raw: body,
  };
}

/* -------------------------------------------------------------------------- */
/* Signature verification                                                     */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder();

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * HMAC-SHA256 of the raw body under the webhook salt, lower-case hex.
 *
 * The body is signed as received. Re-serialising a parsed object would change a
 * byte somewhere — key order, spacing, unicode escaping — and the digest with
 * it, which is why hitpay-webhook reads `req.text()` before anything else.
 *
 * @param {string} rawBody exact bytes HitPay posted
 * @param {string} salt HITPAY_WEBHOOK_SALT
 * @returns {Promise<string>} 64 lower-case hex characters
 */
export async function hitpaySignatureHex(rawBody, salt) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(salt ?? '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(String(rawBody ?? '')));
  return toHex(mac);
}

/**
 * Constant-time string compare (Requirement 14.4).
 *
 * Unequal lengths return early, which leaks only the length of the supplied
 * value — the correct digest is always 64 hex characters, so its length is
 * public. Equal-length inputs are compared with a full XOR sweep: every byte is
 * examined whatever the first mismatch, so the time taken carries no
 * information about *where* a forged digest went wrong.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeEquals(a, b) {
  const left = encoder.encode(String(a ?? ''));
  const right = encoder.encode(String(b ?? ''));
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

/**
 * Whether a supplied signature matches the body under the salt.
 *
 * **Case-sensitive, deliberately.** The digest is compared against the
 * lower-case hex spelling HitPay produces, so an upper-cased digest is
 * rejected. Two reasons, and they agree:
 *
 *  1. HitPay's own published validation snippet compares the computed digest to
 *     the header with PHP's `hash_equals`, which is byte-for-byte. Accepting a
 *     casing HitPay never sends would make this check looser than the vendor's.
 *  2. Property 13 in design.md requires "a differently-cased digest" to be
 *     rejected, and `tests/generators.mjs` marks its `uppercase` signature
 *     variant `signatureIsValid: false`.
 *
 * design.md's inline sketch of this function lower-cases the supplied value
 * before comparing, which would accept that variant; that sketch contradicts its
 * own Property 13, and Property 13 wins. Surrounding whitespace is still
 * trimmed, since HTTP header parsing strips it anyway — trimming changes no
 * digit, only padding.
 *
 * Returns `false` for an absent header rather than throwing (Requirement 14.3):
 * "no signature" and "wrong signature" are the same rejection.
 *
 * @param {string} rawBody
 * @param {string|null|undefined} suppliedSignature
 * @param {string} salt
 * @returns {Promise<boolean>}
 */
export async function verifyHitpaySignatureHex(rawBody, suppliedSignature, salt) {
  if (typeof suppliedSignature !== 'string' || suppliedSignature.trim() === '') return false;
  if (typeof salt !== 'string' || salt === '') return false;

  const expected = await hitpaySignatureHex(rawBody, salt);
  return constantTimeEquals(expected, suppliedSignature.trim());
}

/* -------------------------------------------------------------------------- */
/* Payload normalisation                                                      */
/* -------------------------------------------------------------------------- */

/** The normalised outcomes hitpay-webhook dispatches on. */
export const OUTCOMES = Object.freeze(['completed', 'refunded', 'failed', 'ignored']);

/** Object types this platform has any interest in. */
const RELEVANT_OBJECTS = Object.freeze(['charge', 'payment_request', 'payment']);

/** Statuses that mean money came back out. */
const REFUND_STATUSES = Object.freeze(['refunded', 'partially_refunded', 'partial_refund', 'refund']);

/** Statuses that mean the payment will never complete. */
const FAILURE_STATUSES = Object.freeze(['failed', 'failure', 'error', 'expired', 'canceled', 'cancelled']);

/** Statuses that mean the payment settled. `succeeded` is the charge spelling. */
const SUCCESS_STATUSES = Object.freeze(['completed', 'succeeded', 'success', 'paid']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerLookup(headers) {
  if (!headers) return () => null;
  if (typeof headers.get === 'function') return (name) => headers.get(name);

  const lowered = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return (name) => lowered.get(name.toLowerCase()) ?? null;
}

/**
 * The event name, lower-cased, or null when nothing says what this is.
 *
 * `event_type` in the body is preferred because it is self-contained. Failing
 * that, the headers name the event: `Hitpay-Event-Object` carries the object
 * type and `Hitpay-Event-Type` the action, so `charge` + `created` spells
 * `charge.created`. A `Hitpay-Event-Type` that already contains a dot is taken
 * whole rather than concatenated.
 */
export function eventNameFrom(body, headers) {
  const fromBody = isPlainObject(body)
    ? [body.event_type, body.event, body.type].find((value) => typeof value === 'string' && value.trim() !== '')
    : undefined;
  if (fromBody) return fromBody.trim().toLowerCase();

  const header = headerLookup(headers);
  const action = header('Hitpay-Event-Type');
  const object = header('Hitpay-Event-Object');

  if (typeof action === 'string' && action.includes('.')) return action.trim().toLowerCase();
  if (typeof object === 'string' && object.trim() !== '' && typeof action === 'string' && action.trim() !== '') {
    return `${object.trim().toLowerCase()}.${action.trim().toLowerCase()}`;
  }
  if (typeof object === 'string' && object.trim() !== '') return object.trim().toLowerCase();
  return null;
}

/**
 * The payment-request identifier the Order was stored with (Requirement 15.1).
 *
 * `orders.hitpay_payment_id` holds the `id` of the payment request created at
 * checkout, so that is the field to recover — not a charge id, which identifies
 * a different object and matches no order. Hence the priority: an explicit
 * `payment_request_id`, then a nested `payment_request.id`, then `id` when the
 * payload *is* a payment request, then the legacy `payment_id`. A bare `id` is
 * accepted only when nothing identifies the object as a charge.
 */
export function paymentIdFrom(body, eventName = null) {
  if (!isPlainObject(body)) return null;

  const objectType = typeof eventName === 'string' ? eventName.split('.')[0] : null;
  const candidates = [
    body.payment_request_id,
    isPlainObject(body.payment_request) ? body.payment_request.id : undefined,
    objectType === 'payment_request' ? body.id : undefined,
    body.payment_id,
    objectType === 'charge' ? undefined : body.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

function classify(body, eventName) {
  const objectType = eventName ? eventName.split('.')[0] : null;
  const action = eventName ? eventName.split('.').slice(1).join('.') : null;

  // An event about something else entirely — a payout, an order, a transfer —
  // is ignored before any field of it is trusted, so unrelated event types
  // registered on the same endpoint disturb no order.
  if (objectType && !RELEVANT_OBJECTS.includes(objectType)) {
    return { outcome: 'ignored', reason: `unhandled_event:${eventName}` };
  }

  const status = typeof body.status === 'string' ? body.status.trim().toLowerCase() : null;
  const refundedAmount = toDecimalOrNull(body.refunded_amount);

  if (status && REFUND_STATUSES.includes(status)) return { outcome: 'refunded' };
  if (refundedAmount !== null && refundedAmount > 0) return { outcome: 'refunded' };
  if (body.refunded_at !== undefined && body.refunded_at !== null) return { outcome: 'refunded' };

  if (action === 'failed' || (status && FAILURE_STATUSES.includes(status))) {
    return { outcome: 'failed' };
  }

  // `charge.updated` is HitPay's refund signal; a charge that merely settled
  // arrives as `charge.created`.
  if (objectType === 'charge' && action === 'updated') return { outcome: 'refunded' };

  if (status && SUCCESS_STATUSES.includes(status)) return { outcome: 'completed' };

  // Pending, or a status this platform has no rule for: no writes, HTTP 200.
  return { outcome: 'ignored', reason: status ? `unhandled_status:${status}` : 'no_status' };
}

/**
 * One normalised outcome from a raw webhook body.
 *
 * ```js
 * { status: 'completed', paymentId, amount, currency, eventName, raw }
 * { status: 'refunded',  paymentId, amount, currency, eventName, raw }
 * { status: 'failed',    paymentId, amount, currency, eventName, raw }
 * { status: 'ignored',   reason, eventName, raw }
 * ```
 *
 * The vocabulary is what task 8.3 dispatches on: `completed` → `fulfil_payment`,
 * `refunded` → `refund_payment`, `failed` → `fail_payment`, `ignored` → HTTP 200
 * with zero writes.
 *
 * `amount` and `currency` are `null` when absent or unparseable rather than
 * coerced to a zero or an empty string, because `fulfil_payment` treats a null
 * as a mismatch and records an incident (Requirements 15.3 and 15.4) — a
 * coerced value would be indistinguishable from a real reported one. The
 * reported currency is passed through **verbatim**, casing and padding intact:
 * the SQL side owns the trim-and-upper comparison, and the incident record is
 * evidence, so it should say what actually arrived.
 *
 * Call this only after the signature verified. It parses, it does not trust.
 *
 * @param {string} rawBody
 * @param {Headers|Record<string,string>|null} [headers] optional event headers
 * @returns {{status: string, paymentId?: string, amount?: number|null, currency?: string|null, eventName: string|null, reason?: string, raw: unknown}}
 */
export function parseHitpayPayload(rawBody, headers = null) {
  let parsed;
  try {
    parsed = JSON.parse(typeof rawBody === 'string' ? rawBody : String(rawBody ?? ''));
  } catch {
    return { status: 'ignored', reason: 'unparseable_body', eventName: null, raw: null };
  }

  if (!isPlainObject(parsed)) {
    return { status: 'ignored', reason: 'unexpected_body_shape', eventName: null, raw: null };
  }

  const eventName = eventNameFrom(parsed, headers);
  const { outcome, reason } = classify(parsed, eventName);

  if (outcome === 'ignored') {
    return { status: 'ignored', reason, eventName, raw: parsed };
  }

  const paymentId = paymentIdFrom(parsed, eventName);
  if (paymentId === null) {
    // Nothing to look an order up by. Ignoring beats inventing an identifier:
    // a blank one would match no order and manufacture an incident per event.
    return { status: 'ignored', reason: 'no_payment_identifier', eventName, raw: parsed };
  }

  return {
    status: outcome,
    paymentId,
    amount: toDecimalOrNull(parsed.amount),
    currency: typeof parsed.currency === 'string' ? parsed.currency : null,
    eventName,
    raw: parsed,
  };
}
