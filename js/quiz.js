/* ============================================================================
 * quiz.js — the quiz-taking flow (Section 13).
 *
 * IMPORTANT: this module NEVER holds or sees the answer key.
 *   - getQuiz returns questions + options only (no correct_option).
 *   - Grading + correct answers + explanations come back ONLY from gradeQuiz.
 *   - Answers are kept in memory only — never written to local/sessionStorage.
 * ==========================================================================*/

import {
  el, $, apiGet, apiPost, isConfigured, qparam,
  renderLoading, renderError, renderNotConfigured, CONFIG,
} from "./ui.js";

const root = $("#quiz-root");

// In-memory state only (no persistence — Section 13.7 anti-cheat)
const state = {
  quizId: null,
  code: null,
  quiz: null,          // { quiz_id, quiz_title, subject, questions: [...] }
  answers: {},         // { "1": "B", ... }
  index: 0,
  timer: null,
  remaining: 0,
};

document.addEventListener("DOMContentLoaded", () => {
  if (!root) return;
  // Pre-select a quiz if linked from the catalogue (?quiz=structural-1)
  state.quizId = (qparam("quiz") || "").trim() || null;
  renderCodeEntry();
});

/* ------------------------------------------------------------------ */
/* 1. Code-entry screen                                               */
/* ------------------------------------------------------------------ */

function renderCodeEntry(errorMsg) {
  stopTimer();
  const wrap = el("div", { class: "quiz-shell" });

  const card = el("div", { class: "quiz-card" });
  card.appendChild(el("h1", { text: "Enter your access code" }));
  card.appendChild(el("p", { class: "lead",
    text: "Type the access code from your purchase email to unlock your quiz." }));

  if (!isConfigured()) {
    renderNotConfigured(root);
    return;
  }

  if (errorMsg) {
    card.appendChild(el("div", { class: "alert alert--error", text: errorMsg, attrs: { role: "alert" } }));
  }

  const form = el("form", { attrs: { novalidate: "true" } });

  // Quiz id field (prefilled & read-only if arrived pre-selected)
  const quizField = el("div", { class: "field" });
  quizField.appendChild(el("label", { text: "Quiz", attrs: { for: "quizId" } }));
  const quizInput = el("input", { attrs: {
    type: "text", id: "quizId", name: "quizId",
    value: state.quizId || "", placeholder: "e.g. structural-1",
    autocomplete: "off", autocapitalize: "none", spellcheck: "false",
  }});
  quizField.appendChild(quizInput);
  quizField.appendChild(el("p", { class: "hint",
    text: "This is the quiz code shown on the quizzes page or in your email (for example structural-1 or mock-1)." }));
  form.appendChild(quizField);

  // Access code field
  const codeField = el("div", { class: "field" });
  codeField.appendChild(el("label", { text: "Access code", attrs: { for: "code" } }));
  const codeInput = el("input", { attrs: {
    type: "text", id: "code", name: "code", placeholder: "e.g. ARCH-7F3K",
    autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
  }});
  codeField.appendChild(codeInput);
  form.appendChild(codeField);

  const submit = el("button", { class: "btn btn--primary btn--lg btn--block", text: "Start quiz",
    attrs: { type: "submit" } });
  form.appendChild(submit);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const quizId = quizInput.value.trim();
    const code = codeInput.value.trim();
    if (!quizId) return showInlineError(form, "Please enter the quiz code (for example structural-1).");
    if (!code) return showInlineError(form, "Please enter your access code.");

    submit.disabled = true;
    submit.textContent = "Checking…";
    state.quizId = quizId;
    state.code = code;
    await loadQuiz();
  });

  card.appendChild(form);

  const back = el("p", { class: "center", attrs: { style: "margin-top:1.5rem" }, children: [
    el("a", { text: "← Back to quizzes", attrs: { href: "quizzes.html" } }),
  ]});

  wrap.appendChild(card);
  wrap.appendChild(back);
  root.replaceChildren(wrap);
  codeInput.focus();
}

