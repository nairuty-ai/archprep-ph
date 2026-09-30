/* js/quiz-runner.js — quiz taking, review, and results runner.
 *
 * URL params:
 *   ?quiz_id=UUID      — directly load a quiz
 *   ?product_id=UUID   — resolve the first quiz in the pack, then load it
 *
 * States: loading → taking → review → results
 *
 * Requirements 21.1–21.9
 */

import { requireSession } from './auth.js';
import { api } from './api.js';
import { supabase } from './supabase.js';
import { el, $, setText, peso } from './dom.js';
import { renderLoading, renderError } from './states.js';

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function initQuizRunner(container) {
  try {
    await requireSession();
  } catch {
    return;
  }

  const params = new URLSearchParams(location.search);
  let quizId    = params.get('quiz_id');
  const productId = params.get('product_id');

  renderLoading(container, 'Loading quiz…');

  // Resolve product_id → quiz_id via pack_quizzes
  if (!quizId && productId) {
    try {
      const { data, error } = await supabase
        .from('pack_quizzes')
        .select('quiz_id')
        .eq('product_id', productId)
        .limit(1);
      if (error || !data?.length) {
        renderError(container, 'No quiz found for this product.');
        return;
      }
      quizId = data[0].quiz_id;
    } catch (err) {
      renderError(container, 'Could not load the quiz. Please try again.', () => initQuizRunner(container));
      return;
    }
  }

  if (!quizId) {
    renderError(container, 'No quiz specified. Please go back to My Learning.', null);
    return;
  }

  await loadQuiz(container, quizId);
}

// ---------------------------------------------------------------------------
// Load and start quiz
// ---------------------------------------------------------------------------
async function loadQuiz(container, quizId) {
  renderLoading(container, 'Loading quiz…');

  let quizData;
  try {
    quizData = await api.getQuiz(quizId);
  } catch (err) {
    renderError(container, err.message || 'Could not load this quiz.', () => loadQuiz(container, quizId));
    return;
  }

  const { quiz, questions } = quizData;
  if (!questions?.length) {
    renderError(container, 'This quiz has no questions yet.', null);
    return;
  }

  // Update document title
  if (quiz?.title) {
    document.title = quiz.title + ' — ArchPrep PH';
  }

  startTaking(container, quiz, questions, quizId);
}

