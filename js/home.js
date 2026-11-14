/* js/home.js — homepage sections that depend on the live catalog.
 *
 *   #category-carousel   subject cards with illustrations
 *   #featured-carousel   all courses, carousel
 *   #subject-tabs/panel  tabbed course carousels by subject (or by type)
 *   #starting-price      cheapest course price in the dark feature band
 */

import { api }                                         from './api.js';
import { el, $, peso }                                 from './dom.js';
import { renderError, renderEmpty }                    from './states.js';
import { buildCourseCard, toneFor, renderSkeletonCards } from './catalog.js';
import { buildCarousel }                               from './carousel.js';
import { icon, illustration, illustrationFor }         from './icons.js';

export async function initHome() {
  const catEl    = $('#category-carousel');
  const featEl   = $('#featured-carousel');
  const tabsEl   = $('#subject-tabs');
  const panelEl  = $('#subject-panel');

  if (featEl)  renderSkeletonCards(featEl, 4);
  if (panelEl) renderSkeletonCards(panelEl, 4);

  applySettings();

  let products;
  try {
    products = await api.getCatalog();
  } catch (err) {
    if (featEl) renderError(featEl, err.message || 'Could not load courses.', () => initHome());
    if (panelEl) panelEl.innerHTML = '';
    if (catEl) renderCategories(catEl, []);
    return;
  }

  if (catEl) renderCategories(catEl, products);
  if (featEl) renderFeatured(featEl, products);
  if (tabsEl && panelEl) renderSubjectTabs(tabsEl, panelEl, products);
  renderStartingPrice(products);
}

// ---------------------------------------------------------------------------
// Admin-editable hero copy (settings table)
// ---------------------------------------------------------------------------
async function applySettings() {
  try {
    const s = await api.getSettings();
    const h = $('#hero-headline');
    const p = $('#hero-subhead');
    if (h && typeof s.hero_headline === 'string' && s.hero_headline.trim()) h.textContent = s.hero_headline;
    if (p && typeof s.hero_subhead === 'string' && s.hero_subhead.trim()) p.textContent = s.hero_subhead;
  } catch {
    // Keep the default copy.
  }
}

// ---------------------------------------------------------------------------
// Category carousel
// ---------------------------------------------------------------------------
function countLabel(n) {
  if (!n) return 'Browse';
  return n === 1 ? '1 course' : n + ' courses';
}

function categoryList(products) {
  const bySubject = new Map();
  for (const p of products) {
    const key = p.subject || 'General';
    bySubject.set(key, (bySubject.get(key) || 0) + 1);
  }

  const cats = [...bySubject.entries()].map(([name, count]) => ({
    name,
    count,
    href: '/catalog.html?subject=' + encodeURIComponent(name),
    tone: toneFor(name),
    art:  illustrationFor(name, toneFor(name)),
  }));

  // Pad with type-level categories so the row never looks empty.
  if (cats.length < 3) {
    const quizzes   = products.filter((p) => p.type === 'quiz_pack').length;
    const materials = products.filter((p) => p.type !== 'quiz_pack').length;
    cats.push(
      { name: 'Practice quizzes', count: quizzes,   href: '/catalog.html?type=quiz_pack', tone: 4, art: 'quiz' },
      { name: 'Review materials', count: materials, href: '/catalog.html?type=material',  tone: 1, art: 'document' },
    );
    if (cats.length < 3) {
      cats.push({ name: 'All ALE courses', count: products.length, href: '/catalog.html', tone: 0, art: 'blueprint' });
    }
  }
  return cats;
}

function renderCategories(container, products) {
  container.innerHTML = '';
  const cards = categoryList(products).map((c) => el('a', {
    class: `cat-card tone-${c.tone}`,
    attrs: { href: c.href },
    children: [
      el('div', { class: 'cat-art', children: [illustration(c.art)] }),
      el('div', {
        class: 'cat-label',
        children: [
          el('strong', { text: c.name }),
          el('span', {
            class: 'cat-foot',
            children: [el('span', { text: countLabel(c.count) }), icon('arrowRight', 18)],
          }),
        ],
      }),
    ],
  }));
  container.appendChild(buildCarousel(cards, { label: 'Course categories', dots: true, variant: 'cats' }));
}

// ---------------------------------------------------------------------------
// Featured carousel
// ---------------------------------------------------------------------------
function renderFeatured(container, products) {
  container.innerHTML = '';
  if (!products.length) {
    renderEmpty(container, 'New courses are on the way. Check back soon.');
    return;
  }
  const cards = products.slice(0, 12).map(buildCourseCard);
  container.appendChild(buildCarousel(cards, { label: 'Featured courses' }));
}

// ---------------------------------------------------------------------------
// Subject tabs
// ---------------------------------------------------------------------------
function renderSubjectTabs(tabsEl, panelEl, products) {
  tabsEl.innerHTML = '';
  panelEl.innerHTML = '';

  if (!products.length) {
    tabsEl.closest('section')?.setAttribute('hidden', '');
    return;
  }

  // Tabs by subject when there are several; otherwise by product type.
  const subjects = [...new Set(products.map((p) => p.subject || 'General'))];
  let tabs;
  if (subjects.length >= 2) {
    tabs = subjects.map((s) => ({
      label: s,
      items: products.filter((p) => (p.subject || 'General') === s),
      href:  '/catalog.html?subject=' + encodeURIComponent(s),
    }));
  } else {
    tabs = [
      { label: 'Review materials', items: products.filter((p) => p.type !== 'quiz_pack'), href: '/catalog.html?type=material' },
      { label: 'Practice quizzes', items: products.filter((p) => p.type === 'quiz_pack'),  href: '/catalog.html?type=quiz_pack' },
    ].filter((t) => t.items.length);
  }

  if (!tabs.length) {
    tabsEl.closest('section')?.setAttribute('hidden', '');
    return;
  }

  const buttons = tabs.map((t, i) => {
    const b = el('button', {
      class: 'tab',
      text:  t.label,
      attrs: { type: 'button', role: 'tab', 'aria-selected': String(i === 0), id: 'subject-tab-' + i, 'aria-controls': 'subject-panel' },
    });
    b.addEventListener('click', () => select(i));
    return b;
  });
  for (const b of buttons) tabsEl.appendChild(b);

  function select(i) {
    buttons.forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
    panelEl.setAttribute('aria-labelledby', 'subject-tab-' + i);
    panelEl.innerHTML = '';
    const t = tabs[i];
    panelEl.appendChild(buildCarousel(t.items.map(buildCourseCard), { label: t.label + ' courses' }));
    panelEl.appendChild(el('p', {
      attrs: { style: 'margin:1.25rem 0 0' },
      children: [el('a', {
        class: 'text-link',
        attrs: { href: t.href },
        children: [document.createTextNode(`Show all ${t.label} courses`), icon('arrowRight', 16)],
      })],
    }));
  }

  select(0);
}

// ---------------------------------------------------------------------------
// Starting price
// ---------------------------------------------------------------------------
function renderStartingPrice(products) {
  const target = $('#starting-price');
  if (!target) return;
  const prices = products.map((p) => Number(p.price_php)).filter((n) => Number.isFinite(n) && n > 0);
  if (!prices.length) {
    target.closest('small')?.setAttribute('hidden', '');
    return;
  }
  target.textContent = peso(Math.min(...prices));
}
