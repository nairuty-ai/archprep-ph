/* FAQ / Terms & refunds / Privacy: one page, three tabs driven by the hash. */

import { $$ } from '../core.js';
import { mountShell } from '../shell.js';

const { settings } = await mountShell({});

const email = (settings.contact_email || '').trim();
if (email) {
  for (const node of $$('.contact-email')) {
    node.textContent = email;
    if (node.tagName === 'A') node.href = `mailto:${email}`;
  }
}

// Amounts in the referral terms come from the live settings.
for (const node of $$('[data-setting]')) {
  const v = String(settings[node.dataset.setting] ?? '').trim();
  if (/^\d+$/.test(v)) node.textContent = v;
}

function showTab() {
  // #referral-terms opens the Terms tab on that item.
  const referral = location.hash === '#referral-terms';
  const tab = referral ? 'terms' : ['faq', 'terms', 'privacy'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'faq';
  if (referral) {
    const item = document.getElementById('referral-terms');
    item.open = true;
    item.classList.add('is-open');
    requestAnimationFrame(() => item.scrollIntoView({ block: 'start' }));
  }
  for (const section of $$('[data-doc]')) section.hidden = section.dataset.doc !== tab;
  for (const link of $$('.doc-tabs a')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', () => { if (location.hash !== '#referral-terms') window.scrollTo(0, 0); showTab(); });
showTab();
