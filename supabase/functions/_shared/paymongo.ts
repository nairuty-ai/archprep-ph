/* supabase/functions/_shared/paymongo.ts — PayMongo adapter.
 *
 * Env vars required:
 *   PAYMONGO_SECRET_KEY       sk_live_xxx or sk_test_xxx  (server-side only)
 *   PAYMONGO_WEBHOOK_SECRET   webhook signing secret from PayMongo dashboard
 *   PAYMONGO_API_BASE_URL     optional, defaults to https://api.paymongo.com/v1
 *
 * PayMongo amounts are in centavos (PHP × 100).
 * Webhook signature header: Paymongo-Signature: t=TIMESTAMP,te=TEST_SIG,li=LIVE_SIG
 */

import { HttpError, configMissing } from "./http.ts";

const DEFAULT_BASE_URL = "https://api.paymongo.com/v1";
const CHECKOUT_PATH = "/checkout_sessions";
const TIMEOUT_MS = 15_000;
const SIG_HEADER = "paymongo-signature";

export const ORDER_CURRENCY = "PHP";

const PH_PAYMENT_METHODS = ["gcash", "paymaya", "grab_pay", "card"];

export interface CheckoutSessionResult {
  readonly sessionId: string;
  readonly checkoutUrl: string;
  readonly referenceNumber: string | null;
  readonly status: string | null;
}

export interface CheckoutSessionInput {
  readonly amountPhp: number | string;
  readonly referenceNumber?: string | null;
  readonly successUrl?: string | null;
  readonly cancelUrl?: string | null;
  readonly description?: string | null;
  readonly currency?: string;
  readonly paymentMethods?: readonly string[];
}

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const value = (globalThis as any).Deno?.env?.get(name);
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function basicAuth(secretKey: string): string {
  return btoa(`${secretKey}:`);
}

function upstreamFailed(reason: string, detail?: unknown): HttpError {
  console.error("paymongo request failed", { reason, detail });
  return new HttpError(
    "upstream_failed",
    "We couldn't reach the payment provider. Please try again.",
    { reason },
  );
}

export function isPaymongoTimeout(error: unknown): boolean {
  return error instanceof HttpError &&
    error.code === "upstream_failed" &&
    (error.details as { reason?: string } | undefined)?.reason === "timeout";
}

export function isPaymongoUpstreamFailure(error: unknown): boolean {
  return error instanceof HttpError && error.code === "upstream_failed";
}

export function checkoutSessionTarget(): { url: string; secretKey: string } {
  const secretKey = env("PAYMONGO_SECRET_KEY");
  if (!secretKey) throw configMissing("PAYMONGO_SECRET_KEY");

  const baseUrl = env("PAYMONGO_API_BASE_URL") ?? DEFAULT_BASE_URL;
  const url = baseUrl.trim().replace(/\/+$/, "") + CHECKOUT_PATH;

  return { url, secretKey };
}

export function webhookSecret(): string {
  const secret = env("PAYMONGO_WEBHOOK_SECRET");
  if (!secret) throw configMissing("PAYMONGO_WEBHOOK_SECRET");
  return secret;
}

