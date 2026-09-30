/* tests/generators.mjs — the shared fast-check generators named in design.md
 * ("Generators worth building once"). Most of the 37 correctness properties need
 * the same shapes, so they are defined once here:
 *
 *   arbQuiz             question counts 0-30, 2-4 options, unicode text, blank
 *                       and populated explanations, correct_key always in options
 *   arbSubmission(quiz) complete, partial, empty, and out-of-options answer maps
 *   arbCatalog          products and quizzes with random published, sort_order
 *                       (ties and negatives), prices, and markup in titles
 *   arbQueryShape       column subsets, filters, orderings, limits, embed paths
 *   arbTokenVariant     absent, malformed, expired, unsigned, foreign-issuer,
 *                       missing-claim tokens
 *   arbWebhookDelivery  payload, outcome kind, amount delta, currency casing,
 *                       and a sequential or overlapping delivery schedule
 *   arbLedger           referral rows across all three statuses
 *
 * ESM note: `.mjs` because package.json omits `"type": "module"` so the retained
 * v1 CommonJS harness keeps working.
 */

import fc from 'fast-check';
import { hmacSha256Hex, mintTokenVariant, TOKEN_VARIANT_KINDS } from './helpers/tokens.mjs';

export { TOKEN_VARIANT_KINDS };

// ---------------------------------------------------------------------------
// Text primitives
// ---------------------------------------------------------------------------

const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

export const SUBJECTS = Object.freeze([
  'Structural Design',
  'Architectural Design',
  'Utilities',
  'Professional Practice',
  'History of Architecture',
  'All Subjects',
]);

/** Payloads that must render as literal text, never as markup (Property 31). */
export const MARKUP_SNIPPETS = Object.freeze([
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><b>bold</b>',
  "</textarea><svg onload=alert(1)>",
  '<a href="javascript:alert(1)">tap</a>',
  "Robert'); drop table products;--",
  '{{7*7}}',
  '&lt;not-really-escaped&gt;',
]);

/** Unicode text, including CJK, emoji, combining marks, and whitespace. */
export function arbUnicodeText({ minLength = 1, maxLength = 40 } = {}) {
  return fc.string({ unit: 'grapheme', minLength, maxLength });
}

/** Text that may or may not carry markup, so output-safety holds either way. */
export const arbMarkupText = fc.oneof(
  { weight: 2, arbitrary: arbUnicodeText({ minLength: 1, maxLength: 40 }) },
  { weight: 1, arbitrary: fc.constantFrom(...MARKUP_SNIPPETS) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(arbUnicodeText({ minLength: 0, maxLength: 12 }), fc.constantFrom(...MARKUP_SNIPPETS))
      .map(([text, markup]) => `${text}${markup}`),
  },
);

export const arbSlug = fc
  .tuple(
    fc.array(fc.constantFrom(...SLUG_CHARS), { minLength: 3, maxLength: 10 }),
    fc.option(fc.array(fc.constantFrom(...SLUG_CHARS), { minLength: 1, maxLength: 6 }), {
      nil: null,
    }),
  )
  .map(([head, tail]) => (tail ? `${head.join('')}-${tail.join('')}` : head.join('')));

export const arbSubject = fc.option(fc.constantFrom(...SUBJECTS), { nil: null });

/** Blank, absent, and populated explanations all occur in real content. */
export const arbExplanation = fc.oneof(
  { weight: 2, arbitrary: arbUnicodeText({ minLength: 1, maxLength: 120 }) },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.constant(null) },
);

/** `numeric(12,2)` money, generated in centavos so it never carries float dust. */
export function arbAmountPhp({ min = 1, max = 200000 } = {}) {
  return fc.integer({ min: Math.round(min * 100), max: Math.round(max * 100) }).map(
    (centavos) => Math.round(centavos) / 100,
  );
}

// ---------------------------------------------------------------------------
// arbQuiz
// ---------------------------------------------------------------------------

export const OPTION_KEYS = Object.freeze(['A', 'B', 'C', 'D']);

/** 2-4 options as the `[{key,label}]` jsonb the schema stores. */
export const arbOptions = fc.integer({ min: 2, max: 4 }).chain((count) =>
  fc
    .array(arbUnicodeText({ minLength: 1, maxLength: 24 }), {
      minLength: count,
      maxLength: count,
    })
    .map((labels) => labels.map((label, index) => ({ key: OPTION_KEYS[index], label }))),
);

/** One question. `correct_key` is always one of this question's option keys. */
export const arbQuestionBody = arbOptions.chain((options) =>
  fc.record({
    question_text: arbMarkupText,
    options: fc.constant(options),
    correct_key: fc.constantFrom(...options.map((option) => option.key)),
    explanation: arbExplanation,
  }),
);

