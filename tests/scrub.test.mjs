/* tests/scrub.test.mjs — the outbound-body scrubber (Requirement 28.5).
 *
 * The scrubber is the mechanism behind "an error response carries no secret and
 * no stack trace", so it is tested directly rather than through a deployed
 * function. `supabase/functions/_shared/scrub.mjs` is pure ESM with no Deno
 * APIs precisely so this file can import it under `node --test`; `http.ts`
 * around it reads `Deno.env` and can only run at the edge.
 *
 * The fast-check block at the end is not one of the 37 numbered correctness
 * properties. It is an invariant check on this module: whatever body shape a
 * handler assembles, a configured secret value must not survive serialisation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  REDACTED,
  SECRET_ENV_NAMES,
  redactSecrets,
  scrubBody,
  scrubString,
  secretValuesFrom,
  serialiseScrubbed,
  stripStackFrames,
} from '../supabase/functions/_shared/scrub.mjs';

/* Fabricated values, shaped like the real ones but authorising nothing — the
 * repository holds zero real credentials (Requirement 28.3). */
const ENV = {
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key-for-tests-only',
  HITPAY_API_KEY: 'fake-hitpay-api-key-for-tests-only',
  HITPAY_WEBHOOK_SALT: 'fake-webhook-salt-for-tests-only',
  SMTP_USER: 'postmaster@mail.archprep.test',
  SMTP_PASS: 'fake-smtp-password-for-tests-only',
  // Configuration, not a credential: must survive untouched.
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SMTP_HOST: 'smtp.provider.test',
};

const SECRETS = secretValuesFrom(ENV);

test('secretValuesFrom collects every credential and no configuration value', () => {
  assert.ok(SECRETS.includes(ENV.SUPABASE_SERVICE_ROLE_KEY));
  assert.ok(SECRETS.includes(ENV.HITPAY_API_KEY));
  assert.ok(SECRETS.includes(ENV.HITPAY_WEBHOOK_SALT));
  assert.ok(SECRETS.includes(ENV.SMTP_USER));
  assert.ok(SECRETS.includes(ENV.SMTP_PASS));

  assert.ok(!SECRETS.includes(ENV.SUPABASE_URL), 'the project URL is public config');
  assert.ok(!SECRETS.includes(ENV.SMTP_HOST), 'the SMTP host is not a credential');

  // Percent-encoded spelling is covered, since a key echoed back inside an
  // upstream URL arrives encoded.
  assert.ok(SECRETS.includes(encodeURIComponent(ENV.SMTP_USER)));

  // Longest first, so a secret containing another is redacted as one unit.
  const lengths = SECRETS.map((value) => value.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));

  assert.deepEqual(secretValuesFrom({}), []);
  assert.deepEqual(secretValuesFrom({ HITPAY_API_KEY: '   ' }), []);
  assert.deepEqual(secretValuesFrom(), []);
  for (const name of SECRET_ENV_NAMES) {
    assert.deepEqual(secretValuesFrom({ [name]: 'x-secret-x' }).includes('x-secret-x'), true);
  }
});

test('redactSecrets replaces every occurrence, including repeats and escaped forms', () => {
  const text = `key=${ENV.HITPAY_API_KEY} retry with ${ENV.HITPAY_API_KEY}`;
  const out = redactSecrets(text, SECRETS);

  assert.equal(out, `key=${REDACTED} retry with ${REDACTED}`);
  assert.ok(!out.includes(ENV.HITPAY_API_KEY));

  // A secret that only forms once JSON escaping is applied is still caught.
  const withQuote = ['a"b\\c'];
  const serialised = serialiseScrubbed({ note: 'value a"b\\c here' }, withQuote);
  assert.ok(!serialised.includes('a\\"b\\\\c'));
  assert.ok(serialised.includes(REDACTED));

  assert.equal(redactSecrets('', SECRETS), '');
  assert.equal(redactSecrets('nothing to hide', SECRETS), 'nothing to hide');
});

test('stripStackFrames removes V8, Deno, and Windows frames but keeps the message', () => {
  const v8 = [
    'TypeError: Cannot read properties of undefined',
    '    at createPaymentRequest (file:///src/_shared/hitpay.ts:42:11)',
    '    at handler (file:///src/functions/create-payment/index.ts:17:9)',
  ].join('\n');

  const stripped = stripStackFrames(v8);
  assert.equal(stripped, 'TypeError: Cannot read properties of undefined');
  assert.ok(!stripped.includes('at '));
  assert.ok(!stripped.includes('hitpay.ts'));

  const deno = 'boom handler@https://deno.land/std@0.224.0/http/server.ts:61:20';
  assert.equal(stripStackFrames(deno), 'boom');

  const windows = 'failed C:\\src\\functions\\index.ts:17:9';
  assert.equal(stripStackFrames(windows), 'failed');

  assert.equal(stripStackFrames('file:///src/_shared/http.ts:3:1'), '');
  assert.equal(stripStackFrames(''), '');
  assert.equal(stripStackFrames(undefined), '');

  // A signed Storage URL has no :line:col and must survive: issue-material-url
  // returns one in a success body.
  const signed = 'https://abcdefgh.supabase.co/storage/v1/object/sign/materials/a.pdf?token=abc.def';
  assert.equal(stripStackFrames(signed), signed);
});

