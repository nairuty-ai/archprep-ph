/*****************************************************************************
 * ArchPrep PH — Google Apps Script Web App (the ONLY backend)
 * ---------------------------------------------------------------------------
 * Bind this script to the "Mission Control" Google Sheet (Extensions > Apps
 * Script) under the account rehinaneel@gmail.com, then deploy as a Web App:
 *   - Execute as:        Me (rehinaneel@gmail.com)
 *   - Who has access:    Anyone
 * Copy the resulting ".../exec" URL into config.js (APPS_SCRIPT_URL).
 *
 * SECURITY (Section 5 & 14): the column `correct_option` and the
 * `explanation` field are NEVER returned by any endpoint except gradeQuiz,
 * and only after a valid code + submission.
 *
 * CORS (Section 8): we only ever return JSON via ContentService. The static
 * site calls us as "simple requests" (GET with query params, or POST with
 * Content-Type: text/plain) so the browser does NOT send a CORS preflight.
 * Apps Script cannot set custom CORS headers, so simple requests are the
 * only reliable approach — do not change the front-end to send JSON content
 * type or custom headers.
 *
 * Required Sheet tabs (exact names): Products, Quizzes, AccessCodes,
 * Settings, Attempts. Column headers must match Section 7 exactly.
 *****************************************************************************/

/* ===== Tab + sentinel constants ===== */
var TAB_PRODUCTS    = 'Products';
var TAB_QUIZZES     = 'Quizzes';
var TAB_ACCESSCODES = 'AccessCodes';
var TAB_SETTINGS    = 'Settings';
var TAB_ATTEMPTS    = 'Attempts';
var TAB_REQUESTS    = 'Requests';   // purchase inbox: email captured at checkout

/* ===========================================================================
 * HTTP entry points
 * ======================================================================== */

/** Handles all GET requests; routes by ?action= */
function doGet(e) {
  return handleRequest(e, 'GET');
}

/** Handles all POST requests; routes by action (query param or JSON body). */
function doPost(e) {
  return handleRequest(e, 'POST');
}

function handleRequest(e, method) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};

    // For POST we read a JSON string body sent as text/plain (CORS-safe).
    var body = {};
    if (method === 'POST' && e && e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents) || {}; }
      catch (parseErr) { body = {}; }
    }

    var action = params.action || body.action || '';

    switch (action) {
      case 'getSettings':  return jsonOut(cachedJson_('pub:getSettings', getSettings_));
      case 'getProducts':  return jsonOut(cachedJson_('pub:getProducts', getProducts_));
      case 'getQuizList':  return jsonOut(cachedJson_('pub:getQuizList', getQuizList_));
      // One round-trip for the whole public catalogue (settings+products+quizzes).
      case 'getBootstrap': return jsonOut(cachedJson_('pub:getBootstrap', getBootstrap_));
      case 'getQuiz':      return jsonOut(getQuiz_(params.quizId, params.code));
      case 'validateCode': return jsonOut(validateCodeEndpoint_(params.code, params.scope));
      case 'gradeQuiz':    return jsonOut(gradeQuiz_(body));

      /* ---- Public: capture buyer email at checkout (no token) ---- */
      case 'requestAccess': return jsonOut(requestAccess_(body));

      /* ---- Student auth (passwordless OTP; no token) ---- */
      case 'studentRequestCode': return jsonOut(studentRequestCode_(body));
      case 'studentVerifyCode':  return jsonOut(studentVerifyCode_(body));

      /* ---- Student endpoints (require a STUDENT token, not admin) ---- */
      case 'studentLogout':
      case 'getStudentProfile':
      case 'updateStudentProfile':
      case 'getMyReferralInfo':
      case 'getMyReferrals':
      case 'requestPayout':
      case 'getMyPurchases':
      case 'getMyLibrary':
      case 'getMyQuiz':
      case 'gradeMyQuiz':
      case 'claimFree':
        return jsonOut(dispatchStudent_(action, body));

      /* ---- Admin auth (adminLogin is the only admin action without a token) ---- */
      case 'adminLogin':   return jsonOut(adminLogin_(body));
      case 'adminLogout':  return jsonOut(adminLogout_(body));

      /* ---- All other admin actions are token-gated via dispatchAdmin_ ---- */
      case 'adminListQuizzes':
      case 'adminCreateQuiz':
      case 'adminUpdateQuiz':
      case 'adminDeleteQuiz':
      case 'adminListQuestions':
      case 'adminAddQuestion':
      case 'adminUpdateQuestion':
      case 'adminDeleteQuestion':
      case 'adminReorderQuestions':
      case 'adminBulkAddQuestions':
      case 'adminListProducts':
      case 'adminCreateProduct':
      case 'adminUpdateProduct':
      case 'adminDeleteProduct':
      case 'adminListCodes':
      case 'adminCreateCode':
      case 'adminUpdateCode':
      case 'adminDeleteCode':
      case 'adminListRequests':
      case 'adminFulfillRequest':
      case 'adminDeleteRequest':
      case 'adminListReferralBalances':
      case 'adminListLedger':
      case 'adminMarkPayout':
      case 'adminVoidLedgerEntry':
      case 'adminGetReferralConfig':
      case 'adminUpdateReferralConfig':
      case 'adminGetSettings':
      case 'adminUpdateSettings':
        return jsonOut(dispatchAdmin_(action, body));

      default:
        return jsonOut({ ok: false, error: 'Unknown or missing action: "' + action + '".' });
    }
  } catch (err) {
    // Always return JSON, never an HTML error page (Section 8 / 16).
    return jsonOut({ ok: false, error: 'Server error: ' + (err && err.message ? err.message : err) });
  }
}

/** Wrap any object as a JSON ContentService response. */
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ===========================================================================
 * Lightweight server-side caching for the public read endpoints.
 * Repeated public reads are served from CacheService instead of re-reading
 * the whole Sheet. Admin writes call clearPublicCache_() so changes show
 * immediately (no stale data after an edit).
 * ======================================================================== */

var PUBLIC_CACHE_TTL = 300; // seconds (5 min). Admin writes clear this immediately.
var PUBLIC_CACHE_KEYS = ['pub:getProducts', 'pub:getQuizList', 'pub:getSettings', 'pub:getBootstrap'];

function cachedJson_(key, producer) {
  var cache;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  if (cache) {
    var hit = cache.get(key);
    if (hit) { try { return JSON.parse(hit); } catch (e2) {} }
  }
  var val = producer();
  if (cache) { try { cache.put(key, JSON.stringify(val), PUBLIC_CACHE_TTL); } catch (e3) {} }
  return val;
}

function clearPublicCache_() {
  try { CacheService.getScriptCache().removeAll(PUBLIC_CACHE_KEYS); } catch (e) {}
}

/* ===========================================================================
 * Sheet reading helpers
 * ======================================================================== */

function getSheetOrThrow_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error('Missing tab "' + name + '". Please create a tab named exactly "' + name + '".');
  }
  return sheet;
}

/**
 * Read a tab as an array of objects keyed by the header row.
 * Header names are trimmed; values are trimmed strings.
 * Throws a clear error naming any required column that is missing.
 */
function readTable_(name, requiredCols) {
  var sheet = getSheetOrThrow_(name);
  var values = sheet.getDataRange().getValues();
  if (values.length < 1) return { rows: [], headers: [] };

  var headers = values[0].map(function (h) { return String(h).trim(); });

  if (requiredCols && requiredCols.length) {
    for (var i = 0; i < requiredCols.length; i++) {
      if (headers.indexOf(requiredCols[i]) === -1) {
        throw new Error('Tab "' + name + '" is missing the required column "' +
          requiredCols[i] + '". Found columns: ' + headers.join(', ') + '.');
      }
    }
  }

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var raw = values[r];
    var isBlank = raw.every(function (c) { return String(c).trim() === ''; });
    if (isBlank) continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = (raw[c] == null) ? '' : String(raw[c]).trim();
    }
    obj.__row = r + 1; // 1-based sheet row, for write-backs
    rows.push(obj);
  }
  return { rows: rows, headers: headers };
}

function truthy_(v) {
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

function toNum_(v, fallback) {
  var n = Number(v);
  return isFinite(n) ? n : (fallback == null ? 0 : fallback);
}

/* ===========================================================================
 * Endpoint: getSettings
 * ======================================================================== */

function getSettings_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_SETTINGS);
  var out = {};
  if (!sheet) return out; // Settings is optional; site uses config.js fallbacks.

  var values = sheet.getDataRange().getValues();
  // Expect key/value rows. If a header row "key | value" exists, skip it.
  for (var r = 0; r < values.length; r++) {
    var key = String(values[r][0] || '').trim();
    var val = values[r].length > 1 ? String(values[r][1] || '').trim() : '';
    if (!key) continue;
    if (r === 0 && key.toLowerCase() === 'key') continue; // skip header row
    out[key] = val;
  }
  return out;
}

/* ===========================================================================
 * Endpoint: getProducts (active only; no secret fields)
 * ======================================================================== */

/**
 * Combined public read: settings + products + quiz list in ONE response,
 * so a page pays the Apps-Script round-trip cost once instead of three times.
 * Cached as a unit; admin writes clear it via clearPublicCache_().
 */
function getBootstrap_() {
  return {
    settings: getSettings_(),
    products: getProducts_(),
    quizList: getQuizList_()
  };
}

function getProducts_() {
  var t = readTable_(TAB_PRODUCTS, [
    'product_id', 'type', 'subject', 'title', 'description',
    'price_php', 'hitpay_link', 'active', 'sort_order'
  ]);

  var out = [];
  for (var i = 0; i < t.rows.length; i++) {
    var row = t.rows[i];
    if (!truthy_(row.active)) continue; // only active products show
    out.push({
      product_id:  row.product_id,
      type:        row.type,
      subject:     row.subject,
      title:       row.title,
      description: row.description,
      price_php:   toNum_(row.price_php, 0),
      hitpay_link: row.hitpay_link,
      sort_order:  toNum_(row.sort_order, 9999)
    });
  }
  out.sort(function (a, b) { return a.sort_order - b.sort_order; });
  return out;
}

/* ===========================================================================
 * Endpoint: getQuizList (distinct quizzes, NO questions)
 * ======================================================================== */

function getQuizList_() {
  var t = readTable_(TAB_QUIZZES, [
    'quiz_id', 'quiz_title', 'subject', 'question_number', 'question_text',
    'option_a', 'option_b', 'option_c', 'option_d', 'correct_option', 'explanation'
  ]);

  var map = {}; // quiz_id -> { quiz_id, quiz_title, subject, timer_minutes, question_count }
  var order = [];
  for (var i = 0; i < t.rows.length; i++) {
    var row = t.rows[i];
    var id = row.quiz_id;
    if (!id) continue;
    if (!map[id]) {
      map[id] = {
        quiz_id: id,
        quiz_title: row.quiz_title || id,
        subject: row.subject || '',
        timer_minutes: toNum_(row.timer_minutes, 0), // optional column; 0 = no timer
        question_count: 0
      };
      order.push(id);
    }
    // Prefer the first non-zero timer value seen for this quiz.
    if (!map[id].timer_minutes) map[id].timer_minutes = toNum_(row.timer_minutes, 0);
    map[id].question_count += 1;
  }
  return order.map(function (id) { return map[id]; });
}