/**
 * A quiz with 0-30 questions, numbered contiguously from 1 (the schema's
 * `unique (quiz_id, question_number)` and Requirement 27.4 both depend on it).
 */
export const arbQuiz = fc
  .record({
    slug: arbSlug,
    title: arbMarkupText,
    subject: arbSubject,
    // 0 means "no timer" (Requirement 21.3); anything above is a countdown.
    timer_minutes: fc.oneof(
      { weight: 1, arbitrary: fc.constant(0) },
      { weight: 2, arbitrary: fc.integer({ min: 1, max: 180 }) },
    ),
    published: fc.boolean(),
    questions: fc.array(arbQuestionBody, { minLength: 0, maxLength: 30 }),
  })
  .map((quiz) => ({
    ...quiz,
    questions: quiz.questions.map((question, index) => ({
      ...question,
      question_number: index + 1,
    })),
  }));

// ---------------------------------------------------------------------------
// arbSubmission
// ---------------------------------------------------------------------------

export const SUBMISSION_KINDS = Object.freeze(['complete', 'partial', 'empty', 'out_of_options']);

/** Keys that are never valid options: scored incorrect, still count as answered. */
export const OUT_OF_OPTIONS_KEYS = Object.freeze(['E', 'Z', 'a', '0', '-', 'A ']);

/**
 * A submission for one generated quiz, keyed by `question_number` because the
 * database ids do not exist until the fixture is inserted. Use
 * `answersByQuestionId` to remap once the rows are in.
 *
 * Returns `{ kind, answers, answeredNumbers }`.
 */
export function arbSubmission(quiz) {
  const questions = quiz?.questions ?? [];
  if (questions.length === 0) {
    return fc.constant({ kind: 'empty', answers: {}, answeredNumbers: [] });
  }

  const validKeyFor = (question) => fc.constantFrom(...question.options.map((o) => o.key));

  const complete = fc
    .tuple(...questions.map(validKeyFor))
    .map((keys) => buildSubmission('complete', questions, keys, questions.map((q) => q.question_number)));

  const partial = fc
    .subarray(
      questions.map((q) => q.question_number),
      { minLength: 0, maxLength: Math.max(0, questions.length - 1) },
    )
    .chain((answeredNumbers) =>
      fc
        .tuple(...questions.map(validKeyFor))
        .map((keys) => buildSubmission('partial', questions, keys, answeredNumbers)),
    );

  const empty = fc.constant({ kind: 'empty', answers: {}, answeredNumbers: [] });

  const outOfOptions = fc
    .tuple(
      fc.array(fc.constantFrom(...OUT_OF_OPTIONS_KEYS), {
        minLength: questions.length,
        maxLength: questions.length,
      }),
      fc.subarray(
        questions.map((q) => q.question_number),
        { minLength: 1, maxLength: questions.length },
      ),
    )
    .map(([badKeys, targeted]) =>
      buildSubmission('out_of_options', questions, badKeys, targeted),
    );

  return fc.oneof(complete, partial, empty, outOfOptions);
}

function buildSubmission(kind, questions, keys, answeredNumbers) {
  const answered = new Set(answeredNumbers);
  const answers = {};
  questions.forEach((question, index) => {
    if (answered.has(question.question_number)) answers[question.question_number] = keys[index];
  });
  return { kind, answers, answeredNumbers: [...answered].sort((a, b) => a - b) };
}

