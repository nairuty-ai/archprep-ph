/* js/earnings.js — Earnings / referral dashboard page logic.
 *
 * Requirements 25.1–25.7, 17.6, 22.6, 33.4
 */

import { requireSession } from './auth.js';
import { api } from './api.js';
import { el, peso, setText } from './dom.js';
import { renderLoading, renderEmpty, renderError, toast } from './states.js';
import { buildRefLink } from './referral.js';

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------
export async function initEarnings(container) {
  let user;
  try {
    user = await requireSession();
  } catch {
    return;
  }

  renderLoading(container, 'Loading your earnings…');

  let profile, referrals, settings;
  try {
    [profile, referrals, settings] = await Promise.all([
      api.getProfile(),
      api.getReferrals(),
      api.getSettings(),
    ]);
  } catch (err) {
    renderError(container, err.message || 'Could not load earnings data.', () => initEarnings(container));
    return;
  }

  container.innerHTML = '';

  const refCode     = profile?.ref_code ?? null;
  const rewardType  = settings?.reward_type ?? 'cash';
  const threshold   = parseFloat(settings?.payout_threshold ?? '500');

  // Compute balances (Requirement 25.1–25.3, 17.6 — void rows excluded)
  const activeReferrals  = referrals.filter((r) => r.status !== 'void');
  const paidReferrals    = activeReferrals.filter((r) => r.status === 'paid');
  const pendingReferrals = activeReferrals.filter((r) => r.status === 'pending' || r.status === 'approved');

  const availableBalance = pendingReferrals.reduce((sum, r) => sum + parseFloat(r.amount_php ?? 0), 0);
  const paidBalance      = paidReferrals.reduce((sum, r) => sum + parseFloat(r.amount_php ?? 0), 0);

  // ---- Referral link section ----
  if (refCode) {
    container.appendChild(_buildReferralLinkSection(refCode));
  }

  // ---- Stats summary ----
  container.appendChild(_buildStats(activeReferrals.length, availableBalance, paidBalance, rewardType));

  // ---- Payout section ----
  if (rewardType === 'cash') {
    const payoutSection = _buildPayoutSection(profile, availableBalance, threshold);
    container.appendChild(payoutSection);
  } else {
    // reward_type=credit
    container.appendChild(_buildCreditSection(availableBalance));
  }

  // ---- Referral ledger ----
  if (referrals.length === 0) {
    // Empty state (Requirement 33.4)
    const emptyBox = el('div', {});
    emptyBox.style.cssText = 'margin-top:2rem;';
    const emptyCard = el('div', { class: 'card', attrs: { style: 'text-align:center;padding:2rem;' } });
    emptyCard.appendChild(el('p', { attrs: { style: 'font-size:2.5rem;margin-bottom:.5rem;' }, text: '📤' }));
    emptyCard.appendChild(el('h3', { text: 'No referrals yet' }));
    const desc = el('p', {});
    desc.style.color = 'var(--ink-soft)';
    desc.textContent = 'Share your referral link and earn a reward for each purchase made through it.';
    emptyCard.appendChild(desc);
    emptyBox.appendChild(emptyCard);
    container.appendChild(emptyBox);
  } else {
    container.appendChild(_buildLedger(referrals));
  }
}

// ---------------------------------------------------------------------------
// Referral link card
// ---------------------------------------------------------------------------
function _buildReferralLinkSection(refCode) {
  const refLink = buildRefLink(refCode);

  const section = el('section', {});
  section.style.cssText = 'margin-bottom:2rem;';

  const card = el('div', { class: 'card' });

  const heading = el('h2', { text: 'Your referral link' });
  heading.style.fontSize = 'var(--fs-lg)';

  const desc = el('p', {});
  desc.style.color = 'var(--ink-soft)';
  desc.textContent = 'Share this link. When someone purchases using it, you earn a reward!';

  const row = el('div', {});
  row.style.cssText = 'display:flex;gap:.5rem;margin-top:.75rem;flex-wrap:wrap;';

  const input = el('input', {
    attrs: {
      type: 'text',
      readonly: '',
      value: refLink,
      'aria-label': 'Your referral link',
    },
  });
  input.style.cssText = [
    'flex:1;min-width:0;',
    'padding:.55rem .75rem;',
    'font-family:var(--font-body);font-size:var(--fs-xs);',
    'border:1px solid var(--border);border-radius:var(--radius-sm);',
    'background:#fff;color:var(--ink);',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
  ].join('');

  const copyBtn = el('button', {
    class: 'btn btn--outline',
    text: 'Copy link',
    attrs: { type: 'button', 'aria-label': 'Copy referral link to clipboard' },
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(refLink);
      setText(copyBtn, 'Copied!');
      setTimeout(() => setText(copyBtn, 'Copy link'), 2000);
    } catch {
      input.select();
      document.execCommand('copy');
      setText(copyBtn, 'Copied!');
      setTimeout(() => setText(copyBtn, 'Copy link'), 2000);
    }
  });

  row.appendChild(input);
  row.appendChild(copyBtn);

  card.appendChild(heading);
  card.appendChild(desc);
  card.appendChild(row);
  section.appendChild(card);
  return section;
}

