/* supabase/functions/_shared/cors.mjs — cross-origin policy, as pure logic.
 *
 * The front end is a static site on its own host; the Edge Functions live on
 * `<project-ref>.supabase.co`. Every browser call is therefore cross-origin, so
 * without a preflight answer the browser refuses the request before it is ever
 * sent — no amount of correct server logic downstream matters.
 *
 * Two decisions worth stating plainly:
 *
 * 1. `authorization` MUST appear in `access-control-allow-headers`. The session
 *    token travels in that header (Requirement 4 criterion 2 allows no other
 *    channel for it), and `Authorization` is not a CORS-safelisted request
 *    header, so a preflight that omits it blocks every authenticated call while
 *    leaving the unauthenticated ones working — a confusing half-broken site.
 *    `apikey`, `content-type`, and `x-client-info` are listed for the same
 *    reason: supabase-js sends all three.
 *
 * 2. The allowed origin is an allowlist, never `*` by default. Responses here
 *    are per-user data behind a bearer token, and `*` would let any page a
 *    student visits read those responses by replaying the token it can already
 *    see in `localStorage`. The echo-the-matching-origin form also keeps the
 *    door open to `access-control-allow-credentials` later without a rewrite —
 *    a wildcard is illegal with credentials, an echoed origin is not. We do not
 *    send that header today, because the session is a bearer token rather than
 *    a cookie and asking for credentialed CORS would widen the surface for no
 *    gain.
 *
 * Pure ESM with no runtime APIs, so `tests/cors.test.mjs` exercises it under
 * `node --test`. http.ts reads the environment and applies the result.
 */

/** Environment variable holding the comma-separated allowlist. */
export const CORS_ORIGIN_ENV_NAME = 'CORS_ALLOWED_ORIGINS';

/**
 * Allowlist used when the variable is unset.
 *
 * Local development origins only: a `:*` port wildcard so `python -m http.server`,
 * VS Code Live Server, and friends all work without configuration, and nothing
 * public. A deployed function with no `CORS_ALLOWED_ORIGINS` set therefore
 * refuses the real site's origin, which is a loud, immediate, first-request
 * failure at deploy time rather than a quietly permissive production default.
 */
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'http://localhost:*',
  'http://127.0.0.1:*',
  'http://[::1]:*',
]);

/** Methods the function set uses. `OPTIONS` is the preflight itself. */
export const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);

/** Request headers a browser may send. See note 1 above on `authorization`. */
export const ALLOWED_REQUEST_HEADERS = Object.freeze([
  'authorization',
  'apikey',
  'content-type',
  'x-client-info',
  'x-supabase-api-version',
  'x-requested-with',
]);

/** How long a browser may cache the preflight. One day. */
export const PREFLIGHT_MAX_AGE_SECONDS = 86400;

/**
 * Canonical comparison form for an origin: scheme and host only, lowercased,
 * no path and no trailing slash. `null` for anything that is not an origin —
 * including the literal string `"null"`, which a sandboxed iframe or a
 * `file://` page sends and which must never match an allowlist entry.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normaliseOrigin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  if (trimmed === '*') return '*';

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** An allowlist entry: an exact origin, a `scheme://host:*` port wildcard, or `*`. */
function normalisePattern(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed === '*') return '*';

  const portWildcard = /^(https?:\/\/[^/:]+|https?:\/\/\[[^\]]+\]):\*$/i.exec(trimmed);
  if (portWildcard) return `${portWildcard[1].toLowerCase()}:*`;

  return normaliseOrigin(trimmed);
}

/**
 * Parse the environment value into an allowlist.
 *
 * Comma or whitespace separated. An unset, blank, or entirely unparseable value
 * falls back to {@link DEFAULT_ALLOWED_ORIGINS} rather than to `*`.
 *
 * @param {unknown} raw
 * @param {readonly string[]} [fallback]
 * @returns {string[]}
 */
export function parseAllowedOrigins(raw, fallback = DEFAULT_ALLOWED_ORIGINS) {
  if (typeof raw !== 'string' || raw.trim() === '') return [...fallback];

  const patterns = [];
  for (const piece of raw.split(/[,\s]+/)) {
    const pattern = normalisePattern(piece);
    if (pattern && !patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns.length > 0 ? patterns : [...fallback];
}

/**
 * Does this origin match this allowlist entry?
 *
 * @param {string} origin canonical origin
 * @param {string} pattern canonical allowlist entry
 * @returns {boolean}
 */
export function matchesOriginPattern(origin, pattern) {
  if (!origin || !pattern) return false;
  if (pattern === '*') return true;
  if (pattern === origin) return true;

  if (pattern.endsWith(':*')) {
    const host = pattern.slice(0, -2);
    if (origin === host) return true; // default port, no port in the origin
    return origin.startsWith(`${host}:`);
  }
  return false;
}

/**
 * Is the request's `Origin` allowed?
 *
 * @param {unknown} origin raw header value
 * @param {readonly string[]} allowed allowlist
 * @returns {boolean}
 */
export function isOriginAllowed(origin, allowed = DEFAULT_ALLOWED_ORIGINS) {
  const canonical = normaliseOrigin(origin);
  if (!canonical || canonical === '*') return false;
  return allowed.some((pattern) => matchesOriginPattern(canonical, pattern));
}

/**
 * The CORS headers for one response.
 *
 * A request with no `Origin` — a server-to-server call, curl, the HitPay
 * webhook — gets no `access-control-*` headers at all, because CORS is a
 * browser mechanism and there is nothing to relax. A disallowed origin gets
 * none either: the response still returns with its real status, and the browser
 * withholds it from the page, which is exactly the intended outcome.
 *
 * `vary: origin` is always present. The allowlist can echo different values for
 * different callers, and a cache that ignored `Origin` would serve one
 * caller's `access-control-allow-origin` to another.
 *
 * @param {unknown} origin raw `Origin` header value
 * @param {readonly string[]} [allowed]
 * @param {{ preflight?: boolean }} [options]
 * @returns {Record<string, string>}
 */
export function corsHeaders(origin, allowed = DEFAULT_ALLOWED_ORIGINS, { preflight = false } = {}) {
  const headers = { vary: 'origin' };
  if (!isOriginAllowed(origin, allowed)) return headers;

  headers['access-control-allow-origin'] = normaliseOrigin(origin);

  if (preflight) {
    headers['access-control-allow-methods'] = ALLOWED_METHODS.join(', ');
    headers['access-control-allow-headers'] = ALLOWED_REQUEST_HEADERS.join(', ');
    headers['access-control-max-age'] = String(PREFLIGHT_MAX_AGE_SECONDS);
  }
  return headers;
}
