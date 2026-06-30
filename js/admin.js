/* ============================================================================
 * admin.js — ArchPrep PH admin portal controller (ES module).
 *
 * Security: the admin token lives in sessionStorage and is sent ONLY in the
 * POST text/plain JSON body (never in a query string). Every admin call is
 * gated server-side by requireAuth_; this front-end just reacts to a
 * `session_expired` error by returning to the login screen.
 * All dynamic content is rendered with textContent via el() (injection-safe).
 * ==========================================================================*/

import { el, $, $$, CONFIG, isConfigured } from "./ui.js";

const TOKEN_KEY = "archprep_admin_token";
const EXP_KEY = "archprep_admin_expires";
const USER_KEY = "archprep_admin_user";

let expiryTimer = null;

/* ---------------- transport ---------------- */

function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ""; }
function setSession(token, expires, username) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(EXP_KEY, String(expires));
  if (username) sessionStorage.setItem(USER_KEY, username);
}
function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXP_KEY);
  sessionStorage.removeItem(USER_KEY);
}

async function adminPost(action, payload = {}) {
  if (!isConfigured()) {
    return { ok: false, error: "Not connected: set APPS_SCRIPT_URL in config.js." };
  }
  const base = CONFIG.APPS_SCRIPT_URL.trim();
  const body = JSON.stringify({ action, token: getToken(), ...payload });
  let res;
  try {
    res = await fetch(base, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
    });
  } catch (e) {
    return { ok: false, error: "We couldn't reach the server. Check your connection." };
  }
  let data;
  try { data = JSON.parse(await res.text()); }
  catch (e) { return { ok: false, error: "Unexpected server response." }; }

  if (data && data.error === "session_expired") {
    clearSession();
    showLogin("Your session expired. Please log in again.");
  }
  return data;
}

/* ---------------- toasts + confirm ---------------- */

function toast(message, kind = "ok") {
  const wrap = $("#toasts");
  const t = el("div", { class: "toast " + (kind === "err" ? "err" : kind === "plain" ? "" : "ok"), text: message });
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 3200);
}

function confirmDialog(message, confirmLabel = "Delete") {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    const backdrop = el("div", { class: "modal-backdrop" });
    const modal = el("div", { class: "modal" });
    modal.appendChild(el("h3", { text: "Please confirm" }));
    modal.appendChild(el("p", { text: message }));
    const actions = el("div", { class: "modal-actions" });
    const cancel = el("button", { class: "btn btn--outline", text: "Cancel" });
    const ok = el("button", { class: "btn btn--danger", text: confirmLabel });
    cancel.addEventListener("click", () => { root.replaceChildren(); resolve(false); });
    ok.addEventListener("click", () => { root.replaceChildren(); resolve(true); });
    actions.appendChild(cancel); actions.appendChild(ok);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) { root.replaceChildren(); resolve(false); } });
    root.replaceChildren(backdrop);
    ok.focus();
  });
}

/* ---------------- small form helpers ---------------- */

function field(labelText, input, hint) {
  const f = el("div", { class: "field" });
  const id = input.id || ("f-" + Math.random().toString(36).slice(2));
  input.id = id;
  f.appendChild(el("label", { text: labelText, attrs: { for: id } }));
  f.appendChild(input);
  if (hint) f.appendChild(el("p", { class: "hint", text: hint }));
  return f;
}
function textInput(value = "", attrs = {}) {
  return el("input", { attrs: { type: "text", value: value, ...attrs } });
}
function numberInput(value = "", attrs = {}) {
  return el("input", { attrs: { type: "number", value: String(value), ...attrs } });
}
function textArea(value = "") {
  const t = el("textarea"); t.value = value || ""; return t;
}
function selectInput(options, selected) {
  const s = el("select");
  options.forEach((o) => {
    const opt = el("option", { text: o.label != null ? o.label : o, attrs: { value: o.value != null ? o.value : o } });
    if (String(o.value != null ? o.value : o) === String(selected)) opt.selected = true;
    s.appendChild(opt);
  });
  return s;
}
function busy(btn, on, busyText = "Working…") {
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = busyText; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

/* ---------------- auth controller ---------------- */

function showLogin(notice) {
  if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null; }
  $("#dash-view").hidden = true;
  $("#login-view").hidden = false;
  const alert = $("#login-alert");
  alert.replaceChildren(notice ? el("div", { class: "alert alert--info", text: notice, attrs: { role: "status" } }) : document.createTextNode(""));
}

function showDashboard() {
  $("#login-view").hidden = true;
  $("#dash-view").hidden = false;
  $("#who-user").textContent = sessionStorage.getItem(USER_KEY) || "admin";
  startExpiryCountdown();
  selectTab("requests");
}

