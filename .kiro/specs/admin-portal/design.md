# Design Document — Admin Portal

## Overview

This design adds a token-authenticated **admin portal** to the existing ArchPrep PH
platform without changing the zero-cost architecture: a static front-end
(Cloudflare Pages / workers.dev) plus a single Google Apps Script Web App that
reads and writes one "Mission Control" Google Sheet.

The portal is a new static page (`admin.html` + `js/admin.js`) that talks to a set
of **new admin endpoints** added to the existing `apps-script/Code.gs`. Every admin
endpoint (except `adminLogin`) is gated by a **server-side session-token check**.
Because the Web App is deployed "Anyone can access," this server-side check — not
the obscurity of the admin URL — is the only thing protecting admin actions.

The design preserves the platform's core guarantee: the public `getQuiz` endpoint
continues to return questions **without** `correct_option` or `explanation`. Correct
answers leave the server only via the token-authenticated `adminListQuestions` and
the existing `gradeQuiz` (after a valid submission).

Per the user's decision, **no `status` column is introduced**. The existing
`active` (`TRUE`/`FALSE`) column remains the single authoritative publish control,
surfaced in the admin UI as a "Draft / Published" toggle.

**Data-model correction (authoritative):** sellable **products** and **quizzes** are
kept separate, matching the existing data. A quiz-pack *product* (e.g.
`quiz-structural`, the Mock Series) is a row in `Products` with `type=quiz`, a price,
a HitPay link, and `active`; it can unlock **several** quizzes. The *quizzes*
themselves (`structural-1/2/3`, `mock-1/2/3`) live in the `Quizzes` tab, each with its
own `quiz_id`, title, subject, questions, and **its own timer**. Therefore
**`timer_minutes` is a column on the `Quizzes` tab** (read per `quiz_id` by the public
`getQuiz`), **not** on `Products`, and **`product_id` is NOT forced to equal
`quiz_id`**. The pack→quizzes link remains the existing **access-code scope** (e.g. a
subject prefix `structural` unlocks `structural-1/2/3`), unchanged. The admin UI has
two distinct areas: (1) build **quizzes** + their questions + per-quiz timer, and
(2) create/price **products** and record what each unlocks via scope.

## Architecture

### High-level components

```
Admin's browser
  └─ admin.html + js/admin.js  (ES module; token kept in sessionStorage)
        │  POST text/plain JSON  { action, token, ...payload }
        ▼
Google Apps Script Web App  (apps-script/Code.gs — the only backend)
        │  doPost → handleRequest → (admin action?) → validateToken_ → dispatch
        ├─ PropertiesService (Script Properties): credentials, sessions, lockout
        └─ Mission Control Google Sheet: Products / Quizzes / AccessCodes / Settings / Attempts

Student's browser (unchanged)
  └─ public pages → existing public endpoints (getProducts, getQuiz, gradeQuiz, …)
```

### Why Script Properties (not a Sheet tab) for auth state

Sessions, credentials, and lockout counters are stored in **Script Properties**
(`PropertiesService.getScriptProperties()`), not in a Sheet tab, because:

- It is **server-side only** and is never returned by any endpoint, so tokens and
  hashes cannot leak the way a mis-handled Sheet tab might.
- It avoids Sheet read/write latency and the row-scanning needed for a `_Sessions`
  tab on every authenticated request.
- It is simple key/value storage, a natural fit for `token → session` lookups.

The optional hidden `_Sessions` tab from the requirements is therefore **not used**;
Requirement 10 is satisfied because no session storage is ever exposed by an
endpoint. (If Script Properties volume ever became a concern, sessions could move to
`_Sessions`; this design notes that as a future option only.)

### Script Properties key scheme

| Key | Value (JSON string) | Purpose |
|---|---|---|
| `cred:<username>` | `{ "salt": "<hex>", "hash": "<hex>" }` | Admin credential record |
| `session:<token>` | `{ "username": "<u>", "expires": <epochMs> }` | Active session |
| `lock:<username>` | `{ "count": <int>, "lastMs": <epochMs> }` | Failed-login tracking |

Usernames are lower-cased and trimmed for keying. Tokens are hex strings (see below).

### Authentication flow

