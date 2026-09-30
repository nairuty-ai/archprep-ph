/* supabase/functions/_shared/jwt.mjs — access-token verification, as pure logic.
 *
 * Requirement 4 criterion 1 asks for three things before an Edge Function reads
 * or writes anything: verify the signature, verify the token came from *this*
 * Supabase project, and verify expiry with zero seconds of additional
 * tolerance. Criterion 2 adds that the user id may come from the verified token
 * and from nowhere else.
 *
 * All of that lives here rather than in auth.ts for the same reason scrub.mjs
 * exists: this file is plain ESM over WebCrypto only — no `Deno.env`, no
 * project-specific imports — so `tests/auth-gate.test.mjs` runs it under
 * `node --test` against the seven token variants minted by
 * tests/helpers/tokens.mjs (valid, absent, malformed, expired, unsigned,
 * foreign_issuer, missing_claim), while Deno loads the same file at the edge.
 * auth.ts owns the one thing that cannot be pure: reading the environment and
 * deciding whether the signature check runs locally or against the auth server.
 *
 * Nothing in this module takes a user identity as an argument. It is handed a
 * token and configuration; it returns the claims of a token that passed every
 * check, or it throws. There is no "trust this uid" path.
 */

/** Algorithms this module can verify by itself, given the project JWT secret. */
export const LOCAL_ALGORITHMS = Object.freeze(['HS256', 'HS384', 'HS512']);

/**
 * Algorithms a Supabase project may use once it moves to asymmetric signing
 * keys. They are legitimate but need a public key, so auth.ts verifies them
 * against the project's own auth server instead (see `verifySignature` below).
 */
export const REMOTE_ALGORITHMS = Object.freeze(['RS256', 'RS384', 'RS512', 'ES256', 'ES384']);

/** Every reason a token can be turned away. All of them mean HTTP 401. */
export const REJECTION_REASONS = Object.freeze([
  'absent', // no Authorization header, or no bearer credential in it
  'malformed', // not three base64url segments carrying JSON
  'unsigned', // alg: none, or an empty signature segment
  'unsupported_alg', // an algorithm this platform never issues
  'foreign_issuer', // iss absent, or naming another project
  'expired', // exp absent, or exp <= now (zero tolerance)
  'not_yet_valid', // nbf in the future
  'missing_sub', // signed correctly but carries no user id claim
  'bad_signature', // signature does not verify
  'unverifiable', // no way to check the signature — never treated as valid
]);

const HASH_BY_ALG = Object.freeze({
  HS256: 'SHA-256',
  HS384: 'SHA-384',
  HS512: 'SHA-512',
});

/**
 * A token that must not authenticate anybody.
 *
 * `reason` is for the server log only. The response carries the generic
 * `auth_required` envelope, because Requirement 4 criterion 6 forbids echoing
 * token or claim values back to the caller — telling an attacker *which* check
 * failed is a small oracle we have no reason to hand out.
 */