/* ===========================================================================
 * Endpoint: getQuiz (validates code; returns questions WITHOUT answers)
 * ======================================================================== */

function getQuiz_(quizId, code) {
  quizId = String(quizId || '').trim();
  if (!quizId) return { ok: false, error: 'No quiz was specified.' };

  var check = validateCode_(code, quizId, /*forGrading=*/false);
  if (!check.ok) return { ok: false, error: check.error };

  var questions = getQuestionsForQuiz_(quizId);
  if (questions.length === 0) {
    return { ok: false, error: 'This quiz doesn\'t have any questions yet. Please check back soon or contact us.' };
  }

  // Build the safe payload: options only, NEVER correct_option / explanation.
  var meta = questions[0];
  var timer = 0;
  for (var k = 0; k < questions.length; k++) {
    var tm = toNum_(questions[k].timer_minutes, 0);
    if (tm > 0) { timer = tm; break; } // per-quiz timer, read from Quizzes rows
  }
  var safeQuestions = questions.map(function (q) {
    return {
      question_number: toNum_(q.question_number, 0),
      question_text: q.question_text,
      options: buildOptions_(q)
    };
  }).sort(function (a, b) { return a.question_number - b.question_number; });

  return {
    ok: true,
    quiz: {
      quiz_id: quizId,
      quiz_title: meta.quiz_title || quizId,
      subject: meta.subject || '',
      timer_minutes: timer,
      questions: safeQuestions
    }
  };
}

/** Build the options object, omitting blank options (allows fewer than 4). */
function buildOptions_(q) {
  var opts = {};
  if (q.option_a !== '') opts.A = q.option_a;
  if (q.option_b !== '') opts.B = q.option_b;
  if (q.option_c !== '') opts.C = q.option_c;
  if (q.option_d !== '') opts.D = q.option_d;
  return opts;
}

function getQuestionsForQuiz_(quizId) {
  var t = readTable_(TAB_QUIZZES, [
    'quiz_id', 'quiz_title', 'subject', 'question_number', 'question_text',
    'option_a', 'option_b', 'option_c', 'option_d', 'correct_option', 'explanation'
  ]);
  var target = String(quizId).trim().toLowerCase();
  var out = [];
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].quiz_id).trim().toLowerCase() === target) out.push(t.rows[i]);
  }
  return out;
}

/* ===========================================================================
 * Endpoint: validateCode (early, friendly check before loading a quiz)
 * ======================================================================== */

function validateCodeEndpoint_(code, scope) {
  var res = validateCode_(code, scope, /*forGrading=*/false);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.error };
}

/**
 * Core access-code validation. Case-insensitive, whitespace-trimmed.
 * Checks: exists, status active, not expired, scope covers the quiz,
 * and (optionally) under max_uses.
 * Returns { ok:true, row, rowIndex } or { ok:false, error }.
 */
function validateCode_(code, quizId, forGrading) {
  code = String(code || '').trim();
  quizId = String(quizId || '').trim();
  if (!code) return { ok: false, error: 'Please enter your access code.' };

  var t = readTable_(TAB_ACCESSCODES, [
    'code', 'scope', 'expiry_date', 'max_uses', 'uses_count', 'status', 'notes'
  ]);

  var match = null;
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].code).trim().toLowerCase() === code.toLowerCase()) {
      match = t.rows[i];
      break;
    }
  }
  if (!match) {
    return { ok: false, error: 'We couldn\'t find that access code. Please check the code from your email, or contact us.' };
  }

  // Status: only "active" codes work. "pending" (awaiting admin activation
  // after payment) and "disabled" are rejected. Blank is treated as active
  // for backward compatibility with older rows.
  var st = String(match.status).trim().toLowerCase();
  if (st === 'pending') {
    return { ok: false, error: 'This code isn\'t active yet. If you\'ve already paid, please wait for our confirmation email or contact us.' };
  }
  if (st === 'disabled') {
    return { ok: false, error: 'This access code has been disabled. Please contact us if you think this is a mistake.' };
  }

  // Expiry (YYYY-MM-DD) — valid through the end of the expiry day.
  if (match.expiry_date) {
    var expiry = parseDate_(match.expiry_date);
    if (expiry) {
      var endOfDay = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate(), 23, 59, 59);
      if (new Date() > endOfDay) {
        return { ok: false, error: 'This access code has expired. Please contact us if you need a new one.' };
      }
    }
  }

  // Scope: "all" covers everything; otherwise must match quiz id, or be a
  // subject prefix (e.g. scope "structural" covers "structural-1", "structural-2").
  if (quizId) {
    var scope = String(match.scope).trim().toLowerCase();
    var q = quizId.toLowerCase();
    var scopeOk = (scope === 'all') || (scope === q) ||
      (scope.length > 0 && q.indexOf(scope + '-') === 0) ||
      (scope.length > 0 && q === scope);
    if (!scopeOk) {
      return { ok: false, error: 'This code isn\'t valid for this quiz. Please check you\'ve entered the right quiz, or contact us.' };
    }
  }

  // Max uses (blank = unlimited). When grading we will increment.
  if (String(match.max_uses).trim() !== '') {
    var maxUses = toNum_(match.max_uses, 0);
    var used = toNum_(match.uses_count, 0);
    if (maxUses > 0 && used >= maxUses) {
      return { ok: false, error: 'This access code has reached its usage limit. Please contact us if you need more attempts.' };
    }
  }

  return { ok: true, row: match, rowIndex: match.__row };
}

function parseDate_(v) {
  if (v instanceof Date) return v;
  var s = String(v).trim();
  // Accept YYYY-MM-DD (preferred)
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/* ===========================================================================
 * Endpoint: gradeQuiz (POST) — the ONLY place answers/explanations leave
 * ======================================================================== */

function gradeQuiz_(body) {
  var quizId = String(body.quizId || '').trim();
  var code = String(body.code || '').trim();
  var answers = (body.answers && typeof body.answers === 'object') ? body.answers : {};

  if (!quizId) return { ok: false, error: 'No quiz was specified.' };

  // Re-validate server-side; never trust the client.
  var check = validateCode_(code, quizId, /*forGrading=*/true);
  if (!check.ok) return { ok: false, error: check.error };

  var questions = getQuestionsForQuiz_(quizId);
  if (questions.length === 0) {
    return { ok: false, error: 'This quiz has no questions to grade.' };
  }

  var results = [];
  var score = 0;
  questions.sort(function (a, b) { return toNum_(a.question_number, 0) - toNum_(b.question_number, 0); });

  for (var i = 0; i < questions.length; i++) {
    var q = questions[i];
    var qn = toNum_(q.question_number, 0);
    var correct = String(q.correct_option || '').trim().toUpperCase();
    var your = String(answers[String(qn)] || answers[qn] || '').trim().toUpperCase();
    var isCorrect = (your !== '' && your === correct);
    if (isCorrect) score++;
    results.push({
      question_number: qn,
      your_answer: your,            // '' if unanswered (counts as incorrect)
      correct_option: correct,
      is_correct: isCorrect,
      explanation: q.explanation || ''
    });
  }

  // Increment uses_count and log the attempt (best-effort; don't fail grading).
  try { incrementUses_(check.rowIndex); } catch (e1) {}
  try { logAttempt_(code, quizId, score, questions.length); } catch (e2) {}

  return { ok: true, score: score, total: questions.length, results: results };
}

/** Increment uses_count for the AccessCodes row at the given sheet row. */
function incrementUses_(rowIndex) {
  if (!rowIndex) return;
  var sheet = getSheetOrThrow_(TAB_ACCESSCODES);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var col = headers.indexOf('uses_count');
  if (col === -1) return;
  var cell = sheet.getRange(rowIndex, col + 1);
  var current = toNum_(cell.getValue(), 0);
  cell.setValue(current + 1);
}

/** Append a row to the Attempts log (created if missing). */
function logAttempt_(code, quizId, score, total) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_ATTEMPTS);
  if (!sheet) {
    sheet = ss.insertSheet(TAB_ATTEMPTS);
    sheet.appendRow(['timestamp', 'code', 'quiz_id', 'score', 'total']);
  }
  sheet.appendRow([new Date(), code, quizId, score, total]);
}

/* ===========================================================================
 * Optional: run this once from the editor to sanity-check the Sheet wiring.
 * ======================================================================== */

function selfTest_() {
  Logger.log('Settings: ' + JSON.stringify(getSettings_()));
  Logger.log('Products: ' + JSON.stringify(getProducts_()));
  Logger.log('Quiz list: ' + JSON.stringify(getQuizList_()));
}

/**
 * EDITOR-RUN ONCE to authorise email sending (student OTP uses MailApp).
 * Run this from the editor; approve the Gmail permission prompt; check your
 * inbox. After this, student sign-in codes will send. Change the address if you
 * like — it emails the Settings contact_email (or the script owner) by default.
 */
function testEmail_() {
  var to = String(getSettings_().contact_email || Session.getEffectiveUser().getEmail());
  MailApp.sendEmail(to, 'ArchPrep PH — email test',
    'If you received this, email sending is authorised and student OTP codes will work.');
  Logger.log('Test email sent to ' + to);
}

/*****************************************************************************
 * ADMIN PORTAL — added by the admin-portal spec.
 * ---------------------------------------------------------------------------
 * Security model (see .kiro/specs/admin-portal/design.md):
 *  - Single salted SHA-256 admin credential in Script Properties.
 *  - adminLogin issues a >=32-byte random session token (8h expiry).
 *  - EVERY admin action except adminLogin is gated by requireAuth_ via
 *    dispatchAdmin_ — server-side, not by hiding the admin URL.
 *  - Brute-force lockout: 5 failures -> 15-minute lockout per username.
 *  - Admin requests arrive as POST text/plain JSON (no creds in query string).
 *  - Public getQuiz STILL never returns correct_option / explanation.
 *****************************************************************************/

var SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 8 hours
var LOCK_THRESHOLD = 5;                      // failures before lockout
var LOCK_WINDOW_MS = 15 * 60 * 1000;         // 15 minutes

function props_() { return PropertiesService.getScriptProperties(); }

function normUser_(u) { return String(u || '').trim().toLowerCase(); }

/** Hex-encode a byte array, masking negative (signed) bytes. */
function bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xFF;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function sha256Hex_(str) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8);
  return bytesToHex_(raw);
}

/** >=32 bytes of entropy: hash several UUIDs into a uniform 64-hex token. */
function makeToken_() {
  var seed = Utilities.getUuid() + Utilities.getUuid() +
             Utilities.getUuid() + Utilities.getUuid() + String(Date.now());
  return sha256Hex_(seed); // 64 hex chars = 32 bytes
}

function randomSaltHex_() {
  return sha256Hex_(Utilities.getUuid() + Utilities.getUuid() + String(Date.now()))
           .substring(0, 32); // 16-byte salt
}

/**
 * EDITOR-RUN ONLY — never exposed as a web action.
 * Run once: setupAdminCredential('admin', 'your-strong-password')
 * Then delete the password from the editor. Re-run to change the password.
 */
function setupAdminCredential(username, plaintextPassword) {
  var u = normUser_(username);
  if (!u || !plaintextPassword) {
    throw new Error('Usage: setupAdminCredential("username", "password")');
  }
  var salt = randomSaltHex_();
  var hash = sha256Hex_(salt + plaintextPassword);
  props_().setProperty('cred:' + u, JSON.stringify({ salt: salt, hash: hash }));
  return 'Stored admin credential for "' + u + '". Now clear the password from the editor.';
}