function startExpiryCountdown() {
  if (expiryTimer) clearInterval(expiryTimer);
  const tick = () => {
    const exp = Number(sessionStorage.getItem(EXP_KEY) || 0);
    const ms = exp - Date.now();
    if (ms <= 0) {
      clearInterval(expiryTimer); expiryTimer = null;
      clearSession();
      showLogin("Your session expired. Please log in again.");
      return;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    $("#who-exp").textContent = h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  tick();
  expiryTimer = setInterval(tick, 30000);
}

function initAuth() {
  const form = $("#login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#login-btn");
    const username = $("#username").value.trim();
    const password = $("#password").value;
    const alert = $("#login-alert");
    alert.replaceChildren();
    if (!username || !password) {
      alert.replaceChildren(el("div", { class: "alert alert--error", text: "Enter your username and password." }));
      return;
    }
    busy(btn, true, "Signing in…");
    const res = await adminPost("adminLogin", { username, password });
    busy(btn, false);
    if (res.ok) {
      setSession(res.token, res.expires, username);
      $("#password").value = "";
      showDashboard();
    } else {
      alert.replaceChildren(el("div", { class: "alert alert--error", text: res.error || "Login failed.", attrs: { role: "alert" } }));
    }
  });

  $("#logout-btn").addEventListener("click", async () => {
    await adminPost("adminLogout", {});
    clearSession();
    showLogin("You've been logged out.");
  });

  $$(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
  });
}

function selectTab(name) {
  $$(".admin-tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  $$(".admin-panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
  if (name === "requests") renderRequests();
  else if (name === "quizzes") renderQuizzes();
  else if (name === "products") renderProducts();
  else if (name === "codes") renderCodes();
  else if (name === "settings") renderSettings();
}

/* ---------------- shared section helpers ---------------- */

function panel(name) { return $("#panel-" + name); }

function loadingState(container, label = "Loading…") {
  container.replaceChildren(el("div", { class: "state", children: [
    el("div", { class: "spinner", attrs: { "aria-hidden": "true" } }),
    el("p", { class: "mb-0", text: label }),
  ]}));
}
function emptyState(title, message) {
  return el("div", { class: "state", children: [
    el("h3", { text: title }), el("p", { class: "mb-0", text: message }),
  ]});
}
function sectionHead(title, actionBtn) {
  const head = el("div", { class: "section-head" });
  head.appendChild(el("h2", { class: "mb-0", text: title }));
  if (actionBtn) head.appendChild(actionBtn);
  return head;
}

/* ---------------- boot ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  initAuth();
  if (getToken() && Number(sessionStorage.getItem(EXP_KEY) || 0) > Date.now()) {
    showDashboard();
  } else {
    clearSession();
    showLogin();
  }
});

/* ============================================================================
 * QUIZZES section (quiz definitions + questions; per-quiz timer)
 * ==========================================================================*/

let quizView = { mode: "list" };

async function renderQuizzes() {
  const p = panel("quizzes");
  if (quizView.mode === "questions") return renderQuestions(p);

  loadingState(p, "Loading quizzes…");
  const res = await adminPost("adminListQuizzes", {});
  if (!res.ok) { p.replaceChildren(emptyState("Couldn't load quizzes", res.error || "Try again.")); return; }

  const newBtn = el("button", { class: "btn btn--secondary", text: "+ New quiz" });
  newBtn.addEventListener("click", () => openQuizForm(p, null));

  const wrap = el("div");
  wrap.appendChild(sectionHead("Quizzes", newBtn));

  if (!res.quizzes.length) {
    wrap.appendChild(emptyState("No quizzes yet", "Create your first quiz, then add questions to it."));
  } else {
    const list = el("div", { class: "row-list" });
    res.quizzes.forEach((q) => list.appendChild(quizRow(p, q)));
    wrap.appendChild(list);
  }
  p.replaceChildren(wrap);
}

function quizRow(p, q) {
  const main = el("div", { class: "row-main", children: [
    el("h4", { text: q.quiz_title }),
    el("div", { class: "row-meta", text:
      `${q.quiz_id} · ${q.subject || "—"} · ${q.question_count} question${q.question_count === 1 ? "" : "s"} · timer ${q.timer_minutes ? q.timer_minutes + " min" : "none"}` }),
  ]});
  const actions = el("div", { class: "row-actions" });
  const manage = el("button", { class: "btn btn--primary btn--sm", text: "Manage questions" });
  manage.addEventListener("click", () => { quizView = { mode: "questions", quiz: { ...q } }; renderQuizzes(); });
  const edit = el("button", { class: "btn btn--outline btn--sm", text: "Edit" });
  edit.addEventListener("click", () => openQuizForm(p, q));
  const del = el("button", { class: "btn btn--danger btn--sm", text: "Delete" });
  del.addEventListener("click", async () => {
    if (!(await confirmDialog(`Delete quiz "${q.quiz_title}" and all its questions? This cannot be undone.`))) return;
    const r = await adminPost("adminDeleteQuiz", { quiz_id: q.quiz_id });
    if (r.ok) { toast("Quiz deleted. Change is live."); renderQuizzes(); } else toast(r.error || "Delete failed.", "err");
  });
  actions.appendChild(manage); actions.appendChild(edit); actions.appendChild(del);
  return el("div", { class: "row-item", children: [main, actions] });
}

function openQuizForm(p, quiz) {
  const isNew = !quiz;
  const form = el("form", { class: "admin-form" });
  form.appendChild(el("h3", { text: isNew ? "New quiz" : "Edit quiz" }));

  const idInput = textInput(quiz ? quiz.quiz_id : "", { placeholder: "e.g. structural-2", autocapitalize: "none", spellcheck: "false" });
  if (!isNew) idInput.setAttribute("readonly", "true");
  const titleInput = textInput(quiz ? quiz.quiz_title : "");
  const subjInput = textInput(quiz ? quiz.subject : "", { placeholder: "e.g. Structural Design" });
  const timerInput = numberInput(quiz ? quiz.timer_minutes : 0, { min: "0" });

  form.appendChild(field("Quiz ID", idInput, "Lowercase id used by access-code scope. Use a shared prefix so a subject code unlocks all its quizzes (e.g. structural-1, structural-2)."));
  const row2 = el("div", { class: "row2" });
  row2.appendChild(field("Quiz title", titleInput));
  row2.appendChild(field("Subject", subjInput));
  form.appendChild(row2);
  form.appendChild(field("Timer (minutes, 0 = no timer)", timerInput));

  const save = el("button", { class: "btn btn--secondary", text: isNew ? "Create & add questions" : "Save changes", attrs: { type: "submit" } });
  const cancel = el("button", { class: "btn btn--outline", text: "Cancel", attrs: { type: "button" } });
  cancel.addEventListener("click", () => renderQuizzes());
  const bar = el("div", { class: "quiz-nav" }); bar.appendChild(cancel); bar.appendChild(save);
  form.appendChild(bar);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    const subject = subjInput.value.trim();
    const timer = Number(timerInput.value) || 0;
    if (!title) return toast("Quiz title is required.", "err");
    busy(save, true);
    if (isNew) {
      const r = await adminPost("adminCreateQuiz", { quiz_id: idInput.value.trim(), quiz_title: title, subject, timer_minutes: timer });
      busy(save, false);
      if (!r.ok) return toast(r.error || "Create failed.", "err");
      // Persisted once first question is added — go straight to questions view.
      quizView = { mode: "questions", quiz: { quiz_id: r.quiz_id, quiz_title: title, subject, timer_minutes: timer, question_count: 0, isNew: true } };
      toast("Quiz created — add at least one question to save it.");
      renderQuizzes();
    } else {
      const r = await adminPost("adminUpdateQuiz", { quiz_id: quiz.quiz_id, quiz_title: title, subject, timer_minutes: timer });
      busy(save, false);
      if (r.ok) { toast("Quiz updated. Change is live."); renderQuizzes(); } else toast(r.error || "Update failed.", "err");
    }
  });

  const wrap = el("div");
  const back = el("button", { class: "btn btn--ghost btn--sm", text: "← Back to quizzes" });
  back.addEventListener("click", () => renderQuizzes());
  wrap.appendChild(back);
  wrap.appendChild(form);
  p.replaceChildren(wrap);
}