// ---------------------------------------------------------------------------
// State: Taking (Requirement 21.1–21.5)
// ---------------------------------------------------------------------------
function startTaking(container, quiz, questions, quizId) {
  // Answers map: questionIndex → selectedOption (string)
  const answers = new Map();
  let currentIndex = 0;
  let timerInterval = null;
  let timerSeconds  = quiz?.timer_minutes ? quiz.timer_minutes * 60 : 0;

  container.innerHTML = '';

  // ---- Timer bar ----
  const timerBar = el('div', {});
  timerBar.style.cssText = 'margin-bottom:1rem;';
  const timerLabel = el('p', {});
  timerLabel.style.cssText = 'font-weight:700;font-size:var(--fs-xs);color:var(--muted);text-align:right;';

  if (timerSeconds > 0) {
    updateTimerLabel(timerLabel, timerSeconds);
    timerBar.appendChild(timerLabel);
    container.appendChild(timerBar);

    timerInterval = setInterval(() => {
      timerSeconds -= 1;
      updateTimerLabel(timerLabel, timerSeconds);
      if (timerSeconds <= 0) {
        clearInterval(timerInterval);
        timerLabel.textContent = 'Time is up! Submitting…';
        submitQuiz(container, quiz, questions, answers, quizId);
      }
    }, 1000);
  }

  // ---- Progress ----
  const progressWrap = el('div', { attrs: { style: 'margin-bottom:1.5rem;' } });
  const progressText = el('p', {});
  progressText.style.cssText = 'font-size:var(--fs-xs);font-weight:700;color:var(--muted);margin-bottom:.35rem;';
  const progressBar = el('div', {});
  progressBar.style.cssText = 'height:6px;border-radius:999px;background:var(--border);overflow:hidden;';
  const progressFill = el('div', {});
  progressFill.style.cssText = 'height:100%;background:var(--accent);transition:width .2s ease;';
  progressBar.appendChild(progressFill);
  progressWrap.appendChild(progressText);
  progressWrap.appendChild(progressBar);
  container.appendChild(progressWrap);

  // ---- Question area ----
  const questionArea = el('div', { attrs: { id: 'question-area' } });
  container.appendChild(questionArea);

  // ---- Navigation ----
  const navRow = el('div', {});
  navRow.style.cssText = 'display:flex;gap:.75rem;margin-top:1.5rem;flex-wrap:wrap;';
  const btnPrev = el('button', {
    class: 'btn btn--outline',
    text: '← Previous',
    attrs: { type: 'button', 'aria-label': 'Previous question' },
  });
  const btnNext = el('button', {
    class: 'btn btn--primary',
    text: 'Next →',
    attrs: { type: 'button', 'aria-label': 'Next question' },
  });
  const btnReview = el('button', {
    class: 'btn btn--secondary',
    text: 'Review & Submit',
    attrs: { type: 'button', 'aria-label': 'Review all answers and submit' },
  });
  navRow.appendChild(btnPrev);
  navRow.appendChild(btnNext);
  navRow.appendChild(btnReview);
  container.appendChild(navRow);

  function renderQuestion(index) {
    currentIndex = index;
    const q = questions[index];
    const total = questions.length;

    // Update progress
    progressText.textContent = `Question ${index + 1} of ${total}`;
    progressFill.style.width = `${((index + 1) / total) * 100}%`;

    // Navigation state
    btnPrev.disabled    = index === 0;
    btnNext.hidden      = index === total - 1;
    btnReview.hidden    = index !== total - 1;

    // Render question
    questionArea.innerHTML = '';

    const qCard = el('div', { class: 'card' });
    qCard.style.cssText = 'padding:1.5rem;';

    const qText = el('p', {});
    qText.style.cssText = 'font-weight:700;font-size:var(--fs-md);margin-bottom:1.25rem;white-space:pre-wrap;';
    qText.textContent = q.question_text || q.text || '';
    qCard.appendChild(qText);

    // Options
    const options = q.options || [];
    const fieldset = el('fieldset', {});
    fieldset.style.cssText = 'border:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.6rem;';
    const legend = el('legend', { class: 'visually-hidden', text: 'Choose an answer' });
    fieldset.appendChild(legend);

    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const optId  = `q${index}-opt${i}`;
      const optVal = typeof option === 'object' ? (option.key || option.value || String(i)) : String(option);
      const optText = typeof option === 'object' ? (option.text || option.label || optVal) : String(option);

      const label = el('label', {});
      label.style.cssText = [
        'display:flex;align-items:flex-start;gap:.6rem;',
        'border:1px solid var(--border);border-radius:var(--radius-sm);',
        'padding:.75rem 1rem;cursor:pointer;',
        'font-size:var(--fs-sm);line-height:1.4;',
        'transition:border-color .12s,background .12s;',
      ].join('');

      const radio = document.createElement('input');
      radio.type    = 'radio';
      radio.name    = `question-${index}`;
      radio.id      = optId;
      radio.value   = optVal;
      radio.style.cssText = 'flex-shrink:0;margin-top:.15rem;accent-color:var(--accent);';

      if (answers.get(index) === optVal) {
        radio.checked = true;
        label.style.borderColor = 'var(--accent)';
        label.style.background  = '#FEF4EE';
      }

      const textSpan = document.createElement('span');
      textSpan.textContent = optText;

      label.setAttribute('for', optId);

      label.addEventListener('mouseenter', () => {
        if (!radio.checked) label.style.background = '#f5f5f0';
      });
      label.addEventListener('mouseleave', () => {
        if (!radio.checked) label.style.background = '';
      });

      radio.addEventListener('change', () => {
        // Deselect all
        fieldset.querySelectorAll('label').forEach((l) => {
          l.style.borderColor = '';
          l.style.background  = '';
        });
        answers.set(index, optVal);
        label.style.borderColor = 'var(--accent)';
        label.style.background  = '#FEF4EE';
      });

      label.appendChild(radio);
      label.appendChild(textSpan);
      fieldset.appendChild(label);
    }

    qCard.appendChild(fieldset);
    questionArea.appendChild(qCard);

    // Focus management
    const firstInput = fieldset.querySelector('input');
    if (firstInput) firstInput.focus();
  }

  btnPrev.addEventListener('click', () => {
    if (currentIndex > 0) renderQuestion(currentIndex - 1);
  });
  btnNext.addEventListener('click', () => {
    if (currentIndex < questions.length - 1) renderQuestion(currentIndex + 1);
  });
  btnReview.addEventListener('click', () => {
    if (timerInterval) clearInterval(timerInterval);
    startReview(container, quiz, questions, answers, quizId);
  });

  renderQuestion(0);
}

