/* tests/quiz-payload.test.mjs — unit tests for the pure half of `get-quiz`.
 *
 * supabase/functions/get-quiz/index.ts is TypeScript under Deno, which is not
 * installed here, so every decision that can be pure is pure and lives in
 * _shared/quiz.mjs: the query URLs, the response reading, the payload shape, and
 * the fail-closed assertion. Those are what this file exercises.
 *
 * Two of them carry the answer-key guarantee and get the most attention:
 *
 *   safeQuestionsQueryUrl  must name four columns and never the answer fields,
 *                          because a column that is never requested is a column
 *                          that is never in the function's memory.
 *   assertAnswerFree       must throw on a payload that carries `correct_key`,
 *                          including one nested inside a pre-serialised string,
 *                          since that is Requirement 6 criterion 11's backstop.
 *
 * The end-to-end assertion over a real response body is Property 2 (task 9.2);
 * this file stays at the level of the functions themselves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  ANSWER_FIELDS,
  AnswerLeakDetected,
  SAFE_QUESTION_COLUMNS,
  assertAnswerFree,
  buildQuizPayload,
  enrollmentQueryUrl,
  findAnswerFieldNames,
  hasEnrollmentRow,
  isUuid,
  orderQuestions,
  packProductsQueryUrl,
  productIdsFrom,
  publishedQuizFrom,
  quizQueryUrl,
  safeQuestionsQueryUrl,
  toSafeQuestion,
} from '../supabase/functions/_shared/quiz.mjs';
import { arbQuiz } from './generators.mjs';

const PROJECT_URL = 'https://abcdefghijklmnop.supabase.co';
const QUIZ_ID = '11111111-2222-4333-8444-555555555555';
const USER_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PRODUCT_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

/** The query string of a built URL, already percent-decoded. */
function paramsOf(url) {
  return new URL(url).searchParams;
}

// ---------------------------------------------------------------------------
// Query URLs
// ---------------------------------------------------------------------------

test('the quiz read asks for metadata plus published, one row', () => {
  const params = paramsOf(quizQueryUrl(PROJECT_URL, QUIZ_ID));
  assert.equal(params.get('select'), 'id,title,subject,timer_minutes,published');
  assert.equal(params.get('id'), `eq.${QUIZ_ID}`);
  assert.equal(params.get('limit'), '1');
  assert.ok(quizQueryUrl(PROJECT_URL, QUIZ_ID).startsWith(`${PROJECT_URL}/rest/v1/quizzes?`));
});

test('the questions read names exactly the four safe columns', () => {
  const params = paramsOf(safeQuestionsQueryUrl(PROJECT_URL, QUIZ_ID));
  assert.equal(params.get('select'), 'id,question_number,question_text,options');
  assert.deepEqual(params.get('select').split(','), [...SAFE_QUESTION_COLUMNS]);
  assert.equal(params.get('quiz_id'), `eq.${QUIZ_ID}`);
  assert.equal(params.get('order'), 'question_number.asc');
});

test('no quiz-path URL ever mentions an answer field or a wildcard select', () => {
  const urls = [
    quizQueryUrl(PROJECT_URL, QUIZ_ID),
    packProductsQueryUrl(PROJECT_URL, QUIZ_ID),
    enrollmentQueryUrl(PROJECT_URL, USER_ID, [PRODUCT_ID]),
    safeQuestionsQueryUrl(PROJECT_URL, QUIZ_ID),
  ];
  for (const url of urls) {
    for (const field of ANSWER_FIELDS) {
      assert.ok(!url.includes(field), `${url} must not mention ${field}`);
    }
    assert.ok(!paramsOf(url).get('select').includes('*'), `${url} must not select *`);
  }
});

test('enrollment is resolved through pack_quizzes, then enrollments', () => {
  const packUrl = packProductsQueryUrl(PROJECT_URL, QUIZ_ID);
  assert.ok(packUrl.startsWith(`${PROJECT_URL}/rest/v1/pack_quizzes?`));
  assert.equal(paramsOf(packUrl).get('select'), 'product_id');
  assert.equal(paramsOf(packUrl).get('quiz_id'), `eq.${QUIZ_ID}`);

  const second = 'cccccccc-dddd-4eee-8fff-000000000000';
  const enrollUrl = enrollmentQueryUrl(PROJECT_URL, USER_ID, [PRODUCT_ID, second]);
  const params = paramsOf(enrollUrl);
  assert.ok(enrollUrl.startsWith(`${PROJECT_URL}/rest/v1/enrollments?`));
  assert.equal(params.get('select'), 'id');
  assert.equal(params.get('user_id'), `eq.${USER_ID}`);
  assert.equal(params.get('product_id'), `in.(${PRODUCT_ID},${second})`);
  assert.equal(params.get('limit'), '1');
});