/** Remap a generated submission onto inserted rows: `{ [question.id]: key }`. */
export function answersByQuestionId(answers, insertedQuestions) {
  const byNumber = new Map(insertedQuestions.map((q) => [q.question_number, q.id]));
  const mapped = {};
  for (const [number, key] of Object.entries(answers)) {
    const id = byNumber.get(Number(number));
    if (id !== undefined) mapped[id] = key;
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// arbCatalog
// ---------------------------------------------------------------------------

export const PRODUCT_TYPES = Object.freeze(['material', 'quiz_pack']);

/**
 * `sort_order` is drawn from a deliberately narrow band so ties are common, and
 * it includes negatives, because Requirement 10.3 orders by it ascending.
 */
export const arbSortOrder = fc.integer({ min: -5, max: 10 });

export const arbProduct = fc.record({
  slug: arbSlug,
  type: fc.constantFrom(...PRODUCT_TYPES),
  subject: arbSubject,
  title: arbMarkupText,
  subtitle: fc.option(arbMarkupText, { nil: null }),
  description: fc.option(arbMarkupText, { nil: null }),
  // integer and strictly positive: `check (price_php > 0)`
  price_php: fc.integer({ min: 1, max: 100000 }),
  thumbnail_path: fc.option(arbSlug.map((slug) => `thumbnails/${slug}.jpg`), { nil: null }),
  material_path: fc.option(arbSlug.map((slug) => `materials/${slug}.pdf`), { nil: null }),
  includes: fc.array(arbMarkupText, { maxLength: 5 }),
  published: fc.boolean(),
  sort_order: arbSortOrder,
});

/** Quiz metadata only — question content lives in arbQuiz (Requirement 9.8). */
export const arbQuizMeta = fc.record({
  slug: arbSlug,
  title: arbMarkupText,
  subject: arbSubject,
  timer_minutes: fc.oneof(
    { weight: 1, arbitrary: fc.constant(0) },
    { weight: 2, arbitrary: fc.integer({ min: 1, max: 180 }) },
  ),
  published: fc.boolean(),
  sort_order: arbSortOrder,
});

/**
 * A whole catalog: products and quizzes with unique slugs, plus `packLinks`
 * mapping each `quiz_pack` product to some of the quizzes, which is what the
 * published-through-parent policy on `pack_quizzes` is tested against.
 */
export const arbCatalog = fc
  .record({
    products: fc.uniqueArray(arbProduct, {
      selector: (product) => product.slug,
      minLength: 0,
      maxLength: 8,
    }),
    quizzes: fc.uniqueArray(arbQuizMeta, {
      selector: (quiz) => quiz.slug,
      minLength: 0,
      maxLength: 6,
    }),
  })
  .chain(({ products, quizzes }) => {
    const packs = products.filter((product) => product.type === 'quiz_pack');
    if (packs.length === 0 || quizzes.length === 0) {
      return fc.constant({ products, quizzes, packLinks: [] });
    }
    return fc
      .array(
        fc.record({
          product_slug: fc.constantFrom(...packs.map((p) => p.slug)),
          quiz_slug: fc.constantFrom(...quizzes.map((q) => q.slug)),
          sort_order: arbSortOrder,
        }),
        { maxLength: packs.length * quizzes.length },
      )
      .map((links) => ({
        products,
        quizzes,
        // primary key (product_id, quiz_id): one link per pair
        packLinks: dedupeBy(links, (link) => `${link.product_slug}::${link.quiz_slug}`),
      }));
  });

function dedupeBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// arbQueryShape
// ---------------------------------------------------------------------------

export const QUESTION_COLUMNS = Object.freeze([
  'id',
  'quiz_id',
  'question_number',
  'question_text',
  'options',
  'correct_key',
  'explanation',
]);

/** The answer fields a client must never reach (Requirement 6). */
export const ANSWER_FIELDS = Object.freeze(['correct_key', 'explanation']);

/**
 * The paths a client can take to `questions`: straight at the table, through an
 * embedded resource on `quizzes`, and through a nested embed from
 * `pack_quizzes` (Requirement 6.9).
 */
export const QUERY_ROUTES = Object.freeze([
  { table: 'questions', kind: 'direct', wrap: (select) => select },
  { table: 'quizzes', kind: 'embed', wrap: (select) => `id,questions(${select})` },
  {
    table: 'pack_quizzes',
    kind: 'nested_embed',
    wrap: (select) => `quiz_id,quizzes(id,questions(${select}))`,
  },
]);

const arbColumnSubset = fc.oneof(
  // The two single-column attacks Requirement 6.5 and 6.8 name explicitly.
  { weight: 3, arbitrary: fc.constantFrom('correct_key', 'explanation') },
  { weight: 1, arbitrary: fc.constant('*') },
  { weight: 1, arbitrary: fc.constant('count') },
  {
    weight: 2,
    arbitrary: fc
      .uniqueArray(fc.constantFrom(...QUESTION_COLUMNS), { minLength: 1, maxLength: 4 })
      .map((columns) => columns.join(',')),
  },
);

const arbFilterFragment = fc.oneof(
  fc.record({ column: fc.constant('question_number'), value: fc.constant('gte.0') }),
  fc.record({ column: fc.constant('correct_key'), value: fc.constantFrom('eq.A', 'in.(A,B,C,D)', 'not.is.null') }),
  fc.record({ column: fc.constant('explanation'), value: fc.constantFrom('not.is.null', 'like.*a*') }),
  fc.record({ column: fc.constant('id'), value: fc.constant('not.is.null') }),
);

/**
 * A client query shape: which route, which columns, which filters, ordering,
 * limit, and offset. `searchParams` is ready to hand to `client.query(...)`.
 */
export const arbQueryShape = fc
  .record({
    route: fc.constantFrom(...QUERY_ROUTES),
    select: arbColumnSubset,
    filters: fc.array(arbFilterFragment, { maxLength: 2 }),
    order: fc.option(
      fc.constantFrom(
        'id.asc',
        'question_number.asc',
        'question_number.desc',
        'correct_key.asc',
        'explanation.desc',
      ),
      { nil: null },
    ),
    limit: fc.option(fc.integer({ min: 0, max: 50 }), { nil: null }),
    offset: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
  })
  .map((shape) => {
    const params = new URLSearchParams();
    params.set('select', shape.route.wrap(shape.select));
    // Filters only apply as written on the direct route; on embedded routes they
    // stay in the shape so the attempt is still recorded in the test output.
    if (shape.route.kind === 'direct') {
      for (const filter of shape.filters) params.append(filter.column, filter.value);
      if (shape.order) params.set('order', shape.order);
    }
    if (shape.limit !== null) params.set('limit', String(shape.limit));
    if (shape.offset !== null) params.set('offset', String(shape.offset));

    const searchParams = params.toString();
    return {
      ...shape,
      table: shape.route.table,
      searchParams,
      describe: `${shape.route.kind} GET /rest/v1/${shape.route.table}?${searchParams}`,
    };
  });

// ---------------------------------------------------------------------------
// arbTokenVariant
// ---------------------------------------------------------------------------

/**
 * One of the seven token shapes from tests/helpers/tokens.mjs. Shrinks towards
 * the first kind in the list, so a failure reports the simplest variant.
 */
export const arbTokenVariant = fc
  .record({
    kind: fc.constantFrom(...TOKEN_VARIANT_KINDS),
    sub: fc.uuid(),
  })
  .map(({ kind, sub }) => mintTokenVariant(kind, { sub }));

/** The six rejectable shapes only — for suites that assert HTTP 401 throughout. */
export const arbInvalidTokenVariant = fc
  .record({
    kind: fc.constantFrom(...TOKEN_VARIANT_KINDS.filter((kind) => kind !== 'valid')),
    sub: fc.uuid(),
  })
  .map(({ kind, sub }) => mintTokenVariant(kind, { sub }));

// ---------------------------------------------------------------------------
// arbWebhookDelivery
// ---------------------------------------------------------------------------

export const WEBHOOK_OUTCOMES = Object.freeze(['completed', 'refunded', 'failed', 'ignored']);

/** Event types from HitPay's event-webhook scheme (design.md → wire format). */
export const HITPAY_EVENT_TYPES = Object.freeze({
  completed: 'charge.created',
  refunded: 'charge.updated',
  failed: 'payment_request.failed',
  ignored: 'payout.created',
});

/** Currency spellings and casings HitPay has been observed to send, plus wrong ones. */
export const CURRENCY_VARIANTS = Object.freeze([
  'PHP',
  'php',
  'Php',
  ' PHP ',
  'PHP\n',
  'USD',
  'usd',
  'SGD',
  '',
  null,
]);

export const SIGNATURE_VARIANTS = Object.freeze(['valid', 'absent', 'forged', 'truncated', 'uppercase']);

/**
 * Amount deltas in pesos around the stored order amount. Zero is the only one
 * that may grant access (Requirement 15); the one-centavo deltas are the ones
 * that matter, because they are the cheapest possible attack.
 */
export const arbAmountDelta = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0) },
  { weight: 3, arbitrary: fc.constantFrom(0.01, -0.01, 1, -1) },
  { weight: 1, arbitrary: arbAmountPhp({ min: 0.5, max: 5000 }).map((n) => -n) },
  { weight: 1, arbitrary: arbAmountPhp({ min: 0.5, max: 5000 }) },
);

