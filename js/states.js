/* js/states.js — loading, empty, and error state renderers.
 *
 * Requirement 33: every view region shows exactly one state at a time.
 * Each function clears the region, then renders the new state.
 *
 * Usage:
 *   import { renderLoading, renderEmpty, renderError } from './states.js';
 *   renderLoading(container, 'Loading your library…');
 *   renderError(container, 'Could not load products', onRetry);
 *   renderEmpty(container, "You haven't enrolled in anything yet.", 'Browse catalog', '/catalog.html');
 */

import { el } from './dom.js';

/** Clear a container and render a centred loading spinner. */
export function renderLoading(container, message = 'Loading…') {
  container.innerHTML = '';
  container.appendChild(
    el('div', {
      class: 'state-box state-loading',
      children: [
        el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }),
        el('p',    { class: 'state-message', text: message }),
      ],
    }),
  );
}

/** Clear a container and render an empty-state message with an optional CTA. */
export function renderEmpty(container, message, ctaLabel = null, ctaHref = null) {
  container.innerHTML = '';
  const children = [
    el('p', { class: 'state-icon', text: '📭' }),
    el('p', { class: 'state-message', text: message }),
  ];
  if (ctaLabel && ctaHref) {
    children.push(el('a', { class: 'btn btn--primary', text: ctaLabel, attrs: { href: ctaHref } }));
  }
  container.appendChild(el('div', { class: 'state-box state-empty', children }));
}

/**
 * Clear a container and render an error state with a retry button.
 *
 * @param {HTMLElement} container
 * @param {string} message
 * @param {(() => void) | null} [onRetry]
 */
export function renderError(container, message, onRetry = null) {
  container.innerHTML = '';
  const children = [
    el('p', { class: 'state-icon', text: '⚠️' }),
    el('p', { class: 'state-message', text: message }),
  ];
  if (typeof onRetry === 'function') {
    const btn = el('button', { class: 'btn btn--outline', text: 'Try again' });
    btn.addEventListener('click', onRetry);
    children.push(btn);
  }
  container.appendChild(el('div', { class: 'state-box state-error', children }));
}

/** Show a toast notification. Auto-dismisses after `duration` ms. */
export function toast(message, type = 'success', duration = 3500) {
  let tray = document.getElementById('toast-tray');
  if (!tray) {
    tray = el('div', { attrs: { id: 'toast-tray', role: 'status', 'aria-live': 'polite' } });
    tray.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;display:flex;flex-direction:column;gap:.5rem;z-index:9999;';
    document.body.appendChild(tray);
  }

  const item = el('div', {
    class: `toast toast--${type}`,
    text: message,
    attrs: { role: 'alert' },
  });
  tray.appendChild(item);

  setTimeout(() => {
    item.classList.add('toast--out');
    item.addEventListener('transitionend', () => item.remove(), { once: true });
    setTimeout(() => item.remove(), 400);
  }, duration);
}