export async function createCheckoutSession(
  input: CheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  const { url, secretKey } = checkoutSessionTarget();

  const amountPhp = typeof input.amountPhp === "string"
    ? parseFloat(input.amountPhp)
    : (input.amountPhp as number);

  if (!Number.isFinite(amountPhp) || amountPhp <= 0) {
    throw new HttpError("validation_failed", "Invalid amount.");
  }

  const amountCentavos = Math.round(amountPhp * 100);

  const body = {
    data: {
      attributes: {
        amount: amountCentavos,
        currency: input.currency ?? ORDER_CURRENCY,
        description: input.description ?? "ArchPrep PH purchase",
        payment_method_types: input.paymentMethods ?? PH_PAYMENT_METHODS,
        ...(input.successUrl ? { success_url: input.successUrl } : {}),
        ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
        ...(input.referenceNumber ? { reference_number: input.referenceNumber } : {}),
      },
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth(secretKey)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException
      ? error.name === "TimeoutError"
      : (error as { name?: string })?.name === "TimeoutError";
    throw upstreamFailed(timedOut ? "timeout" : "network", (error as Error)?.name);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw upstreamFailed("http_status", { status: response.status, detail: detail.slice(0, 500) });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw upstreamFailed("malformed_response", "response was not JSON");
  }

  // deno-lint-ignore no-explicit-any
  const data = (payload as any)?.data;
  const sessionId: unknown = data?.id;
  const attrs = data?.attributes;
  const checkoutUrl: unknown = attrs?.checkout_url;

  if (typeof sessionId !== "string" || !sessionId ||
      typeof checkoutUrl !== "string" || !checkoutUrl) {
    throw upstreamFailed("malformed_response", "missing session id or checkout_url");
  }

  return Object.freeze({
    sessionId,
    checkoutUrl,
    referenceNumber: typeof attrs?.reference_number === "string" ? attrs.reference_number : null,
    status: typeof attrs?.status === "string" ? attrs.status : null,
  });
}

function parseSignatureHeader(header: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const segment of header.split(",")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim();
    const val = segment.slice(eq + 1).trim();
    if (key && val) parts[key] = val;
  }
  return parts;
}

export async function verifyPaymongoSignature(
  rawBody: string,
  req: Request,
  secret: string = webhookSecret(),
): Promise<boolean> {
  const header = req.headers.get(SIG_HEADER);
  if (!header) return false;

  const parts = parseSignatureHeader(header);
  const timestamp = parts.t;
  if (!timestamp) return false;

  // Use live sig; fall back to test sig for sandbox mode
  const receivedSig = parts.li || parts.te;
  if (!receivedSig) return false;

  const message = `${timestamp}.${rawBody}`;
  const encoder = new TextEncoder();

  let keyData: CryptoKey;
  try {
    keyData = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return false;
  }

  const sigBuffer = await crypto.subtle.sign("HMAC", keyData, encoder.encode(message));
  const computed = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (computed.length !== receivedSig.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ receivedSig.charCodeAt(i);
  }
  return diff === 0;
}

export interface ParsedPaymongoPayload {
  status: "completed" | "ignored";
  paymentId: string | null;
  referenceNumber: string | null;
  amount: number | null;
  currency: string | null;
  raw: unknown;
}

export function parsePaymongoPayload(raw: string): ParsedPaymongoPayload {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: "ignored", paymentId: null, referenceNumber: null, amount: null, currency: null, raw: null };
  }

  // deno-lint-ignore no-explicit-any
  const eventType = (body as any)?.data?.attributes?.type;

  if (eventType !== "checkout_session.payment.paid") {
    return { status: "ignored", paymentId: null, referenceNumber: null, amount: null, currency: null, raw: body };
  }

  // deno-lint-ignore no-explicit-any
  const csData = (body as any)?.data?.attributes?.data;
  const csAttrs = csData?.attributes;
  const payments: unknown[] = Array.isArray(csAttrs?.payments) ? csAttrs.payments : [];
  // deno-lint-ignore no-explicit-any
  const firstPayment = payments[0] as any;

  // Store the checkout session ID as the payment identifier (matches orders.provider_payment_id)
  const paymentId: string | null = typeof csData?.id === "string" ? csData.id : null;
  const referenceNumber: string | null = typeof csAttrs?.reference_number === "string"
    ? csAttrs.reference_number
    : null;

  // Amount is in centavos; convert to PHP
  const rawAmount = firstPayment?.attributes?.amount ?? csAttrs?.amount;
  const amount = typeof rawAmount === "number" && rawAmount > 0 ? rawAmount / 100 : null;

  const rawCurrency = firstPayment?.attributes?.currency ?? csAttrs?.currency;
  const currency: string | null = typeof rawCurrency === "string"
    ? rawCurrency.trim().toUpperCase()
    : null;

  return { status: "completed", paymentId, referenceNumber, amount, currency, raw: body };
}