/** HMAC-SHA256 over the exact raw body, hex, lower case — the adapter's scheme. */
export function hitpaySignature(rawBody, salt) {
  return hmacSha256Hex(salt, rawBody);
}

function applySignatureVariant(variant, rawBody, salt) {
  const real = hitpaySignature(rawBody, salt);
  switch (variant) {
    case 'valid':
      return real;
    case 'absent':
      return null;
    case 'forged':
      return hitpaySignature(rawBody, `${salt}-not-the-salt`);
    case 'truncated':
      return real.slice(0, real.length - 2);
    case 'uppercase':
      return real.toUpperCase();
    default:
      throw new Error(`Unknown signature variant: ${variant}`);
  }
}

/**
 * One webhook delivery. Fields are generated; the concrete payload is built
 * against a real order by calling `build(...)`:
 *
 *   const delivery = fc.sample(arbWebhookDelivery, 1)[0];
 *   const { raw, headers, reportedAmount } =
 *     delivery.build({ paymentId: order.hitpay_payment_id,
 *                      storedAmount: order.amount_php, salt });
 *
 * `repeat` and `schedule` drive replay: `sequential` awaits each delivery,
 * `overlapping` fires them concurrently to exercise the `for update` row lock
 * (Requirement 16 / Property 15).
 */