/* ---- Lockout helpers ---- */

function getLock_(u) {
  var raw = props_().getProperty('lock:' + u);
  return raw ? JSON.parse(raw) : { count: 0, lastMs: 0 };
}
function setLock_(u, rec) { props_().setProperty('lock:' + u, JSON.stringify(rec)); }
function clearLock_(u) { props_().deleteProperty('lock:' + u); }

/* ---- Login / logout ---- */

function adminLogin_(body) {
  var u = normUser_(body && body.username);
  var password = (body && body.password != null) ? String(body.password) : '';
  var generic = { ok: false, error: 'Invalid username or password.' };

  if (!u || !password) return generic;

  // Lockout check
  var lock = getLock_(u);
  if (lock.count >= LOCK_THRESHOLD) {
    var elapsed = Date.now() - lock.lastMs;
    if (elapsed < LOCK_WINDOW_MS) {
      var mins = Math.ceil((LOCK_WINDOW_MS - elapsed) / 60000);
      return { ok: false, error: 'Too many attempts. Please try again in about ' + mins + ' minute(s).' };
    }
    // Window elapsed -> reset and allow a fresh attempt.
    lock = { count: 0, lastMs: 0 };
  }

  var raw = props_().getProperty('cred:' + u);
  if (!raw) { recordFail_(u, lock); return generic; }

  var cred = JSON.parse(raw);
  var computed = sha256Hex_(cred.salt + password);
  if (!constantTimeEquals_(computed, cred.hash)) { recordFail_(u, lock); return generic; }

  // Success: reset lockout, issue token.
  clearLock_(u);
  var token = makeToken_();
  var expires = Date.now() + SESSION_TTL_MS;
  props_().setProperty('session:' + token, JSON.stringify({ username: u, expires: expires }));
  return { ok: true, token: token, expires: expires };
}

function recordFail_(u, lock) {
  lock.count = (lock.count || 0) + 1;
  lock.lastMs = Date.now();
  setLock_(u, lock);
}

/** Length-checked, full-scan comparison to avoid early-exit timing leaks. */
function constantTimeEquals_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

function adminLogout_(body) {
  var token = body && body.token ? String(body.token) : '';
  if (token) props_().deleteProperty('session:' + token);
  return { ok: true };
}

/* ---- Token validation + admin dispatch gate ---- */

function validateToken_(token) {
  if (!token) return { ok: false };
  var raw = props_().getProperty('session:' + token);
  if (!raw) return { ok: false };
  var rec = JSON.parse(raw);
  if (Date.now() > rec.expires) {
    props_().deleteProperty('session:' + token); // lazy purge
    return { ok: false };
  }
  return { ok: true, username: rec.username };
}

function requireAuth_(body) {
  var token = (body && body.token) ? String(body.token) : '';
  return validateToken_(token);
}

/** Central gate: NO admin handler runs unless requireAuth_ passes. */
function dispatchAdmin_(action, body) {
  var auth = requireAuth_(body);
  if (!auth.ok) return { ok: false, error: 'session_expired' };
  var res = runAdminAction_(action, body);
  // Any successful write invalidates the public read cache so the public
  // site reflects the change immediately.
  if (res && res.ok && isAdminWriteAction_(action)) clearPublicCache_();
  return res;
}

function isAdminWriteAction_(action) {
  return /^(adminCreate|adminUpdate|adminDelete|adminAdd|adminReorder|adminBulk)/.test(action);
}

function runAdminAction_(action, body) {
  switch (action) {
    case 'adminListQuizzes':      return adminListQuizzes_(body);
    case 'adminCreateQuiz':       return adminCreateQuiz_(body);
    case 'adminUpdateQuiz':       return adminUpdateQuiz_(body);
    case 'adminDeleteQuiz':       return adminDeleteQuiz_(body);
    case 'adminListQuestions':    return adminListQuestions_(body);
    case 'adminAddQuestion':      return adminAddQuestion_(body);
    case 'adminUpdateQuestion':   return adminUpdateQuestion_(body);
    case 'adminDeleteQuestion':   return adminDeleteQuestion_(body);
    case 'adminReorderQuestions': return adminReorderQuestions_(body);
    case 'adminBulkAddQuestions': return adminBulkAddQuestions_(body);
    case 'adminListProducts':     return adminListProducts_(body);
    case 'adminCreateProduct':    return adminCreateProduct_(body);
    case 'adminUpdateProduct':    return adminUpdateProduct_(body);
    case 'adminDeleteProduct':    return adminDeleteProduct_(body);
    case 'adminListCodes':        return adminListCodes_(body);
    case 'adminCreateCode':       return adminCreateCode_(body);
    case 'adminUpdateCode':       return adminUpdateCode_(body);
    case 'adminDeleteCode':       return adminDeleteCode_(body);
    case 'adminListRequests':     return adminListRequests_(body);
    case 'adminFulfillRequest':   return adminFulfillRequest_(body);
    case 'adminDeleteRequest':    return adminDeleteRequest_(body);
    case 'adminListReferralBalances': return adminListReferralBalances_(body);
    case 'adminListLedger':       return adminListLedger_(body);
    case 'adminMarkPayout':       return adminMarkPayout_(body);
    case 'adminVoidLedgerEntry':  return adminVoidLedgerEntry_(body);
    case 'adminGetReferralConfig': return adminGetReferralConfig_(body);
    case 'adminUpdateReferralConfig': return adminUpdateReferralConfig_(body);
    case 'adminGetSettings':      return adminGetSettings_(body);
    case 'adminUpdateSettings':   return adminUpdateSettings_(body);
    default: return { ok: false, error: 'Unknown admin action.' };
  }
}

/* ===========================================================================
 * Admin shared helpers — schema-preserving Sheet writes + id generators
 * ======================================================================== */

function headersOf_(sheet) {
  return sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
    .map(function (h) { return String(h).trim(); });
}

/** Ensure the given column names exist on the tab; append any missing ones. */
function ensureColumns_(tabName, names) {
  var sheet = getSheetOrThrow_(tabName);
  var headers = headersOf_(sheet);
  var added = false;
  for (var i = 0; i < names.length; i++) {
    if (headers.indexOf(names[i]) === -1) {
      headers.push(names[i]);
      added = true;
    }
  }
  if (added) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return headers;
}

/** Append an object as a row, ordered by the tab's headers (missing -> ''). */
function appendRowObject_(tabName, obj) {
  var sheet = getSheetOrThrow_(tabName);
  var headers = headersOf_(sheet);
  var row = headers.map(function (h) { return (obj[h] != null) ? obj[h] : ''; });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

/** Update specific fields on a 1-based sheet row, preserving other columns. */
function updateRowFields_(tabName, rowIndex, fields) {
  var sheet = getSheetOrThrow_(tabName);
  var headers = headersOf_(sheet);
  for (var key in fields) {
    if (!fields.hasOwnProperty(key)) continue;
    var col = headers.indexOf(key);
    if (col !== -1) sheet.getRange(rowIndex, col + 1).setValue(fields[key]);
  }
}

/** Find the first data row whose idCol equals idValue (case-insensitive). */
function findRow_(tabName, idCol, idValue) {
  var t = readTable_(tabName, [idCol]);
  var target = String(idValue || '').trim().toLowerCase();
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][idCol]).trim().toLowerCase() === target) {
      return { row: t.rows[i], rowIndex: t.rows[i].__row };
    }
  }
  return null;
}

function deleteSheetRow_(tabName, rowIndex) {
  getSheetOrThrow_(tabName).deleteRow(rowIndex);
}

function slugify_(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40) || 'item';
}

function existingValues_(tabName, col) {
  var set = {};
  try {
    var t = readTable_(tabName, [col]);
    for (var i = 0; i < t.rows.length; i++) {
      set[String(t.rows[i][col]).trim().toLowerCase()] = true;
    }
  } catch (e) {}
  return set;
}

function uniqueId_(tabName, col, base) {
  var set = existingValues_(tabName, col);
  var id = base, n = 2;
  while (set[id.toLowerCase()]) { id = base + '-' + n; n++; }
  return id;
}

/** Readable access code ARCH-XXXX using an unambiguous alphabet. */
function genAccessCode_() {
  var alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var set = existingValues_(TAB_ACCESSCODES, 'code');
  for (var tries = 0; tries < 50; tries++) {
    var s = '';
    for (var i = 0; i < 4; i++) s += alpha.charAt(Math.floor(Math.random() * alpha.length));
    var code = 'ARCH-' + s;
    if (!set[code.toLowerCase()]) return code;
  }
  return 'ARCH-' + String(Date.now()).slice(-5);
}

function letterFromIndex_(idx) { return ['A', 'B', 'C', 'D'][toNum_(idx, 0)] || 'A'; }
function indexFromLetter_(letter) {
  var i = ['A', 'B', 'C', 'D'].indexOf(String(letter || '').trim().toUpperCase());
  return i < 0 ? 0 : i;
}

/* ===========================================================================
 * Admin: Quizzes (quiz definitions live in the Quizzes tab)
 * ======================================================================== */

var QUIZ_COLS = ['quiz_id', 'quiz_title', 'subject', 'question_number', 'question_text',
  'option_a', 'option_b', 'option_c', 'option_d', 'correct_option', 'explanation', 'timer_minutes'];

function adminListQuizzes_() {
  ensureColumns_(TAB_QUIZZES, ['timer_minutes']);
  var t = readTable_(TAB_QUIZZES, [
    'quiz_id', 'quiz_title', 'subject', 'question_number', 'question_text',
    'option_a', 'option_b', 'option_c', 'option_d', 'correct_option', 'explanation'
  ]);
  var map = {}, order = [];
  for (var i = 0; i < t.rows.length; i++) {
    var row = t.rows[i];
    if (!row.quiz_id || String(row.question_text).trim() === '') continue;
    var id = row.quiz_id;
    if (!map[id]) {
      map[id] = { quiz_id: id, quiz_title: row.quiz_title || id, subject: row.subject || '',
        timer_minutes: toNum_(row.timer_minutes, 0), question_count: 0 };
      order.push(id);
    }
    if (!map[id].timer_minutes) map[id].timer_minutes = toNum_(row.timer_minutes, 0);
    map[id].question_count += 1;
  }
  return { ok: true, quizzes: order.map(function (id) { return map[id]; }) };
}

function adminCreateQuiz_(body) {
  var title = String(body.quiz_title || '').trim();
  var subject = String(body.subject || '').trim();
  if (!title) return { ok: false, error: 'A quiz title is required.' };
  if (body.timer_minutes != null && body.timer_minutes !== '' && !isFinite(Number(body.timer_minutes))) {
    return { ok: false, error: 'Timer (minutes) must be a number.' };
  }
  var base = body.quiz_id ? slugify_(body.quiz_id) : slugify_(subject + '-' + title);
  var quizId = uniqueId_(TAB_QUIZZES, 'quiz_id', base);
  // A quiz is persisted once it has its first question (carries quiz-level
  // fields). We return the id; the UI then adds questions under it.
  return { ok: true, quiz_id: quizId };
}