// ---------------------------------------------------------------------------
// Stats summary
// ---------------------------------------------------------------------------
function _buildStats(referralCount, availableBalance, paidBalance, rewardType) {
  const section = el('section', {});
  section.style.cssText = 'margin-bottom:2rem;';

  const heading = el('h2', { text: 'Your earnings' });
  heading.style.cssText = 'font-size:var(--fs-lg);margin-bottom:1rem;';
  section.appendChild(heading);

  const grid = el('div', { class: 'grid grid--3' });

  grid.appendChild(_statCard('Referrals', String(referralCount), 'Total referred purchases'));
  if (rewardType === 'cash') {
    grid.appendChild(_statCard('Available balance', peso(availableBalance), 'Pending payout'));
    grid.appendChild(_statCard('Paid out', peso(paidBalance), 'Total paid to you'));
  } else {
    grid.appendChild(_statCard('Credit balance', peso(availableBalance), 'Redeemable credit'));
    grid.appendChild(_statCard('Used credit', peso(paidBalance), 'Credit applied to orders'));
  }

  section.appendChild(grid);
  return section;
}

function _statCard(label, value, subtext) {
  const card = el('div', { class: 'card', attrs: { style: 'text-align:center;' } });
  const val = el('p', {});
  val.style.cssText = 'font-family:var(--font-head);font-size:var(--fs-xl);font-weight:600;color:var(--ink);margin:0 0 .25rem;';
  val.textContent = value;
  const lbl = el('p', {});
  lbl.style.cssText = 'font-weight:700;font-size:var(--fs-sm);margin:0 0 .2rem;';
  lbl.textContent = label;
  const sub = el('p', {});
  sub.style.cssText = 'font-size:var(--fs-xs);color:var(--muted);margin:0;';
  sub.textContent = subtext;
  card.appendChild(val);
  card.appendChild(lbl);
  card.appendChild(sub);
  return card;
}

// ---------------------------------------------------------------------------
// Payout section (cash) — Requirement 25.4–25.7
// ---------------------------------------------------------------------------
function _buildPayoutSection(profile, availableBalance, threshold) {
  const section = el('section', {});
  section.style.cssText = 'margin-bottom:2rem;';

  const card = el('div', { class: 'card' });

  const heading = el('h2', { text: 'Request payout' });
  heading.style.fontSize = 'var(--fs-lg)';
  card.appendChild(heading);

  if (availableBalance < threshold) {
    const shortfall = threshold - availableBalance;
    const note = el('p', {});
    note.style.color = 'var(--ink-soft)';
    note.textContent = `Minimum payout is ${peso(threshold)}. You need ${peso(shortfall)} more to request a payout.`;
    card.appendChild(note);
    section.appendChild(card);
    return section;
  }

  // Has enough balance
  const desc = el('p', {});
  desc.style.color = 'var(--ink-soft)';
  desc.textContent = `You have ${peso(availableBalance)} available. Enter your GCash number to request a payout.`;
  card.appendChild(desc);

  const formGroup = el('div', {});
  formGroup.style.cssText = 'margin-top:1rem;';

  const label = el('label', {});
  label.style.cssText = 'display:block;font-weight:700;margin-bottom:.35rem;font-size:var(--fs-sm);';
  label.textContent = 'GCash mobile number';
  label.setAttribute('for', 'gcash-input');

  const input = el('input', {
    attrs: {
      type: 'tel',
      id: 'gcash-input',
      name: 'gcash_number',
      inputmode: 'numeric',
      maxlength: '11',
      placeholder: '09XXXXXXXXX',
      autocomplete: 'tel',
      'aria-describedby': 'gcash-error',
    },
  });
  input.style.cssText = [
    'width:100%;max-width:260px;',
    'padding:.65rem .85rem;',
    'font-family:var(--font-body);font-size:var(--fs-sm);',
    'border:1px solid var(--border);border-radius:var(--radius-sm);',
    'background:#fff;color:var(--ink);',
  ].join('');

  // Pre-fill from profile if available
  if (profile?.gcash_number) {
    input.value = profile.gcash_number;
  }

  const errMsg = el('p', { attrs: { id: 'gcash-error', role: 'alert', 'aria-live': 'polite' } });
  errMsg.style.cssText = 'color:var(--error);font-size:var(--fs-xs);font-weight:600;margin-top:.3rem;';

  formGroup.appendChild(label);
  formGroup.appendChild(input);
  formGroup.appendChild(errMsg);

  const btnRow = el('div', { attrs: { style: 'margin-top:1rem;' } });
  const btn = el('button', {
    class: 'btn btn--primary',
    text: 'Request payout',
    attrs: { type: 'button', 'aria-label': 'Request cash payout to GCash' },
  });

  const successMsg = el('p', {});
  successMsg.style.cssText = 'color:var(--success);font-weight:700;font-size:var(--fs-sm);margin-top:.5rem;';

  btn.addEventListener('click', async () => {
    const gcash = input.value.trim();
    if (!gcash || !/^09\d{9}$/.test(gcash)) {
      errMsg.textContent = 'Please enter a valid 11-digit GCash number (e.g. 09XXXXXXXXX).';
      input.focus();
      return;
    }
    errMsg.textContent = '';
    btn.disabled = true;
    setText(btn, 'Submitting…');

    try {
      await api.requestPayout({ gcash_number: gcash });
      successMsg.textContent = 'Payout request submitted! We will process it within 3–5 business days.';
      btn.hidden = true;
    } catch (err) {
      errMsg.textContent = err.message || 'Could not submit payout request. Please try again.';
      btn.disabled = false;
      setText(btn, 'Request payout');
    }
  });

  btnRow.appendChild(btn);
  btnRow.appendChild(successMsg);

  card.appendChild(formGroup);
  card.appendChild(btnRow);
  section.appendChild(card);
  return section;
}