```
adminLogin(username, password)
  1. key = "lock:" + norm(username); read lock record.
     if count >= 5 AND (now - lastMs) < 15 min → return {ok:false, error:"locked …"}
     (if window elapsed, reset count to 0)
  2. read cred:<username>. If missing → record failure, generic error.
  3. computed = sha256Hex(salt + password). If computed !== stored hash →
     increment lock.count, set lock.lastMs, return generic {ok:false, error:"Invalid username or password."}
  4. success: delete lock key (reset). token = makeToken_(); expires = now + 8h.
     PropertiesService.set("session:"+token, {username, expires}).
     return {ok:true, token, expires}

Every admin action (not adminLogin):
  1. handleRequest extracts action + token from POST body.
  2. validateToken_(token):
       rec = get "session:"+token; if missing → {ok:false}
       if now > rec.expires → delete key, {ok:false}
       else {ok:true, username: rec.username}
  3. if invalid → return {ok:false, error:"session_expired"} (NO action performed).
  4. else dispatch to the handler.

adminLogout(token) → delete "session:"+token → {ok:true}
```

This control flow makes the token check **mandatory and central**: a single
`requireAuth_(body)` wrapper runs before any admin handler. There is no code path
to an admin action that bypasses it.

## Components and Interfaces

### Backend — additions to `apps-script/Code.gs`

The existing `handleRequest(e, method)` switch is extended. New admin actions are
dispatched through a wrapper that enforces auth. Existing public cases are
**unchanged** except `getQuizList_`/`getQuiz_` now include `timer_minutes`.

```js
// Inside handleRequest's switch, after the existing public cases:
case 'adminLogin':          return jsonOut(adminLogin_(body));
case 'adminLogout':         return jsonOut(adminLogout_(body));
// All remaining admin actions go through requireAuth_:
case 'adminListQuizzes':
case 'adminCreateQuiz':
case 'adminUpdateQuiz':
case 'adminDeleteQuiz':
case 'adminListQuestions':
case 'adminAddQuestion':
case 'adminUpdateQuestion':
case 'adminDeleteQuestion':
case 'adminReorderQuestions':
case 'adminListProducts':
case 'adminCreateProduct':
case 'adminUpdateProduct':
case 'adminDeleteProduct':
case 'adminListCodes':
case 'adminCreateCode':
case 'adminUpdateCode':
case 'adminDeleteCode':
case 'adminGetSettings':
case 'adminUpdateSettings':
  return jsonOut(dispatchAdmin_(action, body));
```

```js
function dispatchAdmin_(action, body) {
  var auth = requireAuth_(body);            // server-side token check
  if (!auth.ok) return { ok: false, error: 'session_expired' };
  switch (action) {
    case 'adminListQuizzes':     return adminListQuizzes_(body);
    case 'adminCreateQuiz':      return adminCreateQuiz_(body);
    /* … one per admin action … */
  }
}

function requireAuth_(body) {
  var token = body && body.token ? String(body.token) : '';
  return validateToken_(token);             // {ok:true, username} | {ok:false}
}
```

#### Auth helpers (concrete)

```js
var SESSION_TTL_MS   = 8 * 60 * 60 * 1000;  // 8 hours
var LOCK_THRESHOLD   = 5;
var LOCK_WINDOW_MS   = 15 * 60 * 1000;      // 15 minutes

function props_() { return PropertiesService.getScriptProperties(); }

function bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xFF;                // handle negative (signed) bytes
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function sha256Hex_(str) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytesToHex_(raw);
}

// >=32 bytes of entropy: 4 UUIDs (~25 bytes random each) concatenated, then
// SHA-256'd to a uniform 32-byte (64 hex char) token.
function makeToken_() {
  var seed = Utilities.getUuid() + Utilities.getUuid() +
             Utilities.getUuid() + Utilities.getUuid() + String(Date.now());
  return sha256Hex_(seed);                  // 64 hex chars = 32 bytes
}

function randomSaltHex_() {
  return sha256Hex_(Utilities.getUuid() + Utilities.getUuid() + String(Date.now()))
           .substring(0, 32);               // 16-byte salt
}

// EDITOR-RUN ONLY — never exposed as a web action.
function setupAdminCredential(username, plaintextPassword) {
  var u = String(username).trim().toLowerCase();
  var salt = randomSaltHex_();
  var hash = sha256Hex_(salt + plaintextPassword);
  props_().setProperty('cred:' + u, JSON.stringify({ salt: salt, hash: hash }));
  return 'Stored credential for "' + u + '". Now clear the password from the editor.';
}

function validateToken_(token) {
  if (!token) return { ok: false };
  var raw = props_().getProperty('session:' + token);
  if (!raw) return { ok: false };
  var rec = JSON.parse(raw);
  if (Date.now() > rec.expires) { props_().deleteProperty('session:' + token); return { ok: false }; }
  return { ok: true, username: rec.username };
}
```

