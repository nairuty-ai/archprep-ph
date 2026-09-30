/* js/api.js — typed wrappers for every Edge Function.
 *
 * Contract (mirrors _shared/http.ts):
 *   success  { ok: true,  ...payload }
 *   error    { ok: false, code: string, message: string }
 *
 * Central status mapping (Requirement 33.6, 33.7):
 *   401 → session expired → clears session + routes to login (once per navigation)
 *   403 + code=not_enrolled → purchase-required state (handled by caller via throw)
 *   network failure → retryable ApiError
 *
 * Usage:
 *   import { api } from './api.js';
 *   const catalog   = await api.getCatalog();
 *   const { checkout_url } = await api.createPayment({ product_id, ref_code });
 */

import { supabase, getAccessToken } from './supabase.js';

/** Error thrown by every api.* call on a non-ok response. */
export class ApiError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name    = 'ApiError';
    this.code    = code;      // matches ERROR_CODES in _shared/http.ts
    this.details = details;
  }
}

let _redirectingToLogin = false;

/** Edge Function base URL — derived from the Supabase project URL. */
function fnBase() {
  const base = window.APP_CONFIG?.SUPABASE_URL?.replace(/\/+$/, '');
  if (!base) throw new Error('APP_CONFIG.SUPABASE_URL is not set');
  return `${base}/functions/v1`;
}

/**
 * Call an Edge Function.
 *
 * @param {string} path  e.g. 'create-payment' or 'admin-products?action=create'
 * @param {{ method?: string, body?: unknown, token?: string|null }} [opts]
 */
