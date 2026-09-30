/* tests/create-payment.test.mjs — unit tests for create-payment's decisions.
 *
 * The handler itself (supabase/functions/create-payment/index.ts) is TypeScript
 * running under Deno, which is not installed here, so everything that decides an
 * outcome lives in the pure module next to it — request reading, the order row,
 * the product judgement, the redirect target — and that is what this file
 * exercises, the same split tests/auth-gate.test.mjs uses for the gates.
 *
 * Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.2, 12.4, 12.5.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  buildOrderRow,
  ENROLLED_VIEW_PATH,
  enrolledRedirectUrl,
  enrollmentQueryUrl,
  failedPatch,
  firstRow,
  hasEnrollment,
  ORDER_CURRENCY,
  ORDER_STATUS_FAILED,
  ORDER_STATUS_PENDING,
  orderPurpose,
  orderUpdateUrl,
  ordersInsertUrl,
  OrderRequestInvalid,
  paymentPatch,
  productQueryUrl,
  purchasableProduct,
  readOrderIntent,
  REF_CODE_MAX_LENGTH,
  resolveSiteBaseUrl,
  sanitiseRefCode,
  webhookUrlFor,
} from '../supabase/functions/create-payment/orders.mjs';

const PROJECT_URL = 'https://abcdefghijklmnop.supabase.co';
const SITE_URL = 'https://archprep.ph';

function productRow(overrides = {}) {
  return {
    id: randomUUID(),
    price_php: 499,
    published: true,
    title: 'Structural Design Reviewer',
    ...overrides,
  };
}

function invalidIntent(body) {
  try {
    readOrderIntent(body);
  } catch (error) {
    assert.ok(error instanceof OrderRequestInvalid, `expected OrderRequestInvalid, got ${error}`);
    return error;
  }
  assert.fail('expected the request to be rejected');
}

// ---------------------------------------------------------------------------
// What the request may contribute (Requirements 11.2, 11.5)

test('reads the product id and the referral code, and nothing else', () => {
  const productId = randomUUID();
  const intent = readOrderIntent({ product_id: productId, ref_code: 'KX7M2PQR' });

  assert.deepEqual(intent, { productId, refCode: 'KX7M2PQR' });
});

test('an amount, a price, or a currency in the body is not read at all', () => {
  const productId = randomUUID();
  const intent = readOrderIntent({
    product_id: productId,
    amount: 1,
    amount_php: 1,
    price: 1,
    price_php: 1,
    currency: 'USD',
    status: 'paid',
    user_id: randomUUID(),
    email: 'someone.else@example.com',
  });

  assert.deepEqual(Object.keys(intent).sort(), ['productId', 'refCode']);
  assert.equal(intent.productId, productId);
  assert.equal(intent.refCode, null);
});

test('a missing or malformed product id is a validation failure', () => {
  for (const body of [
    null,
    undefined,
    'product',
    [],
    {},
    { product_id: '' },
    { product_id: 'not-a-uuid' },
    { product_id: 42 },
    { product_id: randomUUID().slice(0, -1) },
  ]) {
    assert.equal(invalidIntent(body).field, 'product_id');
  }
});

test('a surrounding-whitespace product id is accepted trimmed', () => {
  const productId = randomUUID();
  assert.equal(readOrderIntent({ product_id: `  ${productId}\n` }).productId, productId);
});

// ---------------------------------------------------------------------------
// Referral code (Requirement 11.5)

test('a supplied referral code is stored as submitted, trimmed', () => {
  assert.equal(sanitiseRefCode('KX7M2PQR'), 'KX7M2PQR');
  assert.equal(sanitiseRefCode('  KX7M2PQR  '), 'KX7M2PQR');
  // Case is preserved: the stored value has to equal the code the buyer arrived
  // with, which is what the referrer sees in their own ledger.
  assert.equal(sanitiseRefCode('kx7m2pqr'), 'kx7m2pqr');
});

test('an absent, blank, oversized, or non-string referral code becomes null', () => {
  for (const value of [
    undefined,
    null,
    '',
    '   ',
    42,
    {},
    ['KX7M2PQR'],
    'X'.repeat(REF_CODE_MAX_LENGTH + 1),
  ]) {
    assert.equal(sanitiseRefCode(value), null);
  }
});

// ---------------------------------------------------------------------------
// The product decision (Requirements 11.1, 11.3)

test('a published product with a positive price is purchasable', () => {
  const row = productRow();
  assert.deepEqual(purchasableProduct([row]), {
    id: row.id,
    pricePhp: 499,
    title: 'Structural Design Reviewer',
  });
});

test('an absent, unpublished, or unpriced product is not purchasable', () => {
  assert.equal(purchasableProduct([]), null, 'absent row');
  assert.equal(purchasableProduct(null), null, 'null body');
  assert.equal(purchasableProduct([productRow({ published: false })]), null, 'unpublished');
  assert.equal(purchasableProduct([productRow({ published: 'true' })]), null, 'string flag');
  assert.equal(purchasableProduct([productRow({ price_php: 0 })]), null, 'zero price');
  assert.equal(purchasableProduct([productRow({ price_php: -100 })]), null, 'negative price');
  assert.equal(purchasableProduct([productRow({ price_php: null })]), null, 'null price');
  assert.equal(purchasableProduct([productRow({ price_php: 'free' })]), null, 'unparseable price');
});

test('a numeric price arriving as a PostgREST string still resolves', () => {
  const product = purchasableProduct([productRow({ price_php: '499' })]);
  assert.equal(product.pricePhp, 499);
});

// ---------------------------------------------------------------------------
// Already owned (Requirement 11.6)

test('an enrollment row means the product is already owned', () => {
  assert.equal(hasEnrollment([{ id: randomUUID() }]), true);
});

test('no enrollment row means the purchase may proceed', () => {
  for (const body of [[], null, undefined, {}, [{}], [{ id: null }], [{ id: '' }]]) {
    assert.equal(hasEnrollment(body), false);
  }
});

// ---------------------------------------------------------------------------
// The order row (Requirement 11.4)

test('the order row carries the database price, PHP, pending, and the uid', () => {
  const uid = randomUUID();
  const row = productRow({ price_php: 1499 });
  const product = purchasableProduct([row]);

  const order = buildOrderRow({ uid, product, refCode: 'KX7M2PQR' });

  assert.deepEqual(order, {
    user_id: uid,
    product_id: row.id,
    amount_php: 1499,
    currency: 'PHP',
    status: 'pending',
    ref_code: 'KX7M2PQR',
  });
  assert.equal(ORDER_CURRENCY, 'PHP');
  assert.equal(ORDER_STATUS_PENDING, 'pending');
});

test('the order row has no channel for a request-supplied amount or currency', () => {
  const uid = randomUUID();
  const product = purchasableProduct([productRow({ price_php: 750 })]);

  // Anything extra handed to the builder is ignored: the row is assembled from
  // the product and the uid alone (Requirement 11.2).
  const order = buildOrderRow({
    uid,
    product: { ...product, amount_php: 1, currency: 'USD', status: 'paid' },
    refCode: null,
  });

  assert.equal(order.amount_php, 750);
  assert.equal(order.currency, 'PHP');
  assert.equal(order.status, 'pending');
  assert.equal(order.ref_code, null);
});

test('the order row refuses an unverified uid or an unpriced product', () => {
  const product = purchasableProduct([productRow()]);

  assert.throws(() => buildOrderRow({ uid: 'me', product }), TypeError);
  assert.throws(() => buildOrderRow({ uid: randomUUID(), product: null }), TypeError);
  assert.throws(
    () => buildOrderRow({ uid: randomUUID(), product: { ...product, pricePhp: 0 } }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// Service-role URLs

test('the product read asks for the price and publish state of one row', () => {
  const productId = randomUUID();
  const url = new URL(productQueryUrl(PROJECT_URL, productId));

  assert.equal(url.pathname, '/rest/v1/products');
  assert.equal(url.searchParams.get('id'), `eq.${productId}`);
  assert.equal(url.searchParams.get('limit'), '1');
  assert.deepEqual(url.searchParams.get('select').split(','), [
    'id',
    'price_php',
    'published',
    'title',
  ]);
});

test('the enrollment read is scoped to the verified uid and the product', () => {
  const uid = randomUUID();
  const productId = randomUUID();
  const url = new URL(enrollmentQueryUrl(PROJECT_URL, uid, productId));

  assert.equal(url.pathname, '/rest/v1/enrollments');
  assert.equal(url.searchParams.get('user_id'), `eq.${uid}`);
  assert.equal(url.searchParams.get('product_id'), `eq.${productId}`);
  assert.equal(url.searchParams.get('select'), 'id');
});

test('the order URLs target orders, and the update targets one id', () => {
  const orderId = randomUUID();

  assert.equal(new URL(ordersInsertUrl(`${PROJECT_URL}/`)).pathname, '/rest/v1/orders');

  const update = new URL(orderUpdateUrl(PROJECT_URL, orderId));
  assert.equal(update.pathname, '/rest/v1/orders');
  assert.equal(update.searchParams.get('id'), `eq.${orderId}`);
});

test('the service-role URLs refuse an unverified id', () => {
  assert.throws(() => productQueryUrl(PROJECT_URL, 'all'), TypeError);
  assert.throws(() => enrollmentQueryUrl(PROJECT_URL, 'me', randomUUID()), TypeError);
  assert.throws(() => orderUpdateUrl(PROJECT_URL, 'all'), TypeError);
  assert.throws(() => ordersInsertUrl(''), TypeError);
});

test('firstRow takes the single row of a PostgREST body', () => {
  assert.deepEqual(firstRow([{ id: 'a' }, { id: 'b' }]), { id: 'a' });
  assert.deepEqual(firstRow({ id: 'a' }), { id: 'a' });
  assert.equal(firstRow([]), null);
  assert.equal(firstRow('a'), null);
});

// ---------------------------------------------------------------------------
// Patches (Requirements 12.2, 12.4)

test('the payment patch stores the HitPay identifiers', () => {
  assert.deepEqual(paymentPatch({ paymentId: 'pay_123', reference: 'ref_456' }), {
    hitpay_payment_id: 'pay_123',
    hitpay_reference: 'ref_456',
  });
  assert.deepEqual(paymentPatch({ paymentId: 'pay_123', reference: null }), {
    hitpay_payment_id: 'pay_123',
    hitpay_reference: null,
  });
});

test('the failure patch sets the order to failed and touches nothing else', () => {
  assert.deepEqual(failedPatch(), { status: 'failed' });
  assert.equal(ORDER_STATUS_FAILED, 'failed');
});

// ---------------------------------------------------------------------------
// Where the buyer goes next (Requirement 12.5)

test('the redirect points at the enrolled-confirmation view for that order', () => {
  const orderId = randomUUID();
  const url = new URL(enrolledRedirectUrl(SITE_URL, orderId));

  assert.equal(url.origin, SITE_URL);
  assert.equal(url.pathname, `/${ENROLLED_VIEW_PATH}`);
  assert.equal(url.searchParams.get('order'), orderId);
});

test('a site base URL with a trailing slash or a sub-path still resolves', () => {
  const orderId = randomUUID();

  assert.equal(
    enrolledRedirectUrl(`${SITE_URL}/`, orderId),
    `${SITE_URL}/${ENROLLED_VIEW_PATH}?order=${orderId}`,
  );
  assert.equal(
    enrolledRedirectUrl(`${SITE_URL}/app/`, orderId),
    `${SITE_URL}/app/${ENROLLED_VIEW_PATH}?order=${orderId}`,
  );
});

test('the site origin falls back to the first usable allowed origin', () => {
  assert.equal(
    resolveSiteBaseUrl({ siteBaseUrl: SITE_URL, corsAllowedOrigins: 'https://other.example' }),
    SITE_URL,
    'the explicit variable wins',
  );
  assert.equal(
    resolveSiteBaseUrl({ corsAllowedOrigins: 'https://archprep.ph,https://www.archprep.ph' }),
    SITE_URL,
  );
  assert.equal(
    resolveSiteBaseUrl({ corsAllowedOrigins: '*, http://localhost:*, https://archprep.ph' }),
    SITE_URL,
    'a wildcard is not an address a browser can be sent to',
  );
});

test('no usable site origin resolves to null rather than a guess', () => {
  for (const env of [
    {},
    { siteBaseUrl: '' },
    { siteBaseUrl: 'archprep.ph' },
    { siteBaseUrl: 'ftp://archprep.ph' },
    { corsAllowedOrigins: 'http://localhost:*' },
    { corsAllowedOrigins: '*' },
  ]) {
    assert.equal(resolveSiteBaseUrl(env), null);
  }
  assert.throws(() => enrolledRedirectUrl(null, randomUUID()), TypeError);
});

test('the webhook URL is derived from the project URL', () => {
  assert.equal(
    webhookUrlFor(`${PROJECT_URL}/`),
    `${PROJECT_URL}/functions/v1/hitpay-webhook`,
  );
  assert.throws(() => webhookUrlFor(''), TypeError);
});

test('the checkout purpose uses the product title when there is one', () => {
  assert.equal(orderPurpose({ title: 'Structural Design Reviewer' }), 'Structural Design Reviewer');
  assert.equal(orderPurpose({ title: '   ' }), 'ArchPrep PH purchase');
  assert.equal(orderPurpose(null), 'ArchPrep PH purchase');
});
