/* supabase/functions/create-payment/orders.mjs — create-payment's decisions,
 * expressed as pure functions.
 *
 * Requirement 11 is a money requirement, so the parts of it that can be checked
 * without a database or a network live here rather than inside the handler:
 * which request fields are read, what the Order row contains, how a product row
 * is judged purchasable, and where HitPay sends the buyer afterwards. index.ts
 * keeps only the impure half — reading the environment, the service-role
 * `fetch` calls, and the HitPay call.
 *
 * The split is the same one ../_shared/postgrest.mjs makes and for the same
 * reason: Deno is not installed in this repository, so plain ESM is the only
 * code both runtimes load and `node --test` can exercise (tests/create-payment.test.mjs).
 *
 * The rule that matters is in `readOrderIntent` and `buildOrderRow`: the request
 * contributes a product id and a referral code, and nothing else. An `amount`,
 * a `price`, or a `currency` in the body is not validated, not rejected, and not
 * echoed — it is simply never read (Requirement 11.2), which is why the amount
 * on the row can only have come from `products.price_php` (Requirement 11.1).
 */

import { ORDER_CURRENCY } from '../_shared/hitpay.mjs';

export { ORDER_CURRENCY };

/** A Postgres uuid — `products.id`, `orders.id`, and the verified uid. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Status every Order starts in (Requirement 11.4). */
export const ORDER_STATUS_PENDING = 'pending';

/** Status an Order moves to when HitPay errors or times out (Requirement 12.4). */
export const ORDER_STATUS_FAILED = 'failed';

/** Columns the price/publish decision needs, and no others. */
export const PRODUCT_COLUMNS = 'id,price_php,published,title';

/** The front-end view HitPay returns the buyer to (Requirement 12.5). */
export const ENROLLED_VIEW_PATH = 'enrolled.html';

/** Path of the webhook function on the project, used to derive its URL. */
export const WEBHOOK_FUNCTION_PATH = 'functions/v1/hitpay-webhook';

/**
 * A referral code longer than this is a mistake or an attack, not a code.
 * Generated codes are 8 characters (`gen_ref_code`); the ceiling is generous so
 * a hand-typed or campaign-specific code still survives.
 */
export const REF_CODE_MAX_LENGTH = 64;

/**
 * A request that cannot be turned into an order intent.
 *
 * Carries the offending field so index.ts can shape a `validation_failed`
 * envelope without this module importing http.ts — which it must not do, since
 * http.ts is TypeScript and this file has to load under Node.
 */
export class OrderRequestInvalid extends Error {
  /**
   * @param {string} field request field at fault
   * @param {string} message student-safe explanation
   */
  constructor(field, message) {
    super(message);
    this.name = 'OrderRequestInvalid';
    this.field = field;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedBase(url) {
  return String(url).trim().replace(/\/+$/, '');
}

/**
 * The referral code to store on the order, or null.
 *
 * Whitespace is trimmed and an empty result becomes null, so `ref_code: ""`
 * from a form field that was never filled in does not later send
 * `fulfil_payment` looking for a referrer. Case is deliberately preserved: the
 * stored value has to equal the code the buyer arrived with, which is what
 * Property 12 asserts and what the referrer sees in their own ledger.
 *
 * A non-string — a number, an object, an array — is not a code and yields null
 * rather than an error: a broken referral must not block a sale.
 *
 * @param {unknown} value raw `ref_code` from the request body
 * @returns {string | null}
 */
export function sanitiseRefCode(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > REF_CODE_MAX_LENGTH) return null;

  return trimmed;
}

/**
 * The two values create-payment reads from a request body.
 *
 * Everything else in the body is ignored, including `amount`, `price`, and
 * `currency` (Requirement 11.2) and including any user, profile, or email
 * identity (Requirement 4.4) — the uid comes from `requireUser`, which takes no
 * identity parameter, so there is nothing here to confuse it with.
 *
 * @param {unknown} body parsed request body
 * @returns {{ productId: string, refCode: string | null }}
 * @throws {OrderRequestInvalid} when `product_id` is absent or not a uuid
 */
export function readOrderIntent(body) {
  if (!isPlainObject(body)) {
    throw new OrderRequestInvalid('product_id', 'Choose a product to buy.');
  }

  const rawProductId = body.product_id;
  if (typeof rawProductId !== 'string' || !UUID.test(rawProductId.trim())) {
    throw new OrderRequestInvalid('product_id', 'Choose a product to buy.');
  }

  return {
    productId: rawProductId.trim(),
    refCode: sanitiseRefCode(body.ref_code),
  };
}

/* -------------------------------------------------------------------------- */
/* Service-role reads                                                        */
/* -------------------------------------------------------------------------- */

/**
 * URL reading the price and publish state of one product.
 *
 * Requirement 11.1 names the service role for this read, and Requirement 9.4
 * is why: a client role sees published rows only, so an unpublished product
 * would be indistinguishable from an absent one — and the price the client can
 * read is not the price we are willing to trust.
 *
 * @param {string} supabaseUrl project URL
 * @param {string} productId uuid from the request
 * @returns {string} absolute PostgREST URL
 */
export function productQueryUrl(supabaseUrl, productId) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new TypeError('productQueryUrl requires the project URL');
  }
  if (typeof productId !== 'string' || !UUID.test(productId)) {
    throw new TypeError('productQueryUrl requires a product uuid');
  }

  const query = new URLSearchParams({
    select: PRODUCT_COLUMNS,
    id: `eq.${productId}`,
    limit: '1',
  });
  return `${trimmedBase(supabaseUrl)}/rest/v1/products?${query.toString()}`;
}

