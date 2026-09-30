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

const NAV_LINKS = [
  { href: '/index.html',       label: 'Home' },
  { href: '/catalog.html',     label: 'Catalog' },
  { href: '/faq.html',         label: 'FAQ' },
];

/**
 * Render the top navigation bar, including the user chip / login button.
 * Call this in every page — it is idempotent.
 *
 * The nav is already in the HTML; this function just wires up the dynamic parts.
 */
export async function initNav() {
  // Capture referral code from URL on every page load (Requirement 22.1–22.3).
  const { captureRef } = await import('./referral.js');
  captureRef();

  const session = await getSession();
  const user    = session?.user ?? null;

  // Fetch profile for display_name if logged in.
  let displayName = null;
  if (user) {
    const { data } = await supabase
      .from('profiles')
      .select('display_name,is_admin')
      .eq('id', user.id)
      .single();
    displayName = data?.display_name || user.email?.split('@')[0] || 'My Account';
    // Stash is_admin in sessionStorage so admin.html can check it quickly.
    if (data?.is_admin) sessionStorage.setItem('is_admin', '1');
    else sessionStorage.removeItem('is_admin');
  }

  const navActions = $('#nav-actions') || $('#nav-end');
  if (!navActions) return;

  navActions.innerHTML = '';

  if (user) {
    // Account menu chip (Requirement 31.1).
    const menu = el('div', { class: 'account-menu', attrs: { style: 'position:relative' } });
    const btn  = el('button', {
      class: 'account-chip',
      text:  displayName,
      attrs: { 'aria-expanded': 'false', 'aria-haspopup': 'true' },
    });
    const dropdown = el('ul', {
      class: 'account-dropdown',
      attrs: { role: 'menu', hidden: '' },
      children: [
        menuItem('📚 My Learning',   '/my-learning.html'),
        menuItem('💰 Earnings',      '/earnings.html'),
        menuItem('⚙️ Account',       '/account.html'),
        menuSep(),
        menuItem('🚪 Sign out',      null, () => signOut()),
      ],
    });

    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      dropdown.hidden = open;
    });

    // Close on outside click.
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) {
        btn.setAttribute('aria-expanded', 'false');
        dropdown.hidden = true;
      }
    });

    menu.appendChild(btn);
    menu.appendChild(dropdown);
    navActions.appendChild(menu);
  } else {
    // Login + Sign up buttons when logged out.
    const loginBtn = el('a', {
      class: 'btn btn--outline',
      text: 'Log in',
      attrs: { href: '/login.html' },
    });
    const signupBtn = el('a', {
      class: 'btn btn--primary',
      text: 'Sign up free',
      attrs: { href: '/login.html' },
    });
    navActions.appendChild(loginBtn);
    navActions.appendChild(signupBtn);
  }
}

function menuItem(label, href, onClick = null) {
  const a = href
    ? el('a', { text: label, attrs: { href, role: 'menuitem' } })
    : el('button', { text: label, attrs: { role: 'menuitem', type: 'button' } });
  if (onClick) a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return el('li', { children: [a] });
}

function menuSep() {
  return el('li', { attrs: { role: 'separator', 'aria-hidden': 'true', style: 'border-top:1px solid var(--border);margin:.25rem 0' } });
}

// ---------------------------------------------------------------------------
// Mobile menu toggle (shared across all pages that include this script)
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const toggle = $('.nav-toggle');
  const menu   = $('#mobile-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      menu.hidden = open;
    });
  }
});
