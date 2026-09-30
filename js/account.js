/* js/account.js — My Account page.
 *
 * Gated: requireSession() redirects to login.html if no session exists.
 * Shows: profile settings (display_name, gcash_number) + referral link.
 * All DOM mutations via el() / textContent — no innerHTML.
 */

import { requireSession, initNav, signOut } from './auth.js';
import { api }                               from './api.js';
import { buildRefLink }                      from './referral.js';
import { el, $ }                             from './dom.js';
import { renderLoading, renderError, toast } from './states.js';

const root = () => $('#account-root');

async function init() {
  // initNav renders the top bar account chip and captures referral codes.
  initNav();

  const container = root();
  renderLoading(container, 'Loading your account…');

  // requireSession redirects to login.html if no session — throws to abort.
  let user;
  try { user = await requireSession(); }
  catch { return; }

  let profile;
  try {
    profile = await api.getProfile();
  } catch (err) {
    renderError(container, err.message ?? 'Could not load your profile.', init);
    return;
  }

  render(user, profile);
}

function render(user, profile) {
  const container = root();
  container.innerHTML = '';

  // ── Page header ──────────────────────────────────────────────────────────
  const header = el('div', { class: 'section-head', attrs: { style: 'margin-bottom:1.5rem' } });
  const titleBlock = el('div');
  titleBlock.appendChild(
    el('h1', { class: 'mb-0', text: profile.display_name || user.email?.split('@')[0] || 'My Account' }),
  );
  titleBlock.appendChild(el('p', { class: 'muted mb-0', text: user.email }));
  header.appendChild(titleBlock);

  const signOutBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Sign out' });
  signOutBtn.addEventListener('click', signOut);
  header.appendChild(signOutBtn);
  container.appendChild(header);

  // ── Profile form ─────────────────────────────────────────────────────────
  const formCard = el('div', { class: 'card', attrs: { style: 'margin-bottom:1.5rem' } });
  formCard.appendChild(el('h2', { text: 'Profile settings' }));

  const form = el('form', { attrs: { novalidate: '' } });

  // Display name
  const nameField = el('div', { class: 'field' });
  nameField.appendChild(el('label', { text: 'Display name', attrs: { for: 'acc-name' } }));
  const nameInput = el('input', { attrs: {
    type: 'text', id: 'acc-name',
    value: profile.display_name ?? '',
    placeholder: 'Your name (shown in the nav)',
    autocomplete: 'name',
  }});
  nameField.appendChild(nameInput);
  form.appendChild(nameField);

  // GCash number
  const gcField = el('div', { class: 'field' });
  gcField.appendChild(el('label', { text: 'GCash number', attrs: { for: 'acc-gcash' } }));
  const gcInput = el('input', { attrs: {
    type: 'tel', id: 'acc-gcash',
    value: profile.gcash_number ?? '',
    placeholder: '09xxxxxxxxx',
    inputmode: 'tel',
    autocomplete: 'tel',
  }});
  gcField.appendChild(gcInput);
  gcField.appendChild(
    el('p', { class: 'hint', text: 'Required for referral cash payouts. Format: 09xxxxxxxxx or +63xxxxxxxxxx.' }),
  );
  form.appendChild(gcField);

  const saveBtn = el('button', { class: 'btn btn--primary', text: 'Save changes', attrs: { type: 'submit' } });
  form.appendChild(saveBtn);

  const formAlert = el('div');
  form.appendChild(formAlert);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formAlert.innerHTML = '';
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await api.updateProfile({
        display_name: nameInput.value.trim() || null,
        gcash_number: gcInput.value.trim() || null,
      });
      toast('Profile saved.');
    } catch (err) {
      formAlert.appendChild(
        el('div', { class: 'alert alert--error', text: err.message ?? 'Could not save profile.', attrs: { role: 'alert' } }),
      );
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save changes';
    }
  });

  formCard.appendChild(form);
  container.appendChild(formCard);

  // ── Referral link ─────────────────────────────────────────────────────────
  const refCard = el('div', { class: 'card', attrs: { style: 'margin-bottom:1.5rem' } });
  refCard.appendChild(el('p', { class: 'eyebrow', text: 'Refer & earn' }));
  refCard.appendChild(el('h2', { text: 'Your referral link' }));
  refCard.appendChild(
    el('p', { class: 'desc', text: 'Share this link. When a friend buys, you earn a ₱9 reward — cash out via GCash when you reach ₱100.' }),
  );

  const refLink = buildRefLink(profile.ref_code);

  const linkField = el('div', { class: 'field' });
  const linkInput = el('input', { attrs: {
    type: 'text', readonly: '', value: refLink, 'aria-label': 'Your personal referral link',
  }});
  linkField.appendChild(linkInput);
  refCard.appendChild(linkField);

  const copyBtn = el('button', { class: 'btn btn--secondary', text: 'Copy link' });
  copyBtn.addEventListener('click', () => {
    linkInput.select();
    navigator.clipboard?.writeText(refLink).catch(() => {});
    toast('Referral link copied!');
  });
  refCard.appendChild(copyBtn);

  refCard.appendChild(
    el('p', { class: 'muted', attrs: { style: 'margin-top:.5rem;margin-bottom:0;font-size:var(--fs-xs)' },
      text: `Your code: ${profile.ref_code}` }),
  );
  container.appendChild(refCard);

  // ── Quick navigation links ────────────────────────────────────────────────
  const linksCard = el('div', { class: 'card' });
  linksCard.appendChild(el('h2', { text: 'Quick links' }));
  const ul = el('ul', { attrs: { style: 'list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.5rem' }});
  [
    { href: '/my-learning.html', text: '📚 My Learning — access your quizzes and materials' },
    { href: '/earnings.html',    text: '💰 Earnings — track and cash out your referral rewards' },
  ].forEach(({ href, text }) => {
    ul.appendChild(el('li', { children: [el('a', { text, attrs: { href } })] }));
  });
  linksCard.appendChild(ul);
  container.appendChild(linksCard);
}

init();
