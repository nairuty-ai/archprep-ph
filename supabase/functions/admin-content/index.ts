/* supabase/functions/admin-content/index.ts — Admin → Content.
 *
 * GET  /                         pages (JSON, last updated, by whom), their
 *                                saved versions (no JSON) and the two settings
 * GET  ?action=version&id=N      one archived version's JSON
 * POST ?action=save              { slug, json, expected_updated_at }
 * POST ?action=restore           { version_id }
 * POST ?action=settings          { content_pages_enabled: 'on'|'off', site_domain }
 *
 * Every write goes through a SQL function (0025) that archives the previous
 * version, keeps 10 and writes audit_log in the same transaction. The JSON is
 * checked against js/app/content/schema.mjs (the same rules the editor shows)
 * before anything is written.
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/admin.ts";
import { rpc } from "../_shared/rpc.ts";
import { PAGE_SLUGS, validatePage } from "../_shared/content-schema.mjs";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 200_000;

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const v = (globalThis as any).Deno?.env?.get(name);
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch { return undefined; }
}

function service() {
  const url = env("SUPABASE_URL"); if (!url) throw configMissing("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY"); if (!key) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");
  return { base: `${url.replace(/\/+$/, "")}/rest/v1`, key };
}

async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  const { base, key } = service();
  let res: Response;
  try {
    res = await fetch(`${base}/${path}`, {
      ...init,
      headers: {
        apikey: key, Authorization: `Bearer ${key}`, accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    console.error("admin-content fetch failed", e);
    throw new HttpError("internal_error");
  }
  if (!res.ok) {
    console.error("admin-content PostgREST", res.status, path.split("?")[0]);
    throw new HttpError("internal_error");
  }
  return res.status === 204 ? null : await res.json().catch(() => null);
}

async function actorEmail(uid: string): Promise<string | null> {
  const rows = await rest(`profiles?select=email&id=eq.${encodeURIComponent(uid)}`) as Array<{ email: string }>;
  return rows?.[0]?.email ?? null;
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function list(): Promise<Response> {
  const [pages, versions, settings] = await Promise.all([
    rest("content_pages?select=slug,json,updated_at,updated_by,profiles(email)&order=slug.asc"),
    rest("content_page_versions?select=id,slug,saved_at,saved_by,archived_at,profiles(email)&order=id.desc"),
    rest("settings?select=key,value&key=in.(content_pages_enabled,site_domain)"),
  ]) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<{ key: string; value: string }>];
  const email = (r: Record<string, unknown>) => (r.profiles as { email?: string } | null)?.email ?? null;
  return json({
    pages: pages.map((p) => ({ slug: p.slug, json: p.json, updated_at: p.updated_at, updated_by_email: email(p) })),
    versions: versions.map((v) => ({ id: v.id, slug: v.slug, saved_at: v.saved_at, archived_at: v.archived_at, saved_by_email: email(v) })),
    settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
  });
}

async function version(id: string | null): Promise<Response> {
  if (!id || !/^\d{1,18}$/.test(id)) throw new HttpError("validation_failed", "id is required.", { field: "id" });
  const rows = await rest(`content_page_versions?select=id,slug,json,saved_at&id=eq.${id}`) as unknown[];
  if (!rows.length) throw new HttpError("not_found", "That version no longer exists.");
  return json({ version: rows[0] });
}

function checkPage(slug: unknown, page: unknown): asserts slug is string {
  if (typeof slug !== "string" || !PAGE_SLUGS.includes(slug)) {
    throw new HttpError("validation_failed", "Unknown page.", { field: "slug" });
  }
  if (JSON.stringify(page ?? null).length > MAX_BYTES) {
    throw new HttpError("validation_failed", "This page is too large to save.", { field: "json" });
  }
  const problems = validatePage(slug, page);
  if (problems.length) {
    throw new HttpError("validation_failed", "The content has errors.", { reason: "CONTENT_INVALID", problems: problems.slice(0, 50) });
  }
}

async function save(uid: string, body: Record<string, unknown>): Promise<Response> {
  checkPage(body.slug, body.json);
  const result = await rpc("content_page_save", {
    p_slug: body.slug, p_json: body.json, p_actor: uid, p_actor_email: await actorEmail(uid),
    p_expected_updated_at: typeof body.expected_updated_at === "string" ? body.expected_updated_at : null,
  });
  return json({ saved: result });
}

async function restore(uid: string, body: Record<string, unknown>): Promise<Response> {
  const id = Number(body.version_id);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError("validation_failed", "version_id is required.", { field: "version_id" });
  const rows = await rest(`content_page_versions?select=slug,json&id=eq.${id}`) as Array<{ slug: string; json: unknown }>;
  if (!rows.length) throw new HttpError("not_found", "That version no longer exists.", { reason: "VERSION_NOT_FOUND" });
  checkPage(rows[0].slug, rows[0].json);
  const result = await rpc("content_page_restore", { p_version_id: id, p_actor: uid, p_actor_email: await actorEmail(uid) });
  return json({ saved: result });
}

/** 'arkiprep.com' style host, or '' (canonical links then use the request's own host). */
export function cleanDomain(v: unknown): string {
  const raw = String(v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (raw === "") return "";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw) || raw.length > 253) {
    throw new HttpError("validation_failed", "Enter a domain like arkiprep.com.", { field: "site_domain" });
  }
  return raw;
}

async function settings(uid: string, body: Record<string, unknown>): Promise<Response> {
  const changes: Array<{ key: string; value: string }> = [];
  if ("content_pages_enabled" in body) {
    const v = body.content_pages_enabled;
    if (v !== "on" && v !== "off") throw new HttpError("validation_failed", "Use on or off.", { field: "content_pages_enabled" });
    changes.push({ key: "content_pages_enabled", value: v });
  }
  if ("site_domain" in body) changes.push({ key: "site_domain", value: cleanDomain(body.site_domain) });
  if (!changes.length) throw new HttpError("validation_failed", "Nothing to change.");

  const before = Object.fromEntries((await rest(
    `settings?select=key,value&key=in.(${changes.map((c) => c.key).join(",")})`,
  ) as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  const email = await actorEmail(uid);

  for (const c of changes) {
    await rest(`settings?key=eq.${c.key}`, {
      method: "PATCH", body: JSON.stringify({ value: c.value, updated_at: new Date().toISOString() }),
      headers: { prefer: "return=minimal" },
    });
    if (before[c.key] !== c.value) {
      await rest("audit_log", {
        method: "POST", headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          actor_id: uid, actor_email: email, area: "settings", action: "setting_changed", target: c.key,
          details: { from: before[c.key] ?? null, to: c.value },
        }),
      });
    }
  }
  return json({ settings: Object.fromEntries(changes.map((c) => [c.key, c.value])) });
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function adminContent(req: Request): Promise<Response> {
  const uid = await requireAdmin(req);
  const action = new URL(req.url).searchParams.get("action") ?? "";

  if (req.method === "GET") {
    if (action === "version") return await version(new URL(req.url).searchParams.get("id"));
    return await list();
  }
  if (req.method !== "POST") throw new HttpError("validation_failed", "Use GET or POST.");

  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch {
    throw new HttpError("validation_failed", "Send a JSON body.");
  }
  switch (action) {
    case "save": return await save(uid, body);
    case "restore": return await restore(uid, body);
    case "settings": return await settings(uid, body);
    default: throw new HttpError("validation_failed", `Unknown action: "${action}".`);
  }
}

export const handler = withEnvelope(adminContent);
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
