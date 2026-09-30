/* supabase/functions/_shared/postgrest.mjs — the service-role read the admin
 * gate performs, expressed as pure functions.
 *
 * admin.ts needs exactly one database read: `profiles.is_admin` for the caller.
 * Building that request is URL construction and response interpretation, both of
 * which are pure, so they live here and are unit-tested under `node --test`
 * (tests/auth-gate.test.mjs). admin.ts keeps only the `fetch`.
 *
 * PostgREST is called over plain `fetch` rather than through supabase-js for the
 * same reason tests/helpers/clients.mjs does: this is a single-column, single-row
 * lookup, and a client library would be a runtime dependency added for one URL.
 */

/** A Postgres uuid, the shape of both `auth.users.id` and `profiles.id`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * URL reading `is_admin` for one profile.
 *
 * `select=is_admin` returns that column and no other: the gate has no business
 * seeing an email or a GCash number. The uid must already be a verified uuid —
 * it comes from `requireUser`, and anything else is a programming error here
 * rather than a request the caller could shape.
 *
 * @param {string} supabaseUrl project URL
 * @param {string} uid verified user id
 * @returns {string} absolute PostgREST URL
 */
export function adminFlagQueryUrl(supabaseUrl, uid) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new TypeError('adminFlagQueryUrl requires the project URL');
  }
  if (typeof uid !== 'string' || !UUID.test(uid)) {
    throw new TypeError('adminFlagQueryUrl requires a verified uuid');
  }

  const base = supabaseUrl.trim().replace(/\/+$/, '');
  const query = new URLSearchParams({
    select: 'is_admin',
    id: `eq.${uid}`,
    limit: '1',
  });
  return `${base}/rest/v1/profiles?${query.toString()}`;
}

/**
 * Does this PostgREST body prove the caller is an admin?
 *
 * Strictly `true`, on a single row, and nothing else. An absent row, an empty
 * array, a null flag, and the string `"true"` all read as "not an admin", which
 * is Requirement 26 criterion 5's "false or the row is absent" answered the same
 * way in every case. Fail closed by construction: every path that is not an
 * explicit boolean `true` returns false.
 *
 * @param {unknown} body parsed JSON response body
 * @returns {boolean}
 */
export function hasAdminTrue(body) {
  const row = Array.isArray(body) ? body[0] : body;
  if (typeof row !== 'object' || row === null) return false;
  return row.is_admin === true;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Is this a Postgres uuid? The only shape a `product_id` may take. */
export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

/** `{base}/rest/v1`, with any trailing slash on the project URL removed. */
function restBase(supabaseUrl, caller) {
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new TypeError(`${caller} requires the project URL`);
  }
  return `${supabaseUrl.trim().replace(/\/+$/, '')}/rest/v1`;
}

function requireUuid(value, caller, what) {
  if (!isUuid(value)) throw new TypeError(`${caller} requires a ${what} uuid`);
  return value;
}

/**
 * The first row of a PostgREST body, or null.
 *
 * PostgREST answers a `select` with an array unless a singular representation
 * was requested, and an absent row is an empty array rather than an error. Both
 * shapes and both absences collapse to the same null here.
 *
 * @param {unknown} body parsed JSON response body
 * @returns {Record<string, unknown> | null}
 */
export function firstRow(body) {
  const row = Array.isArray(body) ? body[0] : body;
  return typeof row === 'object' && row !== null ? row : null;
}

/**
 * Did this PostgREST body contain at least one row?
 *
 * Used for existence tests, where the columns do not matter — only whether the
 * filter matched. Fails closed: anything that is not a row reads as "no".
 *
 * @param {unknown} body parsed JSON response body
 * @returns {boolean}
 */
export function hasRow(body) {
  return firstRow(body) !== null;
}

/* -------------------------------------------------------------------------- */
/* Enrollment gate                                                            */
/* -------------------------------------------------------------------------- */

/**
 * URL asking whether one user holds one product (Requirement 18 criterion 2).
 *
 * `select=id` because the gate is an existence test: the decision needs no
 * column value, only the presence of a row, so `source`, `order_id`, and
 * `created_at` never enter the function's memory. `limit=1` because a second
 * matching row could not change the answer — the unique constraint on
 * `(user_id, product_id)` means there is at most one anyway.
 *
 * Both ids must already be verified uuids: the uid comes from `requireUser` and
 * the product id from a validated request body, so anything else is a
 * programming error here rather than a request a caller could shape. That is
 * also what makes the `eq.` filters injection-free — a value that is not a uuid
 * never reaches the URL.
 *
 * @param {string} supabaseUrl project URL
 * @param {string} uid verified user id
 * @param {string} productId requested product id
 * @returns {string} absolute PostgREST URL
 */
export function enrollmentQueryUrl(supabaseUrl, uid, productId) {
  const base = restBase(supabaseUrl, 'enrollmentQueryUrl');
  requireUuid(uid, 'enrollmentQueryUrl', 'verified');
  requireUuid(productId, 'enrollmentQueryUrl', 'product');

  const query = new URLSearchParams({
    select: 'id',
    user_id: `eq.${uid}`,
    product_id: `eq.${productId}`,
    limit: '1',
  });
  return `${base}/enrollments?${query.toString()}`;
}

/**
 * URL reading the storage location of one product's material file.
 *
 * `material_path` is withheld from every client grant (migration 0008), so this
 * read is service-role only and is the sole way the object layout is resolved.
 * `title` rides along because the download filename is student-facing copy;
 * `type` lets the handler tell "this product has no material" from "the file is
 * missing".
 *
 * @param {string} supabaseUrl project URL
 * @param {string} productId requested product id
 * @returns {string} absolute PostgREST URL
 */
export function materialObjectQueryUrl(supabaseUrl, productId) {
  const base = restBase(supabaseUrl, 'materialObjectQueryUrl');
  requireUuid(productId, 'materialObjectQueryUrl', 'product');

  const query = new URLSearchParams({
    select: 'id,type,title,material_path',
    id: `eq.${productId}`,
    limit: '1',
  });
  return `${base}/products?${query.toString()}`;
}
