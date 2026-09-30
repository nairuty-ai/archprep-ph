/* supabase/functions/_shared/quiz.mjs — quiz delivery, expressed as pure
 * functions.
 *
 * `get-quiz` (and later `grade-quiz`) is mostly URL construction, response
 * interpretation, and payload shaping. All three are pure, so they live here and
 * are unit-tested under `node --test` (tests/quiz-payload.test.mjs); the
 * function's index.ts keeps only the `fetch` and the environment read. Same
 * split as _shared/postgrest.mjs and _shared/scrub.mjs, and for the same reason:
 * Deno is not a test dependency of this repository.
 *
 * The answer-key guarantee (Requirement 6) is enforced here three times over,
 * deliberately redundantly, because one mistake in this file is the whole
 * product's worst failure:
 *
 *   1. `safeQuestionsQueryUrl` names four columns explicitly. `correct_key` and
 *      `explanation` are never requested, so they never arrive, so they are
 *      never in the function's memory — there is no object for a future
 *      refactor to accidentally serialise (design.md → get-quiz).
 *   2. `buildQuizPayload` copies the four safe fields by name rather than
 *      spreading a row. An answer field that somehow arrived anyway is dropped
 *      by construction rather than by a delete pass that could be reordered.
 *   3. `assertAnswerFree` inspects the finished payload and throws instead of
 *      returning if either field name appears anywhere in it. This is the
 *      fail-closed backstop Requirement 6 criterion 11 asks for.
 *
 * PostgREST is called over plain `fetch` rather than through supabase-js, as
 * everywhere else in this project: these are single-table reads, and a client
 * library would be a runtime dependency added for four URLs.
 */

/** A Postgres uuid. Every id this module accepts is one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The two columns of `questions` no client response may ever carry.
 *
 * Named here as data so the query builder, the shaper, and the assertion all
 * agree, and so adding a third answer-bearing column is a one-line change that
 * automatically tightens all three.
 */
export const ANSWER_FIELDS = Object.freeze(['correct_key', 'explanation']);

/** The only columns of `questions` `get-quiz` is allowed to read. */
export const SAFE_QUESTION_COLUMNS = Object.freeze([
  'id',
  'question_number',
  'question_text',
  'options',
]);

/** Columns of `quizzes` the enrollment-gated payload needs. */
export const QUIZ_COLUMNS = Object.freeze([
  'id',
  'title',
  'subject',
  'timer_minutes',
  'published',
]);

/** Is this a well-formed uuid? */
export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function restBase(supabaseUrl, caller) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new TypeError(`${caller} requires the project URL`);
  }
  return `${supabaseUrl.trim().replace(/\/+$/, '')}/rest/v1`;
}

function requireUuid(value, caller, what) {
  if (!isUuid(value)) throw new TypeError(`${caller} requires a ${what} uuid`);
  return value;
}

/* -------------------------------------------------------------------------- */
/* Query URLs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * URL reading one quiz's metadata and published state.
 *
 * `published` is selected because Requirement 19 criterion 5 makes it part of
 * the decision, and stripped again by {@link buildQuizPayload}: the client has
 * no use for it, and a published quiz is the only one it can ever see.
 *
 * @param {string} supabaseUrl project URL
 * @param {string} quizId requested quiz
 * @returns {string} absolute PostgREST URL
 */
export function quizQueryUrl(supabaseUrl, quizId) {
  const base = restBase(supabaseUrl, 'quizQueryUrl');
  requireUuid(quizId, 'quizQueryUrl', 'quiz');

  const query = new URLSearchParams({
    select: QUIZ_COLUMNS.join(','),
    id: `eq.${quizId}`,
    limit: '1',
  });
  return `${base}/quizzes?${query.toString()}`;
}

/**
 * URL listing the products that include this quiz.
 *
 * A quiz is owned by way of a pack, so enrollment is resolved through
 * `pack_quizzes` (Requirement 19 criterion 1). A quiz may belong to several
 * packs or to none; the latter yields an empty list, which
 * {@link enrollmentQueryUrl} refuses to be called with and the handler treats as
 * "not enrolled".
 *
 * @param {string} supabaseUrl project URL
 * @param {string} quizId requested quiz
 * @returns {string} absolute PostgREST URL
 */
export function packProductsQueryUrl(supabaseUrl, quizId) {
  const base = restBase(supabaseUrl, 'packProductsQueryUrl');
  requireUuid(quizId, 'packProductsQueryUrl', 'quiz');

  const query = new URLSearchParams({
    select: 'product_id',
    quiz_id: `eq.${quizId}`,
  });
  return `${base}/pack_quizzes?${query.toString()}`;
}

/**
 * URL asking whether this user holds an enrollment for any of these products.
 *
 * `select=id` and `limit=1`: the gate needs existence, not the row. The uid is
 * the verified one from `requireUser` and every product id came from
 * `pack_quizzes`, so both are uuids by the time they reach the `in.(…)` list —
 * which is why interpolating them is safe rather than merely convenient.
 *
 * @param {string} supabaseUrl project URL
 * @param {string} uid verified user id
 * @param {readonly string[]} productIds products covering the quiz
 * @returns {string} absolute PostgREST URL
 */
