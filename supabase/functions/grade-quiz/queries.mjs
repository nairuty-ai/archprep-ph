/* supabase/functions/grade-quiz/queries.mjs — the service-role reads and the
 * attempt insert, expressed as pure functions.
 *
 * Same split as _shared/postgrest.mjs: building a PostgREST URL and interpreting
 * its response body are pure, so they live here and are unit-tested under
 * `node --test`; ./index.ts keeps only the `fetch`. PostgREST is called over
 * plain `fetch` rather than through supabase-js because these are four
 * single-purpose reads and one insert, and a client library would be a runtime
 * dependency added for five URLs.
 *
 * Four reads, in the order the handler performs them:
 *
 *   1. pack_quizzes  → which products cover this quiz
 *   2. enrollments   → does the caller hold one of them        (the gate)
 *   3. questions     → question_number, options, correct_key, explanation
 *   4. settings      → answer_reveal_mode
 *
 * Steps 3 and 4 run only after step 2 has passed, so a caller with no
 * enrollment never causes an answer field or the reveal mode to be read at all
 * (Requirements 20.6 and 6.6).
 */

/** A Postgres uuid — `quizzes.id`, `products.id`, `profiles.id`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The columns the grader reads from `questions`.
 *
 * This and `get-quiz` are the only places in the platform that name
 * `correct_key` or `explanation` in a query (Requirement 6.6). `question_text`
 * is deliberately absent: grading does not need it, and the response echoes back
 * only what the client already has.
 */
export const GRADING_QUESTION_COLUMNS = 'id,question_number,options,correct_key,explanation';

/** Whether a value is a Postgres uuid. */
export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

/** `<project>/rest/v1`, with any trailing slashes on the project URL removed. */
function restBase(supabaseUrl) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new TypeError('a PostgREST URL requires the project URL');
  }
  return `${supabaseUrl.trim().replace(/\/+$/, '')}/rest/v1`;
}

function requireUuid(value, label) {
  if (!isUuid(value)) throw new TypeError(`${label} must be a uuid`);
  return value;
}

/**
 * Products that include this quiz (Requirement 19.1's `pack_quizzes` hop).
 *
 * A quiz is owned by way of a pack, so the enrollment question is "does the
 * caller hold any product that lists this quiz".
 */
export function packProductsForQuizUrl(supabaseUrl, quizId) {
  const query = new URLSearchParams({
    select: 'product_id',
    quiz_id: `eq.${requireUuid(quizId, 'quizId')}`,
  });
  return `${restBase(supabaseUrl)}/pack_quizzes?${query.toString()}`;
}

/**
 * Does this user hold an enrollment for any of these products?
 *
 * `limit=1`: the gate needs existence, not a list. Every id is uuid-validated
 * before it reaches the `in.(…)` list, so no caller-supplied text can shape the
 * filter.
 */
export function enrollmentMatchUrl(supabaseUrl, uid, productIds) {
  const ids = (Array.isArray(productIds) ? productIds : []).map((id) =>
    requireUuid(id, 'productIds entry')
  );
  if (ids.length === 0) throw new TypeError('enrollmentMatchUrl requires at least one product id');

  const query = new URLSearchParams({
    select: 'product_id',
    user_id: `eq.${requireUuid(uid, 'uid')}`,
    product_id: `in.(${ids.join(',')})`,
    limit: '1',
  });
  return `${restBase(supabaseUrl)}/enrollments?${query.toString()}`;
}

/** The questions of one quiz, answer fields included, ordered as the student saw them. */
export function questionsWithKeysUrl(supabaseUrl, quizId) {
  const query = new URLSearchParams({
    select: GRADING_QUESTION_COLUMNS,
    quiz_id: `eq.${requireUuid(quizId, 'quizId')}`,
    order: 'question_number.asc',
  });
  return `${restBase(supabaseUrl)}/questions?${query.toString()}`;
}

/** One `settings` row by key. Used for `answer_reveal_mode` (Requirement 20.11). */
export function settingValueUrl(supabaseUrl, key) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new TypeError('settingValueUrl requires a setting key');
  }
  const query = new URLSearchParams({
    select: 'key,value',
    key: `eq.${key.trim()}`,
    limit: '1',
  });
  return `${restBase(supabaseUrl)}/settings?${query.toString()}`;
}

/** The `quiz_attempts` insert target. */
export function attemptInsertUrl(supabaseUrl) {
  return `${restBase(supabaseUrl)}/quiz_attempts`;
}

/** The distinct product ids in a `pack_quizzes` response body. */
export function productIdsFrom(body) {
  if (!Array.isArray(body)) return [];
  const seen = new Set();
  for (const row of body) {
    const id = row?.product_id;
    if (isUuid(id)) seen.add(id);
  }
  return [...seen];
}

/** Whether a PostgREST body carries at least one row. */
export function hasRow(body) {
  if (Array.isArray(body)) return body.length > 0;
  return typeof body === 'object' && body !== null;
}

/**
 * The `value` of a single-row `settings` response, or null when the row is absent.
 *
 * Null is what {@link normaliseRevealMode} turns into the `answered_only`
 * fallback, so an absent row and an unreadable one behave identically
 * (Requirement 20.14).
 */
export function settingValueFrom(body) {
  const row = Array.isArray(body) ? body[0] : body;
  if (typeof row !== 'object' || row === null) return null;
  return typeof row.value === 'string' ? row.value : null;
}

/**
 * The single `quiz_attempts` row to insert (Requirement 20.4).
 *
 * `user_id` is the verified uid and never a body field; `score` and `total` are
 * the computed values. The non-negative-integer checks mirror the table's own
 * `check (score >= 0)` and `check (total >= 0)`, so a bug here fails in the
 * function with a clear message rather than as an opaque database error.
 */
export function buildAttemptRow({ uid, quizId, score, total, answers } = {}) {
  requireUuid(uid, 'uid');
  requireUuid(quizId, 'quizId');
  if (!Number.isInteger(score) || score < 0) throw new TypeError('score must be a non-negative integer');
  if (!Number.isInteger(total) || total < 0) throw new TypeError('total must be a non-negative integer');
  if (score > total) throw new TypeError('score cannot exceed total');

  const submitted = typeof answers === 'object' && answers !== null && !Array.isArray(answers)
    ? answers
    : {};

  return {
    user_id: uid,
    quiz_id: quizId,
    score,
    total,
    answers: submitted,
  };
}

/**
 * The one row an insert returned.
 *
 * Requirement 20.4 is "exactly one row", so anything else — zero rows, two rows,
 * a non-array — is a fault rather than something to paper over.
 */
export function singleInsertedRow(body) {
  const rows = Array.isArray(body) ? body : [body];
  if (rows.length !== 1 || typeof rows[0] !== 'object' || rows[0] === null) {
    throw new TypeError(`expected exactly one inserted row, got ${rows.length}`);
  }
  return rows[0];
}
