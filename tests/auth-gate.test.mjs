/* tests/auth-gate.test.mjs — unit tests for the user and admin gates.
 *
 * The gates themselves (supabase/functions/_shared/auth.ts and admin.ts) are
 * TypeScript running under Deno, which is not installed here. Their decision
 * logic therefore lives in two pure ESM modules that Deno and Node both load —
 * jwt.mjs for token verification, postgrest.mjs for the `profiles.is_admin`
 * read — and those are what this file exercises, against the same seven token
 * variants tests/helpers/tokens.mjs mints for the property test in task 11.9.
 *
 * Requirements 4.1, 4.2, 4.3, 26.4, 26.5, 26.7.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  FOREIGN_ISSUER,
  INVALID_TOKEN_VARIANT_KINDS,
  jwtIssuer,
  jwtSecret,
  mintAccessToken,
  mintTokenVariant,
  TOKEN_VARIANT_KINDS,
} from './helpers/tokens.mjs';

import {
  bearerTokenFrom,
  checkAlgorithm,
  decodeToken,
  expectedIssuers,
  TokenRejected,
  verifyAccessToken,
} from '../supabase/functions/_shared/jwt.mjs';

import {
  adminFlagQueryUrl,
  hasAdminTrue,
} from '../supabase/functions/_shared/postgrest.mjs';

const ISSUERS = expectedIssuers({ issuer: jwtIssuer() });
const SECRET = jwtSecret();

/** The configuration `requireUser` builds from the environment. */
function verifyOptions(extra = {}) {
  return { secret: SECRET, issuers: ISSUERS, ...extra };
}

async function rejection(token, options = {}) {
  try {
    await verifyAccessToken(token, verifyOptions(options));
  } catch (error) {
    assert.ok(error instanceof TokenRejected, `expected TokenRejected, got ${error}`);
    return error.reason;
  }
  assert.fail('expected the token to be rejected');
}

// ---------------------------------------------------------------------------
// Bearer credential: the header is the only channel (Requirement 4.2)
// ---------------------------------------------------------------------------

