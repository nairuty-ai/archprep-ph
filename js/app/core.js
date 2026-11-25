/* js/app/core.js — shared helpers and the v2 data layer for the student site.
 *
 * Reads go straight to Supabase (RLS limits them to published rows and the
 * user's own rows). Anything that changes money or access goes through an
 * Edge Function via callFn(); the server decides prices, totals and access.
 */

import { supabase } from '../supabase.js';

export { supabase };

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

/** Create an element. Text is always set with textContent. */
export function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.href) node.setAttribute('href', opts.href);
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v === true) node.setAttribute(k, '');
      else if (v != null && v !== false) node.setAttribute(k, String(v));
    }
  }
  if (opts.style) node.style.cssText = opts.style;
  if (opts.on) for (const [evt, fn] of Object.entries(opts.on)) node.addEventListener(evt, fn);
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function peso(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v === 0 ? 'Free' : '₱' + v.toLocaleString('en-PH', { maximumFractionDigits: 0 });
}

export function formatDate(value, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-PH', { ...opts, timeZone: 'Asia/Manila' });
}

export function toast(message, ms = 4000) {
  const t = el('div', { class: 'toast', text: message, attrs: { role: 'status' } });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** Busy state for submit buttons: spinner over the label, width held. */
export function setBusy(btn, on) {
  if (on) btn.style.width = `${btn.offsetWidth}px`;
  else btn.style.width = '';
  btn.classList.toggle('is-busy', on);
  btn.disabled = on;
  btn.setAttribute('aria-busy', String(on));
}

export function param(name) {
  return new URLSearchParams(location.search).get(name);
}

// ---------------------------------------------------------------------------
// Product vocabulary (BACKEND_RULES.md §1)
// ---------------------------------------------------------------------------

export const TYPE_LABEL = {
  material: 'Materials',
  quiz: 'Quiz pack',
  mock: 'Full mock board',
  free: 'Free',
};

export const SUBJECT_LABEL = {
  A: 'Subject A',
  B: 'Subject B',
  ALL: 'Subjects A + B',
};

export const SUBJECTS = [
  {
    code: 'A',
    name: 'History & Theory, Planning, and Professional Practice',
    topics: 'Western & Philippine architecture, planning, RA 9266, PD 1096, ethics',
  },
  {
    code: 'B',
    name: 'Structural Conceptualization, Building Technology & Utilities',
    topics: 'Structures, materials, construction, plumbing, electrical, HVAC, fire code',
  },
];

/** "Until next ALE (Jan 25, 2027)" / "2 attempts" / "Free with account". */
export function accessLine(product, settings) {
  if (product.access_mode === 'exam_date') {
    const exam = settings?.exam_date;
    return exam ? `Until next ALE (${formatDate(exam + 'T12:00:00+08:00')})` : 'Until the next ALE';
  }
  if (product.access_mode === 'attempts') return `${product.attempts_per_purchase} attempts`;
  return 'Free with account';
}

export function thumbUrl(product) {
  if (!product?.thumbnail_path) return null;
  const { data } = supabase.storage.from('thumbnails').getPublicUrl(product.thumbnail_path);
  return data?.publicUrl ?? null;
}

/** A 16:9 cover, the striped placeholder until a real image is uploaded.
 *  The image sits in an inner layer so it can zoom on hover inside the frame. */
export function thumb(product, cls = 'thumb') {
  const img = el('div', { class: 'thumb-img' });
  const url = thumbUrl(product);
  if (url) img.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
  else img.textContent = 'cover: ' + (product.title || '').toLowerCase();
  return el('div', { class: cls, attrs: { 'aria-hidden': 'true' } }, img);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const PRODUCT_COLS =
  'id,slug,type,subject,title,subtitle,description,price_php,thumbnail_path,includes,' +
  'status,sort_order,access_mode,attempts_per_purchase,material_pages';

export class ApiError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export async function getCatalog() {
  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_COLS)
    .eq('status', 'published')
    .order('sort_order', { ascending: true });
  if (error) throw new ApiError('load_failed', 'We couldn’t load the courses.');
  return data ?? [];
}

export async function getProduct(slug) {
  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_COLS)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new ApiError('load_failed', 'We couldn’t load this course.');
  if (!data) throw new ApiError('not_found', 'This course may have been unpublished or the link is wrong.');
  return data;
}

/** Quizzes inside a product (for the course content list). */
export async function getProductQuizzes(productId) {
  const { data, error } = await supabase
    .from('pack_quizzes')
    .select('sort_order, quizzes(id, slug, title, subject, time_limit_sec)')
    .eq('product_id', productId)
    .order('sort_order', { ascending: true });
  if (error) return [];
  return (data ?? []).map((r) => r.quizzes).filter(Boolean);
}

let settingsPromise = null;
/** Display-safe settings as { key: value } (cached per page). */
export function getSettings() {
  settingsPromise ??= supabase
    .from('settings')
    .select('key,value')
    .then(({ data }) => Object.fromEntries((data ?? []).map((r) => [r.key, r.value])))
    .catch(() => ({}));
  return settingsPromise;
}

export async function getProfile(uid) {
  const { data } = await supabase
    .from('profiles')
    .select('id,email,display_name,mobile,ref_code,signup_completed_at')
    .eq('id', uid)
    .maybeSingle();
  return data ?? null;
}

/** Active enrollments keyed by product_id. Lapsed ones count as not owned. */
export async function getOwned() {
  const { data } = await supabase
    .from('enrollments')
    .select('id,product_id,status,access_mode,attempts_allowed,attempts_used,expires_at,created_at')
    .eq('status', 'active');
  const now = Date.now();
  const owned = {};
  for (const e of data ?? []) {
    if (e.expires_at && new Date(e.expires_at).getTime() <= now) continue;
    owned[e.product_id] = e;
  }
  return owned;
}

/** Most recent enrollment of any status for one product (for "attempts used"). */
export async function getLatestEnrollment(productId) {
  const { data } = await supabase
    .from('enrollments')
    .select('id,status,access_mode,attempts_allowed,attempts_used,expires_at,created_at')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

export async function getBalance() {
  const { data } = await supabase.from('balance_ledger').select('amount_php');
  return (data ?? []).reduce((sum, r) => sum + (r.amount_php || 0), 0);
}

/** Call an Edge Function with the user's token. Throws ApiError on failure. */
export async function callFn(name, body = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  let res;
  try {
    res = await fetch(`${window.APP_CONFIG.SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: window.APP_CONFIG.SUPABASE_ANON_KEY,
        ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network_error', 'You seem to be offline. Check your connection and try again.');
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok || payload?.ok === false) {
    // details.reason carries the specific SQL reason (ALREADY_OWNED, …).
    throw new ApiError(payload?.details?.reason ?? payload?.code ?? 'server_error',
      payload?.message ?? 'Something went wrong. Please try again.', payload?.details ?? null);
  }
  return payload;
}