function adminUpdateQuiz_(body) {
  var quizId = String(body.quiz_id || '').trim();
  if (!quizId) return { ok: false, error: 'quiz_id is required.' };
  ensureColumns_(TAB_QUIZZES, ['timer_minutes']);
  var t = readTable_(TAB_QUIZZES, ['quiz_id']);
  var target = quizId.toLowerCase(), updated = 0;
  var fields = {};
  if (body.quiz_title != null) fields.quiz_title = String(body.quiz_title).trim();
  if (body.subject != null) fields.subject = String(body.subject).trim();
  if (body.timer_minutes != null) fields.timer_minutes = toNum_(body.timer_minutes, 0);
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].quiz_id).trim().toLowerCase() === target) {
      updateRowFields_(TAB_QUIZZES, t.rows[i].__row, fields);
      updated++;
    }
  }
  if (updated === 0) return { ok: false, error: 'Quiz not found (add a question first to create it).' };
  return { ok: true, updated: updated };
}

function adminDeleteQuiz_(body) {
  var quizId = String(body.quiz_id || '').trim();
  if (!quizId) return { ok: false, error: 'quiz_id is required.' };
  var t = readTable_(TAB_QUIZZES, ['quiz_id']);
  var target = quizId.toLowerCase();
  var rowsToDelete = [];
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].quiz_id).trim().toLowerCase() === target) rowsToDelete.push(t.rows[i].__row);
  }
  rowsToDelete.sort(function (a, b) { return b - a; }); // delete bottom-up
  for (var j = 0; j < rowsToDelete.length; j++) deleteSheetRow_(TAB_QUIZZES, rowsToDelete[j]);
  return { ok: true, deleted: rowsToDelete.length };
}

/* ===========================================================================
 * Admin: Questions (admin-only — MAY include correct answers)
 * ======================================================================== */

function quizRows_(quizId) {
  var t = readTable_(TAB_QUIZZES, [
    'quiz_id', 'quiz_title', 'subject', 'question_number', 'question_text',
    'option_a', 'option_b', 'option_c', 'option_d', 'correct_option', 'explanation'
  ]);
  var target = String(quizId).trim().toLowerCase();
  var out = [];
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].quiz_id).trim().toLowerCase() === target &&
        String(t.rows[i].question_text).trim() !== '') out.push(t.rows[i]);
  }
  out.sort(function (a, b) { return toNum_(a.question_number, 0) - toNum_(b.question_number, 0); });
  return out;
}

function adminListQuestions_(body) {
  var quizId = String(body.quiz_id || '').trim();
  if (!quizId) return { ok: false, error: 'quiz_id is required.' };
  var rows = quizRows_(quizId);
  var meta = rows[0] || {};
  var questions = rows.map(function (q) {
    var opts = [];
    ['option_a', 'option_b', 'option_c', 'option_d'].forEach(function (k) {
      if (String(q[k]).trim() !== '') opts.push(q[k]);
    });
    return {
      question_number: toNum_(q.question_number, 0),
      question_text: q.question_text,
      options: opts,
      correct_index: indexFromLetter_(q.correct_option),
      correct_option: String(q.correct_option || '').trim().toUpperCase(),
      explanation: q.explanation || ''
    };
  });
  return {
    ok: true,
    quiz_id: quizId,
    quiz_title: meta.quiz_title || quizId,
    subject: meta.subject || '',
    timer_minutes: toNum_(meta.timer_minutes, 0),
    questions: questions
  };
}

function validateQuestionInput_(body) {
  var text = String(body.question_text || '').trim();
  if (!text) return 'Question text is required.';
  var options = (body.options || []).map(function (o) { return String(o == null ? '' : o).trim(); });
  var nonEmpty = options.filter(function (o) { return o !== ''; });
  if (nonEmpty.length < 2) return 'Please provide at least 2 options.';
  if (nonEmpty.length > 4) return 'A maximum of 4 options is allowed.';
  var ci = toNum_(body.correct_index, -1);
  if (ci < 0 || ci >= options.length || String(options[ci]).trim() === '') {
    return 'Please select exactly one correct answer.';
  }
  return null;
}

function questionRowObject_(quizId, body, questionNumber, meta) {
  var options = (body.options || []).map(function (o) { return String(o == null ? '' : o).trim(); });
  return {
    quiz_id: quizId,
    quiz_title: String(body.quiz_title || (meta && meta.quiz_title) || quizId).trim(),
    subject: String(body.subject || (meta && meta.subject) || '').trim(),
    question_number: questionNumber,
    question_text: String(body.question_text).trim(),
    option_a: options[0] || '',
    option_b: options[1] || '',
    option_c: options[2] || '',
    option_d: options[3] || '',
    correct_option: letterFromIndex_(body.correct_index),
    explanation: String(body.explanation || '').trim(),
    timer_minutes: (body.timer_minutes != null && body.timer_minutes !== '')
      ? toNum_(body.timer_minutes, 0)
      : (meta && meta.timer_minutes != null ? toNum_(meta.timer_minutes, 0) : 0)
  };
}

function adminAddQuestion_(body) {
  var quizId = String(body.quiz_id || '').trim();
  if (!quizId) return { ok: false, error: 'quiz_id is required.' };
  var err = validateQuestionInput_(body);
  if (err) return { ok: false, error: err };
  ensureColumns_(TAB_QUIZZES, ['timer_minutes']);

  var rows = quizRows_(quizId);
  var meta = rows[0] || null;
  var nextNum = 1;
  for (var i = 0; i < rows.length; i++) nextNum = Math.max(nextNum, toNum_(rows[i].question_number, 0) + 1);

  appendRowObject_(TAB_QUIZZES, questionRowObject_(quizId, body, nextNum, meta));
  return { ok: true, question_number: nextNum };
}

/** Bulk-append questions (from a CSV import). Adds every valid row; reports
 *  any skipped rows with the reason. Carries quiz-level fields like adminAddQuestion. */
function adminBulkAddQuestions_(body) {
  var quizId = String(body.quiz_id || '').trim();
  if (!quizId) return { ok: false, error: 'quiz_id is required.' };
  var list = body.questions;
  if (!Array.isArray(list) || !list.length) return { ok: false, error: 'No questions found to import.' };
  ensureColumns_(TAB_QUIZZES, ['timer_minutes']);

  var rows = quizRows_(quizId);
  var meta = rows[0] || null;
  var nextNum = 1;
  for (var i = 0; i < rows.length; i++) nextNum = Math.max(nextNum, toNum_(rows[i].question_number, 0) + 1);

  var added = 0, errors = [];
  for (var j = 0; j < list.length; j++) {
    var q = list[j] || {};
    var err = validateQuestionInput_(q);
    if (err) { errors.push({ row: j + 1, error: err }); continue; }
    appendRowObject_(TAB_QUIZZES, questionRowObject_(quizId, {
      quiz_title: body.quiz_title, subject: body.subject, timer_minutes: body.timer_minutes,
      question_text: q.question_text, options: q.options, correct_index: q.correct_index, explanation: q.explanation
    }, nextNum, meta));
    nextNum++; added++;
  }
  return { ok: true, added: added, skipped: errors.length, errors: errors };
}

function adminUpdateQuestion_(body) {
  var quizId = String(body.quiz_id || '').trim();
  var qn = toNum_(body.question_number, 0);
  if (!quizId || !qn) return { ok: false, error: 'quiz_id and question_number are required.' };
  var err = validateQuestionInput_(body);
  if (err) return { ok: false, error: err };
  ensureColumns_(TAB_QUIZZES, ['timer_minutes']);

  var t = readTable_(TAB_QUIZZES, ['quiz_id', 'question_number']);
  var target = quizId.toLowerCase();
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].quiz_id).trim().toLowerCase() === target &&
        toNum_(t.rows[i].question_number, 0) === qn) {
      var options = (body.options || []).map(function (o) { return String(o == null ? '' : o).trim(); });
      updateRowFields_(TAB_QUIZZES, t.rows[i].__row, {
        question_text: String(body.question_text).trim(),
        option_a: options[0] || '', option_b: options[1] || '',
        option_c: options[2] || '', option_d: options[3] || '',
        correct_option: letterFromIndex_(body.correct_index),
        explanation: String(body.explanation || '').trim()
      });
      return { ok: true };
    }
  }
  return { ok: false, error: 'Question not found.' };
}

function adminDeleteQuestion_(body) {
  var quizId = String(body.quiz_id || '').trim();
  var qn = toNum_(body.question_number, 0);
  if (!quizId || !qn) return { ok: false, error: 'quiz_id and question_number are required.' };

  // Delete the matching row, then renumber the remaining rows 1..N.
  var t = readTable_(TAB_QUIZZES, ['quiz_id', 'question_number']);
  var target = quizId.toLowerCase();
  var delRow = null;
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].quiz_id).trim().toLowerCase() === target &&
        toNum_(t.rows[i].question_number, 0) === qn) { delRow = t.rows[i].__row; break; }
  }
  if (!delRow) return { ok: false, error: 'Question not found.' };
  deleteSheetRow_(TAB_QUIZZES, delRow);

  // Renumber remaining questions for this quiz, in order.
  var rows = quizRows_(quizId);
  for (var j = 0; j < rows.length; j++) {
    if (toNum_(rows[j].question_number, 0) !== j + 1) {
      updateRowFields_(TAB_QUIZZES, rows[j].__row, { question_number: j + 1 });
    }
  }
  return { ok: true };
}

function adminReorderQuestions_(body) {
  var quizId = String(body.quiz_id || '').trim();
  var ordered = body.orderedNumbers || [];
  if (!quizId || !ordered.length) return { ok: false, error: 'quiz_id and orderedNumbers are required.' };

  var rows = quizRows_(quizId);
  var byNum = {};
  for (var i = 0; i < rows.length; i++) byNum[toNum_(rows[i].question_number, 0)] = rows[i];
  // Assign temporary high numbers first to avoid collisions, then final order.
  for (var k = 0; k < ordered.length; k++) {
    var r = byNum[toNum_(ordered[k], 0)];
    if (r) updateRowFields_(TAB_QUIZZES, r.__row, { question_number: 1000 + k });
  }
  for (var m = 0; m < ordered.length; m++) {
    var r2 = byNum[toNum_(ordered[m], 0)];
    if (r2) updateRowFields_(TAB_QUIZZES, r2.__row, { question_number: m + 1 });
  }
  return { ok: true };
}

/* ===========================================================================
 * Admin: Products (materials AND quiz-pack products)
 * ======================================================================== */

function adminListProducts_() {
  ensureColumns_(TAB_PRODUCTS, ['unlock_scope', 'drive_note']);
  var t = readTable_(TAB_PRODUCTS, [
    'product_id', 'type', 'subject', 'title', 'description',
    'price_php', 'hitpay_link', 'active', 'sort_order'
  ]);
  var products = t.rows.map(function (row) {
    return {
      product_id: row.product_id, type: row.type, subject: row.subject,
      title: row.title, description: row.description,
      price_php: toNum_(row.price_php, 0), hitpay_link: row.hitpay_link,
      active: truthy_(row.active), sort_order: toNum_(row.sort_order, 9999),
      unlock_scope: row.unlock_scope || '', drive_note: row.drive_note || ''
    };
  });
  return { ok: true, products: products };
}

