/* js/admin/enrollments.js — Enrollments management tab. */

import { admin } from '../api.js';
import { el } from '../dom.js';
import { renderLoading, renderEmpty, renderError, toast } from '../states.js';

// ---- helpers ---------------------------------------------------------------

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function inp(type, value, placeholder) {
  const i = document.createElement('input');
  i.type = type; i.value = value; i.placeholder = placeholder;
  i.style.cssText = 'min-height:var(--tap);padding:.45rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);';
  return i;
}

function th(text) {
  return el('th', { text, attrs: { style: 'text-align:left;padding:.5rem .75rem;border-bottom:2px solid var(--border);white-space:nowrap' } });
}

function td(tr, text) {
  tr.appendChild(el('td', { text: String(text ?? '—'), attrs: { style: 'padding:.5rem .75rem;border-bottom:1px solid var(--border)' } }));
}

// ---- list renderer ---------------------------------------------------------

function renderList(container, enrollments, products, onMutate) {
  if (!enrollments.length) {
    renderEmpty(container, 'No enrollments found.');
    return;
  }

  const productMap = Object.fromEntries((products ?? []).map((p) => [p.id, p.title]));

  const wrap = el('div', { attrs: { style: 'overflow-x:auto' } });
  const t = el('table', { attrs: { style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)' } });

  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Email', 'Product', 'Source', 'Created', 'Actions']) hrow.appendChild(th(h));
  thead.appendChild(hrow);
  t.appendChild(thead);

  const tbody = el('tbody');
  for (const en of enrollments) {
    const tr = el('tr');
    td(tr, en.user_email ?? en.email ?? '—');
    td(tr, productMap[en.product_id] || en.product_id);
    td(tr, en.source || '—');
    td(tr, fmtDate(en.created_at));

    const actTd = el('td', { attrs: { style: 'padding:.5rem .75rem' } });
    const revBtn = el('button', { class: 'btn btn--danger btn--sm', text: 'Revoke' });
    revBtn.addEventListener('click', async () => {
      if (!confirm(`Revoke access for this enrollment? The user will lose access immediately.`)) return;
      revBtn.disabled = true;
      try {
        await admin.revokeAccess({ user_id: en.user_id, product_id: en.product_id });
        toast('Access revoked.');
        onMutate();
      } catch (err) { toast(err.message, 'error'); revBtn.disabled = false; }
    });
    actTd.appendChild(revBtn);
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  }

  t.appendChild(tbody);
  wrap.appendChild(t);
  container.appendChild(wrap);
}

// ---- init ------------------------------------------------------------------

export async function init(container, params) {
  container.innerHTML = '';

  container.appendChild(el('h2', { text: 'Enrollments', attrs: { style: 'margin:0 0 1.25rem' } }));

  // Grant access form
  const grantForm = el('div', { class: 'admin-form', attrs: { style: 'margin-bottom:1.5rem' } });
  grantForm.appendChild(el('h3', { text: 'Grant Access', attrs: { style: 'margin:0 0 1rem' } }));

  let allProducts = [];
  try {
    const pRes = await admin.listProducts();
    allProducts = pRes.products ?? pRes ?? [];
  } catch (_) { /* ignore */ }

  const emailInp = inp('email', '', 'user@example.com');
  emailInp.style.width = '100%';

  const productSel = document.createElement('select');
  productSel.style.cssText = 'width:100%;min-height:var(--tap);padding:.45rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);';
  const pPlaceholder = document.createElement('option');
  pPlaceholder.value = ''; pPlaceholder.textContent = '— select product —';
  productSel.appendChild(pPlaceholder);
  for (const p of allProducts) {
    const o = document.createElement('option'); o.value = p.id; o.textContent = p.title; productSel.appendChild(o);
  }

  const sourceSel = document.createElement('select');
  sourceSel.style.cssText = 'width:100%;min-height:var(--tap);padding:.45rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);';
  for (const s of ['comp', 'credit']) {
    const o = document.createElement('option'); o.value = s; o.textContent = s; sourceSel.appendChild(o);
  }

  const grantErrDiv = el('div', { class: 'alert alert--error', attrs: { hidden: '' } });
  const grantBtn = el('button', { class: 'btn btn--primary', text: 'Grant access' });

  grantBtn.addEventListener('click', async () => {
    const email = emailInp.value.trim();
    const productId = productSel.value;
    if (!email) { grantErrDiv.textContent = 'Email is required.'; grantErrDiv.hidden = false; return; }
    if (!productId) { grantErrDiv.textContent = 'Select a product.'; grantErrDiv.hidden = false; return; }
    grantErrDiv.hidden = true;
    grantBtn.disabled = true;

    try {
      // First look up user_id from email via listUsers
      const uRes = await admin.listUsers({ email });
      const users = uRes.users ?? uRes ?? [];
      const user = users.find((u) => u.email === email);
      if (!user) throw new Error(`No user found with email ${email}`);
      await admin.grantAccess({ user_id: user.id, product_id: productId, source: sourceSel.value });
      toast('Access granted.');
      emailInp.value = '';
      productSel.value = '';
      load();
    } catch (err) {
      grantErrDiv.textContent = err.message; grantErrDiv.hidden = false;
    }
    grantBtn.disabled = false;
  });

  const row2 = el('div', { class: 'row2' });

  function frow(label, ctrl) {
    const d = el('div');
    d.appendChild(el('label', { text: label, attrs: { style: 'display:block;font-weight:700;font-size:var(--fs-xs);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)' } }));
    d.appendChild(ctrl);
    return d;
  }

  row2.appendChild(frow('Email', emailInp));
  row2.appendChild(frow('Product', productSel));

  grantForm.appendChild(row2);
  grantForm.appendChild(el('div', { attrs: { style: 'margin-top:.75rem' } }));
  grantForm.appendChild(frow('Source', sourceSel));
  grantForm.appendChild(grantErrDiv);
  const grantActions = el('div', { attrs: { style: 'margin-top:1rem' } });
  grantActions.appendChild(grantBtn);
  grantForm.appendChild(grantActions);
  container.appendChild(grantForm);

  // Search bar
  const searchArea = el('div', { attrs: { style: 'display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem' } });
  const searchInp = inp('email', '', 'Filter by email…');
  searchInp.style.minWidth = '240px';
  const searchBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Search' });
  searchArea.appendChild(searchInp);
  searchArea.appendChild(searchBtn);
  container.appendChild(searchArea);

  // Pagination
  let page = 1;
  let userId = null;
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

  searchBtn.addEventListener('click', async () => {
    const email = searchInp.value.trim();
    if (!email) { userId = null; page = 1; load(); return; }
    try {
      const uRes = await admin.listUsers({ email });
      const users = uRes.users ?? uRes ?? [];
      const user = users.find((u) => u.email === email);
      userId = user?.id || null;
      page = 1;
      load();
    } catch (err) { toast(err.message, 'error'); }
  });
  searchInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchBtn.click(); });

  async function load() {
    renderLoading(listArea, 'Loading enrollments…');
    prevBtn.disabled = page <= 1;
    pageLabel.textContent = `Page ${page}`;

    try {
      const queryParams = { page };
      if (userId) queryParams.user_id = userId;
      const res = await admin.listEnrollments(queryParams);
      const enrollments = res.enrollments ?? res ?? [];
      listArea.innerHTML = '';
      nextBtn.disabled = enrollments.length < 25;
      renderList(listArea, enrollments, allProducts, load);
    } catch (err) {
      renderError(listArea, err.message, load);
    }
  }

  load();
}
