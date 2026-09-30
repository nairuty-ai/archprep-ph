/* supabase/functions/admin-settings/index.ts — admin platform settings management.
 *
 * GET /               — list all settings rows (service role, no display_safe filter)
 * POST action=upsert  — upsert a setting key/value with validation
 * POST action=delete  — delete a setting by key
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/admin.ts";

const TIMEOUT_MS = 10_000;

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const v = (globalThis as any).Deno?.env?.get(name);
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch { return undefined; }
}

function serviceContext() {
  const supabaseUrl = env("SUPABASE_URL"); if (!supabaseUrl) throw configMissing("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY"); if (!serviceRoleKey) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");
  return { supabaseUrl, serviceRoleKey };
}

function serviceHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, accept: "application/json", ...extra };
}

function restBase(url: string) { return `${url.replace(/\/+$/, "")}/rest/v1`; }

async function pgFetch(url: string, opts: RequestInit): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.error("admin-settings fetch failed", e);
    throw new HttpError("internal_error");
  }
  let body: unknown = null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json") && res.status !== 204) {
    try { body = await res.json(); } catch { body = null; }
  } else {
    await res.body?.cancel();
  }
  return { status: res.status, body };
}

// Validation per Requirement 20.13 and 24.5
function validateSetting(key: string, value: unknown): void {
  switch (key) {
    case "reward_type":
      if (value !== "cash" && value !== "credit") {
        throw new HttpError("validation_failed", "reward_type must be 'cash' or 'credit'.", { field: "value" });
      }
      break;
    case "answer_reveal_mode":
      if (value !== "answered_only" && value !== "full_reveal") {
        throw new HttpError("validation_failed", "answer_reveal_mode must be 'answered_only' or 'full_reveal'.", { field: "value" });
      }
      break;
    case "referral_amount":
    case "payout_threshold": {
      const n = Number(value);
      if (isNaN(n) || n < 0) {
        throw new HttpError("validation_failed", `${key} must be a non-negative number.`, { field: "value" });
      }
      break;
    }
    case "reward_on":
      if (value !== "every_purchase" && value !== "first_purchase_only") {
        throw new HttpError("validation_failed", "reward_on must be 'every_purchase' or 'first_purchase_only'.", { field: "value" });
      }
      break;
    // All other keys: any string value accepted
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function listSettings(supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const q = new URLSearchParams({ select: "*", order: "key.asc" });
  const { status, body } = await pgFetch(`${restBase(supabaseUrl)}/settings?${q}`, {
    method: "GET",
    headers: serviceHeaders(serviceRoleKey),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ items: body });
}

async function upsertSetting(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { key, value } = body;
  if (!key || typeof key !== "string") throw new HttpError("validation_failed", "key is required.", { field: "key" });
  if (value === undefined) throw new HttpError("validation_failed", "value is required.", { field: "value" });

  validateSetting(key, value);

  const { status, body: upserted } = await pgFetch(`${restBase(supabaseUrl)}/settings`, {
    method: "POST",
    headers: {
      ...serviceHeaders(serviceRoleKey),
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify({ key, value }),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ setting: Array.isArray(upserted) ? upserted[0] : upserted });
}

async function deleteSetting(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { key } = body;
  if (!key || typeof key !== "string") throw new HttpError("validation_failed", "key is required.");
  const q = new URLSearchParams({ key: `eq.${key}` });
  const { status } = await pgFetch(`${restBase(supabaseUrl)}/settings?${q}`, {
    method: "DELETE",
    headers: serviceHeaders(serviceRoleKey),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ deleted: true, key });
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function adminSettings(req: Request): Promise<Response> {
  await requireAdmin(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  if (req.method === "GET") {
    return await listSettings(supabaseUrl, serviceRoleKey);
  }

  if (req.method !== "POST") throw new HttpError("validation_failed", "Use GET or POST.");

  const body = await req.json() as Record<string, unknown>;

  switch (action) {
    case "upsert": return await upsertSetting(body, supabaseUrl, serviceRoleKey);
    case "delete": return await deleteSetting(body, supabaseUrl, serviceRoleKey);
    default:
      throw new HttpError("validation_failed", `Unknown action: "${action}".`);
  }
}

export const handler = withEnvelope(adminSettings);
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
