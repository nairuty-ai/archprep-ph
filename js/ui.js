/* ============================================================================
 * ui.js — shared front-end helpers (ES module)
 * Safe DOM helpers, API calls, formatting. No secrets here.
 * ==========================================================================*/

/** Read the global config defined in /config.js (loaded before modules). */
export const CONFIG = window.APP_CONFIG || {};

/* ---------------------------------------------------------------------------
 * Safe DOM helpers — ALWAYS use textContent for untrusted Sheet content
 * (Section 14: treat Sheet content as untrusted; never innerHTML it).
 * ------------------------------------------------------------------------- */

/** Create an element with optional class, text, and attributes. */
export function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = String(opts.text); // safe: textContent
  if (opts.html != null) node.innerHTML = opts.html;            // ONLY for our own trusted markup
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v != null) node.setAttribute(k, String(v));
    }
  }
  if (opts.children) {
    for (const c of opts.children) if (c) node.appendChild(c);
  }
  return node;
}

/** Shortcut for querySelector. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Format a number of pesos as PHP currency. */
export function peso(amount) {
  const n = Number(amount);
  if (!isFinite(n)) return "";
  return "₱" + n.toLocaleString("en-PH", { maximumFractionDigits: 0 });
}

/* ---------------------------------------------------------------------------
 * API layer — CORS-safe calls to the Apps Script Web App (Section 8).
 *   - GET requests use query params (simple request, no preflight).
 *   - POST uses Content-Type: text/plain with a JSON string body
 *     (simple request, avoids CORS preflight). NO custom headers.
 * ------------------------------------------------------------------------- */

export function isConfigured() {
  return typeof CONFIG.APPS_SCRIPT_URL === "string" && CONFIG.APPS_SCRIPT_URL.trim().length > 0;
}

function buildUrl(params) {
  const base = CONFIG.APPS_SCRIPT_URL.trim();
  // Cache-buster so admin edits to the Sheet reflect promptly on the public site.
  const usp = new URLSearchParams({ ...params, _: Date.now() });
  const sep = base.includes("?") ? "&" : "?";
  return base + sep + usp.toString();
}

/** GET ?action=... — returns parsed JSON. Throws on network/parse failure.
 *  Cacheable catalogue/settings reads are served from a short-lived
 *  sessionStorage cache so navigating between pages doesn't refetch. */
const CLIENT_CACHEABLE = { getSettings: 1, getProducts: 1, getQuizList: 1 };
const CLIENT_CACHE_TTL = 30000; // 30s, matches the server-side cache window

function clientCacheGet(action) {
  try {
    const raw = sessionStorage.getItem("apicache:" + action);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (Date.now() - rec.t > CLIENT_CACHE_TTL) return null;
    return rec.v;
  } catch (e) { return null; }
}
function clientCacheSet(action, value) {
  try { sessionStorage.setItem("apicache:" + action, JSON.stringify({ t: Date.now(), v: value })); }
  catch (e) {}
}

export async function apiGet(action, params = {}) {
  if (!isConfigured()) throw new ApiNotConfigured();

  const cacheable = CLIENT_CACHEABLE[action] && Object.keys(params).length === 0;
  if (cacheable) {
    const hit = clientCacheGet(action);
    if (hit != null) return hit;
  }

  const url = buildUrl({ action, ...params });
  let res;
  try {
    res = await fetch(url, { method: "GET", redirect: "follow" });
  } catch (e) {
    throw new ApiError("network", "We couldn't reach the server. Please check your connection and try again.");
  }
  const data = await parseJsonResponse(res);
  if (cacheable) clientCacheSet(action, data);
  return data;
}

/** POST action — body is a JSON string sent as text/plain (CORS-safe). */
export async function apiPost(action, payload = {}) {
  if (!isConfigured()) throw new ApiNotConfigured();
  const url = buildUrl({ action });
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "follow",
      // text/plain => "simple request" => no CORS preflight (Section 8 CORS note)
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (e) {
    throw new ApiError("network", "We couldn't reach the server. Please check your connection and try again.");
  }
  return parseJsonResponse(res);
}

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApiError("parse", "The server returned an unexpected response. Please try again in a moment.");
  }
}

export class ApiError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
export class ApiNotConfigured extends ApiError {
  constructor() { super("not_configured", "The site isn't connected to its backend yet."); }
}

/* ---------------------------------------------------------------------------
 * State renderers (loading / error / empty)
 * ------------------------------------------------------------------------- */

export function renderLoading(container, label = "Loading…") {
  container.replaceChildren(
    el("div", { class: "state", children: [
      el("div", { class: "spinner", attrs: { "aria-hidden": "true" } }),
      el("p", { class: "mb-0", text: label }),
    ]})
  );
}

