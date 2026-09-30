/* supabase/functions/_shared/scrub.mjs — the outbound-body scrubber.
 *
 * Requirement 28 criterion 5: an Edge Function response body must never carry a
 * secret value or a stack trace. Every response leaves through `json()` in
 * http.ts, which serialises through `serialiseScrubbed()` below, so the
 * guarantee holds for bodies assembled by a handler *and* for bodies derived
 * from a thrown library error.
 *
 * This module is deliberately plain ESM with zero imports and zero runtime
 * APIs: no `Deno.env`, no `fetch`, no `crypto`. Everything here is a pure
 * function of its arguments, which is what lets `tests/scrub.test.mjs` exercise
 * it under `node --test` while Deno loads the same file at the edge. The
 * environment lookup itself lives in http.ts, which passes the resulting values
 * in as data.
 */

/** Replacement text substituted for every redacted secret occurrence. */
export const REDACTED = '[redacted]';

/**
 * Environment variable names whose *values* must never reach a client.
 *
 * The first three are the keys named in Requirement 28 criterion 1; the rest
 * are the SMTP credentials. Both the `SMTP_USER`/`SMTP_PASS` spelling used by
 * `.env.example` and the longer `SMTP_USERNAME`/`SMTP_PASSWORD` spelling are
 * listed so a rename in the Supabase dashboard cannot silently un-redact a
 * credential. Names that are configuration rather than credentials
 * (`SUPABASE_URL`, `HITPAY_API_BASE_URL`, `SMTP_HOST`, `SMTP_PORT`, the sender
 * address) are intentionally absent: redacting a project URL would corrupt
 * legitimate response bodies such as a signed material URL.
 */
export const SECRET_ENV_NAMES = Object.freeze([
  'SUPABASE_SERVICE_ROLE_KEY',
  'HITPAY_API_KEY',
  'HITPAY_WEBHOOK_SALT',
  'SMTP_USER',
  'SMTP_USERNAME',
  'SMTP_PASS',
  'SMTP_PASSWORD',
]);

/** Keys dropped wholesale, whatever they contain. */
const DROPPED_KEYS = new Set(['stack', 'stacktrace', 'stack_trace', 'stackframes', 'stack_frames']);

/** Guard rails for hostile or accidentally recursive bodies. */
const MAX_DEPTH = 12;

/**
 * Collect the secret values present in an environment bag.
 *
 * Returns the distinct non-empty values, longest first, so that a secret which
 * contains another secret as a substring is redacted as one unit. Each value is
 * accompanied by its percent-encoded form, because a secret pasted into an
 * upstream URL comes back encoded and would otherwise survive the scrub.
 *
 * @param {Record<string, string | undefined>} [env] environment bag
 * @param {readonly string[]} [names] variable names to read
 * @returns {string[]} secret values to redact, longest first
 */
