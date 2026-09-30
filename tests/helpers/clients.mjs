/* tests/helpers/clients.mjs — anon, per-user authenticated, and service-role
 * clients for the Platform v2 test suites (design.md → Testing Strategy, layer 1).
 *
 * These talk to a local `supabase start` stack over plain `fetch`. There is no
 * supabase-js dependency on purpose: fast-check is the repository's only dev
 * dependency (Requirement 28), and the RLS suites need the raw HTTP surface
 * anyway — arbQueryShape attacks `questions` with query strings that a typed
 * client builder would not let us express.
 *
 * Every call resolves to `{ status, ok, data, error }` and never throws on an
 * HTTP error, because "zero rows" and "policy-violation error" are both
 * assertable outcomes in Requirement 5.3.
 *
 * Suites that need the stack running must skip cleanly when it is not:
 *
 *   import { test } from 'node:test';
 *   import { skipUnlessLocalSupabase } from './helpers/clients.mjs';
 *   const localOnly = await skipUnlessLocalSupabase();
 *   test('anon cannot read questions', localOnly, async () => { ... });
 */

import { randomUUID } from 'node:crypto';
import { LOCAL_SUPABASE_URL, mintApiKey } from './tokens.mjs';

const REQUEST_TIMEOUT_MS = Number(process.env.SUPABASE_TEST_TIMEOUT_MS || 15000);
const PROBE_TIMEOUT_MS = Number(process.env.SUPABASE_PROBE_TIMEOUT_MS || 2000);

let cachedConfig;

/**
 * Local stack configuration. Keys come from the environment when present and
 * are otherwise minted from the local development JWT secret, so no key string
 * is committed.
 */
export function supabaseConfig() {
  if (cachedConfig) return cachedConfig;
  const url = (process.env.SUPABASE_URL || LOCAL_SUPABASE_URL).replace(/\/+$/, '');
  cachedConfig = {
    url,
    restUrl: `${url}/rest/v1`,
    authUrl: `${url}/auth/v1`,
    anonKey: process.env.SUPABASE_ANON_KEY || mintApiKey('anon'),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || mintApiKey('service_role'),
    isLocal: /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url),
  };
  return cachedConfig;
}