async function call(path, { method = 'GET', body, token } = {}) {
  const accessToken = token !== undefined ? token : await getAccessToken();
  const headers = { 'content-type': 'application/json' };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const url = `${fnBase()}/${path}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError('network_error', 'Network request failed. Please check your connection.', { cause: err });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError('internal_error', 'Unexpected server response. Please try again.');
  }

  // Requirement 33.6 — 401: session expired, route to login once.
  if (response.status === 401 || data?.code === 'auth_required') {
    await supabase.auth.signOut();
    if (!_redirectingToLogin) {
      _redirectingToLogin = true;
      sessionStorage.setItem('login_redirect', location.pathname + location.search);
      location.href = '/login.html?reason=expired';
    }
    throw new ApiError('auth_required', 'Your session expired. Please sign in again.');
  }

  if (data?.ok === false) {
    throw new ApiError(data.code ?? 'internal_error', data.message ?? 'Something went wrong.', data.details ?? null);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Public catalog (no auth needed)
// ---------------------------------------------------------------------------

/** Fetch the published catalog directly from Supabase (no Edge Function needed). */
export async function getCatalog() {
  const { data, error } = await supabase
    .from('products')
    .select('id,slug,type,subject,title,subtitle,description,price_php,currency,thumbnail_path,includes,sort_order')
    .eq('published', true)
    .order('sort_order', { ascending: true });

  if (error) throw new ApiError('internal_error', 'Could not load the catalog. Please try again.');
  return data ?? [];
}

/** Fetch one published product by slug. */
export async function getProduct(slug) {
  const { data, error } = await supabase
    .from('products')
    .select('id,slug,type,subject,title,subtitle,description,price_php,currency,thumbnail_path,includes,sort_order')
    .eq('slug', slug)
    .eq('published', true)
    .single();

  if (error || !data) throw new ApiError('not_found', 'This product is not available.');
  return data;
}

/** Fetch one published product by id. */
export async function getProductById(id) {
  const { data, error } = await supabase
    .from('products')
    .select('id,slug,type,subject,title,subtitle,description,price_php,currency,thumbnail_path,includes,sort_order')
    .eq('id', id)
    .eq('published', true)
    .single();

  if (error || !data) throw new ApiError('not_found', 'This product is not available.');
  return data;
}

// ---------------------------------------------------------------------------
// Auth-gated catalog reads
// ---------------------------------------------------------------------------

/** Fetch the current user's enrollments. */
export async function getEnrollments() {
  const { data, error } = await supabase
    .from('enrollments')
    .select('id,product_id,source,order_id,created_at');

  if (error) throw new ApiError('internal_error', 'Could not load your library. Please try again.');
  return data ?? [];
}

/** Fetch the current user's profile. */
export async function getProfile() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id,email,display_name,ref_code,gcash_number,created_at')
    .single();

  if (error) throw new ApiError('internal_error', 'Could not load your profile. Please try again.');
  return data;
}

/** Update the current user's own profile (display_name, gcash_number only). */
export async function updateProfile({ display_name, gcash_number }) {
  const patch = {};
  if (display_name !== undefined) patch.display_name = display_name;
  if (gcash_number !== undefined) patch.gcash_number = gcash_number;

  const { error } = await supabase.from('profiles').update(patch).eq('id', (await supabase.auth.getUser()).data?.user?.id);
  if (error) throw new ApiError('internal_error', 'Could not save your profile. Please try again.');
}

/** Fetch display-safe settings. */
export async function getSettings() {
  const { data, error } = await supabase
    .from('settings')
    .select('key,value')
    .eq('display_safe', true);

  if (error) return {};
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/** Create a payment and get the HitPay checkout URL. */
export async function createPayment({ product_id, ref_code = null }) {
  return call('create-payment', {
    method: 'POST',
    body: { product_id, ...(ref_code ? { ref_code } : {}) },
  });
}

/** Poll own orders + enrollments for a given order_id. */
export async function pollOrderStatus(orderId) {
  const { data: order } = await supabase
    .from('orders')
    .select('id,status,paid_at')
    .eq('id', orderId)
    .single();

  const { data: enrollment } = await supabase
    .from('enrollments')
    .select('id,product_id')
    .eq('order_id', orderId)
    .maybeSingle();

  return { order: order ?? null, enrollment: enrollment ?? null };
}

// ---------------------------------------------------------------------------
// Content delivery
// ---------------------------------------------------------------------------

/** Get a quiz payload (questions without answers). */
export async function getQuiz(quizId) {
  return call(`get-quiz?quiz_id=${quizId}`);
}

/** Grade a quiz submission. */
export async function gradeQuiz({ quiz_id, answers }) {
  return call('grade-quiz', { method: 'POST', body: { quiz_id, answers } });
}

/** Get a signed URL for a material download. */
export async function getMaterialUrl(productId) {
  return call(`issue-material-url?product_id=${productId}`);
}

// ---------------------------------------------------------------------------
// Referrals / earnings
// ---------------------------------------------------------------------------

/** Get the current user's referral rows. */
export async function getReferrals() {
  const { data, error } = await supabase
    .from('referrals')
    .select('id,referrer_ref_code,buyer_masked,order_id,product_title,amount_php,reward_type,status,created_at,paid_at,notes')
    .order('created_at', { ascending: false });

  if (error) throw new ApiError('internal_error', 'Could not load your referrals. Please try again.');
  return data ?? [];
}

/** Request a payout. */
export async function requestPayout({ gcash_number }) {
  return call('request-payout', { method: 'POST', body: { gcash_number } });
}

// ---------------------------------------------------------------------------
// Admin helpers (all require admin session)
// ---------------------------------------------------------------------------

export const admin = {
  // Products
  listProducts:    ()        => call('admin-products'),
  createProduct:   (body)    => call('admin-products?action=create',    { method: 'POST', body }),
  updateProduct:   (body)    => call('admin-products?action=update',    { method: 'POST', body }),
  publishProduct:  (id)      => call('admin-products?action=publish',   { method: 'POST', body: { product_id: id } }),
  unpublishProduct:(id)      => call('admin-products?action=unpublish', { method: 'POST', body: { product_id: id } }),
  deleteProduct:   (id)      => call('admin-products?action=delete',    { method: 'POST', body: { product_id: id } }),

  // Quizzes
  listQuizzes:     ()        => call('admin-quizzes'),
  createQuiz:      (body)    => call('admin-quizzes?action=create',     { method: 'POST', body }),
  updateQuiz:      (body)    => call('admin-quizzes?action=update',     { method: 'POST', body }),
  deleteQuiz:      (id)      => call('admin-quizzes?action=delete',     { method: 'POST', body: { quiz_id: id } }),
  assignPacks:     (body)    => call('admin-quizzes?action=assign-packs',{ method: 'POST', body }),

  // Questions
  listQuestions:   (quizId)  => call(`admin-questions?quiz_id=${quizId}`),
  createQuestion:  (body)    => call('admin-questions?action=create',   { method: 'POST', body }),
  updateQuestion:  (body)    => call('admin-questions?action=update',   { method: 'POST', body }),
  reorderQuestions:(body)    => call('admin-questions?action=reorder',  { method: 'POST', body }),
  deleteQuestion:  (id)      => call('admin-questions?action=delete',   { method: 'POST', body: { question_id: id } }),

  // Enrollments
  listEnrollments: (params)  => call(`admin-enrollments${params ? '?' + new URLSearchParams(params) : ''}`),
  grantAccess:     (body)    => call('admin-enrollments?action=grant',  { method: 'POST', body }),
  revokeAccess:    (body)    => call('admin-enrollments?action=revoke', { method: 'POST', body }),

  // Referrals
  listReferrals:   (params)  => call(`admin-referrals${params ? '?' + new URLSearchParams(params) : ''}`),
  markReferralPaid:(id)      => call('admin-referrals?action=mark-paid',{ method: 'POST', body: { referral_id: id } }),
  voidReferral:    (id, n)   => call('admin-referrals?action=void',     { method: 'POST', body: { referral_id: id, notes: n } }),
  listPayoutRequests:(params) => call(`admin-referrals?action=payout-requests${params ? '&' + new URLSearchParams(params) : ''}`),
  handlePayout:    (body)    => call('admin-referrals?action=handle-payout', { method: 'POST', body }),

  // Settings
  listSettings:    ()        => call('admin-settings'),
  upsertSetting:   (key, value) => call('admin-settings?action=upsert', { method: 'POST', body: { key, value } }),

  // Incidents
  listIncidents:   (params)  => call(`admin-incidents${params ? '?' + new URLSearchParams(params) : ''}`),
  resolveIncident: (id)      => call('admin-incidents?action=resolve',  { method: 'POST', body: { incident_id: id } }),

  // Users
  listUsers:       (params)  => call(`admin-users${params ? '?' + new URLSearchParams(params) : ''}`),
  grantAdmin:      (email)   => call('admin-users?action=grant-admin',  { method: 'POST', body: { email } }),
  revokeAdmin:     (email)   => call('admin-users?action=revoke-admin', { method: 'POST', body: { email } }),

  // File uploads (multipart — handled separately)
  uploadThumbnail: (productId, file) => uploadFile('admin-products?action=upload-thumbnail', productId, file),
  uploadMaterial:  (productId, file) => uploadFile('admin-products?action=upload-material',  productId, file),
};

async function uploadFile(path, productId, file) {
  const accessToken = await getAccessToken();
  const formData    = new FormData();
  formData.append('product_id', productId);
  formData.append('file', file);

  const headers = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  let response;
  try {
    response = await fetch(`${fnBase()}/${path}`, { method: 'POST', headers, body: formData });
  } catch (err) {
    throw new ApiError('network_error', 'Upload failed. Please try again.', { cause: err });
  }

  let data;
  try { data = await response.json(); } catch { throw new ApiError('internal_error', 'Unexpected server response.'); }
  if (data?.ok === false) throw new ApiError(data.code ?? 'internal_error', data.message ?? 'Upload failed.');
  return data;
}

export const api = {
  getCatalog, getProduct, getProductById,
  getEnrollments, getProfile, updateProfile, getSettings,
  createPayment, pollOrderStatus,
  getQuiz, gradeQuiz, getMaterialUrl,
  getReferrals, requestPayout,
  admin,
};
