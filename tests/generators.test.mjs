/* tests/generators.test.mjs — smoke coverage for the shared test harness.
 *
 * This is deliberately not one of the 37 numbered correctness properties. It
 * checks that the generators in tests/generators.mjs actually produce values of
 * the declared shape, and that the client factories in tests/helpers/ are wired
 * up, so a broken harness surfaces here rather than as a confusing failure
 * inside a property test later.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  anonClient,
  authClient,
  localSupabaseStatus,
  serviceClient,
  skipUnlessLocalSupabase,
  supabaseConfig,
  testEmail,
} from './helpers/clients.mjs';
import {
  decodeJwt,
  hexEquals,
  mintAllTokenVariants,
  mintTokenVariant,
  TOKEN_VARIANT_KINDS,
} from './helpers/tokens.mjs';
import {
  answersByQuestionId,
  arbCatalog,
  arbLedger,
  arbMixedLedger,
  arbQueryShape,
  arbQuiz,
  arbSubmission,
  arbTokenVariant,
  arbWebhookDelivery,
  hitpaySignature,
  OPTION_KEYS,
  OUT_OF_OPTIONS_KEYS,
  PRODUCT_TYPES,
  QUERY_ROUTES,
  REFERRAL_STATUSES,
  WEBHOOK_OUTCOMES,
} from './generators.mjs';

const SAMPLES = 40;

test('arbQuiz produces contiguously numbered questions with in-options answer keys', () => {
  const quizzes = fc.sample(arbQuiz, SAMPLES);
  assert.equal(quizzes.length, SAMPLES);
  assert.ok(quizzes.some((quiz) => quiz.questions.length > 0), 'expected some populated quizzes');

  for (const quiz of quizzes) {
    assert.ok(quiz.questions.length <= 30, 'question count stays within 0-30');
    assert.ok(quiz.timer_minutes >= 0);
    assert.equal(typeof quiz.title, 'string');
    quiz.questions.forEach((question, index) => {
      assert.equal(question.question_number, index + 1, 'numbering is contiguous from 1');
      assert.ok(question.options.length >= 2 && question.options.length <= 4);
      const keys = question.options.map((option) => option.key);
      assert.deepEqual(keys, OPTION_KEYS.slice(0, keys.length));
      assert.ok(keys.includes(question.correct_key), 'correct_key is one of this question options');
    });
  }
  const explanations = quizzes.flatMap((quiz) => quiz.questions.map((q) => q.explanation));
  assert.ok(explanations.some((e) => e === '' || e === null), 'blank explanations occur');
});

test('arbSubmission covers complete, partial, empty, and out-of-options answers', () => {
  const quiz = fc.sample(arbQuiz, 200).find((candidate) => candidate.questions.length >= 3);
  assert.ok(quiz, 'expected a sampled quiz with at least three questions');

  const submissions = fc.sample(arbSubmission(quiz), 150);
  const numbers = new Set(quiz.questions.map((question) => question.question_number));

  for (const submission of submissions) {
    for (const key of Object.keys(submission.answers)) {
      assert.ok(numbers.has(Number(key)), 'answers are keyed by a real question number');
    }
  }

  const kinds = new Set(submissions.map((submission) => submission.kind));
  for (const kind of ['complete', 'partial', 'empty', 'out_of_options']) {
    assert.ok(kinds.has(kind), `expected the ${kind} submission kind in a sample of 150`);
  }

  const complete = submissions.find((submission) => submission.kind === 'complete');
  assert.equal(Object.keys(complete.answers).length, quiz.questions.length);

  const empty = submissions.find((submission) => submission.kind === 'empty');
  assert.deepEqual(empty.answers, {});

  const outOfOptions = submissions.find((submission) => submission.kind === 'out_of_options');
  assert.ok(Object.keys(outOfOptions.answers).length > 0);
  for (const value of Object.values(outOfOptions.answers)) {
    assert.ok(OUT_OF_OPTIONS_KEYS.includes(value), 'out-of-options keys are never valid options');
  }

  const inserted = quiz.questions.map((question, index) => ({
    id: `question-${index}`,
    question_number: question.question_number,
  }));
  const remapped = answersByQuestionId(complete.answers, inserted);
  assert.deepEqual(Object.keys(remapped).sort(), inserted.map((row) => row.id).sort());
});

test('arbCatalog produces unique slugs, positive prices, sort_order ties and negatives', () => {
  const catalogs = fc.sample(arbCatalog, SAMPLES);
  let sawNegativeSort = false;
  let sawTie = false;
  let sawPackLink = false;

  for (const catalog of catalogs) {
    const productSlugs = catalog.products.map((product) => product.slug);
    assert.equal(new Set(productSlugs).size, productSlugs.length, 'product slugs are unique');
    const quizSlugs = catalog.quizzes.map((quiz) => quiz.slug);
    assert.equal(new Set(quizSlugs).size, quizSlugs.length, 'quiz slugs are unique');

    for (const product of catalog.products) {
      assert.ok(Number.isInteger(product.price_php) && product.price_php > 0);
      assert.ok(PRODUCT_TYPES.includes(product.type));
      if (product.sort_order < 0) sawNegativeSort = true;
    }

    const orders = catalog.products.map((product) => product.sort_order);
    if (new Set(orders).size < orders.length) sawTie = true;

    for (const link of catalog.packLinks) {
      sawPackLink = true;
      assert.ok(productSlugs.includes(link.product_slug));
      assert.ok(quizSlugs.includes(link.quiz_slug));
    }
    const pairs = catalog.packLinks.map((link) => `${link.product_slug}::${link.quiz_slug}`);
    assert.equal(new Set(pairs).size, pairs.length, 'pack links respect the composite key');
  }

  assert.ok(sawNegativeSort, 'sort_order includes negatives');
  assert.ok(sawTie, 'sort_order includes ties');
  assert.ok(sawPackLink, 'catalogs include pack-to-quiz links');
});

test('arbQueryShape produces every route and reaches the answer columns', () => {
  const shapes = fc.sample(arbQueryShape, 150);
  const routes = new Set(shapes.map((shape) => shape.route.kind));
  for (const route of QUERY_ROUTES) {
    assert.ok(routes.has(route.kind), `expected the ${route.kind} route in a sample of 150`);
  }

  for (const shape of shapes) {
    const params = new URLSearchParams(shape.searchParams);
    assert.ok(params.get('select'), 'every shape carries a select');
    assert.ok(shape.describe.includes(shape.table));
  }

  assert.ok(
    shapes.some((shape) => shape.searchParams.includes('correct_key')),
    'some shapes request correct_key',
  );
  assert.ok(
    shapes.some((shape) => shape.searchParams.includes('explanation')),
    'some shapes request explanation',
  );
});

test('arbTokenVariant mints every rejectable token shape', () => {
  const variants = mintAllTokenVariants();
  assert.deepEqual(
    variants.map((variant) => variant.kind),
    [...TOKEN_VARIANT_KINDS],
  );

  const byKind = Object.fromEntries(variants.map((variant) => [variant.kind, variant]));
  assert.equal(byKind.absent.token, null);
  assert.equal(byKind.absent.authorizationHeader, null);
  assert.equal(byKind.malformed.token.split('.').length, 3);

  const now = Math.floor(Date.now() / 1000);
  const valid = decodeJwt(byKind.valid.token);
  assert.ok(valid.payload.sub, 'the valid token carries a sub');
  assert.ok(valid.payload.exp > now, 'the valid token has not expired');
  assert.equal(valid.payload.role, 'authenticated');

  assert.ok(decodeJwt(byKind.expired.token).payload.exp < now, 'the expired token is in the past');
  assert.equal(decodeJwt(byKind.unsigned.token).header.alg, 'none');
  assert.equal(byKind.unsigned.token.split('.')[2], '', 'the unsigned token has no signature');
  assert.equal(decodeJwt(byKind.missing_claim.token).payload.sub, undefined);
  assert.notEqual(decodeJwt(byKind.foreign_issuer.token).payload.iss, valid.payload.iss);

  for (const variant of variants) {
    assert.equal(variant.expectValid, variant.kind === 'valid');
  }

  const sampled = fc.sample(arbTokenVariant, 60);
  for (const variant of sampled) {
    assert.ok(TOKEN_VARIANT_KINDS.includes(variant.kind));
    assert.ok(typeof variant.description === 'string' && variant.description.length > 0);
  }

  // Two mints of the same kind differ, so tests cannot accidentally share a uid.
  const a = mintTokenVariant('valid');
  const b = mintTokenVariant('valid');
  assert.notEqual(decodeJwt(a.token).payload.sub, decodeJwt(b.token).payload.sub);
});

test('arbWebhookDelivery builds signable payloads with amounts around the stored value', () => {
  const salt = 'local-test-salt';
  const deliveries = fc.sample(arbWebhookDelivery, 150);
  const outcomes = new Set(deliveries.map((delivery) => delivery.outcome));
  for (const outcome of WEBHOOK_OUTCOMES) {
    assert.ok(outcomes.has(outcome), `expected the ${outcome} outcome in a sample of 150`);
  }

  const schedules = new Set(deliveries.map((delivery) => delivery.schedule));
  assert.ok(schedules.has('sequential') && schedules.has('overlapping'));

  let sawExactAmount = false;
  let sawOneCentavoOff = false;
  let sawValidSignature = false;
  let sawInvalidSignature = false;

  for (const delivery of deliveries) {
    const built = delivery.build({ paymentId: 'pay_123', storedAmount: 499, salt });
    assert.equal(built.raw, JSON.stringify(built.body));
    assert.equal(built.body.amount, built.reportedAmount.toFixed(2));
    assert.equal(built.reportedAmount, Math.round((499 + delivery.amountDelta) * 100) / 100);
    assert.equal(built.paymentId, delivery.paymentIdKnown ? 'pay_123' : delivery.unknownPaymentId);

    if (delivery.amountDelta === 0) sawExactAmount = true;
    if (Math.abs(delivery.amountDelta) === 0.01) sawOneCentavoOff = true;

    if (delivery.signature === 'valid') {
      sawValidSignature = true;
      assert.ok(hexEquals(built.headers['Hitpay-Signature'], hitpaySignature(built.raw, salt)));
    } else {
      sawInvalidSignature = true;
      const supplied = built.headers['Hitpay-Signature'];
      assert.ok(
        supplied === undefined || !hexEquals(supplied, hitpaySignature(built.raw, salt)),
        `signature variant ${delivery.signature} must not verify`,
      );
    }
  }

  assert.ok(sawExactAmount, 'exact-amount deliveries occur');
  assert.ok(sawOneCentavoOff, 'one-centavo deltas occur');
  assert.ok(sawValidSignature && sawInvalidSignature, 'both signed and unsigned deliveries occur');
});

test('arbLedger produces rows across all three statuses with two-decimal amounts', () => {
  const ledgers = fc.sample(arbLedger, SAMPLES);
  const statuses = new Set(ledgers.flat().map((row) => row.status));
  for (const status of REFERRAL_STATUSES) {
    assert.ok(statuses.has(status), `expected the ${status} status across sampled ledgers`);
  }

  for (const row of ledgers.flat()) {
    assert.ok(row.amount_php >= 0, 'amounts respect check (amount_php >= 0)');
    assert.equal(row.amount_php, Math.round(row.amount_php * 100) / 100, 'amounts fit numeric(12,2)');
    assert.ok(row.buyer_masked.includes('@'), 'buyer identity is stored masked');
  }

  for (const ledger of fc.sample(arbMixedLedger, 10)) {
    const present = new Set(ledger.map((row) => row.status));
    assert.deepEqual([...present].sort(), [...REFERRAL_STATUSES].sort());
  }
});

test('client factories are configured against the local stack and carry the right headers', async () => {
  const config = supabaseConfig();
  assert.match(config.url, /^https?:\/\//);
  assert.ok(config.anonKey && config.serviceRoleKey);
  assert.notEqual(config.anonKey, config.serviceRoleKey);
  assert.equal(decodeJwt(config.anonKey).payload.role, 'anon');
  assert.equal(decodeJwt(config.serviceRoleKey).payload.role, 'service_role');

  const anon = anonClient();
  assert.equal(anon.role, 'anon');
  assert.equal(anon.headers().apikey, config.anonKey);
  assert.equal(anon.headers().Authorization, `Bearer ${config.anonKey}`);

  const userToken = mintTokenVariant('valid').token;
  const user = authClient(userToken);
  assert.equal(user.role, 'authenticated');
  assert.equal(user.headers().apikey, config.anonKey, 'the user client still sends the anon apikey');
  assert.equal(user.headers().Authorization, `Bearer ${userToken}`);

  assert.equal(serviceClient().headers().apikey, config.serviceRoleKey);
  assert.throws(() => authClient(null), /requires an access token/);

  assert.notEqual(testEmail(), testEmail());
  assert.match(testEmail('buyer'), /^buyer-[0-9a-f-]{36}@archprep\.test$/);
});

test('suites needing a live local stack skip with a clear message when it is absent', async () => {
  const status = await localSupabaseStatus();
  const options = await skipUnlessLocalSupabase();

  if (status.reachable) {
    assert.deepEqual(options, {}, 'no skip when the stack is up');
  } else {
    assert.equal(typeof options.skip, 'string');
    assert.match(options.skip, /local Supabase not reachable/);
    assert.match(options.skip, /supabase start/);
  }
});