`adminLogin_` verifies with a length-then-content comparison (the constant-time-ish
compare avoids early-exit on first differing char), returns a generic error on any
failure, and applies the lockout logic above.

#### `timer_minutes` (per-quiz, on the Quizzes tab)

`timer_minutes` is a column on the **`Quizzes`** tab, denormalized onto each question
row of a quiz (exactly like the existing `quiz_title` and `subject`). It is read
**per `quiz_id`** from that quiz's rows.

- `getQuizList_`: when grouping questions by `quiz_id`, read `timer_minutes` from the
  quiz's rows (first non-blank) and include it per quiz.
- `getQuiz_`: include `timer_minutes` in the returned `quiz` object.
- `0`/blank means no timer. There is **no** Products lookup for timing.
- **Backward compatibility:** quizzes whose rows have no `timer_minutes` value resolve
  to `0`; the front-end retains `MOCK_TEST_MINUTES` as a fallback used only when
  `timer_minutes` is absent/0 and the `quiz_id` starts with `mock`.

Products and quizzes are linked only by **access-code scope** (e.g. scope
`structural` unlocks `structural-1/2/3`); no `product_id == quiz_id` assumption is
made anywhere.

### Backend endpoint contracts

All requests: `POST`, `Content-Type: text/plain`, body is a JSON string
`{ action, token?, ...fields }`. All responses are JSON via the existing `jsonOut`.

| Endpoint | Token? | Request fields | Response |
|---|---|---|---|
| `adminLogin` | no | `username, password` | `{ok, token, expires}` / `{ok:false, error}` |
| `adminLogout` | yes | `token` | `{ok:true}` |
| `adminListQuizzes` | yes | — | `{ok:true, quizzes:[{quiz_id,quiz_title,subject,timer_minutes,question_count}]}` |
| `adminCreateQuiz` | yes | `quiz_title,subject,timer_minutes` | `{ok:true, quiz_id}` (slug generated unique; persisted once it has its first question) |
| `adminUpdateQuiz` | yes | `quiz_id,quiz_title,subject,timer_minutes` | `{ok:true}` (rewrites those fields across all rows of the quiz_id) |
| `adminDeleteQuiz` | yes | `quiz_id` | `{ok:true}` (deletes all `Quizzes` rows for that quiz_id) |
| `adminListQuestions` | yes | `quiz_id` | `{ok:true, quiz_title, subject, timer_minutes, questions:[{question_number,question_text,options[],correct_index,correct_option,explanation}]}` (**admin-only; includes answers**) |
| `adminAddQuestion` | yes | `quiz_id,quiz_title,subject,timer_minutes,question_text,options[],correct_index,explanation` | `{ok:true, question_number}` (carries quiz-level fields onto the row) |
| `adminUpdateQuestion` | yes | `quiz_id,question_number, ...fields` | `{ok:true}` |
| `adminDeleteQuestion` | yes | `quiz_id,question_number` | `{ok:true}` (renumbers remaining) |
| `adminReorderQuestions` | yes | `quiz_id,orderedNumbers[]` | `{ok:true}` |
| `adminListProducts` | yes | — | `{ok:true, products:[{product_id,type,subject,title,description,price_php,hitpay_link,active,sort_order,unlock_scope,drive_note}]}` |
| `adminCreateProduct` | yes | `type,subject,title,description,price_php,hitpay_link,active,sort_order,unlock_scope,drive_note` | `{ok:true, product_id}` |
| `adminUpdateProduct` | yes | `product_id, ...fields` | `{ok:true}` |
| `adminDeleteProduct` | yes | `product_id` | `{ok:true}` |
| `adminListCodes` | yes | — | `{ok:true, codes:[{code,scope,expiry_date,max_uses,uses_count,status,notes}]}` |
| `adminCreateCode` | yes | `scope,expiry_date,max_uses,notes` | `{ok:true, code}` |
| `adminUpdateCode` | yes | `code, ...fields` | `{ok:true}` |
| `adminDeleteCode` | yes | `code` | `{ok:true}` |
| `adminGetSettings` | yes | — | `{ok:true, settings:{...}}` |
| `adminUpdateSettings` | yes | `key, value` | `{ok:true}` |

