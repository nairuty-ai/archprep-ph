/* js/auth.js — authentication helpers and the shared nav shell.
 *
 * Three route classes (Requirement 31, 10):
 *   public      — anyone can see the page; show login CTA when no session
 *   gated       — requires a session; redirect to login with return URL if absent
 *   admin-only  — requires session AND is_admin = true
 *
 * Usage:
 *   import { requireSession, requireAdmin, initNav, signOut } from './auth.js';
 *
 *   // In a gated page:
 *   const user = await requireSession();  // redirects if not logged in
 *
 *   // In an admin page:
 *   const uid = await requireAdmin();     // redirects if not admin
 *
 *   // In every page:
 *   initNav();  // renders the top-bar user chip / login button
 */

import { supabase, getSession, getUser } from './supabase.js';
import { $, el } from './dom.js';

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/** Sign in with email OTP (step 1 of 2). */
export async function signInWithEmail(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) throw error;
}

/** Verify the OTP code (step 2 of 2). */
export async function verifyOtp(email, token) {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw error;
}

/** Sign out and navigate to the home page. */
export async function signOut() {
  await supabase.auth.signOut();
  location.href = '/index.html';
}

// ---------------------------------------------------------------------------
// Route guards
// ---------------------------------------------------------------------------

/**
 * For gated pages: ensure a session exists, or redirect to login.
 * Returns the Supabase user object.
 */
export async function requireSession() {
  const session = await getSession();
  if (!session) {
    sessionStorage.setItem('login_redirect', location.pathname + location.search);
    location.href = '/login.html';
    throw new Error('redirect');
  }
  return session.user;
}

/**
 * For admin pages: ensure a session AND profiles.is_admin = true.
 * Returns the user object. Renders an access-denied state if not admin.
 */
export async function requireAdmin() {
  const user = await requireSession();

  // Check is_admin from the profiles table (client can read its own row).
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single();

  if (error || !data?.is_admin) {
    // Render access denied rather than redirect — admin.html handles this.
    throw Object.assign(new Error('not_admin'), { code: 'not_admin' });
  }
  return user;
}

// ---------------------------------------------------------------------------
// Shared nav shell
// ---------------------------------------------------------------------------

const PROMO_KEY   = 'archprep_promo_dismissed';
const SESSION_KEY = 'archprep-session'; // storageKey in supabase.js

let navSubscribed = false;
let outsideClickBound = false;

/**
 * Render the dynamic parts of the header (account menu / login buttons,
 * mobile menu auth block, promo bar). Call once per page.
 */
export async function initNav() {
  // Capture referral code from URL on every page load (Requirement 22.1–22.3).
  const { captureRef } = await import('./referral.js');
  captureRef();

  const session = await getSession();
  await renderNavActions(session?.user ?? null);

  // Keep the header in sync with sign-in / sign-out in this or other tabs.
  if (!navSubscribed) {
    navSubscribed = true;
    supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === 'TOKEN_REFRESHED') return;
      renderNavActions(newSession?.user ?? null);
    });
  }
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return 'A';
  const first = parts[0].charAt(0);
  const second = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return (first + second).toUpperCase();
}

async function renderNavActions(user) {
  let displayName = null;
  let isAdmin = false;
  if (user) {
    const { data } = await supabase
      .from('profiles')
      .select('display_name,is_admin')
      .eq('id', user.id)
      .single();
    displayName = data?.display_name || user.email?.split('@')[0] || 'My account';
    isAdmin = !!data?.is_admin;
    // Stash is_admin in sessionStorage so admin.html can check it quickly.
    if (isAdmin) sessionStorage.setItem('is_admin', '1');
    else sessionStorage.removeItem('is_admin');
  }

  updatePromo(!!user);

  const navActions = $('#nav-actions') || $('#nav-end');
  if (navActions) {
    navActions.innerHTML = '';
    if (user) {
      navActions.appendChild(el('a', {
        class: 'nav-learning',
        text: 'My learning',
        attrs: { href: '/my-learning.html' },
      }));
      navActions.appendChild(buildAccountMenu(user, displayName, isAdmin));
    } else {
      navActions.appendChild(el('a', {
        class: 'btn btn--outline nav-auth-btn',
        text: 'Log in',
        attrs: { href: '/login.html' },
      }));
      navActions.appendChild(el('a', {
        class: 'btn btn--primary nav-auth-btn',
        text: 'Sign up',
        attrs: { href: '/login.html' },
      }));
    }
  }

  renderMobileAuth(user, displayName, isAdmin);
}

