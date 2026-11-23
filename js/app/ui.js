/* js/app/ui.js — shared student-site components. */

import { el, peso, accessLine, thumb, TYPE_LABEL, SUBJECT_LABEL } from './core.js';

export function productHref(p) {
  return `product.html?slug=${encodeURIComponent(p.slug)}`;
}

/** Grid card (home). */
export function courseCard(p, settings, owned = null) {
  return el('a', { class: 'course-card', href: productHref(p) },
    thumb(p),
    el('div', { class: 'title', text: p.title }),
    el('div', { class: 'small muted', text: `${TYPE_LABEL[p.type]} · ${SUBJECT_LABEL[p.subject]}` }),
    el('div', { class: 'small muted', text: accessLine(p, settings) }),
    el('div', { class: 'row gap-8', style: 'align-items:baseline' },
      el('span', { style: 'font-weight:800;font-size:18px', text: owned ? '✓ Owned' : peso(p.price_php) })));
}

/** List row (catalog). */
export function courseRow(p, settings, owned = null) {
  const tag = owned
    ? el('span', { class: 'tag tag--owned', text: '✓ Owned' })
    : el('span', { class: p.type === 'free' ? 'tag tag--info' : 'tag', text: TYPE_LABEL[p.type] });
  return el('a', { class: 'course-row', href: productHref(p) },
    thumb(p),
    el('div', { class: 'stack gap-6' },
      el('div', { class: 'title', text: p.title }),
      p.subtitle && el('div', { class: 'sub', style: 'font-size:14px;color:var(--text-2)', text: p.subtitle }),
      el('div', { class: 'small muted', text: `${SUBJECT_LABEL[p.subject]} · ${accessLine(p, settings)}` }),
      el('div', {}, tag)),
    el('div', { class: 'price', text: peso(p.price_php) }));
}

/** Empty / error state card (README screen 22). */
export function stateCard({ icon = '∅', tone = 'muted', where, title, body, cta, ctaHref, onCta, cta2, cta2Href }) {
  const tones = {
    muted: ['var(--surface-3)', 'var(--text-2)'],
    warn: ['var(--warn-bg)', 'var(--warn-text)'],
    info: ['var(--primary-soft)', 'var(--primary-soft-text)'],
    danger: ['var(--danger-bg)', 'var(--danger-text)'],
  }[tone];
  const primary = cta && (ctaHref
    ? el('a', { class: 'btn btn--primary btn--sm', href: ctaHref, text: cta })
    : el('button', { class: 'btn btn--primary btn--sm', attrs: { type: 'button' }, text: cta, on: { click: onCta } }));
  return el('div', { class: 'state', attrs: { role: tone === 'danger' ? 'alert' : null } },
    where && el('span', { class: 'eyebrow', style: 'color:var(--text-3)', text: where }),
    el('div', { class: 'icon', style: `background:${tones[0]};color:${tones[1]}`, text: icon, attrs: { 'aria-hidden': 'true' } }),
    el('h2', { text: title }),
    body && el('p', { text: body }),
    (primary || cta2) && el('div', { class: 'row gap-8 wrap-flex', style: 'margin-top:4px' },
      primary,
      cta2 && el('a', { class: 'btn btn--secondary btn--sm', href: cta2Href, text: cta2 })));
}

/** n grey rows while a list loads. */
export function skeletonRows(n, height = 96) {
  return Array.from({ length: n }, () =>
    el('div', { class: 'skeleton', style: `height:${height}px;margin:12px 0`, attrs: { 'aria-hidden': 'true' } }));
}
