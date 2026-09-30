/* js/admin/questions.js — Questions management tab. */

import { admin } from '../api.js';
import { el } from '../dom.js';
import { renderLoading, renderEmpty, renderError, toast } from '../states.js';

// ---- option builder -------------------------------------------------------

function buildOptionsEditor(initialOptions) {
  // initialOptions: [{key, label}] or default ABCD
  const defaults = [
    { key: 'A', label: '' },
    { key: 'B', label: '' },
    { key: 'C', label: '' },
    { key: 'D', label: '' },
  ];
  const opts = initialOptions && initialOptions.length ? initialOptions.map((o) => ({ ...o })) : defaults;

  const container = el('div');
  const rows = el('div', { attrs: { id: 'opt-rows' } });
  container.appendChild(rows);

  function renderRows() {
    rows.innerHTML = '';
    opts.forEach((opt, i) => {
      const row = el('div', { class: 'opt-row', attrs: { style: 'display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem' } });

      const keyInp = document.createElement('input');
      keyInp.type = 'text'; keyInp.value = opt.key; keyInp.placeholder = 'Key';
      keyInp.style.cssText = 'width:52px;min-height:var(--tap);padding:.45rem .5rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-weight:700;text-align:center;text-transform:uppercase;';
      keyInp.addEventListener('input', () => { opts[i].key = keyInp.value.toUpperCase().slice(0, 4); });

      const labelInp = document.createElement('input');
      labelInp.type = 'text'; labelInp.value = opt.label; labelInp.placeholder = 'Option text';
      labelInp.style.cssText = 'flex:1;min-height:var(--tap);padding:.45rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);';
      labelInp.addEventListener('input', () => { opts[i].label = labelInp.value; });

      const delBtn = el('button', { class: 'btn btn--outline btn--sm', text: '✕', attrs: { type: 'button', title: 'Remove option' } });
      delBtn.addEventListener('click', () => { opts.splice(i, 1); renderRows(); });

      row.appendChild(keyInp);
      row.appendChild(labelInp);
      if (opts.length > 2) row.appendChild(delBtn);
      rows.appendChild(row);
    });
  }

  const addBtn = el('button', { class: 'btn btn--outline btn--sm', text: '+ Add option', attrs: { type: 'button', style: 'margin-top:.25rem' } });
  addBtn.addEventListener('click', () => {
    const nextKey = String.fromCharCode(65 + opts.length);
    opts.push({ key: nextKey, label: '' });
    renderRows();
  });

  container.appendChild(addBtn);
  renderRows();

  return {
    container,
    getOptions: () => opts.map((o) => ({ key: o.key.trim(), label: o.label.trim() })),
  };
}

// ---- question form ---------------------------------------------------------

function buildQuestionForm(question, quizId, onSave, onCancel) {
  const form = el('div', { class: 'admin-form' });

  const qText = document.createElement('textarea');
  qText.value = question?.question_text || '';
  qText.placeholder = 'Enter the question text…';
  qText.style.cssText = 'width:100%;min-height:80px;padding:.55rem .85rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);resize:vertical;';

  const { container: optsContainer, getOptions } = buildOptionsEditor(question?.options);

  const correctSelect = document.createElement('select');
  correctSelect.style.cssText = 'width:100%;min-height:var(--tap);padding:.45rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);';

  function refreshCorrectSelect() {
    const currentVal = correctSelect.value;
    correctSelect.innerHTML = '';
    for (const opt of getOptions()) {
      const o = document.createElement('option');
      o.value = opt.key;
      o.textContent = `${opt.key} — ${opt.label || '(no label)'}`;
      if (opt.key === (currentVal || question?.correct_key)) o.selected = true;
      correctSelect.appendChild(o);
    }
  }
  optsContainer.addEventListener('input', refreshCorrectSelect);
  refreshCorrectSelect();

  const explArea = document.createElement('textarea');
  explArea.value = question?.explanation || '';
  explArea.placeholder = 'Optional explanation shown after answering…';
  explArea.style.cssText = 'width:100%;min-height:60px;padding:.55rem .85rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);resize:vertical;';

  const errDiv = el('div', { class: 'alert alert--error', attrs: { hidden: '' } });
  const saveBtn = el('button', { class: 'btn btn--primary', text: question ? 'Save changes' : 'Add question' });
  const cancelBtn = el('button', { class: 'btn btn--outline', text: 'Cancel', attrs: { type: 'button' } });

  saveBtn.addEventListener('click', async () => {
    errDiv.hidden = true;
    const qt = qText.value.trim();
    if (!qt) { showErr('Question text is required.'); return; }
    const options = getOptions();
    if (options.length < 2) { showErr('At least 2 options required.'); return; }
    if (options.some((o) => !o.key || !o.label)) { showErr('All options must have a key and label.'); return; }
    const ck = correctSelect.value;
    if (!ck) { showErr('Select the correct answer.'); return; }

    const body = {
      quiz_id: quizId,
      question_text: qt,
      options,
      correct_key: ck,
      explanation: explArea.value.trim() || null,
    };
    if (question) body.question_id = question.id;

    saveBtn.disabled = true;
    try {
      if (question) { await admin.updateQuestion(body); toast('Question updated.'); }
      else          { await admin.createQuestion(body); toast('Question added.'); }
      onSave();
    } catch (err) { showErr(err.message); saveBtn.disabled = false; }
  });

  cancelBtn.addEventListener('click', onCancel);

  function showErr(msg) { errDiv.textContent = msg; errDiv.hidden = false; }

  appendRow(form, 'Question text', qText);
  appendRow(form, 'Options', optsContainer);
  appendRow(form, 'Correct answer', correctSelect);
  appendRow(form, 'Explanation (optional)', explArea);
  form.appendChild(errDiv);

  const actions = el('div', { attrs: { style: 'display:flex;gap:.5rem;margin-top:1.25rem;flex-wrap:wrap' } });
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(actions);

  return form;
}