export function secretValuesFrom(env = {}, names = SECRET_ENV_NAMES) {
  const values = new Set();

  for (const name of names) {
    const raw = env?.[name];
    // A blank or whitespace-only value means "not configured". Redacting it
    // would replace every space in every response body.
    if (typeof raw !== 'string' || raw.trim() === '') continue;

    for (const candidate of [raw, raw.trim()]) {
      if (candidate === '') continue;
      values.add(candidate);
      const encoded = encodeURIComponent(candidate);
      if (encoded !== candidate) values.add(encoded);
    }
  }

  return [...values].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/* -------------------------------------------------------------------------- */
/* Stack frames                                                               */
/* -------------------------------------------------------------------------- */

/*
 * Four shapes cover what actually appears in a Deno Edge Function error:
 *
 *   at createPaymentRequest (file:///src/_shared/hitpay.ts:42:11)   V8 frame
 *   handler@https://deno.land/std@0.224.0/http/server.ts:61:20      Deno/FF frame
 *   file:///src/functions/create-payment/index.ts:17:9              bare module URL
 *   C:\src\functions\index.ts:17:9                                  Windows path
 *
 * A URL only loses its position suffix when it looks like a frame; an `https`
 * URL with no `:line:col` is left untouched, because a signed Storage URL is a
 * legitimate part of an `issue-material-url` response body.
 */
const FRAME_PATTERNS = [
  /^[ \t]*at\s+\S.*$/gm,
  /[\w$.<>[\]-]*@(?:file|https?):\/\/\S+?:\d+:\d+/g,
  /(?:file|https?):\/\/\S+?:\d+:\d+/g,
  /file:\/\/\/\S+/g,
  /[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\)*[^\s\\/:*?"<>|]+:\d+:\d+/g,
  /(?:^|(?<=\s))\/(?:[\w.\-+@%]+\/)*[\w.\-+@%]+\.(?:[jt]sx?|mjs|cjs):\d+:\d+/gm,
];

/**
 * Remove anything resembling a stack frame from a single string.
 *
 * Whitespace left behind by a removed frame is collapsed so the remaining
 * message reads as one line. A string that was *only* frames collapses to the
 * empty string, which callers treat as "no usable message".
 *
 * @param {string} text
 * @returns {string}
 */
export function stripStackFrames(text) {
  if (typeof text !== 'string' || text === '') return '';

  let out = text;
  for (const pattern of FRAME_PATTERNS) out = out.replace(pattern, ' ');

  return out
    .replace(/[ \t]*\r?\n[\s\r\n]*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*\(\s*\)/g, '')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Secret redaction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Replace every occurrence of every secret value with {@link REDACTED}.
 *
 * Plain `split`/`join` is used rather than a regex so no escaping of the secret
 * is needed, and both the raw and the JSON-escaped spelling of each secret are
 * covered — the latter matters when this runs over already-serialised JSON.
 *
 * @param {string} text
 * @param {readonly string[]} [secrets]
 * @returns {string}
 */
export function redactSecrets(text, secrets = []) {
  if (typeof text !== 'string' || text === '') return '';

  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue;

    out = out.split(secret).join(REDACTED);

    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join(REDACTED);
  }
  return out;
}

/**
 * Scrub one string: secrets first, then stack frames.
 *
 * Secrets go first because a frame-shaped substring may itself contain a key
 * (`https://…?apikey=…:1:1`), and redacting before stripping guarantees the
 * value is gone even if the frame pattern later fails to match.
 *
 * @param {string} text
 * @param {readonly string[]} [secrets]
 * @returns {string}
 */
export function scrubString(text, secrets = []) {
  return stripStackFrames(redactSecrets(text, secrets));
}

/* -------------------------------------------------------------------------- */
/* Whole-body scrubbing                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Deep-copy a value, scrubbing every string and dropping every stack key.
 *
 * Object keys are scrubbed as well as values, since a key built from upstream
 * data can carry a secret just as easily. `undefined`, functions, and symbols
 * are dropped exactly as `JSON.stringify` would drop them; cycles become
 * `"[circular]"` and runaway nesting becomes `"[truncated]"` so a hostile body
 * cannot turn error shaping into a crash.
 *
 * @param {unknown} value
 * @param {readonly string[]} [secrets]
 * @returns {unknown}
 */
export function scrubBody(value, secrets = []) {
  return walk(value, secrets, new WeakSet(), 0);
}

function walk(value, secrets, seen, depth) {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string') return scrubString(value, secrets);
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type === 'bigint') return scrubString(value.toString(), secrets);
  if (type !== 'object') return undefined; // undefined, function, symbol

  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  try {
    if (value instanceof Error) {
      // An Error reaching a body is the exact leak Requirement 28.5 targets:
      // keep the scrubbed message, discard the stack entirely.
      return { message: scrubString(value.message ?? '', secrets) };
    }

    if (Array.isArray(value)) {
      return value.map((item) => {
        const scrubbed = walk(item, secrets, seen, depth + 1);
        return scrubbed === undefined ? null : scrubbed;
      });
    }

    if (value instanceof Date) return value.toISOString();
    if (value instanceof Map) return walk(Object.fromEntries(value), secrets, seen, depth);
    if (value instanceof Set) return walk([...value], secrets, seen, depth);

    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (DROPPED_KEYS.has(key.toLowerCase())) continue;
      const scrubbed = walk(item, secrets, seen, depth + 1);
      if (scrubbed === undefined) continue;
      out[scrubString(key, secrets) || REDACTED] = scrubbed;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Scrub a value and serialise it to the JSON text of a response body.
 *
 * The serialised text gets a second redaction pass. The structural pass cannot
 * see a secret that only forms once JSON escaping is applied, and a body that
 * somehow refuses to serialise must still produce a safe response rather than
 * throwing inside the error handler.
 *
 * @param {unknown} value
 * @param {readonly string[]} [secrets]
 * @returns {string} JSON text with zero secret values and zero stack frames
 */
export function serialiseScrubbed(value, secrets = []) {
  let text;
  try {
    text = JSON.stringify(scrubBody(value, secrets));
  } catch {
    text = undefined;
  }
  if (typeof text !== 'string') text = 'null';

  return redactSecrets(text, secrets);
}
