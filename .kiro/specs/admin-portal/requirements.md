# Requirements Document

## Introduction

This feature adds a secure, non-technical-friendly **admin portal** to the existing ArchPrep PH platform. The platform is a static front-end (Cloudflare Pages) backed by a single Google Apps Script Web App that reads and writes one "Mission Control" Google Sheet. The public site sells ALE review materials and practice quizzes; quizzes unlock via access codes and are graded server-side so answer keys never reach the browser.

Today the owner manages all content by editing the Google Sheet by hand. This feature adds a new page (`admin.html` + `js/admin.js`) and a set of token-authenticated Apps Script endpoints so the owner manages everything through forms. The portal writes to the same Sheet the public site reads, so changes reflect on the live site without a redeploy. The stack remains zero-cost: static front-end + Google Apps Script Web App + Mission Control Google Sheet. No new servers and no paid services are introduced.

Because the Apps Script Web App is deployed as "Anyone can access," **server-side session-token verification on every admin request is the only protection**. A secret URL is explicitly not treated as security. Authentication and security requirements are therefore first-class in this document.

**Out of scope (deliberate phase-2 items):** student accounts, student login, and student password storage. Students continue to use the existing access-code flow. Also out of scope: payment-API integration, automated material delivery, and any paid third-party services. The rationale for deferring student login is recorded in the README.

## Glossary

- **Admin_Portal**: The new authenticated front-end (`admin.html` + `js/admin.js`) through which the owner manages site content via forms.
- **Public_Site**: The existing public-facing static pages that students use (`index.html`, `materials.html`, `quizzes.html`, `quiz.html`, etc.).
- **Apps_Script_Backend**: The single Google Apps Script Web App (`apps-script/Code.gs`) that is the only backend, reading and writing the Mission Control Sheet.
- **Mission_Control_Sheet**: The single Google Sheet containing the tabs `Products`, `Quizzes`, `AccessCodes`, `Settings`, `Attempts`, and optionally a hidden `_Sessions` tab.
- **Admin_User**: The single owner account (optionally a small fixed list of accounts) authorized to use the Admin_Portal, identified by username and password.
- **Script_Properties**: The Apps Script key/value store used to hold the admin credential record, session tokens, and failed-attempt counters.
- **Admin_Credential**: The stored record `{username, salt, hash}` where `hash = SHA-256(salt + plaintextPassword)`, persisted in Script_Properties during one-time setup.
- **Session_Token**: A cryptographically random value of at least 32 bytes issued on successful login, with an associated expiry timestamp, used to authenticate subsequent admin requests.
- **Quiz_Pack**: A logical quiz product whose metadata is a `Products` row with `type=quiz` and whose questions are `Quizzes` rows sharing the same `quiz_id`.
- **Question**: A single `Quizzes` row belonging to a Quiz_Pack, containing question text, 2–4 options, the correct option, and an explanation.
- **Material**: A non-quiz product (a `Products` row with `type=material`) representing a review-notes item for sale.
- **Access_Code**: A row in the `AccessCodes` tab that gates quiz access, with a scope, expiry, max uses, usage count, status, and notes.
- **Site_Setting**: A key/value row in the `Settings` tab controlling public-site presentation (brand name, contact email, announcement banner, hero copy).
- **Admin_Endpoint**: Any Apps_Script_Backend endpoint that performs admin actions and requires a valid Session_Token (all admin endpoints except `adminLogin`).
- **Public_Endpoint**: An existing Apps_Script_Backend endpoint used by the Public_Site (`getSettings`, `getProducts`, `getQuizList`, `getQuiz`, `validateCode`, `gradeQuiz`).
- **Lockout_Window**: A time period during which login attempts for a username are rejected after exceeding the failed-attempt threshold.

## Requirements

### Requirement 1: One-Time Admin Credential Setup

**User Story:** As the site owner, I want to set my admin username and password once during setup, so that my password is never stored in client code, the Sheet, or the front-end.

#### Acceptance Criteria

