/* js/catalog.js — product cards and the catalog browse page.
 *
 * Used by catalog.html (search + filters), index.html (carousels),
 * product.html (related courses) and my-learning.html (thumbnails).
 *
 * Exports:
 *   thumbnailUrl(path)                          — helper to build thumbnail src
 *   toneFor(key)                                — stable 0–5 colour tone for a subject
 *   typeLabel(type)                             — "Review material" / "Practice quiz"
 *   buildThumb(product)                         — 16:9 thumbnail or generated cover
 *   buildCourseCard(product)                    — vertical card (grids, carousels)
 *   buildListCard(product)                      — horizontal card (search results)
 *   initCatalog(container)                      — renders all products as a grid
 *   initFeaturedCatalog(container, limit, type) — renders first N of a type
 *   initCatalogPage(opts)                       — full catalog page with filters
 */

import { api }                                     from './api.js';
import { el, peso }                                from './dom.js';
import { renderLoading, renderEmpty, renderError } from './states.js';
import { icon, brandMark }                         from './icons.js';

// ---------------------------------------------------------------------------
// Helpers
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

/** Stable colour tone (0–5) for a subject or category name. */
export function toneFor(key) {
  const s = String(key || 'ArchPrep');
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 6;
}

export function typeLabel(type) {
  return type === 'quiz_pack' ? 'Practice quiz' : 'Review material';
}

export function productHref(product) {
  return '/product.html?slug=' + encodeURIComponent(product.slug || product.id);
}

/** Generated 16:9 cover for products without a thumbnail image. */
function buildCover(product) {
  const tone = toneFor(product.subject || product.type);
  return el('div', {
    class: `course-cover tone-${tone}`,
    attrs: { 'aria-hidden': 'true' },
    children: [
      el('span', { class: 'course-cover-mark', children: [brandMark(15)] }),
      el('span', { class: 'course-cover-kicker', text: product.subject || typeLabel(product.type) }),
      el('span', { class: 'course-cover-title', text: product.title || '' }),
    ],
  });
}

/** 16:9 thumbnail; falls back to a generated cover if missing or broken. */
export function buildThumb(product) {
  const wrap = el('div', { class: 'course-thumb-wrap' });
  const url  = thumbnailUrl(product.thumbnail_path);
  if (url) {
    const img = el('img', {
      class: 'course-thumb',
      attrs: { src: url, alt: '', loading: 'lazy', decoding: 'async' },
    });
    img.addEventListener('error', () => {
      wrap.innerHTML = '';
      wrap.appendChild(buildCover(product));
    }, { once: true });
    wrap.appendChild(img);
  } else {
    wrap.appendChild(buildCover(product));
  }
  return wrap;
}

