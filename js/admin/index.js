/* js/admin/index.js — admin portal entry point.
 *
 * Checks admin auth, builds the tab bar, and lazy-loads each tab module.
 * URL routing: ?tab=products&quiz_id=xxx
 */

import { requireAdmin, initNav } from '../auth.js';
import { $, el } from '../dom.js';
import { renderLoading, renderError, toast } from '../states.js';

const TABS = [
  { id: 'products',    label: '📦 Products',    module: () => import('./products.js') },
  { id: 'quizzes',     label: '📝 Quizzes',     module: () => import('./quizzes.js') },
  { id: 'questions',   label: '❓ Questions',   module: () => import('./questions.js') },
  { id: 'enrollments', label: '🎓 Enrollments', module: () => import('./enrollments.js') },
  { id: 'referrals',   label: '🔗 Referrals',   module: () => import('./referrals.js') },
  { id: 'payouts',     label: '💸 Payouts',     module: () => import('./payouts.js') },
  { id: 'incidents',   label: '⚠️ Incidents',  module: () => import('./incidents.js') },
  { id: 'settings',    label: '⚙️ Settings',    module: () => import('./settings.js') },
  { id: 'users',       label: '👥 Users',       module: () => import('./users.js') },
];

// ---- helpers ---------------------------------------------------------------

function getParams() {
  const sp = new URLSearchParams(location.search);
  const out = {};
  for (const [k, v] of sp.entries()) out[k] = v;
  return out;
}

function setParam(key, value) {
  const sp = new URLSearchParams(location.search);
  if (value == null) sp.delete(key);
  else sp.set(key, value);
  const url = sp.toString() ? `?${sp}` : location.pathname;
  history.pushState({}, '', url);
}

// ---- tab routing -----------------------------------------------------------

let _activeTabId = null;

async function loadTab(tabId, params) {
  const panel = $('#admin-panel');
  const tabDef = TABS.find((t) => t.id === tabId);
  if (!tabDef) return;

  // Update tab button states
  for (const btn of document.querySelectorAll('#admin-tab-bar .admin-tab')) {
    const selected = btn.dataset.tabId === tabId;
    btn.setAttribute('aria-selected', String(selected));
  }

  _activeTabId = tabId;
  renderLoading(panel, `Loading ${tabDef.label}…`);

  try {
    const mod = await tabDef.module();
    await mod.init(panel, params);
  } catch (err) {
    console.error('[admin] tab load error', err);
    renderError(panel, `Failed to load ${tabDef.label}: ${err.message}`, () => loadTab(tabId, params));
  }
}

function navigateTab(tabId, extraParams = {}) {
  const sp = new URLSearchParams();
  sp.set('tab', tabId);
  for (const [k, v] of Object.entries(extraParams)) {
    if (v != null) sp.set(k, v);
  }
  history.pushState({}, '', `?${sp}`);
  loadTab(tabId, { tab: tabId, ...extraParams });
}

// ---- build tab bar ---------------------------------------------------------

function buildTabBar() {
  const bar = $('#admin-tab-bar');
  bar.innerHTML = '';
  for (const tab of TABS) {
    const btn = el('button', {
      class: 'admin-tab',
      text: tab.label,
      attrs: {
        role: 'tab',
        'aria-selected': 'false',
        'data-tab-id': tab.id,
      },
    });
    btn.addEventListener('click', () => navigateTab(tab.id));
    bar.appendChild(btn);
  }
}

// ---- popstate --------------------------------------------------------------

window.addEventListener('popstate', () => {
  const params = getParams();
  const tabId = params.tab || TABS[0].id;
  loadTab(tabId, params);
});

// ---- init ------------------------------------------------------------------

(async () => {
  initNav();

  try {
    await requireAdmin();
  } catch (err) {
    // Not admin — show access denied panel
    const denied = $('#access-denied');
    if (denied) denied.hidden = false;
    return;
  }

  // Show portal
  const portal = $('#admin-portal');
  if (portal) portal.hidden = false;

  buildTabBar();

  const params = getParams();
  const tabId = params.tab || TABS[0].id;
  loadTab(tabId, params);
})();

// Expose navigateTab so tab modules can redirect to sibling tabs
export { navigateTab };