// ---- list renderer ---------------------------------------------------------

function renderList(container, questions, quizId, onMutate) {
  if (!questions.length) {
    renderEmpty(container, 'No questions yet. Add the first one above.');
    return;
  }

  const wrap = el('div', { attrs: { style: 'overflow-x:auto' } });
  const t = el('table', { attrs: { style: 'width:100%;border-collapse:collapse;font-size:var(--fs-sm)' } });
  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['#', 'Question', 'Correct', 'Actions']) hrow.appendChild(th(h));
  thead.appendChild(hrow);
  t.appendChild(thead);

  const tbody = el('tbody');
  const ids = questions.map((q) => q.id);

  questions.forEach((q, idx) => {
    const tr = el('tr', { attrs: { 'data-qid': q.id } });
    td(tr, String(q.question_number ?? idx + 1));
    td(tr, q.question_text.length > 80 ? q.question_text.slice(0, 80) + '…' : q.question_text);
    td(tr, q.correct_key);

    const actTd = el('td', { attrs: { style: 'padding:.5rem .75rem;white-space:nowrap' } });

    // Up / Down reorder
    const upBtn = el('button', { class: 'btn btn--outline btn--sm', text: '↑', attrs: { title: 'Move up', style: 'margin-right:.2rem' } });
    upBtn.disabled = idx === 0;
    upBtn.addEventListener('click', async () => {
      const newIds = [...ids];
      [newIds[idx - 1], newIds[idx]] = [newIds[idx], newIds[idx - 1]];
      upBtn.disabled = true;
      try {
        await admin.reorderQuestions({ quiz_id: quizId, ordered_ids: newIds });
        toast('Reordered.');
        onMutate();
      } catch (err) { toast(err.message, 'error'); upBtn.disabled = false; }
    });

    const downBtn = el('button', { class: 'btn btn--outline btn--sm', text: '↓', attrs: { title: 'Move down', style: 'margin-right:.3rem' } });
    downBtn.disabled = idx === questions.length - 1;
    downBtn.addEventListener('click', async () => {
      const newIds = [...ids];
      [newIds[idx + 1], newIds[idx]] = [newIds[idx], newIds[idx + 1]];
      downBtn.disabled = true;
      try {
        await admin.reorderQuestions({ quiz_id: quizId, ordered_ids: newIds });
        toast('Reordered.');
        onMutate();
      } catch (err) { toast(err.message, 'error'); downBtn.disabled = false; }
    });

    const editBtn = el('button', { class: 'btn btn--outline btn--sm', text: 'Edit', attrs: { style: 'margin-right:.3rem' } });
    editBtn.addEventListener('click', () => {
      const formRow = el('tr');
      const formCell = el('td', { attrs: { colspan: '4', style: 'padding:.75rem' } });
      const form = buildQuestionForm(q, quizId, () => { formRow.remove(); onMutate(); }, () => { formRow.remove(); });
      formCell.appendChild(form);
      formRow.appendChild(formCell);
      tr.after(formRow);
      editBtn.disabled = true;
    });

    const delBtn = el('button', { class: 'btn btn--danger btn--sm', text: 'Delete' });
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this question? This cannot be undone.')) return;
      delBtn.disabled = true;
      try {
        await admin.deleteQuestion(q.id);
        toast('Question deleted.');
        onMutate();
      } catch (err) { toast(err.message, 'error'); delBtn.disabled = false; }
    });

    actTd.appendChild(upBtn);
    actTd.appendChild(downBtn);
    actTd.appendChild(editBtn);
    actTd.appendChild(delBtn);
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  });

  t.appendChild(tbody);
  wrap.appendChild(t);
  container.appendChild(wrap);
}

