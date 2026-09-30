/* js/dom.js — safe DOM helpers.
 *
 * Requirement 29: all dynamic content goes through textContent, never innerHTML.
 * An `html` option intentionally does not exist so XSS through DB content is
 * structurally impossible rather than a convention.
 *
 * Usage:
 *   import { el, $, $$, peso } from './dom.js';
 *   const card = el('div', { class: 'card', children: [
 *     el('h3', { text: product.title }),
 *     el('p',  { text: peso(product.price_php) }),
 *   ]});
 */

const SAFE_SCHEMES = new Set(['https:']);

/**
 * Create a DOM element with optional class, text content, attributes, and children.
 *
 * @param {string} tag
 * @param {{ class?: string, text?: string, attrs?: Record<string, string>, children?: (Element|Text)[], data?: Record<string, string> }} [opts]
 */
export function el(tag, opts = {}) {
  const node = document.createElement(tag);

  if (opts.class) node.className = opts.class;

  if (typeof opts.text === 'string') node.textContent = opts.text;

  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      // Requirement 29.3: reject non-https for href/src.
      if ((k === 'href' || k === 'src') && typeof v === 'string') {
        try {
          const scheme = new URL(v, location.href).protocol;
          if (!SAFE_SCHEMES.has(scheme) && !v.startsWith('/') && !v.startsWith('.') && !v.startsWith('#')) {
            console.warn(`[dom.js] Blocked non-https ${k}:`, v);
            continue;
          }
        } catch {
          // Relative path — allow.
        }
      }
      node.setAttribute(k, v);
    }
  }

  if (opts.data) {
    for (const [k, v] of Object.entries(opts.data)) {
      node.dataset[k] = v;
    }
  }

  if (Array.isArray(opts.children)) {
    for (const child of opts.children) {
      if (child instanceof Node) node.appendChild(child);
    }
  }

  return node;
}

/** `document.querySelector` shorthand. */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/** `document.querySelectorAll` as an Array. */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/** Format a PHP peso amount: ₱1,234.00 */
export function peso(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '₱—';
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Set an element's textContent safely. Returns the element. */
export function setText(el, text) {
  el.textContent = typeof text === 'string' ? text : String(text ?? '');
  return el;
}

/** Toggle a class. */
export function toggle(el, cls, force) {
  el.classList.toggle(cls, force);
}

/** Show / hide an element using the hidden attribute. */
export function show(el, visible = true) {
  el.hidden = !visible;
}
