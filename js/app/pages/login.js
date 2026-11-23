/* Login (email OTP only) and first-login signup (BACKEND_RULES.md §3).
 *
 * The code is sent and verified with Supabase Auth email OTP. The OTP limits,
 * admin allowlist and one-active-session check move behind the auth Edge
 * Functions in Phase 3; this page keeps the same three steps.
 */

import { supabase, el, $, $$, param, callFn, getProfile } from '../core.js';
import { mountShell } from '../shell.js';
import { currentRef } from '../../referral.js';

const CONSENT_VERSION = '2026-11';
const RESEND_SECONDS = 60;

const REASONS = {
  buy: 'Log in to buy this course. You’ll come right back to checkout.',
  start: 'Log in to start this quiz. Free quizzes need an account.',
  required: 'Log in to continue. You’ll come right back.',
  ended: 'Your session ended. Enter your email to get a new code and continue where you left off.',
  expired: 'Your session ended. Enter your email to get a new code and continue where you left off.',
};

const steps = { email: $('#step-email'), code: $('#step-code'), signup: $('#step-signup') };
let email = '';
let timer = null;

function show(step) {
  for (const [name, form] of Object.entries(steps)) form.hidden = name !== step;
  const focus = { email: '#email', code: '#otp input', signup: '#display-name' }[step];
  $(focus, steps[step])?.focus();
}

function setError(id, message) {
  const node = $(id);
  node.textContent = message || '';
  node.hidden = !message;
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (label) btn.textContent = label;
}

function finish() {
  const to = sessionStorage.getItem('login_redirect') || 'my-learning.html';
  sessionStorage.removeItem('login_redirect');
  // Only ever return to a page on this site.
  location.href = /^[a-z0-9-]+\.html(\?.*)?$/i.test(to) ? to : 'my-learning.html';
}

function authMessage(err) {
  const status = err?.status;
  const msg = String(err?.message || '').toLowerCase();
  if (status === 429 || msg.includes('rate') || msg.includes('security purposes')) {
    return 'Too many codes requested. Please wait a minute and try again.';
  }
  if (msg.includes('expired') || msg.includes('invalid') || msg.includes('token')) {
    return 'That code is wrong or has expired. Check the email or request a new code.';
  }
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Step 1: email
// ---------------------------------------------------------------------------
steps.email.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('#email').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    setError('#email-error', 'Enter a valid email address.');
    return;
  }
  setError('#email-error', '');
  const btn = $('#send-btn');
  busy(btn, true, 'Sending…');
  const { error } = await supabase.auth.signInWithOtp({ email: value, options: { shouldCreateUser: true } });
  busy(btn, false, 'Send 6-digit code');
  if (error) {
    setError('#email-error', authMessage(error));
    return;
  }
  email = value;
  $('#sent-to').textContent = email;
  buildOtp();
  startResendTimer();
  show('code');
});

// ---------------------------------------------------------------------------
// Step 2: 6-digit code
// ---------------------------------------------------------------------------
function buildOtp() {
  const wrap = $('#otp');
  wrap.replaceChildren(...Array.from({ length: 6 }, (_, i) => el('input', {
    attrs: {
      type: 'text', inputmode: 'numeric', maxlength: '1', pattern: '[0-9]',
      autocomplete: i === 0 ? 'one-time-code' : 'off', 'aria-label': `Digit ${i + 1}`,
    },
  })));
  const boxes = $$('input', wrap);
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      const digits = box.value.replace(/\D/g, '');
      if (digits.length > 1) { spread(digits, i); return; }
      box.value = digits;
      if (digits && i < 5) boxes[i + 1].focus();
      if (code().length === 6) steps.code.requestSubmit();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus();
    });
    box.addEventListener('paste', (e) => {
      e.preventDefault();
      spread((e.clipboardData?.getData('text') || '').replace(/\D/g, ''), i);
    });
  });
  function spread(digits, from) {
    digits.slice(0, 6 - from).split('').forEach((d, k) => { boxes[from + k].value = d; });
    boxes[Math.min(from + digits.length, 5)].focus();
    if (code().length === 6) steps.code.requestSubmit();
  }
}

const code = () => $$('#otp input').map((b) => b.value).join('');

function startResendTimer() {
  const btn = $('#resend');
  let left = RESEND_SECONDS;
  clearInterval(timer);
  btn.disabled = true;
  const tick = () => {
    btn.textContent = left > 0 ? `Resend in 0:${String(left).padStart(2, '0')}` : 'Resend code';
    btn.disabled = left > 0;
    if (left-- <= 0) clearInterval(timer);
  };
  tick();
  timer = setInterval(tick, 1000);
}

$('#resend').addEventListener('click', async () => {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) { setError('#code-error', authMessage(error)); return; }
  setError('#code-error', '');
  startResendTimer();
});

$('#change-email').addEventListener('click', () => { clearInterval(timer); show('email'); });

let verifying = false;
steps.code.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (verifying) return;
  if (code().length !== 6) { setError('#code-error', 'Enter all 6 digits.'); return; }
  verifying = true;
  const btn = $('#verify-btn');
  busy(btn, true, 'Verifying…');
  const { data, error } = await supabase.auth.verifyOtp({ email, token: code(), type: 'email' });
  verifying = false;
  busy(btn, false, 'Verify & continue');
  if (error || !data?.user) {
    setError('#code-error', authMessage(error));
    $$('#otp input').forEach((b) => { b.value = ''; });
    $('#otp input').focus();
    return;
  }
  clearInterval(timer);
  await afterLogin(data.user);
});

async function afterLogin(user) {
  const profile = await getProfile(user.id);
  if (profile?.signup_completed_at) finish();
  else show('signup');
}

// ---------------------------------------------------------------------------
// Step 3: signup (display name, required mobile, consents)
// ---------------------------------------------------------------------------
const MOBILE = /^09\d{9}$/;
const normalizeMobile = (v) => {
  const d = v.replace(/\D/g, '');
  return d.startsWith('639') && d.length === 12 ? '0' + d.slice(2) : d;
};

function signupReady() {
  const nameOk = $('#display-name').value.trim().length >= 2;
  const mobileOk = MOBILE.test(normalizeMobile($('#mobile').value));
  const consentsOk = $$('#consents input[required]').every((c) => c.checked);
  $('#create-btn').disabled = !(nameOk && mobileOk && consentsOk);
}
steps.signup.addEventListener('input', signupReady);
steps.signup.addEventListener('change', signupReady);

steps.signup.addEventListener('submit', async (e) => {
  e.preventDefault();
  signupReady();
  const btn = $('#create-btn');
  if (btn.disabled) return;
  busy(btn, true, 'Creating account…');
  try {
    await callFn('complete-signup', {
      display_name: $('#display-name').value.trim(),
      mobile: normalizeMobile($('#mobile').value),
      consents: $$('#consents input:checked').map((c) => c.value),
      consent_version: CONSENT_VERSION,
      ref_code: currentRef(),
    });
    finish();
  } catch (err) {
    busy(btn, false, 'Create account');
    setError('#signup-error', {
      MOBILE_INVALID: 'Enter a PH mobile number like 0917 123 4567.',
      DISPLAY_NAME_INVALID: 'Display name must be 2–40 characters.',
      CONSENT_REQUIRED: 'Please accept the three required items.',
    }[err.code] || err.message);
  }
});

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
const { user } = await mountShell({});
$('#login-reason').textContent = REASONS[param('reason')] || REASONS[''] || 'Enter your email. We’ll send you a code.';

if (user) {
  await afterLogin(user);
} else {
  show('email');
}
