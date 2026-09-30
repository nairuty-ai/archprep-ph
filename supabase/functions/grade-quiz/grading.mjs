/* supabase/functions/grade-quiz/grading.mjs — grading and reveal scoping.
 *
 * The whole of Requirement 20's grading decision lives here as pure functions of
 * two inputs: the `questions` rows read with the service role, and the answers
 * map the student submitted. Nothing in this file reads the environment, calls
 * `fetch`, or touches a `Request`, which is what lets `tests/grade-quiz.test.mjs`
 * exercise it under `node --test` while Deno loads the same file at the edge
 * (Deno is not installed in this workspace; ./index.ts keeps the impure half).
 *
 * Two guarantees are structural rather than a habit here:
 *
 *   Requirement 20.10 — the score cannot be influenced by the request body,
 *   because `gradeSubmission` is given the `questions` rows and an answers map
 *   and has no parameter through which a `score`, a `total`, or a correctness
 *   flag could arrive. `sanitiseSubmittedAnswers` reads `body.answers` and
 *   nothing else, so a hostile field is not filtered out — it is never read.
 *
 *   Requirements 6.10 / 20.5 — under `answered_only` an unanswered question's
 *   result object is built *without* the `correct_key` and `explanation` keys,
 *   not with them set to null, so a blank submission carries zero answer-key
 *   values (Requirement 6.14). `assertRevealScope` re-checks the finished set
 *   before it is serialised, because leaking the key one blank submission at a
 *   time is the failure this whole function exists to prevent.
 */

/** The `settings` key holding the reveal mode. Read with the service role only. */
export const ANSWER_REVEAL_MODE_KEY = 'answer_reveal_mode';

/** The only two accepted values (Requirement 20.13). */
export const ANSWER_REVEAL_MODES = Object.freeze(['answered_only', 'full_reveal']);

/**
 * The seeded value, and the fallback when the setting row is absent
 * (Requirements 20.12 and 20.14). It is the more restrictive of the two, so a
 * missing row cannot widen what a submission reveals.
 */
export const DEFAULT_ANSWER_REVEAL_MODE = 'answered_only';

/**
 * Request-body fields a client might send that grading must not consult.
 *
 * Listed for documentation and for the test that asserts they have no effect.
 * Nothing in this module reads them: {@link sanitiseSubmittedAnswers} returns
 * only `body.answers`, so there is no code path along which they could apply.
 */
export const IGNORED_SUBMISSION_FIELDS = Object.freeze([
  'score',
  'total',
  'correct',
  'correct_count',
  'correctness',
  'is_correct',
  'results',
  'answers_correct',
  'user_id',
]);

/** Thrown when a finished result set does not match the active reveal mode. */
export class RevealScopeError extends Error {
  /**
   * @param {string} reason machine-readable cause, for the server-side log
   * @param {number | null} [questionNumber] the offending question, where known
   */
  constructor(reason, questionNumber = null) {
    super(`reveal scope violated: ${reason}`);
    this.name = 'RevealScopeError';
    this.reason = reason;
    this.questionNumber = questionNumber;
  }
}

/**
 * The reveal mode a stored setting value means.
 *
 * Fail closed: only the exact string `full_reveal` (with surrounding whitespace
 * tolerated) widens the reveal. An absent row, a null, a misspelling, a
 * different case, or a non-string all resolve to `answered_only`, which is both
 * Requirement 20.14's fallback and the safe answer to "we are not sure".
 *
 * @param {unknown} value raw `settings.value`, or undefined when the row is absent
 * @returns {'answered_only' | 'full_reveal'}
 */
export function normaliseRevealMode(value) {
  if (typeof value !== 'string') return DEFAULT_ANSWER_REVEAL_MODE;
  return value.trim() === 'full_reveal' ? 'full_reveal' : DEFAULT_ANSWER_REVEAL_MODE;
}

/**
 * The answers map of a submission, and nothing else from the body.
 *
 * Returns an empty object for a body with no usable `answers`, so a submission
 * that omits it grades as entirely unanswered rather than failing.
 *
 * @param {unknown} body parsed request body
 * @returns {Record<string, unknown>}
 */
export function sanitiseSubmittedAnswers(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const answers = /** @type {Record<string, unknown>} */ (body).answers;
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return {};
  return /** @type {Record<string, unknown>} */ (answers);
}

/**
 * The option keys a question actually offers.
 *
 * `options` is jsonb — an array of `{ key, label }` — so a malformed row yields
 * an empty list, which makes every submitted answer out-of-options and
 * therefore incorrect (Requirement 20.7) rather than accidentally correct.
 *
 * @param {unknown} options raw `questions.options`
 * @returns {string[]}
 */
export function optionKeysOf(options) {
  if (!Array.isArray(options)) return [];
  const keys = [];
  for (const option of options) {
    if (typeof option === 'string') {
      keys.push(option);
    } else if (typeof option === 'object' && option !== null && typeof option.key === 'string') {
      keys.push(option.key);
    }
  }
  return keys;
}

/**
 * A submitted value read as an answer key, or null when it is not one.
 *
 * `undefined`, `null`, and the empty string are "unanswered". A number or a
 * boolean is stringified, because a body may legitimately send `1` for a
 * numbered option and it must then be graded as the out-of-options key it is.
 * An object or an array is discarded rather than stringified: `[object Object]`
 * is not something a student chose, and treating it as unanswered is the
 * restrictive reading.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function submittedKeyOf(value) {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  return null;
}

function own(bag, key) {
  return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined;
}

/**
 * The key submitted for one question, or null.
 *
 * The map is keyed by question `id` — the design's `answers[q.id]` — with
 * `question_number` accepted as a fallback so an attempt recorded against the
 * numbering the student saw still grades. `id` wins when both are present.
 *
 * @param {Record<string, unknown>} answers
 * @param {{ id?: unknown, question_number?: unknown }} question
 * @returns {string | null}
 */