/* ----- Questions sub-view ----- */

async function renderQuestions(p) {
  const q = quizView.quiz;
  loadingState(p, "Loading questions…");
  let data = { ok: true, questions: [], quiz_title: q.quiz_title, subject: q.subject, timer_minutes: q.timer_minutes };
  if (!q.isNew) data = await adminPost("adminListQuestions", { quiz_id: q.quiz_id });
  if (!data.ok) { p.replaceChildren(emptyState("Couldn't load questions", data.error || "Try again.")); return; }

  const back = el("button", { class: "btn btn--ghost btn--sm", text: "← Back to quizzes" });
  back.addEventListener("click", () => { quizView = { mode: "list" }; renderQuizzes(); });

  const addBtn = el("button", { class: "btn btn--secondary", text: "+ Add question" });
  addBtn.addEventListener("click", () => openQuestionForm(p, null, data));

  const wrap = el("div");
  wrap.appendChild(back);
  wrap.appendChild(sectionHead(`Questions — ${q.quiz_title}`, addBtn));

  const questions = data.questions || [];
  if (!questions.length) {
    wrap.appendChild(el("div", { class: "alert alert--info", text: "This quiz has no questions yet. It is saved only after you add the first question. A quiz with 0 questions won't appear to students." }));
  } else {
    const list = el("div", { class: "row-list" });
    questions.forEach((qq, i) => list.appendChild(questionRow(p, qq, i, questions.length, data)));
    wrap.appendChild(list);
  }
  p.replaceChildren(wrap);
}

function questionRow(p, qq, idx, total, data) {
  const correctText = qq.options[qq.correct_index] != null ? qq.options[qq.correct_index] : "";
  const main = el("div", { class: "row-main", children: [
    el("h4", { text: `${qq.question_number}. ${qq.question_text}` }),
    el("div", { class: "row-meta", text: `Correct: ${qq.correct_option}. ${correctText}` }),
  ]});
  const actions = el("div", { class: "row-actions" });
  const up = el("button", { class: "btn btn--outline btn--sm", text: "↑" });
  const down = el("button", { class: "btn btn--outline btn--sm", text: "↓" });
  up.disabled = idx === 0; down.disabled = idx === total - 1;
  up.addEventListener("click", () => reorder(data, idx, idx - 1));
  down.addEventListener("click", () => reorder(data, idx, idx + 1));
  const edit = el("button", { class: "btn btn--outline btn--sm", text: "Edit" });
  edit.addEventListener("click", () => openQuestionForm(p, qq, data));
  const del = el("button", { class: "btn btn--danger btn--sm", text: "Delete" });
  del.addEventListener("click", async () => {
    if (!(await confirmDialog(`Delete question ${qq.question_number}?`))) return;
    const r = await adminPost("adminDeleteQuestion", { quiz_id: quizView.quiz.quiz_id, question_number: qq.question_number });
    if (r.ok) { toast("Question deleted."); renderQuizzes(); } else toast(r.error || "Delete failed.", "err");
  });
  actions.appendChild(up); actions.appendChild(down); actions.appendChild(edit); actions.appendChild(del);
  return el("div", { class: "row-item", children: [main, actions] });
}

