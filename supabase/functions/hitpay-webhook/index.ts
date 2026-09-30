/* supabase/functions/hitpay-webhook/index.ts — the one unauthenticated endpoint.
 *
 * `verify_jwt = false` is set for this function and no other in
 * supabase/config.toml, because HitPay cannot present a Supabase session token.
 * The caller is authenticated instead by an HMAC-SHA256 check over the exact
 * bytes of the request body, and that check runs before the first database
 * access of any kind — so there is no `requireUser` call here, and nothing
 * downstream reads a field this function did not verify.
 *
 * The shape of the handler is fixed by three requirements that pull in different
 * directions, so they are worth stating together:
 *
 *   14.1  The signature is computed over the received payload and compared
 *         before any Database row is read or written. Hence `req.text()` first,
 *         verification second, and the service-role call third. A forged
 *         delivery changes zero rows because it never reaches a call.
 *
 *   16.3  A settled call answers 200 — including one that recorded an incident
 *         rather than granting anything — and only a genuine fault answers 5xx,
 *         so HitPay retries exactly the calls that can still succeed. Getting
 *         this backwards loses payments in one direction and invites a retry
 *         storm in the other; ./dispatch.mjs holds the decision and the
 *         reasoning.
 *
 *   17.12 The refund transaction commits inside 15 seconds or rolls back and is
 *         retried. A plpgsql function cannot time itself out, which is why the
 *         bound lives at this layer as an aborted request: dropping the
 *         connection cancels the backend and rolls the transaction back whole.
 *
 * Everything that can be a function of its arguments — the outcome-to-function
 * dispatch, the timeout per function, the status decision, the rejection log
 * entry — is in ./dispatch.mjs, tested under `node --test`. This file keeps only
 * the environment reads, the HMAC check against a live `Request`, and the
 * `fetch`.
 *
 * Requirements: 14.2, 14.5, 15.9, 16.3, 16.7, 17.12.
 */

import { configMissing, HttpError, json, withEnvelope } from "../_shared/http.ts";
import { parseHitpayPayload, verifyHitpaySignature } from "../_shared/hitpay.ts";
import {
  rejectionLogEntry,
  rpcCallFor,
  rpcTimeoutMs,
  rpcUrl,
  statusForRpcResult,
} from "./dispatch.mjs";

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
 * A fault, not a settled outcome: nothing was written, so HitPay should retry.
 *
 * 500 rather than a 4xx deliberately. Requirement 16 criterion 3 wants a
 * non-2xx precisely so the delivery comes back, and a 4xx would invite HitPay to
 * treat the call as permanently rejected. The detail goes to the function log,
 * where it is useful and private; the response body carries only the envelope's
 * generic copy.
 */
function fault(reason: string, context: Record<string, unknown>): HttpError {
  console.error("hitpay webhook fault", { event: "hitpay_webhook_fault", reason, ...context });
  return new HttpError("internal_error");
}

/**
 * Invoke one of the three payment SQL functions with the service role.
 *
 * The service role is required, not convenient: migrations 0011 and 0012 grant
 * `EXECUTE` on these functions to `service_role` alone, so no client token can
 * reach them however the request was shaped.
 *
 * Throws on anything that is not a committed answer — a dropped connection, an
 * exceeded timeout, a PostgREST error status, an unreadable body — because each
 * of those means the transaction rolled back and the call must be redelivered.
 */
async function callPaymentFunction(
  call: { fn: string; body: Record<string, unknown> },
  paymentId: string,
): Promise<unknown> {
  const supabaseUrl = env("SUPABASE_URL");
  if (!supabaseUrl) throw configMissing("SUPABASE_URL");

  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");

  let response: Response;
  try {
    response = await fetch(rpcUrl(supabaseUrl, call.fn), {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(rpcTimeoutMs(call.fn)),
    });
  } catch (error) {
    const timedOut = (error as { name?: string })?.name === "TimeoutError";
    throw fault(timedOut ? "timeout" : "network", {
      fn: call.fn,
      payment_id: paymentId,
      detail: (error as Error)?.name,
    });
  }

  if (!response.ok) {
    // Drained so the connection is released. The text stays in the log: a
    // PostgREST error body names columns and constraints, which helps the owner
    // and tells HitPay nothing it needs.
    const detail = await response.text().catch(() => "");
    throw fault("rpc_status", {
      fn: call.fn,
      payment_id: paymentId,
      status: response.status,
      detail: detail.slice(0, 500),
    });
  }

  try {
    return await response.json();
  } catch {
    throw fault("unreadable_rpc_body", { fn: call.fn, payment_id: paymentId });
  }
}

async function handleWebhook(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    // Rejected before the body is read, so a stray probe costs nothing.
    throw new HttpError(405, "This endpoint accepts POST only.");
  }

  // The raw body FIRST. The HMAC covers the exact bytes HitPay posted, and
  // re-serialising a parsed object would change one somewhere — key order,
  // spacing, unicode escaping — and the digest with it.
  const raw = await req.text();

  // Before any database access whatsoever (Requirement 14.1). A missing salt
  // throws `config_missing`, which answers 500: "we cannot check" must never
  // resolve to "verified", and once the salt is set the retry succeeds.
  const verified = await verifyHitpaySignature(raw, req);

  if (!verified) {
    // Requirement 14.2 and 14.3: zero writes, and a response saying the call was
    // not accepted. Requirement 14.5: the reported payment identifier is logged,
    // the salt is not — and cannot be, since dispatch.mjs never receives one.
    console.warn("hitpay webhook rejected", rejectionLogEntry(raw, req.headers));
    throw new HttpError(400, "Webhook signature verification failed.");
  }

  const parsed = parseHitpayPayload(raw, req.headers);

  const call = rpcCallFor(parsed);
  if (!call) {
    // An unrelated event type, a pending status, a payload with nothing to look
    // an order up by: zero writes, HTTP 200. Returning an error would make
    // HitPay redeliver a call this platform will never act on.
    console.info("hitpay webhook ignored", {
      event: "hitpay_webhook_ignored",
      reason: (parsed as { reason?: string }).reason ?? null,
      event_name: parsed.eventName ?? null,
    });
    return json({ outcome: "ignored", reason: (parsed as { reason?: string }).reason ?? null });
  }

  const paymentId = String(call.body.p_payment_id);
  const result = await callPaymentFunction(call, paymentId);
  const decision = statusForRpcResult(result);

  if (decision.status !== 200) {
    // The function answered, but not with the jsonb outcome its contract
    // promises. Treated as a fault rather than guessed at: claiming a call
    // settled when we cannot read what it did is how a payment goes missing.
    throw fault("unexpected_rpc_result", { fn: call.fn, payment_id: paymentId });
  }

  if (!decision.recognised) {
    // Committed, so still a 200 — but the SQL side has grown a branch this file
    // has not heard of, and that is worth a line in the log.
    console.warn("hitpay webhook unrecognised outcome", {
      event: "hitpay_webhook_unrecognised_outcome",
      fn: call.fn,
      outcome: decision.outcome,
      payment_id: paymentId,
    });
  }

  console.info("hitpay webhook settled", {
    event: "hitpay_webhook_settled",
    fn: call.fn,
    outcome: decision.outcome,
    payment_id: paymentId,
    order_id: decision.orderId,
  });

  return json({
    outcome: decision.outcome,
    ...(decision.orderId ? { order_id: decision.orderId } : {}),
  });
}

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(withEnvelope(handleWebhook));

export { handleWebhook };
