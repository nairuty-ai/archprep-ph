/* js/app/shell.js — promo bar, header, footer and mobile tab bar for every
 * student page, plus the login guard.
 *
 * Page markup: <div id="site-header"></div> <main id="main">…</main>
 *              <div id="site-footer"></div>
 * Usage:       const ctx = await mountShell({ active: 'catalog' });
 *              ctx = { session, user, profile, settings }
 */

import { supabase, el, $, peso, getSettings, getProfile, getBalance } from './core.js';
import { captureRef } from '../referral.js';

/** The brand, in one place. */
export const BRAND = { name: 'ArkiPrep', suffix: 'PH' };

function logo(href = 'index.html') {
  return el('a', { class: 'logo', href, attrs: { 'aria-label': `${BRAND.name} home` } },
    el('span', { class: 'mark', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'word' }, BRAND.name, el('span', { text: BRAND.suffix })));
}

function initials(profile, user) {
  const name = (profile?.display_name || user?.email || '?').trim();
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function promoBar(settings) {
  const text = (settings.announcement_banner || '').trim();
  if (text) return el('div', { class: 'promo', attrs: { role: 'note' } }, el('span', { text }));
  const amount = settings.referral_amount || '9';
  const min = settings.payout_threshold || '100';
  return el('div', { class: 'promo', attrs: { role: 'note' } },
    el('strong', { text: 'Refer & earn:' }),
    el('span', { text: `₱${amount} for every friend who buys with your link · redeem once you reach ₱${min}` }));
}

function navLink(href, label, key, active) {
  return el('a', { href, text: label, attrs: { 'aria-current': key === active ? 'page' : null } });
}

function accountMenu(user, profile) {
  const list = el('ul', { class: 'menu-list', attrs: { hidden: true, role: 'menu' } },
    el('li', { class: 'who', text: user.email }),
    el('li', {}, el('a', { href: 'my-learning.html', text: 'My learning' })),
    el('li', {}, el('a', { href: 'earnings.html', text: 'Refer & earn' })),
    el('li', {}, el('a', { href: 'account.html', text: 'Account & orders' })),
    el('li', {}, el('button', { type: 'button', text: 'Log out', on: { click: logout } })));
  const btn = el('button', {
    class: 'avatar', text: initials(profile, user),
    attrs: { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'Account menu' },
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = list.hidden;
    list.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', () => { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.hidden = true; });
  return el('div', { class: 'menu' }, btn, list);
}

function header({ active, user, profile, balance, settings, query }) {
  const search = el('form', { class: 'search-pill', attrs: { role: 'search', action: 'catalog.html' } },
    el('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } }),
    el('label', { class: 'sr-only', text: 'Search courses', attrs: { for: 'site-search' } }),
    el('input', {
      attrs: {
        id: 'site-search', name: 'q', type: 'search', value: query || null,
        placeholder: 'Search reviewers, quiz packs, mock exams…', autocomplete: 'off',
      },
    }));

  const tabs = el('nav', { class: 'nav-tabs', attrs: { 'aria-label': 'Primary' } },
    navLink('catalog.html', 'Browse', 'catalog', active),
    user && navLink('my-learning.html', 'My learning', 'learning', active),
    user && navLink('earnings.html', 'Refer & earn', 'refer', active));

  const actions = user
    ? el('div', { class: 'header-actions' },
        el('a', { class: 'earned-pill', href: 'earnings.html', text: `${peso(balance) === 'Free' ? '₱0' : peso(balance)} earned` }),
        accountMenu(user, profile))
    : el('div', { class: 'header-actions' },
        el('a', { class: 'btn btn--secondary btn--sm', href: 'login.html', text: 'Log in' }),
        el('a', { class: 'btn btn--dark btn--sm', href: 'login.html', text: 'Sign up free' }));

  return el('div', {},
    el('a', { class: 'skip-link', href: '#main', text: 'Skip to content' }),
    promoBar(settings),
    el('header', { class: 'site-header' }, el('div', { class: 'bar' }, logo(), search, tabs, actions)));
}

function footer() {
  return el('footer', { class: 'site-footer' },
    el('span', { class: 'word' }, BRAND.name, el('span', { text: BRAND.suffix })),
    el('nav', { attrs: { 'aria-label': 'Footer' } },
      el('a', { href: 'faq.html', text: 'FAQ' }),
      el('a', { href: 'faq.html#terms', text: 'Terms & refund policy' }),
      el('a', { href: 'faq.html#privacy', text: 'Privacy' }),
      el('a', { href: 'faq.html#contact', text: 'Contact' }),
      el('a', { href: 'admin.html', text: 'Admin' })),
    el('div', { class: 'pay-badges', attrs: { 'aria-label': 'Payment methods' } },
      el('span', { text: 'GCash' }), el('span', { text: 'Maya' }),
      el('span', { text: 'QR Ph' }), el('span', { text: 'Bank' })));
}

function tabbar(active) {
  const t = (href, label, key) =>
    el('a', { href, text: label, attrs: { 'aria-current': key === active ? 'page' : null } });
  return el('nav', { class: 'tabbar', attrs: { 'aria-label': 'Sections' } },
    t('catalog.html', 'Browse', 'catalog'),
    t('my-learning.html', 'My learning', 'learning'),
    t('earnings.html', 'Earn', 'refer'),
    t('account.html', 'Account', 'account'));
}

export async function logout() {
  await supabase.auth.signOut();
  location.href = 'index.html';
}

/** Send a logged-out visitor to login and bring them back afterwards. */
export function goToLogin(reason, returnTo = location.pathname.replace(/^\//, '') + location.search) {
  sessionStorage.setItem('login_redirect', returnTo);
  location.href = 'login.html' + (reason ? `?reason=${encodeURIComponent(reason)}` : '');
}

/**
 * Render the chrome and resolve the session.
 * @param {{active?: string, requireAuth?: boolean, chrome?: boolean}} opts
 */
export async function mountShell({ active = null, requireAuth = false, chrome = true } = {}) {
  captureRef();
  const [{ data: { session } }, settings] = await Promise.all([supabase.auth.getSession(), getSettings()]);
  const user = session?.user ?? null;

  if (requireAuth && !user) {
    goToLogin('required');
    return new Promise(() => {}); // navigation is under way
  }

  const [profile, balance] = user ? await Promise.all([getProfile(user.id), getBalance()]) : [null, 0];

  // First login is signup: finish it before using the site.
  // Cloudflare serves page.html at /page, so match both forms.
  if (user && profile && !profile.signup_completed_at && !/\/login(\.html)?$/.test(location.pathname)) {
    location.href = 'login.html?step=signup';
    return new Promise(() => {});
  }

  if (chrome) {
    const query = new URLSearchParams(location.search).get('q');
    $('#site-header')?.replaceChildren(header({ active, user, profile, balance, settings, query }));
    $('#site-footer')?.replaceChildren(footer(), tabbar(active));
  }

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && requireAuth) location.href = 'login.html?reason=ended';
  });

  return { session, user, profile, settings, balance };
}