async function reorder(data, fromIdx, toIdx) {
  const nums = data.questions.map((x) => x.question_number);
  const moved = nums.splice(fromIdx, 1)[0];
  nums.splice(toIdx, 0, moved);
  const r = await adminPost("adminReorderQuestions", { quiz_id: quizView.quiz.quiz_id, orderedNumbers: nums });
  if (r.ok) renderQuizzes(); else toast(r.error || "Reorder failed.", "err");
}

function openQuestionForm(p, qq, data) {
  const isNew = !qq;
  const form = el("form", { class: "admin-form" });
  form.appendChild(el("h3", { text: isNew ? "Add question" : "Edit question" }));

  const qText = textArea(qq ? qq.question_text : "");
  form.appendChild(field("Question text", qText));

  // Option rows with a single radio for the correct answer.
  const opts = (qq ? qq.options.slice() : ["", ""]);
  let correctIdx = qq ? qq.correct_index : 0;
  const optWrap = el("div");
  form.appendChild(el("label", { text: "Options (select the correct one)", attrs: { style: "font-weight:700;display:block;margin-bottom:.4rem" } }));
  form.appendChild(optWrap);

  function drawOptions() {
    optWrap.replaceChildren();
    opts.forEach((val, i) => {
      const rowEl = el("div", { class: "opt-row" });
      const radio = el("input", { attrs: { type: "radio", name: "correct", title: "Mark correct" } });
      if (i === correctIdx) radio.checked = true;
      radio.addEventListener("change", () => { correctIdx = i; });
      const ti = textInput(val, { placeholder: "Option " + "ABCD"[i] });
      ti.addEventListener("input", () => { opts[i] = ti.value; });
      const rm = el("button", { class: "btn btn--outline btn--sm", text: "✕", attrs: { type: "button", title: "Remove option" } });
      rm.disabled = opts.length <= 2;
      rm.addEventListener("click", () => {
        opts.splice(i, 1);
        if (correctIdx >= opts.length) correctIdx = opts.length - 1;
        drawOptions();
      });
      rowEl.appendChild(radio); rowEl.appendChild(ti); rowEl.appendChild(rm);
      optWrap.appendChild(rowEl);
    });
    addOpt.style.display = opts.length >= 4 ? "none" : "";
  }
  const addOpt = el("button", { class: "btn btn--ghost btn--sm", text: "+ Add option", attrs: { type: "button" } });
  addOpt.addEventListener("click", () => { if (opts.length < 4) { opts.push(""); drawOptions(); } });
  form.appendChild(addOpt);
  drawOptions();

  const expl = textArea(qq ? qq.explanation : "");
  form.appendChild(field("Explanation (shown after grading)", expl));

  const save = el("button", { class: "btn btn--secondary", text: isNew ? "Add question" : "Save question", attrs: { type: "submit" } });
  const cancel = el("button", { class: "btn btn--outline", text: "Cancel", attrs: { type: "button" } });
  cancel.addEventListener("click", () => renderQuizzes());
  const bar = el("div", { class: "quiz-nav" }); bar.appendChild(cancel); bar.appendChild(save);
  form.appendChild(bar);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cleanOpts = opts.map((o) => String(o || "").trim());
    const nonEmpty = cleanOpts.filter((o) => o !== "");
    if (!qText.value.trim()) return toast("Question text is required.", "err");
    if (nonEmpty.length < 2) return toast("Provide at least 2 options.", "err");
    if (correctIdx < 0 || !cleanOpts[correctIdx]) return toast("Select exactly one correct answer (must be a filled option).", "err");

    busy(save, true);
    const q = quizView.quiz;
    let r;
    if (isNew) {
      r = await adminPost("adminAddQuestion", {
        quiz_id: q.quiz_id, quiz_title: q.quiz_title, subject: q.subject, timer_minutes: q.timer_minutes,
        question_text: qText.value.trim(), options: cleanOpts, correct_index: correctIdx, explanation: expl.value.trim(),
      });
    } else {
      r = await adminPost("adminUpdateQuestion", {
        quiz_id: q.quiz_id, question_number: qq.question_number,
        question_text: qText.value.trim(), options: cleanOpts, correct_index: correctIdx, explanation: expl.value.trim(),
      });
    }
    busy(save, false);
    if (r.ok) {
      toast(isNew ? "Question added. Change is live." : "Question saved. Change is live.");
      if (quizView.quiz) quizView.quiz.isNew = false; // now persisted
      renderQuizzes();
    } else toast(r.error || "Save failed.", "err");
  });

  const wrap = el("div");
  const back = el("button", { class: "btn btn--ghost btn--sm", text: "← Back to questions" });
  back.addEventListener("click", () => renderQuizzes());
  wrap.appendChild(back);
  wrap.appendChild(form);
  p.replaceChildren(wrap);
}

