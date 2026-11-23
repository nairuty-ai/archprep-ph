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

function showTab() {
  const tab = ['faq', 'terms', 'privacy'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'faq';
  for (const section of $$('[data-doc]')) section.hidden = section.dataset.doc !== tab;
  for (const link of $$('.doc-tabs a')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', () => { showTab(); window.scrollTo(0, 0); });
showTab();
