/* ALE cheat sheet (/ale-guide/cheat-sheet). Rendered by the Worker with the
 * ?f= filter already applied; this makes the chips live, keeps the filter in
 * the URL so it can be shared, and wires the print button. */

import { $, $$ } from '../core.js';
import { mountShell } from '../shell.js';

mountShell({});

const FILTERS = ['all', 'A', 'B', 'C', 'X'];
const chips = $$('[data-f]');
const cards = $$('.cs-card');
const tail = $('[data-tail]');
const count = $('[data-cs-count]');

function apply(f, updateUrl) {
  if (!FILTERS.includes(f)) f = 'all';
  let shown = 0;
  let facts = 0;
  for (const card of cards) {
    const on = f === 'all' || card.dataset.tag === f;
    card.hidden = !on;
    if (on) { shown += 1; facts += Number(card.dataset.facts) || 0; }
  }
  for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.f === f));
  if (tail) tail.hidden = !(f === 'all' || f === 'X');
  if (count) count.textContent = `${shown} card${shown === 1 ? '' : 's'} · ${facts} fact${facts === 1 ? '' : 's'}`;
  if (updateUrl) {
    const url = new URL(location.href);
    if (f === 'all') url.searchParams.delete('f');
    else url.searchParams.set('f', f);
    history.replaceState(null, '', url);
  }
}

for (const chip of chips) chip.addEventListener('click', () => apply(chip.dataset.f, true));
$('[data-print]')?.addEventListener('click', () => print());

// The server already applied ?f=; this only matters for a cached copy.
apply(new URLSearchParams(location.search).get('f') || 'all', false);
