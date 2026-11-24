/* Work with us: no openings right now, so collect an email (required) and an
 * optional résumé to notify people when a role opens. */

import { $ } from '../core.js';
import { mountShell } from '../shell.js';

const MAX_BYTES = 5 * 1024 * 1024;
const RESUME_EXT = /\.(pdf|docx?)$/i;

await mountShell({});

const form = $('#notify-form');
const errorBox = $('#form-error');

function fail(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

const REASONS = {
  EMAIL_INVALID: 'Enter a valid email address.',
  RATE_LIMITED: 'Too many sign-ups from this connection. Please try again in an hour.',
  RESUME_TOO_LARGE: 'Your résumé must be 5 MB or smaller.',
  RESUME_TYPE: 'Your résumé must be a PDF, DOC or DOCX file.',
  CONSENT_REQUIRED: 'Please tick the privacy box to continue.',
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.hidden = true;

  const email = $('#email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(REASONS.EMAIL_INVALID);
  const file = $('#resume').files[0];
  if (file && file.size > MAX_BYTES) return fail(REASONS.RESUME_TOO_LARGE);
  if (file && !RESUME_EXT.test(file.name)) return fail(REASONS.RESUME_TYPE);
  if (!form.consent.checked) return fail(REASONS.CONSENT_REQUIRED);

  const btn = $('#submit-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch(`${window.APP_CONFIG.SUPABASE_URL}/functions/v1/careers-interest`, {
      method: 'POST',
      headers: { apikey: window.APP_CONFIG.SUPABASE_ANON_KEY },
      body: new FormData(form),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.ok) {
      throw new Error(REASONS[payload?.details?.reason] || payload?.message || 'Something went wrong. Please try again.');
    }
    $('#done-text').textContent = payload.new
      ? `We’ll email ${email} when a role opens.`
      : `We updated your details. We’ll email ${email} when a role opens.`;
    form.hidden = true;
    $('#done').hidden = false;
    $('#done').focus();
  } catch (err) {
    fail(err.message === 'Failed to fetch' ? 'You seem to be offline. Check your connection and try again.' : err.message);
    btn.disabled = false;
    btn.textContent = 'Notify me';
  }
});
