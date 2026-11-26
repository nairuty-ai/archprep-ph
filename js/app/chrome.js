/* js/app/chrome.js — promo bar, header, footer and mobile tab bar.
 *
 * A plain (non-module) script with no imports, placed right after
 * <div id="site-header"></div> so it runs before the first paint: the header
 * is there from the first frame and never pushes the page down. It draws from
 * what this tab already knows (the stored session plus the settings, profile
 * and balance shell.js saved last time); shell.js redraws it with fresh data
 * through window.ArkiChrome.draw() and supplies the logout handler.
 *
 * Usage: <script src="js/app/chrome.js" data-active="catalog"></script>
 */
(function () {
  'use strict';

  /** The brand, in one place. */
  var BRAND = { name: 'ArkiPrep', suffix: 'PH' };
  var CACHE_KEY = 'arkiprep-shell';
  var SESSION_KEY = 'arkiprep-session';

  function el(tag, opts) {
    opts = opts || {};
    var node = document.createElement(tag);
    if (opts['class']) node.className = opts['class'];
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.href) node.setAttribute('href', opts.href);
    var attrs = opts.attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === true) node.setAttribute(k, '');
      else if (v != null && v !== false) node.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function peso(n) {
    var v = Number(n) || 0;
    return '₱' + v.toLocaleString('en-PH', { maximumFractionDigits: 0 });
  }

  function logo() {
    return el('a', { 'class': 'logo', href: 'index.html', attrs: { 'aria-label': BRAND.name + ' home' } },
      el('span', { 'class': 'mark', attrs: { 'aria-hidden': 'true' } }),
      el('span', { 'class': 'word' }, BRAND.name, el('span', { text: BRAND.suffix })));
  }

  function initials(profile, user) {
    var name = String((profile && profile.display_name) || (user && user.email) || '?').trim();
    var parts = name.split(/[\s@._-]+/).filter(Boolean);
    return (((parts[0] || '?')[0]) + ((parts[1] || '')[0] || '')).toUpperCase();
  }

  function promoBar(settings) {
    var text = String(settings.announcement_banner || '').trim();
    if (text) return el('div', { 'class': 'promo', attrs: { role: 'note' } }, el('span', { text: text }));
    // Amounts and the payout minimum live in the referral terms, not here.
    return el('div', { 'class': 'promo', attrs: { role: 'note' } },
      el('strong', { text: 'Refer & earn:' }),
      el('span', { text: 'cash rewards when friends buy with your link*' }),
      el('a', { href: 'faq.html#referral-terms', text: '*Terms apply' }));
  }

  // The ALE guide pages exist only while content_pages_enabled is on; on the
  // guide pages themselves that is a given.
  function guideOn(active, settings) {
    return active === 'guide' || String((settings || {}).content_pages_enabled || '').trim().toLowerCase() === 'on';
  }

  function navLink(href, label, key, active) {
    return el('a', { href: href, text: label, attrs: { 'aria-current': key === active ? 'page' : null } });
  }

  function accountMenu(user, profile) {
    var logoutBtn = el('button', { text: 'Log out', attrs: { type: 'button' } });
    logoutBtn.addEventListener('click', function () { ArkiChrome.logout(); });
    var list = el('ul', { 'class': 'menu-list', attrs: { hidden: true, role: 'menu' } },
      el('li', { 'class': 'who', text: user.email }),
      el('li', {}, el('a', { href: 'my-learning.html', text: 'My learning' })),
      el('li', {}, el('a', { href: 'earnings.html', text: 'Refer & earn' })),
      el('li', {}, el('a', { href: 'account.html', text: 'Account & orders' })),
      el('li', {}, logoutBtn));
    var btn = el('button', {
      'class': 'avatar', text: initials(profile, user),
      attrs: { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'Account menu' },
    });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = list.hidden;
      list.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', function () { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') list.hidden = true; });
    return el('div', { 'class': 'menu' }, btn, list);
  }

  function header(active, data) {
    var user = data.user;
    var query = new URLSearchParams(location.search).get('q');
    var search = el('form', { 'class': 'search-pill', attrs: { role: 'search', action: 'catalog.html' } },
      el('span', { 'class': 'icon', attrs: { 'aria-hidden': 'true' } }),
      el('label', { 'class': 'sr-only', text: 'Search courses', attrs: { 'for': 'site-search' } }),
      el('input', {
        attrs: {
          id: 'site-search', name: 'q', type: 'search', value: query || null,
          placeholder: 'Search reviewers, quiz packs, mock exams…', autocomplete: 'off',
        },
      }));

    var tabs = el('nav', { 'class': 'nav-tabs', attrs: { 'aria-label': 'Primary' } },
      guideOn(active, data.settings) && navLink('ale-guide', 'ALE guide', 'guide', active),
      navLink('catalog.html', 'Browse', 'catalog', active),
      user && navLink('my-learning.html', 'My learning', 'learning', active),
      user && navLink('earnings.html', 'Refer & earn', 'refer', active));

    var actions = user
      ? el('div', { 'class': 'header-actions' },
          el('a', { 'class': 'earned-pill', href: 'earnings.html', text: peso(data.balance) + ' earned' }),
          accountMenu(user, data.profile))
      : el('div', { 'class': 'header-actions' },
          el('a', { 'class': 'btn btn--secondary btn--sm', href: 'login.html', text: 'Log in' }),
          el('a', { 'class': 'btn btn--dark btn--sm', href: 'login.html', text: 'Sign up free' }));

    return el('div', {},
      el('a', { 'class': 'skip-link', href: '#main', text: 'Skip to content' }),
      promoBar(data.settings || {}),
      el('header', { 'class': 'site-header' }, el('div', { 'class': 'bar' }, logo(), search, tabs, actions)));
  }

  function footer() {
    return el('footer', { 'class': 'site-footer' },
      el('span', { 'class': 'word' }, BRAND.name, el('span', { text: BRAND.suffix })),
      el('nav', { attrs: { 'aria-label': 'Footer' } },
        el('a', { href: 'faq.html', text: 'FAQ' }),
        el('a', { href: 'faq.html#terms', text: 'Terms & refund policy' }),
        el('a', { href: 'faq.html#privacy', text: 'Privacy' }),
        el('a', { href: 'faq.html#contact', text: 'Contact' }),
        el('a', { href: 'careers.html', text: 'Work with us' }),
        el('a', { href: 'admin.html', text: 'Admin' })),
      el('div', { 'class': 'pay-badges', attrs: { 'aria-label': 'Payment methods' } },
        el('span', { text: 'GCash' }), el('span', { text: 'Maya' }),
        el('span', { text: 'QR Ph' }), el('span', { text: 'Bank' })));
  }

  function tabbar(active) {
    function t(href, label, key) {
      return el('a', { href: href, text: label, attrs: { 'aria-current': key === active ? 'page' : null } });
    }
    return el('nav', { 'class': 'tabbar', attrs: { 'aria-label': 'Sections' } },
      t('catalog.html', 'Browse', 'catalog'),
      t('my-learning.html', 'My learning', 'learning'),
      t('earnings.html', 'Earn', 'refer'),
      t('account.html', 'Account', 'account'));
  }

  function readCache() {
    try {
      var shell = JSON.parse(sessionStorage.getItem(CACHE_KEY)) || {};
      var session = JSON.parse(sessionStorage.getItem(SESSION_KEY));
      shell.user = (session && session.user) || null;
      return shell;
    } catch (e) {
      return {};
    }
  }

  // Footer and tab bar are drawn when draw() runs after the page has parsed;
  // the header (above the fold) is drawn right now.
  // What the header shows. Rebuilding it with identical content would count
  // as a fresh paint (and push back Largest Contentful Paint), so draw()
  // skips the rebuild when this hasn't changed.
  var drawn = null;
  function signature(active, data) {
    var s = data.settings || {};
    var p = data.profile || {};
    return JSON.stringify([active, data.user ? data.user.email : null, p.display_name || null,
      data.user ? Number(data.balance) || 0 : 0,
      String(s.announcement_banner || '').trim(),
      guideOn(active, s)]);
  }

  function draw(active, data) {
    data = data || {};
    var sig = signature(active, data);
    var head = document.getElementById('site-header');
    if (head && sig !== drawn) {
      head.replaceChildren(header(active, data));
      drawn = sig;
    }
    var foot = document.getElementById('site-footer');
    if (foot && !foot.firstChild) foot.replaceChildren(footer(), tabbar(active));
  }

  var ArkiChrome = window.ArkiChrome = {
    BRAND: BRAND,
    CACHE_KEY: CACHE_KEY,
    active: (document.currentScript && document.currentScript.dataset.active) || null,
    draw: draw,
    saveCache: function (data) {
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* storage blocked */ }
    },
    // shell.js replaces this with the real logout once Supabase has loaded.
    logout: function () {
      sessionStorage.removeItem(CACHE_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      location.href = 'index.html';
    },
  };

  draw(ArkiChrome.active, readCache());
  document.addEventListener('DOMContentLoaded', function () {
    var foot = document.getElementById('site-footer');
    if (foot && !foot.firstChild) foot.replaceChildren(footer(), tabbar(ArkiChrome.active));
  });
})();