1. THE Apps_Script_Backend SHALL provide a setup helper `setupAdminCredential(username, plaintextPassword)` that is runnable once from the Apps Script editor.
2. WHEN `setupAdminCredential(username, plaintextPassword)` is run, THE Apps_Script_Backend SHALL generate a cryptographically random salt.
3. WHEN `setupAdminCredential(username, plaintextPassword)` is run, THE Apps_Script_Backend SHALL compute the hash as SHA-256 of the concatenation of salt and plaintext password using `Utilities.computeDigest`.
4. WHEN `setupAdminCredential(username, plaintextPassword)` is run, THE Apps_Script_Backend SHALL store the record `{username, salt, hash}` in Script_Properties.
5. THE Apps_Script_Backend SHALL store no admin password in plaintext in Script_Properties, the Mission_Control_Sheet, or any front-end file.
6. WHERE the owner re-runs `setupAdminCredential` with a new password, THE Apps_Script_Backend SHALL overwrite the stored Admin_Credential with the newly computed salt and hash.

### Requirement 2: Admin Login

**User Story:** As an Admin_User, I want to log in with my username and password, so that I receive a session token to access admin functions securely.

#### Acceptance Criteria

1. WHEN `adminLogin` is called with a username and password that match the stored Admin_Credential, THE Apps_Script_Backend SHALL generate a Session_Token of at least 32 bytes from a cryptographically random source.
2. WHEN `adminLogin` succeeds, THE Apps_Script_Backend SHALL set the Session_Token expiry to 8 hours from the time of issue by default.
3. WHEN `adminLogin` succeeds, THE Apps_Script_Backend SHALL store the Session_Token and its expiry server-side in Script_Properties or the hidden `_Sessions` tab.
4. WHEN `adminLogin` succeeds, THE Apps_Script_Backend SHALL return `{ok:true, token, expires}`.
5. IF `adminLogin` is called with a username or password that does not match the stored Admin_Credential, THEN THE Apps_Script_Backend SHALL return `{ok:false, error}` with a generic error message that does not indicate which field was incorrect.
6. WHEN `adminLogin` is verifying a password, THE Apps_Script_Backend SHALL compute SHA-256 of the concatenation of the stored salt and the supplied password and compare the result to the stored hash.

### Requirement 3: Brute-Force Protection

**User Story:** As the site owner, I want repeated failed login attempts to be throttled, so that my account is protected against password-guessing attacks.

#### Acceptance Criteria

1. WHEN an `adminLogin` attempt for a username fails, THE Apps_Script_Backend SHALL record the failed-attempt count and the last-attempt timestamp for that username in Script_Properties.
2. IF the number of consecutive failed `adminLogin` attempts for a username reaches 5, THEN THE Apps_Script_Backend SHALL reject further login attempts for that username for a Lockout_Window of 15 minutes.
3. WHILE a username is within an active Lockout_Window, THE Apps_Script_Backend SHALL return `{ok:false, error}` with a message stating that the account is temporarily locked and the time to retry.
4. WHEN an `adminLogin` attempt for a username succeeds, THE Apps_Script_Backend SHALL reset the failed-attempt count for that username to zero.

### Requirement 4: Session Token Validation on Admin Endpoints

**User Story:** As the site owner, I want every admin endpoint to verify a valid session token on every request, so that the only protection for the publicly accessible backend is enforced server-side.

#### Acceptance Criteria

1. WHEN any Admin_Endpoint is called, THE Apps_Script_Backend SHALL verify that the supplied Session_Token exists in server-side storage and has not expired before performing the requested action.
2. IF an Admin_Endpoint is called with a missing, unknown, or expired Session_Token, THEN THE Apps_Script_Backend SHALL return `{ok:false, error:"session_expired"}` and SHALL NOT perform the requested action.
3. WHEN the Admin_Portal receives a response with `error:"session_expired"` from any Admin_Endpoint, THE Admin_Portal SHALL clear the stored Session_Token and return to the login screen with a friendly notice.
4. THE Apps_Script_Backend SHALL require a valid Session_Token for every Admin_Endpoint except `adminLogin`.

### Requirement 5: Admin Logout

**User Story:** As an Admin_User, I want to log out, so that my session token can no longer be used.

#### Acceptance Criteria

1. WHEN `adminLogout` is called with a Session_Token, THE Apps_Script_Backend SHALL invalidate that Session_Token in server-side storage and return `{ok:true}`.
2. WHEN the Admin_User logs out, THE Admin_Portal SHALL clear the Session_Token from sessionStorage and return to the login screen.
3. WHEN an Admin_Endpoint is called with a Session_Token that has been invalidated by `adminLogout`, THE Apps_Script_Backend SHALL return `{ok:false, error:"session_expired"}`.

