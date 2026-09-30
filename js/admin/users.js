/* js/admin/users.js — Users management tab. */

import { admin } from '../api.js';
import { el } from '../dom.js';
import { renderLoading, renderEmpty, renderError, toast } from '../states.js';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function th(text) {
  return el('th', { text, attrs: { style: 'text-align:left;padding:.5rem .75rem;border-bottom:2px solid var(--border);white-space:nowrap' } });
}

function td(tr, text) {
  tr.appendChild(el('td', { text: String(text ?? '—'), attrs: { style: 'padding:.5rem .75rem;border-bottom:1px solid var(--border)' } }));
}

function renderList(container, users, onMutate) {
  if (!users.length) {
    renderEmpty(container, 'No users found.');
    return;
  }

  const wrap = el('div', { attrs: { style: 'overflow-x:auto' } });
  const t = el('table', { attrs: { style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)' } });

  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Email', 'Name', 'Admin', 'Ref code', 'Joined', 'Actions']) hrow.appendChild(th(h));
  thead.appendChild(hrow);
  t.appendChild(thead);

  const tbody = el('tbody');
  for (const u of users) {
    const tr = el('tr');
    td(tr, u.email);
    td(tr, u.display_name || '—');

    // Admin badge cell
    const adminTd = el('td', { attrs: { style: 'padding:.5rem .75rem;border-bottom:1px solid var(--border)' } });
    if (u.is_admin) {
      adminTd.appendChild(el('span', { class: 'badge pub', text: 'Admin' }));
    }
    tr.appendChild(adminTd);

    td(tr, u.ref_code || '—');
    td(tr, fmtDate(u.created_at));

    const actTd = el('td', { attrs: { style: 'padding:.5rem .75rem;white-space:nowrap' } });

    if (!u.is_admin) {
      const grantBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Grant Admin' });
      grantBtn.addEventListener('click', async () => {
        if (!confirm(`Grant admin privileges to ${u.email}? They will have full access to this portal.`)) return;
        grantBtn.disabled = true;
        try {
          await admin.grantAdmin(u.email);
          toast(`Admin granted to ${u.email}.`);
          onMutate();
        } catch (err) { toast(err.message, 'error'); grantBtn.disabled = false; }
      });
      actTd.appendChild(grantBtn);
    } else {
      const revokeBtn = el('button', { class: 'btn btn--danger btn--sm', text: 'Revoke Admin' });
      revokeBtn.addEventListener('click', async () => {
        if (!confirm(`Revoke admin privileges from ${u.email}? Make sure at least one other admin exists.`)) return;
        revokeBtn.disabled = true;
        try {
          await admin.revokeAdmin(u.email);
          toast(`Admin revoked from ${u.email}.`);
          onMutate();
        } catch (err) { toast(err.message, 'error'); revokeBtn.disabled = false; }
      });
      actTd.appendChild(revokeBtn);
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
  container.appendChild(el('h2', { text: 'Users', attrs: { style: 'margin:0 0 1.25rem' } }));

  // Search bar
  const searchRow = el('div', { attrs: { style: 'display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem' } });
  const searchInp = document.createElement('input');
  searchInp.type = 'email';
  searchInp.placeholder = 'Search by email…';
  searchInp.style.cssText = 'min-height:var(--tap);padding:.45rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);min-width:240px;';
  const searchBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Search' });
  const clearBtn  = el('button', { class: 'btn btn--outline btn--sm', text: 'Clear' });
  searchRow.appendChild(searchInp);
  searchRow.appendChild(searchBtn);
  searchRow.appendChild(clearBtn);
  container.appendChild(searchRow);

  const listArea = el('div');
  container.appendChild(listArea);

  // Pagination
  let page = 1;
  let searchEmail = '';
  const pagArea = el('div', { attrs: { style: 'display:flex;gap:.5rem;margin-top:1rem;align-items:center' } });
  const prevBtn = el('button', { class: 'btn btn--outline btn--sm', text: '← Prev' });
  const nextBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Next →' });
  const pageLabel = el('span', { attrs: { style: 'font-size:var(--fs-xs);color:var(--muted)' } });
  prevBtn.addEventListener('click', () => { if (page > 1) { page--; load(); } });
  nextBtn.addEventListener('click', () => { page++; load(); });
  pagArea.appendChild(prevBtn); pagArea.appendChild(pageLabel); pagArea.appendChild(nextBtn);
  container.appendChild(pagArea);

  function doSearch() {
    searchEmail = searchInp.value.trim();
    page = 1;
    load();
  }

  searchBtn.addEventListener('click', doSearch);
  searchInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  clearBtn.addEventListener('click', () => { searchInp.value = ''; searchEmail = ''; page = 1; load(); });

  async function load() {
    renderLoading(listArea, 'Loading users…');
    prevBtn.disabled = page <= 1;
    pageLabel.textContent = `Page ${page}`;

    try {
      const queryParams = { page };
      if (searchEmail) queryParams.email = searchEmail;
      const res = await admin.listUsers(queryParams);
      const users = res.users ?? res ?? [];
      listArea.innerHTML = '';
      nextBtn.disabled = users.length < 25;
      renderList(listArea, users, load);
    } catch (err) {
      renderError(listArea, err.message, load);
    }
  }

  load();
}