test('an empty product list is refused rather than rendered as in.()', () => {
  assert.throws(() => enrollmentQueryUrl(PROJECT_URL, USER_ID, []), TypeError);
  assert.throws(() => enrollmentQueryUrl(PROJECT_URL, USER_ID, undefined), TypeError);
});

test('every id a URL builder accepts must be a uuid', () => {
  for (const bad of ['', 'not-a-uuid', '1 or 1=1', null, undefined, 42]) {
    assert.throws(() => quizQueryUrl(PROJECT_URL, bad), TypeError);
    assert.throws(() => safeQuestionsQueryUrl(PROJECT_URL, bad), TypeError);
    assert.throws(() => enrollmentQueryUrl(PROJECT_URL, bad, [PRODUCT_ID]), TypeError);
    assert.throws(() => enrollmentQueryUrl(PROJECT_URL, USER_ID, [bad]), TypeError);
  }
  assert.throws(() => quizQueryUrl('', QUIZ_ID), TypeError);
  assert.ok(isUuid(QUIZ_ID) && !isUuid('nope'));
});

// ---------------------------------------------------------------------------
// Response interpretation
// ---------------------------------------------------------------------------

test('only an explicitly published row counts as a quiz', () => {
  const row = { id: QUIZ_ID, title: 'Structures', subject: null, timer_minutes: 30 };
  assert.equal(publishedQuizFrom([{ ...row, published: true }])?.id, QUIZ_ID);
  assert.equal(publishedQuizFrom({ ...row, published: true })?.id, QUIZ_ID);

  for (const published of [false, null, undefined, 'true', 1]) {
    assert.equal(publishedQuizFrom([{ ...row, published }]), null);
  }
  for (const body of [[], null, undefined, {}, 'nope', [{ published: true }]]) {
    assert.equal(publishedQuizFrom(body), null);
  }
});

test('product ids are deduped and non-uuids dropped', () => {
  assert.deepEqual(
    productIdsFrom([
      { product_id: PRODUCT_ID },
      { product_id: PRODUCT_ID },
      { product_id: 'not-a-uuid' },
      { product_id: null },
      {},
      null,
    ]),
    [PRODUCT_ID],
  );
  assert.deepEqual(productIdsFrom([]), []);
  assert.deepEqual(productIdsFrom(null), []);
});

test('the enrollment gate opens only for a real row', () => {
  assert.equal(hasEnrollmentRow([{ id: USER_ID }]), true);
  for (const body of [[], null, undefined, [{}], [{ id: 'nope' }], { error: 'boom' }, 'yes']) {
    assert.equal(hasEnrollmentRow(body), false, `${JSON.stringify(body)} must not grant access`);
  }
});

// ---------------------------------------------------------------------------
// Payload shaping
// ---------------------------------------------------------------------------

test('a question object carries exactly the four safe keys', () => {
  const shaped = toSafeQuestion({
    id: QUIZ_ID,
    quiz_id: QUIZ_ID,
    question_number: '3',
    question_text: 'Which load governs?',
    options: [{ key: 'A', label: 'Dead' }],
    correct_key: 'A',
    explanation: 'Because dead load governs here.',
    created_at: '2025-01-01T00:00:00Z',
  });

  assert.deepEqual(Object.keys(shaped).sort(), [
    'id',
    'options',
    'question_number',
    'question_text',
  ]);
  assert.equal(shaped.question_number, 3);
  assert.deepEqual(findAnswerFieldNames(shaped), []);
});

test('malformed rows shape into defensible defaults', () => {
  const shaped = toSafeQuestion({ id: 7, question_number: 'x', options: 'A,B' });
  assert.equal(shaped.id, null);
  assert.equal(shaped.question_number, null);
  assert.equal(shaped.question_text, '');
  assert.deepEqual(shaped.options, []);
});

test('questions come back ordered by question_number regardless of input order', () => {
  const rows = [3, 1, 10, 2].map((n) => ({
    id: QUIZ_ID,
    question_number: n,
    question_text: `q${n}`,
    options: [],
  }));
  assert.deepEqual(
    orderQuestions(rows).map((q) => q.question_number),
    [1, 2, 3, 10],
  );
  assert.deepEqual(orderQuestions([]), []);
  assert.deepEqual(orderQuestions(null), []);
});