test('scrubBody drops stack keys and scrubs nested strings and keys', () => {
  const body = {
    ok: false,
    code: 'upstream_failed',
    message: `POST failed with key ${ENV.HITPAY_API_KEY}`,
    stack: 'at handler (file:///src/index.ts:1:1)',
    details: {
      stackTrace: ['at a (file:///x.ts:1:1)'],
      upstream: { salt: ENV.HITPAY_WEBHOOK_SALT, status: 502, retryable: true },
    },
    [`header-${ENV.SMTP_USER}`]: 'present',
  };

  const scrubbed = scrubBody(body, SECRETS);

  assert.equal(scrubbed.message, `POST failed with key ${REDACTED}`);
  assert.ok(!('stack' in scrubbed));
  assert.ok(!('stackTrace' in scrubbed.details));
  assert.equal(scrubbed.details.upstream.salt, REDACTED);
  assert.equal(scrubbed.details.upstream.status, 502);
  assert.equal(scrubbed.details.upstream.retryable, true);
  assert.ok(`header-${REDACTED}` in scrubbed, 'object keys are scrubbed too');

  // An Error reaching a body keeps only its scrubbed message.
  const error = new Error(`connect failed for ${ENV.SMTP_PASS}`);
  const wrapped = scrubBody({ cause: error }, SECRETS);
  assert.deepEqual(Object.keys(wrapped.cause), ['message']);
  assert.equal(wrapped.cause.message, `connect failed for ${REDACTED}`);

  // Hostile shapes degrade instead of throwing.
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.equal(scrubBody(cyclic, SECRETS).self, '[circular]');

  let deep = { leaf: ENV.HITPAY_API_KEY };
  for (let i = 0; i < 20; i += 1) deep = { nested: deep };
  assert.ok(!JSON.stringify(scrubBody(deep, SECRETS)).includes(ENV.HITPAY_API_KEY));
});

test('serialiseScrubbed always returns safe JSON text', () => {
  const text = serialiseScrubbed(
    {
      ok: false,
      code: 'internal_error',
      message: `boom ${ENV.SUPABASE_SERVICE_ROLE_KEY}\n    at h (file:///src/index.ts:9:5)`,
    },
    SECRETS,
  );

  const parsed = JSON.parse(text);
  assert.equal(parsed.code, 'internal_error');
  assert.equal(parsed.message, `boom ${REDACTED}`);
  assert.ok(!text.includes(ENV.SUPABASE_SERVICE_ROLE_KEY));
  assert.ok(!text.includes('index.ts'));

  // A body that cannot serialise still yields valid JSON.
  const unserialisable = { value: 10n ** 30n, fn: () => 'x', missing: undefined };
  const fallback = serialiseScrubbed(unserialisable, SECRETS);
  assert.deepEqual(JSON.parse(fallback), { value: '1000000000000000000000000000000' });
  assert.equal(serialiseScrubbed(undefined, SECRETS), 'null');
});

test('no secret value survives any body shape a handler might assemble', () => {
  const arbSecretPlacement = fc.constantFrom(...Object.values({
    serviceRole: ENV.SUPABASE_SERVICE_ROLE_KEY,
    hitpayKey: ENV.HITPAY_API_KEY,
    salt: ENV.HITPAY_WEBHOOK_SALT,
    smtpUser: ENV.SMTP_USER,
    smtpPass: ENV.SMTP_PASS,
  }));

  const arbLeakyString = fc
    .tuple(fc.string({ maxLength: 40 }), arbSecretPlacement, fc.string({ maxLength: 40 }))
    .map(([before, secret, after]) => `${before}${secret}${after}`);

  const arbBody = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: 'small' },
      arbLeakyString,
      fc.string({ maxLength: 30 }),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(tie('node'), { maxLength: 4 }),
      fc.dictionary(fc.oneof(fc.string({ maxLength: 12 }), arbLeakyString), tie('node'), {
        maxKeys: 4,
      }),
    ),
  })).node;

  fc.assert(
    fc.property(arbBody, (body) => {
      const text = serialiseScrubbed(body, SECRETS);
      JSON.parse(text); // stays valid JSON
      for (const secret of SECRETS) {
        assert.ok(!text.includes(secret), `secret survived in ${text.slice(0, 120)}`);
      }
      assert.ok(!/\bat \S+ \(/.test(text), 'no V8 frame survived');
    }),
    { numRuns: 300 },
  );
});