/* ============================================================================
 * PRODUCTS section (materials + quiz packs)
 * ==========================================================================*/

async function renderProducts() {
  const p = panel("products");
  loadingState(p, "Loading products…");
  const res = await adminPost("adminListProducts", {});
  if (!res.ok) { p.replaceChildren(emptyState("Couldn't load products", res.error || "Try again.")); return; }

  const newBtn = el("button", { class: "btn btn--secondary", text: "+ New product" });
  newBtn.addEventListener("click", () => openProductForm(p, null));

  const wrap = el("div");
  wrap.appendChild(sectionHead("Products", newBtn));
  if (!res.products.length) {
    wrap.appendChild(emptyState("No products yet", "Create a material or a quiz pack to sell."));
  } else {
    const list = el("div", { class: "row-list" });
    res.products.forEach((pr) => list.appendChild(productRow(p, pr)));
    wrap.appendChild(list);
  }
  p.replaceChildren(wrap);
}

function productRow(p, pr) {
  const badge = pr.active ? el("span", { class: "badge pub", text: "Published" }) : el("span", { class: "badge draft", text: "Draft" });
  const meta = `${pr.type} · ${pr.subject || "—"} · ₱${pr.price_php}` + (pr.unlock_scope ? ` · unlocks "${pr.unlock_scope}"` : "");
  const main = el("div", { class: "row-main", children: [
    el("h4", { children: [document.createTextNode(pr.title + "  "), badge] }),
    el("div", { class: "row-meta", text: `${pr.product_id} · ${meta}` }),
  ]});
  const actions = el("div", { class: "row-actions" });
  const edit = el("button", { class: "btn btn--outline btn--sm", text: "Edit" });
  edit.addEventListener("click", () => openProductForm(p, pr));
  const del = el("button", { class: "btn btn--danger btn--sm", text: "Delete" });
  del.addEventListener("click", async () => {
    if (!(await confirmDialog(`Delete product "${pr.title}"?`))) return;
    const r = await adminPost("adminDeleteProduct", { product_id: pr.product_id });
    if (r.ok) { toast("Product deleted. Change is live."); renderProducts(); } else toast(r.error || "Delete failed.", "err");
  });
  actions.appendChild(edit); actions.appendChild(del);
  return el("div", { class: "row-item", children: [main, actions] });
}

function openProductForm(p, pr) {
  const isNew = !pr;
  const form = el("form", { class: "admin-form" });
  form.appendChild(el("h3", { text: isNew ? "New product" : "Edit product" }));

  const typeSel = selectInput([{ value: "material", label: "Material" }, { value: "quiz", label: "Quiz pack" }], pr ? pr.type : "material");
  const subjInput = textInput(pr ? pr.subject : "");
  const titleInput = textInput(pr ? pr.title : "");
  const descInput = textArea(pr ? pr.description : "");
  const priceInput = numberInput(pr ? pr.price_php : 0, { min: "0" });
  const linkInput = textInput(pr ? pr.hitpay_link : "", { placeholder: "https://… HitPay link" });
  const sortInput = numberInput(pr ? pr.sort_order : 100, { min: "0" });
  const scopeInput = textInput(pr ? pr.unlock_scope : "", { placeholder: "e.g. structural or all" });
  const driveInput = textInput(pr ? pr.drive_note : "", { placeholder: "Drive folder/file note" });
  const activeChk = el("input", { attrs: { type: "checkbox" } });
  if (!pr || pr.active) activeChk.checked = true;

  const r1 = el("div", { class: "row2" });
  r1.appendChild(field("Type", typeSel));
  r1.appendChild(field("Subject", subjInput));
  form.appendChild(r1);
  form.appendChild(field("Title", titleInput));
  form.appendChild(field("Description", descInput));
  const r2 = el("div", { class: "row2" });
  r2.appendChild(field("Price (PHP)", priceInput));
  r2.appendChild(field("Sort order", sortInput));
  form.appendChild(r2);
  form.appendChild(field("HitPay link", linkInput, "Leave blank/REPLACE_ME until you create the HitPay payment link."));
  const r3 = el("div", { class: "row2" });
  r3.appendChild(field("Unlock scope (quiz packs)", scopeInput, "Which quizzes this product unlocks; pre-fills the access-code scope."));
  r3.appendChild(field("Drive note (materials)", driveInput));
  form.appendChild(r3);

  const toggle = el("label", { class: "toggle" });
  toggle.appendChild(activeChk);
  toggle.appendChild(el("span", { text: "Published (uncheck = Draft, hidden from the public site)" }));
  form.appendChild(toggle);

  const save = el("button", { class: "btn btn--secondary", text: isNew ? "Create product" : "Save changes", attrs: { type: "submit" } });
  const cancel = el("button", { class: "btn btn--outline", text: "Cancel", attrs: { type: "button" } });
  cancel.addEventListener("click", () => renderProducts());
  const bar = el("div", { class: "quiz-nav", attrs: { style: "margin-top:1rem" } }); bar.appendChild(cancel); bar.appendChild(save);
  form.appendChild(bar);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!titleInput.value.trim()) return toast("Title is required.", "err");
    const payload = {
      type: typeSel.value, subject: subjInput.value.trim(), title: titleInput.value.trim(),
      description: descInput.value.trim(), price_php: Number(priceInput.value) || 0,
      hitpay_link: linkInput.value.trim(), sort_order: Number(sortInput.value) || 100,
      unlock_scope: scopeInput.value.trim(), drive_note: driveInput.value.trim(),
      active: activeChk.checked,
    };
    busy(save, true);
    const r = isNew ? await adminPost("adminCreateProduct", payload)
                    : await adminPost("adminUpdateProduct", { product_id: pr.product_id, ...payload });
    busy(save, false);
    if (r.ok) { toast(isNew ? "Product created. Change is live." : "Product saved. Change is live."); renderProducts(); }
    else toast(r.error || "Save failed.", "err");
  });

  const wrap = el("div");
  const back = el("button", { class: "btn btn--ghost btn--sm", text: "← Back to products" });
  back.addEventListener("click", () => renderProducts());
  wrap.appendChild(back); wrap.appendChild(form);
  p.replaceChildren(wrap);
}

