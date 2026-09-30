/* tests/cors.test.mjs — unit tests for the cross-origin policy.
 *
 * supabase/functions/_shared/http.ts applies these headers and answers the
 * preflight, but it is TypeScript under Deno, which is not installed here. The
 * policy is therefore pure ESM in cors.mjs and is tested directly: which origins
 * match, which headers a preflight offers, and the two things a browser will not
 * forgive — a missing `authorization` in allow-headers, and a wildcard origin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_METHODS,
  ALLOWED_REQUEST_HEADERS,
  CORS_ORIGIN_ENV_NAME,
  DEFAULT_ALLOWED_ORIGINS,
  corsHeaders,
  isOriginAllowed,
  normaliseOrigin,
  parseAllowedOrigins,
  PREFLIGHT_MAX_AGE_SECONDS,
} from '../supabase/functions/_shared/cors.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('the environment variable name is the documented one', () => {
  assert.equal(CORS_ORIGIN_ENV_NAME, 'CORS_ALLOWED_ORIGINS');
});

test('an unset allowlist falls back to local development origins, never to *', () => {
  for (const raw of [undefined, null, '', '   ', 42]) {
    const allowed = parseAllowedOrigins(raw);
    assert.deepEqual(allowed, [...DEFAULT_ALLOWED_ORIGINS]);
    assert.ok(!allowed.includes('*'), 'the default must not be a wildcard');
  }
});

test('the allowlist parses comma and whitespace separated origins', () => {
  assert.deepEqual(
    parseAllowedOrigins('https://archprep.ph, https://www.archprep.ph\nhttps://preview.archprep.ph/'),
    ['https://archprep.ph', 'https://www.archprep.ph', 'https://preview.archprep.ph'],
  );
});

test('unparseable entries are dropped, and an entirely unparseable list falls back', () => {
  assert.deepEqual(parseAllowedOrigins('https://ok.example, not-an-origin, ftp://nope.example'), [
    'https://ok.example',
  ]);
  assert.deepEqual(parseAllowedOrigins('not-an-origin'), [...DEFAULT_ALLOWED_ORIGINS]);
});

test('a wildcard is honoured only when it is set deliberately', () => {
  assert.deepEqual(parseAllowedOrigins('*'), ['*']);
  assert.equal(isOriginAllowed('https://anything.example', ['*']), true);
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('origins are compared on scheme and host only', () => {
  assert.equal(normaliseOrigin('https://ArchPrep.PH/'), 'https://archprep.ph');
  assert.equal(normaliseOrigin('https://archprep.ph/materials.html'), 'https://archprep.ph');
  assert.equal(normaliseOrigin('http://localhost:5500'), 'http://localhost:5500');
});

test('a non-origin, a file page, and a sandboxed iframe never match', () => {
  for (const value of ['', '   ', 'null', 'file:///C:/site/index.html', 'javascript:alert(1)', null, 7]) {
    assert.equal(normaliseOrigin(value), null, `should not normalise: ${value}`);
    assert.equal(isOriginAllowed(value, ['*']), false, `should not be allowed: ${value}`);
  }
});

test('the port wildcard matches any port on that host and nothing else', () => {
  assert.equal(isOriginAllowed('http://localhost:5500', DEFAULT_ALLOWED_ORIGINS), true);
  assert.equal(isOriginAllowed('http://127.0.0.1:8080', DEFAULT_ALLOWED_ORIGINS), true);
  assert.equal(isOriginAllowed('http://localhost', DEFAULT_ALLOWED_ORIGINS), true);

  assert.equal(isOriginAllowed('https://localhost:5500', DEFAULT_ALLOWED_ORIGINS), false);
  assert.equal(isOriginAllowed('http://localhost.attacker.example', DEFAULT_ALLOWED_ORIGINS), false);
  assert.equal(isOriginAllowed('http://evil.example', DEFAULT_ALLOWED_ORIGINS), false);
});

test('an exact entry does not match a subdomain or a different scheme', () => {
  const allowed = parseAllowedOrigins('https://archprep.ph');
  assert.equal(isOriginAllowed('https://archprep.ph', allowed), true);
  assert.equal(isOriginAllowed('https://evil.archprep.ph', allowed), false);
  assert.equal(isOriginAllowed('http://archprep.ph', allowed), false);
  assert.equal(isOriginAllowed('https://archprep.ph.evil.example', allowed), false);
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test('an allowed origin is echoed, with vary so caches stay honest', () => {
  const headers = corsHeaders('https://archprep.ph', ['https://archprep.ph']);
  assert.equal(headers['access-control-allow-origin'], 'https://archprep.ph');
  assert.equal(headers.vary, 'origin');
  assert.equal('access-control-allow-credentials' in headers, false);
});

test('a disallowed origin gets no allow-origin header at all', () => {
  const headers = corsHeaders('https://evil.example', ['https://archprep.ph']);
  assert.equal('access-control-allow-origin' in headers, false);
  assert.equal(headers.vary, 'origin');
});

test('a request with no Origin gets no cross-origin headers', () => {
  const headers = corsHeaders(null, ['https://archprep.ph']);
  assert.deepEqual(headers, { vary: 'origin' });
});

test('the preflight allows the authorization header and the methods in use', () => {
  const headers = corsHeaders('https://archprep.ph', ['https://archprep.ph'], { preflight: true });

  const allowHeaders = headers['access-control-allow-headers'].split(', ');
  assert.ok(allowHeaders.includes('authorization'), 'the bearer token rides in authorization');
  assert.ok(allowHeaders.includes('apikey'));
  assert.ok(allowHeaders.includes('content-type'));
  assert.deepEqual(allowHeaders, [...ALLOWED_REQUEST_HEADERS]);

  const allowMethods = headers['access-control-allow-methods'].split(', ');
  assert.deepEqual(allowMethods, [...ALLOWED_METHODS]);
  assert.ok(allowMethods.includes('OPTIONS'), 'the preflight method itself');
  assert.ok(allowMethods.includes('POST'), 'every gated function is called with POST');

  assert.equal(headers['access-control-max-age'], String(PREFLIGHT_MAX_AGE_SECONDS));
});

test('a non-preflight response carries no allow-methods or max-age', () => {
  const headers = corsHeaders('https://archprep.ph', ['https://archprep.ph']);
  assert.equal('access-control-allow-methods' in headers, false);
  assert.equal('access-control-allow-headers' in headers, false);
  assert.equal('access-control-max-age' in headers, false);
});
