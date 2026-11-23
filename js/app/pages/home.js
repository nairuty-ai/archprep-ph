/* Home: exam-date chip, subject cards, course grid, plan prices. */

import { el, $, peso, formatDate, getCatalog, SUBJECTS, TYPE_LABEL } from '../core.js';
import { mountShell } from '../shell.js';
import { courseCard } from '../ui.js';

const DEFAULT_PRICE = { material: 49, quiz: 19, mock: 49, free: 0 };

const { settings } = await mountShell({ active: 'home' });

if (settings.exam_date) {
  $('#exam-chip').textContent =
    'Next ALE: ' + formatDate(settings.exam_date + 'T12:00:00+08:00', { month: 'short', year: 'numeric' });
}

let products = [];
try {
  products = await getCatalog();
} catch {
  // The grid shows its empty state below; the rest of the page is static.
}

const minPrice = (type) => {
  const prices = products.filter((p) => p.type === type).map((p) => p.price_php);
  return prices.length ? Math.min(...prices) : DEFAULT_PRICE[type];
};

const paid = products.filter((p) => p.type !== 'free').map((p) => p.price_php);
if (paid.length) $('#from-price').textContent = 'from ' + peso(Math.min(...paid));

const free = products.find((p) => p.type === 'free');
if (free) $('#free-cta').href = `product.html?slug=${encodeURIComponent(free.slug)}`;

$('#subject-grid').replaceChildren(...SUBJECTS.map((s) => el('a', {
  class: 'card subject-card', href: `catalog.html?subject=${s.code}`,
},
  el('div', { class: 'row', style: 'justify-content:space-between' },
    el('span', { class: 'eyebrow', text: `Subject ${s.code}` }),
    el('span', { class: 'small muted', text: `Reviewer ${peso(minPrice('material'))} · Quiz ${peso(minPrice('quiz'))}` })),
  el('div', { style: 'font-weight:700;font-size:19px;line-height:1.3', text: s.name }),
  el('div', { class: 'small muted', style: 'font-size:14px', text: s.topics }))));

const grid = $('#course-grid');
grid.removeAttribute('aria-busy');
if (products.length) {
  grid.replaceChildren(...products.slice(0, 4).map((p) => courseCard(p, settings)));
} else {
  grid.replaceChildren(el('p', { class: 'muted', text: 'Courses are being prepared. Check back soon.' }));
}

const plans = [
  ['Free', peso(0), 'A 25-item diagnostic and sample questions per subject.', 'Unlimited', false],
  [TYPE_LABEL.material, peso(minPrice('material')), 'Full reviewer for one subject in the online viewer.', 'Per subject · until next ALE', false],
  [TYPE_LABEL.quiz, peso(minPrice('quiz')), 'Board-type questions for one subject, with explanations.', 'Per subject · 2 attempts', false],
  [TYPE_LABEL.mock, peso(minPrice('mock')), 'All subjects in one timed board, with leaderboard.', '2 attempts', true],
];
$('#plan-grid').replaceChildren(...plans.map(([name, price, desc, access, featured]) =>
  el('div', { class: 'card plan' + (featured ? ' plan--featured' : '') },
    el('div', { class: 'name', text: name }),
    el('div', { class: 'price', text: price === 'Free' ? '₱0' : price }),
    el('div', { class: 'desc', text: desc }),
    el('div', { class: 'access', text: access }))));
