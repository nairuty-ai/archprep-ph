/* Login (email only) and first-login signup (BACKEND_RULES.md §3).
 *
 * One Supabase Auth email does both: it carries a login link and, once the
 * email template shows {{ .Token }} (needs custom SMTP on the free plan), a
 * 6-digit code. The link lands back on this page with the session in the URL
 * fragment; the code is typed into step 2. The OTP limits, admin allowlist
 * and one-active-session check move behind the auth Edge Functions in
 * Phase 3; this page keeps the same three steps.
 */

import { supabase, el, $, $$, param, callFn, getProfile, setBusy } from '../core.js';
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
  const codeTarget = $('#code-fields').hidden ? '#change-email' : '#otp input';
  const focus = { email: '#email', code: codeTarget, signup: '#display-name' }[step];
  $(focus, steps[step])?.focus();
}

function setError(id, message) {
  const node = $(id);
  node.textContent = message || '';
  node.hidden = !message;
}

// Where to go after login. A login link usually opens in a new tab, which
// has its own sessionStorage, so the target also travels in ?next=.
function returnTarget() {
  return param('next') || sessionStorage.getItem('login_redirect') || 'my-learning.html';
}

function finish() {
  const to = returnTarget();
  sessionStorage.removeItem('login_redirect');
  // Only ever return to a page on this site.
  location.href = /^[a-z0-9-]+(\.html)?(\?.*)?$/i.test(to) ? to : 'my-learning.html';
}

function authMessage(err) {
  const status = err?.status;
  const msg = String(err?.message || '').toLowerCase();
  if (status === 429 || msg.includes('rate') || msg.includes('security purposes')) {
    return 'Too many login emails requested. Please wait a few minutes and try again.';
  }
  if (msg.includes('expired') || msg.includes('invalid') || msg.includes('token')) {
    return 'That code is wrong or has expired. Check the email or request a new code.';
  }
  return 'Something went wrong. Please try again.';
}

function sendLoginEmail(address) {
  const back = `${location.origin}${location.pathname}?next=${encodeURIComponent(returnTarget())}`;
  return supabase.auth.signInWithOtp({
    email: address,
    options: { shouldCreateUser: true, emailRedirectTo: back },
  });
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
  setBusy(btn, true);
  const { error } = await sendLoginEmail(value);
  setBusy(btn, false);
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
      wrap.classList.remove('is-error');
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
    btn.textContent = left > 0 ? `Resend in 0:${String(left).padStart(2, '0')}` : 'Resend email';
    btn.disabled = left > 0;
    if (left-- <= 0) clearInterval(timer);
  };
  tick();
  timer = setInterval(tick, 1000);
}

$('#resend').addEventListener('click', async () => {
  const { error } = await sendLoginEmail(email);
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
  setBusy(btn, true);
  const { data, error } = await supabase.auth.verifyOtp({ email, token: code(), type: 'email' });
  verifying = false;
  setBusy(btn, false);
  if (error || !data?.user) {
    setError('#code-error', authMessage(error));
    const otp = $('#otp');
    otp.classList.remove('is-error');
    void otp.offsetWidth; // restart the shake on a repeat miss
    otp.classList.add('is-error');
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
  setBusy(btn, true);
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
    setBusy(btn, false);
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
// A used or expired login link comes back with the error in the fragment.
const linkError = new URLSearchParams(location.hash.slice(1)).get('error_description');

// mountShell waits for the Supabase client to read a login link's session
// from the fragment; only then is it safe to tidy the address bar.
const { user, settings } = await mountShell({});
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

// Until the email template carries {{ .Token }} (needs custom SMTP on the
// free plan) the email has only a link, so step 2 hides the code boxes.
if (settings.login_email_code !== 'on') {
  for (const id of ['#code-hint', '#code-fields', '#verify-btn']) $(id).hidden = true;
  $('#link-hint').hidden = false;
}
$('#login-reason').textContent = REASONS[param('reason')] || 'Enter your email. We’ll send you a login link.';

if (user) {
  await afterLogin(user);
} else {
  show('email');
  if (linkError) setError('#email-error', 'That login link has expired or was already used. Enter your email to get a new one.');
}
