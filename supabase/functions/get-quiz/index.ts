/* supabase/functions/get-quiz/index.ts — enrollment-gated quiz delivery.
 *
 * Requirement 19, and the half of Requirement 6 that lives outside the database.
 *
 * The order of operations is the security design:
 *
 *   1. `requireUser` — identity from the bearer token, never from the body.
 *   2. `quiz_id` from the request, validated as a uuid.
 *   3. the quiz row: absent or `published = false` is a 404 (19.5), decided
 *      before any enrollment work so an unpublished quiz looks identical to a
 *      nonexistent one.
 *   4. enrollment, resolved through `pack_quizzes` (19.1). No match is a 403
 *      with the `not_enrolled` code — the exact code `js/api.js` turns into the
 *      purchase-required state (33.7) — and, being an error envelope, with zero
 *      question objects (19.4).
 *   5. the questions, four columns only. The answer fields are never requested,
 *      so they are never in this process's memory.
 *   6. `assertAnswerFree` on the finished payload. Throws rather than returns if
 *      either answer field name appears (6.11).
 *
 * Every read uses the service role, because Requirement 6 leaves `questions`
 * with no grant to any client role at all (migration 0006) — there is no
 * user-scoped way to read a question, by design. The role is therefore the
 * reason the enrollment check above has to be explicit: RLS is not standing
 * behind it here.
 *
 * The pure half of this function — every URL, every response reading, the
 * payload shape, and the assertion — is in ../_shared/quiz.mjs and tested under
 * `node --test`. What remains here is the `fetch` and the environment read.
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import {
  AnswerLeakDetected,
  assertAnswerFree,
  buildQuizPayload,
  enrollmentQueryUrl,
  hasEnrollmentRow,
  isUuid,
  packProductsQueryUrl,
  productIdsFrom,
  publishedQuizFrom,
  quizQueryUrl,
  safeQuestionsQueryUrl,
} from "../_shared/quiz.mjs";

/** Ceiling on each read, so a stalled database cannot hang the request. */
const READ_TIMEOUT_MS = 10_000;

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const value = (globalThis as any).Deno?.env?.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    // Environment unreadable. Treated as unset, which becomes config_missing.
    return undefined;
  }
}

/** Project URL and service-role key, or a `config_missing` naming the absentee. */
function serviceContext(): { supabaseUrl: string; serviceRoleKey: string } {
  const supabaseUrl = env("SUPABASE_URL");
  if (!supabaseUrl) throw configMissing("SUPABASE_URL");

  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");

  return { supabaseUrl, serviceRoleKey };
}

/**
 * One service-role PostgREST read.
 *
 * A failed read is an `internal_error`, never a `not_found` and never a
 * `not_enrolled`: telling a paying student they do not own something because the
 * database hiccupped would be the wrong answer to the wrong question.
 */
async function serviceRead(url: string, serviceRoleKey: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("get-quiz read failed", error);
    throw new HttpError("internal_error");
  }

  if (!response.ok) {
    console.error("get-quiz read returned", response.status);
    await response.body?.cancel();
    throw new HttpError("internal_error");
  }

  try {
    return await response.json();
  } catch (error) {
    console.error("get-quiz read returned an unreadable body", error);
    throw new HttpError("internal_error");
  }
}

/**
 * The requested `quiz_id`, from the query string or the JSON body.
 *
 * Both are accepted because the runner opens a quiz by link and the API layer
 * posts: neither is an identity, so neither is a trust decision. Anything that
 * is not a uuid is `validation_failed` rather than a 404, since a malformed id
 * is a broken caller rather than a missing quiz.
 */
async function quizIdFrom(req: Request): Promise<string> {
  const url = new URL(req.url);
  let candidate: unknown = url.searchParams.get("quiz_id");

  if (!candidate && req.method !== "GET" && req.method !== "HEAD") {
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

export async function getQuiz(req: Request): Promise<Response> {
  const uid = await requireUser(req);
  const quizId = await quizIdFrom(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();

  // Requirement 19.5 — unpublished and nonexistent are the same 404.
  const quiz = publishedQuizFrom(
    await serviceRead(quizQueryUrl(supabaseUrl, quizId), serviceRoleKey),
  );
  if (!quiz) throw new HttpError("not_found", "This quiz isn't available.");

  // Requirement 19.1 — enrollment resolved through pack_quizzes.
  const productIds = productIdsFrom(
    await serviceRead(packProductsQueryUrl(supabaseUrl, quizId), serviceRoleKey),
  );
  const enrolled = productIds.length > 0 &&
    hasEnrollmentRow(
      await serviceRead(
        enrollmentQueryUrl(supabaseUrl, uid, productIds),
        serviceRoleKey,
      ),
    );

  // Requirement 19.4 — 403 with zero question objects. The code must be
  // `not_enrolled`, not a bare 403: a bare 403 resolves to `not_admin`, and the
  // front end's purchase-required state keys on `not_enrolled` (33.7).
  if (!enrolled) {
    throw new HttpError("not_enrolled", "Buy the pack to open this quiz.");
  }

  // Requirement 19.2 and 19.3 — four safe columns, ordered by question_number.
  const payload = buildQuizPayload(
    quiz,
    await serviceRead(safeQuestionsQueryUrl(supabaseUrl, quizId), serviceRoleKey) as
      unknown[],
  );

  // Requirement 6.11 — the fail-closed backstop. Throwing here returns an error
  // envelope, which carries zero question objects by construction.
  try {
    assertAnswerFree(payload);
  } catch (error) {
    if (error instanceof AnswerLeakDetected) {
      console.error("get-quiz refused to serve a payload", {
        quiz_id: quizId,
        fields: error.fields,
      });
      throw new HttpError("internal_error", "This quiz is unavailable right now.");
    }
    throw error;
  }

  return json(payload);
}

/** The wrapped handler: CORS preflight, envelope, and no unhandled throw. */
export const handler = withEnvelope(getQuiz);

// Reached through `globalThis` for the same reason the environment is: this
// module is also read by tooling that has no Deno global.
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