export function enrollmentQueryUrl(supabaseUrl, uid, productIds) {
  const base = restBase(supabaseUrl, 'enrollmentQueryUrl');
  requireUuid(uid, 'enrollmentQueryUrl', 'verified user');

  const ids = Array.isArray(productIds) ? productIds : [];
  for (const id of ids) requireUuid(id, 'enrollmentQueryUrl', 'product');
  if (ids.length === 0) {
    // An empty list would render as `in.()`, which PostgREST rejects. The caller
    // must read "no product covers this quiz" as "not enrolled" without asking.
    throw new TypeError('enrollmentQueryUrl requires at least one product id');
  }

  const query = new URLSearchParams({
    select: 'id',
    user_id: `eq.${uid}`,
    product_id: `in.(${ids.join(',')})`,
    limit: '1',
  });
  return `${base}/enrollments?${query.toString()}`;
}

/**
 * URL reading this quiz's questions — the four safe columns, and nothing else.
 *
 * There is no `select=*` anywhere in this project's quiz path. Ordering is
 * `question_number` ascending, which is the order Requirement 19 criterion 2
 * calls for and the order the runner presents.
 *
 * @param {string} supabaseUrl project URL
 * @param {string} quizId requested quiz
 * @returns {string} absolute PostgREST URL
 */
