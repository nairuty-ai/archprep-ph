/* supabase/functions/_shared/hitpay.ts — the HitPay adapter.
 *
 *   createPaymentRequest()     create-payment, after the Order row exists
 *   verifyHitpaySignature()    hitpay-webhook, before anything else
 *   parseHitpayPayload()       re-exported from ./hitpay.mjs
 *
 * This module owns the two things that cannot be pure: reading `HITPAY_*` out of
 * the environment, and making the outbound call. The wire format itself — path
 * resolution, the request body, the HMAC, the constant-time compare, payload
 * normalisation — lives in ./hitpay.mjs, which is plain ESM over WebCrypto and
 * is therefore unit-tested under `node --test` (tests/hitpay.test.mjs).
 *
 * Nothing here spells a HitPay host (Requirement 13.2). The base URL arrives as
 * `HITPAY_API_BASE_URL`, so moving from sandbox to live is three environment
 * values and zero code changes (Requirement 13.7).
 */

import { HttpError, configMissing } from "./http.ts";
import {
  API_KEY_HEADER,
  buildPaymentRequestBody,
  HITPAY_TIMEOUT_MS,
  HitpayWireError,
  ORDER_CURRENCY,
  parsePaymentRequestResponse,
  PAYMENT_REQUEST_ENV_NAMES,
  PAYMENT_REQUEST_PATH,
  PHP_PAYMENT_METHODS,
  resolveHitpayUrl,
  SIGNATURE_HEADER,
  verifyHitpaySignatureHex,
} from "./hitpay.mjs";

export {
  HITPAY_ENV_NAMES,
  HITPAY_TIMEOUT_MS,
  HitpayWireError,
  ORDER_CURRENCY,
  parseHitpayPayload,
  PAYMENT_REQUEST_PATH,
  PHP_PAYMENT_METHODS,
  resolveHitpayUrl,
  SIGNATURE_HEADER,
} from "./hitpay.mjs";

/** Why an `upstream_failed` happened. `timeout` is the one Requirement 12.4 names. */
export type HitpayFailureReason =
  | "timeout"
  | "network"
  | "http_status"
  | "malformed_response";

/** What `create-payment` needs to finish the Order and answer the browser. */
export interface PaymentRequestResult {
  /** → `orders.hitpay_payment_id` (Requirement 12.2). */
  readonly paymentId: string;
  /** → `orders.hitpay_reference`. */
  readonly reference: string | null;
  /** → returned to the front end, which navigates to it (Requirement 12.3). */
  readonly checkoutUrl: string;
  /** HitPay's own status for the new request, usually `pending`. */
  readonly status: string | null;
}

export interface PaymentRequestInput {
  /** The Order amount, read from `products.price_php` — never from a request body. */
  readonly amountPhp: number | string;
  /** `orders.id` or another internal reference. */
  readonly referenceNumber?: string | null;
  /** The enrolled-confirmation view (Requirement 12.5). */
  readonly redirectUrl?: string | null;
  /** The `hitpay-webhook` function URL, when it is passed explicitly. */
  readonly webhookUrl?: string | null;
  readonly purpose?: string | null;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly currency?: string;
  readonly paymentMethods?: readonly string[];
}

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

/**
 * `upstream_failed`, tagged with what went wrong.
 *
 * Requirement 12.4 gives an error and a timeout the same consequence — the Order
 * moves to `failed` and the buyer is invited to retry — but the two want
 * different log lines, so the reason travels in `details` where `create-payment`
 * and the admin can both see it. No response text from HitPay is ever copied
 * into the message; the envelope's scrubber is the backstop, not the plan.
 */
function upstreamFailed(reason: HitpayFailureReason, logContext?: unknown): HttpError {
  console.error("hitpay payment request failed", { reason, detail: logContext });
  return new HttpError(
    "upstream_failed",
    "We couldn't reach the payment provider. Please try again.",
    { reason },
  );
}

/** Whether a thrown error was HitPay failing to answer inside the timeout. */
export function isHitpayTimeout(error: unknown): boolean {
  return error instanceof HttpError &&
    error.code === "upstream_failed" &&
    (error.details as { reason?: string } | undefined)?.reason === "timeout";
}

/** Whether a thrown error means HitPay was called and did not deliver. */
export function isHitpayUpstreamFailure(error: unknown): boolean {
  return error instanceof HttpError && error.code === "upstream_failed";
}

/**
 * The resolved endpoint and API key, or a `config_missing` naming the gap.
 *
 * Requirement 13.5: the check runs before any outbound call, and the error names
 * the absent variable without carrying any value. Variables are checked in the
 * order they appear in `.env.example`, so an owner filling the file top to bottom
 * is told about the first thing still missing.
 */
