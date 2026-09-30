/* supabase/functions/_shared/http.ts — the one response envelope.
 *
 * Every Edge Function returns JSON, never HTML, and every JSON body leaves
 * through `json()` or `errorResponse()` below. That single exit is what makes
 * Requirement 28 criterion 5 structural rather than a habit: the scrubber runs
 * on the way out, so a thrown library error cannot leak a key, a credential, or
 * an internal path, and Requirement 33 criteria 5 to 7 get the stable `code`
 * token the front end branches on.
 *
 * Contract (frozen — `js/api.js` depends on it):
 *
 *   success  { "ok": true,  ...payload }
 *   error    { "ok": false, "code": "not_enrolled", "message": "…" }
 *
 * `code` is a machine token from ERROR_CODES; `message` is copy safe to show a
 * student. `ok` is the discriminator, so a caller never has to infer success
 * from the shape of the payload.
 *
 * The scrubbing itself lives in ./scrub.mjs, which is pure ESM with no runtime
 * dependency, so it is unit-testable outside Deno. This module owns the only
 * things that cannot be: reading the secret values out of the environment, and
 * reading the cross-origin allowlist.
 *
 * The same single exit carries the cross-origin headers. The site is a static
 * front end on a different host from the functions, so every browser call is
 * cross-origin and needs both a preflight answer and an
 * `access-control-allow-origin` on the real response. `withEnvelope()` answers
 * `OPTIONS` and stamps the headers on everything else; ./cors.mjs holds the
 * policy and the reasoning behind it.
 */

import {
  SECRET_ENV_NAMES,
  scrubString,
  secretValuesFrom,
  serialiseScrubbed,
} from "./scrub.mjs";
import {
  CORS_ORIGIN_ENV_NAME,
  corsHeaders as corsHeadersFor,
  parseAllowedOrigins,
} from "./cors.mjs";

export { REDACTED, SECRET_ENV_NAMES } from "./scrub.mjs";
export {
  ALLOWED_METHODS,
  ALLOWED_REQUEST_HEADERS,
  CORS_ORIGIN_ENV_NAME,
  DEFAULT_ALLOWED_ORIGINS,
} from "./cors.mjs";

/* -------------------------------------------------------------------------- */
/* Error codes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The complete set of error codes any Edge Function may return.
 *
 * Adding a code is a front-end change too: `js/api.js` maps each one to a
 * state. Nothing outside this list may appear in a response body.
 */
export const ERROR_CODES = [
  "auth_required",
  "not_admin",
  "not_enrolled",
  "not_found",
  "already_owned",
  "below_threshold",
  "validation_failed",
  "config_missing",
  "upstream_failed",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Default HTTP status per code. */
const CODE_STATUS: Record<ErrorCode, number> = {
  auth_required: 401,
  not_admin: 403,
  not_enrolled: 403,
  not_found: 404,
  already_owned: 409,
  below_threshold: 409,
  validation_failed: 422,
  config_missing: 500,
  upstream_failed: 502,
  internal_error: 500,
};

/** Default student-safe copy per code. A handler may override the message. */
const CODE_MESSAGE: Record<ErrorCode, string> = {
  auth_required: "Your session expired. Please sign in again.",
  not_admin: "You don't have access to this area.",
  not_enrolled: "This item isn't in your library yet.",
  not_found: "This item isn't available.",
  already_owned: "You already own this — open it in My Learning.",
  below_threshold: "Your balance hasn't reached the payout minimum yet.",
  validation_failed: "Please check the highlighted fields and try again.",
  config_missing: "A required server setting is missing.",
  upstream_failed: "We couldn't reach the payment provider. Please try again.",
  internal_error: "Something went wrong on our side. Please try again.",
};

/**
 * Code used when only a status is known.
 *
 * 403 resolves to `not_admin` because the admin gate is the one place in the
 * design that raises a bare 403. An enrollment gate must pass `not_enrolled`
 * explicitly, since that is the code the purchase-required state keys on
 * (Requirement 33 criterion 7).
 */
const STATUS_CODE: Record<number, ErrorCode> = {
  400: "validation_failed",
  401: "auth_required",
  403: "not_admin",
  404: "not_found",
  409: "already_owned",
  422: "validation_failed",
  500: "internal_error",
  502: "upstream_failed",
};

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* HttpError                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The only error type a handler should throw deliberately.
 *
 * Accepted forms:
 *
 *   new HttpError("not_enrolled")
 *   new HttpError("not_enrolled", "Buy the pack to open this quiz.")
 *   new HttpError(401, "auth_required")
 *   new HttpError(403, "not_admin", "Ask the owner for access.")
 *   new HttpError(404, "product not found")     // status-only; phrase is the message
 *
 * `details` carries structured extras for the front end — field messages for a
 * `validation_failed`, the shortfall for a `below_threshold`, the absent
 * variable name for a `config_missing`. It is scrubbed like everything else.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    statusOrCode: number | ErrorCode,
    codeOrMessage?: string,
    messageOrDetails?: string | Record<string, unknown>,
    details?: Record<string, unknown>,
  ) {
    let status: number;
    let code: ErrorCode;
    let message: string | undefined;
    let extras: Record<string, unknown> | undefined;

    if (typeof statusOrCode === "number") {
      status = statusOrCode;
      if (isErrorCode(codeOrMessage)) {
        code = codeOrMessage;
        message = typeof messageOrDetails === "string" ? messageOrDetails : undefined;
        extras = typeof messageOrDetails === "object" && messageOrDetails !== null
          ? messageOrDetails
          : details;
      } else {
        code = STATUS_CODE[status] ?? (status >= 500 ? "internal_error" : "validation_failed");
        message = codeOrMessage;
        extras = typeof messageOrDetails === "object" && messageOrDetails !== null
          ? messageOrDetails
          : details;
      }
    } else {
      code = isErrorCode(statusOrCode) ? statusOrCode : "internal_error";
      status = CODE_STATUS[code];
      message = codeOrMessage;
      extras = typeof messageOrDetails === "object" && messageOrDetails !== null
        ? messageOrDetails
        : details;
    }

    super(message && message.trim() !== "" ? message : CODE_MESSAGE[code]);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = extras;
  }
}

