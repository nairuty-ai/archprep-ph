/* js/admin/payouts.js — Payout requests management tab. */

import { admin } from '../api.js';
import { el, peso } from '../dom.js';
import { renderLoading, renderEmpty, renderError, toast } from '../states.js';

const STATUS_TABS = ['all', 'requested', 'paid', 'rejected'];

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusBadge(status) {
  const map = { paid: 'pub', rejected: 'disabled', requested: 'draft' };
  return el('span', { class: `badge ${map[status] || 'draft'}`, text: status || '—' });
}

function th(text) {
  return el('th', { text, attrs: { style: 'text-align:left;padding:.5rem .75rem;border-bottom:2px solid var(--border);white-space:nowrap' } });
}

function td(tr, text) {
  tr.appendChild(el('td', { text: String(text ?? '—'), attrs: { style: 'padding:.5rem .75rem;border-bottom:1px solid var(--border)' } }));
}

function renderList(container, payouts, onMutate) {
  if (!payouts.length) {
    renderEmpty(container, 'No payout requests found.');
    return;
  }

  const wrap = el('div', { attrs: { style: 'overflow-x:auto' } });
  const t = el('table', { attrs: { style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)' } });

  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Email', 'Amount', 'GCash', 'Status', 'Requested', 'Actions']) hrow.appendChild(th(h));
  thead.appendChild(hrow);
  t.appendChild(thead);

  const tbody = el('tbody');
  for (const p of payouts) {
    const tr = el('tr');
    td(tr, p.user_email ?? p.email ?? '—');
    td(tr, peso(p.amount_php ?? p.amount));
    td(tr, p.gcash_number ?? '—');

    const stTd = el('td', { attrs: { style: 'padding:.5rem .75rem;border-bottom:1px solid var(--border)' } });
    stTd.appendChild(statusBadge(p.status));
    tr.appendChild(stTd);

    td(tr, fmtDate(p.created_at));

    const actTd = el('td', { attrs: { style: 'padding:.5rem .75rem;white-space:nowrap' } });

    if (p.status === 'requested') {
      const notesInput = document.createElement('input');
      notesInput.type = 'text';
      notesInput.placeholder = 'Notes (optional)';
      notesInput.style.cssText = 'min-height:32px;padding:.3rem .6rem;border:1px solid var(--border);border-radius:6px;font-size:var(--fs-xs);width:140px;margin-right:.4rem;';

      const paidBtn = el('button', { class: 'btn btn--outline btn--sm', text: '✓ Mark Paid', attrs: { style: 'margin-right:.3rem' } });
      paidBtn.addEventListener('click', async () => {
        if (!confirm(`Mark payout of ${peso(p.amount_php ?? p.amount)} to ${p.gcash_number} as paid?`)) return;
        paidBtn.disabled = true;
        try {
          await admin.handlePayout({ payout_request_id: p.id, status: 'paid', notes: notesInput.value.trim() || null });
          toast('Payout marked as paid.');
          onMutate();
        } catch (err) { toast(err.message, 'error'); paidBtn.disabled = false; }
      });

      const rejectBtn = el('button', { class: 'btn btn--danger btn--sm', text: '✕ Reject' });
      rejectBtn.addEventListener('click', async () => {
        if (!confirm('Reject this payout request?')) return;
        rejectBtn.disabled = true;
        try {
          await admin.handlePayout({ payout_request_id: p.id, status: 'rejected', notes: notesInput.value.trim() || null });
          toast('Payout rejected.');
          onMutate();
        } catch (err) { toast(err.message, 'error'); rejectBtn.disabled = false; }
      });

      actTd.appendChild(notesInput);
      actTd.appendChild(paidBtn);
      actTd.appendChild(rejectBtn);
    } else {
      if (p.notes) {
        actTd.appendChild(el('span', { text: p.notes, attrs: { style: 'font-size:var(--fs-xs);color:var(--muted)' } }));
      }
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
  container.appendChild(el('h2', { text: 'Payout Requests', attrs: { style: 'margin:0 0 1.25rem' } }));

  let activeStatus = 'all';
  let page = 1;

  const filterBar = el('div', { attrs: { style: 'display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem' } });
  const tabBtns = {};
  for (const s of STATUS_TABS) {
    const btn = el('button', { class: 'btn btn--outline btn--sm', text: s.charAt(0).toUpperCase() + s.slice(1) });
    btn.addEventListener('click', () => {
      activeStatus = s; page = 1;
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
    renderLoading(listArea, 'Loading payout requests…');
    prevBtn.disabled = page <= 1;
    pageLabel.textContent = `Page ${page}`;

    try {
      const queryParams = { page };
      if (activeStatus !== 'all') queryParams.status = activeStatus;
      const res = await admin.listPayoutRequests(queryParams);
      const payouts = res.payout_requests ?? res.payouts ?? res ?? [];
      listArea.innerHTML = '';
      nextBtn.disabled = payouts.length < 25;
      renderList(listArea, payouts, load);
    } catch (err) {
      renderError(listArea, err.message, load);
    }
  }

  load();
}
