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
  const usp = new URLSearchParams(params);
  const sep = base.includes("?") ? "&" : "?";
  return base + sep + usp.toString();
}

/** GET ?action=... — returns parsed JSON. Throws on network/parse failure. */
export async function apiGet(action, params = {}) {
  if (!isConfigured()) throw new ApiNotConfigured();
  const url = buildUrl({ action, ...params });
  let res;
  try {
    res = await fetch(url, { method: "GET", redirect: "follow" });
  } catch (e) {
    throw new ApiError("network", "We couldn't reach the server. Please check your connection and try again.");
  }
  return parseJsonResponse(res);
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
    const data = await apiGet("getSettings");
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

export async function applyChrome() {
  buildNavInteractions();
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