Notes: `AccessCodes.status` (`active`/`disabled`) is the pre-existing access-code
state column, unrelated to product publish state. `adminCreateProduct` accepts
`type` = `material` or `quiz`; quiz-pack products carry an optional `unlock_scope`
(e.g. `structural` or `all`) recording which quizzes the product unlocks, used to
pre-fill the access-code scope when issuing codes. `drive_note` is a free-text
fulfilment note (materials). Neither `unlock_scope` nor `drive_note` is returned by
any public endpoint.

#### ID / code generators (uniqueness guaranteed)

- `quiz_id` / `product_id`: slugify the title (lowercase, hyphens, ASCII), prefix
  `quiz-`/`mat-`; if the slug already exists in `Products.product_id`, append
  `-2`, `-3`, … until unique. Read the Products column once to check.
- Access code: `ARCH-` + 4 chars drawn from an unambiguous alphabet
  (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, excluding `0/O/1/I`); regenerate on collision
  with existing `AccessCodes.code` (case-insensitive).

### Front-end — `admin.html` + `js/admin.js`

- Reuses `css/styles.css`. Admin context gets a slate-blue (`--secondary`) accent
  (a top-bar treatment + a body class `admin`) so it's visually distinct.
- Reuses `js/ui.js` helpers: `el()` (textContent-based, injection-safe), and a small
  admin-specific POST helper mirroring `apiPost` but always including the token.
- **Token** kept in `sessionStorage` (`archprep_admin_token`, `…_expires`);
  cleared on logout and on any `session_expired`.

Module structure (`js/admin.js`):

| Unit | Responsibility |
|---|---|
| `adminPost(action, payload)` | POST text/plain `{action, token, ...payload}`; on `error==="session_expired"` clear token + force login screen |
| auth controller | login form, logout, expiry countdown, auto-logout timer |
| dashboard shell | top bar (brand, "Admin", username, time-to-expiry, Logout) + section tabs |
| Quiz Packs section | Quizzes area: list quizzes, New/Edit quiz (title, subject, per-quiz timer), Manage Questions sub-view |
| Question editor | 2–4 option rows (add/remove), radio to pick the single correct answer, explanation textarea, validation, reorder up/down |
| Products section | list products (material + quiz packs), New/Edit/Delete (type, price, HitPay link, Draft/Published toggle ↔ `active`, unlock scope, drive note) |
| Access Codes section | list + New code form, generated-code display with Copy + email snippet, enable/disable, delete |
| Settings section | brand_name, contact_email, announcement_banner, hero_headline, hero_subhead |
| toasts / confirm | success/error toasts, confirm dialog before destructive actions, loading states, empty states |

#### Quiz timer generalisation in `js/quiz.js`

Currently `isMock()` decides timing from `quiz_id` prefix + `CONFIG.MOCK_TEST_MINUTES`.
New behaviour: read `timer_minutes` from the `getQuiz` response.

```
minutes = Number(quiz.timer_minutes) > 0 ? quiz.timer_minutes
        : (/^mock/i.test(quizId) ? Number(CONFIG.MOCK_TEST_MINUTES) : 0);
if (minutes > 0) startTimer(minutes);   // else no timer
```

This is backward compatible: packs with a configured `timer_minutes` use it; legacy
`mock-*` packs fall back to `MOCK_TEST_MINUTES`; everything else has no timer.

#### Cache-busting for live reflection

Apps Script Web App responses are not cached by default, but to be safe the public
read fetches (`getProducts`, `getQuizList`, `getSettings`) append a cache-buster
`&_=<Date.now()>` so an admin change is never served stale from an intermediary.
This is a one-line change in `js/ui.js`'s `apiGet` and does not affect the contract.

## Data Models

### Products tab (sellable items — materials and quiz packs)

```
product_id | type | subject | title | description | price_php | hitpay_link | active | sort_order | unlock_scope | drive_note
```

- `active`: unchanged; `TRUE` = Published, `FALSE` = Draft. **Single publish control.**
- `unlock_scope` (NEW, optional): for `type=quiz` products, records which quizzes the
  product unlocks (e.g. `structural`, `all`), used to pre-fill the access-code scope.
- `drive_note` (NEW, optional): free-text fulfilment note for materials.
- **No `timer_minutes` on Products.** Timing is per-quiz (see below).
- Existing rows without the new columns default to blank. Public endpoints never
  return `unlock_scope` or `drive_note`.

### Quizzes tab (quiz definitions + questions — one new column)

```
quiz_id | quiz_title | subject | question_number | question_text | option_a | option_b | option_c | option_d | correct_option | explanation | timer_minutes
```

