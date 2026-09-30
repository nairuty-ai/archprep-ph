/* js/my-learning.js — My Learning page logic.
 *
 * Fetches the user's enrollments, fetches corresponding products,
 * then renders Materials and Quiz sections.
 */

import { requireSession } from './auth.js';
import { api } from './api.js';
import { el, setText } from './dom.js';
import { renderLoading, renderEmpty, renderError, toast } from './states.js';

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

  if (materials.length > 0) {
    container.appendChild(_buildSection('Materials', materials, _buildMaterialItem));
  }
  if (quizzes.length > 0) {
    container.appendChild(_buildSection('Quizzes', quizzes, _buildQuizItem));
  }
}

// ---------------------------------------------------------------------------
// Section builder
// ---------------------------------------------------------------------------
function _buildSection(title, items, itemBuilder) {
  const section = el('section', { class: 'subject-group' });
  const heading = el('h2', { text: title });
  section.appendChild(heading);

  const grid = el('div', { class: 'grid grid--3' });
  for (const item of items) {
    grid.appendChild(itemBuilder(item));
  }
  section.appendChild(grid);
  return section;
}

// ---------------------------------------------------------------------------
// Material item card
// ---------------------------------------------------------------------------
function _buildMaterialItem({ enrollment, product }) {
  const card = el('article', { class: 'card' });

  const badge = el('span', { class: 'subject-tag', text: product.subject || 'Material' });
  const title = el('h3', { text: product.title });

  if (product.subtitle) {
    const sub = el('p', { class: 'desc', text: product.subtitle });
    card.appendChild(badge);
    card.appendChild(title);
    card.appendChild(sub);
  } else {
    card.appendChild(badge);
    card.appendChild(title);
  }

  const openBtn = el('button', {
    class: 'btn btn--primary btn--block',
    text: 'Open',
    attrs: {
      type: 'button',
      'aria-label': 'Open ' + product.title,
    },
  });

  const errMsg = el('p', {});
  errMsg.style.cssText = 'color:var(--error);font-size:var(--fs-xs);font-weight:600;margin-top:.35rem;';

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
      setText(openBtn, 'Open');
    }
  });

  const foot = el('div', { class: 'card-foot', children: [openBtn, errMsg] });
  card.appendChild(foot);
  return card;
}

// ---------------------------------------------------------------------------
// Quiz item card
// ---------------------------------------------------------------------------
function _buildQuizItem({ enrollment, product }) {
  const card = el('article', { class: 'card' });

  const badge = el('span', { class: 'subject-tag', text: product.subject || 'Quiz' });
  const title = el('h3', { text: product.title });

  if (product.subtitle) {
    card.appendChild(badge);
    card.appendChild(title);
    card.appendChild(el('p', { class: 'desc', text: product.subtitle }));
  } else {
    card.appendChild(badge);
    card.appendChild(title);
  }

  const href = '/quiz.html?product_id=' + encodeURIComponent(enrollment.product_id);
  const quizLink = el('a', {
    class: 'btn btn--primary btn--block',
    text: 'Take quiz',
    attrs: {
      href,
      'aria-label': 'Take quiz for ' + product.title,
    },
  });

  const foot = el('div', { class: 'card-foot', children: [quizLink] });
  card.appendChild(foot);
  return card;
}
