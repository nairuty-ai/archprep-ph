/* supabase/functions/admin-enrollments/index.ts — admin enrollment management.
 *
 * GET /                        — list enrollments (paged), with profile + product join
 * GET /?user_id=...            — filter by user
 * GET /?product_id=...         — filter by product
 * POST action=grant            — create enrollment (comp/credit)
 * POST action=revoke           — delete enrollment, void matching available referrals
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
    console.error("admin-enrollments fetch failed", e);
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

async function listEnrollments(
  searchParams: URLSearchParams,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<Response> {
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;
  const userId = searchParams.get("user_id");
  const productId = searchParams.get("product_id");

  const q = new URLSearchParams({
    select: "*,profiles(email,display_name),products(title,type)",
    order: "created_at.desc",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (userId) q.set("user_id", `eq.${userId}`);
  if (productId) q.set("product_id", `eq.${productId}`);

  const { status, body, headers } = await pgFetch(`${restBase(supabaseUrl)}/enrollments?${q}`, {
    method: "GET",
    headers: { ...serviceHeaders(serviceRoleKey), prefer: "count=exact" },
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ items: body, page, total_count: parseTotalCount(headers.get("content-range")) });
}

async function grantEnrollment(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { user_id, product_id, source } = body;
  if (!user_id || !product_id) throw new HttpError("validation_failed", "user_id and product_id are required.");
  if (source !== "comp" && source !== "credit") {
    throw new HttpError("validation_failed", "source must be 'comp' or 'credit'.", { field: "source" });
  }

  const base = restBase(supabaseUrl);

  // Check enrollment doesn't already exist
  const checkQ = new URLSearchParams({ select: "id", user_id: `eq.${user_id}`, product_id: `eq.${product_id}`, limit: "1" });
  const { body: existing } = await pgFetch(`${base}/enrollments?${checkQ}`, {
    method: "GET",
    headers: serviceHeaders(serviceRoleKey),
  });
  if (Array.isArray(existing) && existing.length > 0) {
    throw new HttpError("already_owned", "User is already enrolled in this product.");
  }

  const { status, body: created } = await pgFetch(`${base}/enrollments`, {
    method: "POST",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify({ user_id, product_id, source }),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ enrollment: Array.isArray(created) ? created[0] : created });
}

async function revokeEnrollment(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { user_id, product_id } = body;
  if (!user_id || !product_id) throw new HttpError("validation_failed", "user_id and product_id are required.");

  const base = restBase(supabaseUrl);

  // Delete enrollment
  const dq = new URLSearchParams({ user_id: `eq.${user_id}`, product_id: `eq.${product_id}` });
  const { status } = await pgFetch(`${base}/enrollments?${dq}`, {
    method: "DELETE",
    headers: serviceHeaders(serviceRoleKey),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);

  // Void available referrals: find orders for this user+product, void matching referrals (Req 17.9)
  const oq = new URLSearchParams({ select: "id", user_id: `eq.${user_id}`, product_id: `eq.${product_id}` });
  const { body: orders } = await pgFetch(`${base}/orders?${oq}`, {
    method: "GET",
    headers: serviceHeaders(serviceRoleKey),
  });

  if (Array.isArray(orders) && orders.length > 0) {
    const orderIds = (orders as Array<{ id: string }>).map((o) => o.id);
    const rq = new URLSearchParams({ order_id: `in.(${orderIds.join(",")})`, status: "eq.available" });
    await pgFetch(`${base}/referrals?${rq}`, {
      method: "PATCH",
      headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
      body: JSON.stringify({ status: "void" }),
    });
  }

  return json({ revoked: true, user_id, product_id });
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function adminEnrollments(req: Request): Promise<Response> {
  await requireAdmin(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  if (req.method === "GET") {
    return await listEnrollments(url.searchParams, supabaseUrl, serviceRoleKey);
  }

  if (req.method !== "POST") throw new HttpError("validation_failed", "Use GET or POST.");

  const body = await req.json() as Record<string, unknown>;

  switch (action) {
    case "grant":  return await grantEnrollment(body, supabaseUrl, serviceRoleKey);
    case "revoke": return await revokeEnrollment(body, supabaseUrl, serviceRoleKey);
    default:
      throw new HttpError("validation_failed", `Unknown action: "${action}".`);
  }
}

export const handler = withEnvelope(adminEnrollments);
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