- `timer_minutes` (NEW): per-quiz countdown in minutes, denormalized onto every row
  of the quiz (like `quiz_title`/`subject`); `0`/blank = no timer. Read per `quiz_id`.
- A quiz is the set of `Quizzes` rows sharing a `quiz_id`. It is persisted once it has
  at least one question; quiz-level fields (`quiz_title`, `subject`, `timer_minutes`)
  are written identically on each of its rows.

`Setup.gs` is updated so a fresh Sheet's `Quizzes` tab includes `timer_minutes`
(e.g. `mock-1` → 60, `structural-1` → 0) and `Products` includes `unlock_scope`
(e.g. `quiz-structural` → `structural`, `quiz-mock` → `mock`) and `drive_note`.

### Script Properties records

```
cred:<username>   = { salt: "<hex16B>", hash: "<hex32B sha256(salt+password)>" }
session:<token>   = { username: "<u>", expires: <epochMs> }      // token = 64 hex chars
lock:<username>   = { count: <int>, lastMs: <epochMs> }
```

### Quiz ↔ questions ↔ products

- **Quiz**: `Quizzes` rows sharing a `quiz_id`; `question_number` sequential from 1.
  Options stored `option_a..option_d`; `correct_option` as `A..D`. Admin payload uses
  `options[]` + `correct_index` (0-based); the backend maps to/from letters.
- **Product**: a `Products` row (`type=material` or `type=quiz`). A quiz-pack product
  unlocks one or more quizzes; the link is the **access-code scope**, not an id match.
  `product_id` and `quiz_id` are independent namespaces.

## Error Handling

- Every endpoint returns JSON via `jsonOut` — never an HTML error page (reuses the
  existing pattern; the top-level `try/catch` in `handleRequest` already guarantees a
  JSON error response).
- Auth failures: `{ok:false, error:"session_expired"}`; login failures: generic
  `{ok:false, error:"Invalid username or password."}`; lockout: `{ok:false,
  error:"Too many attempts. Try again in N minutes."}`.
- Validation failures (missing required field, non-numeric price/timer, <2 options,
  no/!=1 correct answer): `{ok:false, error:"<specific message>"}`, no row written.
- Missing tab/column: the existing `readTable_` throws a clear named error, caught and
  returned as JSON.
- Front-end: friendly inline messages + toasts; `session_expired` always returns to
  the login screen with a notice.

## Testing Strategy

Continue the project's pattern of Node-based harness tests that mock
`PropertiesService`, `SpreadsheetApp`, `ContentService`, and `Utilities`, load
`Code.gs`, and exercise `doPost`/`doGet`.

Critical tests:

1. **Public answer-key guarantee (regression).** `getQuiz` for a valid code returns
   questions with options but **no** `correct_option` and **no** `explanation`
   (string-search the serialized response). Must still pass after admin code is added.
2. **Token gate.** Calling each admin endpoint with no token / bad token / expired
   token returns `{ok:false, error:"session_expired"}` and performs no write.
3. **Login + hashing.** `setupAdminCredential` then `adminLogin` with correct
   password succeeds and returns a 64-hex token; wrong password returns the generic
   error; the stored value is a salted SHA-256 hash, never the plaintext.
4. **Lockout.** 5 failed attempts trigger a 15-minute lockout; a success resets it.
5. **CRUD round-trips.** Create/list/update/delete for quiz packs, questions
   (incl. correct answer + explanation via `adminListQuestions`), materials, codes,
   settings; question delete renumbers; `adminDeleteQuizPack` removes both tabs' rows.
6. **timer_minutes propagation.** `getQuiz`/`getQuizList` include `timer_minutes`
   from the matching Products row; absent → 0.
7. **Draft/Published.** `active=FALSE` pack is excluded from public `getProducts`/
   `getQuizList`; `TRUE` is included.

## Security Considerations

- **Server-side enforcement only.** Admin protection is the per-request token check,
  not the secrecy of `/admin`. The page and JS are public static files by design.
- **No plaintext secrets** anywhere: only salted SHA-256 hashes in Script Properties.
- **Generic auth errors** to avoid username/password enumeration; lockout limits
  guessing.
- **Credentials/tokens never in URLs** (POST text/plain only), keeping them out of
  server logs and browser history.
- **Answer-key confidentiality** unchanged: only `adminListQuestions` (token) and
  `gradeQuiz` (valid submission) ever emit `correct_option`/`explanation`.
