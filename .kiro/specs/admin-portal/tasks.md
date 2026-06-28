# Implementation Plan — Admin Portal

## Overview

Build order matches the user's request: (1) backend auth + `requireAuth_` gate +
login/logout, (2) admin CRUD endpoints, (3) admin UI page, (4) per-quiz timer wiring.
All existing public endpoints and their tests must keep passing throughout. The work
extends `apps-script/Code.gs`, `apps-script/Setup.gs`, `js/ui.js`, `js/quiz.js`, adds
`admin.html` + `js/admin.js`, and updates the docs.

## Tasks

- [ ] 1. Backend auth foundation (Script Properties, hashing, tokens, gate)
  - [ ] 1.1 Add auth helpers to `apps-script/Code.gs`: `props_`, `bytesToHex_`, `sha256Hex_`, `makeToken_`, `randomSaltHex_`, constants (`SESSION_TTL_MS`=8h, `LOCK_THRESHOLD`=5, `LOCK_WINDOW_MS`=15m).
  - [ ] 1.2 Add editor-run `setupAdminCredential(username, plaintextPassword)` storing `cred:<username> = {salt, hash}`; never exposed as a web action.
  - [ ] 1.3 Implement `adminLogin_(body)` with salted-hash verify, generic error, token issue (`session:<token>`), and brute-force lockout (`lock:<username>`); `adminLogout_(body)` to delete the session.
  - [ ] 1.4 Implement `validateToken_(token)` and `requireAuth_(body)`; add `dispatchAdmin_(action, body)` that calls `requireAuth_` first and returns `{ok:false, error:"session_expired"}` on failure.
  - [ ] 1.5 Wire `adminLogin`/`adminLogout`/`dispatchAdmin_` into the existing `handleRequest` switch without altering existing public cases.
  - _Requirements: 1.1-1.6, 2.1-2.6, 3.1-3.4, 4.1-4.4, 5.1-5.3, 6.1-6.3, 10.1-10.2_

- [ ] 2. Backend admin CRUD endpoints (all token-gated)
  - [ ] 2.1 Quizzes: `adminListQuizzes_`, `adminCreateQuiz_` (unique `quiz_id` slug), `adminUpdateQuiz_` (rewrite quiz-level fields across rows), `adminDeleteQuiz_` (delete all rows for quiz_id).
  - [ ] 2.2 Questions: `adminListQuestions_` (includes `correct_option`+`explanation`, admin-only), `adminAddQuestion_` (next `question_number`, carries quiz-level fields), `adminUpdateQuestion_`, `adminDeleteQuestion_` (renumber), `adminReorderQuestions_`. Validate: text required, 2-4 non-empty options, exactly one correct.
  - [ ] 2.3 Products: `adminListProducts_`, `adminCreateProduct_` (unique `product_id` slug; `type` material/quiz; optional `unlock_scope`, `drive_note`), `adminUpdateProduct_`, `adminDeleteProduct_`. Validate numeric price/sort_order.
  - [ ] 2.4 Access codes: `adminListCodes_`, `adminCreateCode_` (readable unique `ARCH-XXXX`), `adminUpdateCode_`, `adminDeleteCode_`.
  - [ ] 2.5 Settings: `adminGetSettings_`, `adminUpdateSettings_` (upsert key/value).
  - [ ] 2.6 Shared row helpers: locate row by id, write/update/delete preserving exact column schema; id/code uniqueness generators.
  - _Requirements: 9.1-9.3, 11.1-11.6, 12.1-12.6, 13.1-13.6, 14.1-14.7, 15.1-15.3, 16.1-16.3_

- [ ] 3. Public endpoint extension — per-quiz timer (no answer leakage)
  - [ ] 3.1 Add `timer_minutes` handling to `getQuizList_` and `getQuiz_` (read per `quiz_id` from the Quizzes rows); keep stripping `correct_option`/`explanation`.
  - [ ] 3.2 Update `Setup.gs` seed: add `timer_minutes` to Quizzes (mock-1->60, others->0) and `unlock_scope`/`drive_note` to Products; update `sample-data/mission-control-template.md`.
  - _Requirements: 8.1-8.4, 17.1-17.3, 21.1_

- [ ] 4. Backend tests (Node harness, mocks for PropertiesService/Spreadsheet/Utilities)
  - [ ] 4.1 Regression: public `getQuiz`/`getQuizList`/`getProducts` contain no `correct_option`/`explanation`; existing public behaviour intact.
  - [ ] 4.2 Auth: setup->login(correct)->token; login(wrong)->generic error; lockout after 5; reset on success; expired/missing/bad token denied on a sample admin endpoint; logout invalidates.
  - [ ] 4.3 CRUD round-trips: quizzes, questions (incl. correct answer via `adminListQuestions`, renumber on delete), products, codes, settings; id/code uniqueness; `timer_minutes` propagates to public `getQuiz`.
  - _Requirements: 2.1-2.6, 3.1-3.4, 4.1-4.4, 12.1-12.6, 16.2, 17.1, 21.1_

