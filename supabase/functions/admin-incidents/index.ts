/* supabase/functions/admin-incidents/index.ts — admin payment incident management.
 *
 * GET /                         — list payment_incidents (unresolved by default, paged)
 * GET /?include_resolved=true   — include resolved incidents
 * POST action=resolve           — mark incident resolved (resolved_at=now, resolved_by=uid)
 *
 * Note: payload is excluded from responses to avoid leaking payer PII.
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/admin.ts";

const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 50;
const SAFE_COLUMNS = "id,kind,order_id,hitpay_payment_id,reported_amount,reported_currency,stored_amount,stored_currency,resolved_at,resolved_by,created_at";

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
    console.error("admin-incidents fetch failed", e);
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

async function listIncidents(searchParams: URLSearchParams, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;
  const includeResolved = searchParams.get("include_resolved") === "true";

  const q = new URLSearchParams({
    select: SAFE_COLUMNS,
    order: "created_at.desc",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (!includeResolved) q.set("resolved_at", "is.null");

  const { status, body, headers } = await pgFetch(`${restBase(supabaseUrl)}/payment_incidents?${q}`, {
    method: "GET",
    headers: { ...serviceHeaders(serviceRoleKey), prefer: "count=exact" },
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ items: body, page, total_count: parseTotalCount(headers.get("content-range")) });
}

async function resolveIncident(
  body: Record<string, unknown>,
  uid: string,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<Response> {
  const { incident_id } = body;
  if (!incident_id) throw new HttpError("validation_failed", "incident_id is required.");
  const q = new URLSearchParams({ id: `eq.${incident_id}` });
  const { status } = await pgFetch(`${restBase(supabaseUrl)}/payment_incidents?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
    body: JSON.stringify({ resolved_at: new Date().toISOString(), resolved_by: uid }),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ incident_id, resolved: true });
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function adminIncidents(req: Request): Promise<Response> {
  const uid = await requireAdmin(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  if (req.method === "GET") {
    return await listIncidents(url.searchParams, supabaseUrl, serviceRoleKey);
  }

  if (req.method !== "POST") throw new HttpError("validation_failed", "Use GET or POST.");

  const body = await req.json() as Record<string, unknown>;

  switch (action) {
    case "resolve": return await resolveIncident(body, uid, supabaseUrl, serviceRoleKey);
    default:
      throw new HttpError("validation_failed", `Unknown action: "${action}".`);
  }
}

export const handler = withEnvelope(adminIncidents);
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
