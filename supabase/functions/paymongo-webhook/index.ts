/* supabase/functions/paymongo-webhook/index.ts — the payment webhook endpoint.
 *
 * `verify_jwt = false` is set in supabase/config.toml for this function only.
 * PayMongo cannot present a Supabase session token; authentication is instead
 * done via HMAC-SHA256 over the exact bytes of the request body, using the
 * Paymongo-Signature header. The signature check runs before any database access.
 *
 * Flow:
 *   1. Read raw body
 *   2. Verify Paymongo-Signature HMAC
 *   3. Parse event — only checkout_session.payment.paid is acted on
 *   4. Call fulfil_payment RPC with service role
 *   5. Return 200 (settled) or 5xx (fault — PayMongo will retry)
 */

import { configMissing, HttpError, json, withEnvelope } from "../_shared/http.ts";
import { parsePaymongoPayload, verifyPaymongoSignature } from "../_shared/paymongo.ts";

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const value = (globalThis as any).Deno?.env?.get(name);
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function fault(reason: string, context: Record<string, unknown>): HttpError {
  console.error("paymongo webhook fault", { event: "paymongo_webhook_fault", reason, ...context });
  return new HttpError("internal_error");
}

async function callFulfilPayment(
  paymentId: string,
  amount: number | null,
  currency: string | null,
  payload: unknown,
): Promise<unknown> {
  const supabaseUrl = env("SUPABASE_URL");
  if (!supabaseUrl) throw configMissing("SUPABASE_URL");

  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");

  const url = `${supabaseUrl.trim().replace(/\/+$/, "")}/rest/v1/rpc/fulfil_payment`;
  const body = {
    p_payment_id: paymentId,
    p_reported_amount: amount,
    p_reported_currency: currency,
    p_payload: payload,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const timedOut = (error as { name?: string })?.name === "TimeoutError";
    throw fault(timedOut ? "timeout" : "network", { payment_id: paymentId });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw fault("rpc_status", { payment_id: paymentId, status: response.status, detail: detail.slice(0, 500) });
  }

  try {
    return await response.json();
  } catch {
    throw fault("unreadable_rpc_body", { payment_id: paymentId });
  }
}

async function handleWebhook(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError(405, "This endpoint accepts POST only.");
  }

  const raw = await req.text();

  const verified = await verifyPaymongoSignature(raw, req);
  if (!verified) {
    console.warn("paymongo webhook rejected", {
      event: "paymongo_webhook_rejected",
      reason: "signature_mismatch",
      body_bytes: raw.length,
    });
    throw new HttpError(400, "Webhook signature verification failed.");
  }

  const parsed = parsePaymongoPayload(raw);

  if (parsed.status === "ignored") {
    console.info("paymongo webhook ignored", { event: "paymongo_webhook_ignored" });
    return json({ outcome: "ignored" });
  }

  if (!parsed.paymentId) {
    console.warn("paymongo webhook missing payment id", { event: "paymongo_webhook_missing_id" });
    return json({ outcome: "ignored", reason: "missing_payment_id" });
  }

  const result = await callFulfilPayment(
    parsed.paymentId,
    parsed.amount,
    parsed.currency,
    parsed.raw,
  );

  const body = Array.isArray(result) && result.length === 1 ? result[0] : result;
  if (typeof (body as Record<string, unknown>)?.outcome !== "string") {
    throw fault("unexpected_rpc_result", { payment_id: parsed.paymentId });
  }

  const outcome = (body as Record<string, unknown>).outcome as string;
  const orderId = typeof (body as Record<string, unknown>).order_id === "string"
    ? (body as Record<string, unknown>).order_id as string
    : null;

  console.info("paymongo webhook settled", {
    event: "paymongo_webhook_settled",
    outcome,
    payment_id: parsed.paymentId,
    order_id: orderId,
  });

  return json({ outcome, ...(orderId ? { order_id: orderId } : {}) });
}

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(withEnvelope(handleWebhook));
export { handleWebhook };