/* ============================================================================
 * ACCESS CODES section
 * ==========================================================================*/

async function renderCodes() {
  const p = panel("codes");
  loadingState(p, "Loading access codes…");
  const res = await adminPost("adminListCodes", {});
  if (!res.ok) { p.replaceChildren(emptyState("Couldn't load codes", res.error || "Try again.")); return; }

  const newBtn = el("button", { class: "btn btn--secondary", text: "+ New code" });
  newBtn.addEventListener("click", () => openCodeForm(p));

  const wrap = el("div");
  wrap.appendChild(sectionHead("Access codes", newBtn));
  if (!res.codes.length) {
    wrap.appendChild(emptyState("No access codes yet", "Generate a code after a sale to unlock quizzes for a buyer."));
  } else {
    const list = el("div", { class: "row-list" });
    res.codes.forEach((c) => list.appendChild(codeRow(p, c)));
    wrap.appendChild(list);
  }
  p.replaceChildren(wrap);
}

function codeRow(p, c) {
  const disabled = String(c.status).toLowerCase() === "disabled";
  const badge = disabled ? el("span", { class: "badge disabled", text: "Disabled" }) : el("span", { class: "badge pub", text: "Active" });
  const uses = c.max_uses === "" || c.max_uses == null ? `${c.uses_count} (unlimited)` : `${c.uses_count}/${c.max_uses}`;
  const main = el("div", { class: "row-main", children: [
    el("h4", { children: [document.createTextNode(c.code + "  "), badge] }),
    el("div", { class: "row-meta", text: `unlocks "${c.scope}" · expires ${c.expiry_date || "—"} · uses ${uses}${c.notes ? " · " + c.notes : ""}` }),
  ]});
  const actions = el("div", { class: "row-actions" });
  const toggleBtn = el("button", { class: "btn btn--outline btn--sm", text: disabled ? "Enable" : "Disable" });
  toggleBtn.addEventListener("click", async () => {
    const r = await adminPost("adminUpdateCode", { code: c.code, status: disabled ? "active" : "disabled" });
    if (r.ok) { toast("Code updated. Change is live."); renderCodes(); } else toast(r.error || "Update failed.", "err");
  });
  const del = el("button", { class: "btn btn--danger btn--sm", text: "Delete" });
  del.addEventListener("click", async () => {
    if (!(await confirmDialog(`Delete code ${c.code}?`))) return;
    const r = await adminPost("adminDeleteCode", { code: c.code });
    if (r.ok) { toast("Code deleted."); renderCodes(); } else toast(r.error || "Delete failed.", "err");
  });
  actions.appendChild(toggleBtn); actions.appendChild(del);
  return el("div", { class: "row-item", children: [main, actions] });
}

function openCodeForm(p) {
  const form = el("form", { class: "admin-form" });
  form.appendChild(el("h3", { text: "New access code" }));
  const scopeInput = textInput("", { placeholder: "a quiz_id, a subject prefix, or all" });
  const expiryInput = el("input", { attrs: { type: "date" } });
  const maxInput = numberInput("", { min: "0", placeholder: "blank = unlimited" });
  const notesInput = textInput("", { placeholder: "buyer email / reference" });
  form.appendChild(field("Scope", scopeInput, "Examples: structural-1 (one quiz), structural (a subject's quizzes), or all."));
  const r2 = el("div", { class: "row2" });
  r2.appendChild(field("Expiry date", expiryInput));
  r2.appendChild(field("Max uses", maxInput));
  form.appendChild(r2);
  form.appendChild(field("Notes", notesInput));

  const save = el("button", { class: "btn btn--secondary", text: "Generate code", attrs: { type: "submit" } });
  const cancel = el("button", { class: "btn btn--outline", text: "Cancel", attrs: { type: "button" } });
  cancel.addEventListener("click", () => renderCodes());
  const bar = el("div", { class: "quiz-nav" }); bar.appendChild(cancel); bar.appendChild(save);
  form.appendChild(bar);
  const revealHost = el("div");
  form.appendChild(revealHost);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!scopeInput.value.trim()) return toast("A scope is required.", "err");
    busy(save, true);
    const r = await adminPost("adminCreateCode", {
      scope: scopeInput.value.trim(), expiry_date: expiryInput.value, max_uses: maxInput.value, notes: notesInput.value.trim(),
    });
    busy(save, false);
    if (!r.ok) return toast(r.error || "Create failed.", "err");
    toast("Code generated. Change is live.");
    revealHost.replaceChildren(codeReveal(r.code, scopeInput.value.trim(), expiryInput.value));
  });

  const wrap = el("div");
  const back = el("button", { class: "btn btn--ghost btn--sm", text: "← Back to codes" });
  back.addEventListener("click", () => renderCodes());
  wrap.appendChild(back); wrap.appendChild(form);
  p.replaceChildren(wrap);
}