// ---------------------------------------------------------------------------
// Credit section
// ---------------------------------------------------------------------------
function _buildCreditSection(availableBalance) {
  const section = el('section', {});
  section.style.cssText = 'margin-bottom:2rem;';

  const card = el('div', { class: 'card' });
  const heading = el('h2', { text: 'Redeemable credit' });
  heading.style.fontSize = 'var(--fs-lg)';
  const balance = el('p', {});
  balance.style.cssText = 'font-family:var(--font-head);font-size:var(--fs-xl);font-weight:600;color:var(--ink);';
  balance.textContent = peso(availableBalance);
  const desc = el('p', {});
  desc.style.color = 'var(--ink-soft)';
  desc.textContent = 'This credit will be applied automatically to your next purchase.';
  card.appendChild(heading);
  card.appendChild(balance);
  card.appendChild(desc);
  section.appendChild(card);
  return section;
}

// ---------------------------------------------------------------------------
// Referral ledger (Requirement 25.3, 17.6)
// ---------------------------------------------------------------------------
function _buildLedger(referrals) {
  const section = el('section', {});
  section.style.cssText = 'margin-bottom:2rem;';

  const heading = el('h2', { text: 'Referral history' });
  heading.style.cssText = 'font-size:var(--fs-lg);margin-bottom:1rem;';
  section.appendChild(heading);

  // Table wrapper for horizontal scroll on small screens
  const tableWrap = el('div', {});
  tableWrap.style.cssText = 'overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);';

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:var(--fs-xs);';
  table.setAttribute('aria-label', 'Referral earnings history');

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headerRow.style.cssText = 'background:var(--surface);border-bottom:1px solid var(--border);';

  const cols = ['Date', 'Buyer', 'Product', 'Amount', 'Status'];
  for (const col of cols) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = col;
    th.style.cssText = 'padding:.65rem 1rem;text-align:left;font-weight:700;color:var(--ink-soft);white-space:nowrap;';
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of referrals) {
    const tr = document.createElement('tr');
    tr.style.cssText = 'border-bottom:1px solid var(--border);' + (row.status === 'void' ? 'opacity:.5;' : '');

    const date = new Date(row.created_at).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });

    const cells = [
      date,
      row.buyer_masked || '—',
      row.product_title || '—',
      row.amount_php ? peso(row.amount_php) : '—',
      _statusBadge(row.status),
    ];

    cells.forEach((val, i) => {
      const td = document.createElement('td');
      td.style.cssText = 'padding:.65rem 1rem;vertical-align:middle;white-space:nowrap;';
      if (i === cells.length - 1 && val instanceof Node) {
        td.appendChild(val);
      } else {
        td.textContent = String(val);
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  section.appendChild(tableWrap);
  return section;
}

function _statusBadge(status) {
  const colors = {
    pending:  { bg: '#FFF3CD', color: '#856404' },
    approved: { bg: '#D1ECF1', color: '#0C5460' },
    paid:     { bg: '#D4EDDA', color: '#155724' },
    void:     { bg: '#F8D7DA', color: '#721C24' },
  };
  const c = colors[status] || { bg: '#E2E3E5', color: '#383D41' };
  const badge = document.createElement('span');
  badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  badge.style.cssText = [
    `background:${c.bg};color:${c.color};`,
    'padding:.2rem .6rem;border-radius:999px;',
    'font-size:var(--fs-xs);font-weight:700;',
  ].join('');
  return badge;
}
