/* js/product.js — product detail page logic.
 *
 * Reads ?slug from URL, fetches product, renders detail page,
 * handles Buy / Enroll button flow.
 */

import { api, ApiError } from './api.js';
import { getSession } from './supabase.js';
import { el, peso, setText } from './dom.js';
import { renderLoading, renderError, toast } from './states.js';
import { currentRef } from './referral.js';

// ---------------------------------------------------------------------------
// Thumbnail helper (shared with catalog.js)
// ---------------------------------------------------------------------------
function thumbnailUrl(thumbnailPath) {
  if (!thumbnailPath) return null;
  if (thumbnailPath.startsWith('http')) return thumbnailPath;
  const base = window.APP_CONFIG?.SUPABASE_URL?.replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/thumbnails/${thumbnailPath}`;
}

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------
export async function initProduct(container) {
  const params = new URLSearchParams(location.search);
  const slug = params.get('slug');

  if (!slug) {
    renderError(container, 'No product specified. Please go back to the catalog.', null);
    return;
  }

  renderLoading(container, 'Loading product…');

  let product;
  try {
    product = await api.getProduct(slug);
  } catch (err) {
    renderError(container, err.message || 'Could not load this product.', () => initProduct(container));
    return;
  }

  // Set page title dynamically
  document.title = product.title + ' — ArchPrep PH';

  // Check if user already owns this product
  const session = await getSession();
  let alreadyOwned = false;
  if (session) {
    try {
      const enrollments = await api.getEnrollments();
      alreadyOwned = enrollments.some((e) => e.product_id === product.id);
    } catch {
      // Non-fatal — will fall back to buy button
    }
  }

  _render(container, product, session, alreadyOwned);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function _render(container, product, session, alreadyOwned) {
  container.innerHTML = '';

  const url = thumbnailUrl(product.thumbnail_path);

  // Hero thumbnail
  let thumbEl;
  if (url) {
    thumbEl = el('img', {
      attrs: {
        src: url,
        alt: product.title + ' thumbnail',
        loading: 'lazy',
      },
    });
    thumbEl.style.cssText = 'width:100%;max-height:360px;object-fit:cover;border-radius:var(--radius);border:1px solid var(--border);';
  } else {
    thumbEl = el('div', {});
    const initial = (product.title || '?').charAt(0).toUpperCase();
    thumbEl.textContent = initial;
    thumbEl.style.cssText = [
      'width:100%;height:220px;',
      'border-radius:var(--radius);border:1px solid var(--border);',
      'background:var(--secondary);color:#fff;',
      'display:flex;align-items:center;justify-content:center;',
      'font-family:var(--font-head);font-size:5rem;font-weight:600;',
    ].join('');
  }

  // Subject badge
  const badge = el('p', { class: 'eyebrow', text: product.subject || 'General' });

  // Title
  const titleEl = el('h1', { text: product.title || '' });

  // Subtitle
  const subtitleEl = product.subtitle
    ? el('p', { class: 'lead', text: product.subtitle })
    : null;

  // Price
  const priceEl = el('p', {});
  priceEl.style.cssText = 'font-family:var(--font-head);font-size:var(--fs-xl);font-weight:600;color:var(--ink);margin:.5rem 0 0;';
  priceEl.textContent = peso(product.price_php);

  // What's included
  const includesItems = Array.isArray(product.includes) ? product.includes : [];
  let includesSection = null;
  if (includesItems.length > 0) {
    const heading = el('h2', { text: "What's included" });
    heading.style.cssText = 'font-size:var(--fs-lg);margin-top:1.5rem;margin-bottom:.75rem;';
    const ul = el('ul', { class: 'check-list' });
    for (const item of includesItems) {
      ul.appendChild(el('li', { text: String(item) }));
    }
    includesSection = el('div', { children: [heading, ul] });
  }

  // Description
  let descSection = null;
  if (product.description) {
    const heading = el('h2', { text: 'About this product' });
    heading.style.cssText = 'font-size:var(--fs-lg);margin-top:1.5rem;margin-bottom:.75rem;';
    const desc = el('p', { text: product.description });
    desc.style.color = 'var(--ink-soft)';
    descSection = el('div', { children: [heading, desc] });
  }

  // Action area (buy / open)
  const actionArea = el('div', { attrs: { id: 'product-action-area' } });
  actionArea.style.cssText = 'margin-top:1.5rem;';
  _renderActionArea(actionArea, product, session, alreadyOwned);

  // Trust signals
  const trust = el('p', {});
  trust.style.cssText = 'font-size:var(--fs-xs);color:var(--muted);margin-top:.75rem;';
  trust.textContent = 'Secure payment via HitPay · GCash or QR Ph · Instant access in your account';

  // Refund info
  const refund = el('p', {});
  refund.style.cssText = 'font-size:var(--fs-xs);color:var(--muted);margin-top:.35rem;';
  refund.textContent = 'Contact us within 7 days if you have an issue.';

  // Layout: two-column on wide screens
  const contentCol = el('div', {});
  const children = [badge, titleEl];
  if (subtitleEl) children.push(subtitleEl);
  children.push(priceEl);
  if (includesSection) children.push(includesSection);
  if (descSection) children.push(descSection);
  children.push(actionArea, trust, refund);
  for (const c of children) contentCol.appendChild(c);

  const grid = el('div', {});
  grid.style.cssText = 'display:grid;gap:2rem;align-items:start;';
  grid.appendChild(thumbEl);
  grid.appendChild(contentCol);

  // Apply two-column layout on wide viewports via inline style (no build step)
  const style = document.createElement('style');
  style.textContent = '@media(min-width:820px){#product-layout{grid-template-columns:1fr 1fr;}}';
  document.head.appendChild(style);
  grid.id = 'product-layout';

  container.appendChild(grid);
}

// ---------------------------------------------------------------------------
// Action area
// ---------------------------------------------------------------------------
function _renderActionArea(area, product, session, alreadyOwned) {
  area.innerHTML = '';

  if (alreadyOwned) {
    const link = el('a', {
      class: 'btn btn--secondary btn--lg',
      text: 'Open in My Learning',
      attrs: { href: '/my-learning.html' },
    });
    area.appendChild(link);
    return;
  }

  const btn = el('button', {
    class: 'btn btn--primary btn--lg',
    text: 'Buy now — ' + peso(product.price_php),
    attrs: {
      type: 'button',
      'aria-label': 'Buy ' + product.title + ' for ' + peso(product.price_php),
    },
  });
  area.appendChild(btn);

  const errMsg = el('p', {});
  errMsg.style.cssText = 'color:var(--error);font-size:var(--fs-xs);font-weight:600;margin-top:.5rem;';
  area.appendChild(errMsg);

  btn.addEventListener('click', async () => {
    if (!session) {
      // Save intended product and redirect to login
      sessionStorage.setItem('pending_product_id', product.id);
      sessionStorage.setItem('login_redirect', '/product.html?slug=' + encodeURIComponent(product.slug));
      location.href = '/login.html';
      return;
    }

    btn.disabled = true;
    setText(btn, 'Processing…');
    errMsg.textContent = '';

    try {
      const { checkout_url } = await api.createPayment({
        product_id: product.id,
        ref_code: currentRef(),
      });
      location.href = checkout_url;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'already_owned') {
        // Replace button with "open" link
        area.innerHTML = '';
        const notice = el('p', { text: 'You already own this product.' });
        notice.style.cssText = 'color:var(--success);font-weight:700;margin-bottom:.5rem;';
        const link = el('a', {
          class: 'btn btn--secondary btn--lg',
          text: 'Open in My Learning',
          attrs: { href: '/my-learning.html' },
        });
        area.appendChild(notice);
        area.appendChild(link);
      } else {
        errMsg.textContent = err.message || 'Payment could not be started. Please try again.';
        btn.disabled = false;
        setText(btn, 'Buy now — ' + peso(product.price_php));
      }
    }
  });
}
