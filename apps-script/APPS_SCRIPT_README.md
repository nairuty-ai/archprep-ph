# APPS_SCRIPT_README.md — Installing & deploying the backend

`Code.gs` is the **entire backend** for ArchPrep PH: a single Google Apps Script
Web App, bound to the **Mission Control** Google Sheet, owned by
**`rehinaneel@gmail.com`**. It reads the Sheet, strips quiz answer keys before
sending questions, validates access codes, and grades submissions.

---

## 1. Install (bind the script to the Sheet)

1. Open the **Mission Control** Sheet (signed in as `rehinaneel@gmail.com`).
2. **Extensions → Apps Script.**
3. Replace everything in the default `Code.gs` with the full contents of
   [`Code.gs`](Code.gs). **Save.**

Because you opened the editor *from the Sheet*, the script is **bound** to it and
`SpreadsheetApp.getActiveSpreadsheet()` automatically points at the right Sheet —
no Sheet ID to configure.

---

## 2. Required tabs & columns

The script reads these tab names **exactly** (see
[`../sample-data/mission-control-template.md`](../sample-data/mission-control-template.md)
for full details and seed rows):

| Tab | Required columns (header row, exact spelling) |
|---|---|
| `Products` | `product_id`, `type`, `subject`, `title`, `description`, `price_php`, `hitpay_link`, `active`, `sort_order` |
| `Quizzes` | `quiz_id`, `quiz_title`, `subject`, `question_number`, `question_text`, `option_a`, `option_b`, `option_c`, `option_d`, `correct_option`, `explanation` |
| `AccessCodes` | `code`, `scope`, `expiry_date`, `max_uses`, `uses_count`, `status`, `notes` |
| `Settings` | key/value rows (column A = key, column B = value) |
| `Attempts` | `timestamp`, `code`, `quiz_id`, `score`, `total` (auto-created if missing) |

If a required column is missing, every affected endpoint returns a clear JSON
error naming the missing column (e.g. `Tab "Products" is missing the required
column "price_php"...`).

---

## 3. Deploy as a Web App

1. **Deploy → New deployment.**
2. Gear ⚙️ → **Web app**.
3. **Execute as:** **Me (`rehinaneel@gmail.com`)**.
4. **Who has access:** **Anyone**.
5. **Deploy**, then authorise (Review permissions → Allow). It's normal to see an
   "unverified app" warning for your own script — Advanced → Go to project → Allow.
6. Copy the **Web app URL** (ends in `/exec`) and paste it into
   [`../config.js`](../config.js) as `APPS_SCRIPT_URL`.

### Re-deploying after edits
Edit `Code.gs` → **Deploy → Manage deployments → ✏️ edit → Version: New version →
Deploy**. This keeps the **same `/exec` URL**, so `config.js` doesn't change.

---

## 4. CORS — why the code is written this way

Apps Script Web Apps are called cross-origin and **cannot set custom CORS
headers**. To avoid the browser's CORS *preflight* (which Apps Script can't
answer), the front-end uses only **simple requests**:

- **GET** with query parameters (e.g. `?action=getProducts`).
- **POST** with `Content-Type: text/plain`, sending a JSON **string** body. The
  script parses it with `JSON.parse(e.postData.contents)`.

The script always replies with
`ContentService.createTextOutput(JSON.stringify(...)).setMimeType(JSON)`.

**Do not** change the front-end to send `application/json` or custom headers —
that would trigger a preflight and break the calls.

---

## 5. The API contract (endpoints)

All responses are JSON. Base URL = your `/exec` URL.

| # | Call | Returns |
|---|---|---|
| 1 | `GET ?action=getSettings` | `{ brand_name, contact_email, announcement_banner, hero_headline, hero_subhead, ... }` |
| 2 | `GET ?action=getProducts` | `[{ product_id, type, subject, title, description, price_php, hitpay_link, sort_order }]` (active rows only) |
| 3 | `GET ?action=getQuizList` | `[{ quiz_id, quiz_title, subject, question_count }]` (no questions) |
| 4 | `GET ?action=getQuiz&quizId=<id>&code=<code>` | valid → `{ ok:true, quiz:{ quiz_id, quiz_title, subject, questions:[{ question_number, question_text, options:{A,B,C,D} }] } }`; invalid → `{ ok:false, error }`. **No `correct_option`, no `explanation`.** |
| 5 | `POST action=gradeQuiz` (text/plain JSON body `{ quizId, code, answers:{ "1":"B", ... } }`) | `{ ok:true, score, total, results:[{ question_number, your_answer, correct_option, is_correct, explanation }] }`. **The only endpoint that returns correct answers**, and only after a valid submission. Also increments `uses_count` and appends to `Attempts`. |
| 6 | `GET ?action=validateCode&code=<code>&scope=<quizId>` | `{ ok:true }` or `{ ok:false, error }` |

### Code validation rules (server-side, never trust the client)
- Codes are matched **case-insensitively** and whitespace is trimmed.
- A code is rejected if: it doesn't exist, `status` is `disabled`, it's past its
  `expiry_date` (valid through end of that day), its `scope` doesn't cover the
  quiz, or `uses_count >= max_uses` (when `max_uses` is set).
- `scope` of `all` covers everything; an exact `quiz_id` covers that quiz; a
  subject prefix (e.g. `structural`) covers `structural-1`, `structural-2`, …
- `uses_count` is incremented **only on `gradeQuiz`** (not on `getQuiz`).

---

## 6. Test each endpoint from a browser

Paste these into your address bar, replacing `EXEC_URL` with your `/exec` URL.
(GET endpoints are testable directly; `gradeQuiz` is POST-only and is exercised by
the website's quiz page.)

```
EXEC_URL?action=getSettings
EXEC_URL?action=getProducts
EXEC_URL?action=getQuizList
EXEC_URL?action=validateCode&code=ARCH-7F3K&scope=structural-1
EXEC_URL?action=getQuiz&quizId=structural-1&code=ARCH-7F3K
```

For the seed data, `getQuiz` above should return 5 questions **with options but
no `correct_option` and no `explanation`** — that's the security guarantee in
action. Trying a wrong code (e.g. `&code=WRONG`) should return
`{ "ok": false, "error": "..." }`.

### Quick check inside the editor
Run the `selfTest_` function (function dropdown → **Run**) and open
**View → Logs** to see your settings, products, and quiz list printed — a fast
way to confirm the Sheet is wired up before deploying.

---

## 7. Troubleshooting

- **`Unknown or missing action`** — the `action` parameter wasn't supplied or is
  misspelled.
- **`Missing tab "X"`** — create a tab named exactly `X`.
- **`...missing the required column "Y"`** — fix the header spelling in that tab.
- **Site can't reach the server** — confirm the deployment's **Who has access =
  Anyone**, and that `config.js` uses the `/exec` URL (not `/dev`).
- **Changes to `Code.gs` not taking effect** — you must **re-deploy a new
  version** (Section 3); saving alone updates only the `/dev` test URL.