- [ ] 5. Admin front-end — `admin.html` + `js/admin.js`
  - [ ] 5.1 `admin.html` shell reusing `css/styles.css` with slate-blue admin accent; login screen markup; dashboard container; `noindex`.
  - [ ] 5.2 `js/admin.js` auth controller: `adminPost(action,payload)` (POST text/plain, token from sessionStorage; on `session_expired` clear + show login); login/logout; expiry countdown + auto-logout.
  - [ ] 5.3 Dashboard shell: top bar (brand, "Admin", username, time-to-expiry, Logout) + section tabs (Quizzes, Products, Access Codes, Settings).
  - [ ] 5.4 Quizzes section: list; New/Edit quiz form (title, subject dropdown+add-new, timer minutes); Manage Questions sub-view with add/edit/delete + up/down reorder; question form with 2-4 options, radio correct answer, explanation; warn when a quiz has 0 questions.
  - [ ] 5.5 Products section: list; New/Edit/Delete form (type, subject, title, description, price PHP, HitPay link, Draft/Published toggle<->active, sort order, unlock scope, drive note).
  - [ ] 5.6 Access Codes section: list; New code form (scope dropdown, expiry date, max uses, notes); show generated code with Copy + delivery-email snippet; enable/disable; delete.
  - [ ] 5.7 Settings section: brand_name, contact_email, announcement_banner, hero_headline, hero_subhead.
  - [ ] 5.8 Cross-cutting UX: confirm dialogs before deletes, toasts, loading states, inline validation, friendly empty states; all dynamic output via `textContent`.
  - _Requirements: 7.1-7.2, 11.1-11.6, 12.1-12.6, 13.1-13.6, 14.6, 15.3, 18.1-18.5, 19.1-19.8, 20.1-20.5, 21.2_

- [ ] 6. Per-quiz timer wiring in public quiz page
  - [ ] 6.1 Update `js/quiz.js` to use `quiz.timer_minutes` from `getQuiz` (fallback: `mock`-prefixed -> `CONFIG.MOCK_TEST_MINUTES`, else none); keep auto-submit on timeout.
  - [ ] 6.2 Add cache-busting param to public `apiGet` reads in `js/ui.js` so admin changes reflect promptly.
  - _Requirements: 8.3, 21.1, 21.3_

- [ ] 7. Documentation updates
  - [ ] 7.1 `SETUP.md`: run `setupAdminCredential` once + change later; new `timer_minutes` (Quizzes) and `unlock_scope`/`drive_note` (Products) columns; redeploy Apps Script as a NEW VERSION after adding endpoints.
  - [ ] 7.2 `ADMIN_GUIDE.md`: portal walkthrough (login, build a quiz + questions + timer, create/price a product + unlock scope, generate+send a code, edit settings); changes go live automatically.
  - [ ] 7.3 `README.md`: note student login is a deliberate phase-2 item and why.
  - _Requirements: 22.1-22.3, 23.1-23.3_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "3"], "dependsOn": [] },
    { "wave": 2, "tasks": ["2"], "dependsOn": ["1"] },
    { "wave": 3, "tasks": ["4", "5", "6"], "dependsOn": ["2", "3"] },
    { "wave": 4, "tasks": ["7"], "dependsOn": ["2", "5"] }
  ]
}
```

```
Task 1 (auth foundation)
  └─> Task 2 (admin CRUD endpoints)
        └─> Task 4 (backend tests)
Task 3 (public timer extension) ──> Task 4 (backend tests)
Task 1, Task 2 ──> Task 5 (admin front-end)
Task 3 ──> Task 6 (public timer wiring)
Task 2, Task 5 ──> Task 7 (docs)
```

- Task 1 has no dependencies (start here).
- Task 2 depends on Task 1 (uses `requireAuth_`/`dispatchAdmin_`).
- Task 3 is independent of auth and can run alongside Task 1/2.
- Task 4 depends on Tasks 2 and 3 (verifies endpoints + public guarantee).
- Task 5 depends on Tasks 1 and 2 (UI calls the endpoints).
- Task 6 depends on Task 3 (consumes `timer_minutes`).
- Task 7 depends on Tasks 2 and 5 (documents finished behaviour).

## Notes

- Keep the existing security model exactly as designed: salted SHA-256 in Script
  Properties, central `requireAuth_` gate, 8h token expiry, lockout, POST/text-plain
  transport, and public answer-stripping (with its regression test).
- Do not introduce a `status` column; `active` is the single publish control.
- Quizzes and products are separate id namespaces; `timer_minutes` is per-quiz on the
  Quizzes tab; product->quizzes linkage stays via access-code scope.
- After backend changes, the owner must redeploy the Apps Script as a NEW VERSION for
  changes to go live (documented in SETUP.md).
- A default admin credential will be provided for local testing and reported to the
  user when the first working version is ready.
