/* supabase/functions/create-payment/index.ts — the purchase endpoint.
 *
 *   POST { "product_id": "…", "ref_code": "…" }  →  { ok, order_id, checkout_url }
 *
 * The sequence is fixed, and the order of the steps is the security property:
 *
 *   1. `requireUser`        identity from the bearer token only (Requirement 4)
 *   2. `readOrderIntent`    product id and referral code; nothing else is read
 *   3. service-role read    price and publish state from `products` (11.1, 11.3)
 *   4. service-role read    existing Enrollment → already-owned (11.6)
 *   5. `paymentRequestTarget()`  HitPay configuration checked (13.5)
 *   6. insert               `pending`, `PHP`, database price (11.4)
 *   7. HitPay               payment request for the order amount (12.1)
 *   8. update               `hitpay_payment_id` + `hitpay_reference` (12.2)
 *
 * Step 5 runs before step 6 so a missing `HITPAY_*` variable cannot leave a
 * pending order behind. Step 6 runs before step 7 so a HitPay failure has a row
 * to mark `failed` (Requirement 12.4) and so a webhook can never arrive for an
 * order that was never written.
 *
 * The request body contributes a product id and a referral code. An `amount`, a
 * `price`, or a `currency` in the body is never read — see ./orders.mjs, where
 * the intent reader and the row builder have no parameter for one.
 *
 * Every write here uses the service role, because `orders` has no client-role
 * insert policy at all (Requirement 8.1, 8.4). PostgREST is called over plain
 * `fetch` for the same reason ../_shared/postgrest.mjs does: a handful of URLs
 * is not worth a runtime dependency.
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import {
  createPaymentRequest,
  isHitpayTimeout,
  isHitpayUpstreamFailure,
  paymentRequestTarget,
} from "../_shared/hitpay.ts";
import {
  buildOrderRow,
  enrolledRedirectUrl,
  enrollmentQueryUrl,
  failedPatch,
  firstRow,
  hasEnrollment,
  orderPurpose,
  orderUpdateUrl,
  ordersInsertUrl,
  OrderRequestInvalid,
  ORDER_CURRENCY,
  ORDER_STATUS_PENDING,
  paymentPatch,
  productQueryUrl,
  purchasableProduct,
  readOrderIntent,
  resolveSiteBaseUrl,
  webhookUrlFor,
} from "./orders.mjs";

/** Ceiling on each database call, so a stalled database cannot hang the request. */
const DB_TIMEOUT_MS = 10_000;

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const value = (globalThis as any).Deno?.env?.get(name);
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    // Environment unreadable: treated as unset, which is a config_missing.
    return undefined;
  }
}

interface ServiceContext {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly siteBaseUrl: string;
}

/**
 * Everything this handler needs from the environment, resolved before any write.
 *
 * `SITE_BASE_URL` is read here rather than at the redirect, so an unset origin
 * is a `config_missing` before an order exists instead of after one does. It
 * falls back to the first entry of `CORS_ALLOWED_ORIGINS`, which already names
 * the site's own origin.
 */
function serviceContext(): ServiceContext {
  const supabaseUrl = env("SUPABASE_URL");
  if (!supabaseUrl) throw configMissing("SUPABASE_URL");

  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");

  const siteBaseUrl = resolveSiteBaseUrl({
    siteBaseUrl: env("SITE_BASE_URL") ?? null,
    corsAllowedOrigins: env("CORS_ALLOWED_ORIGINS") ?? null,
  });
  if (!siteBaseUrl) throw configMissing("SITE_BASE_URL");

  return { supabaseUrl, serviceRoleKey, siteBaseUrl };
}

function serviceHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    accept: "application/json",
    ...extra,
  };
}

/**
 * One service-role PostgREST call, returning the parsed body.
 *
 * A transport failure, a non-2xx, or an unreadable body all become
 * `internal_error`: the caller did nothing wrong, and the upstream detail goes
 * to the log rather than into a response body.
 */
async function callPostgrest(
  url: string,
  init: RequestInit,
  what: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(DB_TIMEOUT_MS) });
  } catch (error) {
    console.error(`${what} failed`, error);
    throw new HttpError("internal_error");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`${what} returned`, response.status, detail.slice(0, 500));
    throw new HttpError("internal_error");
  }

  const text = await response.text().catch(() => "");
  if (text.trim() === "") return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(`${what} returned an unreadable body`, error);
    throw new HttpError("internal_error");
  }
}

function readRows(ctx: ServiceContext, url: string, what: string): Promise<unknown> {
  return callPostgrest(url, { method: "GET", headers: serviceHeaders(ctx.serviceRoleKey) }, what);
}

