/* tests/hitpay.test.mjs — the pure half of the HitPay adapter.
 *
 * `supabase/functions/_shared/hitpay.mjs` holds everything about HitPay's wire
 * format that is a function of its arguments: URL resolution (Requirement 13.4),
 * the request body (Requirements 12.1 and 12.5), the raw-body HMAC and its
 * constant-time compare (Requirement 14.1, 14.3, 14.4), and payload
 * normalisation. All of it runs under `node --test`. The `.ts` half around it
 * reads `Deno.env` and calls `fetch`, so it can only run at the edge — Deno is
 * not installed in this workspace.
 *
 * Deliveries come from `tests/generators.mjs` (`arbWebhookDelivery`), so the
 * adapter is checked against the same bodies, headers, and signature variants
 * the integration suites will post at the deployed function.
 *
 * The fast-check block at the end is NOT Property 13 or Property 36 — those are
 * tasks 7.4 and 7.5 and they assert on database rows and on request URLs. This
 * one is a module invariant: whatever `arbWebhookDelivery` builds, the adapter's
 * normalised outcome and its signature verdict agree with what the generator
 * says it built.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';

import {
  API_KEY_HEADER,
  buildPaymentRequestBody,
  constantTimeEquals,
  eventNameFrom,
  formatAmount,
  HITPAY_ENV_NAMES,
  HITPAY_TIMEOUT_MS,
  hitpaySignatureHex,
  HitpayWireError,
  ORDER_CURRENCY,
  parseHitpayPayload,
  parsePaymentRequestResponse,
  PAYMENT_REQUEST_ENV_NAMES,
  PAYMENT_REQUEST_PATH,
  paymentIdFrom,
  PHP_PAYMENT_METHODS,
  resolveHitpayUrl,
  SIGNATURE_HEADER,
  toDecimalOrNull,
  verifyHitpaySignatureHex,
} from '../supabase/functions/_shared/hitpay.mjs';

import { arbWebhookDelivery, hitpaySignature } from './generators.mjs';

/* A fabricated salt, shaped like the real one but authorising nothing: the
 * repository holds zero real credentials (Requirement 28.3). */
const SALT = 'fake-webhook-salt-for-tests-only';

/* Bases spelled the several ways an owner might paste them. No real HitPay host
 * appears here or in the module under test (Requirement 13.2) — the host is a
 * configuration value, and these are stand-ins for one. */
const BASE = 'https://payments.example.test';

// ---------------------------------------------------------------------------
// Configuration surface
// ---------------------------------------------------------------------------

test('the adapter names its environment variables and hardcodes no base URL', () => {
  assert.deepEqual([...HITPAY_ENV_NAMES], [
    'HITPAY_API_KEY',
    'HITPAY_WEBHOOK_SALT',
    'HITPAY_API_BASE_URL',
  ]);

  // A payment request needs the key and the base URL; the salt belongs to the
  // webhook, so it is not a precondition for create-payment (Requirement 13.5).
  assert.deepEqual([...PAYMENT_REQUEST_ENV_NAMES], ['HITPAY_API_KEY', 'HITPAY_API_BASE_URL']);

  assert.equal(PAYMENT_REQUEST_PATH, 'v1/payment-requests');
  assert.equal(API_KEY_HEADER, 'X-BUSINESS-API-KEY');
  assert.equal(SIGNATURE_HEADER, 'Hitpay-Signature');
  assert.equal(HITPAY_TIMEOUT_MS, 15_000);
  assert.equal(ORDER_CURRENCY, 'PHP');

  // Requirement 13.2: zero hardcoded HitPay base URLs in either module, so the
  // sandbox-to-live switch is an environment change only (Requirement 13.7).
  for (const file of ['hitpay.mjs', 'hitpay.ts']) {
    const source = readFileSync(new URL(`../supabase/functions/_shared/${file}`, import.meta.url), 'utf8');
    assert.ok(!/hit-pay\.com/.test(source), `${file} must not spell a HitPay API host`);
    assert.ok(!/api\.sandbox/.test(source), `${file} must not spell the sandbox host`);
  }
});

// ---------------------------------------------------------------------------
// URL resolution (Requirement 13.4)
// ---------------------------------------------------------------------------