function showInlineError(form, msg) {
  let alert = form.querySelector(".alert--error");
  if (!alert) {
    alert = el("div", { class: "alert alert--error", attrs: { role: "alert" } });
    form.prepend(alert);
  }
  alert.textContent = msg;
  const submit = form.querySelector('button[type="submit"]');
  if (submit) { submit.disabled = false; submit.textContent = "Start quiz"; }
}

/* ------------------------------------------------------------------ */
/* 2. Load the quiz (questions + options only — no answers)           */
/* ------------------------------------------------------------------ */

async function loadQuiz() {
  renderLoading(root, "Unlocking your quiz…");
  try {
    const res = await apiGet("getQuiz", { quizId: state.quizId, code: state.code });
    if (!res || res.ok === false) {
      return renderCodeEntry(res && res.error
        ? res.error
        : "This code isn't valid for this quiz or has expired. Please check the code from your email, or contact us.");
    }
    const quiz = res.quiz;
    if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      return renderCodeEntry("This quiz doesn't have any questions yet. Please contact us or try again later.");
    }
    state.quiz = quiz;
    state.answers = {};
    state.index = 0;
    startTimerIfMock();
    renderQuestion();
  } catch (err) {
    renderError(root, err.message || "We couldn't load the quiz. Please try again.", () => loadQuiz());
  }
}

/* ------------------------------------------------------------------ */
/* 3 & 4. Answering + optional mock timer                              */
/* ------------------------------------------------------------------ */

function renderQuestion() {
  const q = state.quiz.questions[state.index];
  const total = state.quiz.questions.length;
  const qnum = q.question_number;

  const wrap = el("div", { class: "quiz-shell" });
  const card = el("div", { class: "quiz-card" });

  // Progress + timer row
  const progressRow = el("div", { class: "quiz-progress" });
  progressRow.appendChild(el("span", { class: "count",
    text: `Question ${state.index + 1} of ${total}` }));
  const bar = el("div", { class: "progress-bar", attrs: {
    role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total),
    "aria-valuenow": String(state.index + 1),
  }});
  bar.appendChild(el("span", { attrs: { style: `width:${((state.index + 1) / total) * 100}%` } }));
  progressRow.appendChild(bar);
  if (isMock()) {
    progressRow.appendChild(el("span", { class: "timer", attrs: { id: "timer", "aria-live": "polite" },
      text: formatTime(state.remaining) }));
  }
  card.appendChild(progressRow);

  // Quiz title + subject
  card.appendChild(el("p", { class: "eyebrow mb-0", text: `${state.quiz.quiz_title} · ${state.quiz.subject || ""}` }));

  // Question text
  card.appendChild(el("p", { class: "question-text", text: q.question_text || "" }));

  // Options
  const fieldset = el("fieldset", { attrs: { style: "border:0;padding:0;margin:0" } });
  fieldset.appendChild(el("legend", { class: "visually-hidden", text: "Choose one answer" }));
  const optionsWrap = el("div", { class: "options" });
  const opts = q.options || {};
  for (const key of ["A", "B", "C", "D"]) {
    const textVal = opts[key];
    if (textVal == null || String(textVal).trim() === "") continue; // allow fewer than 4
    const id = `opt-${qnum}-${key}`;
    const selected = state.answers[String(qnum)] === key;

    const label = el("label", { class: "option" + (selected ? " selected" : ""), attrs: { for: id } });
    const input = el("input", { attrs: {
      type: "radio", name: `q-${qnum}`, id, value: key,
    }});
    if (selected) input.checked = true;
    input.addEventListener("change", () => {
      state.answers[String(qnum)] = key;
      // update selected styling
      optionsWrap.querySelectorAll(".option").forEach((o) => o.classList.remove("selected"));
      label.classList.add("selected");
    });
    label.appendChild(input);
    label.appendChild(el("span", { children: [
      el("span", { class: "opt-key", text: key + ". " }),
      document.createTextNode(String(textVal)),
    ]}));
    optionsWrap.appendChild(label);
  }
  fieldset.appendChild(optionsWrap);
  card.appendChild(fieldset);

  // Navigation
  const nav = el("div", { class: "quiz-nav" });
  const prevBtn = el("button", { class: "btn btn--outline", text: "← Previous",
    attrs: { type: "button" } });
  prevBtn.disabled = state.index === 0;
  prevBtn.addEventListener("click", () => { if (state.index > 0) { state.index--; renderQuestion(); } });
  nav.appendChild(prevBtn);

  if (state.index < total - 1) {
    const nextBtn = el("button", { class: "btn btn--primary", text: "Next →", attrs: { type: "button" } });
    nextBtn.addEventListener("click", () => { state.index++; renderQuestion(); });
    nav.appendChild(nextBtn);
  } else {
    const reviewBtn = el("button", { class: "btn btn--secondary", text: "Review & submit", attrs: { type: "button" } });
    reviewBtn.addEventListener("click", renderReview);
    nav.appendChild(reviewBtn);
  }
  card.appendChild(nav);

  wrap.appendChild(card);
  root.replaceChildren(wrap);
}