/** A `config_missing` error naming the absent variable, with no value attached. */
export function configMissing(variableName: string): HttpError {
  return new HttpError(
    "config_missing",
    `Server configuration is incomplete: ${variableName} is not set.`,
    { variable: variableName },
  );
}

/* -------------------------------------------------------------------------- */
/* Secret values from the environment                                         */
/* -------------------------------------------------------------------------- */

let cachedSecrets: string[] | undefined;

/**
 * The secret values to redact, read once from the function environment.
 *
 * Secrets are set at deploy time and never change mid-process, so the result is
 * cached. A denied or absent environment yields an empty list rather than an
 * exception: failing to read the env must not turn into a failure to respond.
 */
export function secretValues(): string[] {
  if (cachedSecrets) return cachedSecrets;

  const env: Record<string, string | undefined> = {};
  try {
    // deno-lint-ignore no-explicit-any
    const denoEnv = (globalThis as any).Deno?.env;
    if (denoEnv) {
      for (const name of SECRET_ENV_NAMES) env[name] = denoEnv.get(name);
    }
  } catch {
    // Environment unreadable: fall through with nothing to redact.
  }

  cachedSecrets = secretValuesFrom(env);
  return cachedSecrets;
}

/** Test seam: drop the cached environment read. */
export function resetSecretCache(): void {
  cachedSecrets = undefined;
}

/* -------------------------------------------------------------------------- */
/* Cross-origin policy                                                        */
/* -------------------------------------------------------------------------- */

/*
 * The front end is a static site on its own host, so every browser call to a
 * function is cross-origin: without a preflight answer the browser refuses the
 * request before the handler is ever reached. The policy itself — which origins,
 * which headers, and why never `*` — is documented in ./cors.mjs. This section
 * is only the environment read and the plumbing.
 */

let cachedAllowedOrigins: string[] | undefined;

/** The configured allowlist, read once. See {@link CORS_ORIGIN_ENV_NAME}. */
export function allowedOrigins(): string[] {
  if (cachedAllowedOrigins) return cachedAllowedOrigins;

  let raw: string | undefined;
  try {
    // deno-lint-ignore no-explicit-any
    raw = (globalThis as any).Deno?.env?.get(CORS_ORIGIN_ENV_NAME);
  } catch {
    raw = undefined;
  }

  cachedAllowedOrigins = parseAllowedOrigins(raw);
  return cachedAllowedOrigins;
}

/** Test seam: drop the cached allowlist. */
export function resetCorsCache(): void {
  cachedAllowedOrigins = undefined;
}

/** The `Origin` of a request, or a bare origin string, or null. */
function originOf(source?: Request | string | null): string | null {
  if (!source) return null;
  if (typeof source === "string") return source;
  try {
    return source.headers.get("Origin");
  } catch {
    return null;
  }
}

/**
 * The CORS headers for one response.
 *
 * @param source the request being answered, or its `Origin` value
 * @param options `preflight: true` adds the allow-methods/headers/max-age set
 */
export function corsHeaders(
  source?: Request | string | null,
  options: { preflight?: boolean } = {},
): Record<string, string> {
  return corsHeadersFor(originOf(source), allowedOrigins(), options);
}