// ---- DOM helpers -----------------------------------------------------------

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
  head.appendChild(el('h2', { text: 'Questions', attrs: { style: 'margin:0' } }));
  container.appendChild(head);

  // Quiz selector
  let quizId = params.quiz_id || null;

  if (!quizId) {
    // Show quiz selector
    const selectorArea = el('div', { attrs: { style: 'margin-bottom:1.5rem' } });
    container.appendChild(selectorArea);

    try {
      renderLoading(selectorArea, 'Loading quizzes…');
      const res = await admin.listQuizzes();
      const quizzes = res.quizzes ?? res ?? [];
      selectorArea.innerHTML = '';

      if (!quizzes.length) {
        renderEmpty(selectorArea, 'No quizzes yet. Create one in the Quizzes tab.');
        return;
      }

      const row = el('div', { attrs: { style: 'display:flex;align-items:center;gap:.75rem;flex-wrap:wrap' } });
      row.appendChild(el('label', { text: 'Select quiz:', attrs: { style: 'font-weight:700' } }));
      const sel = document.createElement('select');
      sel.style.cssText = 'min-height:var(--tap);padding:.45rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);min-width:200px;';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '— choose a quiz —';
      sel.appendChild(placeholder);
      for (const qz of quizzes) {
        const o = document.createElement('option');
        o.value = qz.id;
        o.textContent = qz.title;
        sel.appendChild(o);
      }
      row.appendChild(sel);

      const goBtn = el('button', { class: 'btn btn--primary btn--sm', text: 'Load questions' });
      goBtn.addEventListener('click', () => {
        if (!sel.value) { toast('Select a quiz first.', 'error'); return; }
        const sp = new URLSearchParams(location.search);
        sp.set('tab', 'questions');
        sp.set('quiz_id', sel.value);
        history.pushState({}, '', `?${sp}`);
        init(container, { ...params, quiz_id: sel.value });
      });
      row.appendChild(goBtn);
      selectorArea.appendChild(row);
    } catch (err) {
      renderError(selectorArea, err.message);
    }
    return;
  }

  // Show quiz name in heading
  try {
    const qRes = await admin.listQuizzes();
    const quizzes = qRes.quizzes ?? qRes ?? [];
    const qz = quizzes.find((q) => q.id === quizId);
    if (qz) head.querySelector('h2').textContent = `Questions — ${qz.title}`;
  } catch (_) { /* ignore */ }

  // Back to quiz selector link
  const backLink = el('a', { text: '← Change quiz', attrs: { href: '?tab=questions', style: 'font-size:var(--fs-xs);color:var(--secondary)' } });
  container.appendChild(backLink);

  // Add question form (collapsible)
  const addBtn = el('button', { class: 'btn btn--primary btn--sm', text: '+ Add Question', attrs: { style: 'margin-left:auto' } });
  head.appendChild(addBtn);

  let formVisible = false;
  let formEl = null;
  const listArea = el('div', { attrs: { style: 'margin-top:1rem' } });
  container.appendChild(listArea);

  addBtn.addEventListener('click', () => {
    if (formVisible && formEl) { formEl.remove(); formVisible = false; addBtn.textContent = '+ Add Question'; return; }
    formEl = buildQuestionForm(null, quizId,
      () => { formEl.remove(); formVisible = false; addBtn.textContent = '+ Add Question'; load(); },
      () => { formEl.remove(); formVisible = false; addBtn.textContent = '+ Add Question'; });
    container.insertBefore(formEl, listArea);
    formVisible = true;
    addBtn.textContent = '− Cancel';
  });

  async function load() {
    renderLoading(listArea, 'Loading questions…');
    try {
      const res = await admin.listQuestions(quizId);
      const questions = res.questions ?? res ?? [];
      listArea.innerHTML = '';
      renderList(listArea, questions, quizId, load);
    } catch (err) {
      renderError(listArea, err.message, load);
    }
  }

  load();
}