/* ------------------------------------------------------------------ */
/* Review screen (lists answered / unanswered before submit)          */
/* ------------------------------------------------------------------ */

function renderReview() {
  const total = state.quiz.questions.length;
  const answeredCount = state.quiz.questions.filter(
    (q) => state.answers[String(q.question_number)]).length;
  const unanswered = state.quiz.questions.filter(
    (q) => !state.answers[String(q.question_number)]);

  const wrap = el("div", { class: "quiz-shell" });
  const card = el("div", { class: "quiz-card" });
  card.appendChild(el("h1", { text: "Review your answers" }));
  card.appendChild(el("p", { class: "lead",
    text: `You've answered ${answeredCount} of ${total} questions.` }));

  if (unanswered.length > 0) {
    card.appendChild(el("div", { class: "alert alert--info", attrs: { role: "alert" },
      text: `You have ${unanswered.length} unanswered question${unanswered.length === 1 ? "" : "s"}. Unanswered questions will be marked incorrect. You can go back to answer them, or submit now.` }));
  }

  // Quick jump grid
  const jump = el("div", { class: "options", attrs: { style: "grid-template-columns:repeat(auto-fill,minmax(64px,1fr))" } });
  state.quiz.questions.forEach((q, i) => {
    const answered = !!state.answers[String(q.question_number)];
    const b = el("button", { class: "btn " + (answered ? "btn--outline" : "btn--ghost"),
      text: String(i + 1), attrs: { type: "button", style: answered ? "" : "border:1px dashed var(--error);color:var(--error)" } });
    b.addEventListener("click", () => { state.index = i; renderQuestion(); });
    jump.appendChild(b);
  });
  card.appendChild(jump);

  const nav = el("div", { class: "quiz-nav" });
  const backBtn = el("button", { class: "btn btn--outline", text: "← Keep editing", attrs: { type: "button" } });
  backBtn.addEventListener("click", () => { state.index = total - 1; renderQuestion(); });
  nav.appendChild(backBtn);

  const submitBtn = el("button", { class: "btn btn--primary", text: "Submit quiz", attrs: { type: "button" } });
  submitBtn.addEventListener("click", () => submitQuiz(submitBtn));
  nav.appendChild(submitBtn);
  card.appendChild(nav);

  wrap.appendChild(card);
  root.replaceChildren(wrap);
}

/* ------------------------------------------------------------------ */
/* 5. Submit + grade (server-side)                                     */
/* ------------------------------------------------------------------ */

async function submitQuiz(triggerBtn) {
  stopTimer();
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = "Submitting…"; }
  renderLoading(root, "Grading your quiz…");
  try {
    const res = await apiPost("gradeQuiz", {
      quizId: state.quizId,
      code: state.code,
      answers: state.answers,
    });
    if (!res || res.ok === false) {
      return renderError(root, (res && res.error) || "We couldn't grade your quiz. Please try again.",
        () => renderReview());
    }
    renderResults(res);
  } catch (err) {
    renderError(root, err.message || "We couldn't grade your quiz. Please try again.", () => renderReview());
  }
}

/* ------------------------------------------------------------------ */
/* 6. Results screen                                                   */
/* ------------------------------------------------------------------ */