/**
 * URL asking whether this user already owns this product.
 *
 * `select=id` because only existence matters (Requirement 11.6). The uid is the
 * verified one, so the answer is about the caller and cannot be steered.
 *
 * @param {string} supabaseUrl project URL
 * @param {string} uid verified user id
 * @param {string} productId uuid from the request
 * @returns {string} absolute PostgREST URL
 */
export function enrollmentQueryUrl(supabaseUrl, uid, productId) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new TypeError('enrollmentQueryUrl requires the project URL');
  }
  if (typeof uid !== 'string' || !UUID.test(uid)) {
    throw new TypeError('enrollmentQueryUrl requires a verified uuid');
  }
  if (typeof productId !== 'string' || !UUID.test(productId)) {
    throw new TypeError('enrollmentQueryUrl requires a product uuid');
  }

  const query = new URLSearchParams({
    select: 'id',
    user_id: `eq.${uid}`,
    product_id: `eq.${productId}`,
    limit: '1',
  });
  return `${trimmedBase(supabaseUrl)}/rest/v1/enrollments?${query.toString()}`;
}

/** URL inserting an order and returning the inserted row. */
export function ordersInsertUrl(supabaseUrl) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new TypeError('ordersInsertUrl requires the project URL');
  }
  return `${trimmedBase(supabaseUrl)}/rest/v1/orders?select=id,amount_php,currency,status`;
}

/**
 * URL updating one order by id.
 *
 * Used for both writes that follow the insert: the HitPay identifiers on
 * success (Requirement 12.2) and `status = 'failed'` when the call does not
 * land (Requirement 12.4).
 *
 * @param {string} supabaseUrl project URL
 * @param {string} orderId uuid of the inserted order
 * @returns {string} absolute PostgREST URL
 */
export function orderUpdateUrl(supabaseUrl, orderId) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new TypeError('orderUpdateUrl requires the project URL');
  }
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    throw new TypeError('orderUpdateUrl requires an order uuid');
  }

  const query = new URLSearchParams({ id: `eq.${orderId}` });
  return `${trimmedBase(supabaseUrl)}/rest/v1/orders?${query.toString()}`;
}

/** The single row of a PostgREST response, or null. */
export function firstRow(body) {
  const row = Array.isArray(body) ? body[0] : body;
  return isPlainObject(row) ? row : null;
}

/**
 * Does this response body prove the caller already holds an Enrollment?
 *
 * Fail-*open* here means selling something twice, not leaking anything, so the
 * strict reading is the right one: a row with an id, and nothing else counts.
 *
 * @param {unknown} body parsed PostgREST body
 * @returns {boolean}
 */
export function hasEnrollment(body) {
  const row = firstRow(body);
  return row !== null && typeof row.id === 'string' && row.id !== '';
}

/* -------------------------------------------------------------------------- */
/* The product decision                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The purchasable product from a PostgREST body, or null.
 *
 * Requirement 11.3 treats "no such product" and "not published" as one outcome,
 * a 404, so both return null here and the handler has one branch rather than
 * two. A row whose `price_php` is not a positive finite number is refused the
 * same way: an amount we cannot state is not an amount we may charge, and it
 * would fail the `amount_php > 0` check on insert regardless.
 *
 * @param {unknown} body parsed PostgREST body
 * @returns {{ id: string, pricePhp: number, title: string | null } | null}
 */
export function purchasableProduct(body) {
  const row = firstRow(body);
  if (row === null) return null;
  if (row.published !== true) return null;
  if (typeof row.id !== 'string' || !UUID.test(row.id)) return null;

  const price = typeof row.price_php === 'number' ? row.price_php : Number(row.price_php);
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    id: row.id,
    pricePhp: price,
    title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : null,
  };
}

