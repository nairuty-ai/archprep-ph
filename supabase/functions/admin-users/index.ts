/* supabase/functions/admin-users/index.ts — admin user management.
 *
 * GET /                 — list all profiles (paged)
 * GET /?email=...       — find profile by email (case-insensitive)
 * POST action=grant-admin  — set profiles.is_admin=true by email (Req 26.3)
 * POST action=revoke-admin — set profiles.is_admin=false by email (blocks last admin)
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/admin.ts";

const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 50;
const PROFILE_COLUMNS = "id,email,display_name,is_admin,ref_code,created_at";

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
    console.error("admin-users fetch failed", e);
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

async function listProfiles(searchParams: URLSearchParams, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;
  const email = searchParams.get("email");

  const q = new URLSearchParams({
    select: PROFILE_COLUMNS,
    order: "created_at.desc",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  // Case-insensitive email filter using PostgREST ilike
  if (email) q.set("email", `ilike.${email}`);

  const { status, body, headers } = await pgFetch(`${restBase(supabaseUrl)}/profiles?${q}`, {
    method: "GET",
    headers: { ...serviceHeaders(serviceRoleKey), prefer: "count=exact" },
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ items: body, page, total_count: parseTotalCount(headers.get("content-range")) });
}

async function setAdminByEmail(
  body: Record<string, unknown>,
  isAdmin: boolean,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<Response> {
  const { email } = body;
  if (!email || typeof email !== "string") throw new HttpError("validation_failed", "email is required.");

  const base = restBase(supabaseUrl);

  // If revoking, ensure more than 1 admin exists
  if (!isAdmin) {
    const countQ = new URLSearchParams({ select: "id", is_admin: "eq.true" });
    const { body: admins } = await pgFetch(`${base}/profiles?${countQ}`, {
      method: "GET",
      headers: serviceHeaders(serviceRoleKey),
    });
    if (Array.isArray(admins) && admins.length <= 1) {
      throw new HttpError("validation_failed", "Cannot revoke the last admin. Grant another admin first.");
    }
  }

  const q = new URLSearchParams({ email: `ilike.${email}` });
  const { status, body: updated } = await pgFetch(`${base}/profiles?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify({ is_admin: isAdmin }),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);

  const rows = Array.isArray(updated) ? updated : (updated ? [updated] : []);
  if (rows.length === 0) throw new HttpError("not_found", "No user found with that email.");

  return json({ email, is_admin: isAdmin, updated: rows.length });
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function adminUsers(req: Request): Promise<Response> {
  await requireAdmin(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  if (req.method === "GET") {
    return await listProfiles(url.searchParams, supabaseUrl, serviceRoleKey);
  }

  if (req.method !== "POST") throw new HttpError("validation_failed", "Use GET or POST.");

  const body = await req.json() as Record<string, unknown>;

  switch (action) {
    case "grant-admin":  return await setAdminByEmail(body, true, supabaseUrl, serviceRoleKey);
    case "revoke-admin": return await setAdminByEmail(body, false, supabaseUrl, serviceRoleKey);
    default:
      throw new HttpError("validation_failed", `Unknown action: "${action}".`);
  }
}

export const handler = withEnvelope(adminUsers);
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