function updateTimerLabel(el, seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  el.textContent = `Time remaining: ${m}:${s}`;
  if (seconds <= 60) {
    el.style.color = 'var(--error)';
    el.style.fontWeight = '800';
  }
}

// ---------------------------------------------------------------------------
// State: Review (Requirement 21.6–21.7)
// ---------------------------------------------------------------------------
function startReview(container, quiz, questions, answers, quizId) {
  container.innerHTML = '';

  const heading = el('h2', { text: 'Review your answers' });
  heading.style.marginBottom = '1rem';
  container.appendChild(heading);

  const unanswered = questions.filter((_, i) => !answers.has(i));

  if (unanswered.length > 0) {
    const warning = el('div', {});
    warning.style.cssText = [
      'background:#FFF3CD;border:1px solid #FFCA2C;',
      'border-radius:var(--radius-sm);padding:.75rem 1rem;',
      'font-size:var(--fs-xs);font-weight:700;color:#856404;margin-bottom:1rem;',
    ].join('');
    warning.textContent = `⚠️  ${unanswered.length} unanswered question${unanswered.length > 1 ? 's' : ''}. Unanswered questions count as incorrect.`;
    container.appendChild(warning);
  }

  const list = el('ol', {});
  list.style.cssText = 'margin:0 0 1.5rem;padding:0;list-style:none;display:flex;flex-direction:column;gap:.5rem;';

  questions.forEach((q, i) => {
    const answered = answers.has(i);
    const item = el('li', {});
    item.style.cssText = [
      'display:flex;align-items:center;justify-content:space-between;gap:1rem;',
      'padding:.65rem 1rem;border-radius:var(--radius-sm);border:1px solid var(--border);',
      'background:' + (answered ? '#F4FAF6' : '#FFF9F0') + ';',
      'font-size:var(--fs-xs);',
    ].join('');

    const qLabel = document.createElement('span');
    qLabel.textContent = `Q${i + 1}: ` + (q.question_text || q.text || '').slice(0, 80) + (((q.question_text || q.text || '').length > 80) ? '…' : '');

    const badge = document.createElement('span');
    badge.textContent = answered ? '✓ Answered' : '— Unanswered';
    badge.style.cssText = 'font-weight:700;white-space:nowrap;color:' + (answered ? 'var(--success)' : 'var(--muted)') + ';';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--secondary);font-weight:700;font-size:var(--fs-xs);text-decoration:underline;padding:0;';
    editBtn.setAttribute('aria-label', 'Edit answer for question ' + (i + 1));
    editBtn.addEventListener('click', () => {
      startTakingFromIndex(container, quiz, questions, answers, quizId, i);
    });

    item.appendChild(qLabel);
    item.appendChild(badge);
    item.appendChild(editBtn);
    list.appendChild(item);
  });

  container.appendChild(list);

  const btnSubmit = el('button', {
    class: 'btn btn--primary btn--lg',
    text: 'Submit quiz',
    attrs: { type: 'button', 'aria-label': 'Submit quiz and see results' },
  });
  container.appendChild(btnSubmit);

  btnSubmit.addEventListener('click', () => {
    submitQuiz(container, quiz, questions, answers, quizId);
  });
}

