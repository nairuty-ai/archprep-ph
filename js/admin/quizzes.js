/* js/admin/quizzes.js — Quizzes management tab. */

import { admin } from '../api.js';
import { el, $ } from '../dom.js';
import { renderLoading, renderEmpty, renderError, toast } from '../states.js';

// ---- helpers ----------------------------------------------------------------

function slugify(str) {
  return str.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function badge(published) {
  return el('span', { class: `badge ${published ? 'pub' : 'draft'}`, text: published ? 'Published' : 'Draft' });
}

// ---- form builder ----------------------------------------------------------

function buildForm(quiz, allProducts, onSave, onCancel) {
  const form = el('div', { class: 'admin-form' });

  const titleInput   = inp('text', quiz?.title || '', 'Quiz title');
  const slugInput    = inp('text', quiz?.slug || '', 'quiz-slug');
  const subjectInput = inp('text', quiz?.subject || '', 'e.g. Mathematics');
  const timerInput   = inp('number', quiz?.timer_minutes ?? 0, '0 = no timer');
  const pubCheck     = checkbox('Published', quiz?.published ?? false);

  if (!quiz) {
    titleInput.addEventListener('input', () => {
      if (!slugInput.dataset.touched) slugInput.value = slugify(titleInput.value);
    });
    slugInput.addEventListener('input', () => { slugInput.dataset.touched = '1'; });
  }

  // Pack assignment checklist
  const packs = allProducts.filter((p) => p.type === 'quiz_pack');
  const assignedIds = quiz?._pack_ids ?? [];
  const packSection = el('div', { attrs: { style: 'margin-top:1rem' } });
  packSection.appendChild(el('p', { text: 'Assign to quiz packs', attrs: { style: 'font-weight:700;margin-bottom:.5rem' } }));
  const packChecks = [];
  if (packs.length === 0) {
    packSection.appendChild(el('p', { text: 'No quiz_pack products yet.', attrs: { style: 'color:var(--muted);font-size:var(--fs-xs)' } }));
  } else {
    for (const pack of packs) {
      const row = el('div', { attrs: { style: 'display:flex;align-items:center;gap:.5rem;margin-bottom:.35rem' } });
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = pack.id;
      cb.checked = assignedIds.includes(pack.id);
      cb.style.width = '18px';
      cb.style.height = '18px';
      cb.style.accentColor = 'var(--accent)';
      row.appendChild(cb);
      row.appendChild(el('label', { text: pack.title }));
      packSection.appendChild(row);
      packChecks.push(cb);
    }
  }

  const errDiv = el('div', { class: 'alert alert--error', attrs: { hidden: '' } });
  const saveBtn = el('button', { class: 'btn btn--primary', text: quiz ? 'Save changes' : 'Create quiz' });
  const cancelBtn = el('button', { class: 'btn btn--outline', text: 'Cancel', attrs: { type: 'button' } });

  saveBtn.addEventListener('click', async () => {
    errDiv.hidden = true;
    const titleVal = titleInput.value.trim();
    const slugVal  = slugInput.value.trim();
    if (!titleVal) { showErr('Title is required.'); return; }
    if (!slugVal)  { showErr('Slug is required.'); return; }

    const body = {
      title: titleVal,
      slug: slugVal,
      subject: subjectInput.value.trim(),
      timer_minutes: Number(timerInput.value) || 0,
      published: pubCheck.checked,
    };

    if (quiz) body.quiz_id = quiz.id;

    saveBtn.disabled = true;
    try {
      let savedId = quiz?.id;
      if (quiz) {
        await admin.updateQuiz(body);
        toast('Quiz updated.');
      } else {
        const res = await admin.createQuiz(body);
        savedId = res.quiz_id ?? res.id;
        toast('Quiz created.');
      }

      // Save pack assignments
      if (savedId && packs.length > 0) {
        const selectedIds = packChecks.filter((c) => c.checked).map((c) => c.value);
        await admin.assignPacks({ quiz_id: savedId, product_ids: selectedIds });
      }

      onSave();
    } catch (err) {
      showErr(err.message);
      saveBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener('click', onCancel);

  function showErr(msg) { errDiv.textContent = msg; errDiv.hidden = false; }

  appendRow(form, 'Title', titleInput);
  appendRow(form, 'Slug', slugInput);
  appendRow(form, 'Subject', subjectInput);
  appendRow(form, 'Timer (minutes, 0 = none)', timerInput);
  appendRow(form, 'Status', pubCheck.parentElement);
  form.appendChild(packSection);
  form.appendChild(errDiv);

  const actions = el('div', { attrs: { style: 'display:flex;gap:.5rem;margin-top:1.25rem;flex-wrap:wrap' } });
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(actions);

  return form;
}

// ---- list renderer ---------------------------------------------------------

function renderList(container, quizzes, allProducts, onMutate, onManageQuestions) {
  if (!quizzes.length) {
    renderEmpty(container, 'No quizzes yet.');
    return;
  }

  const wrap = el('div', { attrs: { style: 'overflow-x:auto' } });
  const t = el('table', { attrs: { style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)' } });
  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Title', 'Subject', 'Timer', 'Questions', 'Status', 'Actions']) {
    hrow.appendChild(th(h));
  }
  thead.appendChild(hrow);
  t.appendChild(thead);

  const tbody = el('tbody');

  for (const q of quizzes) {
    const tr = el('tr', { attrs: { 'data-quiz-id': q.id } });
    td(tr, q.title);
    td(tr, q.subject || '—');
    td(tr, q.timer_minutes ? `${q.timer_minutes} min` : 'None');
    td(tr, String(q.question_count ?? '—'));

    const stTd = el('td', { attrs: { style: 'padding:.5rem .75rem' } });
    stTd.appendChild(badge(q.published));
    tr.appendChild(stTd);

    const actTd = el('td', { attrs: { style: 'padding:.5rem .75rem;white-space:nowrap' } });

    const editBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Edit', attrs: { style: 'margin-right:.3rem' } });
    editBtn.addEventListener('click', () => {
      const formRow = el('tr');
      const formCell = el('td', { attrs: { colspan: '6', style: 'padding:.75rem' } });
      const form = buildForm(q, allProducts, () => { formRow.remove(); onMutate(); }, () => { formRow.remove(); });
      formCell.appendChild(form);
      formRow.appendChild(formCell);
      tr.after(formRow);
      editBtn.disabled = true;
    });

    const mqBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Questions', attrs: { style: 'margin-right:.3rem' } });
    mqBtn.addEventListener('click', () => onManageQuestions(q.id));

    const pubBtn = el('button', {
      class: 'btn btn--outline btn--sm',
      text: q.published ? 'Unpublish' : 'Publish',
      attrs: { style: 'margin-right:.3rem' },
    });
    pubBtn.addEventListener('click', async () => {
      pubBtn.disabled = true;
      try {
        // Quizzes use updateQuiz to flip published flag
        await admin.updateQuiz({ quiz_id: q.id, published: !q.published });
        toast(q.published ? 'Quiz unpublished.' : 'Quiz published.');
        onMutate();
      } catch (err) { toast(err.message, 'error'); pubBtn.disabled = false; }
    });

    const delBtn = el('button', { class: 'btn btn--danger btn--sm', text: 'Delete' });
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this quiz and all its questions? This cannot be undone.')) return;
      delBtn.disabled = true;
      try {
        await admin.deleteQuiz(q.id);
        toast('Quiz deleted.');
        onMutate();
      } catch (err) { toast(err.message, 'error'); delBtn.disabled = false; }
    });

    actTd.appendChild(editBtn);
    actTd.appendChild(mqBtn);
    actTd.appendChild(pubBtn);
    actTd.appendChild(delBtn);
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  }

  t.appendChild(tbody);
  wrap.appendChild(t);
  container.appendChild(wrap);
}

// ---- DOM helpers ------------------------------------------------------------

function inp(type, value, placeholder) {
  const i = document.createElement('input');
  i.type = type; i.value = value; i.placeholder = placeholder;
  i.style.cssText = 'width:100%;min-height:var(--tap);padding:.55rem .85rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);';
  return i;
}

function checkbox(label, checked) {
  const wrap = el('div', { attrs: { style: 'display:flex;align-items:center;gap:.5rem' } });
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = checked;
  cb.style.width = '20px'; cb.style.height = '20px'; cb.style.accentColor = 'var(--accent)';
  wrap.appendChild(cb);
  wrap.appendChild(el('label', { text: label }));
  return cb;
}

function appendRow(form, label, control) {
  const row = el('div', { attrs: { style: 'margin-bottom:.85rem' } });
  row.appendChild(el('label', { text: label, attrs: { style: 'display:block;font-weight:700;font-size:var(--fs-xs);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)' } }));
  row.appendChild(control);
  form.appendChild(row);
}

function th(text) {
  return el('th', { text, attrs: { style: 'text-align:left;padding:.5rem .75rem;border-bottom:2px solid var(--border);white-space:nowrap' } });
}

function td(tr, text) {
  tr.appendChild(el('td', { text: String(text ?? '—'), attrs: { style: 'padding:.5rem .75rem;border-bottom:1px solid var(--border)' } }));
}

// ---- init ------------------------------------------------------------------

export async function init(container, params) {
  container.innerHTML = '';

  const head = el('div', { class: 'section-head' });
  head.appendChild(el('h2', { text: 'Quizzes', attrs: { style: 'margin:0' } }));
  const addBtn = el('button', { class: 'btn btn--primary btn--sm', text: '+ Add Quiz' });
  head.appendChild(addBtn);
  container.appendChild(head);

  let formVisible = false;
  let formEl = null;
  let allProducts = [];

  const listArea = el('div');
  container.appendChild(listArea);

  addBtn.addEventListener('click', () => {
    if (formVisible && formEl) { formEl.remove(); formVisible = false; addBtn.textContent = '+ Add Quiz'; return; }
    formEl = buildForm(null, allProducts,
      () => { formEl.remove(); formVisible = false; addBtn.textContent = '+ Add Quiz'; load(); },
      () => { formEl.remove(); formVisible = false; addBtn.textContent = '+ Add Quiz'; });
    container.insertBefore(formEl, listArea);
    formVisible = true;
    addBtn.textContent = '− Cancel';
  });

  function onManageQuestions(quizId) {
    // Navigate to Questions tab — push state and fire popstate so index.js re-routes.
    const sp = new URLSearchParams();
    sp.set('tab', 'questions');
    sp.set('quiz_id', quizId);
    history.pushState({}, '', `?${sp}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  async function load() {
    renderLoading(listArea, 'Loading quizzes…');
    try {
      const [qRes, pRes] = await Promise.all([admin.listQuizzes(), admin.listProducts()]);
      const quizzes  = qRes.quizzes  ?? qRes  ?? [];
      allProducts    = pRes.products  ?? pRes  ?? [];
      listArea.innerHTML = '';
      renderList(listArea, quizzes, allProducts, load, onManageQuestions);
    } catch (err) {
      renderError(listArea, err.message, load);
    }
  }

  load();
}
