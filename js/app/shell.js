/* js/app/shell.js — session, login guard and live data for the chrome.
 *
 * Page markup: <div id="site-header"></div>
 *              <script src="js/app/chrome.js" data-active="catalog"></script>
 *              <main id="main">…</main> <div id="site-footer"></div>
 * chrome.js draws the promo bar, header, footer and tab bar before the first
 * paint; mountShell() resolves the session and redraws them with fresh data.
 * Usage:       const ctx = await mountShell({ active: 'catalog' });
 *              ctx = { session, user, profile, settings, balance }
 */

import { supabase, getSettings, getProfile, getBalance } from './core.js';
import { captureRef } from '../referral.js';
import './motion.js';

const chrome = window.ArkiChrome;

export async function logout() {
  sessionStorage.removeItem(chrome.CACHE_KEY);
  await supabase.auth.signOut();
  location.href = 'index.html';
}
chrome.logout = logout;

/** Send a logged-out visitor to login and bring them back afterwards. */
export function goToLogin(reason, returnTo = location.pathname.replace(/^\//, '') + location.search) {
  sessionStorage.setItem('login_redirect', returnTo);
  location.href = 'login.html' + (reason ? `?reason=${encodeURIComponent(reason)}` : '');
}

/**
 * Resolve the session and redraw the chrome with fresh data.
 * @param {{active?: string, requireAuth?: boolean, chrome?: boolean}} opts
 */
export async function mountShell({ active = chrome.active, requireAuth = false, chrome: drawChrome = true } = {}) {
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

  chrome.saveCache({ profile, balance, settings });
  if (drawChrome) chrome.draw(active, { user, profile, balance, settings });

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && requireAuth) location.href = 'login.html?reason=ended';
  });

  return { session, user, profile, settings, balance };
}