export function renderError(container, message, onRetry) {
  const children = [
    el("h3", { text: "Something went wrong" }),
    el("p", { text: message }),
  ];
  if (typeof onRetry === "function") {
    const btn = el("button", { class: "btn btn--outline", text: "Try again" });
    btn.addEventListener("click", onRetry);
    children.push(btn);
  }
  container.replaceChildren(el("div", { class: "state", children }));
}

export function renderEmpty(container, title, message) {
  container.replaceChildren(
    el("div", { class: "state", children: [
      el("h3", { text: title }),
      el("p", { class: "mb-0", text: message }),
    ]})
  );
}

export function renderNotConfigured(container) {
  container.replaceChildren(
    el("div", { class: "state", children: [
      el("h3", { text: "Almost there" }),
      el("p", { text: "This site isn't connected to its content backend yet. The owner needs to paste the Apps Script Web App URL into config.js (see SETUP.md)." }),
      el("p", { class: "muted mb-0", text: "Once connected, products and quizzes will appear here automatically." }),
    ]})
  );
}

/* ---------------------------------------------------------------------------
 * Settings (brand name, contact email, banner, hero copy) with fallbacks.
 * ------------------------------------------------------------------------- */

let _settingsCache = null;

/* ---------------------------------------------------------------------------
 * Bootstrap: one API call for settings + products + quiz list, with a
 * persistent stale-while-revalidate cache. This is the single biggest latency
 * win — a page reads everything it needs from ONE Apps Script round-trip, and
 * repeat visits render instantly from localStorage while refreshing in the
 * background. Admin edits clear the SERVER cache, so staleness is bounded.
 * ------------------------------------------------------------------------- */
const BOOT_KEY = "archprep_bootstrap";
const BOOT_TTL = 5 * 60 * 1000; // 5 min "fresh" window before a background refresh
let _bootMem = null;      // in-memory copy for the current page (0 refetch across modules)
let _bootPromise = null;  // in-flight fetch, so parallel callers share one request

function readBootCache() {
  try { return JSON.parse(localStorage.getItem(BOOT_KEY)); } catch (e) { return null; }
}
function writeBootCache(v) {
  try { localStorage.setItem(BOOT_KEY, JSON.stringify({ t: Date.now(), v })); } catch (e) {}
}
function fetchBootstrap() {
  return apiGet("getBootstrap").then((data) => {
    if (data && data.settings) { _bootMem = data; writeBootCache(data); }
    return data;
  });
}

/** Returns { settings, products, quizList } — instantly from cache when
 *  available (revalidating in the background), else awaits the network. */
export async function getBootstrap() {
  if (!isConfigured()) return null;
  if (_bootMem) return _bootMem;

  const cached = readBootCache();
  if (cached && cached.v) {
    _bootMem = cached.v;
    if (Date.now() - cached.t > BOOT_TTL && !_bootPromise) {
      _bootPromise = fetchBootstrap().catch(() => null).finally(() => { _bootPromise = null; });
    }
    return _bootMem; // stale-while-revalidate: return immediately
  }

  if (!_bootPromise) _bootPromise = fetchBootstrap().catch(() => null).finally(() => { _bootPromise = null; });
  return _bootPromise;
}

/** Public catalogue helpers backed by the bootstrap cache (with fallbacks). */
export async function getProductsCached() {
  const boot = await getBootstrap();
  if (boot && Array.isArray(boot.products)) return boot.products;
  return apiGet("getProducts");
}
export async function getQuizListCached() {
  const boot = await getBootstrap();
  if (boot && Array.isArray(boot.quizList)) return boot.quizList;
  return apiGet("getQuizList").catch(() => []);
}

export async function getSettings() {
  if (_settingsCache) return _settingsCache;
  const fallback = {
    brand_name: CONFIG.BRAND_NAME || "ArchPrep PH",
    contact_email: CONFIG.CONTACT_EMAIL_FALLBACK || "",
    announcement_banner: "",
    hero_headline: CONFIG.HERO_HEADLINE_FALLBACK || "",
    hero_subhead: CONFIG.HERO_SUBHEAD_FALLBACK || "",
  };
  if (!isConfigured()) { _settingsCache = fallback; return fallback; }
  try {
    const boot = await getBootstrap();
    const data = (boot && boot.settings) ? boot.settings : await apiGet("getSettings");
    _settingsCache = { ...fallback, ...cleanSettings(data) };
  } catch (e) {
    _settingsCache = fallback;
  }
  return _settingsCache;
}