export function safeQuestionsQueryUrl(supabaseUrl, quizId) {
  const base = restBase(supabaseUrl, 'safeQuestionsQueryUrl');
  requireUuid(quizId, 'safeQuestionsQueryUrl', 'quiz');

  const query = new URLSearchParams({
    select: SAFE_QUESTION_COLUMNS.join(','),
    quiz_id: `eq.${quizId}`,
    order: 'question_number.asc',
  });
  return `${base}/questions?${query.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* Response interpretation                                                    */
/* -------------------------------------------------------------------------- */

function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null) return [body];
  return [];
}

/**
 * The published quiz in this PostgREST body, or null.
 *
 * `published` must be exactly boolean `true`. An absent row, an empty array, a
 * null flag, and the string `"false"` all read as "no quiz", which is how
 * Requirement 19 criterion 5 (unpublished) and a nonexistent id end up
 * indistinguishable from outside: both are a 404, so the existence of an
 * unpublished quiz is not something a request can probe for.
 *
 * @param {unknown} body parsed JSON response body
 * @returns {{id: string, title: string, subject: string|null, timer_minutes: number}|null}
 */
export function publishedQuizFrom(body) {
  const row = rowsOf(body)[0];
  if (typeof row !== 'object' || row === null) return null;
  if (row.published !== true) return null;
  if (!isUuid(row.id)) return null;
  return row;
}

/**
 * The distinct product ids in a `pack_quizzes` body.
 *
 * Non-uuid values are dropped rather than passed on: they cannot match an
 * enrollment, and filtering them here keeps {@link enrollmentQueryUrl}'s
 * precondition true by construction.
 *
 * @param {unknown} body parsed JSON response body
 * @returns {string[]} unique product ids, in the order returned
 */
export function productIdsFrom(body) {
  const seen = new Set();
  for (const row of rowsOf(body)) {
    if (typeof row !== 'object' || row === null) continue;
    if (isUuid(row.product_id)) seen.add(row.product_id);
  }
  return [...seen];
}

/**
 * Does this PostgREST body prove the user holds a covering enrollment?
 *
 * One row with a uuid id, and nothing else. Every other shape — an empty array,
 * an error object, a null — reads as "not enrolled". Fail closed by
 * construction: only an explicit row grants access.
 *
 * @param {unknown} body parsed JSON response body
 * @returns {boolean}
 */
export function hasEnrollmentRow(body) {
  const row = rowsOf(body)[0];
  if (typeof row !== 'object' || row === null) return false;
  return isUuid(row.id);
}

/* -------------------------------------------------------------------------- */
/* Payload shaping                                                            */
/* -------------------------------------------------------------------------- */

function questionNumberOf(row) {
  const value = Number(row?.question_number);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

/**
 * One question object, built field by field.
 *
 * Copying four named fields rather than spreading the row is the point: if a
 * future change widens the select, or a database trigger starts returning an
 * extra column, nothing new reaches the client. `options` is passed through as
 * the stored jsonb array; a non-array becomes `[]` so the runner never has to
 * defend against a malformed row.
 *
 * @param {Record<string, unknown>} row a `questions` row
 * @returns {{id: string, question_number: number, question_text: string, options: unknown[]}}
 */
export function toSafeQuestion(row) {
  const number = questionNumberOf(row);
  return {
    id: typeof row?.id === 'string' ? row.id : null,
    question_number: Number.isFinite(number) ? number : null,
    question_text: typeof row?.question_text === 'string' ? row.question_text : '',
    options: Array.isArray(row?.options) ? row.options : [],
  };
}

/**
 * Questions in ascending `question_number`, re-sorted rather than trusted.
 *
 * PostgREST already ordered them, but the order is part of the contract the quiz
 * runner depends on, and sorting a list of at most a few hundred rows costs
 * nothing next to relying on a query string staying correct.
 *
 * @param {readonly unknown[]} rows
 * @returns {Array<{id: string, question_number: number, question_text: string, options: unknown[]}>}
 */
export function orderQuestions(rows) {
  return rowsOf(rows)
    .map(toSafeQuestion)
    .sort((a, b) => questionNumberOf(a) - questionNumberOf(b));
}

/**
 * The `get-quiz` success payload.
 *
 * Shape (frozen — `js/quiz-runner.js` depends on it, and `json()` merges it
 * alongside `ok: true`):
 *
 *   { quiz: { id, title, subject, timer_minutes },
 *     questions: [ { id, question_number, question_text, options } ] }
 *
 * `timer_minutes` defaults to 0, which the runner reads as "no countdown"
 * (Requirement 21 criterion 3). `published` is dropped: it was only ever an
 * input to the 404 decision.
 *
 * @param {Record<string, unknown>} quiz a published `quizzes` row
 * @param {readonly unknown[]} questionRows `questions` rows, safe columns only
 * @returns {{quiz: object, questions: object[]}}
 */
export function buildQuizPayload(quiz, questionRows) {
  const timer = Number(quiz?.timer_minutes);
  return {
    quiz: {
      id: typeof quiz?.id === 'string' ? quiz.id : null,
      title: typeof quiz?.title === 'string' ? quiz.title : '',
      subject: typeof quiz?.subject === 'string' ? quiz.subject : null,
      timer_minutes: Number.isFinite(timer) && timer > 0 ? Math.trunc(timer) : 0,
    },
    questions: orderQuestions(questionRows),
  };
}

/* -------------------------------------------------------------------------- */
/* The fail-closed assertion                                                  */
/* -------------------------------------------------------------------------- */

/** Thrown instead of returning a payload that mentions an answer field. */
export class AnswerLeakDetected extends Error {
  /** @param {readonly string[]} fields the answer field names that appeared */
  constructor(fields) {
    super(`quiz payload carries answer field(s): ${fields.join(', ')}`);
    this.name = 'AnswerLeakDetected';
    this.fields = Object.freeze([...fields]);
  }
}

const ANSWER_KEY_IN_JSON = ANSWER_FIELDS.map((field) => ({
  field,
  pattern: new RegExp(`"${field}"\\s*:`, 'i'),
}));

/**
 * Serialised JSON with its escaping removed, so a nested spelling cannot hide.
 *
 * A pre-serialised value comes out of `JSON.stringify` as `\"correct_key\":`,
 * and one nested a level deeper as `\\\"correct_key\\\":`. Dropping every
 * backslash collapses all of them onto the plain spelling the patterns look for,
 * at whatever depth the string was nested.
 */
function unescapeForScan(text) {
  return text.replace(/\\+/g, '');
}

/**
 * Every answer field name that appears anywhere in this payload.
 *
 * Two passes, because they fail differently:
 *
 *   structural  every object key, at every depth, compared case-insensitively.
 *               Exact: a key either is `correct_key` or it is not.
 *   serialised  the JSON text with its escaping collapsed, searched for
 *               `"correct_key":`. Catches what the structural pass cannot see —
 *               a value that is itself pre-serialised JSON, which is exactly the
 *               shape a well-meaning "just cache the whole row as a string"
 *               refactor produces.
 *
 * The serialised pass can in principle fire on question text that literally
 * contains `"correct_key":`. That is accepted: Requirement 6 criterion 11 states
 * the behaviour when the payload cannot be shown to be answer-free, and refusing
 * to serve one pathological question is the correct side to err on.
 *
 * @param {unknown} payload the finished response payload
 * @returns {string[]} offending field names, empty when the payload is clean
 */
export function findAnswerFieldNames(payload) {
  const found = new Set();

  const walk = (value, depth, seen) => {
    if (depth > 12 || typeof value !== 'object' || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, seen);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalised = key.trim().toLowerCase();
      for (const field of ANSWER_FIELDS) if (normalised === field) found.add(field);
      walk(item, depth + 1, seen);
    }
  };
  walk(payload, 0, new WeakSet());

  let text;
  try {
    text = JSON.stringify(payload);
  } catch {
    // A payload that will not serialise cannot be shown to be answer-free.
    return [...ANSWER_FIELDS];
  }
  if (typeof text === 'string') {
    const scannable = unescapeForScan(text);
    for (const { field, pattern } of ANSWER_KEY_IN_JSON) {
      if (pattern.test(scannable)) found.add(field);
    }
  }

  return ANSWER_FIELDS.filter((field) => found.has(field));
}

/**
 * Throw rather than return a payload that mentions an answer field.
 *
 * Called as the last step before the response leaves `get-quiz`, so the
 * guarantee is checked against the thing actually being sent rather than against
 * the developer's belief about it.
 *
 * @template T
 * @param {T} payload
 * @returns {T} the same payload, when it is clean
 * @throws {AnswerLeakDetected}
 */
export function assertAnswerFree(payload) {
  const leaked = findAnswerFieldNames(payload);
  if (leaked.length > 0) throw new AnswerLeakDetected(leaked);
  return payload;
}