// Resume taking from a specific question index (used from review "Edit" buttons)
function startTakingFromIndex(container, quiz, questions, answers, quizId, fromIndex) {
  // Rebuild taking state, but show the specified question
  // We reuse startTaking but need to navigate to `fromIndex`.
  // Simple approach: re-render taking state and click "next" to navigate.
  // Instead, we'll refactor startTaking to accept an initial index.
  startTakingAt(container, quiz, questions, answers, quizId, fromIndex);
}

// Variant of startTaking that starts at a specific question index
// and re-uses the existing answers map (so progress is preserved).
function startTakingAt(container, quiz, questions, answers, quizId, startIndex) {
  container.innerHTML = '';

  let currentIndex = startIndex;
  const total = questions.length;

  const progressWrap = el('div', { attrs: { style: 'margin-bottom:1.5rem;' } });
  const progressText = el('p', {});
  progressText.style.cssText = 'font-size:var(--fs-xs);font-weight:700;color:var(--muted);margin-bottom:.35rem;';
  const progressBar = el('div', {});
  progressBar.style.cssText = 'height:6px;border-radius:999px;background:var(--border);overflow:hidden;';
  const progressFill = el('div', {});
  progressFill.style.cssText = 'height:100%;background:var(--accent);transition:width .2s ease;';
  progressBar.appendChild(progressFill);
  progressWrap.appendChild(progressText);
  progressWrap.appendChild(progressBar);
  container.appendChild(progressWrap);

  const questionArea = el('div', { attrs: { id: 'question-area' } });
  container.appendChild(questionArea);

  const navRow = el('div', {});
  navRow.style.cssText = 'display:flex;gap:.75rem;margin-top:1.5rem;flex-wrap:wrap;';
  const btnPrev = el('button', {
    class: 'btn btn--outline',
    text: '← Previous',
    attrs: { type: 'button', 'aria-label': 'Previous question' },
  });
  const btnNext = el('button', {
    class: 'btn btn--primary',
    text: 'Next →',
    attrs: { type: 'button', 'aria-label': 'Next question' },
  });
  const btnReview = el('button', {
    class: 'btn btn--secondary',
    text: 'Review & Submit',
    attrs: { type: 'button', 'aria-label': 'Review all answers and submit' },
  });
  navRow.appendChild(btnPrev);
  navRow.appendChild(btnNext);
  navRow.appendChild(btnReview);
  container.appendChild(navRow);

  function renderQuestion(index) {
    currentIndex = index;
    const q = questions[index];

    progressText.textContent = `Question ${index + 1} of ${total}`;
    progressFill.style.width = `${((index + 1) / total) * 100}%`;
    btnPrev.disabled = index === 0;
    btnNext.hidden   = index === total - 1;
    btnReview.hidden = index !== total - 1;

    questionArea.innerHTML = '';
    const qCard = el('div', { class: 'card' });
    qCard.style.cssText = 'padding:1.5rem;';

    const qText = el('p', {});
    qText.style.cssText = 'font-weight:700;font-size:var(--fs-md);margin-bottom:1.25rem;white-space:pre-wrap;';
    qText.textContent = q.question_text || q.text || '';
    qCard.appendChild(qText);

    const options = q.options || [];
    const fieldset = el('fieldset', {});
    fieldset.style.cssText = 'border:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.6rem;';
    const legend = el('legend', { class: 'visually-hidden', text: 'Choose an answer' });
    fieldset.appendChild(legend);

    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const optId  = `q${index}-opt${i}`;
      const optVal = typeof option === 'object' ? (option.key || option.value || String(i)) : String(option);
      const optText = typeof option === 'object' ? (option.text || option.label || optVal) : String(option);

      const label = el('label', {});
      label.style.cssText = [
        'display:flex;align-items:flex-start;gap:.6rem;',
        'border:1px solid var(--border);border-radius:var(--radius-sm);',
        'padding:.75rem 1rem;cursor:pointer;',
        'font-size:var(--fs-sm);line-height:1.4;',
        'transition:border-color .12s,background .12s;',
      ].join('');

      const radio = document.createElement('input');
      radio.type  = 'radio';
      radio.name  = `question-${index}`;
      radio.id    = optId;
      radio.value = optVal;
      radio.style.cssText = 'flex-shrink:0;margin-top:.15rem;accent-color:var(--accent);';

      if (answers.get(index) === optVal) {
        radio.checked = true;
        label.style.borderColor = 'var(--accent)';
        label.style.background  = '#FEF4EE';
      }

      const textSpan = document.createElement('span');
      textSpan.textContent = optText;

      label.setAttribute('for', optId);
      label.addEventListener('mouseenter', () => { if (!radio.checked) label.style.background = '#f5f5f0'; });
      label.addEventListener('mouseleave', () => { if (!radio.checked) label.style.background = ''; });
      radio.addEventListener('change', () => {
        fieldset.querySelectorAll('label').forEach((l) => { l.style.borderColor = ''; l.style.background = ''; });
        answers.set(index, optVal);
        label.style.borderColor = 'var(--accent)';
        label.style.background  = '#FEF4EE';
      });

      label.appendChild(radio);
      label.appendChild(textSpan);
      fieldset.appendChild(label);
    }

    qCard.appendChild(fieldset);
    questionArea.appendChild(qCard);
  }

  btnPrev.addEventListener('click', () => { if (currentIndex > 0) renderQuestion(currentIndex - 1); });
  btnNext.addEventListener('click', () => { if (currentIndex < total - 1) renderQuestion(currentIndex + 1); });
  btnReview.addEventListener('click', () => startReview(container, quiz, questions, answers, quizId));

  renderQuestion(currentIndex);
}