### Requirement 6: Secure Transport for Admin Requests

**User Story:** As the site owner, I want passwords and tokens kept out of URLs and query strings, so that credentials are not exposed in logs or browser history.

#### Acceptance Criteria

1. WHEN the Admin_Portal calls any Admin_Endpoint or `adminLogin`, THE Admin_Portal SHALL send the request as an HTTP POST with `Content-Type: text/plain` and a JSON string body.
2. THE Admin_Portal SHALL NOT place a password or Session_Token in a GET query string or URL parameter.
3. THE Admin_Portal SHALL transmit all admin requests over HTTPS.

### Requirement 7: Output Safety in the Admin UI

**User Story:** As the site owner, I want dynamic content rendered safely, so that data from the Sheet cannot inject markup or scripts into the admin interface.

#### Acceptance Criteria

1. WHEN the Admin_Portal renders dynamic data retrieved from the Apps_Script_Backend, THE Admin_Portal SHALL set element content using `textContent`.
2. THE Admin_Portal SHALL NOT assign dynamic data to `innerHTML`.

### Requirement 8: Products Tab Data Model Extensions

**User Story:** As the site owner, I want quiz packs to carry a per-pack timer, and I want publish visibility controlled by the existing `active` field, so that the data model stays consistent with the current Products tab and the existing ADMIN_GUIDE.

#### Acceptance Criteria

1. THE Mission_Control_Sheet `Products` tab SHALL include a `timer_minutes` column representing a per-pack countdown in minutes for quiz-type products, where 0 or blank means no timer.
2. THE Apps_Script_Backend SHALL use the existing `active` column (`TRUE`/`FALSE`) as the single authoritative publish control, and SHALL NOT introduce a separate `status` column.
3. WHEN the Public_Endpoints `getQuizList` and `getQuiz` return quiz data, THE Apps_Script_Backend SHALL include the `timer_minutes` value for the quiz pack.
4. THE Apps_Script_Backend SHALL return only products with `active` equal to `TRUE` from the Public_Endpoints that list products and quizzes.
5. WHERE the Admin_Portal presents publish visibility, THE Admin_Portal SHALL render the `active` field as a "Draft / Published" toggle, mapping Published to `active=TRUE` and Draft to `active=FALSE`.

### Requirement 9: Quiz Pack Two-Tab Consistency

**User Story:** As the site owner, I want a quiz pack's metadata and questions kept consistent across the two tabs, so that the Sheet never desyncs.

#### Acceptance Criteria

1. THE Apps_Script_Backend SHALL represent a Quiz_Pack as one `Products` row with `type=quiz` holding `title`, `subject`, `price_php`, `hitpay_link`, `timer_minutes`, and `active`, plus zero or more `Quizzes` rows sharing the same `quiz_id`.
2. WHEN a Quiz_Pack is created, THE Apps_Script_Backend SHALL create the `Products` row and use a single `quiz_id` value that is identical across the `Products` row and all associated `Quizzes` rows.
3. WHEN the Apps_Script_Backend writes any `Products`, `Quizzes`, `AccessCodes`, or `Settings` row, THE Apps_Script_Backend SHALL write the row using the exact existing column schema for that tab.

### Requirement 10: Hidden Sessions Tab (Optional Storage)

**User Story:** As the site owner, I want session storage that is never exposed to the public, so that tokens cannot leak through public endpoints.

#### Acceptance Criteria

1. WHERE sessions are stored in a Sheet tab rather than Script_Properties, THE Apps_Script_Backend SHALL store them in a hidden tab named `_Sessions` with a leading underscore.
2. THE Apps_Script_Backend SHALL NOT return the contents of the `_Sessions` tab from any Public_Endpoint.

### Requirement 11: Manage Quiz Packs

**User Story:** As an Admin_User, I want to create, list, edit, and delete quiz packs through forms, so that I manage quiz products without editing the Sheet directly.

#### Acceptance Criteria

