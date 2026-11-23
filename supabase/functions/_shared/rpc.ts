/* supabase/functions/_shared/rpc.ts — call a v2 SQL function as the service role.
 *
 * The v2 SQL functions (migrations 0019+) do the money/access work in one
 * transaction and raise a short reason code (ALREADY_OWNED, MOBILE_INVALID,
 * ...) when they refuse. rpc() turns that into an HttpError whose `code` is
 * the envelope category and whose `details.reason` is the SQL reason, so the
 * front end can show a specific message.
 */

import { HttpError, configMissing, type ErrorCode } from "./http.ts";

const RPC_TIMEOUT_MS = 10_000;

function env(name: string): string | undefined {
  try {
    const value = (globalThis as any).Deno?.env?.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Envelope category for a SQL reason code. */
export function reasonCategory(reason: string): ErrorCode {
  if (reason === "ALREADY_OWNED") return "already_owned";
  if (reason === "BELOW_THRESHOLD") return "below_threshold";
  if (reason === "NO_ACCESS" || reason === "ATTEMPTS_USED") return "not_enrolled";
  if (reason.endsWith("_NOT_FOUND")) return "not_found";
  return "validation_failed";
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{2,40}$/;

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabaseUrl = env("SUPABASE_URL");
  if (!supabaseUrl) throw configMissing("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`rpc ${fn} failed`, error);
    throw new HttpError("internal_error");
  }

  let body: any = null;
  try { body = await response.json(); } catch { /* empty or non-JSON */ }

  if (!response.ok) {
    const reason = typeof body?.message === "string" ? body.message.trim() : "";
    if (REASON_CODE.test(reason)) {
      throw new HttpError(reasonCategory(reason), reason, { reason });
    }
    console.error(`rpc ${fn} returned`, response.status, body?.code);
    throw new HttpError("internal_error");
  }
  return body as T;
}