function codeReveal(code, scope, expiry) {
  const box = el("div", { class: "code-reveal" });
  box.appendChild(el("p", { class: "mb-0", text: "Share this code with the buyer:" }));
  box.appendChild(el("div", { class: "the-code", text: code }));
  const copyBtn = el("button", { class: "btn btn--secondary btn--sm", text: "Copy code", attrs: { type: "button" } });
  copyBtn.addEventListener("click", () => { navigator.clipboard && navigator.clipboard.writeText(code); toast("Code copied."); });
  box.appendChild(copyBtn);

  const snippet =
`Hi,

Thank you for your purchase! Here is your quiz access:

Quiz page: open the Quizzes page on our site and tap "Already purchased? Enter your code".
Quiz to enter: ${scope}
Access code: ${code}

This code is valid until ${expiry || "the date on your receipt"}. Your score and full explanations appear right after you submit.

Good luck with your review!`;
  const ta = textArea(snippet);
  box.appendChild(el("p", { class: "mb-0", attrs: { style: "margin-top:.75rem;font-weight:700" }, text: "Ready-to-send email:" }));
  box.appendChild(ta);
  const copySnip = el("button", { class: "btn btn--outline btn--sm", text: "Copy email", attrs: { type: "button" } });
  copySnip.addEventListener("click", () => { ta.select(); navigator.clipboard && navigator.clipboard.writeText(ta.value); toast("Email copied."); });
  box.appendChild(copySnip);
  return box;
}

/* ============================================================================
 * SETTINGS section
 * ==========================================================================*/

async function renderSettings() {
  const p = panel("settings");
  loadingState(p, "Loading settings…");
  const res = await adminPost("adminGetSettings", {});
  if (!res.ok) { p.replaceChildren(emptyState("Couldn't load settings", res.error || "Try again.")); return; }
  const s = res.settings || {};

  const form = el("form", { class: "admin-form" });
  form.appendChild(el("h3", { text: "Site settings" }));
  const brand = textInput(s.brand_name || "");
  const contact = textInput(s.contact_email || "");
  const banner = textInput(s.announcement_banner || "", { placeholder: "Leave blank to hide the banner" });
  const headline = textInput(s.hero_headline || "");
  const subhead = textArea(s.hero_subhead || "");
  form.appendChild(field("Brand name", brand));
  form.appendChild(field("Contact email", contact));
  form.appendChild(field("Announcement banner", banner, "Shown across the top of every public page. Blank = hidden."));
  form.appendChild(field("Hero headline", headline));
  form.appendChild(field("Hero subhead", subhead));

  const save = el("button", { class: "btn btn--secondary", text: "Save settings", attrs: { type: "submit" } });
  form.appendChild(save);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    busy(save, true);
    const entries = {
      brand_name: brand.value.trim(), contact_email: contact.value.trim(),
      announcement_banner: banner.value.trim(), hero_headline: headline.value.trim(),
      hero_subhead: subhead.value.trim(),
    };
    let okAll = true;
    for (const key of Object.keys(entries)) {
      const r = await adminPost("adminUpdateSettings", { key, value: entries[key] });
      if (!r.ok) okAll = false;
    }
    busy(save, false);
    toast(okAll ? "Settings saved. Live on the public site on next load." : "Some settings failed to save.", okAll ? "ok" : "err");
  });

  const wrap = el("div");
  wrap.appendChild(sectionHead("Settings", null));
  wrap.appendChild(form);
  p.replaceChildren(wrap);
}

/* ============================================================================
 * REQUESTS section — purchase inbox (emails captured at checkout).
 * Quiz requests: confirm payment -> Activate (turns the pending 2-attempt
 * code live) -> send the email snippet. Material requests: set a validity
 * date you choose and mark fulfilled (delivery stays manual via Drive).
 * ==========================================================================*/

async function renderRequests() {
  const p = panel("requests");
  loadingState(p, "Loading purchase requests…");
  const res = await adminPost("adminListRequests", {});
  if (!res.ok) { p.replaceChildren(emptyState("Couldn't load requests", res.error || "Try again.")); return; }

  const refresh = el("button", { class: "btn btn--outline btn--sm", text: "↻ Refresh" });
  refresh.addEventListener("click", renderRequests);

  const wrap = el("div");
  wrap.appendChild(sectionHead("Purchase requests", refresh));
  wrap.appendChild(el("p", { class: "muted", attrs: { style: "margin-top:-.5rem" }, text:
    "When a student checks out, their email appears here. Confirm the payment in HitPay, then activate (quiz) or set a validity date (material)." }));

  const reqs = res.requests || [];
  const pending = reqs.filter((r) => r.status !== "fulfilled");
  const done = reqs.filter((r) => r.status === "fulfilled");

  if (!reqs.length) {
    wrap.appendChild(emptyState("No requests yet", "Checkout requests from students will show up here."));
  } else {
    if (pending.length) {
      wrap.appendChild(el("h3", { text: `Pending (${pending.length})` }));
      const list = el("div", { class: "row-list" });
      pending.forEach((r) => list.appendChild(requestRow(r)));
      wrap.appendChild(list);
    }
    if (done.length) {
      wrap.appendChild(el("h3", { attrs: { style: "margin-top:1.5rem" }, text: "Fulfilled" }));
      const list2 = el("div", { class: "row-list" });
      done.forEach((r) => list2.appendChild(requestRow(r)));
      wrap.appendChild(list2);
    }
  }
  p.replaceChildren(wrap);
}

