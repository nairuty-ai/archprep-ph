/* supabase/functions/admin-questions/index.ts — admin CRUD for quiz questions.
 *
 * GET /?quiz_id=...         — list questions for a quiz
 * POST action=create        — create question (auto-assigns question_number)
 * POST action=update        — update question by id
 * POST action=reorder       — reassign question_number by ordered_ids
 * POST action=delete        — delete question, renumber remaining
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
    console.error("admin-questions fetch failed", e);
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

function validateQuestion(fields: Record<string, unknown>, requireAll = false) {
  if (requireAll) {
    if (!fields.question_text || typeof fields.question_text !== "string") {
      throw new HttpError("validation_failed", "question_text is required.", { field: "question_text" });
    }
    if (!Array.isArray(fields.options) || fields.options.length === 0) {
      throw new HttpError("validation_failed", "options must be a non-empty array.", { field: "options" });
    }
    if (!fields.correct_key || typeof fields.correct_key !== "string") {
      throw new HttpError("validation_failed", "correct_key is required.", { field: "correct_key" });
    }
  }
  if ("options" in fields && "correct_key" in fields) {
    const opts = fields.options as Array<{ key: string }>;
    const keys = opts.map((o) => o.key);
    if (!keys.includes(fields.correct_key as string)) {
      throw new HttpError("validation_failed", "correct_key must be one of the option keys.", { field: "correct_key" });
    }
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function listQuestions(quizId: string, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  if (!quizId) throw new HttpError("validation_failed", "quiz_id is required.");
  const q = new URLSearchParams({ select: "*", quiz_id: `eq.${quizId}`, order: "question_number.asc" });
  const { status, body } = await pgFetch(`${restBase(supabaseUrl)}/questions?${q}`, {
    method: "GET",
    headers: serviceHeaders(serviceRoleKey),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ items: body });
}

async function getMaxQuestionNumber(base: string, key: string, quizId: string): Promise<number> {
  const q = new URLSearchParams({ select: "question_number", quiz_id: `eq.${quizId}`, order: "question_number.desc", limit: "1" });
  const { body } = await pgFetch(`${base}/questions?${q}`, {
    method: "GET",
    headers: serviceHeaders(key),
  });
  if (Array.isArray(body) && body.length > 0 && typeof body[0].question_number === "number") {
    return body[0].question_number;
  }
  return 0;
}

async function createQuestion(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { quiz_id, question_text, options, correct_key, explanation } = body;
  if (!quiz_id) throw new HttpError("validation_failed", "quiz_id is required.");
  validateQuestion({ question_text, options, correct_key }, true);

  const base = restBase(supabaseUrl);
  const maxNum = await getMaxQuestionNumber(base, serviceRoleKey, quiz_id as string);
  const row = { quiz_id, question_text, options, correct_key, explanation: explanation ?? null, question_number: maxNum + 1 };

  const { status, body: created } = await pgFetch(`${base}/questions`, {
    method: "POST",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ question: Array.isArray(created) ? created[0] : created });
}

async function updateQuestion(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { id, ...fields } = body;
  if (!id) throw new HttpError("validation_failed", "id is required.");
  validateQuestion(fields);
  const q = new URLSearchParams({ id: `eq.${id}` });
  const { status, body: updated } = await pgFetch(`${restBase(supabaseUrl)}/questions?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify(fields),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ question: Array.isArray(updated) ? updated[0] : updated });
}

async function reorderQuestions(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { quiz_id, ordered_ids } = body;
  if (!quiz_id) throw new HttpError("validation_failed", "quiz_id is required.");
  if (!Array.isArray(ordered_ids)) throw new HttpError("validation_failed", "ordered_ids must be an array.");

  const base = restBase(supabaseUrl);
  // Patch each question with its new number sequentially
  for (let i = 0; i < (ordered_ids as string[]).length; i++) {
    const id = ordered_ids[i];
    const q = new URLSearchParams({ id: `eq.${id}`, quiz_id: `eq.${quiz_id}` });
    const { status } = await pgFetch(`${base}/questions?${q}`, {
      method: "PATCH",
      headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
      body: JSON.stringify({ question_number: i + 1 }),
    });
    if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status} reordering question ${id}`);
  }

  return json({ quiz_id, reordered: ordered_ids.length });
}

async function deleteQuestion(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { id } = body;
  if (!id) throw new HttpError("validation_failed", "id is required.");

  const base = restBase(supabaseUrl);

  // Find the question's quiz_id before deleting
  const findQ = new URLSearchParams({ select: "quiz_id,question_number", id: `eq.${id}`, limit: "1" });
  const { body: rows } = await pgFetch(`${base}/questions?${findQ}`, {
    method: "GET",
    headers: serviceHeaders(serviceRoleKey),
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw new HttpError("not_found", "Question not found.");

  const { quiz_id } = row as { quiz_id: string; question_number: number };

  // Delete the question
  const dq = new URLSearchParams({ id: `eq.${id}` });
  const { status } = await pgFetch(`${base}/questions?${dq}`, {
    method: "DELETE",
    headers: serviceHeaders(serviceRoleKey),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);

  // Fetch remaining questions ordered by question_number and renumber
  const rq = new URLSearchParams({ select: "id", quiz_id: `eq.${quiz_id}`, order: "question_number.asc" });
  const { body: remaining } = await pgFetch(`${base}/questions?${rq}`, {
    method: "GET",
    headers: serviceHeaders(serviceRoleKey),
  });

  if (Array.isArray(remaining)) {
    for (let i = 0; i < remaining.length; i++) {
      const qid = (remaining[i] as { id: string }).id;
      const pq = new URLSearchParams({ id: `eq.${qid}` });
      await pgFetch(`${base}/questions?${pq}`, {
        method: "PATCH",
        headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
        body: JSON.stringify({ question_number: i + 1 }),
      });
    }
  }

  return json({ deleted: true, id, quiz_id });
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function adminQuestions(req: Request): Promise<Response> {
  await requireAdmin(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  if (req.method === "GET") {
    const quizId = url.searchParams.get("quiz_id") ?? "";
    return await listQuestions(quizId, supabaseUrl, serviceRoleKey);
  }

  if (req.method !== "POST") throw new HttpError("validation_failed", "Use GET or POST.");

  const body = await req.json() as Record<string, unknown>;

  switch (action) {
    case "create":  return await createQuestion(body, supabaseUrl, serviceRoleKey);
    case "update":  return await updateQuestion(body, supabaseUrl, serviceRoleKey);
    case "reorder": return await reorderQuestions(body, supabaseUrl, serviceRoleKey);
    case "delete":  return await deleteQuestion(body, supabaseUrl, serviceRoleKey);
    default:
      throw new HttpError("validation_failed", `Unknown action: "${action}".`);
  }
}

export const handler = withEnvelope(adminQuestions);
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