function buildAccountMenu(user, displayName, isAdmin) {
  const menu = el('div', { class: 'account-menu' });
  const btn  = el('button', {
    class: 'avatar-btn',
    text:  initialsOf(displayName),
    attrs: {
      type: 'button',
      'aria-expanded': 'false',
      'aria-haspopup': 'true',
      'aria-label': 'Account menu for ' + displayName,
    },
  });

  const head = el('a', {
    class: 'dropdown-head',
    attrs: { href: '/account.html', role: 'menuitem' },
    children: [
      el('span', { class: 'avatar', text: initialsOf(displayName), attrs: { 'aria-hidden': 'true' } }),
      el('span', {
        children: [
          el('span', { class: 'dropdown-name', text: displayName }),
          el('span', { class: 'dropdown-email', text: user.email || '' }),
        ],
      }),
    ],
  });

  const items = [
    el('li', { children: [head] }),
    menuSep(),
    menuItem('My learning',          '/my-learning.html'),
    menuItem('Earnings & referrals', '/earnings.html'),
    menuItem('Account settings',     '/account.html'),
  ];
  if (isAdmin) items.push(menuItem('Admin portal', '/admin.html'));
  items.push(
    menuSep(),
    menuItem('Help & FAQ', '/faq.html'),
    menuSep(),
    menuItem('Log out', null, () => signOut()),
  );

  const dropdown = el('ul', {
    class: 'account-dropdown',
    attrs: { role: 'menu', hidden: '' },
    children: items,
  });

  const close = () => {
    btn.setAttribute('aria-expanded', 'false');
    dropdown.hidden = true;
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    dropdown.hidden = open;
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); btn.focus(); }
  });

  if (!outsideClickBound) {
    outsideClickBound = true;
    document.addEventListener('click', (e) => {
      document.querySelectorAll('.account-menu').forEach((m) => {
        if (!m.contains(e.target)) {
          const b = m.querySelector('.avatar-btn');
          const d = m.querySelector('.account-dropdown');
          if (b) b.setAttribute('aria-expanded', 'false');
          if (d) d.hidden = true;
        }
      });
    });
  }

  menu.appendChild(btn);
  menu.appendChild(dropdown);
  return menu;
}

function renderMobileAuth(user, displayName, isAdmin) {
  const box = $('#mobile-auth');
  if (!box) return;
  box.innerHTML = '';

  if (!user) {
    box.appendChild(el('a', { class: 'btn btn--primary btn--block', text: 'Sign up', attrs: { href: '/login.html' } }));
    box.appendChild(el('a', { class: 'btn btn--outline btn--block', text: 'Log in',  attrs: { href: '/login.html' } }));
    return;
  }

  box.appendChild(el('div', {
    class: 'mobile-user',
    children: [
      el('span', { class: 'avatar', text: initialsOf(displayName), attrs: { 'aria-hidden': 'true' } }),
      el('span', {
        children: [
          el('span', { class: 'dropdown-name', text: displayName }),
          el('span', { class: 'dropdown-email', text: user.email || '' }),
        ],
      }),
    ],
  }));

  const links = [
    ['My learning', '/my-learning.html'],
    ['Earnings & referrals', '/earnings.html'],
    ['Account settings', '/account.html'],
  ];
  if (isAdmin) links.push(['Admin portal', '/admin.html']);
  const ul = el('ul', { attrs: { role: 'list' } });
  for (const [label, href] of links) {
    ul.appendChild(el('li', { children: [el('a', { text: label, attrs: { href } })] }));
  }
  const out = el('button', { class: 'btn btn--outline btn--block', text: 'Log out', attrs: { type: 'button' } });
  out.addEventListener('click', () => signOut());
  ul.appendChild(el('li', { children: [out] }));
  box.appendChild(ul);
}

function menuItem(label, href, onClick = null) {
  const a = href
    ? el('a', { text: label, attrs: { href, role: 'menuitem' } })
    : el('button', { text: label, attrs: { role: 'menuitem', type: 'button' } });
  if (onClick) a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return el('li', { children: [a] });
}

function menuSep() {
  return el('li', { attrs: { role: 'separator', 'aria-hidden': 'true' } });
}

// ---------------------------------------------------------------------------
// Promo bar (top announcement strip)
// ---------------------------------------------------------------------------

function promoDismissed() {
  try { return localStorage.getItem(PROMO_KEY) === '1'; } catch { return false; }
}

function looksSignedIn() {
  try { return !!localStorage.getItem(SESSION_KEY); } catch { return false; }
}

function updatePromo(signedIn) {
  const bar = $('#promo-bar');
  if (!bar) return;
  const suppressed = document.body.hasAttribute('data-no-promo');
  bar.hidden = signedIn || suppressed || promoDismissed();
}

// ---------------------------------------------------------------------------
// Static header wiring (mobile menu, promo bar, search prefill)
// ---------------------------------------------------------------------------

function wireHeader() {
  // Mobile menu toggle.
  const toggle = $('.nav-toggle');
  const menu   = $('#mobile-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      toggle.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
      menu.hidden = open;
    });
  }

  // Mobile search icon opens the menu with the search box focused.
  const searchIcon = $('.nav-icon--search');
  if (searchIcon && toggle && menu) {
    searchIcon.addEventListener('click', (e) => {
      e.preventDefault();
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close menu');
      menu.hidden = false;
      $('#mobile-q')?.focus();
    });
  }

  // Promo bar: show immediately for signed-out visitors (avoids a late jump),
  // initNav() hides it again once the session is confirmed.
  const bar = $('#promo-bar');
  if (bar) {
    updatePromo(looksSignedIn());
    bar.querySelector('.promo-close')?.addEventListener('click', () => {
      try { localStorage.setItem(PROMO_KEY, '1'); } catch { /* private mode */ }
      bar.hidden = true;
    });
  }

  // Keep the search box filled with the current query on the catalog page.
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    const navQ = $('#nav-q');
    const mobQ = $('#mobile-q');
    if (navQ) navQ.value = q;
    if (mobQ) mobQ.value = q;
  }

  // Footer year.
  const year = $('#footer-year');
  if (year && !year.textContent) year.textContent = String(new Date().getFullYear());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireHeader);
} else {
  wireHeader();
}
