/* supabase/functions/_shared/auth.ts — the user gate.
 *
 * One function, one job: turn a request into a verified user id, or throw.
 *
 *   const uid = await requireUser(req);   // Requirement 4 criteria 1 and 2
 *
 * Requirement 4 criterion 4 ("ignore every supplied user identity") is met
 * structurally rather than by a filter: `requireUser` takes a `Request` and
 * nothing else, so there is no parameter through which a caller could offer a
 * uid, an email, or a profile id, and no handler has a second identity to
 * confuse with this one. The body is never read here — only the `Authorization`
 * header, which is the sole channel criterion 2 permits.
 *
 * The verification logic itself lives in ./jwt.mjs, which is pure and therefore
 * unit-tested under `node --test` against tokens no real auth server would
 * issue. This module owns the impure half: reading the environment and choosing
 * how the signature gets checked.
 *
 * Two signature paths, one outcome:
 *
 *   HS256 + SUPABASE_JWT_SECRET   verified in-process, no network hop
 *   asymmetric, or no secret set  verified by this project's own auth server
 *
 * Both anchor trust in the project. The second path exists because a Supabase
 * project using asymmetric JWT signing keys has no shared secret to hand a
 * function, and because SUPABASE_JWT_SECRET is not one of the variables the
 * platform injects automatically. If neither path is available the request is
 * refused: "cannot verify" never resolves to "verified".
 */

import { HttpError, configMissing } from "./http.ts";
import {
  bearerTokenFrom,
  expectedIssuers,
  TokenRejected,
  verifyAccessToken,
} from "./jwt.mjs";

export { TokenRejected } from "./jwt.mjs";

/** Environment variables this module reads. Values, never logged. */
export const AUTH_ENV_NAMES = Object.freeze([
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_JWT_SECRET",
  "SUPABASE_JWT_ISSUER",
]);

/** Ceiling on the auth-server round trip used by the asymmetric path. */
const REMOTE_VERIFY_TIMEOUT_MS = 10_000;

/** The identity of the caller, derived from the token and from nothing else. */
export interface VerifiedIdentity {
  /** `sub` of the validated token. The only user identity a handler may use. */
  readonly uid: string;
  /** `email` claim, or null. Present for convenience; never an input. */
  readonly email: string | null;
  /** `exp` of the validated token, in seconds. */
  readonly expiresAt: number;
  /** The raw bearer credential, for onward calls made *as the user*. */
  readonly token: string;
  /** Every claim of the validated token, frozen. */
  readonly claims: Readonly<Record<string, unknown>>;
}

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const value = (globalThis as any).Deno?.env?.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    // Environment unreadable. Treated as unset by every caller below.
    return undefined;
  }
}

/** `auth_required`, with the real reason logged server-side only.
 *
 * Requirement 4 criterion 6: the response carries no token value, no claim
 * value, and no other user's identifier — so every rejection returns the same
 * envelope, and the distinguishing detail goes to the log where only we see it.
 */
function authRequired(reason: string): HttpError {
  console.warn("auth rejected", { reason });
  return new HttpError("auth_required");
}

/**
 * Ask this project's auth server to validate the token.
 *
 * `GET /auth/v1/user` succeeds only for a token this project signed and has not
 * expired, so a 200 is a signature check performed by the issuer itself. The
 * returned user id is cross-checked against the token's `sub`: the id we return
 * must be the one the verified token carries, not one a response body asserts.
 */
function remoteVerifier(supabaseUrl: string, anonKey: string) {
  return async (
    { token, payload }: { token: string; payload: Record<string, unknown> },
  ): Promise<boolean> => {
    let response: Response;
    try {
      response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anonKey,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(REMOTE_VERIFY_TIMEOUT_MS),
      });
    } catch (error) {
      console.error("auth server unreachable during token verification", error);
      return false;
    }

    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }

    let user: { id?: unknown } | null = null;
    try {
      user = await response.json();
    } catch {
      return false;
    }

    return typeof user?.id === "string" && user.id !== "" && user.id === payload.sub;
  };
}

/**
 * Verify the request's bearer token and return the caller's identity.
 *
 * Throws `auth_required` (HTTP 401) for a token that is absent, malformed,
 * expired with zero tolerance, unsigned, signed by another project, or carrying
 * no `sub` — the six cases enumerated in Requirement 4 criterion 3. Throws
 * `config_missing` (HTTP 500) when the function has no way to verify a
 * signature at all, because misconfiguration on our side must not be reported
 * as the caller's failed login.
 *
 * Takes a `Request`. Takes no identity.
 */
export async function verifyRequest(req: Request): Promise<VerifiedIdentity> {
  const token = bearerTokenFrom(req.headers.get("Authorization"));
  if (!token) throw authRequired("absent");

  const supabaseUrl = env("SUPABASE_URL");
  const secret = env("SUPABASE_JWT_SECRET");
  const anonKey = env("SUPABASE_ANON_KEY");
  const issuers = expectedIssuers({ supabaseUrl, issuer: env("SUPABASE_JWT_ISSUER") });

  if (issuers.length === 0) throw configMissing("SUPABASE_URL");
  if (!secret && !(supabaseUrl && anonKey)) throw configMissing("SUPABASE_JWT_SECRET");

  try {
    const verified = await verifyAccessToken(token, {
      secret,
      issuers,
      verifySignature: supabaseUrl && anonKey
        ? remoteVerifier(supabaseUrl, anonKey)
        : undefined,
    });

    return Object.freeze({
      uid: verified.uid,
      email: verified.email,
      expiresAt: verified.expiresAt,
      token,
      claims: verified.claims,
    });
  } catch (error) {
    if (error instanceof TokenRejected) {
      // 'unverifiable' means we could not perform the check, not that the
      // caller failed it. Surfacing it as config_missing keeps a deployment
      // mistake from looking like an expired session to every user at once.
      if (error.reason === "unverifiable") throw configMissing("SUPABASE_JWT_SECRET");
      throw authRequired(error.reason);
    }
    if (error instanceof HttpError) throw error;
    console.error("unexpected failure verifying token", error);
    throw authRequired("verification_error");
  }
}

/**
 * The verified user id, and the only identity any handler may act on.
 *
 * ```ts
 * Deno.serve(withEnvelope(async (req) => {
 *   const uid = await requireUser(req);
 *   const { product_id } = await req.json();   // never a user id
 *   return json({ order: await createOrder(uid, product_id) });
 * }));
 * ```
 */
export async function requireUser(req: Request): Promise<string> {
  const { uid } = await verifyRequest(req);
  return uid;
}
