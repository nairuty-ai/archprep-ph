/* js/admin/products.js — Products management tab. */

import { admin } from '../api.js';
import { el, $, peso } from '../dom.js';
import { renderLoading, renderEmpty, renderError, toast } from '../states.js';

// ---- shared helpers --------------------------------------------------------

function slugify(str) {
  return str.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function badge(published) {
  return el('span', {
    class: `badge ${published ? 'pub' : 'draft'}`,
    text: published ? 'Published' : 'Draft',
  });
}

function confirm(msg) {
  return window.confirm(msg);
}

// ---- form builder ----------------------------------------------------------

function buildProductForm(product, onSave, onCancel) {
  const form = el('div', { class: 'admin-form' });

  const titleInput   = input('text', product?.title || '', 'Product title');
  const slugInput    = input('text', product?.slug || '', 'e.g. ale-math-drills');
  const typeSelect   = select(['quiz_pack', 'material', 'bundle'], product?.type || 'quiz_pack');
  const priceInput   = input('number', product?.price_php ?? '', 'e.g. 299');
  const subjectInput = input('text', product?.subject || '', 'e.g. Mathematics');
  const subtitleInput= input('text', product?.subtitle || '', 'Short tagline');
  const sortInput    = input('number', product?.sort_order ?? 0, '0');
  const descArea     = textarea(product?.description || '', 'Full description');
  const includesInput= input('text', Array.isArray(product?.includes) ? product.includes.join(', ') : (product?.includes || ''), 'Comma-separated list');

  // Auto-slug from title if new product
  if (!product) {
    titleInput.addEventListener('input', () => {
      if (!slugInput.dataset.touched) {
        slugInput.value = slugify(titleInput.value);
      }
    });
    slugInput.addEventListener('input', () => { slugInput.dataset.touched = '1'; });
  }

  const errDiv = el('div', { class: 'alert alert--error', attrs: { hidden: '' } });

  const saveBtn = el('button', { class: 'btn btn--primary', text: product ? 'Save changes' : 'Create product' });
  const cancelBtn = el('button', { class: 'btn btn--outline', text: 'Cancel', attrs: { type: 'button' } });

  saveBtn.addEventListener('click', async () => {
    errDiv.hidden = true;
    const titleVal = titleInput.value.trim();
    const slugVal  = slugInput.value.trim();
    if (!titleVal) { showErr('Title is required.'); return; }
    if (!slugVal)  { showErr('Slug is required.'); return; }

    const includesRaw = includesInput.value.trim();
    const includesArr = includesRaw ? includesRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

    const body = {
      title: titleVal,
      slug: slugVal,
      type: typeSelect.value,
      price_php: Number(priceInput.value) || 0,
      subject: subjectInput.value.trim(),
      subtitle: subtitleInput.value.trim(),
      description: descArea.value.trim(),
      includes: includesArr,
      sort_order: Number(sortInput.value) || 0,
    };

    if (product) body.product_id = product.id;

    saveBtn.disabled = true;
    try {
      if (product) {
        await admin.updateProduct(body);
        toast('Product updated.');
      } else {
        await admin.createProduct(body);
        toast('Product created.');
      }
      onSave();
    } catch (err) {
      showErr(err.message);
      saveBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener('click', onCancel);

  function showErr(msg) {
    errDiv.textContent = msg;
    errDiv.hidden = false;
  }

  appendRow(form, 'Title', titleInput);
  appendRow(form, 'Slug', slugInput);
  appendRow(form, 'Type', typeSelect);
  appendRow(form, 'Price (PHP)', priceInput);
  appendRow(form, 'Subject', subjectInput);
  appendRow(form, 'Subtitle', subtitleInput);
  appendRow(form, 'Sort order', sortInput);
  appendRow(form, 'Description', descArea);
  appendRow(form, 'Includes (comma-separated)', includesInput);
  form.appendChild(errDiv);

  // File uploads shown only when editing
  if (product) {
    const thumbSection = el('div', { attrs: { style: 'margin-top:1rem' } });
    thumbSection.appendChild(el('p', { text: 'Thumbnail image', attrs: { style: 'font-weight:700;margin-bottom:.4rem' } }));
    const thumbInput = el('input', { attrs: { type: 'file', accept: 'image/*' } });
    const thumbBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Upload thumbnail', attrs: { type: 'button', style: 'margin-left:.5rem' } });
    thumbBtn.addEventListener('click', async () => {
      if (!thumbInput.files[0]) { toast('Select a file first.', 'error'); return; }
      thumbBtn.disabled = true;
      try {
        await admin.uploadThumbnail(product.id, thumbInput.files[0]);
        toast('Thumbnail uploaded.');
      } catch (err) { toast(err.message, 'error'); }
      thumbBtn.disabled = false;
    });
    const thumbRow = el('div', { attrs: { style: 'display:flex;align-items:center;gap:.5rem;flex-wrap:wrap' } });
    thumbRow.appendChild(thumbInput);
    thumbRow.appendChild(thumbBtn);
    thumbSection.appendChild(thumbRow);
    form.appendChild(thumbSection);

    const matSection = el('div', { attrs: { style: 'margin-top:1rem' } });
    matSection.appendChild(el('p', { text: 'Material file (PDF)', attrs: { style: 'font-weight:700;margin-bottom:.4rem' } }));
    const matInput = el('input', { attrs: { type: 'file', accept: '.pdf,.zip' } });
    const matBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Upload material', attrs: { type: 'button', style: 'margin-left:.5rem' } });
    matBtn.addEventListener('click', async () => {
      if (!matInput.files[0]) { toast('Select a file first.', 'error'); return; }
      matBtn.disabled = true;
      try {
        await admin.uploadMaterial(product.id, matInput.files[0]);
        toast('Material uploaded.');
      } catch (err) { toast(err.message, 'error'); }
      matBtn.disabled = false;
    });
    const matRow = el('div', { attrs: { style: 'display:flex;align-items:center;gap:.5rem;flex-wrap:wrap' } });
    matRow.appendChild(matInput);
    matRow.appendChild(matBtn);
    matSection.appendChild(matRow);
    form.appendChild(matSection);
  }

  const actions = el('div', { attrs: { style: 'display:flex;gap:.5rem;margin-top:1.25rem;flex-wrap:wrap' } });
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(actions);

  return form;
}

// ---- list renderer ---------------------------------------------------------

function renderList(container, products, onMutate) {
  if (!products.length) {
    renderEmpty(container, 'No products yet.', null, null);
    return;
  }

  const table = el('div', { attrs: { style: 'overflow-x:auto' } });
  const t = el('table', { attrs: { style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)' } });

  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Title', 'Type', 'Price', 'Subject', 'Status', 'Actions']) {
    const th = el('th', { text: h, attrs: { style: 'text-align:left;padding:.5rem .75rem;border-bottom:2px solid var(--border);white-space:nowrap' } });
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  t.appendChild(thead);

  const tbody = el('tbody');

  for (const p of products) {
    const tr = el('tr', { attrs: { 'data-product-id': p.id } });

    td(tr, p.title);
    td(tr, p.type);
    td(tr, peso(p.price_php));
    td(tr, p.subject || '—');

    const statusTd = el('td', { attrs: { style: 'padding:.5rem .75rem' } });
    statusTd.appendChild(badge(p.published));
    tr.appendChild(statusTd);

    const actionsTd = el('td', { attrs: { style: 'padding:.5rem .75rem;white-space:nowrap' } });

    const editBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Edit', attrs: { style: 'margin-right:.3rem' } });
    editBtn.addEventListener('click', () => {
      // Replace tbody row with inline edit form
      const formRow = el('tr');
      const formCell = el('td', { attrs: { colspan: '6', style: 'padding:.75rem' } });
      const form = buildProductForm(p, () => { onMutate(); }, () => { formRow.remove(); });
      formCell.appendChild(form);
      formRow.appendChild(formCell);
      tr.after(formRow);
      editBtn.disabled = true;
    });

    const pubBtn = el('button', {
      class: `btn btn--outline btn--sm`,
      text: p.published ? 'Unpublish' : 'Publish',
      attrs: { style: 'margin-right:.3rem' },
    });
    pubBtn.addEventListener('click', async () => {
      pubBtn.disabled = true;
      try {
        if (p.published) {
          await admin.unpublishProduct(p.id);
          toast('Product unpublished.');
        } else {
          await admin.publishProduct(p.id);
          toast('Product published.');
        }
        onMutate();
      } catch (err) { toast(err.message, 'error'); pubBtn.disabled = false; }
    });

    const delBtn = el('button', { class: 'btn btn--danger btn--sm', text: 'Delete' });
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this product? This cannot be undone.')) return;
      delBtn.disabled = true;
      try {
        await admin.deleteProduct(p.id);
        toast('Product deleted.');
        onMutate();
      } catch (err) { toast(err.message, 'error'); delBtn.disabled = false; }
    });

    actionsTd.appendChild(editBtn);
    actionsTd.appendChild(pubBtn);
    actionsTd.appendChild(delBtn);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }

  t.appendChild(tbody);
  table.appendChild(t);
  container.appendChild(table);
}

// ---- DOM helpers -----------------------------------------------------------

function input(type, value, placeholder) {
  const i = document.createElement('input');
  i.type = type;
  i.value = value;
  i.placeholder = placeholder;
  i.style.cssText = 'width:100%;min-height:var(--tap);padding:.55rem .85rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);';
  return i;
}

function textarea(value, placeholder) {
  const t = document.createElement('textarea');
  t.value = value;
  t.placeholder = placeholder;
  t.style.cssText = 'width:100%;min-height:80px;padding:.55rem .85rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);resize:vertical;';
  return t;
}

function select(options, selected) {
  const s = document.createElement('select');
  s.style.cssText = 'width:100%;min-height:var(--tap);padding:.45rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (opt === selected) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

function appendRow(form, label, control) {
  const row = el('div', { attrs: { style: 'margin-bottom:.85rem' } });
  const lbl = el('label', { text: label, attrs: { style: 'display:block;font-weight:700;font-size:var(--fs-xs);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)' } });
  row.appendChild(lbl);
  row.appendChild(control);
  form.appendChild(row);
}

function td(tr, text) {
  const cell = el('td', { text: String(text ?? '—'), attrs: { style: 'padding:.5rem .75rem;border-bottom:1px solid var(--border)' } });
  tr.appendChild(cell);
}

// ---- init ------------------------------------------------------------------

export async function init(container, params) {
  container.innerHTML = '';

  // Section header
  const head = el('div', { class: 'section-head' });
  head.appendChild(el('h2', { text: 'Products', attrs: { style: 'margin:0' } }));
  const addBtn = el('button', { class: 'btn btn--primary btn--sm', text: '+ Add Product' });
  head.appendChild(addBtn);
  container.appendChild(head);

  // Add product form (collapsible)
  let formVisible = false;
  let formEl = null;

  addBtn.addEventListener('click', () => {
    if (formVisible && formEl) { formEl.remove(); formVisible = false; addBtn.textContent = '+ Add Product'; return; }
    formEl = buildProductForm(null, () => { formEl.remove(); formVisible = false; addBtn.textContent = '+ Add Product'; load(); }, () => { formEl.remove(); formVisible = false; addBtn.textContent = '+ Add Product'; });
    container.insertBefore(formEl, listArea);
    formVisible = true;
    addBtn.textContent = '− Cancel';
  });

  const listArea = el('div');
  container.appendChild(listArea);

  async function load() {
    renderLoading(listArea, 'Loading products…');
    try {
      const data = await admin.listProducts();
      const products = data.products ?? data ?? [];
      listArea.innerHTML = '';
      renderList(listArea, products, load);
    } catch (err) {
      renderError(listArea, err.message, load);
    }
  }

  load();
}
