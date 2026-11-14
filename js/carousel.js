/* js/carousel.js — horizontal scroll carousel with arrow buttons and dots.
 *
 * Native scroll + scroll-snap does the heavy lifting (touch/trackpad work for
 * free); the buttons just scroll one "page" at a time.
 *
 * Usage:
 *   import { buildCarousel } from './carousel.js';
 *   container.appendChild(buildCarousel(cards, { label: 'Featured courses' }));
 */

import { el } from './dom.js';
import { icon } from './icons.js';

/**
 * @param {HTMLElement[]} items
 * @param {{ label?: string, dots?: boolean, variant?: string }} [opts]
 * @returns {HTMLElement}
 */
export function buildCarousel(items, opts = {}) {
  const { label = 'Carousel', dots = false, variant = '' } = opts;

  const track = el('div', {
    class: 'carousel-track',
    attrs: { role: 'region', 'aria-label': label, tabindex: '0' },
  });
  for (const item of items) track.appendChild(item);

  const prev = el('button', {
    class: 'icon-btn carousel-btn carousel-btn--prev',
    attrs: { type: 'button', 'aria-label': 'Previous', disabled: '' },
    children: [icon('chevronLeft', 22, 2.4)],
  });
  const next = el('button', {
    class: 'icon-btn carousel-btn carousel-btn--next',
    attrs: { type: 'button', 'aria-label': 'Next' },
    children: [icon('chevronRight', 22, 2.4)],
  });

  const root = el('div', {
    class: 'carousel' + (variant ? ' carousel--' + variant : ''),
    children: [prev, track, next],
  });

  let dotsWrap = null;
  if (dots) {
    dotsWrap = el('div', { class: 'carousel-dots', attrs: { 'aria-hidden': 'true' } });
    root.appendChild(dotsWrap);
  }

  const page = () => Math.max(track.clientWidth * 0.9, 200);

  prev.addEventListener('click', () => track.scrollBy({ left: -page(), behavior: 'smooth' }));
  next.addEventListener('click', () => track.scrollBy({ left:  page(), behavior: 'smooth' }));

  function pageCount() {
    if (!track.clientWidth) return 1;
    return Math.max(1, Math.ceil((track.scrollWidth - 4) / track.clientWidth));
  }

  function renderDots() {
    if (!dotsWrap) return;
    const count = pageCount();
    dotsWrap.hidden = count <= 1;
    if (dotsWrap.childElementCount !== count) {
      dotsWrap.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const dot = el('button', { class: 'carousel-dot', attrs: { type: 'button', tabindex: '-1' } });
        dot.addEventListener('click', () => {
          track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
        });
        dotsWrap.appendChild(dot);
      }
    }
    const max = track.scrollWidth - track.clientWidth;
    const ratio = max > 0 ? track.scrollLeft / max : 0;
    const active = Math.round(ratio * (count - 1));
    Array.from(dotsWrap.children).forEach((d, i) => {
      d.setAttribute('aria-current', String(i === active));
    });
  }

  function update() {
    const max = track.scrollWidth - track.clientWidth;
    if (track.scrollLeft <= 4) prev.setAttribute('disabled', '');
    else prev.removeAttribute('disabled');
    if (track.scrollLeft >= max - 4) next.setAttribute('disabled', '');
    else next.removeAttribute('disabled');
    renderDots();
  }

  let raf = 0;
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(update);
  }, { passive: true });

  if ('ResizeObserver' in window) {
    new ResizeObserver(() => update()).observe(track);
  } else {
    window.addEventListener('resize', update);
  }
  // First paint happens after the caller inserts the node.
  requestAnimationFrame(update);

  return root;
}
