/* supabase/functions/admin-referrals/index.ts — admin referral & payout management.
 *
 * GET /                           — list referrals (paged, filterable by status)
 * GET /?referrer_user_id=...      — referrals for one referrer
 * POST action=mark-paid           — set referral status='paid', paid_at=now()
 * POST action=void                — set referral status='void' with notes
 * GET  action=payout-requests     — list payout_requests (paged, filterable)
 * POST action=handle-payout       — update payout_request status+handled_at+notes
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/admin.ts";

const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 50;

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

async function pgFetch(url: string, opts: RequestInit): Promise<{ status: number; body: unknown; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.error("admin-referrals fetch failed", e);
    throw new HttpError("internal_error");
  }
  let body: unknown = null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json") && res.status !== 204) {
    try { body = await res.json(); } catch { body = null; }
  } else {
    await res.body?.cancel();
  }
  return { status: res.status, body, headers: res.headers };
}

function parseTotalCount(contentRange: string | null): number {
  if (!contentRange) return 0;
  const m = contentRange.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function listReferrals(searchParams: URLSearchParams, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;
  const status = searchParams.get("status");
  const referrerUserId = searchParams.get("referrer_user_id");

  const q = new URLSearchParams({
    select: "*,profiles!referrals_referrer_user_id_fkey(email,display_name)",
    order: "created_at.desc",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (status) q.set("status", `eq.${status}`);
  if (referrerUserId) q.set("referrer_user_id", `eq.${referrerUserId}`);

  const { status: httpStatus, body, headers } = await pgFetch(`${restBase(supabaseUrl)}/referrals?${q}`, {
    method: "GET",
    headers: { ...serviceHeaders(serviceRoleKey), prefer: "count=exact" },
  });
  if (httpStatus >= 300) throw new HttpError("internal_error", `PostgREST returned ${httpStatus}`);
  return json({ items: body, page, total_count: parseTotalCount(headers.get("content-range")) });
}

async function markPaid(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { referral_id } = body;
  if (!referral_id) throw new HttpError("validation_failed", "referral_id is required.");
  const q = new URLSearchParams({ id: `eq.${referral_id}` });
  const { status } = await pgFetch(`${restBase(supabaseUrl)}/referrals?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
    body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ referral_id, status: "paid" });
}

async function voidReferral(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { referral_id, notes } = body;
  if (!referral_id) throw new HttpError("validation_failed", "referral_id is required.");
  const q = new URLSearchParams({ id: `eq.${referral_id}` });
  const patch: Record<string, unknown> = { status: "void" };
  if (notes !== undefined) patch.notes = notes;
  const { status } = await pgFetch(`${restBase(supabaseUrl)}/referrals?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ referral_id, status: "void" });
}

async function listPayoutRequests(searchParams: URLSearchParams, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;
  const status = searchParams.get("status");

  const q = new URLSearchParams({
    select: "*",
    order: "created_at.desc",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (status) q.set("status", `eq.${status}`);

  const { status: httpStatus, body, headers } = await pgFetch(`${restBase(supabaseUrl)}/payout_requests?${q}`, {
    method: "GET",
    headers: { ...serviceHeaders(serviceRoleKey), prefer: "count=exact" },
  });
  if (httpStatus >= 300) throw new HttpError("internal_error", `PostgREST returned ${httpStatus}`);
  return json({ items: body, page, total_count: parseTotalCount(headers.get("content-range")) });
}

async function handlePayout(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { payout_request_id, status: newStatus, notes } = body;
  if (!payout_request_id) throw new HttpError("validation_failed", "payout_request_id is required.");
  if (newStatus !== "paid" && newStatus !== "rejected") {
    throw new HttpError("validation_failed", "status must be 'paid' or 'rejected'.", { field: "status" });
  }
  const q = new URLSearchParams({ id: `eq.${payout_request_id}` });
  const patch: Record<string, unknown> = { status: newStatus, handled_at: new Date().toISOString() };
  if (notes !== undefined) patch.notes = notes;
  const { status: httpStatus } = await pgFetch(`${restBase(supabaseUrl)}/payout_requests?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (httpStatus >= 300) throw new HttpError("internal_error", `PostgREST returned ${httpStatus}`);
  return json({ payout_request_id, status: newStatus });
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function adminReferrals(req: Request): Promise<Response> {
  await requireAdmin(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  if (req.method === "GET") {
    if (action === "payout-requests") {
      return await listPayoutRequests(url.searchParams, supabaseUrl, serviceRoleKey);
    }
    return await listReferrals(url.searchParams, supabaseUrl, serviceRoleKey);
  }

  if (req.method !== "POST") throw new HttpError("validation_failed", "Use GET or POST.");

  const body = await req.json() as Record<string, unknown>;

  switch (action) {
    case "mark-paid":     return await markPaid(body, supabaseUrl, serviceRoleKey);
    case "void":          return await voidReferral(body, supabaseUrl, serviceRoleKey);
    case "handle-payout": return await handlePayout(body, supabaseUrl, serviceRoleKey);
    default:
      throw new HttpError("validation_failed", `Unknown action: "${action}".`);
  }
}

export const handler = withEnvelope(adminReferrals);
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