test('the payload returns title, subject, timer_minutes, and drops published', () => {
  const payload = buildQuizPayload(
    {
      id: QUIZ_ID,
      title: 'Structural Design',
      subject: 'Structures',
      timer_minutes: 45,
      published: true,
      created_at: '2025-01-01T00:00:00Z',
    },
    [{ id: PRODUCT_ID, question_number: 1, question_text: 'q1', options: [] }],
  );

  assert.deepEqual(Object.keys(payload).sort(), ['questions', 'quiz']);
  assert.deepEqual(Object.keys(payload.quiz).sort(), [
    'id',
    'subject',
    'timer_minutes',
    'title',
  ]);
  assert.equal(payload.quiz.timer_minutes, 45);
  assert.equal(payload.questions.length, 1);
});

test('a missing or non-positive timer becomes 0, meaning no countdown', () => {
  for (const timer of [0, -5, null, undefined, 'soon', NaN]) {
    const payload = buildQuizPayload({ id: QUIZ_ID, title: 't', timer_minutes: timer }, []);
    assert.equal(payload.quiz.timer_minutes, 0);
  }
});

test('shaping any generated quiz drops the answer fields it was stored with', () => {
  fc.assert(
    fc.property(arbQuiz, (quiz) => {
      // Rows as the database holds them — answer fields included. The real
      // function never receives these columns; passing them in asserts that the
      // shaper would drop them even if a widened select one day did.
      const rows = quiz.questions.map((question, index) => ({
        id: `${'0'.repeat(8)}-0000-4000-8000-${String(index).padStart(12, '0')}`,
        quiz_id: QUIZ_ID,
        ...question,
      }));

      const payload = buildQuizPayload(
        { id: QUIZ_ID, title: quiz.title, subject: quiz.subject, timer_minutes: quiz.timer_minutes, published: true },
        rows,
      );

      assert.deepEqual(findAnswerFieldNames(payload), []);
      assert.equal(payload.questions.length, quiz.questions.length);
      for (const question of payload.questions) {
        assert.deepEqual(Object.keys(question).sort(), [
          'id',
          'options',
          'question_number',
          'question_text',
        ]);
      }
      const numbers = payload.questions.map((q) => q.question_number);
      assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
    }),
    { numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// The fail-closed assertion (Requirement 6 criterion 11)
// ---------------------------------------------------------------------------

test('a clean payload passes through unchanged', () => {
  const payload = buildQuizPayload({ id: QUIZ_ID, title: 't', timer_minutes: 10 }, [
    { id: PRODUCT_ID, question_number: 1, question_text: 'q', options: [{ key: 'A', label: 'x' }] },
  ]);
  assert.equal(assertAnswerFree(payload), payload);
});

test('a payload carrying correct_key is refused, not returned', () => {
  const leaky = {
    quiz: { id: QUIZ_ID, title: 't', subject: null, timer_minutes: 0 },
    questions: [
      {
        id: PRODUCT_ID,
        question_number: 1,
        question_text: 'q',
        options: [],
        correct_key: 'B',
      },
    ],
  };

  assert.deepEqual(findAnswerFieldNames(leaky), ['correct_key']);
  assert.throws(() => assertAnswerFree(leaky), AnswerLeakDetected);
  try {
    assertAnswerFree(leaky);
  } catch (error) {
    assert.deepEqual(error.fields, ['correct_key']);
  }
});

test('explanation is caught at any depth, and both fields are reported', () => {
  assert.deepEqual(
    findAnswerFieldNames({ questions: [{ meta: { nested: { explanation: 'because' } } }] }),
    ['explanation'],
  );
  assert.deepEqual(
    findAnswerFieldNames({ a: { correct_key: 'A' }, b: [{ explanation: null }] }),
    ['correct_key', 'explanation'],
  );
  // Case and surrounding whitespace do not help a leak through.
  assert.deepEqual(findAnswerFieldNames({ ' Correct_Key ': 'A' }), ['correct_key']);
});

test('an answer field hidden inside a pre-serialised string is still caught', () => {
  // The shape a "cache the whole row as JSON text" refactor produces: no object
  // key named correct_key anywhere, yet the response body would carry the answer.
  const leaky = {
    quiz: { id: QUIZ_ID, title: 't' },
    questions: [{ id: PRODUCT_ID, raw: '{"question_number":1,"correct_key":"C"}' }],
  };
  assert.deepEqual(findAnswerFieldNames(leaky), ['correct_key']);
  assert.throws(() => assertAnswerFree(leaky), AnswerLeakDetected);
});

test('a payload that will not serialise fails closed', () => {
  const cyclic = { quiz: { id: QUIZ_ID } };
  cyclic.self = cyclic;
  assert.deepEqual(findAnswerFieldNames(cyclic), [...ANSWER_FIELDS]);
  assert.throws(() => assertAnswerFree(cyclic), AnswerLeakDetected);
});