function validateProductInput_(body) {
  if (!String(body.title || '').trim()) return 'A title is required.';
  var type = String(body.type || '').trim().toLowerCase();
  if (type !== 'material' && type !== 'quiz') return 'Type must be "material" or "quiz".';
  if (body.price_php != null && body.price_php !== '' && !isFinite(Number(body.price_php))) {
    return 'Price (PHP) must be a number.';
  }
  if (body.sort_order != null && body.sort_order !== '' && !isFinite(Number(body.sort_order))) {
    return 'Sort order must be a number.';
  }
  return null;
}

function adminCreateProduct_(body) {
  var err = validateProductInput_(body);
  if (err) return { ok: false, error: err };
  ensureColumns_(TAB_PRODUCTS, ['unlock_scope', 'drive_note']);
  var type = String(body.type).trim().toLowerCase();
  var prefix = (type === 'quiz') ? 'quiz-' : 'mat-';
  var base = prefix + slugify_(body.title);
  var productId = uniqueId_(TAB_PRODUCTS, 'product_id', base);
  appendRowObject_(TAB_PRODUCTS, {
    product_id: productId, type: type, subject: String(body.subject || '').trim(),
    title: String(body.title).trim(), description: String(body.description || '').trim(),
    price_php: toNum_(body.price_php, 0), hitpay_link: String(body.hitpay_link || '').trim(),
    active: truthy_(body.active) ? 'TRUE' : 'FALSE', sort_order: toNum_(body.sort_order, 100),
    unlock_scope: String(body.unlock_scope || '').trim(), drive_note: String(body.drive_note || '').trim()
  });
  return { ok: true, product_id: productId };
}

function adminUpdateProduct_(body) {
  var id = String(body.product_id || '').trim();
  if (!id) return { ok: false, error: 'product_id is required.' };
  if (body.price_php != null && body.price_php !== '' && !isFinite(Number(body.price_php))) {
    return { ok: false, error: 'Price (PHP) must be a number.' };
  }
  ensureColumns_(TAB_PRODUCTS, ['unlock_scope', 'drive_note']);
  var found = findRow_(TAB_PRODUCTS, 'product_id', id);
  if (!found) return { ok: false, error: 'Product not found.' };
  var fields = {};
  ['type', 'subject', 'title', 'description', 'hitpay_link', 'unlock_scope', 'drive_note'].forEach(function (k) {
    if (body[k] != null) fields[k] = String(body[k]).trim();
  });
  if (body.price_php != null) fields.price_php = toNum_(body.price_php, 0);
  if (body.sort_order != null) fields.sort_order = toNum_(body.sort_order, 100);
  if (body.active != null) fields.active = truthy_(body.active) ? 'TRUE' : 'FALSE';
  updateRowFields_(TAB_PRODUCTS, found.rowIndex, fields);
  return { ok: true };
}

function adminDeleteProduct_(body) {
  var id = String(body.product_id || '').trim();
  if (!id) return { ok: false, error: 'product_id is required.' };
  var found = findRow_(TAB_PRODUCTS, 'product_id', id);
  if (!found) return { ok: false, error: 'Product not found.' };
  deleteSheetRow_(TAB_PRODUCTS, found.rowIndex);
  return { ok: true };
}

/* ===========================================================================
 * Admin: Access Codes
 * ======================================================================== */

function adminListCodes_() {
  ensureColumns_(TAB_ACCESSCODES, ['email']);
  var t = readTable_(TAB_ACCESSCODES, [
    'code', 'scope', 'expiry_date', 'max_uses', 'uses_count', 'status', 'notes'
  ]);
  var codes = t.rows.map(function (row) {
    return {
      code: row.code, scope: row.scope, expiry_date: row.expiry_date,
      max_uses: row.max_uses, uses_count: toNum_(row.uses_count, 0),
      status: row.status || 'active', notes: row.notes || '', email: row.email || ''
    };
  });
  return { ok: true, codes: codes };
}

function adminCreateCode_(body) {
  var scope = String(body.scope || '').trim();
  if (!scope) return { ok: false, error: 'A scope is required (a quiz_id, a subject prefix, or "all").' };
  var code = genAccessCode_();
  appendRowObject_(TAB_ACCESSCODES, {
    code: code, scope: scope, expiry_date: String(body.expiry_date || '').trim(),
    max_uses: (body.max_uses == null || body.max_uses === '') ? '' : toNum_(body.max_uses, 0),
    uses_count: 0, status: 'active', notes: String(body.notes || '').trim()
  });
  return { ok: true, code: code };
}

function adminUpdateCode_(body) {
  var code = String(body.code || '').trim();
  if (!code) return { ok: false, error: 'code is required.' };
  var found = findRow_(TAB_ACCESSCODES, 'code', code);
  if (!found) return { ok: false, error: 'Code not found.' };
  var fields = {};
  ['scope', 'expiry_date', 'status', 'notes'].forEach(function (k) {
    if (body[k] != null) fields[k] = String(body[k]).trim();
  });
  if (body.max_uses != null) fields.max_uses = (body.max_uses === '') ? '' : toNum_(body.max_uses, 0);
  updateRowFields_(TAB_ACCESSCODES, found.rowIndex, fields);
  return { ok: true };
}

function adminDeleteCode_(body) {
  var code = String(body.code || '').trim();
  if (!code) return { ok: false, error: 'code is required.' };
  var found = findRow_(TAB_ACCESSCODES, 'code', code);
  if (!found) return { ok: false, error: 'Code not found.' };
  deleteSheetRow_(TAB_ACCESSCODES, found.rowIndex);
  return { ok: true };
}

/* ===========================================================================
 * Admin: Settings
 * ======================================================================== */

function adminGetSettings_() {
  return { ok: true, settings: getSettings_() };
}

function adminUpdateSettings_(body) {
  var key = String(body.key || '').trim();
  if (!key) return { ok: false, error: 'A settings key is required.' };
  var value = (body.value == null) ? '' : String(body.value);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_SETTINGS);
  if (!sheet) { sheet = ss.insertSheet(TAB_SETTINGS); sheet.appendRow(['key', 'value']); }

  var values = sheet.getDataRange().getValues();
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][0]).trim().toLowerCase() === key.toLowerCase()) {
      sheet.getRange(r + 1, 2).setValue(value);
      return { ok: true };
    }
  }
  sheet.appendRow([key, value]); // upsert: add if not present
  return { ok: true };
}

function runOnce() {
  setupAdminCredential('admin', 'ArchPrep!2026');
  PropertiesService.getScriptProperties().deleteProperty('lock:admin');
}

/**
 * Editor-run helper (no trailing underscore so it shows in the Run dropdown).
 * Seeds a FREE demo product + a 3-question quiz so you can test the code-free,
 * login-only library flow without any payment. Idempotent — safe to re-run.
 *
 * After running: a product "quiz-free" (₱0, active) and quiz "free-1" exist.
 * On the site, a logged-in student can claim it from account.html?claim=quiz-free
 * (or via the "Get it free" button on the catalogue) and play it 2x.
 */
function seedFreeDemo() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1) Free product (unlock_scope 'free' -> matches quiz ids starting with 'free-')
  ensureColumns_(TAB_PRODUCTS, ['unlock_scope', 'drive_note']);
  if (!findRow_(TAB_PRODUCTS, 'product_id', 'quiz-free')) {
    appendRowObject_(TAB_PRODUCTS, {
      product_id: 'quiz-free', type: 'quiz', subject: 'Demo',
      title: 'Free Demo Quiz', description: 'A short free quiz to try the login-based library. No code needed.',
      price_php: 0, hitpay_link: '', active: 'TRUE', sort_order: 1,
      unlock_scope: 'free', drive_note: ''
    });
  }

  // 2) Free quiz "free-1" with 3 questions (only if not already present)
  var exists = false;
  var qt = readTable_(TAB_QUIZZES, ['quiz_id']);
  for (var i = 0; i < qt.rows.length; i++) {
    if (String(qt.rows[i].quiz_id).trim().toLowerCase() === 'free-1') { exists = true; break; }
  }
  if (!exists) {
    var meta = { quiz_title: 'Free Demo Quiz', subject: 'Demo', timer_minutes: 0 };
    var demo = [
      { question_text: 'Which material is best known for high compressive strength but low tensile strength?',
        options: ['Steel', 'Concrete', 'Timber', 'Aluminium'], correct_index: 1,
        explanation: 'Concrete resists compression well but is weak in tension, which is why it is reinforced with steel.' },
      { question_text: 'In the Philippines, which code governs the structural design of buildings?',
        options: ['NSCP', 'PEC', 'ASHRAE', 'NBCP'], correct_index: 0,
        explanation: 'The National Structural Code of the Philippines (NSCP) governs structural design.' },
      { question_text: 'What does a load-bearing wall primarily do?',
        options: ['Divide rooms only', 'Carry loads to the foundation', 'Hold windows', 'Improve acoustics'], correct_index: 1,
        explanation: 'A load-bearing wall transfers loads from above down to the foundation.' }
    ];
    for (var n = 0; n < demo.length; n++) {
      appendRowObject_(TAB_QUIZZES, questionRowObject_('free-1', {
        quiz_title: meta.quiz_title, subject: meta.subject, timer_minutes: meta.timer_minutes,
        question_text: demo[n].question_text, options: demo[n].options,
        correct_index: demo[n].correct_index, explanation: demo[n].explanation
      }, n + 1, meta));
    }
  }
  return 'seedFreeDemo complete: product quiz-free + quiz free-1 (3 questions).';
}

/* ===========================================================================
 * Purchase / access-request flow (email captured at checkout)
 * ---------------------------------------------------------------------------
 * NOTE: there is no payment-API in v1, so payment cannot be auto-detected.
 * requestAccess records the buyer's email at checkout and (for quiz packs)
 * creates a PENDING code (2 attempts, no date expiry). The admin confirms
 * payment in HitPay, then activates and sends the code. Materials are logged
 * with the email; the admin sets a date validity and fulfils via Drive.
 * ======================================================================== */

var REQUEST_HEADERS = ['request_id', 'timestamp', 'email', 'product_id', 'type',
  'title', 'scope', 'code', 'valid_until', 'status', 'ref'];

var TAB_ENTITLEMENTS = 'Entitlements';
var ENTITLEMENT_COLS = ['entitlement_id', 'email', 'product_id', 'type', 'title',
  'scope', 'attempts_allowed', 'granted_at', 'order_ref', 'status'];

function isEmail_(s) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());
}

/** PUBLIC: record a checkout email; for quizzes pre-create a pending code. */
function requestAccess_(body) {
  var email = String(body.email || '').trim();
  var productId = String(body.product_id || '').trim();
  if (!isEmail_(email)) return { ok: false, error: 'Please enter a valid email address.' };
  if (!productId) return { ok: false, error: 'Missing product.' };

  var found = findRow_(TAB_PRODUCTS, 'product_id', productId);
  if (!found || !truthy_(found.row.active)) return { ok: false, error: 'That product isn\'t available right now.' };

  var type = String(found.row.type || '').trim().toLowerCase();
  var title = found.row.title || '';
  var scope = String(found.row.unlock_scope || '').trim();
  var code = '';

  if (type === 'quiz') {
    if (!scope) scope = slugify_(found.row.subject || '') || 'all';
    code = genAccessCode_();
    ensureColumns_(TAB_ACCESSCODES, ['email']);
    appendRowObject_(TAB_ACCESSCODES, {
      code: code, scope: scope, expiry_date: '', // quiz codes: NO date expiry
      max_uses: 2, uses_count: 0, status: 'pending', notes: '', email: email
    });
  }
  logRequest_(email, productId, type, title, scope, code, String(body.ref || '').trim());
  return { ok: true, type: type };
}

