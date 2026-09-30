/* js/admin/incidents.js — Payment incidents management tab. */

import { admin } from '../api.js';
import { el } from '../dom.js';
import { renderLoading, renderEmpty, renderError, toast } from '../states.js';

// Kind → color mapping
const KIND_COLORS = {
  amount_mismatch:    { bg: '#FFF7E6', border: '#F5A623', text: '#7A4A00' },
  unmatched_payment:  { bg: '#FBEDEF', border: '#E87B7B', text: '#7A2530' },
  duplicate_payment:  { bg: '#FBF1EA', border: '#C2703D', text: '#6B3820' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function kindStyle(kind) {
  const c = KIND_COLORS[kind];
  if (!c) return '';
  return `background:${c.bg};border-left:4px solid ${c.border};color:${c.text};`;
}

function th(text) {
  return el('th', { text, attrs: { style: 'text-align:left;padding:.5rem .75rem;border-bottom:2px solid var(--border);white-space:nowrap' } });
}

function td(tr, text, style) {
  const cell = el('td', { text: String(text ?? '—'), attrs: { style: `padding:.5rem .75rem;border-bottom:1px solid var(--border);${style || ''}` } });
  tr.appendChild(cell);
}

function renderList(container, incidents, onMutate) {
  if (!incidents.length) {
    renderEmpty(container, 'No incidents found.');
    return;
  }

  const wrap = el('div', { attrs: { style: 'overflow-x:auto' } });
  const t = el('table', { attrs: { style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)' } });

  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Kind', 'HitPay ID', 'Rep. Amount', 'Rep. Curr.', 'Stored Amount', 'Stored Curr.', 'Created', 'Resolved', 'Actions']) {
    hrow.appendChild(th(h));
  }
  thead.appendChild(hrow);
  t.appendChild(thead);

  const tbody = el('tbody');
  for (const inc of incidents) {
    const rowStyle = kindStyle(inc.kind);
    const tr = el('tr', { attrs: { style: rowStyle ? 'background:inherit' : '' } });

    const kindTd = el('td', { attrs: { style: `padding:.5rem .75rem;border-bottom:1px solid var(--border);${rowStyle}font-weight:700;white-space:nowrap` } });
    kindTd.textContent = inc.kind || '—';
    tr.appendChild(kindTd);

    td(tr, inc.hitpay_payment_id ? inc.hitpay_payment_id.slice(0, 16) + '…' : '—');
    td(tr, inc.reported_amount ?? '—');
    td(tr, inc.reported_currency ?? '—');
    td(tr, inc.stored_amount ?? '—');
    td(tr, inc.stored_currency ?? '—');
    td(tr, fmtDate(inc.created_at));
    td(tr, inc.resolved_at ? fmtDate(inc.resolved_at) : '—');

    const actTd = el('td', { attrs: { style: 'padding:.5rem .75rem' } });

    if (!inc.resolved_at) {
      const resolveBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Resolve' });
      resolveBtn.addEventListener('click', async () => {
        if (!confirm('Mark this incident as resolved?')) return;
        resolveBtn.disabled = true;
        try {
          await admin.resolveIncident(inc.id);
          toast('Incident resolved.');
          onMutate();
        } catch (err) { toast(err.message, 'error'); resolveBtn.disabled = false; }
      });
      actTd.appendChild(resolveBtn);
    } else {
      actTd.appendChild(el('span', { text: 'Resolved', attrs: { style: 'color:var(--success);font-weight:700;font-size:var(--fs-xs)' } }));
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

  const head = el('div', { class: 'section-head' });
  head.appendChild(el('h2', { text: 'Payment Incidents', attrs: { style: 'margin:0' } }));
  container.appendChild(head);

  // Show resolved toggle
  const toggleRow = el('div', { attrs: { style: 'display:flex;align-items:center;gap:.6rem;margin-bottom:1rem' } });
  const resolvedCb = document.createElement('input');
  resolvedCb.type = 'checkbox';
  resolvedCb.id = 'inc-show-resolved';
  resolvedCb.style.cssText = 'width:18px;height:18px;accent-color:var(--accent)';
  const cbLabel = el('label', { text: 'Include resolved incidents', attrs: { for: 'inc-show-resolved', style: 'font-weight:600;cursor:pointer' } });
  toggleRow.appendChild(resolvedCb);
  toggleRow.appendChild(cbLabel);
  container.appendChild(toggleRow);

  const listArea = el('div');
  container.appendChild(listArea);

  resolvedCb.addEventListener('change', load);

  async function load() {
    renderLoading(listArea, 'Loading incidents…');
    try {
      const params = resolvedCb.checked ? { include_resolved: true } : {};
      const res = await admin.listIncidents(params);
      const incidents = res.incidents ?? res ?? [];
      listArea.innerHTML = '';

      // Legend
      const legend = el('div', { attrs: { style: 'display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem' } });
      for (const [kind, colors] of Object.entries(KIND_COLORS)) {
        const chip = el('span', { text: kind, attrs: { style: `background:${colors.bg};border:1px solid ${colors.border};color:${colors.text};padding:.2rem .6rem;border-radius:999px;font-size:var(--fs-xs);font-weight:700;` } });
        legend.appendChild(chip);
      }
      if (incidents.length) listArea.appendChild(legend);

      renderList(listArea, incidents, load);
    } catch (err) {
      renderError(listArea, err.message, load);
    }
  }

  load();
}
