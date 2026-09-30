/* js/catalog.js — published product catalog renderer.
 *
 * Used by catalog.html and index.html (featured subset).
 *
 * Exports:
 *   initCatalog(container)              — renders the full catalog
 *   initFeaturedCatalog(container, limit=4) — renders the first `limit` products
 */

import { api } from './api.js';
import { el, peso } from './dom.js';
import { renderLoading, renderEmpty, renderError } from './states.js';

// ---------------------------------------------------------------------------
// Thumbnail helpers
// ---------------------------------------------------------------------------

/**
 * Build the full thumbnail URL for a product.
 * If thumbnail_path starts with 'http', use as-is.
 * Otherwise construct a Supabase Storage URL.
 *
 * @param {string|null|undefined} thumbnailPath
 * @returns {string|null}
 */
function thumbnailUrl(thumbnailPath) {
  if (!thumbnailPath) return null;
  if (thumbnailPath.startsWith('http')) return thumbnailPath;
  const base = window.APP_CONFIG?.SUPABASE_URL?.replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/thumbnails/${thumbnailPath}`;
}

/**
 * Build a catalog card element for one product.
 *
 * @param {object} product
 * @returns {HTMLElement}
 */
function buildCard(product) {
  const url = thumbnailUrl(product.thumbnail_path);

  // Thumbnail or placeholder
  let thumbEl;
  if (url) {
    thumbEl = el('img', {
      attrs: {
        src: url,
        alt: product.title + ' thumbnail',
        loading: 'lazy',
      },
    });
    thumbEl.style.cssText = 'width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:var(--radius-sm) var(--radius-sm) 0 0;';
  } else {
    thumbEl = el('div', { class: 'card-thumb-placeholder' });
    const initial = (product.title || '?').charAt(0).toUpperCase();
    thumbEl.textContent = initial;
    thumbEl.style.cssText = [
      'width:100%;aspect-ratio:16/9;',
      'border-radius:var(--radius-sm) var(--radius-sm) 0 0;',
      'background:var(--secondary);color:#fff;',
      'display:flex;align-items:center;justify-content:center;',
      'font-family:var(--font-head);font-size:3rem;font-weight:600;',
    ].join('');
  }

  // Subject badge
  const badge = el('span', { class: 'subject-tag', text: product.subject || 'General' });

  // Title
  const title = el('h3', { text: product.title || '' });

  // Subtitle
  const subtitle = el('p', { class: 'desc', text: product.subtitle || '' });

  // Price
  const priceEl = el('p', { class: 'price', text: peso(product.price_php) });

  // Includes (first 3 items)
  const includesList = Array.isArray(product.includes) ? product.includes.slice(0, 3) : [];
  const includesSection = el('div', { class: 'included' });
  if (includesList.length > 0) {
    includesSection.appendChild(el('p', { text: 'Includes:' }));
    const ul = el('ul', { class: 'check-list' });
    for (const item of includesList) {
      ul.appendChild(el('li', { text: String(item) }));
    }
    includesSection.appendChild(ul);
  }

  // CTA button
  const slug = product.slug || product.id;
  const ctaLink = el('a', {
    class: 'btn btn--primary btn--block',
    text: 'View — ' + product.title,
    attrs: { href: '/product.html?slug=' + encodeURIComponent(slug) },
  });
  ctaLink.setAttribute('aria-label', 'View ' + product.title);

  const cardFoot = el('div', { class: 'card-foot', children: [ctaLink] });

  // Assemble card body (below thumbnail)
  const cardBody = el('div', {
    attrs: { style: 'padding:1rem;display:flex;flex-direction:column;gap:.4rem;flex:1;' },
    children: [
      badge,
      title,
      subtitle,
      priceEl,
      includesSection,
      cardFoot,
    ],
  });

  const article = el('article', {
    class: 'card',
    attrs: { style: 'padding:0;overflow:hidden;' },
    children: [thumbEl, cardBody],
  });

  return article;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch and render all published products into `container`.
 *
 * @param {HTMLElement} container
 */
export async function initCatalog(container) {
  renderLoading(container, 'Loading catalog…');
  try {
    const products = await api.getCatalog();
    if (!products.length) {
      renderEmpty(container, 'No products are available yet. Check back soon.');
      return;
    }
    _renderGrid(container, products);
  } catch (err) {
    renderError(container, err.message || 'Could not load the catalog.', () => initCatalog(container));
  }
}

/**
 * Fetch and render the first `limit` products (by sort_order) into `container`.
 * Used on the home page as a "featured" section.
 *
 * @param {HTMLElement} container
 * @param {number} [limit=4]
 */
export async function initFeaturedCatalog(container, limit = 4) {
  renderLoading(container, 'Loading featured products…');
  try {
    const products = await api.getCatalog();
    const featured = products.slice(0, limit);
    if (!featured.length) {
      renderEmpty(container, 'No featured products yet.');
      return;
    }
    _renderGrid(container, featured);
  } catch (err) {
    renderError(container, err.message || 'Could not load products.', () => initFeaturedCatalog(container, limit));
  }
}

/**
 * Internal: render an array of products as a card grid into container.
 *
 * @param {HTMLElement} container
 * @param {object[]} products
 */
function _renderGrid(container, products) {
  container.innerHTML = '';
  const grid = el('div', { class: 'grid grid--3' });
  for (const product of products) {
    grid.appendChild(buildCard(product));
  }
  container.appendChild(grid);
}