test('resolveHitpayUrl joins the documented path to the configured base once', () => {
  const expected = `${BASE}/v1/payment-requests`;

  assert.equal(resolveHitpayUrl(BASE), expected);
  assert.equal(resolveHitpayUrl(`${BASE}/`), expected);
  assert.equal(resolveHitpayUrl(`${BASE}///`), expected);
  assert.equal(resolveHitpayUrl(`  ${BASE}  `), expected);

  // No duplicated segment when the owner pasted the base with the version on it.
  assert.equal(resolveHitpayUrl(`${BASE}/v1`), expected);
  assert.equal(resolveHitpayUrl(`${BASE}/v1/`), expected);
  assert.equal(resolveHitpayUrl(`${BASE}/v1/payment-requests`), expected);

  // A genuine prefix path is kept; only an overlap is consumed.
  assert.equal(resolveHitpayUrl(`${BASE}/gateway`), `${BASE}/gateway/v1/payment-requests`);

  // Leading slashes on the path are the caller's business, not a second separator.
  assert.equal(resolveHitpayUrl(BASE, '/v1/payment-requests'), expected);

  // Other documented paths resolve the same way.
  assert.equal(
    resolveHitpayUrl(`${BASE}/v1`, 'v1/payment-requests/abc-123'),
    `${expected}/abc-123`,
  );

  // http is tolerated so a local stand-in can serve the endpoint.
  assert.equal(resolveHitpayUrl('http://127.0.0.1:8081'), 'http://127.0.0.1:8081/v1/payment-requests');
});

