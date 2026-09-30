/* supabase/functions/admin-quizzes/index.ts — admin CRUD for quizzes.
 *
 * GET /            — list all quizzes with question_count
 * POST action=create       — create quiz
 * POST action=update       — update quiz by id
 * POST action=publish      — set published=true
 * POST action=unpublish    — set published=false
 * POST action=delete       — delete quiz (cascades questions)
 * POST action=assign-packs — set which quiz_pack products this quiz belongs to
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

async function pgFetch(url: string, opts: RequestInit): Promise<{ status: number; body: unknown; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.error("admin-quizzes fetch failed", e);
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

async function listQuizzes(supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const q = new URLSearchParams({
    select: "*,questions(count)",
    order: "created_at.desc",
  });
  const { status, body, headers } = await pgFetch(`${restBase(supabaseUrl)}/quizzes?${q}`, {
    method: "GET",
    headers: { ...serviceHeaders(serviceRoleKey), prefer: "count=exact" },
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ items: body, total_count: parseTotalCount(headers.get("content-range")) });
}

async function createQuiz(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { title, slug, subject, timer_minutes = 0, published = false } = body;
  if (!title || !slug) throw new HttpError("validation_failed", "title and slug are required.");
  if (typeof timer_minutes === "number" && timer_minutes < 0) {
    throw new HttpError("validation_failed", "timer_minutes must be >= 0.", { field: "timer_minutes" });
  }
  const row = { title, slug, subject: subject ?? null, timer_minutes, published };
  const { status, body: created } = await pgFetch(`${restBase(supabaseUrl)}/quizzes`, {
    method: "POST",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ quiz: Array.isArray(created) ? created[0] : created });
}

async function updateQuiz(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { id, ...fields } = body;
  if (!id) throw new HttpError("validation_failed", "id is required.");
  if ("timer_minutes" in fields && (typeof fields.timer_minutes !== "number" || fields.timer_minutes < 0)) {
    throw new HttpError("validation_failed", "timer_minutes must be >= 0.", { field: "timer_minutes" });
  }
  const q = new URLSearchParams({ id: `eq.${id}` });
  const { status, body: updated } = await pgFetch(`${restBase(supabaseUrl)}/quizzes?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify(fields),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ quiz: Array.isArray(updated) ? updated[0] : updated });
}

async function setPublished(body: Record<string, unknown>, published: boolean, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { quiz_id } = body;
  if (!quiz_id) throw new HttpError("validation_failed", "quiz_id is required.");
  const q = new URLSearchParams({ id: `eq.${quiz_id}` });
  const { status } = await pgFetch(`${restBase(supabaseUrl)}/quizzes?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
    body: JSON.stringify({ published }),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ quiz_id, published });
}

async function deleteQuiz(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { quiz_id } = body;
  if (!quiz_id) throw new HttpError("validation_failed", "quiz_id is required.");
  // pack_quizzes rows will be removed by the delete (or via cascade) — this is expected.
  const q = new URLSearchParams({ id: `eq.${quiz_id}` });
  const { status } = await pgFetch(`${restBase(supabaseUrl)}/quizzes?${q}`, {
    method: "DELETE",
    headers: serviceHeaders(serviceRoleKey),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ deleted: true, quiz_id });
}

async function assignPacks(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { quiz_id, product_ids } = body;
  if (!quiz_id) throw new HttpError("validation_failed", "quiz_id is required.");
  if (!Array.isArray(product_ids)) throw new HttpError("validation_failed", "product_ids must be an array.");

  const base = restBase(supabaseUrl);

  // Delete all existing pack_quizzes rows for this quiz
  const dq = new URLSearchParams({ quiz_id: `eq.${quiz_id}` });
  const { status: dStatus } = await pgFetch(`${base}/pack_quizzes?${dq}`, {
    method: "DELETE",
    headers: serviceHeaders(serviceRoleKey),
  });
  if (dStatus >= 300) throw new HttpError("internal_error", `PostgREST delete returned ${dStatus}`);

  // Insert new rows if any
  if (product_ids.length > 0) {
    const rows = (product_ids as string[]).map((product_id) => ({ quiz_id, product_id }));
    const { status: iStatus } = await pgFetch(`${base}/pack_quizzes`, {
      method: "POST",
      headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
      body: JSON.stringify(rows),
    });
    if (iStatus >= 300) throw new HttpError("internal_error", `PostgREST insert returned ${iStatus}`);
  }

  return json({ quiz_id, product_ids });
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function adminQuizzes(req: Request): Promise<Response> {
  await requireAdmin(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  if (req.method === "GET") {
    return await listQuizzes(supabaseUrl, serviceRoleKey);
  }

  if (req.method !== "POST") throw new HttpError("validation_failed", "Use GET or POST.");

  const body = await req.json() as Record<string, unknown>;

  switch (action) {
    case "create":    return await createQuiz(body, supabaseUrl, serviceRoleKey);
    case "update":    return await updateQuiz(body, supabaseUrl, serviceRoleKey);
    case "publish":   return await setPublished(body, true, supabaseUrl, serviceRoleKey);
    case "unpublish": return await setPublished(body, false, supabaseUrl, serviceRoleKey);
    case "delete":    return await deleteQuiz(body, supabaseUrl, serviceRoleKey);
    case "assign-packs": return await assignPacks(body, supabaseUrl, serviceRoleKey);
    default:
      throw new HttpError("validation_failed", `Unknown action: "${action}".`);
  }
}

export const handler = withEnvelope(adminQuizzes);
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
