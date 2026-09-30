/* tests/helpers/tokens.mjs — locally minted JWTs for the Platform v2 test suites.
 *
 * Why mint locally: the Edge Function gate (_shared/auth.ts) must reject absent,
 * malformed, expired, unsigned, foreign-issuer, and claim-less tokens. Obtaining
 * those from a real auth server is impossible, so the suites sign them here with
 * the local development JWT secret (design.md → Testing Strategy, layer 2).
 *
 * NO SECRETS ARE COMMITTED HERE. `LOCAL_DEV_JWT_SECRET` below is the well-known
 * signing secret that `supabase start` uses for every local stack on every
 * machine — it is published in the Supabase CLI defaults and grants nothing
 * outside 127.0.0.1. Any real project secret must arrive through the
 * environment (`SUPABASE_JWT_SECRET`), never through this file.
 *
 * ESM note: the repository's package.json deliberately omits `"type": "module"`
 * so the retained v1 CommonJS harness (tests/backend-test.js) keeps working, so
 * every v2 test module carries the .mjs extension instead.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** The JWT secret baked into every local `supabase start` stack. Local-only. */
export const LOCAL_DEV_JWT_SECRET =
  'super-secret-jwt-token-with-at-least-32-characters-long';

/** Default local API root, matching supabase/config.toml `[api] port = 54321`. */
export const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

/** Stand-in for "a token from somebody else's Supabase project" (Requirement 4.3). */
export const FOREIGN_JWT_SECRET =
  'foreign-project-jwt-secret-with-at-least-32-characters-long';
export const FOREIGN_ISSUER = 'https://foreign-project.supabase.co/auth/v1';

/** Every token shape the auth gate has to reject, plus the one it must accept. */
export const TOKEN_VARIANT_KINDS = Object.freeze([
  'valid',
  'absent',
  'malformed',
  'expired',
  'unsigned',
  'foreign_issuer',
  'missing_claim',
]);

/** The subset of TOKEN_VARIANT_KINDS that must produce HTTP 401. */
export const INVALID_TOKEN_VARIANT_KINDS = Object.freeze(
  TOKEN_VARIANT_KINDS.filter((kind) => kind !== 'valid'),
);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Signing secret: environment first, documented local default second. */
export function jwtSecret() {
  return (
    process.env.SUPABASE_JWT_SECRET ||
    process.env.SUPABASE_AUTH_JWT_SECRET ||
    LOCAL_DEV_JWT_SECRET
  );
}

/** `iss` claim the local stack uses: `<api url>/auth/v1`. */
export function jwtIssuer() {
  if (process.env.SUPABASE_JWT_ISSUER) return process.env.SUPABASE_JWT_ISSUER;
  const base = (process.env.SUPABASE_URL || LOCAL_SUPABASE_URL).replace(/\/+$/, '');
  return `${base}/auth/v1`;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

/** Generic HMAC-SHA256 hex digest. Used for JWTs here and for HitPay webhook
 *  signatures in tests/generators.mjs (design.md → verifyHitpaySignature). */
export function hmacSha256Hex(secret, message) {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

function hmacSha256Base64Url(secret, message) {
  return base64UrlEncode(createHmac('sha256', secret).update(message, 'utf8').digest());
}

/** Constant-time hex compare, mirroring the Edge Function's compare semantics. */
export function hexEquals(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Sign an arbitrary payload. `alg: 'none'` produces an unsigned token. */
export function signJwt(payload, { secret = jwtSecret(), alg = 'HS256', header = {} } = {}) {
  const head = base64UrlEncode(JSON.stringify({ alg, typ: 'JWT', ...header }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${head}.${body}`;
  const signature = alg === 'none' ? '' : hmacSha256Base64Url(secret, signingInput);
  return `${signingInput}.${signature}`;
}

/** Decode without verifying — for assertions about what a test actually sent. */
export function decodeJwt(token) {
  const [head, body] = String(token).split('.');
  return {
    header: JSON.parse(base64UrlDecode(head).toString('utf8')),
    payload: JSON.parse(base64UrlDecode(body).toString('utf8')),
  };
}

// ---------------------------------------------------------------------------
// Token minting
// ---------------------------------------------------------------------------

const TEN_YEARS_SECONDS = 60 * 60 * 24 * 365 * 10;

/**
 * A user access token in the shape GoTrue issues.
 * `includeSub: false` produces the missing-claim variant.
 */
export function mintAccessToken({
  sub = randomUUID(),
  email = `user-${sub.slice(0, 8)}@archprep.test`,
  role = 'authenticated',
  expiresInSeconds = 3600,
  issuedAtSeconds = Math.floor(Date.now() / 1000),
  issuer = jwtIssuer(),
  secret = jwtSecret(),
  audience = 'authenticated',
  alg = 'HS256',
  includeSub = true,
  claims = {},
} = {}) {
  const payload = {
    iss: issuer,
    aud: audience,
    role,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + expiresInSeconds,
    email,
    session_id: randomUUID(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    ...claims,
  };
  if (includeSub) payload.sub = sub;
  return signJwt(payload, { secret, alg });
}

/**
 * A long-lived role key for the `apikey` header. PostgREST and GoTrue read the
 * `role` claim; the local stack's published anon/service keys are exactly this
 * shape, so minting our own avoids pasting key strings into the repository.
 */
export function mintApiKey(role = 'anon', { expiresInSeconds = TEN_YEARS_SECONDS } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { iss: jwtIssuer(), role, iat: now, exp: now + expiresInSeconds },
    { secret: jwtSecret() },
  );
}

/**
 * One member of arbTokenVariant's space.
 * Returns `{ kind, token, authorizationHeader, expectValid, description }`;
 * `token` is `null` for the absent variant so callers can omit the header.
 */
export function mintTokenVariant(kind, options = {}) {
  const { sub = randomUUID(), email, secret, issuer } = options;
  const base = { sub, email, secret, issuer };
  let token = null;
  let description = '';

  switch (kind) {
    case 'valid':
      token = mintAccessToken(base);
      description = 'correctly signed, unexpired, carries sub';
      break;
    case 'absent':
      token = null;
      description = 'no Authorization header at all';
      break;
    case 'malformed':
      token = `${base64UrlEncode('{"alg":"HS256"}')}.not-base64-payload.!!!`;
      description = 'not a decodable three-part JWT';
      break;
    case 'expired':
      token = mintAccessToken({
        ...base,
        issuedAtSeconds: Math.floor(Date.now() / 1000) - 7200,
        expiresInSeconds: 3600,
      });
      description = 'correctly signed but expired an hour ago (zero tolerance)';
      break;
    case 'unsigned':
      token = mintAccessToken({ ...base, alg: 'none' });
      description = 'alg=none with an empty signature';
      break;
    case 'foreign_issuer':
      token = mintAccessToken({
        ...base,
        issuer: FOREIGN_ISSUER,
        secret: FOREIGN_JWT_SECRET,
      });
      description = 'valid token from a different Supabase project';
      break;
    case 'missing_claim':
      token = mintAccessToken({ ...base, includeSub: false });
      description = 'correctly signed but carries no sub claim';
      break;
    default:
      throw new Error(`Unknown token variant kind: ${kind}`);
  }

  return {
    kind,
    token,
    authorizationHeader: token === null ? null : `Bearer ${token}`,
    expectValid: kind === 'valid',
    description,
  };
}

/** Convenience: every variant at once, for table-driven negative tests. */
export function mintAllTokenVariants(options = {}) {
  return TOKEN_VARIANT_KINDS.map((kind) => mintTokenVariant(kind, options));
}