export function submittedKeyFor(answers, question) {
  if (typeof answers !== 'object' || answers === null) return null;

  const id = question?.id;
  if (typeof id === 'string' || typeof id === 'number') {
    const byId = submittedKeyOf(own(answers, String(id)));
    if (byId !== null) return byId;
  }

  const number = question?.question_number;
  if (typeof number === 'number' || typeof number === 'string') {
    return submittedKeyOf(own(answers, String(number)));
  }
  return null;
}

function questionNumberOf(question, fallbackIndex) {
  const number = Number(question?.question_number);
  return Number.isInteger(number) && number > 0 ? number : fallbackIndex + 1;
}

/**
 * Grade one submission against the stored questions.
 *
 * ```js
 * const graded = gradeSubmission({
 *   questions,                               // service-role rows, with correct_key
 *   answers: sanitiseSubmittedAnswers(body), // the body's answers map, only
 *   revealMode: normaliseRevealMode(stored), // settings.answer_reveal_mode
 * });
 * ```
 *
 * Scoring (Requirements 20.2, 20.3, 20.7):
 *   correct  ⟺ answered ∧ key ∈ options ∧ key = correct_key
 * An unanswered question and a key absent from that question's `options` are
 * both incorrect. The in-options test is applied even though a well-formed row
 * always has `correct_key` among its options, so a corrupt row cannot turn an
 * out-of-options guess into a point.
 *
 * Reveal (Requirements 6.10, 6.12, 20.5, 20.9, 20.10):
 *   reveal ⟺ mode = full_reveal ∨ answered
 * An out-of-options key counts as *answered* for reveal and *incorrect* for
 * scoring, which is Requirement 20.10 exactly.
 *
 * @param {{ questions?: unknown, answers?: unknown, revealMode?: unknown }} input
 * @returns {{
 *   mode: 'answered_only' | 'full_reveal',
 *   score: number,
 *   total: number,
 *   answered_count: number,
 *   answers: Record<string, string>,
 *   results: Array<Record<string, unknown>>,
 * }}
 */
export function gradeSubmission({ questions, answers, revealMode } = {}) {
  const mode = normaliseRevealMode(revealMode);
  const rows = Array.isArray(questions) ? questions.filter(isRow) : [];
  const submitted = typeof answers === 'object' && answers !== null && !Array.isArray(answers)
    ? /** @type {Record<string, unknown>} */ (answers)
    : {};

  const ordered = rows
    .map((question, index) => ({ question, number: questionNumberOf(question, index), index }))
    .sort((a, b) => (a.number - b.number) || (a.index - b.index));

  /** @type {Record<string, string>} */
  const storedAnswers = {};
  const results = [];
  let score = 0;
  let answeredCount = 0;

  for (const { question, number } of ordered) {
    const key = submittedKeyFor(submitted, question);
    const answered = key !== null;
    const inOptions = answered && optionKeysOf(question.options).includes(key);
    const correct = inOptions &&
      typeof question.correct_key === 'string' &&
      key === question.correct_key;

    if (answered) {
      answeredCount += 1;
      // Recorded under the database id where there is one, so the stored attempt
      // is readable after a renumbering (Requirement 20.4's submitted answers).
      storedAnswers[question.id === undefined || question.id === null ? String(number) : String(question.id)] = key;
    }
    if (correct) score += 1;

    const reveal = mode === 'full_reveal' || answered;
    results.push({
      question_id: question.id ?? null,
      question_number: number,
      answered,
      submitted_key: key,
      correct,
      // Conditional spread, not `: null`: under answered_only an unanswered
      // question's result must carry no such key at all (Requirement 6.14).
      ...(reveal
        ? {
          correct_key: typeof question.correct_key === 'string' ? question.correct_key : null,
          explanation: question.explanation ?? null,
        }
        : {}),
    });
  }

  return {
    mode,
    score,
    total: ordered.length,
    answered_count: answeredCount,
    answers: storedAnswers,
    results,
  };
}

function isRow(value) {
  return typeof value === 'object' && value !== null;
}

/** Whether a finished result object carries either answer field. */
export function revealsAnswer(result) {
  if (typeof result !== 'object' || result === null) return false;
  return Object.prototype.hasOwnProperty.call(result, 'correct_key') ||
    Object.prototype.hasOwnProperty.call(result, 'explanation');
}

/**
 * The fail-closed check run on the finished results before they are serialised.
 *
 * Asserts set equality both ways, which is Property 3's statement:
 *   answered_only → revealed set = answered set
 *   full_reveal   → revealed set = every question
 * Throws {@link RevealScopeError} rather than returning false, so a future
 * refactor that widens the reveal produces an error response instead of a quiet
 * disclosure.
 *
 * @param {Array<Record<string, unknown>>} results
 * @param {unknown} revealMode
 * @returns {Array<Record<string, unknown>>} the same results, when they are sound
 */
export function assertRevealScope(results, revealMode) {
  const mode = normaliseRevealMode(revealMode);
  if (!Array.isArray(results)) throw new RevealScopeError('results_not_an_array');

  for (const result of results) {
    const reveals = revealsAnswer(result);
    const shouldReveal = mode === 'full_reveal' || result?.answered === true;
    const number = typeof result?.question_number === 'number' ? result.question_number : null;

    if (reveals && !shouldReveal) throw new RevealScopeError('unanswered_question_revealed', number);
    if (!reveals && shouldReveal) throw new RevealScopeError('expected_reveal_missing', number);
  }
  return results;
}