1. WHEN `adminListQuizPacks` is called with a valid Session_Token, THE Apps_Script_Backend SHALL return the list of packs, each with `quiz_id`, `title`, `subject`, `price_php`, `hitpay_link`, `timer_minutes`, `active`, and `question_count`.
2. WHEN `adminCreateQuizPack` is called with a valid Session_Token and the fields `title`, `subject`, `price_php`, `hitpay_link`, `timer_minutes`, and `active`, THE Apps_Script_Backend SHALL create a `Products` row, auto-generate a unique `quiz_id`, and return the generated `quiz_id`.
3. WHEN `adminUpdateQuizPack` is called with a valid Session_Token and a `quiz_id` plus updated fields, THE Apps_Script_Backend SHALL update the matching `Products` row.
4. WHEN `adminDeleteQuizPack` is called with a valid Session_Token and a `quiz_id`, THE Apps_Script_Backend SHALL delete the matching `Products` row and all `Quizzes` rows sharing that `quiz_id`.
5. WHEN the Admin_User initiates deletion of a Quiz_Pack, THE Admin_Portal SHALL require the Admin_User to confirm the action before calling `adminDeleteQuizPack`.
6. IF `adminCreateQuizPack` or `adminUpdateQuizPack` is called with a non-numeric `price_php` or `timer_minutes`, or a missing required field, THEN THE Apps_Script_Backend SHALL return `{ok:false, error}` describing the invalid input and SHALL NOT write the row.

### Requirement 12: Manage Questions (Admin-Only, Including Answers)

**User Story:** As an Admin_User, I want to add, edit, reorder, and delete questions within a pack, including correct answers and explanations, so that I maintain quiz content through forms.

#### Acceptance Criteria

1. WHEN `adminListQuestions` is called with a valid Session_Token and a `quiz_id`, THE Apps_Script_Backend SHALL return the full questions for that pack including `correct_option` and `explanation`.
2. WHEN `adminAddQuestion` is called with a valid Session_Token, a `quiz_id`, `question_text`, `options` (2 to 4), `correct_index`, and `explanation`, THE Apps_Script_Backend SHALL append a `Quizzes` row with the next sequential `question_number`.
3. WHEN `adminUpdateQuestion` is called with a valid Session_Token, a `quiz_id`, a `question_number`, and updated fields, THE Apps_Script_Backend SHALL update the matching `Quizzes` row.
4. WHEN `adminDeleteQuestion` is called with a valid Session_Token, a `quiz_id`, and a `question_number`, THE Apps_Script_Backend SHALL delete the matching `Quizzes` row and renumber the remaining questions sequentially.
5. WHERE `adminReorderQuestions` is called with a valid Session_Token, a `quiz_id`, and an ordered list of question numbers, THE Apps_Script_Backend SHALL reassign `question_number` values to match the supplied order.
6. IF `adminAddQuestion` or `adminUpdateQuestion` is called with fewer than 2 non-empty options, or without exactly one correct option selected, or with empty `question_text`, THEN THE Apps_Script_Backend SHALL return `{ok:false, error}` describing the validation failure and SHALL NOT write the row.

### Requirement 13: Manage Materials

**User Story:** As an Admin_User, I want to create, list, edit, and delete materials through forms, so that I manage review-notes products without editing the Sheet directly.

#### Acceptance Criteria

1. WHEN `adminListMaterials` is called with a valid Session_Token, THE Apps_Script_Backend SHALL return all materials with the fields `subject`, `title`, `description`, `price_php`, `hitpay_link`, `active`, `sort_order`, and `drive_note`.
2. WHEN `adminCreateMaterial` is called with a valid Session_Token and material fields, THE Apps_Script_Backend SHALL create a `Products` row with `type=material` and auto-generate a unique `product_id`.
3. WHEN `adminUpdateMaterial` is called with a valid Session_Token and a `product_id` plus updated fields, THE Apps_Script_Backend SHALL update the matching `Products` row.
4. WHEN `adminDeleteMaterial` is called with a valid Session_Token and a `product_id`, THE Apps_Script_Backend SHALL delete the matching `Products` row.
5. WHEN the Admin_User initiates deletion of a Material, THE Admin_Portal SHALL require the Admin_User to confirm the action before calling `adminDeleteMaterial`.
6. IF `adminCreateMaterial` or `adminUpdateMaterial` is called with a non-numeric `price_php` or a missing required field, THEN THE Apps_Script_Backend SHALL return `{ok:false, error}` describing the invalid input and SHALL NOT write the row.

