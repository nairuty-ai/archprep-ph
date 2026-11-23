/* Catalog: type chips, subject/price/access filters, search, owned tags. */

import { $, $$, getCatalog, getOwned, param } from '../core.js';
import { mountShell } from '../shell.js';
import { courseRow, stateCard, skeletonRows } from '../ui.js';

const list = $('#course-list');
list.replaceChildren(...skeletonRows(4));

const { user, settings } = await mountShell({ active: 'catalog' });

const state = {
  type: ['material', 'quiz', 'mock', 'free'].includes(param('type')) ? param('type') : 'all',
  q: (param('q') || '').trim().toLowerCase(),
};
const subjectParam = param('subject');
if (subjectParam === 'A' || subjectParam === 'B') {
  for (const box of $$('input[name="subject"]')) box.checked = box.value === subjectParam;
}

let products = [];
let owned = {};

async function load() {
  try {
    [products, owned] = await Promise.all([getCatalog(), user ? getOwned() : {}]);
    render();
  } catch (err) {
    $('#result-count').textContent = '';
    list.removeAttribute('aria-busy');
    list.replaceChildren(stateCard({
      icon: '⚠', tone: 'warn', title: 'We couldn’t load this page',
      body: 'Check your connection and try again.', cta: 'Try again', onCta: load,
    }));
  }
}

function checked(name) {
  return $$(`input[name="${name}"]:checked`).map((i) => i.value);
}

function render() {
  for (const chip of $$('#type-chips .chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.type === state.type));
  }
  const subjects = checked('subject');
  const prices = checked('price');
  const access = checked('access');

  const shown = products.filter((p) => {
    if (state.type !== 'all' && p.type !== state.type) return false;
    // A combined (ALL) course belongs to every subject.
    if (p.subject !== 'ALL' && !subjects.includes(p.subject)) return false;
    if (prices.length && !prices.includes(p.price_php === 0 ? 'free' : 'paid')) return false;
    if (access.length && !access.includes(p.access_mode)) return false;
    if (state.q) {
      const hay = `${p.title} ${p.subtitle ?? ''} ${p.description ?? ''}`.toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    return true;
  });

  list.removeAttribute('aria-busy');
  const scope = state.q ? ` for “${state.q}”` : '';
  $('#result-count').textContent =
    `${shown.length} result${shown.length === 1 ? '' : 's'}${scope} · Subjects A & B · access length shown on each course`;

  if (!shown.length) {
    list.replaceChildren(stateCard({
      icon: '?', title: products.length ? 'No courses match these filters' : 'Courses are being prepared',
      body: products.length ? 'Try another type or clear a filter.' : 'Check back soon.',
      cta: products.length ? 'Show all courses' : null, ctaHref: 'catalog.html',
    }));
    return;
  }
  list.replaceChildren(...shown.map((p) => courseRow(p, settings, owned[p.id])));
}

$('#type-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.type = chip.dataset.type;
  const url = new URL(location.href);
  if (state.type === 'all') url.searchParams.delete('type'); else url.searchParams.set('type', state.type);
  history.replaceState(null, '', url);
  render();
});
$('#filters').addEventListener('change', render);
$('.filters-toggle').addEventListener('click', (e) => {
  const open = $('#filters').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

await load();