function renderResults(res) {
  const score = Number(res.score) || 0;
  const total = Number(res.total) || (Array.isArray(res.results) ? res.results.length : 0);
  const pct = total ? Math.round((score / total) * 100) : 0;

  const wrap = el("div", { class: "quiz-shell" });

  const banner = el("div", { class: "score-banner" });
  banner.appendChild(el("p", { class: "eyebrow", text: state.quiz ? state.quiz.quiz_title : "Quiz results" }));
  banner.appendChild(el("div", { class: "score", text: `${score} / ${total}` }));
  banner.appendChild(el("p", { class: "pct mb-0", text: `${pct}%` }));
  wrap.appendChild(banner);

  const list = el("div");
  const results = Array.isArray(res.results) ? res.results : [];
  // Build a lookup of question text/options from in-memory quiz for context.
  const qById = {};
  if (state.quiz) for (const q of state.quiz.questions) qById[String(q.question_number)] = q;

  results.sort((a, b) => num(a.question_number) - num(b.question_number));

  results.forEach((r, i) => {
    const q = qById[String(r.question_number)];
    const isCorrect = !!r.is_correct;
    const item = el("div", { class: "result-item " + (isCorrect ? "correct" : "incorrect") });

    item.appendChild(el("p", { class: "rq",
      text: `${i + 1}. ${q ? q.question_text : "Question " + r.question_number}` }));

    const your = r.your_answer ? labelFor(q, r.your_answer) : "No answer";
    const correct = labelFor(q, r.correct_option);

    item.appendChild(el("p", { class: "ra", children: [
      el("span", { class: "tag " + (isCorrect ? "ok" : "no"), text: isCorrect ? "✓ Correct " : "✗ Incorrect " }),
    ]}));
    item.appendChild(el("p", { class: "ra", children: [
      document.createTextNode("Your answer: "), el("strong", { text: your }),
    ]}));
    if (!isCorrect) {
      item.appendChild(el("p", { class: "ra", children: [
        document.createTextNode("Correct answer: "), el("strong", { text: correct }),
      ]}));
    }
    if (r.explanation) {
      item.appendChild(el("p", { class: "explanation", text: r.explanation }));
    }
    list.appendChild(item);
  });
  wrap.appendChild(list);

  const actions = el("div", { class: "quiz-nav", attrs: { style: "margin-top:1.5rem" } });
  actions.appendChild(el("a", { class: "btn btn--outline", text: "← Back to quizzes", attrs: { href: "quizzes.html" } }));
  const retry = el("button", { class: "btn btn--ghost", text: "Take another quiz", attrs: { type: "button" } });
  retry.addEventListener("click", () => { state.quiz = null; state.answers = {}; state.code = null; renderCodeEntry(); });
  actions.appendChild(retry);
  wrap.appendChild(actions);

  root.replaceChildren(wrap);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function labelFor(q, key) {
  if (!key) return "—";
  if (q && q.options && q.options[key] != null && String(q.options[key]).trim() !== "") {
    return `${key}. ${q.options[key]}`;
  }
  return String(key);
}

/* ------------------------------------------------------------------ */
/* Mock-test timer (optional, Section 13.4)                            */
/* ------------------------------------------------------------------ */

function isMock() {
  return typeof state.quizId === "string" && /^mock/i.test(state.quizId)
    && Number(CONFIG.MOCK_TEST_MINUTES) > 0;
}

function startTimerIfMock() {
  if (!isMock()) return;
  state.remaining = Number(CONFIG.MOCK_TEST_MINUTES) * 60;
  stopTimer();
  state.timer = setInterval(() => {
    state.remaining--;
    const t = document.getElementById("timer");
    if (t) {
      t.textContent = formatTime(state.remaining);
      t.classList.toggle("warn", state.remaining <= 60);
    }
    if (state.remaining <= 0) {
      stopTimer();
      submitQuiz();
    }
  }, 1000);
}

function stopTimer() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

function formatTime(secs) {
  secs = Math.max(0, secs | 0);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `⏱ ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function num(v) { const n = Number(v); return isFinite(n) ? n : 9999; }