- **Output safety:** all dynamic admin DOM via `textContent`.
- **Token lifetime** capped at 8h; expired sessions rejected and lazily purged.
- Note: SHA-256(salt+password) is acceptable here given a single-admin, low-value
  threat model and Apps Script's available primitives; a slow KDF (bcrypt/PBKDF2)
  isn't natively available. The lockout + strong-password guidance in SETUP.md
  mitigate offline-guessing risk (which would first require compromising the Google
  account that owns Script Properties).

## Correctness Properties

These are invariants the implementation and tests must uphold:

### Property 1: No answer leakage on public paths
For any input, the public `getQuiz`, `getQuizList`, `getProducts`, `getSettings`, and
`validateCode` responses contain no `correct_option` and no `explanation`. Answers
appear only in `adminListQuestions` and `gradeQuiz` responses.

**Validates: Requirements 17.1, 17.2, 12.1**

### Property 2: Auth is total over admin actions
Every admin action except `adminLogin` returns `session_expired` and performs zero
Sheet writes unless `validateToken_` returns `ok:true`. There is no dispatch path to
an admin handler that skips `requireAuth_`.

**Validates: Requirements 4.1, 4.2, 4.4**

### Property 3: Secrets are never stored or returned in plaintext
No endpoint or stored property ever contains the admin password in plaintext; only
`{salt, hash}` and session tokens exist server-side, and none of `cred:*`,
`session:*`, or `lock:*` is ever returned by any endpoint.

**Validates: Requirements 1.5, 10.2**

### Property 4: Lockout monotonicity
After 5 consecutive failures for a username, every login attempt within 15 minutes is
rejected without a successful hash comparison; a single successful login resets the
counter to 0.

**Validates: Requirements 3.2, 3.3, 3.4**

### Property 5: Token expiry
A token is accepted only while `now <= expires`; once expired or logged out, it is
rejected on every subsequent request.

**Validates: Requirements 2.2, 4.1, 5.3**

### Property 6: Sheet schema integrity
Every admin write produces rows matching the exact existing column order/headers for
that tab; a quiz's quiz-level fields (`quiz_title`, `subject`, `timer_minutes`) are
identical across all rows sharing its `quiz_id`. Products and quizzes are independent
id namespaces (no `product_id == quiz_id` assumption).

**Validates: Requirements 9.2, 9.3, 8.1**

### Property 7: ID/code uniqueness
Generated `quiz_id`, `product_id`, and access codes never duplicate an existing value
in the relevant tab.

**Validates: Requirements 16.2**

### Property 8: Publish control consistency
A product is visible on the public site if and only if its `active` value is `TRUE`;
no separate `status` column participates in visibility.

**Validates: Requirements 8.2, 8.4**

### Property 9: Question numbering
After any add/delete/reorder, a pack's `question_number` values are exactly `1..N`
with no gaps or duplicates.

**Validates: Requirements 12.2, 12.4, 12.5**

## Requirements Traceability

| Design area | Requirements |
|---|---|
| `setupAdminCredential`, `sha256Hex_`, `bytesToHex_`, salt | R1 |
| `adminLogin_`, `makeToken_`, 8h expiry, generic error | R2 |
| `lock:<username>` logic, threshold 5 / 15 min | R3 |
| `requireAuth_`/`validateToken_` on every admin action; `session_expired` | R4 |
| `adminLogout_`, sessionStorage clear | R5 |
| POST text/plain transport, no creds in query strings | R6 |
| `textContent` rendering in `js/admin.js` | R7, R19 |
| `timer_minutes` column, `active`-as-publish, public include | R8 |
| `product_id === quiz_id`, exact schema writes | R9 |
| Script Properties for sessions; no exposed `_Sessions` | R10 |
| `adminListQuizPacks/Create/Update/Delete` | R11 |
| `adminListQuestions/Add/Update/Delete/Reorder` | R12 |
| material admin endpoints | R13 |
| access-code admin endpoints + code generator | R14 |
| `adminGetSettings/UpdateSettings` | R15 |
| validation + ID/code uniqueness + JSON always | R16 |
| public `getQuiz` strips answers; only admin/grade emit them | R17 |
| login screen + session UI | R18 |
| dashboard structure, confirmations, toasts, empty states | R19 |
| pack/question editing UX (radio correct answer, publish-0 warning) | R20 |
| cache-busting + live reflection | R21 |
| SETUP/ADMIN_GUIDE/README updates | R22 |
| no student login; access-code flow unchanged | R23 |
```
