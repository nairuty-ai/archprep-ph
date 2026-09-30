/* js/enrolled.js — post-payment confirmation polling page.
 *
 * Reads ?order_id= from the URL. Polls every 2 seconds for up to 30 seconds.
 * On success (paid + enrolled): shows success state with My Learning link.
 * On timeout: shows pending state with "check My Learning" fallback.
 */

import { requireSession } from './auth.js';
import { api }            from './api.js';
import { el, $ }          from './dom.js';

const MAX_ATTEMPTS  = 15;
const POLL_INTERVAL = 2000; // ms

export async function initEnrolled(container) {
  if (!container) return;

  let user;
  try { user = await requireSession(); }
  catch { return; }

  const params  = new URLSearchParams(location.search);
  const orderId = params.get('order_id') || params.get('order');

  if (!orderId) {
    renderSuccess(container);
    return;
  }

  renderPolling(container);
  poll(container, orderId, 0);
}

function renderPolling(container) {
  container.innerHTML = '';
  const spinner = el('div', { attrs: { style: 'display:flex;flex-direction:column;align-items:center;gap:1rem' } });
  spinner.appendChild(el('div', { class: 'spinner', attrs: { style: 'width:48px;height:48px;border-width:4px' } }));
  spinner.appendChild(el('h2', { text: 'Confirming your payment…' }));
  spinner.appendChild(el('p', { class: 'muted', text: 'Please wait — this usually takes just a few seconds.' }));
  container.appendChild(spinner);
}

function renderSuccess(container) {
  container.innerHTML = '';
  container.appendChild(el('div', { attrs: { style: 'font-size:3rem;margin-bottom:1rem' }, text: '🎉' }));
  container.appendChild(el('h1', { text: 'You\'re enrolled!' }));
  container.appendChild(el('p', { class: 'lead', text: 'Your payment was confirmed. Your purchase is now in My Learning — open it any time on any device.' }));

  const cta = el('a', { class: 'btn btn--primary btn--lg', text: '📚 Go to My Learning', attrs: { href: '/my-learning.html' } });
  container.appendChild(cta);

  // Referral share
  container.appendChild(el('hr', { attrs: { style: 'margin:2rem 0;border:none;border-top:1px solid var(--border-soft)' } }));
  container.appendChild(el('p', { class: 'muted', text: 'Know someone else studying for the ALE? Share your referral link and earn ₱9 when they buy.' }));
  container.appendChild(
    el('a', { class: 'btn btn--outline', text: '🔗 Get my referral link', attrs: { href: '/earnings.html' } }),
  );
}

function renderPending(container) {
  container.innerHTML = '';
  container.appendChild(el('div', { attrs: { style: 'font-size:3rem;margin-bottom:1rem' }, text: '⏳' }));
  container.appendChild(el('h2', { text: 'Payment received — processing…' }));
  container.appendChild(el('p', { text: 'Your payment was received. It may take a few minutes to confirm. Check My Learning — your item will appear there once it\'s ready.' }));
  container.appendChild(
    el('a', { class: 'btn btn--primary btn--lg', text: '📚 Go to My Learning', attrs: { href: '/my-learning.html' } }),
  );
}

async function poll(container, orderId, attempt) {
  if (attempt >= MAX_ATTEMPTS) {
    renderPending(container);
    return;
  }

  try {
    const { order, enrollment } = await api.pollOrderStatus(orderId);
    if (order?.status === 'paid' && enrollment) {
      renderSuccess(container);
      return;
    }
    if (order?.status === 'failed') {
      container.innerHTML = '';
      container.appendChild(el('div', { attrs: { style: 'font-size:3rem;margin-bottom:1rem' }, text: '❌' }));
      container.appendChild(el('h2', { text: 'Payment failed' }));
      container.appendChild(el('p', { text: 'Something went wrong with your payment. Please try again from the catalog.' }));
      container.appendChild(el('a', { class: 'btn btn--outline', text: '← Back to catalog', attrs: { href: '/catalog.html' } }));
      return;
    }
  } catch { /* keep polling */ }

  setTimeout(() => poll(container, orderId, attempt + 1), POLL_INTERVAL);
}