export class TokenRejected extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'TokenRejected';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* Bearer credential                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The token carried by an `Authorization: Bearer <token>` header.
 *
 * Returns `null` when the header is absent, empty, or uses another scheme. The
 * caller passes the header value and nothing else, which is how Requirement 4
 * criterion 2 ("read that claim only from the request's authorization
 * credential") is kept structural: there is no code path here that could reach
 * a request body or a query string.
 *
 * @param {string | null | undefined} headerValue
 * @returns {string | null}
 */
export function bearerTokenFrom(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(headerValue);
  if (!match) return null;
  return match[1];
}

/* -------------------------------------------------------------------------- */
/* Issuer                                                                     */
/* -------------------------------------------------------------------------- */

/** Trailing-slash-insensitive, case-insensitive-scheme-and-host comparison form. */
function canonicalIssuer(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}${url.search}`.toLowerCase();
  } catch {
    // Not a URL (older local stacks issue the bare string "supabase").
    return trimmed.toLowerCase();
  }
}

/**
 * The set of `iss` values that mean "this project's auth server".
 *
 * GoTrue issues `<project url>/auth/v1`. The project URL itself is accepted
 * too, since that is the spelling some stacks use, and an explicitly configured
 * issuer always wins. A token whose `iss` is outside this set is a token from
 * somebody else's project: Requirement 4 criterion 3's `foreign_issuer` case.
 *
 * @param {{ supabaseUrl?: string | null, issuer?: string | null }} [config]
 * @returns {string[]} canonical issuer forms, never empty unless unconfigured
 */
export function expectedIssuers({ supabaseUrl, issuer } = {}) {
  const issuers = new Set();

  for (const candidate of String(issuer ?? '').split(',')) {
    const canonical = canonicalIssuer(candidate);
    if (canonical) issuers.add(canonical);
  }

  const base = canonicalIssuer(supabaseUrl);
  if (base) {
    issuers.add(base);
    issuers.add(`${base}/auth/v1`);
  }

  return [...issuers];
}

/* -------------------------------------------------------------------------- */
/* Structural decoding                                                        */
/* -------------------------------------------------------------------------- */

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Decode one base64url segment to bytes, rejecting anything that is not
 * base64url at all. A `length % 4 === 1` segment cannot be valid base64 and is
 * rejected before `atob` gets a chance to be lenient about it.
 *
 * @param {string} segment
 * @returns {Uint8Array}
 */
export function base64UrlToBytes(segment) {
  if (typeof segment !== 'string' || !BASE64URL.test(segment) || segment.length % 4 === 1) {
    throw new TokenRejected('malformed', 'segment is not base64url');
  }
  const padded =
    segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (segment.length % 4)) % 4);

  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new TokenRejected('malformed', 'segment is not decodable');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonSegment(segment, label) {
  let text;
  try {
    text = new TextDecoder().decode(base64UrlToBytes(segment));
  } catch (error) {
    if (error instanceof TokenRejected) throw error;
    throw new TokenRejected('malformed', `${label} is not decodable`);
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TokenRejected('malformed', `${label} is not JSON`);
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TokenRejected('malformed', `${label} is not a JSON object`);
  }
  return value;
}

/**
 * Split and decode a token without judging it.
 *
 * @param {string} token
 * @returns {{ header: Record<string, unknown>, payload: Record<string, unknown>,
 *             signingInput: string, signature: string }}
 */
export function decodeToken(token) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TokenRejected('absent', 'no token supplied');
  }

  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenRejected('malformed', 'expected three segments');

  const [headerSegment, payloadSegment, signature] = parts;
  if (headerSegment === '' || payloadSegment === '') {
    throw new TokenRejected('malformed', 'empty header or payload segment');
  }

  return {
    header: decodeJsonSegment(headerSegment, 'header'),
    payload: decodeJsonSegment(payloadSegment, 'payload'),
    signingInput: `${headerSegment}.${payloadSegment}`,
    signature,
  };
}

/* -------------------------------------------------------------------------- */
/* Claim checks                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Check the algorithm named in the header.
 *
 * `alg: none` with an empty signature is the classic forgery and is rejected
 * before anything else looks at the payload. Anything outside the two known
 * families is rejected as well, rather than assumed harmless.
 *
 * @param {Record<string, unknown>} header
 * @returns {{ alg: string, local: boolean }}
 */
export function checkAlgorithm(header, signature) {
  const alg = typeof header.alg === 'string' ? header.alg : '';
  if (alg === '' || alg.toLowerCase() === 'none') {
    throw new TokenRejected('unsigned', 'alg names no signature');
  }
  if (typeof signature !== 'string' || signature === '') {
    throw new TokenRejected('unsigned', 'empty signature segment');
  }
  if (LOCAL_ALGORITHMS.includes(alg)) return { alg, local: true };
  if (REMOTE_ALGORITHMS.includes(alg)) return { alg, local: false };
  throw new TokenRejected('unsupported_alg', 'algorithm is not issued by this platform');
}

/**
 * Check issuer, expiry, and the user id claim.
 *
 * Expiry is compared with `>=` against the supplied second, with no grace
 * period in either direction: Requirement 4 criterion 1 asks for zero seconds
 * of additional tolerance, so a token whose `exp` equals the current second is
 * spent. `iat` in the future is deliberately *not* an error — a one-second
 * clock difference between the auth server and the function host would
 * otherwise lock out a freshly issued token — but `nbf`, which exists only to
 * say "not before", is honoured.
 *
 * @param {Record<string, unknown>} payload
 * @param {{ issuers?: readonly string[], nowSeconds?: number }} [config]
 * @returns {{ uid: string, email: string | null, expiresAt: number }}
 */
export function checkClaims(payload, { issuers = [], nowSeconds } = {}) {
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);

  if (issuers.length === 0) {
    // Nothing to compare against means the project identity is unknown, and an
    // unknown project cannot be "this project". Fail closed.
    throw new TokenRejected('unverifiable', 'no expected issuer configured');
  }
  const iss = canonicalIssuer(payload.iss);
  if (!iss || !issuers.includes(iss)) {
    throw new TokenRejected('foreign_issuer', 'iss does not name this project');
  }

  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new TokenRejected('expired', 'exp claim absent');
  }
  if (now >= payload.exp) throw new TokenRejected('expired', 'exp is in the past');

  if (typeof payload.nbf === 'number' && Number.isFinite(payload.nbf) && now < payload.nbf) {
    throw new TokenRejected('not_yet_valid', 'nbf is in the future');
  }

  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (sub === '') throw new TokenRejected('missing_sub', 'sub claim absent');

  return {
    uid: sub,
    email: typeof payload.email === 'string' && payload.email !== '' ? payload.email : null,
    expiresAt: payload.exp,
  };
}

/* -------------------------------------------------------------------------- */
/* Signature                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Verify an HMAC signature over the signing input.
 *
 * `crypto.subtle.verify` does the constant-time compare, so no byte-by-byte
 * loop appears here. A malformed signature segment resolves to `false` rather
 * than throwing, so every failure mode ends in the same 401.
 *
 * @param {{ signingInput: string, signature: string, secret: string, alg?: string }} args
 * @returns {Promise<boolean>}
 */
export async function verifyHmacSignature({ signingInput, signature, secret, alg = 'HS256' }) {
  const hash = HASH_BY_ALG[alg];
  if (!hash || typeof secret !== 'string' || secret === '') return false;

  let signatureBytes;
  try {
    signatureBytes = base64UrlToBytes(signature);
  } catch {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: { name: hash } },
    false,
    ['verify'],
  );

  return crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(signingInput));
}

/* -------------------------------------------------------------------------- */
/* The whole check                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Verify a Supabase access token and return the claims that survived.
 *
 * Order of work: structure, algorithm, issuer, expiry, user id claim, then the
 * signature. The cheap checks run first because every one of them ends in the
 * same 401 and there is no point paying for a hash — or, on the asymmetric
 * path, a round trip — to reject a token that names another project. Nothing is
 * *trusted* before the signature verifies: this function has exactly one
 * `return`, and it is after the signature check.
 *
 * @param {string | null | undefined} token
 * @param {{
 *   secret?: string | null,
 *   issuers?: readonly string[],
 *   nowSeconds?: number,
 *   verifySignature?: (context: {
 *     token: string, signingInput: string, signature: string,
 *     header: Record<string, unknown>, payload: Record<string, unknown>, alg: string,
 *   }) => boolean | Promise<boolean>,
 * }} [config]
 * @returns {Promise<{ uid: string, email: string | null, expiresAt: number, alg: string,
 *                     claims: Readonly<Record<string, unknown>> }>}
 * @throws {TokenRejected} for every token that must produce HTTP 401
 */
export async function verifyAccessToken(token, config = {}) {
  const { secret, issuers = [], nowSeconds, verifySignature } = config;

  const { header, payload, signingInput, signature } = decodeToken(token);
  const { alg, local } = checkAlgorithm(header, signature);
  const identity = checkClaims(payload, { issuers, nowSeconds });

  let signatureOk = false;
  if (local && typeof secret === 'string' && secret !== '') {
    signatureOk = await verifyHmacSignature({ signingInput, signature, secret, alg });
  } else if (typeof verifySignature === 'function') {
    signatureOk = (await verifySignature({
      token,
      signingInput,
      signature,
      header,
      payload,
      alg,
    })) === true;
  } else {
    // No secret for a local algorithm and no delegate for an asymmetric one.
    // "Cannot check" must never read as "checks out".
    throw new TokenRejected('unverifiable', `no verifier available for ${alg}`);
  }

  if (!signatureOk) throw new TokenRejected('bad_signature', 'signature does not verify');

  return {
    uid: identity.uid,
    email: identity.email,
    expiresAt: identity.expiresAt,
    alg,
    claims: Object.freeze({ ...payload }),
  };
}
