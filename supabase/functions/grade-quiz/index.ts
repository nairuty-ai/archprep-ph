/* supabase/functions/grade-quiz/index.ts — enrollment-gated server-side grading.
 *
 * Requirement 20, and the grading half of Requirement 6.
 *
 * The order of operations is the security design:
 *
 *   1. `requireUser`    — identity from the bearer token, never from the body.
 *   2. `quiz_id`        — from the request, validated as a uuid.
 *   3. enrollment gate  — pack_quizzes → enrollments. 403 on miss (20.6).
 *   4. questions read   — with correct_key + explanation (service role, 6.6).
 *   5. reveal-mode read — answer_reveal_mode from settings (service role, 20.11).
 *   6. grade            — gradeSubmission() from ./grading.mjs, pure.
 *   7. assertRevealScope — fail-closed check before the response leaves (6.12).
 *   8. attempt insert   — exactly one quiz_attempts row (20.4).
 *   9. return           — score, total, per-question results, reveal-scoped keys.
 *
 * Steps 4 and 5 run only after step 3 passes, so a caller with no enrollment
 * never causes correct_key or explanation to be read from the database (6.6).
 *
 * The pure half — grading, reveal scoping, URL builders, row builders — lives in
 * ./grading.mjs and ./queries.mjs, tested under `node --test`. What remains here
 * is the `fetch`, the environment read, and the Deno.serve entry point.
 *
 * Requirements: 19.1, 20.1–20.14, 6.6, 6.10, 6.12.
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import {
  assertRevealScope,
  gradeSubmission,
  normaliseRevealMode,
  sanitiseSubmittedAnswers,
  RevealScopeError,
} from "./grading.mjs";
import {
  attemptInsertUrl,
  buildAttemptRow,
  enrollmentMatchUrl,
  isUuid,
  packProductsForQuizUrl,
  productIdsFrom,
  hasRow,
  questionsWithKeysUrl,
  settingValueFrom,
  settingValueUrl,
  singleInsertedRow,
  GRADING_QUESTION_COLUMNS,
} from "./queries.mjs";

const READ_TIMEOUT_MS  = 10_000;
const WRITE_TIMEOUT_MS = 10_000;

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
  const supabaseUrl = env("SUPABASE_URL");
  if (!supabaseUrl) throw configMissing("SUPABASE_URL");

  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");

  return { supabaseUrl, serviceRoleKey };
}

function serviceHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    accept: "application/json",
    ...extra,
  };
}

async function serviceRead(url: string, serviceRoleKey: string, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: serviceHeaders(serviceRoleKey),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`grade-quiz ${what} read failed`, error);
    throw new HttpError("internal_error");
  }

  if (!response.ok) {
    console.error(`grade-quiz ${what} read returned`, response.status);
    await response.body?.cancel();
    throw new HttpError("internal_error");
  }

  try {
    return await response.json();
  } catch (error) {
    console.error(`grade-quiz ${what} returned unreadable body`, error);
    throw new HttpError("internal_error");
  }
}

async function servicePost(
  url: string,
  serviceRoleKey: string,
  row: Record<string, unknown>,
  what: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: serviceHeaders(serviceRoleKey, {
        "content-type": "application/json",
        prefer: "return=representation",
      }),
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`grade-quiz ${what} write failed`, error);
    throw new HttpError("internal_error");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`grade-quiz ${what} returned`, response.status, detail.slice(0, 500));
    throw new HttpError("internal_error");
  }

  try {
    return await response.json();
  } catch (error) {
    console.error(`grade-quiz ${what} returned unreadable body`, error);
    throw new HttpError("internal_error");
  }
}

async function quizIdFrom(req: Request): Promise<string> {
  const url = new URL(req.url);
  let candidate: unknown = url.searchParams.get("quiz_id");

  if (!candidate && req.method === "POST") {
    try {
      const body = await req.json();
      candidate = (body as { quiz_id?: unknown } | null)?.quiz_id;
    } catch {
      candidate = null;
    }
  }

  if (!isUuid(candidate)) {
    throw new HttpError("validation_failed", "A valid quiz id is required.", {
      field: "quiz_id",
    });
  }
  return candidate as string;
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.clone().json();
  } catch {
    return null;
  }
}

export async function gradeQuiz(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError("validation_failed", "Send this request as a POST.");
  }

  const uid     = await requireUser(req);
  const quizId  = await quizIdFrom(req);
  const body    = await readJsonBody(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();

  // Step 3: enrollment gate — resolve through pack_quizzes.
  // Requirement 19.1: access is to a product, not directly to a quiz.
  const packBody   = await serviceRead(packProductsForQuizUrl(supabaseUrl, quizId), serviceRoleKey, "pack_quizzes");
  const productIds = productIdsFrom(packBody);

  const enrolled = productIds.length > 0 &&
    hasRow(
      await serviceRead(enrollmentMatchUrl(supabaseUrl, uid, productIds), serviceRoleKey, "enrollment"),
    );

  // Requirement 20.6: 403 with zero quiz_attempts rows inserted.
  if (!enrolled) {
    throw new HttpError("not_enrolled", "Buy the pack to access this quiz.");
  }

  // Step 4: questions WITH correct_key + explanation — service role only (6.6).
  const questions = await serviceRead(
    questionsWithKeysUrl(supabaseUrl, quizId),
    serviceRoleKey,
    "questions",
  );

  // Step 5: answer_reveal_mode from settings — service role only (20.11, 6.13).
  const settingBody  = await serviceRead(settingValueUrl(supabaseUrl, "answer_reveal_mode"), serviceRoleKey, "settings");
  const storedMode   = settingValueFrom(settingBody);
  const revealMode   = normaliseRevealMode(storedMode);

  // Step 6: pure grading — no request fields other than `answers` (20.8, 20.10).
  const answers  = sanitiseSubmittedAnswers(body);
  const graded   = gradeSubmission({ questions, answers, revealMode });

  // Step 7: fail-closed reveal scope assertion (6.12).
  try {
    assertRevealScope(graded.results, graded.mode);
  } catch (error) {
    if (error instanceof RevealScopeError) {
      console.error("grade-quiz refused to serve results", {
        quiz_id: quizId,
        reason: error.reason,
        question_number: error.questionNumber,
      });
      throw new HttpError("internal_error", "Grading result unavailable. Please try again.");
    }
    throw error;
  }

  // Step 8: insert exactly one quiz_attempts row (20.4).
  const attemptRow = buildAttemptRow({
    uid,
    quizId,
    score: graded.score,
    total: graded.total,
    answers: graded.answers,
  });
  const insertedBody = await servicePost(
    attemptInsertUrl(supabaseUrl),
    serviceRoleKey,
    attemptRow,
    "attempt insert",
  );
  singleInsertedRow(insertedBody); // throws if not exactly one row

  // Step 9: return the graded result.
  return json({
    quiz_id: quizId,
    score: graded.score,
    total: graded.total,
    answered_count: graded.answered_count,
    reveal_mode: graded.mode,
    results: graded.results,
  });
}

export const handler = withEnvelope(gradeQuiz);

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
