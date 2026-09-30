/* supabase/functions/issue-material-url/index.ts — enrollment-gated signed URL.
 *
 * Requirement 18. Files in the private Materials_Bucket are never public. Every
 * download starts here: the function verifies the JWT, checks the enrollment, and
 * mints a short-lived signed URL for the one requested product.
 *
 * Security design (the order is the guarantee):
 *
 *   1. `requireUser`    — identity from the bearer token.
 *   2. `product_id`     — from the request, validated as a uuid.
 *   3. enrollment gate  — query enrollments with the service role.
 *   4. material_path    — read from products with the service role.
 *   5. signed URL       — Storage sign endpoint, expiry 300 s (Req 18.3).
 *   6. return           — the URL only; zero path information.
 *
 * The browser never learns the Storage object path (Requirement 18.7): step 6
 * returns only the signed URL, and products.material_path is withheld from the
 * client-role select grant (migration 0008).
 *
 * Every read uses the service role because enrollments has no client-role insert
 * or update policy, and products.material_path is in the deny-list for client
 * selects (migration 0008).
 *
 * Requirements: 18.1–18.8, 4.1–4.6.
 */

import { HttpError, configMissing, json, withEnvelope } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";

/** Signed URL lifetime (Requirement 18.3). */
const SIGNED_URL_EXPIRY_SECONDS = 300;

/** Name of the private materials bucket. */
const MATERIALS_BUCKET = "materials";

const READ_TIMEOUT_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const value = (globalThis as any).Deno?.env?.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function serviceContext(): { supabaseUrl: string; serviceRoleKey: string } {
  const supabaseUrl    = env("SUPABASE_URL");
  if (!supabaseUrl)    throw configMissing("SUPABASE_URL");

  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw configMissing("SUPABASE_SERVICE_ROLE_KEY");

  return { supabaseUrl, serviceRoleKey };
}

function serviceHeaders(key: string): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    accept: "application/json",
  };
}

async function serviceRead(url: string, key: string, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: serviceHeaders(key),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`issue-material-url ${what} failed`, error);
    throw new HttpError("internal_error");
  }

  if (!response.ok) {
    console.error(`issue-material-url ${what} returned`, response.status);
    await response.body?.cancel();
    throw new HttpError("internal_error");
  }

  try {
    return await response.json();
  } catch {
    throw new HttpError("internal_error");
  }
}

function restBase(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
}

function storageBase(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1`;
}

/** URL to check enrollment: does uid own product_id? */
function enrollmentUrl(supabaseUrl: string, uid: string, productId: string): string {
  const q = new URLSearchParams({
    select: "product_id",
    user_id:    `eq.${uid}`,
    product_id: `eq.${productId}`,
    limit: "1",
  });
  return `${restBase(supabaseUrl)}/enrollments?${q}`;
}

/** URL to fetch material_path for a product (service role only — not in client grant). */
function materialPathUrl(supabaseUrl: string, productId: string): string {
  const q = new URLSearchParams({
    select:     "material_path",
    id:         `eq.${productId}`,
    published:  "eq.true",
    limit:      "1",
  });
  return `${restBase(supabaseUrl)}/products?${q}`;
}

/** Storage signing endpoint for the private materials bucket. */
function signUrl(supabaseUrl: string, objectPath: string, expiresIn: number): string {
  const encoded = objectPath.split("/").map(encodeURIComponent).join("/");
  return `${storageBase(supabaseUrl)}/object/sign/${MATERIALS_BUCKET}/${encoded}?expiresIn=${expiresIn}`;
}

function productIdFrom(req: Request): string {
  const url       = new URL(req.url);
  const candidate = url.searchParams.get("product_id");

  if (!isUuid(candidate)) {
    throw new HttpError("validation_failed", "A valid product id is required.", {
      field: "product_id",
    });
  }
  return candidate;
}

export async function issueMaterialUrl(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") {
    throw new HttpError("validation_failed", "Use GET or POST.");
  }

  const uid       = await requireUser(req);
  const productId = productIdFrom(req);
  const { supabaseUrl, serviceRoleKey } = serviceContext();

  // Step 3: enrollment gate (Requirement 18.2, 18.4).
  const enrollmentBody = await serviceRead(
    enrollmentUrl(supabaseUrl, uid, productId),
    serviceRoleKey,
    "enrollment check",
  );
  const hasEnrollment = Array.isArray(enrollmentBody) && enrollmentBody.length > 0;
  if (!hasEnrollment) {
    throw new HttpError("not_enrolled", "Buy this product to access its materials.");
  }

  // Step 4: fetch material_path (client role cannot read this column — migration 0008).
  const productBody = await serviceRead(
    materialPathUrl(supabaseUrl, productId),
    serviceRoleKey,
    "material_path read",
  );

  const firstProduct = Array.isArray(productBody) ? productBody[0] : productBody;
  const materialPath = typeof firstProduct?.material_path === "string"
    ? firstProduct.material_path.trim()
    : null;

  // Requirement 18.8: file absent → friendly error, not a 404 from Storage.
  if (!materialPath) {
    console.error("issue-material-url: no material_path", { productId });
    throw new HttpError("not_found", "This material file isn't available yet. Please contact support.");
  }

  // Step 5: mint a signed URL with the service role (Requirement 18.3).
  let signResponse: Response;
  try {
    signResponse = await fetch(signUrl(supabaseUrl, materialPath, SIGNED_URL_EXPIRY_SECONDS), {
      method: "POST",
      headers: { ...serviceHeaders(serviceRoleKey), "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("issue-material-url: signing failed", error);
    throw new HttpError("internal_error");
  }

  if (!signResponse.ok) {
    const detail = await signResponse.text().catch(() => "");
    console.error("issue-material-url: signing returned", signResponse.status, detail.slice(0, 200));
    // 400 from Storage means the object does not exist (Requirement 18.8).
    if (signResponse.status === 400 || signResponse.status === 404) {
      throw new HttpError("not_found", "This material file isn't available yet. Please contact support.");
    }
    throw new HttpError("internal_error");
  }

  let signBody: { signedURL?: string; signedUrl?: string } | null = null;
  try {
    signBody = await signResponse.json();
  } catch {
    throw new HttpError("internal_error");
  }

  const signedUrl = signBody?.signedURL ?? signBody?.signedUrl ?? null;
  if (typeof signedUrl !== "string" || signedUrl.trim() === "") {
    console.error("issue-material-url: no signed URL in response", { productId });
    throw new HttpError("internal_error");
  }

  // Step 6: return only the URL — zero path information (Requirement 18.7).
  return json({
    signed_url:  signedUrl,
    expires_in:  SIGNED_URL_EXPIRY_SECONDS,
    product_id:  productId,
  });
}

export const handler = withEnvelope(issueMaterialUrl);

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno?.serve?.(handler);
