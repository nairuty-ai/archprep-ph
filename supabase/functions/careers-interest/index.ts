/* supabase/functions/careers-interest/index.ts — "Work with us" sign-up.
 *
 * POST multipart/form-data, no login needed:
 *   email (required), name, area, message, consent ("yes", required),
 *   resume (optional file: PDF, DOC or DOCX, max 5 MB)
 *   → { ok: true, new: boolean }
 *
 * public.job_interest_submit() validates the email, keeps one entry per
 * email and limits each IP to 5 submissions an hour. The résumé is checked
 * here (size, extension and file signature) and stored in the private
 * `resumes` bucket under the entry's id.
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { rpc } from "../_shared/rpc.ts";

const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const AREAS = new Set(["question_writer", "reviewer_writer", "faculty", "support", "other"]);
const UPLOAD_TIMEOUT_MS = 20_000;

const RESUME_TYPES: Record<string, { mime: string; magic: number[] }> = {
  pdf:  { mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },              // %PDF
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          magic: [0x50, 0x4b, 0x03, 0x04] },                                       // zip
  doc:  { mime: "application/msword", magic: [0xd0, 0xcf, 0x11, 0xe0] },           // OLE2
};

function env(name: string): string | undefined {
  try {
    const value = (globalThis as any).Deno?.env?.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("cf-connecting-ip") || null;
}

async function checkResume(file: File): Promise<{ bytes: Uint8Array; ext: string; mime: string }> {
  if (file.size > MAX_RESUME_BYTES) {
    throw new HttpError("validation_failed", "Résumé must be 5 MB or smaller.", { reason: "RESUME_TOO_LARGE" });
  }
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const type = RESUME_TYPES[ext];
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!type || !type.magic.every((b, i) => bytes[i] === b)) {
    throw new HttpError("validation_failed", "Résumé must be a PDF, DOC or DOCX file.", { reason: "RESUME_TYPE" });
  }
  return { bytes, ext, mime: type.mime };
}

async function upload(path: string, bytes: Uint8Array, mime: string): Promise<void> {
  const supabaseUrl = env("SUPABASE_URL");
  if (!supabaseUrl) throw configMissing("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/resumes/${path}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": mime, "x-upsert": "true" },
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("careers-interest upload failed", error);
    throw new HttpError("internal_error");
  }
  if (!response.ok) {
    console.error("careers-interest upload returned", response.status);
    await response.body?.cancel();
    throw new HttpError("internal_error");
  }
}

async function careersInterest(req: Request): Promise<Response> {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");

  let form: FormData;
  try { form = await req.formData(); } catch {
    throw new HttpError("validation_failed", "Send the form as multipart/form-data.");
  }

  if (field(form, "consent") !== "yes") {
    throw new HttpError("validation_failed", "Please agree to the privacy notice.", { reason: "CONSENT_REQUIRED" });
  }
  const area = field(form, "area");
  const file = form.get("resume");
  const resume = file instanceof File && file.size > 0 ? await checkResume(file) : null;

  const entry = await rpc<{ id: string; new: boolean }>("job_interest_submit", {
    p_email: field(form, "email"),
    p_name: field(form, "name").slice(0, 100),
    p_area: AREAS.has(area) ? area : "",
    p_message: field(form, "message").slice(0, 2000),
    p_ip: clientIp(req),
  });

  if (resume) {
    const path = `${entry.id}/resume-${Date.now()}.${resume.ext}`;
    await upload(path, resume.bytes, resume.mime);
    await rpc("job_interest_attach_resume", { p_id: entry.id, p_path: path });
  }

  return json({ new: entry.new });
}

export const handler = withEnvelope(careersInterest);

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
