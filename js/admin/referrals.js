/* js/admin/referrals.js — Referrals management tab. */

import { admin } from '../api.js';
import { el, peso } from '../dom.js';
import { renderLoading, renderEmpty, renderError, toast } from '../states.js';

const STATUS_TABS = ['all', 'available', 'paid', 'void'];

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusBadge(status) {
  const map = { available: 'pub', paid: 'pub', void: 'disabled', pending: 'draft' };
  return el('span', { class: `badge ${map[status] || 'draft'}`, text: status || '—' });
}

function th(text) {
  return el('th', { text, attrs: { style: 'text-align:left;padding:.5rem .75rem;border-bottom:2px solid var(--border);white-space:nowrap' } });
}

function td(tr, text) {
  tr.appendChild(el('td', { text: String(text ?? '—'), attrs: { style: 'padding:.5rem .75rem;border-bottom:1px solid var(--border)' } }));
}

function renderList(container, referrals, onMutate) {
  if (!referrals.length) {
    renderEmpty(container, 'No referrals found.');
    return;
  }

  const wrap = el('div', { attrs: { style: 'overflow-x:auto' } });
  const t = el('table', { attrs: { style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)' } });
  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Referrer', 'Buyer', 'Product', 'Amount', 'Reward', 'Status', 'Created', 'Paid', 'Actions']) {
    hrow.appendChild(th(h));
  }
  thead.appendChild(hrow);
  t.appendChild(thead);

  const tbody = el('tbody');
  for (const r of referrals) {
    const tr = el('tr');
    td(tr, r.referrer_email ?? r.referrer_ref_code ?? '—');
    td(tr, r.buyer_masked ?? '—');
    td(tr, r.product_title ?? '—');
    td(tr, peso(r.amount_php));
    td(tr, r.reward_type ?? '—');

    const stTd = el('td', { attrs: { style: 'padding:.5rem .75rem;border-bottom:1px solid var(--border)' } });
    stTd.appendChild(statusBadge(r.status));
    tr.appendChild(stTd);

    td(tr, fmtDate(r.created_at));
    td(tr, fmtDate(r.paid_at));

    const actTd = el('td', { attrs: { style: 'padding:.5rem .75rem;white-space:nowrap' } });

    if (r.status === 'available') {
      const paidBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Mark Paid', attrs: { style: 'margin-right:.3rem' } });
      paidBtn.addEventListener('click', async () => {
        if (!confirm('Mark this referral as paid? This cannot be undone.')) return;
        paidBtn.disabled = true;
        try {
          await admin.markReferralPaid(r.id);
          toast('Referral marked paid.');
          onMutate();
        } catch (err) { toast(err.message, 'error'); paidBtn.disabled = false; }
      });
      actTd.appendChild(paidBtn);
    }

    if (r.status !== 'void') {
      const voidBtn = el('button', { class: 'btn btn--danger btn--sm', text: 'Void' });
      voidBtn.addEventListener('click', async () => {
        const notes = prompt('Reason for voiding (optional):') ?? '';
        if (!confirm('Void this referral? This cannot be undone.')) return;
        voidBtn.disabled = true;
        try {
          await admin.voidReferral(r.id, notes || null);
          toast('Referral voided.');
          onMutate();
        } catch (err) { toast(err.message, 'error'); voidBtn.disabled = false; }
      });
      actTd.appendChild(voidBtn);
    }

    tr.appendChild(actTd);
    tbody.appendChild(tr);
  }

  t.appendChild(tbody);
  wrap.appendChild(t);
  container.appendChild(wrap);
}

export async function init(container, params) {
  container.innerHTML = '';
  container.appendChild(el('h2', { text: 'Referrals', attrs: { style: 'margin:0 0 1.25rem' } }));

  // Status filter tabs
  let activeStatus = 'all';
  let page = 1;

  const filterBar = el('div', { attrs: { style: 'display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem' } });
  const tabBtns = {};
  for (const s of STATUS_TABS) {
    const btn = el('button', {
      class: `btn btn--outline btn--sm${s === activeStatus ? '' : ''}`,
      text: s.charAt(0).toUpperCase() + s.slice(1),
    });
    btn.addEventListener('click', () => {
      activeStatus = s;
      page = 1;
      for (const [k, b] of Object.entries(tabBtns)) {
        b.style.fontWeight = k === s ? '800' : '';
        b.style.borderColor = k === s ? 'var(--secondary)' : '';
        b.style.color = k === s ? 'var(--secondary)' : '';
      }
      load();
    });
    tabBtns[s] = btn;
    filterBar.appendChild(btn);
  }
  // Highlight active
  tabBtns[activeStatus].style.fontWeight = '800';
  tabBtns[activeStatus].style.borderColor = 'var(--secondary)';
  tabBtns[activeStatus].style.color = 'var(--secondary)';
  container.appendChild(filterBar);

  const listArea = el('div');
  container.appendChild(listArea);

  const pagArea = el('div', { attrs: { style: 'display:flex;gap:.5rem;margin-top:1rem;align-items:center' } });
  const prevBtn = el('button', { class: 'btn btn--outline btn--sm', text: '← Prev' });
  const nextBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Next →' });
  const pageLabel = el('span', { attrs: { style: 'font-size:var(--fs-xs);color:var(--muted)' } });
  prevBtn.addEventListener('click', () => { if (page > 1) { page--; load(); } });
  nextBtn.addEventListener('click', () => { page++; load(); });
  pagArea.appendChild(prevBtn); pagArea.appendChild(pageLabel); pagArea.appendChild(nextBtn);
  container.appendChild(pagArea);

  async function load() {
    renderLoading(listArea, 'Loading referrals…');
    prevBtn.disabled = page <= 1;
    pageLabel.textContent = `Page ${page}`;

    try {
      const queryParams = { page };
      if (activeStatus !== 'all') queryParams.status = activeStatus;
      const res = await admin.listReferrals(queryParams);
      const referrals = res.referrals ?? res ?? [];
      listArea.innerHTML = '';
      nextBtn.disabled = referrals.length < 25;
      renderList(listArea, referrals, load);
    } catch (err) {
      renderError(listArea, err.message, load);
    }
  }

  load();
}