function logRequest_(email, productId, type, title, scope, code, ref) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_REQUESTS);
  if (!sheet) { sheet = ss.insertSheet(TAB_REQUESTS); sheet.appendRow(REQUEST_HEADERS); }
  ensureColumns_(TAB_REQUESTS, ['ref']);
  var id = 'REQ-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 9000 + 1000);
  appendRowObject_(TAB_REQUESTS, {
    request_id: id, timestamp: new Date(), email: email, product_id: productId, type: type,
    title: title, scope: scope, code: code, valid_until: '', status: 'pending', ref: ref || ''
  });
  return id;
}

/* ---- Admin: purchase inbox ---- */

function adminListRequests_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_REQUESTS)) return { ok: true, requests: [] };
  var t = readTable_(TAB_REQUESTS, ['request_id', 'email', 'type', 'status']);
  var rows = t.rows.map(function (r) {
    return {
      request_id: r.request_id, timestamp: r.timestamp, email: r.email,
      product_id: r.product_id, type: r.type, title: r.title, scope: r.scope,
      code: r.code || '', valid_until: r.valid_until || '', status: r.status || 'pending'
    };
  });
  // newest first
  rows.reverse();
  return { ok: true, requests: rows };
}

/** Activate a quiz request's code (after payment), or set a material's
 *  validity date; marks the request fulfilled either way. */
function adminFulfillRequest_(body) {
  var id = String(body.request_id || '').trim();
  if (!id) return { ok: false, error: 'request_id is required.' };
  var req = findRow_(TAB_REQUESTS, 'request_id', id);
  if (!req) return { ok: false, error: 'Request not found.' };

  var type = String(req.row.type || '').trim().toLowerCase();

  // Grant an account entitlement (code-free access) + run referral attribution.
  // Both are idempotent and safe to run once per confirm.
  grantEntitlement_(req.row);
  var reward = referralAttribute_(req.row);

  if (type === 'quiz') {
    var code = String(req.row.code || '').trim();
    if (code) {
      var cr = findRow_(TAB_ACCESSCODES, 'code', code);
      if (cr) updateRowFields_(TAB_ACCESSCODES, cr.rowIndex, { status: 'active' });
    }
    updateRowFields_(TAB_REQUESTS, req.rowIndex, { status: 'fulfilled' });
    return { ok: true, code: code, reward: reward };
  }
  // material: store the admin-chosen validity date and mark fulfilled
  var validUntil = String(body.valid_until || '').trim();
  updateRowFields_(TAB_REQUESTS, req.rowIndex, { valid_until: validUntil, status: 'fulfilled' });
  return { ok: true, reward: reward };
}

/* Grant the buyer's account access to what they bought (idempotent per order). */
function grantEntitlement_(reqRow) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_ENTITLEMENTS)) ss.insertSheet(TAB_ENTITLEMENTS).appendRow(ENTITLEMENT_COLS);
  var email = String(reqRow.email || '').trim().toLowerCase();
  var orderRef = String(reqRow.request_id || '').trim();
  if (!email || !orderRef) return;
  // idempotent: skip if an entitlement already exists for this order
  var t = readTable_(TAB_ENTITLEMENTS, ['order_ref']);
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].order_ref).trim() === orderRef) return;
  }
  var type = String(reqRow.type || '').trim().toLowerCase();
  appendRowObject_(TAB_ENTITLEMENTS, {
    entitlement_id: 'ENT-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 900 + 100),
    email: email, product_id: reqRow.product_id, type: type, title: reqRow.title,
    scope: reqRow.scope, attempts_allowed: (type === 'quiz' ? 2 : ''), granted_at: new Date().toISOString(),
    order_ref: orderRef, status: 'active'
  });
}

/* Referral attribution — runs at confirm. Server-authoritative, idempotent. */
function referralAttribute_(reqRow) {
  var ref = String(reqRow.ref || '').trim();
  if (!ref) return null;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_LEDGER)) ss.insertSheet(TAB_LEDGER).appendRow(LEDGER_COLS);

  var buyerEmail = String(reqRow.email || '').trim().toLowerCase();
  var orderRef = String(reqRow.request_id || '').trim();
  var cfg = refConfig_();

  var referrer = findStudentByRef_(ref);
  if (!referrer || String(referrer.row.status).toLowerCase() === 'disabled') return null;
  var referrerEmail = String(referrer.row.email).trim().toLowerCase();
  if (referrerEmail === buyerEmail) return null; // self-referral guard

  // duplicate guard: one non-void entry per order
  var led = readTable_(TAB_LEDGER, ['order_ref', 'status']);
  for (var i = 0; i < led.rows.length; i++) {
    if (String(led.rows[i].order_ref).trim() === orderRef &&
        String(led.rows[i].status).toLowerCase() !== 'void') return null;
  }
  // reward scope: first_purchase_only => only the buyer's first-ever confirmed order
  if (cfg.reward_on === 'first_purchase_only') {
    var reqs = readTable_(TAB_REQUESTS, ['email', 'status']);
    var priorConfirmed = 0;
    for (var j = 0; j < reqs.rows.length; j++) {
      if (String(reqs.rows[j].email).trim().toLowerCase() === buyerEmail &&
          String(reqs.rows[j].status).toLowerCase() === 'fulfilled' &&
          String(reqs.rows[j].request_id).trim() !== orderRef) priorConfirmed++;
    }
    if (priorConfirmed > 0) return null;
  }

  appendRowObject_(TAB_LEDGER, {
    entry_id: 'LED-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 900 + 100),
    referrer_ref_code: referrer.row.ref_code, referrer_email: referrerEmail, buyer_email: buyerEmail,
    product_id: reqRow.product_id, order_ref: orderRef, amount: cfg.referral_amount, status: 'available',
    reward_type: cfg.reward_type, created_at: new Date().toISOString(), confirmed_at: new Date().toISOString(),
    paid_at: '', notes: ''
  });
  return { referrer_ref_code: referrer.row.ref_code, amount: cfg.referral_amount };
}

function adminDeleteRequest_(body) {
  var id = String(body.request_id || '').trim();
  if (!id) return { ok: false, error: 'request_id is required.' };
  var req = findRow_(TAB_REQUESTS, 'request_id', id);
  if (!req) return { ok: false, error: 'Request not found.' };
  // also remove a still-pending quiz code that was never activated
  var code = String(req.row.code || '').trim();
  if (code) {
    var cr = findRow_(TAB_ACCESSCODES, 'code', code);
    if (cr && String(cr.row.status).toLowerCase() === 'pending') deleteSheetRow_(TAB_ACCESSCODES, cr.rowIndex);
  }
  deleteSheetRow_(TAB_REQUESTS, req.rowIndex);
  return { ok: true };
}

/*****************************************************************************
 * STUDENT ACCOUNTS + REFERRALS (passwordless email-OTP). Additive feature.
 * ---------------------------------------------------------------------------
 * Student auth is SEPARATE from and lower-privilege than admin auth:
 *   - Student sessions:  ssession:<token> -> { email, expires }  (30-day TTL)
 *   - OTP:               otp:<emailLower> -> { salt, codeHash, expires, attempts }
 *   - OTP rate limit:    otplock:<emailLower> -> { count, lastMs }
 * A student token is accepted ONLY by student endpoints (dispatchStudent_);
 * it can never reach an admin endpoint (dispatchAdmin_ checks admin tokens).
 * No passwords are ever created or stored for anyone.
 *****************************************************************************/

var TAB_STUDENTS = 'Students';
var TAB_LEDGER   = 'ReferralLedger';

var STUDENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
var OTP_TTL_MS       = 10 * 60 * 1000;   // 10 minutes
var OTP_MAX_ATTEMPTS = 5;                // verify attempts before code invalidated
var OTP_REQ_MAX      = 5;                // code requests per window
var OTP_REQ_WINDOW_MS = 15 * 60 * 1000;  // 15 minutes

var STUDENT_COLS = ['student_id', 'email', 'display_name', 'ref_code', 'referred_by',
  'gcash_number', 'created_at', 'status'];
var LEDGER_COLS = ['entry_id', 'referrer_ref_code', 'referrer_email', 'buyer_email',
  'product_id', 'order_ref', 'amount', 'status', 'reward_type',
  'created_at', 'confirmed_at', 'paid_at', 'notes'];

/* ---- Referral config (Settings-backed, server-authoritative) ---- */
function refConfig_() {
  var s = getSettings_(); // key/value from Settings tab
  var num = function (v, d) { var n = Number(v); return isFinite(n) ? n : d; };
  var truth = function (v, d) { if (v == null || String(v).trim() === '') return d; return truthy_(v); };
  var rt = String(s.reward_type || 'cash').trim().toLowerCase();
  var ro = String(s.reward_on || 'every_purchase').trim().toLowerCase();
  return {
    referral_amount: num(s.referral_amount, 9),
    reward_type: (rt === 'credit') ? 'credit' : 'cash',
    payout_threshold: num(s.payout_threshold, 100),
    reward_on: (ro === 'first_purchase_only') ? 'first_purchase_only' : 'every_purchase',
    require_account_to_buy: truth(s.require_account_to_buy, false)
  };
}

/* ---- Small helpers ---- */
function makeOtp_() {
  var n = Math.floor(Math.random() * 1000000);
  return ('000000' + n).slice(-6);
}
function genRefCode_() {
  var alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var set = existingValues_(TAB_STUDENTS, 'ref_code');
  for (var tries = 0; tries < 60; tries++) {
    var s = '';
    for (var i = 0; i < 4; i++) s += alpha.charAt(Math.floor(Math.random() * alpha.length));
    var code = 'REF-' + s;
    if (!set[code.toLowerCase()]) return code;
  }
  return 'REF-' + String(Date.now()).slice(-5);
}
function ensureStudentTabs_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_STUDENTS)) ss.insertSheet(TAB_STUDENTS).appendRow(STUDENT_COLS);
  if (!ss.getSheetByName(TAB_LEDGER)) ss.insertSheet(TAB_LEDGER).appendRow(LEDGER_COLS);
}
function findStudentByEmail_(email) {
  var e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_STUDENTS)) return null;
  var t = readTable_(TAB_STUDENTS, ['email']);
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].email).trim().toLowerCase() === e) return { row: t.rows[i], rowIndex: t.rows[i].__row };
  }
  return null;
}
function findStudentByRef_(refCode) {
  var c = String(refCode || '').trim().toLowerCase();
  if (!c) return null;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_STUDENTS)) return null;
  var t = readTable_(TAB_STUDENTS, ['ref_code']);
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].ref_code).trim().toLowerCase() === c) return { row: t.rows[i], rowIndex: t.rows[i].__row };
  }
  return null;
}
function referralLinkFor_(refCode) {
  var s = getSettings_();
  var base = String(s.site_url || '').trim();
  return (base ? base.replace(/\/+$/, '') : '') + '/?ref=' + encodeURIComponent(refCode);
}