function cleanSettings(data) {
  if (!data || typeof data !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v != null && String(v).trim() !== "") out[k] = String(v);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Apply shared settings to the page chrome (brand, banner, contact, footer).
 * Call once per page on DOMContentLoaded.
 * ------------------------------------------------------------------------- */

/* Capture a ?ref=<code> referral into localStorage (first-touch, 30-day TTL). */
export function captureRef() {
  try {
    const ref = new URLSearchParams(location.search).get("ref");
    if (!ref || !/^[A-Za-z0-9-]{3,24}$/.test(ref)) return;
    let cur = null;
    try { cur = JSON.parse(localStorage.getItem("archprep_ref")); } catch (e) {}
    const fresh = cur && cur.ref && (Date.now() - cur.t < 30 * 24 * 3600 * 1000);
    if (!fresh) localStorage.setItem("archprep_ref", JSON.stringify({ ref, t: Date.now() })); // first-touch: don't overwrite
  } catch (e) {}
}

/* Read the stored referral code (empty if none/expired). */
export function getStoredRef() {
  try {
    const c = JSON.parse(localStorage.getItem("archprep_ref"));
    if (c && c.ref && Date.now() - c.t < 30 * 24 * 3600 * 1000) return c.ref;
  } catch (e) {}
  return "";
}

/* ---------------------------------------------------------------------------
 * Student session awareness (read-only helpers for the shared page chrome).
 * The real auth lives in account.js; here we only reflect logged-in state.
 * ------------------------------------------------------------------------- */
const STUDENT_TOKEN_KEY = "archprep_student_token";
const STUDENT_EXP_KEY = "archprep_student_expires";
const STUDENT_NAME_KEY = "archprep_student_name";

/** { loggedIn, name } — name is the display name or email local-part. */
export function getStudentSession() {
  try {
    const token = localStorage.getItem(STUDENT_TOKEN_KEY) || "";
    const exp = Number(localStorage.getItem(STUDENT_EXP_KEY) || 0);
    if (token && exp > Date.now()) {
      return { loggedIn: true, name: (localStorage.getItem(STUDENT_NAME_KEY) || "").trim() };
    }
  } catch (e) {}
  return { loggedIn: false, name: "" };
}

function initialOf(name) {
  const s = String(name || "").trim();
  return s ? s.charAt(0).toUpperCase() : "•";
}

function accountNode(kind /* "nav" | "mobile" */) {
  const sess = getStudentSession();
  if (kind === "mobile") {
    const li = el("li");
    li.appendChild(el("a", { text: sess.loggedIn ? "My account" : "Account", attrs: { href: "account.html", "data-account-link": "1" } }));
    return li;
  }
  const li = el("li");
  if (sess.loggedIn) {
    const chip = el("a", { class: "nav-account-chip", attrs: { href: "account.html", "data-account-link": "1", title: "Go to your account" } });
    chip.appendChild(el("span", { class: "nav-account-avatar", text: initialOf(sess.name), attrs: { "aria-hidden": "true" } }));
    chip.appendChild(el("span", { class: "nav-account-name", text: sess.name || "My account" }));
    li.appendChild(chip);
  } else {
    li.appendChild(el("a", { text: "Account", attrs: { href: "account.html", "data-account-link": "1" } }));
  }
  return li;
}

function injectAccountLink() {
  $$(".nav-links").forEach((ul) => {
    if (ul.querySelector("[data-account-link]")) return;
    ul.appendChild(accountNode("nav"));
  });
  const mm = document.querySelector("#mobile-menu ul");
  if (mm && !mm.querySelector("[data-account-link]")) {
    mm.appendChild(accountNode("mobile"));
  }
}

export async function applyChrome() {
  buildNavInteractions();
  captureRef();
  injectAccountLink();
  const settings = await getSettings();

  // Brand name everywhere it's marked
  $$("[data-brand]").forEach((node) => { node.textContent = settings.brand_name; });
  document.title = document.title.replace(/ArchPrep PH/g, settings.brand_name);

  // Contact email links
  $$("[data-contact-email]").forEach((node) => {
    if (settings.contact_email) {
      node.textContent = settings.contact_email;
      if (node.tagName === "A") node.setAttribute("href", "mailto:" + settings.contact_email);
    }
  });

  // Announcement banner
  const banner = $("#announce");
  if (banner) {
    if (settings.announcement_banner) {
      banner.textContent = settings.announcement_banner;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  // Footer year
  const yr = $("#footer-year");
  if (yr) yr.textContent = new Date().getFullYear();

  return settings;
}

function buildNavInteractions() {
  const toggle = $(".nav-toggle");
  const menu = $("#mobile-menu");
  if (toggle && menu) {
    toggle.addEventListener("click", () => {
      const open = menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
  }
}

/** Read a query-string param. */
export function qparam(name) {
  return new URLSearchParams(window.location.search).get(name);
}
