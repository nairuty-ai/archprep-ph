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
      case 'getSettings':  return jsonOut(getSettings_());
      case 'getProducts':  return jsonOut(getProducts_());
      case 'getQuizList':  return jsonOut(getQuizList_());
      case 'getQuiz':      return jsonOut(getQuiz_(params.quizId, params.code));
      case 'validateCode': return jsonOut(validateCodeEndpoint_(params.code, params.scope));
      case 'gradeQuiz':    return jsonOut(gradeQuiz_(body));
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

  var map = {}; // quiz_id -> { quiz_id, quiz_title, subject, question_count }
  var order = [];
  for (var i = 0; i < t.rows.length; i++) {
    var row = t.rows[i];
    var id = row.quiz_id;
    if (!id) continue;
    if (!map[id]) {
      map[id] = { quiz_id: id, quiz_title: row.quiz_title || id, subject: row.subject || '', question_count: 0 };
      order.push(id);
    }
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

  // Status
  if (String(match.status).trim().toLowerCase() === 'disabled') {
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