/** Insert the pending order and return the row PostgREST echoes back. */
async function insertOrder(
  ctx: ServiceContext,
  row: Record<string, unknown>,
): Promise<{ id: string; amountPhp: unknown }> {
  const body = await callPostgrest(
    ordersInsertUrl(ctx.supabaseUrl),
    {
      method: "POST",
      headers: serviceHeaders(ctx.serviceRoleKey, {
        "content-type": "application/json",
        prefer: "return=representation",
      }),
      body: JSON.stringify(row),
    },
    "order insert",
  );

  const inserted = firstRow(body) as { id?: unknown; amount_php?: unknown } | null;
  if (!inserted || typeof inserted.id !== "string" || inserted.id === "") {
    console.error("order insert returned no row");
    throw new HttpError("internal_error");
  }

  // The amount is re-read from the inserted row so the HitPay call is charged
  // the value the database actually stored, not the value we hoped it would.
  return { id: inserted.id, amountPhp: inserted.amount_php ?? row.amount_php };
}

async function patchOrder(
  ctx: ServiceContext,
  orderId: string,
  patch: Record<string, unknown>,
  what: string,
): Promise<void> {
  await callPostgrest(
    orderUpdateUrl(ctx.supabaseUrl, orderId),
    {
      method: "PATCH",
      headers: serviceHeaders(ctx.serviceRoleKey, {
        "content-type": "application/json",
        prefer: "return=minimal",
      }),
      body: JSON.stringify(patch),
    },
    what,
  );
}

/**
 * Mark an order `failed` (Requirement 12.4), never throwing.
 *
 * This runs while another error is already on its way to the client, so a
 * failure to record the status must not replace it: the buyer needs the retry
 * message more than we need the bookkeeping, and the order is still `pending`
 * in the log if this second call also fails.
 */
async function markFailed(ctx: ServiceContext, orderId: string): Promise<void> {
  try {
    await patchOrder(ctx, orderId, failedPatch(), "order fail update");
  } catch (error) {
    console.error("could not mark order failed", { orderId, error });
  }
}

/**
 * The HitPay payment request for an order that already exists.
 *
 * Requirement 12.4: an error and a timeout have the same consequence — the order
 * moves to `failed` and the error travels on to the front end, which shows the
 * retry message. `isHitpayTimeout` only separates the two in the log.
 */
async function requestPayment(
  ctx: ServiceContext,
  order: { id: string; amountPhp: unknown },
  product: { title: string | null },
) {
  try {
    return await createPaymentRequest({
      amountPhp: order.amountPhp as number | string,
      referenceNumber: order.id,
      // Requirement 12.5: HitPay returns the buyer to the enrolled view.
      redirectUrl: enrolledRedirectUrl(ctx.siteBaseUrl, order.id),
      webhookUrl: webhookUrlFor(ctx.supabaseUrl),
      purpose: orderPurpose(product),
    });
  } catch (error) {
    await markFailed(ctx, order.id);
    if (isHitpayUpstreamFailure(error)) {
      console.error("payment request failed", {
        orderId: order.id,
        timeout: isHitpayTimeout(error),
      });
    }
    throw error;
  }
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    // An unparseable body is the same as an absent product id, and
    // `readOrderIntent` already has the copy for that.
    return null;
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError("validation_failed", "Send this request as a POST.");
  }

  // Identity first: nothing is read and nothing is written for a caller whose
  // token does not verify (Requirement 4.3).
  const uid = await requireUser(req);

  let intent: { productId: string; refCode: string | null };
  try {
    intent = readOrderIntent(await readJsonBody(req));
  } catch (error) {
    if (error instanceof OrderRequestInvalid) {
      throw new HttpError("validation_failed", error.message, { field: error.field });
    }
    throw error;
  }

  const ctx = serviceContext();

  // Requirement 11.1 and 11.3: the price and the publish state both come from
  // the database, and an absent or unpublished product is one 404.
  const product = purchasableProduct(
    await readRows(ctx, productQueryUrl(ctx.supabaseUrl, intent.productId), "product read"),
  );
  if (!product) throw new HttpError("not_found");

  // Requirement 11.6: an owner is told they own it, and no order is created.
  const owned = hasEnrollment(
    await readRows(
      ctx,
      enrollmentQueryUrl(ctx.supabaseUrl, uid, intent.productId),
      "enrollment read",
    ),
  );
  if (owned) {
    return json({ already_owned: true, product_id: product.id });
  }

  // Requirement 13.5: the HitPay configuration is checked before the order row
  // exists, so a missing variable leaves nothing behind to reconcile.
  paymentRequestTarget();

  const order = await insertOrder(
    ctx,
    buildOrderRow({ uid, product, refCode: intent.refCode }),
  );

  const payment = await requestPayment(ctx, order, product);

  // Requirement 12.2: the identifiers the webhook will match on. If this write
  // does not land, the payment could never be matched to the order, so the
  // order is failed rather than left looking live.
  try {
    await patchOrder(ctx, order.id, paymentPatch(payment), "order payment update");
  } catch (error) {
    await markFailed(ctx, order.id);
    throw error;
  }

  return json({
    order_id: order.id,
    checkout_url: payment.checkoutUrl,
    amount_php: order.amountPhp,
    currency: ORDER_CURRENCY,
    status: ORDER_STATUS_PENDING,
  });
}

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(withEnvelope(handle));

export default handle;