// ---------------------------------------------------------------------------
// Submit quiz
// ---------------------------------------------------------------------------
async function submitQuiz(container, quiz, questions, answers, quizId) {
  container.innerHTML = '';
  const loadingMsg = el('div', { class: 'state-box state-loading' });
  loadingMsg.style.cssText = 'text-align:center;padding:2rem;';
  loadingMsg.textContent = 'Submitting quiz…';
  container.appendChild(loadingMsg);

  // Build answers payload: { question_id: selected_option }
  const payload = {};
  questions.forEach((q, i) => {
    const questionId = q.id || q.question_id || String(i);
    payload[questionId] = answers.get(i) ?? null;
  });

  let result;
  try {
    result = await api.gradeQuiz({ quiz_id: quizId, answers: payload });
  } catch (err) {
    renderError(container, err.message || 'Could not grade the quiz. Please try again.', () => submitQuiz(container, quiz, questions, answers, quizId));
    return;
  }

  showResults(container, quiz, questions, answers, result, quizId);
}

// ---------------------------------------------------------------------------
// State: Results (Requirement 21.8–21.9)
// ---------------------------------------------------------------------------
function showResults(container, quiz, questions, answers, result, quizId) {
  container.innerHTML = '';

  const score       = result.score ?? result.correct ?? 0;
  const total       = result.total ?? questions.length;
  const percentage  = total > 0 ? Math.round((score / total) * 100) : 0;
  const passed      = percentage >= (quiz?.pass_score ?? 75);

  // Score card
  const scoreCard = el('div', { class: 'card', attrs: { style: 'text-align:center;padding:2rem;margin-bottom:1.5rem;' } });
  const scoreIcon = el('p', {});
  scoreIcon.style.cssText = 'font-size:3rem;margin-bottom:.5rem;';
  scoreIcon.textContent = passed ? '🎉' : '📝';

  const scoreHeading = el('h1', {});
  scoreHeading.style.fontSize = 'var(--fs-xl)';
  scoreHeading.textContent = `You scored ${score} out of ${total}`;

  const pctEl = el('p', {});
  pctEl.style.cssText = 'font-size:var(--fs-lg);font-weight:700;color:' + (passed ? 'var(--success)' : 'var(--error)') + ';margin:0;';
  pctEl.textContent = percentage + '%  ·  ' + (passed ? 'Passed' : 'Keep practising');

  scoreCard.appendChild(scoreIcon);
  scoreCard.appendChild(scoreHeading);
  scoreCard.appendChild(pctEl);
  container.appendChild(scoreCard);

  // Try again button
  const btnTryAgain = el('button', {
    class: 'btn btn--outline',
    text: 'Try again',
    attrs: { type: 'button', 'aria-label': 'Retake this quiz from the start' },
  });
  btnTryAgain.style.marginBottom = '2rem';
  btnTryAgain.addEventListener('click', () => loadQuiz(container, quizId));
  container.appendChild(btnTryAgain);

  // Per-question results
  const resultsHeading = el('h2', { text: 'Question breakdown' });
  resultsHeading.style.cssText = 'font-size:var(--fs-lg);margin-bottom:1rem;';
  container.appendChild(resultsHeading);

  const resultRows = result.results ?? result.question_results ?? [];
  const revealMode = quiz?.reveal_mode ?? 'always';

  questions.forEach((q, i) => {
    const qResult = resultRows[i] || resultRows.find((r) => (r.question_id || r.id) === (q.id || q.question_id)) || {};
    const correct         = qResult.correct ?? false;
    const submittedAnswer = qResult.submitted ?? answers.get(i) ?? '—';
    const correctAnswer   = qResult.correct_answer ?? qResult.answer ?? '?';
    const explanation     = qResult.explanation ?? q.explanation ?? null;

    const showExplanation = revealMode === 'always' || (revealMode === 'on_pass' && passed);

    const row = el('div', { class: 'card' });
    row.style.cssText = [
      'padding:1rem 1.25rem;',
      'border-left:4px solid ' + (correct ? 'var(--success)' : 'var(--error)') + ';',
    ].join('');

    const qNum = el('p', {});
    qNum.style.cssText = 'font-size:var(--fs-xs);font-weight:700;color:var(--muted);margin-bottom:.25rem;';
    qNum.textContent = `Question ${i + 1} · ` + (correct ? '✓ Correct' : '✗ Incorrect');

    const qText = el('p', {});
    qText.style.cssText = 'font-weight:700;margin-bottom:.5rem;';
    qText.textContent = q.question_text || q.text || '';

    row.appendChild(qNum);
    row.appendChild(qText);

    const answerGrid = el('div', {});
    answerGrid.style.cssText = 'display:flex;flex-direction:column;gap:.25rem;font-size:var(--fs-xs);';

    const yourAnswer = el('p', {});
    yourAnswer.textContent = 'Your answer: ';
    const yourSpan = document.createElement('strong');
    yourSpan.textContent = String(submittedAnswer);
    yourAnswer.appendChild(yourSpan);
    answerGrid.appendChild(yourAnswer);

    if (!correct) {
      const correctEl = el('p', {});
      correctEl.style.color = 'var(--success)';
      correctEl.textContent = 'Correct answer: ';
      const cSpan = document.createElement('strong');
      cSpan.textContent = String(correctAnswer);
      correctEl.appendChild(cSpan);
      answerGrid.appendChild(correctEl);
    }

    if (showExplanation && explanation) {
      const expEl = el('p', {});
      expEl.style.cssText = 'color:var(--ink-soft);margin-top:.5rem;font-size:var(--fs-xs);';
      expEl.textContent = explanation;
      answerGrid.appendChild(expEl);
    }

    row.appendChild(answerGrid);

    const wrapper = el('div', { attrs: { style: 'margin-bottom:.75rem;' } });
    wrapper.appendChild(row);
    container.appendChild(wrapper);
  });
}
