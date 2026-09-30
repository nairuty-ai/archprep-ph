/* js/referral.js — referral code capture, storage, and retrieval.
 *
 * Requirements 22.1–22.5:
 *   - First-touch capture: the first ?ref=CODE seen is stored; later ones ignored.
 *   - 30-day TTL: a stored code older than 30 days is discarded.
 *   - currentRef() returns null when the code is absent or expired.
 *   - captureRef() is called on every page load via initNav().
 *
 * The referral code lives in localStorage under 'archprep_ref' as JSON:
 *   { code: "ABCD1234", captured_at: 1700000000000 }
 */

const STORAGE_KEY  = 'archprep_ref';
const TTL_MS       = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Read the stored record, discarding it if expired.
 * @returns {{ code: string, captured_at: number } | null}
 */
function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (typeof record?.code !== 'string' || typeof record?.captured_at !== 'number') return null;

    // Requirement 22.4: discard when older than 30 days.
    if (Date.now() - record.captured_at > TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

/**
 * Capture a referral code from the current URL's `?ref=` parameter.
 *
 * First-touch only: if a code is already stored and unexpired, do nothing.
 * Call this on every page load (done automatically by initNav()).
 */
export function captureRef() {
  try {
    const params = new URLSearchParams(location.search);
    const code   = params.get('ref');
    if (!code || typeof code !== 'string' || code.trim() === '') return;

    // Requirement 22.3: do not overwrite an unexpired stored code.
    const existing = readStored();
    if (existing) return;

    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      code:        code.trim(),
      captured_at: Date.now(),
    }));
  } catch {
    // localStorage may be unavailable in some privacy modes — silently skip.
  }
}

/**
 * The current unexpired referral code, or null.
 *
 * Returns null when:
 *   - nothing is stored
 *   - the stored code is older than 30 days
 *   - localStorage is unavailable
 */
export function currentRef() {
  return readStored()?.code ?? null;
}

/**
 * Build the referral link for a user from their ref_code.
 *
 * @param {string} refCode — from profiles.ref_code
 * @returns {string}
 */
export function buildRefLink(refCode) {
  const origin = location.origin;
  return `${origin}/?ref=${encodeURIComponent(refCode)}`;
}

/** Clear the stored referral code (call after a successful purchase). */
export function clearRef() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