/** Test-only: drop the memoised config after mutating process.env. */
export function resetSupabaseConfig() {
  cachedConfig = undefined;
  probePromise = undefined;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

let probePromise;

/** Is a local stack answering? Probed once per process. */
export function localSupabaseStatus() {
  if (!probePromise) {
    probePromise = (async () => {
      const { url, authUrl } = supabaseConfig();
      try {
        const response = await fetch(`${authUrl}/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
          return { reachable: false, url, reason: `auth health check returned ${response.status}` };
        }
        await response.arrayBuffer();
        return { reachable: true, url, reason: null };
      } catch (error) {
        return { reachable: false, url, reason: error?.message || String(error) };
      }
    })();
  }
  return probePromise;
}

/**
 * node:test options object: `{}` when the stack is up, `{ skip: '<why>' }` when
 * it is not, so a developer without Docker running sees skipped tests and a
 * clear message rather than a red suite.
 */
export async function skipUnlessLocalSupabase() {
  const status = await localSupabaseStatus();
  if (status.reachable) return {};
  return {
    skip:
      `local Supabase not reachable at ${status.url} (${status.reason}). ` +
      'Run `supabase start` to execute this suite.',
  };
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

function appendFilters(params, filters) {
  for (const [column, condition] of Object.entries(filters || {})) {
    if (condition === null || condition === undefined) continue;
    params.append(column, String(condition));
  }
}

function buildSearchParams({
  columns,
  select,
  eq,
  filters,
  order,
  limit,
  offset,
  extra,
} = {}) {
  const params = new URLSearchParams();
  const selection = select ?? columns;
  if (selection) params.set('select', selection);
  for (const [column, value] of Object.entries(eq || {})) {
    params.append(column, `eq.${value}`);
  }
  appendFilters(params, filters);
  if (order) params.set('order', order);
  if (limit !== undefined && limit !== null) params.set('limit', String(limit));
  if (offset !== undefined && offset !== null) params.set('offset', String(offset));
  for (const [key, value] of Object.entries(extra || {})) params.append(key, String(value));
  return params;
}

async function parseBody(response) {
  const text = await response.text();
  if (text === '') return { data: null, text };
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: text, text };
  }
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function createClient({ role, label, apikey, accessToken }) {
  const config = supabaseConfig();

  function headers(extra = {}) {
    const base = {
      apikey,
      Authorization: `Bearer ${accessToken ?? apikey}`,
      Accept: 'application/json',
    };
    for (const [key, value] of Object.entries(extra)) {
      if (value === null || value === undefined) delete base[key];
      else base[key] = value;
    }
    return base;
  }

  /** Raw request against any Supabase path (`/rest/v1/...`, `/auth/v1/...`). */
  async function request(method, path, { query, body, headers: extraHeaders, prefer } = {}) {
    const search = query ? `?${query instanceof URLSearchParams ? query.toString() : query}` : '';
    const url = `${config.url}${path.startsWith('/') ? path : `/${path}`}${search}`;
    const requestHeaders = headers(extraHeaders);
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (prefer) requestHeaders.Prefer = prefer;

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        status: 0,
        ok: false,
        data: null,
        error: { message: error?.message || String(error), kind: 'network' },
        text: '',
        url,
        role,
      };
    }

    const { data, text } = await parseBody(response);
    return {
      status: response.status,
      ok: response.ok,
      data: response.ok ? data : null,
      error: response.ok ? null : data ?? { message: text },
      text,
      url,
      role,
      headers: response.headers,
    };
  }

  const rest = (method, table, options = {}) =>
    request(method, `/rest/v1/${table}`, {
      query: buildSearchParams(options),
      body: options.body,
      headers: options.headers,
      prefer: options.prefer,
    });

  return {
    role,
    label,
    accessToken: accessToken ?? null,
    config,
    headers,
    request,

    /** Select with a structured shape. `{ columns, eq, filters, order, limit, offset }`. */
    select(table, options = {}) {
      return rest('GET', table, { columns: '*', ...options });
    },

    /**
     * Select with a caller-built query string — the escape hatch arbQueryShape
     * needs for embeds, aggregates, and odd column subsets.
     */
    query(table, searchParams, options = {}) {
      return request('GET', `/rest/v1/${table}`, { query: searchParams, ...options });
    },

    insert(table, rows, options = {}) {
      return rest('POST', table, {
        ...options,
        body: rows,
        prefer: options.prefer ?? 'return=representation',
      });
    },

    update(table, patch, options = {}) {
      return rest('PATCH', table, {
        ...options,
        body: patch,
        prefer: options.prefer ?? 'return=representation',
      });
    },

    remove(table, options = {}) {
      return rest('DELETE', table, { ...options, prefer: options.prefer ?? 'return=representation' });
    },

    rpc(fn, args = {}, options = {}) {
      return request('POST', `/rest/v1/rpc/${fn}`, { body: args, ...options });
    },
  };
}

/** No session: the Anon_Role. */
export function anonClient() {
  const { anonKey } = supabaseConfig();
  return createClient({ role: 'anon', label: 'anon', apikey: anonKey });
}

/** A signed-in user: the Authenticated_Role, one client per user. */
export function authClient(accessToken, label = 'authenticated') {
  const { anonKey } = supabaseConfig();
  if (!accessToken) throw new Error('authClient requires an access token');
  return createClient({ role: 'authenticated', label, apikey: anonKey, accessToken });
}

/** Bypasses RLS. Edge Functions and test fixtures only. */
export function serviceClient() {
  const { serviceRoleKey } = supabaseConfig();
  return createClient({ role: 'service_role', label: 'service_role', apikey: serviceRoleKey });
}

// ---------------------------------------------------------------------------
// Test users — real sign-in, no passwords
// ---------------------------------------------------------------------------

/** Unique throwaway address. `.test` is reserved by RFC 2606, so it never sends. */
export function testEmail(prefix = 'user') {
  return `${prefix}-${randomUUID()}@archprep.test`;
}

/**
 * A genuine passwordless sign-in: the service role generates a magic-link token
 * for the address, then the anon client redeems it through /auth/v1/verify, the
 * same endpoint the front end uses for an emailed code (Requirement 1.3). No
 * password grant is involved, matching Requirement 1.6.
 */
export async function signIn(email) {
  const service = serviceClient();
  const link = await service.request('POST', '/auth/v1/admin/generate_link', {
    body: { type: 'magiclink', email },
  });
  if (!link.ok) {
    throw new Error(`generate_link failed for ${email} (${link.status}): ${link.text}`);
  }

  const anon = anonClient();
  const hashedToken = link.data?.hashed_token;
  const emailOtp = link.data?.email_otp;

  let verified = { ok: false, text: 'no verification attempted' };
  if (hashedToken) {
    verified = await anon.request('POST', '/auth/v1/verify', {
      body: { type: 'magiclink', token_hash: hashedToken },
    });
  }
  if (!verified.ok && emailOtp) {
    verified = await anon.request('POST', '/auth/v1/verify', {
      body: { type: 'email', email, token: emailOtp },
    });
  }
  if (!verified.ok) {
    throw new Error(`sign-in failed for ${email} (${verified.status}): ${verified.text}`);
  }
  return verified.data;
}

/**
 * Create a confirmed user and sign them in.
 * Returns `{ id, email, accessToken, refreshToken, client, session }`, where
 * `client` is that user's Authenticated_Role client.
 */
export async function createTestUser(options = {}) {
  const email = options.email ?? testEmail(options.prefix);
  const service = serviceClient();
  const created = await service.request('POST', '/auth/v1/admin/users', {
    body: {
      email,
      email_confirm: true,
      user_metadata: options.userMetadata ?? {},
    },
  });
  if (!created.ok) {
    throw new Error(`admin create user failed for ${email} (${created.status}): ${created.text}`);
  }

  const session = await signIn(email);
  const id = created.data?.id ?? session?.user?.id;
  return {
    id,
    email,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    session,
    client: authClient(session.access_token, `user:${email}`),
  };
}

/** Delete a user (and, by cascade, their profile) after a test. */
export async function deleteTestUser(userId) {
  if (!userId) return { ok: true, status: 204, data: null, error: null };
  return serviceClient().request('DELETE', `/auth/v1/admin/users/${userId}`);
}

/** Best-effort teardown for a list of user ids; never throws. */
export async function deleteTestUsers(userIds = []) {
  const results = [];
  for (const id of userIds) {
    try {
      results.push(await deleteTestUser(id));
    } catch (error) {
      results.push({ ok: false, status: 0, error: { message: error?.message } });
    }
  }
  return results;
}