export function paymentRequestTarget(): { url: string; apiKey: string } {
  for (const name of PAYMENT_REQUEST_ENV_NAMES) {
    if (!env(name)) throw configMissing(name);
  }

  const apiKey = env("HITPAY_API_KEY")!;
  const baseUrl = env("HITPAY_API_BASE_URL")!;

  try {
    return { url: resolveHitpayUrl(baseUrl, PAYMENT_REQUEST_PATH), apiKey };
  } catch (error) {
    if (error instanceof HitpayWireError) {
      // A present-but-unusable value is still a configuration fault, and it is
      // the variable name — not its value — that goes into the response.
      throw configMissing("HITPAY_API_BASE_URL");
    }
    throw error;
  }
}

/** The webhook salt, or a `config_missing` naming it. */
export function webhookSalt(): string {
  const salt = env("HITPAY_WEBHOOK_SALT");
  if (!salt) throw configMissing("HITPAY_WEBHOOK_SALT");
  return salt;
}

/**
 * Create a HitPay payment request for an Order (Requirement 12.1).
 *
 * ```ts
 * const payment = await createPaymentRequest({
 *   amountPhp: order.amount_php,          // from products.price_php
 *   referenceNumber: order.id,
 *   redirectUrl: `${siteUrl}/enrolled.html?order=${order.id}`,
 * });
 * ```
 *
 * Throws `config_missing` naming the absent variable *before* any outbound call,
 * and `upstream_failed` with `details.reason` when HitPay errors, answers with
 * something unusable, or stays silent for 15 seconds. Both cases are the
 * caller's cue to set the Order to `failed` (Requirement 12.4); `isHitpayTimeout`
 * separates the two for logging.
 */
export async function createPaymentRequest(
  input: PaymentRequestInput,
): Promise<PaymentRequestResult> {
  const { url, apiKey } = paymentRequestTarget();

  const body = buildPaymentRequestBody({
    amountPhp: input.amountPhp,
    referenceNumber: input.referenceNumber ?? null,
    redirectUrl: input.redirectUrl ?? null,
    webhookUrl: input.webhookUrl ?? null,
    purpose: input.purpose ?? null,
    email: input.email ?? null,
    name: input.name ?? null,
    currency: input.currency ?? ORDER_CURRENCY,
    paymentMethods: input.paymentMethods ?? PHP_PAYMENT_METHODS,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        [API_KEY_HEADER]: apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      // Requirement 12.4's 15 seconds, enforced by the runtime rather than by a
      // race we would have to remember to clean up.
      signal: AbortSignal.timeout(HITPAY_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException
      ? error.name === "TimeoutError"
      : (error as { name?: string })?.name === "TimeoutError";
    throw upstreamFailed(timedOut ? "timeout" : "network", (error as Error)?.name);
  }

  if (!response.ok) {
    // Drained so the connection is released; kept out of the response body,
    // because an upstream error text is exactly where a key echo would appear.
    const detail = await response.text().catch(() => "");
    throw upstreamFailed("http_status", { status: response.status, detail: detail.slice(0, 500) });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw upstreamFailed("malformed_response", "response was not JSON");
  }

  try {
    const parsed = parsePaymentRequestResponse(payload);
    return Object.freeze({
      paymentId: parsed.paymentId,
      reference: parsed.reference,
      checkoutUrl: parsed.checkoutUrl,
      status: parsed.status,
    });
  } catch (error) {
    if (error instanceof HitpayWireError) {
      throw upstreamFailed("malformed_response", error.reason);
    }
    throw error;
  }
}

/**
 * Whether a webhook request carries a signature matching its own raw body
 * (Requirement 14.1).
 *
 * The raw body must be read by the caller and handed in, because the HMAC covers
 * the exact bytes HitPay posted — re-serialising a parsed object changes them.
 * Returns `false` for an absent header (Requirement 14.3) and for a mismatch
 * (Requirement 14.2); the compare is constant-time and case-sensitive
 * (Requirement 14.4, see ./hitpay.mjs for why).
 *
 * The salt is read from the environment when it is not passed. A missing salt
 * throws `config_missing`: "we cannot check" must never resolve to "verified".
 */
export function verifyHitpaySignature(
  raw: string,
  req: Request,
  salt: string = webhookSalt(),
): Promise<boolean> {
  return verifyHitpaySignatureHex(raw, req.headers.get(SIGNATURE_HEADER), salt);
}