/* ---- OTP request ---- */
function studentRequestCode_(body) {
  var email = String(body.email || '').trim().toLowerCase();
  var generic = { ok: true }; // never reveal whether the email exists
  if (!isEmail_(email)) return { ok: false, error: 'Please enter a valid email address.' };

  // rate limit code requests per email
  var lk = props_().getProperty('otplock:' + email);
  var lock = lk ? JSON.parse(lk) : { count: 0, lastMs: 0 };
  if (Date.now() - lock.lastMs > OTP_REQ_WINDOW_MS) lock = { count: 0, lastMs: 0 };
  if (lock.count >= OTP_REQ_MAX) return generic; // silently drop; don't reveal
  lock.count += 1; lock.lastMs = Date.now();
  props_().setProperty('otplock:' + email, JSON.stringify(lock));

  var code = makeOtp_();
  var salt = randomSaltHex_();
  props_().setProperty('otp:' + email, JSON.stringify({
    salt: salt, codeHash: sha256Hex_(salt + code), expires: Date.now() + OTP_TTL_MS, attempts: 0
  }));

  try {
    var brand = String(getSettings_().brand_name || 'ArchPrep PH');
    MailApp.sendEmail(email, brand + ' — your sign-in code',
      'Your ' + brand + ' sign-in code is: ' + code + '\n\n' +
      'It expires in 10 minutes. If you didn\'t request this, you can safely ignore this email.');
  } catch (e) { /* quota or send failure: still return generic */ }
  return generic;
}

/* ---- OTP verify (creates the account on first successful verify) ---- */
function studentVerifyCode_(body) {
  var email = String(body.email || '').trim().toLowerCase();
  var code = String(body.code || '').trim();
  var ref = String(body.ref || '').trim();
  if (!isEmail_(email) || !code) return { ok: false, error: 'Invalid email or code.' };

  var raw = props_().getProperty('otp:' + email);
  if (!raw) return { ok: false, error: 'That code has expired or was already used. Please request a new one.' };
  var rec = JSON.parse(raw);
  if (Date.now() > rec.expires) { props_().deleteProperty('otp:' + email); return { ok: false, error: 'That code has expired. Please request a new one.' }; }
  if (rec.attempts >= OTP_MAX_ATTEMPTS) { props_().deleteProperty('otp:' + email); return { ok: false, error: 'Too many attempts. Please request a new code.' }; }

  if (sha256Hex_(rec.salt + code) !== rec.codeHash) {
    rec.attempts += 1;
    props_().setProperty('otp:' + email, JSON.stringify(rec));
    return { ok: false, error: 'Incorrect code. Please try again.' };
  }
  props_().deleteProperty('otp:' + email); // one-time use

  ensureStudentTabs_();
  var existing = findStudentByEmail_(email);
  var profile;
  if (existing) {
    profile = studentProfile_(existing.row);
  } else {
    var refCode = genRefCode_();
    var referredBy = '';
    // self-referral guard + validity at signup only
    if (ref) {
      var r = findStudentByRef_(ref);
      if (r && String(r.row.status).toLowerCase() !== 'disabled'
          && String(r.row.email).trim().toLowerCase() !== email) {
        referredBy = r.row.ref_code;
      }
    }
    appendRowObject_(TAB_STUDENTS, {
      student_id: 'STU-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 900 + 100),
      email: email, display_name: '', ref_code: refCode, referred_by: referredBy,
      gcash_number: '', created_at: new Date().toISOString(), status: 'active'
    });
    profile = studentProfile_(findStudentByEmail_(email).row);
  }

  var token = makeToken_();
  var expires = Date.now() + STUDENT_SESSION_TTL_MS;
  props_().setProperty('ssession:' + token, JSON.stringify({ email: email, expires: expires }));
  return { ok: true, token: token, expires: expires, profile: profile };
}

function studentProfile_(row) {
  return {
    email: row.email, display_name: row.display_name || '', ref_code: row.ref_code,
    referral_link: referralLinkFor_(row.ref_code), gcash_number: row.gcash_number || ''
  };
}

/* ---- Student session validation + dispatch gate ---- */
function validateStudentToken_(token) {
  if (!token) return { ok: false };
  var raw = props_().getProperty('ssession:' + token);
  if (!raw) return { ok: false };
  var rec = JSON.parse(raw);
  if (Date.now() > rec.expires) { props_().deleteProperty('ssession:' + token); return { ok: false }; }
  return { ok: true, email: rec.email };
}

function dispatchStudent_(action, body) {
  var auth = validateStudentToken_(body && body.token ? String(body.token) : '');
  if (!auth.ok) return { ok: false, error: 'session_expired' };
  var email = auth.email;
  switch (action) {
    case 'studentLogout':        return studentLogout_(body);
    case 'getStudentProfile':    return getStudentProfile_(email);
    case 'updateStudentProfile': return updateStudentProfile_(email, body);
    case 'getMyReferralInfo':    return getMyReferralInfo_(email);
    case 'getMyReferrals':       return getMyReferrals_(email);
    case 'requestPayout':        return requestPayout_(email, body);
    case 'getMyLibrary':         return getMyLibrary_(email);
    case 'getMyPurchases':       return getMyLibrary_(email);
    case 'getMyQuiz':            return getMyQuiz_(email, body);
    case 'gradeMyQuiz':          return gradeMyQuiz_(email, body);
    case 'claimFree':            return claimFree_(email, body);
    default: return { ok: false, error: 'Unknown student action.' };
  }
}

function studentLogout_(body) {
  var token = body && body.token ? String(body.token) : '';
  if (token) props_().deleteProperty('ssession:' + token);
  return { ok: true };
}

function getStudentProfile_(email) {
  var s = findStudentByEmail_(email);
  if (!s) return { ok: false, error: 'session_expired' };
  return { ok: true, profile: studentProfile_(s.row) };
}

function updateStudentProfile_(email, body) {
  var s = findStudentByEmail_(email);
  if (!s) return { ok: false, error: 'session_expired' };
  var fields = {};
  if (body.display_name != null) fields.display_name = String(body.display_name).trim().substring(0, 60);
  if (body.gcash_number != null) fields.gcash_number = String(body.gcash_number).trim().substring(0, 30);
  updateRowFields_(TAB_STUDENTS, s.rowIndex, fields);
  return { ok: true, profile: studentProfile_(findStudentByEmail_(email).row) };
}

/* ===========================================================================
 * Student: account library (code-free access) + quiz play + referral dashboard
 * ======================================================================== */

function scopeCovers_(scope, quizId) {
  scope = String(scope || '').trim().toLowerCase();
  var q = String(quizId || '').trim().toLowerCase();
  if (!scope || !q) return false;
  return scope === 'all' || scope === q || q.indexOf(scope + '-') === 0;
}

function entitlementsFor_(email) {
  var e = String(email || '').trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_ENTITLEMENTS)) return [];
  var t = readTable_(TAB_ENTITLEMENTS, ['email', 'scope', 'status']);
  var out = [];
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].email).trim().toLowerCase() === e &&
        String(t.rows[i].status).toLowerCase() !== 'disabled') out.push(t.rows[i]);
  }
  return out;
}

/** Count a student's graded submissions for a quiz (from the Attempts log). */
function myQuizAttempts_(email, quizId) {
  var e = String(email || '').trim().toLowerCase();
  var q = String(quizId || '').trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_ATTEMPTS);
  if (!sheet) return 0;
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var ei = headers.indexOf('email'), qi = headers.indexOf('quiz_id');
  if (ei === -1 || qi === -1) return 0;
  var n = 0;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][ei]).trim().toLowerCase() === e &&
        String(values[r][qi]).trim().toLowerCase() === q) n++;
  }
  return n;
}

function logMyAttempt_(email, quizId, score, total) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_ATTEMPTS);
  if (!sheet) { sheet = ss.insertSheet(TAB_ATTEMPTS); sheet.appendRow(['timestamp', 'code', 'quiz_id', 'score', 'total', 'email']); }
  ensureColumns_(TAB_ATTEMPTS, ['email']);
  appendRowObject_(TAB_ATTEMPTS, { timestamp: new Date(), code: '', quiz_id: quizId, score: score, total: total, email: email });
}

var MY_ATTEMPTS_MAX = 2;

function isEntitledToQuiz_(email, quizId) {
  var ents = entitlementsFor_(email);
  for (var i = 0; i < ents.length; i++) {
    if (String(ents[i].type).toLowerCase() !== 'material' && scopeCovers_(ents[i].scope, quizId)) return true;
  }
  return false;
}

function getMyLibrary_(email) {
  var ents = entitlementsFor_(email);
  var quizzesOut = [], materials = [], seen = {};
  var allQuizzes = getQuizList_(); // [{quiz_id, quiz_title, subject, timer_minutes, question_count}]
  for (var i = 0; i < ents.length; i++) {
    var ent = ents[i];
    if (String(ent.type).toLowerCase() === 'material') {
      materials.push({ product_id: ent.product_id, title: ent.title });
      continue;
    }
    for (var j = 0; j < allQuizzes.length; j++) {
      var qz = allQuizzes[j];
      if (seen[qz.quiz_id]) continue;
      if (scopeCovers_(ent.scope, qz.quiz_id)) {
        seen[qz.quiz_id] = true;
        var used = myQuizAttempts_(email, qz.quiz_id);
        quizzesOut.push({
          quiz_id: qz.quiz_id, quiz_title: qz.quiz_title, subject: qz.subject,
          timer_minutes: qz.timer_minutes, attempts_used: used,
          attempts_left: Math.max(0, MY_ATTEMPTS_MAX - used)
        });
      }
    }
  }
  return { ok: true, library: { quizzes: quizzesOut, materials: materials } };
}

/**
 * Claim a FREE product (price_php === 0) into the logged-in student's library.
 * Idempotent per (product, email) via a synthetic order_ref: 'free:<pid>:<email>'.
 * Used by the "Get it free" flow so students can try code-free access with no payment.
 */
function claimFree_(email, body) {
  var e = String(email || '').trim().toLowerCase();
  var pid = String(body && (body.productId || body.product_id) || '').trim();
  if (!e) return { ok: false, error: 'session_expired' };
  if (!pid) return { ok: false, error: 'No product specified.' };

  var found = findRow_(TAB_PRODUCTS, 'product_id', pid);
  if (!found || !truthy_(found.row.active)) return { ok: false, error: 'That product isn\'t available right now.' };
  if (toNum_(found.row.price_php, -1) !== 0) return { ok: false, error: 'This product is not free.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_ENTITLEMENTS)) ss.insertSheet(TAB_ENTITLEMENTS).appendRow(ENTITLEMENT_COLS);

  var orderRef = 'free:' + pid + ':' + e;
  // idempotent: if already claimed, just succeed
  var t = readTable_(TAB_ENTITLEMENTS, ['order_ref']);
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].order_ref).trim() === orderRef) return { ok: true, already: true };
  }

  var type = String(found.row.type || '').trim().toLowerCase();
  var scope = String(found.row.unlock_scope || '').trim();
  appendRowObject_(TAB_ENTITLEMENTS, {
    entitlement_id: 'ENT-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 900 + 100),
    email: e, product_id: pid, type: type, title: found.row.title || pid,
    scope: scope, attempts_allowed: (type === 'quiz' ? 2 : ''), granted_at: new Date().toISOString(),
    order_ref: orderRef, status: 'active'
  });
  return { ok: true };
}

