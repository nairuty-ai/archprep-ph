/* supabase/functions/complete-signup/index.ts — first login = signup.
 *
 * POST { display_name, mobile, consents: string[], consent_version, ref_code? }
 *   → { ok: true, already: boolean }
 *
 * The caller is identified only by their verified token. Validation, the
 * consent rows and the first-touch referral binding all happen inside
 * public.complete_signup() in one transaction (BACKEND_RULES.md §3, §7).
 */

import { HttpError, json, withEnvelope } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import { rpc } from "../_shared/rpc.ts";

const CONSENT_TYPES = new Set(["terms_refund", "privacy", "public_leaderboard", "marketing_email"]);

async function completeSignup(req: Request): Promise<Response> {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const uid = await requireUser(req);

  let body: any;
  try { body = await req.json(); } catch { throw new HttpError("validation_failed", "Body must be JSON."); }

  const consents = Array.isArray(body?.consents)
    ? body.consents.filter((c: unknown) => typeof c === "string" && CONSENT_TYPES.has(c))
    : [];
  const refCode = typeof body?.ref_code === "string" && /^[A-Z0-9]{4,16}$/i.test(body.ref_code)
    ? body.ref_code
    : null;

  const result = await rpc<{ ok: boolean; already: boolean }>("complete_signup", {
    p_uid: uid,
    p_display_name: typeof body?.display_name === "string" ? body.display_name : "",
    p_mobile: typeof body?.mobile === "string" ? body.mobile : "",
    p_consents: consents,
    p_version: typeof body?.consent_version === "string" ? body.consent_version.slice(0, 20) : "v1",
    p_ref_code: refCode,
  });
  return json({ already: !!result?.already });
}

export const handler = withEnvelope(completeSignup);

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