test('bearerTokenFrom reads only a well-formed bearer header', () => {
  assert.equal(bearerTokenFrom('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerTokenFrom('bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerTokenFrom('  Bearer   abc.def.ghi  '), 'abc.def.ghi');

  for (const value of [null, undefined, '', 'abc.def.ghi', 'Basic dXNlcjpwdw==', 'Bearer', 'Bearer ']) {
    assert.equal(bearerTokenFrom(value), null, `should not yield a token: ${value}`);
  }
});

// ---------------------------------------------------------------------------
// Issuer set (Requirement 4.1)
// ---------------------------------------------------------------------------

test('expectedIssuers accepts the project URL and its auth path, and nothing else', () => {
  const issuers = expectedIssuers({ supabaseUrl: 'https://abc.supabase.co/' });
  assert.ok(issuers.includes('https://abc.supabase.co'));
  assert.ok(issuers.includes('https://abc.supabase.co/auth/v1'));
  assert.ok(!issuers.includes(FOREIGN_ISSUER.toLowerCase()));
});

test('expectedIssuers is empty when nothing is configured', () => {
  assert.deepEqual(expectedIssuers(), []);
});

// ---------------------------------------------------------------------------
// The seven variants (Requirement 4.3)
// ---------------------------------------------------------------------------

test('a valid token yields its sub and nothing else is trusted', async () => {
  const sub = randomUUID();
  const { token } = mintTokenVariant('valid', { sub });

  const verified = await verifyAccessToken(token, verifyOptions());
  assert.equal(verified.uid, sub);
  assert.equal(verified.alg, 'HS256');
  assert.ok(verified.expiresAt > Math.floor(Date.now() / 1000));
  assert.equal(Object.isFrozen(verified.claims), true);
});

test('every invalid variant is rejected with its reason', async () => {
  const expectedReasons = {
    absent: 'absent',
    malformed: 'malformed',
    expired: 'expired',
    unsigned: 'unsigned',
    foreign_issuer: 'foreign_issuer',
    missing_claim: 'missing_sub',
  };

  for (const kind of INVALID_TOKEN_VARIANT_KINDS) {
    const { token } = mintTokenVariant(kind);
    assert.equal(await rejection(token), expectedReasons[kind], `variant: ${kind}`);
  }
});

test('the variant list is exactly the set the gate is designed against', () => {
  assert.deepEqual([...TOKEN_VARIANT_KINDS].sort(), [
    'absent',
    'expired',
    'foreign_issuer',
    'malformed',
    'missing_claim',
    'unsigned',
    'valid',
  ]);
});

test('a token signed with another secret fails the signature check', async () => {
  const token = mintAccessToken({ secret: 'another-project-secret-at-least-32-characters' });
  assert.equal(await rejection(token), 'bad_signature');
});

test('a tampered payload fails the signature check', async () => {
  const { token } = mintTokenVariant('valid');
  const [header, , signature] = token.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({ iss: jwtIssuer(), sub: randomUUID(), exp: Math.floor(Date.now() / 1000) + 3600 }),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  assert.equal(await rejection(`${header}.${forgedPayload}.${signature}`), 'bad_signature');
});

// ---------------------------------------------------------------------------
// Expiry, with zero tolerance (Requirement 4.1)
// ---------------------------------------------------------------------------

test('expiry has no grace period in either direction', async () => {
  const now = 1_700_000_000;
  const token = mintAccessToken({ issuedAtSeconds: now - 3600, expiresInSeconds: 3600 });

  // exp === now is spent: zero seconds of additional tolerance.
  assert.equal(await rejection(token, { nowSeconds: now }), 'expired');
  assert.equal(await rejection(token, { nowSeconds: now + 1 }), 'expired');

  const verified = await verifyAccessToken(token, verifyOptions({ nowSeconds: now - 1 }));
  assert.equal(typeof verified.uid, 'string');
});

test('a token with no exp claim is rejected', async () => {
  const token = mintAccessToken({ claims: { exp: undefined } });
  assert.equal(await rejection(token), 'expired');
});

// ---------------------------------------------------------------------------
// Signature verification cannot be skipped
// ---------------------------------------------------------------------------

test('alg: none is refused before any claim is considered', () => {
  const { token } = mintTokenVariant('unsigned');
  const { header, signature } = decodeToken(token);
  assert.throws(() => checkAlgorithm(header, signature), (error) => error.reason === 'unsigned');
});

test('an unverifiable token is never accepted', async () => {
  const { token } = mintTokenVariant('valid');
  // No secret and no delegate: the signature cannot be checked at all.
  assert.equal(await rejection(token, { secret: undefined }), 'unverifiable');
});

test('a delegated verifier returning false rejects the token', async () => {
  const { token } = mintTokenVariant('valid');
  const reason = await rejection(token, { secret: undefined, verifySignature: () => false });
  assert.equal(reason, 'bad_signature');
});

test('a delegated verifier returning true accepts only the token sub', async () => {
  const sub = randomUUID();
  const { token } = mintTokenVariant('valid', { sub });

  const verified = await verifyAccessToken(
    token,
    verifyOptions({ secret: undefined, verifySignature: () => true }),
  );
  assert.equal(verified.uid, sub);
});

test('an unknown issuer is refused even with a passing signature', async () => {
  const { token } = mintTokenVariant('valid');
  const reason = await rejection(token, { issuers: ['https://other-project.supabase.co/auth/v1'] });
  assert.equal(reason, 'foreign_issuer');
});

test('no configured issuer means no token can be verified', async () => {
  const { token } = mintTokenVariant('valid');
  assert.equal(await rejection(token, { issuers: [] }), 'unverifiable');
});

// ---------------------------------------------------------------------------
// Admin flag read (Requirements 26.4, 26.5, 26.7)
// ---------------------------------------------------------------------------

test('the admin flag query reads one column for one verified uid', () => {
  const uid = randomUUID();
  const url = adminFlagQueryUrl('https://abc.supabase.co/', uid);

  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://abc.supabase.co/rest/v1/profiles');
  assert.equal(parsed.searchParams.get('select'), 'is_admin');
  assert.equal(parsed.searchParams.get('id'), `eq.${uid}`);
  assert.equal(parsed.searchParams.get('limit'), '1');
});

test('the admin flag query refuses anything that is not a verified uuid', () => {
  for (const uid of ['', 'not-a-uuid', '*', "' or true--", null, undefined]) {
    assert.throws(() => adminFlagQueryUrl('https://abc.supabase.co', uid), TypeError);
  }
});

test('only a boolean true grants admin', () => {
  assert.equal(hasAdminTrue([{ is_admin: true }]), true);
  assert.equal(hasAdminTrue({ is_admin: true }), true);

  for (const body of [
    [],
    null,
    undefined,
    'true',
    [{ is_admin: false }],
    [{ is_admin: null }],
    [{ is_admin: 'true' }],
    [{ is_admin: 1 }],
    [{}],
    [{ id: 'x' }],
  ]) {
    assert.equal(hasAdminTrue(body), false, `should not grant admin: ${JSON.stringify(body)}`);
  }
});

test('an is_admin claim in the token is carried but never decides', async () => {
  const sub = randomUUID();
  const token = mintAccessToken({ sub, claims: { is_admin: true, role: 'service_role' } });
  const verified = await verifyAccessToken(token, verifyOptions());

  // A caller can put anything in a claim, and a correctly signed token proves
  // only who signed it. The gate's decision input is the profiles row, which is
  // the only value hasAdminTrue() ever sees.
  assert.equal(verified.claims.is_admin, true, 'the claim rides along');
  assert.equal(verified.uid, sub, 'identity still comes from sub');
  assert.equal(hasAdminTrue([{ is_admin: false }]), false, 'the row is what decides');
});
