/* supabase/functions/admin-products/index.ts — admin CRUD for products.
 *
 * All routes are admin-gated. Actions via ?action= query param.
 * GET /          — list all products
 * POST action=create        — create product
 * POST action=update        — update product by id
 * POST action=publish       — set published=true
 * POST action=unpublish     — set published=false
 * POST action=delete        — delete product (blocks if orders exist)
 * POST action=upload-thumbnail — upload to thumbnails bucket, update thumbnail_path
 * POST action=upload-material  — upload to materials bucket, update material_path
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/admin.ts";

const TIMEOUT_MS = 10_000;

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const v = (globalThis as any).Deno?.env?.get(name);
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch { return undefined; }
}

function serviceContext() {
  const supabaseUrl = env("SUPABASE_URL"); if (!supabaseUrl) throw configMissing("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY"); if (!serviceRoleKey) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");
  return { supabaseUrl, serviceRoleKey };
}

function serviceHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, accept: "application/json", ...extra };
}

function restBase(url: string) { return `${url.replace(/\/+$/, "")}/rest/v1`; }
function storageBase(url: string) { return `${url.replace(/\/+$/, "")}/storage/v1`; }

async function pgFetch(url: string, opts: RequestInit): Promise<{ status: number; body: unknown; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.error("admin-products fetch failed", e);
    throw new HttpError("internal_error");
  }
  let body: unknown = null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json") && res.status !== 204) {
    try { body = await res.json(); } catch { body = null; }
  } else {
    await res.body?.cancel();
  }
  return { status: res.status, body, headers: res.headers };
}

function parseTotalCount(contentRange: string | null): number {
  if (!contentRange) return 0;
  const m = contentRange.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

const VALID_TYPES = ["material", "quiz_pack"] as const;

function validateProductFields(fields: Record<string, unknown>, requireAll = false) {
  if (requireAll || "price_php" in fields) {
    const p = fields.price_php;
    if (!Number.isInteger(p) || (p as number) <= 0) {
      throw new HttpError("validation_failed", "price_php must be a positive integer.", { field: "price_php" });
    }
  }
  if (requireAll || "type" in fields) {
    if (!VALID_TYPES.includes(fields.type as typeof VALID_TYPES[number])) {
      throw new HttpError("validation_failed", "type must be 'material' or 'quiz_pack'.", { field: "type" });
    }
  }
  if (requireAll || "slug" in fields) {
    if (typeof fields.slug !== "string" || !fields.slug.trim()) {
      throw new HttpError("validation_failed", "slug is required.", { field: "slug" });
    }
  }
}

async function checkSlugUnique(base: string, key: string, slug: string, excludeId?: string) {
  const q = new URLSearchParams({ select: "id", slug: `eq.${slug}` });
  if (excludeId) q.set("id", `neq.${excludeId}`);
  const { body } = await pgFetch(`${base}/products?${q}`, {
    method: "GET",
    headers: serviceHeaders(key),
  });
  if (Array.isArray(body) && body.length > 0) {
    throw new HttpError("validation_failed", "A product with this slug already exists.", { field: "slug" });
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function listProducts(supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const q = new URLSearchParams({ select: "*", order: "sort_order.asc.nullslast,created_at.asc" });
  const { status, body, headers } = await pgFetch(`${restBase(supabaseUrl)}/products?${q}`, {
    method: "GET",
    headers: { ...serviceHeaders(serviceRoleKey), prefer: "count=exact" },
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ items: body, total_count: parseTotalCount(headers.get("content-range")) });
}

async function createProduct(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { title, slug, type, price_php, ...rest } = body;
  if (!title || !slug || !type || price_php === undefined) {
    throw new HttpError("validation_failed", "title, slug, type, and price_php are required.");
  }
  const fields = { title, slug, type, price_php, ...rest };
  validateProductFields(fields, true);
  await checkSlugUnique(restBase(supabaseUrl), serviceRoleKey, slug as string);
  const { status, body: created } = await pgFetch(`${restBase(supabaseUrl)}/products`, {
    method: "POST",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify(fields),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ product: Array.isArray(created) ? created[0] : created });
}

async function updateProduct(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { id, ...fields } = body;
  if (!id) throw new HttpError("validation_failed", "id is required.");
  validateProductFields(fields);
  if ("slug" in fields) await checkSlugUnique(restBase(supabaseUrl), serviceRoleKey, fields.slug as string, id as string);
  const q = new URLSearchParams({ id: `eq.${id}` });
  const { status, body: updated } = await pgFetch(`${restBase(supabaseUrl)}/products?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify(fields),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ product: Array.isArray(updated) ? updated[0] : updated });
}

async function setPublished(body: Record<string, unknown>, published: boolean, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { product_id } = body;
  if (!product_id) throw new HttpError("validation_failed", "product_id is required.");
  const q = new URLSearchParams({ id: `eq.${product_id}` });
  const { status } = await pgFetch(`${restBase(supabaseUrl)}/products?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
    body: JSON.stringify({ published }),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ product_id, published });
}

async function deleteProduct(body: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<Response> {
  const { product_id } = body;
  if (!product_id) throw new HttpError("validation_failed", "product_id is required.");
  // Check for existing orders
  const oq = new URLSearchParams({ select: "id", product_id: `eq.${product_id}`, limit: "1" });
  const { body: orders } = await pgFetch(`${restBase(supabaseUrl)}/orders?${oq}`, {
    method: "GET",
    headers: serviceHeaders(serviceRoleKey),
  });
  if (Array.isArray(orders) && orders.length > 0) {
    throw new HttpError("validation_failed", "Cannot delete a product with existing orders.");
  }
  const q = new URLSearchParams({ id: `eq.${product_id}` });
  const { status } = await pgFetch(`${restBase(supabaseUrl)}/products?${q}`, {
    method: "DELETE",
    headers: serviceHeaders(serviceRoleKey),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status}`);
  return json({ deleted: true, product_id });
}

async function uploadFile(
  req: Request,
  bucket: string,
  pathPrefix: string,
  column: "thumbnail_path" | "material_path",
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<Response> {
  let formData: FormData;
  try { formData = await req.formData(); } catch {
    throw new HttpError("validation_failed", "Expected multipart form data.");
  }
  const productId = formData.get("product_id");
  const file = formData.get("file");
  if (!productId || typeof productId !== "string") throw new HttpError("validation_failed", "product_id is required.");
  if (!(file instanceof File)) throw new HttpError("validation_failed", "file is required.");

  const storagePath = `${pathPrefix}/${productId}/${file.name}`;
  const uploadUrl = `${storageBase(supabaseUrl)}/object/${bucket}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;

  let uploadRes: Response;
  try {
    uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        ...serviceHeaders(serviceRoleKey),
        "content-type": file.type || "application/octet-stream",
        "x-upsert": "true",
      },
      body: await file.arrayBuffer(),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    console.error("admin-products storage upload failed", e);
    throw new HttpError("internal_error");
  }
  if (!uploadRes.ok) {
    const detail = await uploadRes.text().catch(() => "");
    console.error("admin-products storage upload returned", uploadRes.status, detail.slice(0, 200));
    throw new HttpError("internal_error", "Storage upload failed.");
  }

  const q = new URLSearchParams({ id: `eq.${productId}` });
  const { status } = await pgFetch(`${restBase(supabaseUrl)}/products?${q}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
    body: JSON.stringify({ [column]: storagePath }),
  });
  if (status >= 300) throw new HttpError("internal_error", `PostgREST returned ${status} updating ${column}`);

  return json({ [column]: storagePath });
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function adminProducts(req: Request): Promise<Response> {
  await requireAdmin(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  if (req.method === "GET") {
    return await listProducts(supabaseUrl, serviceRoleKey);
  }

  if (req.method !== "POST") throw new HttpError("validation_failed", "Use GET or POST.");

  switch (action) {
    case "create": {
      const body = await req.json() as Record<string, unknown>;
      return await createProduct(body, supabaseUrl, serviceRoleKey);
    }
    case "update": {
      const body = await req.json() as Record<string, unknown>;
      return await updateProduct(body, supabaseUrl, serviceRoleKey);
    }
    case "publish": {
      const body = await req.json() as Record<string, unknown>;
      return await setPublished(body, true, supabaseUrl, serviceRoleKey);
    }
    case "unpublish": {
      const body = await req.json() as Record<string, unknown>;
      return await setPublished(body, false, supabaseUrl, serviceRoleKey);
    }
    case "delete": {
      const body = await req.json() as Record<string, unknown>;
      return await deleteProduct(body, supabaseUrl, serviceRoleKey);
    }
    case "upload-thumbnail":
      return await uploadFile(req, "thumbnails", "thumbnails", "thumbnail_path", supabaseUrl, serviceRoleKey);
    case "upload-material":
      return await uploadFile(req, "materials", "materials", "material_path", supabaseUrl, serviceRoleKey);
    default:
      throw new HttpError("validation_failed", `Unknown action: "${action}".`);
  }
}

export const handler = withEnvelope(adminProducts);
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