function getMyQuiz_(email, body) {
  var quizId = String(body.quizId || body.quiz_id || '').trim();
  if (!quizId) return { ok: false, error: 'No quiz specified.' };
  if (!isEntitledToQuiz_(email, quizId)) return { ok: false, error: 'You don\'t have access to this quiz. It may not be in your purchases.' };
  if (myQuizAttempts_(email, quizId) >= MY_ATTEMPTS_MAX) return { ok: false, error: 'You\'ve used all ' + MY_ATTEMPTS_MAX + ' attempts for this quiz.' };

  var questions = getQuestionsForQuiz_(quizId);
  if (!questions.length) return { ok: false, error: 'This quiz has no questions yet.' };
  var meta = questions[0], timer = 0;
  for (var k = 0; k < questions.length; k++) { var tm = toNum_(questions[k].timer_minutes, 0); if (tm > 0) { timer = tm; break; } }
  var safe = questions.map(function (q) {
    return { question_number: toNum_(q.question_number, 0), question_text: q.question_text, options: buildOptions_(q) };
  }).sort(function (a, b) { return a.question_number - b.question_number; });
  return { ok: true, quiz: { quiz_id: quizId, quiz_title: meta.quiz_title || quizId, subject: meta.subject || '', timer_minutes: timer, attempts_left: MY_ATTEMPTS_MAX - myQuizAttempts_(email, quizId), questions: safe } };
}

function gradeMyQuiz_(email, body) {
  var quizId = String(body.quizId || body.quiz_id || '').trim();
  var answers = (body.answers && typeof body.answers === 'object') ? body.answers : {};
  if (!quizId) return { ok: false, error: 'No quiz specified.' };
  if (!isEntitledToQuiz_(email, quizId)) return { ok: false, error: 'You don\'t have access to this quiz.' };
  if (myQuizAttempts_(email, quizId) >= MY_ATTEMPTS_MAX) return { ok: false, error: 'You\'ve used all ' + MY_ATTEMPTS_MAX + ' attempts for this quiz.' };

  var questions = getQuestionsForQuiz_(quizId);
  if (!questions.length) return { ok: false, error: 'This quiz has no questions to grade.' };
  questions.sort(function (a, b) { return toNum_(a.question_number, 0) - toNum_(b.question_number, 0); });
  var results = [], score = 0;
  for (var i = 0; i < questions.length; i++) {
    var q = questions[i], qn = toNum_(q.question_number, 0);
    var correct = String(q.correct_option || '').trim().toUpperCase();
    var your = String(answers[String(qn)] || answers[qn] || '').trim().toUpperCase();
    var ok = (your !== '' && your === correct); if (ok) score++;
    results.push({ question_number: qn, your_answer: your, correct_option: correct, is_correct: ok, explanation: q.explanation || '' });
  }
  try { logMyAttempt_(email, quizId, score, questions.length); } catch (e) {}
  var left = Math.max(0, MY_ATTEMPTS_MAX - myQuizAttempts_(email, quizId));
  return { ok: true, score: score, total: questions.length, attempts_left: left, results: results };
}

/* ---- Referral dashboard data ---- */
function maskEmail_(e) {
  e = String(e || '');
  var at = e.indexOf('@'); if (at < 1) return '***';
  return e.charAt(0) + '***' + e.substring(at);
}

function ledgerForReferrer_(email) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_LEDGER)) return [];
  var t = readTable_(TAB_LEDGER, ['referrer_email', 'status']);
  var e = String(email).trim().toLowerCase(), out = [];
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].referrer_email).trim().toLowerCase() === e) out.push(t.rows[i]);
  }
  return out;
}

function getMyReferralInfo_(email) {
  var s = findStudentByEmail_(email);
  if (!s) return { ok: false, error: 'session_expired' };
  var refCode = s.row.ref_code;
  var entries = ledgerForReferrer_(email);
  var pending = 0, available = 0, paid = 0, purchases = 0;
  for (var i = 0; i < entries.length; i++) {
    var st = String(entries[i].status).toLowerCase(), amt = toNum_(entries[i].amount, 0);
    if (st === 'void') continue;
    purchases++;
    if (st === 'pending') pending += amt;
    else if (st === 'paid') paid += amt;
    else available += amt; // 'available' (default)
  }
  // count distinct students referred by this code
  var referred = 0;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(TAB_STUDENTS)) {
    var st2 = readTable_(TAB_STUDENTS, ['referred_by']);
    for (var j = 0; j < st2.rows.length; j++) if (String(st2.rows[j].referred_by).trim().toLowerCase() === String(refCode).toLowerCase()) referred++;
  }
  var cfg = refConfig_();
  return {
    ok: true, ref_code: refCode, referral_link: referralLinkFor_(refCode),
    counts: { referred: referred, purchases: purchases },
    earnings: { pending: pending, available: available, paid: paid, currency: 'PHP' },
    config: { amount: cfg.referral_amount, reward_type: cfg.reward_type, payout_threshold: cfg.payout_threshold }
  };
}

function getMyReferrals_(email) {
  var entries = ledgerForReferrer_(email);
  var list = entries.map(function (r) {
    return { buyer: maskEmail_(r.buyer_email), product_id: r.product_id, amount: toNum_(r.amount, 0),
      status: r.status, date: r.confirmed_at || r.created_at };
  }).reverse();
  return { ok: true, referrals: list };
}

function requestPayout_(email, body) {
  var cfg = refConfig_();
  if (cfg.reward_type !== 'cash') return { ok: false, error: 'credit_mode' };
  var entries = ledgerForReferrer_(email);
  var available = 0;
  for (var i = 0; i < entries.length; i++) if (String(entries[i].status).toLowerCase() === 'available') available += toNum_(entries[i].amount, 0);
  if (available < cfg.payout_threshold) return { ok: false, error: 'below_threshold', available: available, threshold: cfg.payout_threshold };
  var gc = String(body.gcash_number || '').trim();
  var s = findStudentByEmail_(email);
  if (s && gc) updateRowFields_(TAB_STUDENTS, s.rowIndex, { gcash_number: gc });
  props_().setProperty('payoutreq:' + String(email).toLowerCase(), JSON.stringify({ amount: available, gcash: gc, ts: Date.now() }));
  return { ok: true, requested: available };
}

/* ===========================================================================
 * Admin: referral management (balances, ledger, payouts, void, config)
 * ======================================================================== */

function allLedger_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_LEDGER)) return { rows: [] };
  return readTable_(TAB_LEDGER, LEDGER_COLS.slice(0, 8));
}

function adminListReferralBalances_() {
  var led = allLedger_();
  var byRef = {}; // referrer_email -> aggregate
  for (var i = 0; i < led.rows.length; i++) {
    var r = led.rows[i];
    var em = String(r.referrer_email).trim().toLowerCase();
    if (!em) continue;
    if (!byRef[em]) byRef[em] = { email: em, ref_code: r.referrer_ref_code, available: 0, paid: 0, pending: 0 };
    var st = String(r.status).toLowerCase(), amt = toNum_(r.amount, 0);
    if (st === 'void') continue;
    if (st === 'paid') byRef[em].paid += amt;
    else if (st === 'pending') byRef[em].pending += amt;
    else byRef[em].available += amt;
  }
  // enrich with student info + payout request flag + referred count
  var students = {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(TAB_STUDENTS)) {
    var st2 = readTable_(TAB_STUDENTS, ['email', 'ref_code']);
    for (var j = 0; j < st2.rows.length; j++) students[String(st2.rows[j].email).trim().toLowerCase()] = st2.rows[j];
  }
  var out = [];
  for (var key in byRef) {
    if (!byRef.hasOwnProperty(key)) continue;
    var b = byRef[key];
    var stu = students[key] || {};
    var referred = 0;
    if (ss.getSheetByName(TAB_STUDENTS)) {
      var st3 = readTable_(TAB_STUDENTS, ['referred_by']);
      for (var k = 0; k < st3.rows.length; k++) if (String(st3.rows[k].referred_by).trim().toLowerCase() === String(b.ref_code).toLowerCase()) referred++;
    }
    var hasReq = props_().getProperty('payoutreq:' + key) ? true : false;
    out.push({ email: b.email, ref_code: b.ref_code, referred_count: referred,
      available: b.available, paid: b.paid, pending: b.pending,
      gcash_number: stu.gcash_number || '', has_payout_request: hasReq });
  }
  out.sort(function (a, b) { return b.available - a.available; });
  return { ok: true, balances: out };
}

function adminListLedger_(body) {
  var led = readTableSafe_(TAB_LEDGER, LEDGER_COLS);
  var filterStatus = String((body && body.status) || '').toLowerCase();
  var filterEmail = String((body && body.email) || '').trim().toLowerCase();
  var rows = led.filter(function (r) {
    if (filterStatus && String(r.status).toLowerCase() !== filterStatus) return false;
    if (filterEmail && String(r.referrer_email).toLowerCase() !== filterEmail && String(r.buyer_email).toLowerCase() !== filterEmail) return false;
    return true;
  }).map(function (r) {
    return { entry_id: r.entry_id, referrer_ref_code: r.referrer_ref_code, referrer_email: r.referrer_email,
      buyer_email: r.buyer_email, product_id: r.product_id, order_ref: r.order_ref, amount: toNum_(r.amount, 0),
      status: r.status, reward_type: r.reward_type, created_at: r.created_at, confirmed_at: r.confirmed_at,
      paid_at: r.paid_at, notes: r.notes };
  }).reverse();
  return { ok: true, ledger: rows };
}

function readTableSafe_(name, cols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(name)) return [];
  return readTable_(name, cols.slice(0, 1)).rows;
}

function adminMarkPayout_(body) {
  var email = String(body.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'email is required.' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(TAB_LEDGER)) return { ok: false, error: 'No ledger yet.' };
  var t = readTable_(TAB_LEDGER, ['referrer_email', 'status']);
  var n = 0, now = new Date().toISOString();
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].referrer_email).trim().toLowerCase() === email &&
        String(t.rows[i].status).toLowerCase() === 'available') {
      updateRowFields_(TAB_LEDGER, t.rows[i].__row, { status: 'paid', paid_at: now });
      n++;
    }
  }
  props_().deleteProperty('payoutreq:' + email);
  return { ok: true, marked_paid: n };
}

function adminVoidLedgerEntry_(body) {
  var id = String(body.entry_id || '').trim();
  if (!id) return { ok: false, error: 'entry_id is required.' };
  var found = findRow_(TAB_LEDGER, 'entry_id', id);
  if (!found) return { ok: false, error: 'Ledger entry not found.' };
  updateRowFields_(TAB_LEDGER, found.rowIndex, { status: 'void', notes: String(body.reason || 'voided').trim() });
  return { ok: true };
}

function adminGetReferralConfig_() {
  return { ok: true, config: refConfig_() };
}

function adminUpdateReferralConfig_(body) {
  var allowed = { referral_amount: 1, reward_type: 1, payout_threshold: 1, reward_on: 1, require_account_to_buy: 1 };
  var wrote = 0;
  for (var key in body) {
    if (!body.hasOwnProperty(key) || !allowed[key]) continue;
    var res = adminUpdateSettings_({ key: key, value: String(body[key]) });
    if (res.ok) wrote++;
  }
  return { ok: true, updated: wrote, config: refConfig_() };
}
