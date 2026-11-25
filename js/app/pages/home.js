/* Home: exam-date chip, live prices, course grid, reviews.
 *
 * Subject cards, plans and the course-grid skeleton are static HTML in
 * index.html (launch-default prices), so loading the real data only swaps
 * text and cards in place and nothing on screen moves.
 */

import { el, $, $$, peso, formatDate, getCatalog } from '../core.js';
import { mountShell } from '../shell.js';
import { courseCard } from '../ui.js';
import { REVIEWS } from '../reviews.js';

const DEFAULT_PRICE = { material: 49, quiz: 19, mock: 49, free: 0 };

// ---------------------------------------------------------------------------
// Reviews strip (below the fold, so drawing it now moves nothing on screen)
// ---------------------------------------------------------------------------
function stars(rating) {
  return el('span', { class: 'row gap-6' },
    el('span', { class: 'rating', text: '★★★★★', attrs: { role: 'img', 'aria-label': `${rating} out of 5 stars` } },
      el('span', { text: '★★★★★', style: `width:${(rating / 5) * 100}%`, attrs: { 'aria-hidden': 'true' } })),
    el('span', { class: 'rating-num', text: rating.toFixed(1), attrs: { 'aria-hidden': 'true' } }));
}

function reviewCard(r, hidden) {
  return el('figure', { class: 'card quote', attrs: { 'aria-hidden': hidden ? 'true' : null } },
    stars(r.rating),
    el('blockquote', { style: 'margin:0' }, el('p', { text: `“${r.quote}”` })),
    el('figcaption', { class: 'mono', style: 'margin-top:auto;font-weight:600;font-size:14px', text: r.user }));
}

// The second copy makes the loop seamless; screen readers get the list once.
// About 6.5s per review keeps the same reading speed however long the list.
$('#reviews').replaceChildren(el('div', { class: 'marquee-track', style: `animation-duration:${REVIEWS.length * 6.5}s` },
  ...REVIEWS.map((r) => reviewCard(r, false)),
  ...REVIEWS.map((r) => reviewCard(r, true))));

// ---------------------------------------------------------------------------
// Live data
// ---------------------------------------------------------------------------
const { settings } = await mountShell({ active: 'home' });

// ALE guide teaser: only while the content pages are switched on.
$('#exam-block').hidden = String(settings.content_pages_enabled || '').trim().toLowerCase() !== 'on';

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
for (const span of $$('[data-price]')) span.textContent = peso(minPrice(span.dataset.price));

const paid = products.filter((p) => p.type !== 'free').map((p) => p.price_php);
if (paid.length) $('#from-price').textContent = 'from ' + peso(Math.min(...paid));

const free = products.find((p) => p.type === 'free');
if (free) $('#free-cta').href = `product.html?slug=${encodeURIComponent(free.slug)}`;

const grid = $('#course-grid');
grid.removeAttribute('aria-busy');
grid.classList.add('fade-in');
if (products.length) {
  grid.replaceChildren(...products.slice(0, 4).map((p) => courseCard(p, settings)));
} else {
  grid.replaceChildren(el('p', { class: 'muted', text: 'Courses are being prepared. Check back soon.' }));
}
