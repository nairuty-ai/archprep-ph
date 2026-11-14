/* js/my-learning.js — My Learning page logic.
 *
 * Fetches the user's enrollments, fetches corresponding products,
 * then renders Materials and Quiz sections.
 */

import { requireSession } from './auth.js';
import { api } from './api.js';
import { el, setText } from './dom.js';
import { renderLoading, renderEmpty, renderError, toast } from './states.js';
import { buildThumb, typeLabel } from './catalog.js';

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------
export async function initMyLearning(container) {
  let user;
  try {
    user = await requireSession();
  } catch {
    return; // requireSession redirects to login
  }

  renderLoading(container, 'Loading your library…');

  let enrollments, products;
  try {
    enrollments = await api.getEnrollments();
  } catch (err) {
    renderError(container, err.message || 'Could not load your library.', () => initMyLearning(container));
    return;
  }

  if (!enrollments.length) {
    renderEmpty(container, "You haven't enrolled in anything yet. Browse the catalog.", 'Browse catalog', '/catalog.html');
    return;
  }

  // Fetch product details for each enrollment
  const productIds = [...new Set(enrollments.map((e) => e.product_id))];
  const productMap = new Map();
  try {
    // Fetch each product individually (catalog endpoint returns all, which is fine for small sets)
    const allProducts = await api.getCatalog();
    for (const p of allProducts) {
      productMap.set(p.id, p);
    }
  } catch (err) {
    renderError(container, err.message || 'Could not load product details.', () => initMyLearning(container));
    return;
  }

  const materials = [];
  const quizzes   = [];

  for (const enrollment of enrollments) {
    const product = productMap.get(enrollment.product_id);
    if (!product) continue;
    if (product.type === 'quiz_pack') {
      quizzes.push({ enrollment, product });
    } else {
      materials.push({ enrollment, product });
    }
  }


  container.innerHTML = '';

  if (!materials.length && !quizzes.length) {
    renderEmpty(container, "You haven't enrolled in anything yet. Browse the catalog.", 'Browse catalog', '/catalog.html');
    return;
  }

  const grid = el('div', { class: 'learning-grid' });
  for (const item of materials) grid.appendChild(_buildMaterialItem(item));
  for (const item of quizzes)   grid.appendChild(_buildQuizItem(item));

  const emptyFilter = el('div', {
    class: 'state-box',
    attrs: { hidden: '' },
    children: [
      el('p', { class: 'state-message', text: 'Nothing here yet.' }),
      el('a', { class: 'btn btn--primary', text: 'Browse catalog', attrs: { href: '/catalog.html' } }),
    ],
  });

  container.appendChild(grid);
  container.appendChild(emptyFilter);

  _wireTabs(grid, emptyFilter, { all: materials.length + quizzes.length, material: materials.length, quiz_pack: quizzes.length });
}

// ---------------------------------------------------------------------------
// Tabs in the page header (All / Review materials / Practice quizzes)
// ---------------------------------------------------------------------------
function _wireTabs(grid, emptyFilter, counts) {
  const tabs = Array.from(document.querySelectorAll('[data-learning-tab]'));
  if (!tabs.length) return;

  const labels = { all: 'All courses', material: 'Review materials', quiz_pack: 'Practice quizzes' };
  for (const tab of tabs) {
    const key = tab.dataset.learningTab;
    setText(tab, `${labels[key] || key} (${counts[key] ?? 0})`);
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      let shown = 0;
      for (const card of grid.children) {
        const visible = key === 'all' || card.dataset.type === key;
        card.hidden = !visible;
        if (visible) shown++;
      }
      emptyFilter.hidden = shown > 0;
    });
  }
}

// ---------------------------------------------------------------------------
// Card shell shared by materials and quizzes
// ---------------------------------------------------------------------------
function _cardShell(product, type, actionEls) {
  const body = el('div', {
    class: 'course-body',
    children: [
      el('h3', { class: 'course-title', text: product.title || '' }),
      el('p', { class: 'course-author', text: product.subject ? 'ArchPrep PH · ' + product.subject : 'ArchPrep PH' }),
      el('div', {
        class: 'course-meta',
        children: [el('span', {
          class: type === 'quiz_pack' ? 'course-badge course-badge--quiz' : 'course-badge',
          text:  typeLabel(type),
        })],
      }),
      el('div', { class: 'course-foot', children: actionEls }),
    ],
  });
  return el('article', {
    class: 'learn-card',
    data: { type },
    children: [buildThumb(product), body],
  });
}

// ---------------------------------------------------------------------------
// Material item card
// ---------------------------------------------------------------------------
function _buildMaterialItem({ product }) {
  const openBtn = el('button', {
    class: 'btn btn--primary btn--block',
    text: 'Open material',
    attrs: { type: 'button', 'aria-label': 'Open ' + product.title },
  });
  const errMsg = el('p', { class: 'learn-card-error', attrs: { role: 'alert' } });

  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true;
    setText(openBtn, 'Getting link…');
    errMsg.textContent = '';
    try {
      const { signed_url } = await api.getMaterialUrl(product.id);
      window.open(signed_url, '_blank', 'noopener');
    } catch (err) {
      errMsg.textContent = err.message || 'Could not open this material. Please try again.';
    } finally {
      openBtn.disabled = false;
      setText(openBtn, 'Open material');
    }
  });

  return _cardShell(product, 'material', [openBtn, errMsg]);
}

// ---------------------------------------------------------------------------
// Quiz item card
// ---------------------------------------------------------------------------
function _buildQuizItem({ enrollment, product }) {
  const quizLink = el('a', {
    class: 'btn btn--primary btn--block',
    text: 'Start quiz',
    attrs: {
      href: '/quiz.html?product_id=' + encodeURIComponent(enrollment.product_id),
      'aria-label': 'Start quiz for ' + product.title,
    },
  });
  return _cardShell(product, 'quiz_pack', [quizLink]);
}