### Requirement 14: Manage Access Codes

**User Story:** As an Admin_User, I want to generate, edit, disable, and delete access codes through forms, so that I control quiz access without editing the Sheet directly.

#### Acceptance Criteria

1. WHEN `adminListCodes` is called with a valid Session_Token, THE Apps_Script_Backend SHALL return all access codes with `code`, `scope`, `expiry_date`, `max_uses`, `uses_count`, `status`, and `notes`.
2. WHEN `adminCreateCode` is called with a valid Session_Token and the fields `scope`, `expiry_date`, `max_uses`, and `notes`, THE Apps_Script_Backend SHALL auto-generate a human-readable unique code and return the generated code.
3. THE Apps_Script_Backend SHALL accept a `scope` value that is a specific `quiz_id`, a subject group, or `all`.
4. WHEN `adminUpdateCode` is called with a valid Session_Token, a `code`, and updated fields, THE Apps_Script_Backend SHALL update the matching `AccessCodes` row.
5. WHEN `adminDeleteCode` is called with a valid Session_Token and a `code`, THE Apps_Script_Backend SHALL delete the matching `AccessCodes` row.
6. WHEN `adminCreateCode` returns a generated code, THE Admin_Portal SHALL display the code with a Copy button and a ready-to-send delivery email snippet.
7. WHEN the Admin_User initiates deletion of an Access_Code, THE Admin_Portal SHALL require the Admin_User to confirm the action before calling `adminDeleteCode`.

### Requirement 15: Manage Site Settings

**User Story:** As an Admin_User, I want to edit site settings through forms, so that brand name, contact email, announcement banner, and hero copy update without editing the Sheet directly.

#### Acceptance Criteria

1. WHEN `adminGetSettings` is called with a valid Session_Token, THE Apps_Script_Backend SHALL return the full set of `Settings` key/value pairs.
2. WHEN `adminUpdateSettings` is called with a valid Session_Token, a `key`, and a `value`, THE Apps_Script_Backend SHALL upsert the matching `Settings` row.
3. THE Admin_Portal SHALL provide editable fields for brand name, contact email, announcement banner, and hero copy.

### Requirement 16: Server-Side Input Validation and ID Uniqueness

**User Story:** As the site owner, I want every admin write validated and every generated identifier unique, so that the Sheet stays well-formed and consistent.

#### Acceptance Criteria

1. WHEN any Admin_Endpoint receives input, THE Apps_Script_Backend SHALL validate and sanitize each input field before writing to the Mission_Control_Sheet.
2. WHEN the Apps_Script_Backend auto-generates a `quiz_id`, `product_id`, or Access_Code, THE Apps_Script_Backend SHALL guarantee the generated value is unique among existing values in the relevant tab.
3. WHEN any Admin_Endpoint returns a response, THE Apps_Script_Backend SHALL return valid JSON.

### Requirement 17: Preserve Public Answer-Key Confidentiality

**User Story:** As the site owner, I want correct answers to remain server-side for public users, so that the platform's core security guarantee is preserved after adding admin endpoints.

#### Acceptance Criteria

1. WHEN the Public_Endpoint `getQuiz` returns quiz questions, THE Apps_Script_Backend SHALL omit `correct_option` and `explanation` from the response.
2. THE Apps_Script_Backend SHALL return `correct_option` and `explanation` only from the token-authenticated `adminListQuestions` endpoint and the `gradeQuiz` endpoint.
3. THE Apps_Script_Backend SHALL NOT modify existing Public_Endpoints except to include `timer_minutes` where applicable.

### Requirement 18: Admin Portal Login Screen and Session UI

**User Story:** As an Admin_User, I want a clear login screen and session feedback, so that I always know my authentication state.

#### Acceptance Criteria

1. THE Admin_Portal SHALL present a login screen with username and password fields, a Login button, inline error messages, and a loading state.
2. WHEN login succeeds, THE Admin_Portal SHALL display the dashboard.
3. WHILE the Admin_User is logged in, THE Admin_Portal SHALL display the brand name, an "Admin" label, the logged-in username, the time remaining until session expiry, and a Logout control.
4. WHEN the Session_Token expiry time is reached, THE Admin_Portal SHALL log the Admin_User out and display a friendly message.
5. THE Admin_Portal SHALL store the Session_Token in sessionStorage and clear it on logout and on `session_expired`.