function requestRow(r) {
  const isQuiz = r.type === "quiz";
  const fulfilled = r.status === "fulfilled";
  const badge = fulfilled
    ? el("span", { class: "badge pub", text: "Fulfilled" })
    : el("span", { class: "badge draft", text: "Pending" });

  const metaBits = [`${r.type} · ${r.title || r.product_id}`];
  if (isQuiz && r.code) metaBits.push(`code ${r.code}`);
  if (r.valid_until) metaBits.push(`valid until ${r.valid_until}`);

  const main = el("div", { class: "row-main", children: [
    el("h4", { children: [document.createTextNode(r.email + "  "), badge] }),
    el("div", { class: "row-meta", text: metaBits.join(" · ") }),
  ]});

  const actions = el("div", { class: "row-actions" });

  if (isQuiz && !fulfilled) {
    const activate = el("button", { class: "btn btn--primary btn--sm", text: "Confirm payment & activate" });
    activate.addEventListener("click", async () => {
      if (!(await confirmDialog(`Activate the quiz code for ${r.email}? Do this only after you've confirmed their payment in HitPay.`, "Activate"))) return;
      const res = await adminPost("adminFulfillRequest", { request_id: r.request_id });
      if (res.ok) { showQuizDelivery(r); renderRequests(); }
      else toast(res.error || "Activate failed.", "err");
    });
    actions.appendChild(activate);
  }

  if (!isQuiz && !fulfilled) {
    // Material: pick a validity date, then fulfil.
    const date = el("input", { attrs: { type: "date", style: "min-height:36px" } });
    const fulfil = el("button", { class: "btn btn--primary btn--sm", text: "Set validity & mark sent" });
    fulfil.addEventListener("click", async () => {
      if (!date.value) return toast("Pick a validity date first.", "err");
      const res = await adminPost("adminFulfillRequest", { request_id: r.request_id, valid_until: date.value });
      if (res.ok) { toast("Marked fulfilled. Remember to share the Drive file with " + r.email); renderRequests(); }
      else toast(res.error || "Failed.", "err");
    });
    actions.appendChild(date);
    actions.appendChild(fulfil);
  }

  if (isQuiz && fulfilled && r.code) {
    const resend = el("button", { class: "btn btn--outline btn--sm", text: "Show email" });
    resend.addEventListener("click", () => showQuizDelivery(r));
    actions.appendChild(resend);
  }

  const del = el("button", { class: "btn btn--danger btn--sm", text: "Delete" });
  del.addEventListener("click", async () => {
    if (!(await confirmDialog(`Delete this request from ${r.email}?` + (isQuiz && !fulfilled ? " Its un-activated code will also be removed." : "")))) return;
    const res = await adminPost("adminDeleteRequest", { request_id: r.request_id });
    if (res.ok) { toast("Request deleted."); renderRequests(); }
    else toast(res.error || "Delete failed.", "err");
  });
  actions.appendChild(del);

  return el("div", { class: "row-item", children: [main, actions] });
}

/* Show a ready-to-send email with the activated quiz code. */
function showQuizDelivery(r) {
  const root = $("#modal-root");
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal" });
  modal.appendChild(el("h3", { text: "Send this to the buyer" }));
  modal.appendChild(el("p", { class: "muted", text: `Email: ${r.email}` }));

  const snippet =
`Hi,

Thank you for your purchase! Here is your quiz access:

Quiz page: open the Quizzes page on our site and tap "Already purchased? Enter your code".
Quiz to enter: ${r.scope}
Access code: ${r.code}

This code works for 2 attempts. Your score and full explanations appear right after you submit.

Good luck with your review!`;
  const ta = el("textarea");
  ta.value = snippet; ta.style.width = "100%"; ta.style.minHeight = "180px"; ta.style.marginTop = ".5rem";
  modal.appendChild(ta);

  const actions = el("div", { class: "modal-actions" });
  const copy = el("button", { class: "btn btn--secondary", text: "Copy email" });
  copy.addEventListener("click", () => { ta.select(); if (navigator.clipboard) navigator.clipboard.writeText(ta.value); toast("Email copied."); });
  const close = el("button", { class: "btn btn--outline", text: "Close" });
  close.addEventListener("click", () => root.replaceChildren());
  actions.appendChild(copy); actions.appendChild(close);
  modal.appendChild(actions);

  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) root.replaceChildren(); });
  backdrop.appendChild(modal);
  root.replaceChildren(backdrop);
}