test('resolveHitpayUrl rejects an unusable base URL', () => {
  for (const bad of ['', '   ', 'not a url', 'api.example.test/v1', 'file:///etc/passwd', null, undefined, 42]) {
    assert.throws(
      () => resolveHitpayUrl(bad),
      (error) => error instanceof HitpayWireError && error.reason === 'invalid_base_url',
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Payment request body (Requirements 12.1, 12.5)
// ---------------------------------------------------------------------------

test('buildPaymentRequestBody prices the order in PHP with GCash and QR Ph', () => {
  const body = buildPaymentRequestBody({
    amountPhp: 1499,
    referenceNumber: 'c0ffee00-0000-4000-8000-000000000001',
    redirectUrl: 'https://archprep.test/enrolled.html?order=c0ffee00',
    webhookUrl: 'https://project.functions.test/hitpay-webhook',
    purpose: 'Structural Design reviewer',
  });

  assert.equal(body.amount, '1499.00');
  assert.equal(body.currency, 'PHP');
  assert.deepEqual(body.payment_methods, ['gcash', 'qrph_netbank']);
  assert.deepEqual([...PHP_PAYMENT_METHODS], ['gcash', 'qrph_netbank']);
  assert.equal(body.reference_number, 'c0ffee00-0000-4000-8000-000000000001');
  assert.equal(body.redirect_url, 'https://archprep.test/enrolled.html?order=c0ffee00');
  assert.equal(body.webhook, 'https://project.functions.test/hitpay-webhook');

  // Nothing about the buyer's identity or the API key rides in the body.
  assert.equal('email' in body, false);
  assert.equal('name' in body, false);
  assert.equal(JSON.stringify(body).includes('API-KEY'), false);
});

test('buildPaymentRequestBody formats every amount to two decimals', () => {
  assert.equal(buildPaymentRequestBody({ amountPhp: 1 }).amount, '1.00');
  assert.equal(buildPaymentRequestBody({ amountPhp: '2500' }).amount, '2500.00');
  assert.equal(buildPaymentRequestBody({ amountPhp: 1499.5 }).amount, '1499.50');
  assert.equal(buildPaymentRequestBody({ amountPhp: '0.335' }).amount, '0.34');
  assert.equal(formatAmount('900.00'), '900.00');

  for (const bad of [null, undefined, '', 'free', Number.NaN, Infinity, '1e3', {}]) {
    assert.throws(
      () => buildPaymentRequestBody({ amountPhp: bad }),
      (error) => error instanceof HitpayWireError && error.reason === 'invalid_amount',
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('buildPaymentRequestBody truncates the reference and purpose to the documented maximum', () => {
  const body = buildPaymentRequestBody({
    amountPhp: 100,
    referenceNumber: 'r'.repeat(400),
    purpose: 'p'.repeat(400),
  });
  assert.equal(body.reference_number.length, 255);
  assert.equal(body.purpose.length, 255);
});

// ---------------------------------------------------------------------------
// Payment request response (Requirement 12.2)
// ---------------------------------------------------------------------------

test('parsePaymentRequestResponse takes the payment id, reference, and checkout URL', () => {
  // Shape from the documented create-payment-request response.
  const parsed = parsePaymentRequestResponse({
    id: '974ee233-bc3e-4aac-a212-15af0d155133',
    amount: '1499.00',
    currency: 'php',
    status: 'pending',
    reference_number: 'c0ffee00',
    url: 'https://checkout.example.test/payment-request/974ee233/checkout',
    redirect_url: 'https://archprep.test/enrolled.html',
  });

  assert.equal(parsed.paymentId, '974ee233-bc3e-4aac-a212-15af0d155133');
  assert.equal(parsed.reference, 'c0ffee00');
  assert.equal(parsed.checkoutUrl, 'https://checkout.example.test/payment-request/974ee233/checkout');
  assert.equal(parsed.status, 'pending');
});

test('parsePaymentRequestResponse refuses a response missing either required field', () => {
  for (const bad of [
    null,
    {},
    { id: 'abc' },
    { url: 'https://checkout.example.test/x' },
    { id: '', url: 'https://checkout.example.test/x' },
    { id: 'abc', url: '   ' },
    [{ id: 'abc', url: 'https://checkout.example.test/x' }],
  ]) {
    assert.throws(
      () => parsePaymentRequestResponse(bad),
      (error) => error instanceof HitpayWireError && error.reason === 'malformed_response',
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Signature verification (Requirements 14.1, 14.3, 14.4)
// ---------------------------------------------------------------------------

test('hitpaySignatureHex matches an independent HMAC-SHA256 of the raw body', async () => {
  const raw = JSON.stringify({ id: 'abc', amount: '10.00', currency: 'PHP', status: 'completed' });
  const digest = await hitpaySignatureHex(raw, SALT);

  assert.match(digest, /^[0-9a-f]{64}$/);
  // tests/generators.mjs signs with node:crypto; this module uses WebCrypto.
  assert.equal(digest, hitpaySignature(raw, SALT));

  // The signature covers the exact bytes: a re-serialised body is a different one.
  const reordered = JSON.stringify({ amount: '10.00', id: 'abc', currency: 'PHP', status: 'completed' });
  assert.notEqual(await hitpaySignatureHex(reordered, SALT), digest);
});

test('constantTimeEquals compares equal-length strings and refuses the rest', () => {
  assert.equal(constantTimeEquals('a1b2', 'a1b2'), true);
  assert.equal(constantTimeEquals('a1b2', 'a1b3'), false);
  assert.equal(constantTimeEquals('a1b2', 'a1b'), false);
  assert.equal(constantTimeEquals('', ''), true);
  assert.equal(constantTimeEquals('a', null), false);
  assert.equal(constantTimeEquals(null, undefined), true); // both coerce to ''
});

test('verifyHitpaySignatureHex accepts the real digest and nothing else', async () => {
  const raw = JSON.stringify({ id: 'abc', amount: '10.00', currency: 'PHP', status: 'completed' });
  const real = hitpaySignature(raw, SALT);

  assert.equal(await verifyHitpaySignatureHex(raw, real, SALT), true);
  assert.equal(await verifyHitpaySignatureHex(raw, ` ${real} `, SALT), true, 'header padding is not a digit');

  // Absent (Requirement 14.3), forged, truncated, and differently-cased digests
  // are all the same rejection (Requirement 14.2, Property 13).
  assert.equal(await verifyHitpaySignatureHex(raw, null, SALT), false);
  assert.equal(await verifyHitpaySignatureHex(raw, undefined, SALT), false);
  assert.equal(await verifyHitpaySignatureHex(raw, '', SALT), false);
  assert.equal(await verifyHitpaySignatureHex(raw, hitpaySignature(raw, `${SALT}-not-the-salt`), SALT), false);
  assert.equal(await verifyHitpaySignatureHex(raw, real.slice(0, -2), SALT), false);
  assert.equal(await verifyHitpaySignatureHex(raw, real.toUpperCase(), SALT), false);

  // A body edited in flight no longer matches its own signature.
  assert.equal(await verifyHitpaySignatureHex(`${raw} `, real, SALT), false);

  // No salt configured means no verification, never a pass.
  assert.equal(await verifyHitpaySignatureHex(raw, real, ''), false);
  assert.equal(await verifyHitpaySignatureHex(raw, real, undefined), false);
});

// ---------------------------------------------------------------------------
// Payload normalisation
// ---------------------------------------------------------------------------

test('parseHitpayPayload normalises a completed charge', () => {
  const body = {
    payment_id: 'pay_1',
    payment_request_id: '9ef68e2e-3569-4f69-9f68-04c7e4bb007c',
    reference_number: 'order-abc',
    amount: '1499.00',
    currency: 'php',
    status: 'completed',
    event_type: 'charge.created',
  };
  const parsed = parseHitpayPayload(JSON.stringify(body));

  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.paymentId, '9ef68e2e-3569-4f69-9f68-04c7e4bb007c');
  assert.equal(parsed.amount, 1499);
  // Verbatim: the SQL side owns the trim-and-upper comparison, and the incident
  // record is evidence of what actually arrived (Requirements 15.2, 15.8).
  assert.equal(parsed.currency, 'php');
  assert.deepEqual(parsed.raw, body);
});

test('parseHitpayPayload reads a real charge payload, whose own id is not the order key', () => {
  // A `charge` carries its own id plus the payment request it settles. Only the
  // latter matches `orders.hitpay_payment_id` (Requirement 15.1).
  const parsed = parseHitpayPayload(
    JSON.stringify({
      id: 'charge-9e9a3451',
      status: 'succeeded',
      currency: 'php',
      amount: 913.84,
      refunded_amount: 0,
      refunded_at: null,
      payment_request_id: 'request-9e9a344b',
      event_type: 'charge.created',
    }),
  );

  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.paymentId, 'request-9e9a344b');
  assert.equal(parsed.amount, 913.84);
});

test('parseHitpayPayload treats a refund as refunded however it is signalled', () => {
  const byStatus = parseHitpayPayload(
    JSON.stringify({ payment_request_id: 'r1', status: 'refunded', amount: '10.00', currency: 'PHP', event_type: 'charge.updated' }),
  );
  assert.equal(byStatus.status, 'refunded');
  assert.equal(byStatus.paymentId, 'r1');

  const byAmount = parseHitpayPayload(
    JSON.stringify({ payment_request_id: 'r2', status: 'succeeded', refunded_amount: '5.00', amount: '10.00', event_type: 'charge.updated' }),
  );
  assert.equal(byAmount.status, 'refunded');

  const byTimestamp = parseHitpayPayload(
    JSON.stringify({ payment_request_id: 'r3', status: 'succeeded', refunded_at: '2025-04-05T19:09:59+08:00', event_type: 'charge.updated' }),
  );
  assert.equal(byTimestamp.status, 'refunded');

  // charge.updated is HitPay's refund event even when the body says little.
  const byEvent = parseHitpayPayload(JSON.stringify({ payment_request_id: 'r4', event_type: 'charge.updated' }));
  assert.equal(byEvent.status, 'refunded');
});

test('parseHitpayPayload treats a failure as failed', () => {
  for (const status of ['failed', 'expired', 'canceled', 'cancelled']) {
    const parsed = parseHitpayPayload(JSON.stringify({ id: 'f1', status, event_type: 'payment_request.failed' }));
    assert.equal(parsed.status, 'failed', status);
    assert.equal(parsed.paymentId, 'f1');
  }

  // The event alone is enough, whatever the body's status says.
  assert.equal(
    parseHitpayPayload(JSON.stringify({ id: 'f2', status: 'pending', event_type: 'payment_request.failed' })).status,
    'failed',
  );
});

test('parseHitpayPayload ignores everything it has no rule for', () => {
  const cases = [
    [{ id: 'p1', status: 'succeeded', event_type: 'payout.created' }, 'unhandled_event:payout.created'],
    [{ id: 'o1', status: 'completed', event_type: 'order.updated' }, 'unhandled_event:order.updated'],
    [{ payment_request_id: 'x1', status: 'pending' }, 'unhandled_status:pending'],
    [{ payment_request_id: 'x2' }, 'no_status'],
  ];

  for (const [body, reason] of cases) {
    const parsed = parseHitpayPayload(JSON.stringify(body));
    assert.equal(parsed.status, 'ignored', JSON.stringify(body));
    assert.equal(parsed.reason, reason);
    assert.deepEqual(parsed.raw, body);
  }

  // A settled outcome with nothing to look an order up by is ignored rather than
  // dispatched with a blank identifier, which would manufacture an incident.
  const anonymous = parseHitpayPayload(JSON.stringify({ status: 'succeeded', event_type: 'charge.created' }));
  assert.equal(anonymous.status, 'ignored');
  assert.equal(anonymous.reason, 'no_payment_identifier');
});

test('parseHitpayPayload survives a body that is not a JSON object', () => {
  for (const [raw, reason] of [
    ['', 'unparseable_body'],
    ['{', 'unparseable_body'],
    ['not json at all', 'unparseable_body'],
    ['[]', 'unexpected_body_shape'],
    ['"a string"', 'unexpected_body_shape'],
    ['null', 'unexpected_body_shape'],
    ['7', 'unexpected_body_shape'],
  ]) {
    const parsed = parseHitpayPayload(raw);
    assert.equal(parsed.status, 'ignored', raw);
    assert.equal(parsed.reason, reason);
    assert.equal(parsed.raw, null);
  }
});

test('parseHitpayPayload reports an unusable amount or currency as absent', () => {
  const parsed = parseHitpayPayload(
    JSON.stringify({ payment_request_id: 'a1', status: 'completed', amount: 'one thousand', currency: 42, event_type: 'charge.created' }),
  );
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.amount, null, 'an unparseable amount is a mismatch, not a zero');
  assert.equal(parsed.currency, null, 'an absent currency is a mismatch, not an empty string');

  assert.equal(toDecimalOrNull('  10.50  '), 10.5);
  assert.equal(toDecimalOrNull(''), null);
  assert.equal(toDecimalOrNull(Number.NaN), null);
});

test('event headers name the event when the body does not', () => {
  // The documented payment_request.completed delivery: object and action arrive
  // in headers, and the payload's own `id` is the payment request id.
  const body = {
    id: '9c262fb5-f3cd-4187-8c3e-fbe20730b9c6',
    amount: '123.00',
    currency: 'PHP',
    status: 'completed',
    reference_number: 'REF123',
  };
  const headers = new Headers({
    'Hitpay-Event-Type': 'completed',
    'Hitpay-Event-Object': 'payment_request',
  });

  assert.equal(eventNameFrom(body, headers), 'payment_request.completed');

  const parsed = parseHitpayPayload(JSON.stringify(body), headers);
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.paymentId, '9c262fb5-f3cd-4187-8c3e-fbe20730b9c6');
  assert.equal(parsed.amount, 123);

  // A plain object of headers works too, case-insensitively.
  assert.equal(
    parseHitpayPayload(JSON.stringify(body), { 'hitpay-event-object': 'payout', 'hitpay-event-type': 'created' }).status,
    'ignored',
  );

  // Body wins when it names the event itself.
  assert.equal(eventNameFrom({ event_type: 'charge.created' }, headers), 'charge.created');
  assert.equal(eventNameFrom({}, null), null);
  assert.equal(paymentIdFrom(null), null);
});

// ---------------------------------------------------------------------------
// Module invariant over the shared generator
//
// NOT Property 13 (task 7.4) and NOT Property 36 (task 7.5): both of those
// assert on a deployed function — unchanged database rows and request URLs. This
// block only checks that the pure adapter agrees with what arbWebhookDelivery
// says it built.
// ---------------------------------------------------------------------------

test('every generated delivery normalises and verifies as the generator describes', async () => {
  await fc.assert(
    fc.asyncProperty(arbWebhookDelivery, fc.uuid(), async (delivery, paymentId) => {
      const built = delivery.build({ paymentId, storedAmount: 1499, salt: SALT });

      const verified = await verifyHitpaySignatureHex(
        built.raw,
        built.headers[SIGNATURE_HEADER] ?? null,
        SALT,
      );
      assert.equal(verified, built.signatureIsValid, `signature variant ${delivery.signature}`);

      const parsed = parseHitpayPayload(built.raw, built.headers);
      assert.equal(parsed.status, delivery.outcome, `outcome for ${delivery.eventType}`);

      if (parsed.status === 'ignored') return;

      assert.equal(parsed.paymentId, built.paymentId);
      assert.equal(parsed.amount, built.reportedAmount);
      // The reported currency reaches the SQL side exactly as it arrived.
      assert.equal(parsed.currency, typeof delivery.currency === 'string' ? delivery.currency : null);
    }),
    { numRuns: 200 },
  );
});
