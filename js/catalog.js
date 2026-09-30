/* js/catalog.js — published product catalog renderer.
 *
 * Used by catalog.html (full catalog) and index.html (featured subsets).
 *
 * Exports:
 *   initCatalog(container)                   — renders all products
 *   initFeaturedCatalog(container, limit, type) — renders first N of a given type
 *   thumbnailUrl(path)                        — helper to build thumbnail src
 */

import { api }                               from './api.js';
import { el, peso }                          from './dom.js';
import { renderLoading, renderEmpty, renderError } from './states.js';

// ---------------------------------------------------------------------------
// Thumbnail helper
// ---------------------------------------------------------------------------

/**
 * Build the full thumbnail URL for a product.
 * If thumbnail_path starts with 'http', use as-is.
 * Otherwise construct a Supabase Storage URL.
 *
 * @param {string|null|undefined} thumbnailPath
 * @returns {string|null}
 */
export function thumbnailUrl(thumbnailPath) {
  if (!thumbnailPath) return null;
  if (thumbnailPath.startsWith('http')) return thumbnailPath;
  const base = window.APP_CONFIG?.SUPABASE_URL?.replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/thumbnails/${thumbnailPath}`;
}

// ---------------------------------------------------------------------------
// Card builder
// ---------------------------------------------------------------------------

/**
 * Build a catalog card element for one product.
 *
 * @param {object} product
 * @returns {HTMLElement} article.course-card wrapped in div.course-card-wrap
 */
function buildCard(product) {
  const slug = product.slug || product.id;
  const type = product.type || 'material';
  const url  = thumbnailUrl(product.thumbnail_path);

  // --- Thumbnail or placeholder ---
  let thumbEl;
  if (url) {
    thumbEl = el('img', {
      class: 'course-thumb',
      attrs: {
        src:     url,
        alt:     (product.title || '') + ' thumbnail',
        loading: 'lazy',
      },
    });
  } else {
    const initial = (product.title || '?').charAt(0).toUpperCase();
    thumbEl = el('div', { class: 'course-thumb-placeholder', text: initial });
  }

  // --- Subject badge ---
  const badgeClass = type === 'quiz_pack'
    ? 'course-badge course-badge--quiz'
    : 'course-badge';
  const badge = el('span', {
    class: badgeClass,
    text:  product.subject || 'General',
  });

  // --- Title (2-line clamp via CSS) ---
  const title = el('h3', {
    class: 'course-title',
    text:  product.title || '',
  });

  // --- Subtitle (1-line clamp via CSS) ---
  const subtitle = el('p', {
    class: 'course-subtitle',
    text:  product.subtitle || '',
  });

  // --- Meta row ---
  const priceSpan = el('span', {
    class: 'course-price',
    text:  peso(product.price_php),
  });
  const typeLabel = type === 'quiz_pack' ? 'Practice Quiz' : 'Material';
  const typeSpan  = el('span', { text: typeLabel });
  const meta = el('div', {
    class:    'course-meta',
    children: [priceSpan, typeSpan],
  });

  // --- Card body ---
  const body = el('div', {
    class:    'course-body',
    children: [badge, title, subtitle, meta],
  });

  // --- CTA ---
  const cta = el('a', {
    class: 'btn btn--primary btn--block',
    text:  'View Details',
    attrs: {
      href:       '/product.html?slug=' + encodeURIComponent(slug),
      'aria-label': 'View details for ' + (product.title || slug),
    },
  });
  const foot = el('div', {
    class:    'course-foot',
    children: [cta],
  });

  // --- Article ---
  const article = el('article', {
    class: 'course-card',
    data:  { type, slug },
    children: [thumbEl, body, foot],
  });

  // --- Wrapper (used by filter tabs to show/hide) ---
  const wrap = el('div', { class: 'course-card-wrap', children: [article] });
  return wrap;
}

// ---------------------------------------------------------------------------
// Grid renderer
// ---------------------------------------------------------------------------

/**
 * Internal: render an array of products as a course-grid into container.
 *
 * @param {HTMLElement} container
 * @param {object[]} products
 */
function _renderGrid(container, products) {
  container.innerHTML = '';
  const grid = el('div', { class: 'course-grid' });
  for (const product of products) {
    grid.appendChild(buildCard(product));
  }
  container.appendChild(grid);
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
 * Fetch and render the first `limit` products of a given `type` into `container`.
 * Used on the home page as featured section previews.
 *
 * @param {HTMLElement} container
 * @param {number} [limit=4]
 * @param {'material'|'quiz_pack'} [type]
 */
export async function initFeaturedCatalog(container, limit = 4, type) {
  renderLoading(container, 'Loading featured products…');
  try {
    const products = await api.getCatalog();
    const filtered = type ? products.filter(p => p.type === type) : products;
    const featured = filtered.slice(0, limit);
    if (!featured.length) {
      renderEmpty(container, 'No featured products yet.');
      return;
    }
    _renderGrid(container, featured);
  } catch (err) {
    renderError(container, err.message || 'Could not load products.', () => initFeaturedCatalog(container, limit, type));
  }
}