export const arbWebhookDelivery = fc
  .record({
    outcome: fc.constantFrom(...WEBHOOK_OUTCOMES),
    amountDelta: arbAmountDelta,
    currency: fc.constantFrom(...CURRENCY_VARIANTS),
    signature: fc.constantFrom(...SIGNATURE_VARIANTS),
    paymentIdKnown: fc.boolean(),
    repeat: fc.integer({ min: 1, max: 3 }),
    schedule: fc.constantFrom('sequential', 'overlapping'),
    unknownPaymentId: fc.uuid().map((id) => `unmatched-${id.slice(0, 12)}`),
    referenceSuffix: fc.uuid().map((id) => id.slice(0, 8)),
  })
  .map((delivery) => ({
    ...delivery,
    eventType: HITPAY_EVENT_TYPES[delivery.outcome],
    /** Build the raw body and headers for a specific order. */
    build({ paymentId, storedAmount = 0, salt = 'local-test-salt', reference } = {}) {
      const effectivePaymentId = delivery.paymentIdKnown
        ? paymentId
        : delivery.unknownPaymentId;
      const reportedAmount = Math.round((Number(storedAmount) + delivery.amountDelta) * 100) / 100;
      const body = {
        payment_id: effectivePaymentId,
        payment_request_id: effectivePaymentId,
        reference_number: reference ?? `order-${delivery.referenceSuffix}`,
        amount: reportedAmount.toFixed(2),
        currency: delivery.currency,
        status:
          delivery.outcome === 'completed'
            ? 'completed'
            : delivery.outcome === 'refunded'
              ? 'refunded'
              : delivery.outcome === 'failed'
                ? 'failed'
                : 'pending',
        event_type: HITPAY_EVENT_TYPES[delivery.outcome],
      };
      const raw = JSON.stringify(body);
      const signature = applySignatureVariant(delivery.signature, raw, salt);
      const headers = {
        'Content-Type': 'application/json',
        'Hitpay-Event-Type': HITPAY_EVENT_TYPES[delivery.outcome],
        'Hitpay-Event-Object': delivery.outcome === 'failed' ? 'payment_request' : 'charge',
      };
      if (signature !== null) headers['Hitpay-Signature'] = signature;
      return {
        body,
        raw,
        headers,
        signature,
        reportedAmount,
        paymentId: effectivePaymentId,
        signatureIsValid: delivery.signature === 'valid',
      };
    },
  }));

// ---------------------------------------------------------------------------
// arbLedger
// ---------------------------------------------------------------------------

export const REFERRAL_STATUSES = Object.freeze(['available', 'paid', 'void']);
export const REWARD_TYPES = Object.freeze(['cash', 'credit']);

/** One `referrals` row, minus the ids a fixture supplies. */
export const arbReferralRow = fc.record({
  status: fc.constantFrom(...REFERRAL_STATUSES),
  // `check (amount_php >= 0)`: zero is legal on a voided or zero-reward row.
  amount_php: arbAmountPhp({ min: 0, max: 5000 }),
  reward_type: fc.constantFrom(...REWARD_TYPES),
  product_title: arbMarkupText,
  buyer_masked: fc
    .tuple(fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 6 }), fc.constantFrom('gmail.com', 'yahoo.com', 'outlook.com'))
    .map(([head, domain]) => `${head}\u2022\u2022\u2022\u2022@${domain}`),
  notes: fc.option(arbUnicodeText({ minLength: 1, maxLength: 60 }), { nil: null }),
});

/** A referrer's whole ledger: rows across all three statuses, any amounts. */
export const arbLedger = fc.array(arbReferralRow, { minLength: 0, maxLength: 12 });

/**
 * A ledger guaranteed to contain at least one row of every status, for the
 * balance properties where an all-`void` sample would be a weak test.
 */
export const arbMixedLedger = fc
  .tuple(
    ...REFERRAL_STATUSES.map((status) =>
      arbReferralRow.map((row) => ({ ...row, status })),
    ),
    arbLedger,
  )
  .map(([...parts]) => {
    const rest = parts.pop();
    return [...parts, ...rest];
  });
