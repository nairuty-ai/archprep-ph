/* supabase/functions/request-payout/index.ts — referral payout request.
 *
 * Requirement 25 criteria 7: a logged-in user with an available balance at or
 * above the `payout_threshold` setting can request a cash payout. The balance is
 * always re-computed from `referrals` server-side — never trusted from the body
 * — and the GCash number is the only caller-supplied input that reaches the DB.
 *
 * Security design:
 *
 *   1. `requireUser`    — identity from the bearer token.
 *   2. body             — gcash_number only; any amount field is ignored.
 *   3. balance read     — sum of available referrals rows (service role).
 *   4. threshold read   — payout_threshold from settings (service role).
 *   5. eligibility      — balance >= threshold, or `below_threshold` (25.5).
 *   6. insert           — exactly one payout_requests row with the computed amount.
 *   7. return           — the request row.
 *
 * `payout_requests` has no client-role insert policy (migration 0009), so the
 * service role is required for step 6.
 *
 * Requirements: 25.4, 25.7, 4.1–4.4.
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";

const READ_TIMEOUT_MS  = 10_000;
const WRITE_TIMEOUT_MS = 10_000;

const DEFAULT_PAYOUT_THRESHOLD = 100;

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const value = (globalThis as any).Deno?.env?.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function serviceContext(): { supabaseUrl: string; serviceRoleKey: string } {
  const supabaseUrl    = env("SUPABASE_URL");
  if (!supabaseUrl)    throw configMissing("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");
  return { supabaseUrl, serviceRoleKey };
}

function restBase(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
}

function serviceHeaders(key: string): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    accept: "application/json",
  };
}

async function serviceRead(url: string, key: string, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: serviceHeaders(key),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`request-payout ${what} failed`, error);
    throw new HttpError("internal_error");
  }
  if (!response.ok) {
    console.error(`request-payout ${what} returned`, response.status);
    await response.body?.cancel();
    throw new HttpError("internal_error");
  }
  try { return await response.json(); } catch { throw new HttpError("internal_error"); }
}

async function servicePost(
  url: string,
  key: string,
  row: Record<string, unknown>,
  what: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...serviceHeaders(key), "content-type": "application/json", prefer: "return=representation" },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`request-payout ${what} failed`, error);
    throw new HttpError("internal_error");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`request-payout ${what} returned`, response.status, detail.slice(0, 300));
    throw new HttpError("internal_error");
  }
  try { return await response.json(); } catch { throw new HttpError("internal_error"); }
}

/** Sum of available referral amounts for this user — server-side, never trusted from the body. */
function availableBalanceUrl(supabaseUrl: string, uid: string): string {
  const q = new URLSearchParams({
    select:           "amount_php",
    referrer_user_id: `eq.${uid}`,
    status:           "eq.available",
  });
  return `${restBase(supabaseUrl)}/referrals?${q}`;
}

function settingUrl(supabaseUrl: string, key: string): string {
  const q = new URLSearchParams({ select: "value", key: `eq.${key}`, limit: "1" });
  return `${restBase(supabaseUrl)}/settings?${q}`;
}

function settingValueFrom(body: unknown): string | null {
  const row = Array.isArray(body) ? body[0] : body;
  return typeof row?.value === "string" ? row.value : null;
}

function sumAmounts(body: unknown): number {
  if (!Array.isArray(body)) return 0;
  return body.reduce((sum, row) => {
    const v = parseFloat(row?.amount_php ?? "0");
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);
}

function thresholdFrom(body: unknown): number {
  const raw = settingValueFrom(body);
  const v   = raw !== null ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_PAYOUT_THRESHOLD;
}

export async function requestPayout(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError("validation_failed", "Send this request as a POST.");
  }

  const uid = await requireUser(req);

  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json();
  } catch {
    throw new HttpError("validation_failed", "Request body must be JSON.");
  }

  const gcashNumber = typeof body?.gcash_number === "string" ? body.gcash_number.trim() : "";
  if (!gcashNumber) {
    throw new HttpError("validation_failed", "A GCash number is required.", { field: "gcash_number" });
  }
  // Basic sanity: 11-digit PH mobile number, optionally prefixed with +63.
  if (!/^(\+63|0)\d{10}$/.test(gcashNumber.replace(/\s/g, ""))) {
    throw new HttpError("validation_failed", "Enter a valid Philippine mobile number (e.g. 09xxxxxxxxx).", { field: "gcash_number" });
  }

  const { supabaseUrl, serviceRoleKey } = serviceContext();

  // Step 3 + 4: compute balance and threshold server-side.
  const [referralsBody, thresholdBody] = await Promise.all([
    serviceRead(availableBalanceUrl(supabaseUrl, uid), serviceRoleKey, "referrals balance"),
    serviceRead(settingUrl(supabaseUrl, "payout_threshold"), serviceRoleKey, "payout_threshold"),
  ]);

  const balance   = sumAmounts(referralsBody);
  const threshold = thresholdFrom(thresholdBody);

  // Requirement 25.5: below_threshold if not yet reached.
  if (balance < threshold) {
    throw new HttpError("below_threshold",
      `Your available balance is ₱${balance.toFixed(2)}. The minimum payout is ₱${threshold.toFixed(2)}.`,
      { balance, threshold, shortfall: threshold - balance },
    );
  }

  // Step 6: insert one payout_requests row.
  const row = {
    user_id:      uid,
    amount_php:   parseFloat(balance.toFixed(2)),
    gcash_number: gcashNumber,
    status:       "requested",
  };

  const insertedBody = await servicePost(
    `${restBase(supabaseUrl)}/payout_requests`,
    serviceRoleKey,
    row,
    "payout_requests insert",
  );

  const inserted = Array.isArray(insertedBody) ? insertedBody[0] : insertedBody;

  return json({
    payout_request_id: inserted?.id ?? null,
    amount_php:        balance,
    gcash_number:      gcashNumber,
    status:            "requested",
  });
}

export const handler = withEnvelope(requestPayout);

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