/**
 * The `orders` row to insert (Requirement 11.4).
 *
 * `amountPhp` is a parameter of the *product*, not of the request: this function
 * has no channel through which a request body could supply an amount, a price,
 * or a currency, so Property 12 holds by the shape of the code rather than by a
 * filter someone has to remember to apply. `currency` is the constant `PHP`.
 *
 * The row is inserted as `pending` before HitPay is called, so a failure has a
 * row to mark `failed` (Requirement 12.4) and a paid webhook can never arrive
 * for an order that does not exist.
 *
 * @param {{ uid: string, product: { id: string, pricePhp: number }, refCode?: string | null }} input
 * @returns {Record<string, unknown>}
 */
export function buildOrderRow({ uid, product, refCode = null } = {}) {
  if (typeof uid !== 'string' || !UUID.test(uid)) {
    throw new TypeError('buildOrderRow requires the verified uid');
  }
  if (!isPlainObject(product) || typeof product.id !== 'string' || !UUID.test(product.id)) {
    throw new TypeError('buildOrderRow requires a product with a uuid');
  }
  if (!Number.isFinite(product.pricePhp) || product.pricePhp <= 0) {
    throw new TypeError('buildOrderRow requires a positive product price');
  }

  return {
    user_id: uid,
    product_id: product.id,
    amount_php: product.pricePhp, // from products.price_php, never the request
    currency: ORDER_CURRENCY,
    status: ORDER_STATUS_PENDING,
    ref_code: sanitiseRefCode(refCode),
  };
}

/** The HitPay identifiers to write back onto the order (Requirement 12.2). */
export function paymentPatch({ paymentId, reference } = {}) {
  return {
    hitpay_payment_id: typeof paymentId === 'string' && paymentId !== '' ? paymentId : null,
    hitpay_reference: typeof reference === 'string' && reference !== '' ? reference : null,
  };
}

/** The patch marking an order `failed` (Requirement 12.4). */
export function failedPatch() {
  return { status: ORDER_STATUS_FAILED };
}

/* -------------------------------------------------------------------------- */
/* Where the buyer goes next                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The site origin HitPay redirects back to.
 *
 * `SITE_BASE_URL` is the explicit answer. When it is unset the first entry of
 * `CORS_ALLOWED_ORIGINS` is used, because that list already names the origins
 * the site is served from — a deployment that can call this function at all has
 * necessarily configured it. Port wildcards and `*` are skipped: neither is an
 * address a browser can be sent to.
 *
 * Returns null when nothing usable is configured, which the caller turns into a
 * `config_missing` naming `SITE_BASE_URL` rather than guessing an origin.
 *
 * @param {{ siteBaseUrl?: string | null, corsAllowedOrigins?: string | null }} env
 * @returns {string | null} origin with no trailing slash
 */
export function resolveSiteBaseUrl({ siteBaseUrl = null, corsAllowedOrigins = null } = {}) {
  const candidates = [];
  if (typeof siteBaseUrl === 'string') candidates.push(siteBaseUrl);
  if (typeof corsAllowedOrigins === 'string') candidates.push(...corsAllowedOrigins.split(/[,\s]+/));

  for (const candidate of candidates) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (trimmed === '' || trimmed === '*' || trimmed.endsWith(':*')) continue;

    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const path = url.pathname.replace(/\/+$/, '');
      return `${url.protocol}//${url.host}${path}`;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The enrolled-confirmation URL for one order (Requirement 12.5).
 *
 * The order id travels in the query string so `enrolled.html` can poll the
 * buyer's own `orders` row through RLS (Requirement 12.6) instead of guessing
 * which purchase just completed.
 *
 * @param {string} siteBaseUrl site origin
 * @param {string} orderId uuid of the inserted order
 * @returns {string}
 */
export function enrolledRedirectUrl(siteBaseUrl, orderId) {
  const base = resolveSiteBaseUrl({ siteBaseUrl });
  if (base === null) throw new TypeError('enrolledRedirectUrl requires the site base URL');
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    throw new TypeError('enrolledRedirectUrl requires an order uuid');
  }

  return `${base}/${ENROLLED_VIEW_PATH}?order=${encodeURIComponent(orderId)}`;
}

/**
 * The `hitpay-webhook` function URL, derived from the project URL.
 *
 * Derived rather than configured: the webhook is a function in this same
 * project, so a separate variable could only ever be right or wrong about where
 * it already is.
 *
 * @param {string} supabaseUrl project URL
 * @returns {string}
 */
export function webhookUrlFor(supabaseUrl) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new TypeError('webhookUrlFor requires the project URL');
  }
  return `${trimmedBase(supabaseUrl)}/${WEBHOOK_FUNCTION_PATH}`;
}

/** Short description shown on the HitPay checkout page. */
export function orderPurpose(product) {
  const title = isPlainObject(product) && typeof product.title === 'string' ? product.title.trim() : '';
  return title === '' ? 'ArchPrep PH purchase' : title.slice(0, 255);
}