function typeBadge(type) {
  return el('span', {
    class: type === 'quiz_pack' ? 'course-badge course-badge--quiz' : 'course-badge',
    text:  typeLabel(type),
  });
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

/**
 * Vertical course card (grids and carousels). The whole card is one link.
 * @param {object} product
 * @returns {HTMLElement}
 */
export function buildCourseCard(product) {
  const type = product.type || 'material';

  const metaChildren = [typeBadge(type)];
  if (product.subject) metaChildren.push(el('span', { text: product.subject }));

  const body = el('div', {
    class: 'course-body',
    children: [
      el('h3', { class: 'course-title', text: product.title || '' }),
      el('p',  { class: 'course-author', text: 'ArchPrep PH' }),
      el('div', { class: 'course-meta', children: metaChildren }),
      el('div', {
        class: 'course-foot',
        children: [
          el('span', { class: 'course-price', text: peso(product.price_php) }),
          el('span', { class: 'course-cta', text: 'View details', attrs: { 'aria-hidden': 'true' } }),
        ],
      }),
    ],
  });

  return el('a', {
    class: 'course-card',
    attrs: { href: productHref(product) },
    data:  { type, slug: product.slug || product.id, subject: product.subject || '' },
    children: [buildThumb(product), body],
  });
}

/**
 * Horizontal list card used on the catalog results page.
 * @param {object} product
 * @returns {HTMLElement}
 */
export function buildListCard(product) {
  const type = product.type || 'material';

  const metaChildren = [typeBadge(type)];
  if (product.subject) metaChildren.push(el('span', { text: product.subject }));
  metaChildren.push(el('span', { class: 'course-meta-item', children: [icon('bolt', 13), document.createTextNode('Instant access')] }));

  const bodyChildren = [el('h3', { class: 'course-title', text: product.title || '' })];
  if (product.subtitle) bodyChildren.push(el('p', { class: 'course-subtitle', text: product.subtitle }));
  bodyChildren.push(el('p', { class: 'course-author', text: 'ArchPrep PH' }));
  bodyChildren.push(el('div', { class: 'course-meta', children: metaChildren }));

  // Price sits under the text on phones and in its own column on wide screens
  // (placement handled by the .list-card grid in CSS).
  const price = el('div', {
    class: 'list-price',
    children: [
      el('span', { class: 'course-price', text: peso(product.price_php) }),
      el('span', { class: 'course-cta', text: 'View details', attrs: { 'aria-hidden': 'true' } }),
    ],
  });

  return el('a', {
    class: 'list-card',
    attrs: { href: productHref(product) },
    data:  { type, slug: product.slug || product.id },
    children: [buildThumb(product), el('div', { class: 'course-body', children: bodyChildren }), price],
  });
}

/** Skeleton placeholders shown while products load. */
export function renderSkeletonCards(container, count = 4) {
  container.innerHTML = '';
  const grid = el('div', { class: 'course-grid', attrs: { 'aria-hidden': 'true' } });
  for (let i = 0; i < count; i++) {
    grid.appendChild(el('div', {
      class: 'skeleton-card',
      children: [
        el('div', { class: 'sk sk-thumb' }),
        el('div', { class: 'sk sk-line' }),
        el('div', { class: 'sk sk-line short' }),
      ],
    }));
  }
  container.appendChild(grid);
}

function _renderGrid(container, products) {
  container.innerHTML = '';
  const grid = el('div', { class: 'course-grid' });
  for (const product of products) grid.appendChild(buildCourseCard(product));
  container.appendChild(grid);
}

// ---------------------------------------------------------------------------
// Simple renderers (kept for backwards compatibility)
// ---------------------------------------------------------------------------

/** Fetch and render all published products into `container` as a grid. */
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

/** Fetch and render the first `limit` products of a given `type`. */
export async function initFeaturedCatalog(container, limit = 4, type) {
  renderSkeletonCards(container, limit);
  try {
    const products = await api.getCatalog();
    const filtered = type ? products.filter((p) => p.type === type) : products;
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

// ---------------------------------------------------------------------------
// Catalog page (search, filters, sort)
// ---------------------------------------------------------------------------

const TYPE_OPTIONS = [
  { value: '',          label: 'All types' },
  { value: 'material',  label: 'Review materials' },
  { value: 'quiz_pack', label: 'Practice quizzes' },
];

const SORTS = {
  recommended: { label: 'Most relevant',      fn: null },
  'price-asc': { label: 'Price: low to high', fn: (a, b) => Number(a.price_php) - Number(b.price_php) },
  'price-desc':{ label: 'Price: high to low', fn: (a, b) => Number(b.price_php) - Number(a.price_php) },
  title:       { label: 'Title: A to Z',      fn: (a, b) => String(a.title).localeCompare(String(b.title)) },
};

function readState() {
  const p = new URLSearchParams(location.search);
  const type = p.get('type');
  const sort = p.get('sort');
  return {
    q:        (p.get('q') || '').trim(),
    type:     type === 'material' || type === 'quiz_pack' ? type : '',
    subjects: p.getAll('subject').filter(Boolean),
    sort:     SORTS[sort] ? sort : 'recommended',
  };
}

function writeState(state) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.type) p.set('type', state.type);
  for (const s of state.subjects) p.append('subject', s);
  if (state.sort !== 'recommended') p.set('sort', state.sort);
  const qs = p.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
}

function matchesQuery(product, q) {
  if (!q) return true;
  const hay = [product.title, product.subtitle, product.subject, product.description, typeLabel(product.type)]
    .filter(Boolean).join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((term) => hay.includes(term));
}

function applyFilters(products, state, { ignoreType = false, ignoreSubject = false } = {}) {
  return products.filter((p) =>
    matchesQuery(p, state.q) &&
    (ignoreType || !state.type || p.type === state.type) &&
    (ignoreSubject || !state.subjects.length || state.subjects.includes(p.subject || 'General')),
  );
}

/**
 * Wire up the catalog page.
 * @param {{ root: HTMLElement, title: HTMLElement, subtitle: HTMLElement,
 *           panel: HTMLElement, layout: HTMLElement, count: HTMLElement,
 *           chips: HTMLElement, sort: HTMLSelectElement, toggle: HTMLButtonElement }} ui
 */
export async function initCatalogPage(ui) {
  const state = readState();

  // Sort select.
  ui.sort.innerHTML = '';
  for (const [value, { label }] of Object.entries(SORTS)) {
    ui.sort.appendChild(el('option', { text: 'Sort by: ' + label, attrs: { value } }));
  }
  ui.sort.value = state.sort;

  // Filter panel toggle (mobile: show/hide, desktop: collapse sidebar).
  const desktop = window.matchMedia('(min-width: 960px)');
  ui.toggle.setAttribute('aria-expanded', String(desktop.matches));
  ui.toggle.addEventListener('click', () => {
    if (desktop.matches) {
      const collapsed = ui.layout.classList.toggle('filters-collapsed');
      ui.toggle.setAttribute('aria-expanded', String(!collapsed));
    } else {
      const open = ui.layout.classList.toggle('filters-open');
      ui.toggle.setAttribute('aria-expanded', String(open));
    }
  });

  let products = [];

  const rerender = () => {
    writeState(state);
    renderPanel();
    renderResults();
  };

  ui.sort.addEventListener('change', () => {
    state.sort = ui.sort.value;
    rerender();
  });

  async function load() {
    renderSkeletonCards(ui.root, 4);
    try {
      products = await api.getCatalog();
    } catch (err) {
      renderError(ui.root, err.message || 'Could not load the catalog.', load);
      return;
    }
    rerender();
  }

  // ---- Filter panel ------------------------------------------------------
  function renderPanel() {
    ui.panel.innerHTML = '';

    // Type
    const typeBase = applyFilters(products, state, { ignoreType: true });
    const typeGroup = el('details', { class: 'filter-group', attrs: { open: '' } });
    typeGroup.appendChild(el('summary', { text: 'Type' }));
    for (const opt of TYPE_OPTIONS) {
      const count = opt.value ? typeBase.filter((p) => p.type === opt.value).length : typeBase.length;
      const input = el('input', { attrs: { type: 'radio', name: 'f-type', value: opt.value } });
      input.checked = state.type === opt.value;
      input.addEventListener('change', () => { state.type = opt.value; rerender(); });
      typeGroup.appendChild(el('label', {
        class: 'filter-option',
        children: [input, el('span', { text: opt.label }), el('span', { class: 'opt-count', text: '(' + count + ')' })],
      }));
    }
    ui.panel.appendChild(typeGroup);

    // Subject
    const subjBase = applyFilters(products, state, { ignoreSubject: true });
    const subjects = [...new Set(products.map((p) => p.subject || 'General'))];
    if (subjects.length) {
      const subjGroup = el('details', { class: 'filter-group', attrs: { open: '' } });
      subjGroup.appendChild(el('summary', { text: 'Subject' }));
      for (const s of subjects) {
        const count = subjBase.filter((p) => (p.subject || 'General') === s).length;
        const input = el('input', { attrs: { type: 'checkbox', value: s } });
        input.checked = state.subjects.includes(s);
        input.addEventListener('change', () => {
          state.subjects = input.checked
            ? [...state.subjects, s]
            : state.subjects.filter((x) => x !== s);
          rerender();
        });
        subjGroup.appendChild(el('label', {
          class: 'filter-option',
          children: [input, el('span', { text: s }), el('span', { class: 'opt-count', text: '(' + count + ')' })],
        }));
      }
      ui.panel.appendChild(subjGroup);
    }

    if (state.type || state.subjects.length || state.q) {
      const clear = el('button', { class: 'btn btn--ghost btn--sm filter-clear', text: 'Clear all filters', attrs: { type: 'button' } });
      clear.addEventListener('click', () => {
        state.type = '';
        state.subjects = [];
        state.q = '';
        const navQ = document.getElementById('nav-q');
        if (navQ) navQ.value = '';
        rerender();
      });
      ui.panel.appendChild(clear);
    }

    const active = (state.type ? 1 : 0) + state.subjects.length;
    const badge = ui.toggle.querySelector('.filter-count');
    if (badge) badge.textContent = active ? String(active) : '';
  }

  // ---- Active filter chips ----------------------------------------------
  function chip(label, onRemove) {
    const x = el('button', {
      attrs: { type: 'button', 'aria-label': 'Remove filter ' + label },
      children: [icon('close', 14, 2.4)],
    });
    x.addEventListener('click', onRemove);
    return el('span', { class: 'chip', children: [el('span', { text: label }), x] });
  }

  function renderChips() {
    ui.chips.innerHTML = '';
    if (state.q) ui.chips.appendChild(chip('“' + state.q + '”', () => {
      state.q = '';
      const navQ = document.getElementById('nav-q');
      if (navQ) navQ.value = '';
      rerender();
    }));
    if (state.type) {
      const label = TYPE_OPTIONS.find((t) => t.value === state.type)?.label || state.type;
      ui.chips.appendChild(chip(label, () => { state.type = ''; rerender(); }));
    }
    for (const s of state.subjects) {
      ui.chips.appendChild(chip(s, () => { state.subjects = state.subjects.filter((x) => x !== s); rerender(); }));
    }
  }

  // ---- Results -----------------------------------------------------------
  function renderResults() {
    let results = applyFilters(products, state);
    const sorter = SORTS[state.sort]?.fn;
    if (sorter) results = [...results].sort(sorter);

    // Heading
    if (state.q) {
      ui.title.textContent = `${results.length} ${results.length === 1 ? 'result' : 'results'} for “${state.q}”`;
      ui.subtitle.textContent = 'Review materials and practice quizzes matching your search.';
    } else if (state.type === 'quiz_pack') {
      ui.title.textContent = 'Practice quizzes';
      ui.subtitle.textContent = 'Exam-style questions to test yourself before the real ALE. Instant access after payment.';
    } else if (state.type === 'material') {
      ui.title.textContent = 'Review materials';
      ui.subtitle.textContent = 'Focused reviewers for every ALE subject. Open them any time on any device.';
    } else {
      ui.title.textContent = 'All ALE review courses';
      ui.subtitle.textContent = 'Review materials and practice quizzes for the Philippine Architect Licensure Examination.';
    }
    document.title = ui.title.textContent + ' — ArchPrep PH';

    ui.count.textContent = `${results.length} ${results.length === 1 ? 'course' : 'courses'}`;
    renderChips();

    ui.root.innerHTML = '';
    if (!products.length) {
      renderEmpty(ui.root, 'No courses are available yet. Check back soon.');
      return;
    }
    if (!results.length) {
      const reset = el('button', { class: 'btn btn--outline', text: 'Clear filters', attrs: { type: 'button' } });
      reset.addEventListener('click', () => {
        state.type = ''; state.subjects = []; state.q = '';
        const navQ = document.getElementById('nav-q');
        if (navQ) navQ.value = '';
        rerender();
      });
      ui.root.appendChild(el('div', {
        class: 'state-box',
        children: [
          el('h2', { text: 'Sorry, we couldn’t find any results', attrs: { style: 'font-size:var(--fs-lg);margin:0' } }),
          el('p',  { class: 'state-message', text: 'Try adjusting your search or filters — or browse everything we have.' }),
          reset,
        ],
      }));
      return;
    }

    const list = el('div', { class: 'result-list' });
    for (const p of results) list.appendChild(buildListCard(p));
    ui.root.appendChild(list);
  }

  await load();
}