### Requirement 19: Admin Portal Dashboard Structure and UX

**User Story:** As an Admin_User, I want an organized, mobile-friendly dashboard with safe and clear interactions, so that I can manage content confidently from any device.

#### Acceptance Criteria

1. THE Admin_Portal SHALL provide a sectioned or tabbed layout with sections for Quiz Packs, Materials, Access Codes, and Settings.
2. THE Admin_Portal SHALL reuse the existing `css/styles.css` with a slate-blue secondary accent that visually distinguishes the admin context.
3. THE Admin_Portal SHALL render usable on mobile-sized viewports.
4. WHEN the Admin_User triggers a destructive action, THE Admin_Portal SHALL present a confirmation dialog before proceeding.
5. WHEN an async action is in progress, THE Admin_Portal SHALL display a loading state for that action.
6. WHEN an async action completes, THE Admin_Portal SHALL display a success or error toast indicating the outcome.
7. WHEN the Admin_User submits a form with invalid input, THE Admin_Portal SHALL display inline validation messages and SHALL NOT submit the request.
8. WHERE a managed list is empty, THE Admin_Portal SHALL display a friendly empty-state message.

### Requirement 20: Quiz Pack and Question Editing UX

**User Story:** As an Admin_User, I want guided forms for packs and questions, so that I enter correct data without knowing the Sheet structure.

#### Acceptance Criteria

1. THE Admin_Portal SHALL present the Quiz Packs list showing title, subject, price, timer, publish state (Draft/Published), and question count, with actions for New Pack, Edit, Delete, and Manage Questions.
2. THE Admin_Portal New/Edit Pack form SHALL provide a title field, a subject dropdown of existing subjects with an add-new option, a timer-minutes field where 0 means no timer, a price field in PHP, a HitPay link field, and a Draft/Published toggle that maps to the `active` field (Published = `active=TRUE`, Draft = `active=FALSE`).
3. THE Admin_Portal Add/Edit Question form SHALL provide a question-text field, 2 to 4 option rows with add and remove controls, a radio control beside each option to mark the single correct answer, and an explanation textarea.
4. WHEN the Admin_User attempts to publish a Quiz_Pack that has 0 questions, THE Admin_Portal SHALL display a warning before proceeding.
5. THE Admin_Portal Manage Questions view SHALL list questions with edit, delete, and up/down reorder controls.

### Requirement 21: Live Reflection on the Public Site

**User Story:** As the site owner, I want my admin changes to appear on the live public site without a redeploy, so that I can manage content in real time.

#### Acceptance Criteria

1. WHEN an Admin_Endpoint writes a change to the Mission_Control_Sheet, THE Public_Site SHALL reflect that change on its next load of the affected data without any redeploy.
2. WHEN the Admin_User saves a change, THE Admin_Portal SHALL indicate that the change is live.
3. WHERE the Public_Site reads cached data, THE Public_Site SHALL use a cache-busting mechanism so that saved admin changes are not served stale.

### Requirement 22: Documentation Updates

**User Story:** As the site owner, I want the project documentation updated, so that I can set up, operate, and understand the scope of the admin portal.

#### Acceptance Criteria

1. THE `SETUP.md` document SHALL describe setting the admin credential once via `setupAdminCredential`, changing it later by re-running the helper, the new `timer_minutes` `Products` column, and redeploying the Apps Script as a new version after adding endpoints.
2. THE `ADMIN_GUIDE.md` document SHALL provide a walkthrough covering login, creating a quiz pack, adding questions and marking the correct answer, publishing, adding a material, generating and sending an access code, and editing settings, and SHALL note that changes go live automatically.
3. THE `README.md` document SHALL record that student login is a deliberate phase-2 item and the rationale for deferring it.

### Requirement 23: Scope Boundaries

**User Story:** As the site owner, I want the build limited to the admin portal and admin login, so that no out-of-scope features are added.

#### Acceptance Criteria

1. THE Admin_Portal SHALL NOT implement student accounts, student login, or student password storage.
2. THE feature SHALL NOT implement payment-API integration, automated material delivery, or paid third-party services.
3. THE students SHALL continue to use the existing access-code flow to unlock quizzes.