/**
 * The answer to an `OPTIONS` preflight.
 *
 * 204 with no body when the origin is allowed. 403 when it is not — the browser
 * would block the real request either way, and the explicit status makes a
 * missing `CORS_ALLOWED_ORIGINS` obvious in the function logs instead of
 * appearing as an unexplained client-side failure.
 */
export function preflightResponse(req: Request): Response {
  const headers = corsHeaders(req, { preflight: true });
  const allowed = "access-control-allow-origin" in headers;
  return new Response(null, { status: allowed ? 204 : 403, headers });
}

/**
 * Add the CORS headers for `req` to a response, replacing any already set.
 *
 * Used by {@link withEnvelope} so a handler that builds a `Response` by hand
 * still ends up cross-origin correct. Headers already on the response are kept.
 */
export function withCors(response: Response, req?: Request | string | null): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(req))) headers.set(name, value);

  // A 204/304 body must stay null; every other body passes through untouched.
  return new Response(response.status === 204 || response.status === 304 ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function respond(
  body: unknown,
  status: number,
  headers?: HeadersInit,
  origin?: Request | string | null,
): Response {
  return new Response(serialiseScrubbed(body, secretValues()), {
    status,
    headers: {
      ...BASE_HEADERS,
      ...corsHeaders(origin),
      ...(headers ? Object.fromEntries(new Headers(headers)) : {}),
    },
  });
}

/**
 * A success response in the envelope.
 *
 * A plain-object payload is merged alongside `ok: true`, so
 * `json({ already_owned: true })` yields `{ ok: true, already_owned: true }`.
 * Any other payload (an array, a string) is nested under `data` so the envelope
 * stays an object. An `ok` key in the payload is ignored; the envelope owns it.
 *
 * Passing `request` (or a bare `origin`) attaches the cross-origin headers for
 * that caller. A handler wrapped in {@link withEnvelope} may omit it: the
 * wrapper knows the request and fills them in on the way out.
 *
 * @param body payload to return
 * @param init status (default 200), extra headers, and the request being answered
 */
export function json(
  body: unknown = {},
  init: {
    status?: number;
    headers?: HeadersInit;
    request?: Request | null;
    origin?: string | null;
  } = {},
): Response {
  const status = init.status ?? 200;
  const origin = init.request ?? init.origin ?? null;
  if (status >= 400) {
    // Errors must carry a code: route them through the error path.
    return errorResponse(
      new HttpError(status, isPlainObject(body) ? undefined : String(body)),
      origin,
    );
  }

  const payload = isPlainObject(body)
    ? { ok: true, ...stripOk(body) }
    : { ok: true, data: body ?? null };

  return respond(payload, status, init.headers, origin);
}

function stripOk(body: Record<string, unknown>): Record<string, unknown> {
  if (!("ok" in body)) return body;
  const { ok: _ignored, ...rest } = body;
  return rest;
}

/**
 * An error response in the envelope, from anything at all.
 *
 * An `HttpError` keeps its status, code, and message. Anything else — a thrown
 * `TypeError`, a rejected `fetch`, a string — becomes `internal_error` with
 * generic copy, because an unexpected error's own message is exactly the text
 * most likely to carry a key or a path. The scrubber still runs over the
 * result, so even a deliberate message cannot leak a configured secret.
 */
export function errorResponse(error: unknown, origin?: Request | string | null): Response {
  const httpError = error instanceof HttpError
    ? error
    : new HttpError("internal_error");

  const message = scrubString(httpError.message ?? "", secretValues()) ||
    CODE_MESSAGE[httpError.code];

  const body: Record<string, unknown> = {
    ok: false,
    code: httpError.code,
    message,
  };
  if (httpError.details && Object.keys(httpError.details).length > 0) {
    body.details = httpError.details;
  }

  return respond(body, httpError.status, undefined, origin);
}

/**
 * Wrap a handler so no unhandled throw ever escapes as an HTML 500, and so the
 * cross-origin preflight is answered without the handler knowing it exists.
 *
 * ```ts
 * Deno.serve(withEnvelope(async (req) => {
 *   const uid = await requireUser(req);
 *   return json({ enrollments: await listEnrollments(uid) });
 * }));
 * ```
 *
 * An `OPTIONS` request never reaches the handler: it is a browser negotiation,
 * not an operation, and answering it before the gate keeps `requireUser` from
 * 401-ing a preflight that carries no `Authorization` header by design.
 *
 * Every outgoing response — from `json()`, from `errorResponse()`, or built by
 * hand — passes through {@link withCors}, so each function gets the headers for
 * free and cannot forget them.
 *
 * The full error is logged server-side, where detail is useful and private; the
 * client gets the scrubbed envelope.
 */
export function withEnvelope(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return preflightResponse(req);

    try {
      return withCors(await handler(req), req);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error("unhandled error", error);
      return errorResponse(error, req);
    }
  };
}
