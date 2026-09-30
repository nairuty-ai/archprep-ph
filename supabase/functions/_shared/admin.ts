/* supabase/functions/_shared/admin.ts — the admin gate.
 *
 *   const uid = await requireAdmin(req);   // Requirement 26 criteria 4 to 7
 *
 * Every `admin-*` function starts with this line and performs no privileged work
 * before it returns. Two properties make it worth its own module:
 *
 * 1. The flag is re-read from `profiles` on EVERY call, with the service role,
 *    and nothing is cached — not per process, not per request. Revoking an
 *    admin is an `update` on one row, and it has to take effect on the very next
 *    request rather than whenever a warm function instance happens to recycle.
 *
 * 2. An `is_admin` claim inside the token is never consulted. Requirement 26
 *    criterion 7 forbids trusting an admin flag from a request body or header,
 *    and a JWT claim is no different in kind: it is minted at sign-in and would
 *    keep asserting privilege for the life of the token after the flag was
 *    turned off. The only authority is the row.
 *
 * Like `requireUser`, the signature takes a `Request` and no identity: the uid
 * checked is the one `requireUser` derived from the verified bearer token, so
 * there is no parameter through which a caller could nominate whose admin flag
 * gets read.
 */

import { HttpError, configMissing } from "./http.ts";
import { requireUser } from "./auth.ts";
import { adminFlagQueryUrl, hasAdminTrue } from "./postgrest.mjs";

/** Ceiling on the profile read, so a stalled database cannot hang the gate. */
const ADMIN_READ_TIMEOUT_MS = 10_000;

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const value = (globalThis as any).Deno?.env?.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read `profiles.is_admin` for one verified uid, with the service role.
 *
 * The service role is required rather than incidental: Requirement 9 keeps
 * `is_admin` out of reach of client roles, so the caller's own token cannot read
 * its own flag. Requirement 26 criterion 6 names the same role for the writes
 * that follow.
 *
 * Not exported. The uid it takes is always the output of `requireUser`, and
 * exporting it would create the identity-shaped parameter this design does not
 * want to exist.
 */
async function readAdminFlag(uid: string): Promise<boolean> {
  const supabaseUrl = env("SUPABASE_URL");
  if (!supabaseUrl) throw configMissing("SUPABASE_URL");

  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");

  let response: Response;
  try {
    response = await fetch(adminFlagQueryUrl(supabaseUrl, uid), {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(ADMIN_READ_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("admin flag read failed", error);
    throw new HttpError("internal_error");
  }

  if (!response.ok) {
    // A failed read is not a denial: reporting it as `not_admin` would tell the
    // owner they had lost access when the database merely hiccupped.
    console.error("admin flag read returned", response.status);
    await response.body?.cancel();
    throw new HttpError("internal_error");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    console.error("admin flag read returned an unreadable body", error);
    throw new HttpError("internal_error");
  }

  return hasAdminTrue(body);
}

/**
 * The verified user id of an admin caller.
 *
 * Throws `auth_required` (HTTP 401) for every token `requireUser` refuses, and
 * `not_admin` (HTTP 403) when the caller's `profiles.is_admin` is `false` or the
 * row is absent — Requirement 26 criterion 5, with zero writes performed on the
 * way out because the gate runs before the handler's first write.
 *
 * ```ts
 * Deno.serve(withEnvelope(async (req) => {
 *   const uid = await requireAdmin(req);
 *   const { email } = await req.json();      // the target, never the caller
 *   return json({ granted: await grantAdmin(email, uid) });
 * }));
 * ```
 */
export async function requireAdmin(req: Request): Promise<string> {
  const uid = await requireUser(req);

  // Re-read on every call. No cache, by design — see note 1 at the top.
  const isAdmin = await readAdminFlag(uid);
  if (!isAdmin) {
    console.warn("admin denied", { uid });
    throw new HttpError("not_admin");
  }

  return uid;
}
