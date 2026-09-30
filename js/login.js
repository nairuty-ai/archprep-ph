/* js/login.js — passwordless email OTP login page.
 *
 * Two-step flow:
 *   Step 1: enter email → signInWithEmail() sends a 6-digit code
 *   Step 2: enter code  → verifyOtp()  establishes session
 *
 * After a successful login, redirects to:
 *   - sessionStorage.login_redirect (set by requireSession() or the buy flow)
 *   - OR /my-learning.html as default
 */

import { signInWithEmail, verifyOtp } from './auth.js';
import { el, $ }                       from './dom.js';

const root = () => $('#login-root');

async function init() {
  // If already logged in, skip straight to the destination.
  const { getSession } = await import('./supabase.js');
  const session = await getSession();
  if (session) {
    redirect();
    return;
  }
  renderEmailStep();
}

function redirect() {
  const dest = sessionStorage.getItem('login_redirect') || '/my-learning.html';
  sessionStorage.removeItem('login_redirect');
  location.href = dest;
}

// ---------------------------------------------------------------------------
// Step 1 — email
// ---------------------------------------------------------------------------
function renderEmailStep(notice = null) {
  const container = root();
  if (!container) return;
  container.innerHTML = '';

  if (notice) {
    container.appendChild(
      el('div', { class: 'alert alert--info', text: notice, attrs: { role: 'status' } }),
    );
  }

  const alertBox = el('div');
  container.appendChild(alertBox);

  const form = el('form', { attrs: { novalidate: '' } });

  const emailField = el('div', { class: 'field' });
  emailField.appendChild(el('label', { text: 'Email address', attrs: { for: 'login-email' } }));
  const emailInput = el('input', { attrs: {
    type: 'email', id: 'login-email', placeholder: 'you@example.com',
    autocomplete: 'email', inputmode: 'email', required: '',
  }});
  emailField.appendChild(emailInput);
  form.appendChild(emailField);

  const submitBtn = el('button', {
    class: 'btn btn--primary btn--block btn--lg',
    text: 'Send me a code',
    attrs: { type: 'submit' },
  });
  form.appendChild(submitBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.innerHTML = '';
    const email = emailInput.value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      alertBox.appendChild(el('div', { class: 'alert alert--error', text: 'Please enter a valid email address.', attrs: { role: 'alert' } }));
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    try {
      await signInWithEmail(email);
      renderCodeStep(email);
    } catch (err) {
      alertBox.appendChild(el('div', { class: 'alert alert--error', text: err.message || 'Could not send code. Please try again.', attrs: { role: 'alert' } }));
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send me a code';
    }
  });

  container.appendChild(form);
  emailInput.focus();
}

// ---------------------------------------------------------------------------
// Step 2 — OTP code
// ---------------------------------------------------------------------------
function renderCodeStep(email) {
  const container = root();
  if (!container) return;
  container.innerHTML = '';

  const desc = el('p', { attrs: { style: 'margin-bottom:1rem' } });
  desc.appendChild(document.createTextNode('We sent a 6-digit code to '));
  desc.appendChild(el('strong', { text: email }));
  desc.appendChild(document.createTextNode('. Check your inbox — it expires in 10 minutes.'));
  container.appendChild(desc);

  const alertBox = el('div');
  container.appendChild(alertBox);

  const form = el('form', { attrs: { novalidate: '' } });

  const codeField = el('div', { class: 'field' });
  codeField.appendChild(el('label', { text: '6-digit code', attrs: { for: 'login-code' } }));
  const codeInput = el('input', { attrs: {
    type: 'text', id: 'login-code', inputmode: 'numeric',
    autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456',
  }});
  codeField.appendChild(codeInput);
  form.appendChild(codeField);

  const verifyBtn = el('button', {
    class: 'btn btn--primary btn--block btn--lg',
    text: 'Verify & sign in',
    attrs: { type: 'submit' },
  });
  form.appendChild(verifyBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.innerHTML = '';
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {
      alertBox.appendChild(el('div', { class: 'alert alert--error', text: 'Enter the 6-digit code from your email.', attrs: { role: 'alert' } }));
      return;
    }
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying…';
    try {
      await verifyOtp(email, code);
      redirect();
    } catch (err) {
      alertBox.appendChild(el('div', { class: 'alert alert--error', text: err.message || "That code didn't work. Please try again.", attrs: { role: 'alert' } }));
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify & sign in';
    }
  });

  // Resend / back link
  let resendSeconds = 60;
  const resendBtn = el('button', {
    class: 'btn btn--ghost btn--block',
    text: `Resend code (${resendSeconds}s)`,
    attrs: { type: 'button', disabled: '' },
  });
  const countdown = setInterval(() => {
    resendSeconds--;
    if (resendSeconds <= 0) {
      clearInterval(countdown);
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend code';
    } else {
      resendBtn.textContent = `Resend code (${resendSeconds}s)`;
    }
  }, 1000);
  resendBtn.addEventListener('click', () => {
    clearInterval(countdown);
    renderEmailStep('Enter your email again to request a new code.');
  });

  form.appendChild(resendBtn);

  const backBtn = el('button', {
    class: 'btn btn--ghost btn--block',
    text: '← Use a different email',
    attrs: { type: 'button', style: 'margin-top:.25rem' },
  });
  backBtn.addEventListener('click', () => { clearInterval(countdown); renderEmailStep(); });
  form.appendChild(backBtn);

  container.appendChild(form);
  codeInput.focus();
}

init();
