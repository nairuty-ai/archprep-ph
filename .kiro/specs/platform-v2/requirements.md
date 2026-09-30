# Requirements Document

## Introduction

This feature is the **v2 re-architecture** of the ArchPrep PH learning platform, specified in full by `platform_v2_supabase_spec.md` (the authoritative source). The backend moves from Google Apps Script + Google Sheets to **Supabase**: Auth (passwordless email OTP), Postgres with Row-Level Security, a private Storage bucket, and Edge Functions. Access moves from emailed access codes to **account-linked enrollments** (login-first, Udemy-style). Payments move from manually-confirmed HitPay payment links to the **HitPay API with HMAC-verified webhooks**, so GCash / QR Ph payments unlock purchases automatically. A **database-backed referral program** is auto-attributed on confirmed payment.

Carried over from v1: the static front-end pages, the design system (`css/styles.css`), the palette (terracotta / slate / off-white), the fonts (Fraunces + Manrope), the content (products, quizzes, questions, material files), and the admin portal's form UX. The repository remains a static vanilla-JS site deployed on Cloudflare Pages with no build step. The `apps-script/` directory is **retired** and is not edited by this feature.

The security posture is the centrepiece of this document and is stated as individually-testable requirements: default-deny RLS on every table, an answer-key guarantee (no client role can read `questions.correct_key` even with a valid session), service-role-only writes to every money and access table, database-level webhook idempotency, a paid-amount cross-check before granting access, and refund handling that revokes both the enrollment and the referral.

Out of scope: passwords of any kind, storing card data, automated cash disbursement of referral payouts (recorded in the ledger, paid manually over GCash), and any paid service beyond an optional future Supabase Pro upgrade.

> **Note on requirements analysis (2026-09-22):** The automated requirements-analysis check could not be run against this document. It was attempted three times: twice it failed with an internal tool service error, and on the third attempt the tool was not available in the session at all. This document was therefore reviewed manually instead, against EARS pattern compliance, single-system-per-criterion phrasing, removal of unquantified terms, and presence of an explicit acceptance test on every money, RLS, answer-key, idempotency, and refund requirement. The money requirements (11, 14, 15, 16, 17, 23) and the answer-key requirement (6) warrant a careful human read before implementation begins, since they did not receive the automated pass. This note should be removed once the automated check has run clean.

## Glossary

- **Platform**: The complete ArchPrep PH v2 system — the static Front_End plus the Supabase project (Auth, Database, Storage, Edge Functions).
- **Front_End**: The static vanilla-JS site (HTML + `css/styles.css` + `js/*.js`) hosted on Cloudflare Pages with no build step.
- **Supabase_Auth**: The Supabase Auth service, configured for passwordless email OTP, which issues JWT sessions.
- **Database**: The Supabase Postgres database holding the tables `profiles`, `products`, `pack_quizzes`, `quizzes`, `questions`, `orders`, `enrollments`, `quiz_attempts`, `referrals`, and `settings`.
- **RLS**: Postgres Row-Level Security, enabled on every table in the Database.
- **Anon_Role**: The Supabase `anon` Postgres role used by the Front_End for requests without a session.
- **Authenticated_Role**: The Supabase `authenticated` Postgres role used by the Front_End for requests carrying a valid user JWT.
- **Service_Role**: The Supabase service role, which bypasses RLS and is used only inside Edge Functions.
- **Client_Role**: Either the Anon_Role or the Authenticated_Role — that is, any role reachable from a browser.
- **Session_JWT**: The Supabase-issued JSON Web Token representing a logged-in user, persisted and refreshed by `supabase-js`.
- **Verified_UID**: The user id extracted by an Edge Function from a validated Session_JWT.
- **Edge_Function**: A Supabase Edge Function. The set is `create-payment`, `hitpay-webhook`, `get-quiz`, `grade-quiz`, `issue-material-url`, and the `admin-*` functions.
- **Create_Payment_Function**: The `create-payment` Edge_Function, which creates an Order and returns a HitPay checkout URL.
- **Webhook_Function**: The `hitpay-webhook` Edge_Function, the public endpoint that HitPay calls to report payment outcomes.
- **Get_Quiz_Function**: The `get-quiz` Edge_Function, which returns quiz questions with answer fields removed.
- **Grade_Quiz_Function**: The `grade-quiz` Edge_Function, which grades a submission server-side and records a Quiz_Attempt.
- **Issue_Material_URL_Function**: The `issue-material-url` Edge_Function, which returns a short-lived signed URL for a material file.
- **Admin_Function**: Any Edge_Function whose name begins with `admin-`, performing a privileged write after confirming the caller is an Admin_User.
- **Materials_Bucket**: The private Supabase Storage bucket holding material files (PDF / PowerPoint).
- **Signed_URL**: A time-limited Supabase Storage URL granting read access to one object in the Materials_Bucket.
- **Product**: A row in `products` — a sellable catalog item of `type` `material` or `quiz_pack`.
- **Published_Product**: A Product whose `published` column is `true`.
- **Quiz**: A row in `quizzes`, holding quiz metadata including `timer_minutes`.
- **Question**: A row in `questions`, holding `question_text`, `options`, `correct_key`, and `explanation`.
- **Answer_Fields**: The `questions.correct_key` and `questions.explanation` columns.
- **Order**: A row in `orders`, recording one purchase attempt with `amount_php`, `status`, and `hitpay_payment_id`.
- **Enrollment**: A row in `enrollments`, granting one user permanent access to one Product.
- **Quiz_Attempt**: A row in `quiz_attempts`, recording one graded quiz submission.
- **Referral_Row**: A row in `referrals`, the ledger entry attributing one paid Order to one referrer.
- **Ref_Code**: The unique referral code stored on a `profiles` row and shared in a referral link.
- **Setting**: A key/value row in `settings` holding admin-editable configuration.
- **Display_Safe_Keys**: The explicit allowlist of `settings` keys readable by Client_Roles (brand, contact, hero copy, announcement banner, and the display copies of referral configuration).
- **Answer_Reveal_Mode**: The `answer_reveal_mode` Setting, which governs how much of the Answer_Fields the Grade_Quiz_Function returns after a submission is graded, accepting the value `answered_only` (the seeded default) or the value `full_reveal`, read through the Service_Role only and excluded from Display_Safe_Keys.
- **Admin_User**: A user whose `profiles.is_admin` column is `true`.
- **Owner_Emails**: The two email addresses `rehinaneel@gmail.com` and `nairutya.84@gmail.com`.
- **Admin_Portal**: The authenticated admin front-end (`admin.html` + `js/admin.js`), restyled to call Supabase and Admin_Functions.
- **HitPay_API**: The HitPay REST API used to create payment requests for GCash and QR Ph.
- **Webhook_Salt**: The HitPay-issued secret used to compute and verify the HMAC-SHA256 signature on webhook calls.
- **Migration_Set**: The ordered SQL migration files that create the schema, RLS policies, indexes, triggers, and seed data.
- **Seed_Import**: The one-time import of existing v1 products, quizzes, questions, and material files into the Database and Materials_Bucket.
- **Docs**: The repository documents `SETUP.md`, `ADMIN_GUIDE.md`, and `README.md`.

## Requirements

### Requirement 1: Passwordless Email OTP Authentication

**User Story:** As a student, I want to sign in with a code sent to my email, so that I gain access to my purchases without creating or remembering a password.

#### Acceptance Criteria

1. THE Supabase_Auth SHALL be configured with email one-time-password sign-in enabled and email-and-password sign-in disabled.
2. WHILE fewer than 5 one-time code requests have been recorded for an email address in the preceding 60 minutes, WHEN a visitor submits that email address on the login view, THE Supabase_Auth SHALL send to that email address a one-time code consisting of exactly 6 decimal digits, and SHALL set that code to expire 600 seconds after issuance.
3. WHEN a visitor submits a one-time code that matches the most recently issued unexpired code for that email address within 600 seconds of its issuance, THE Supabase_Auth SHALL create a Session_JWT for that email address.
4. WHEN a visitor submits a matching unexpired one-time code for an email address that has no prior account, THE Supabase_Auth SHALL create exactly one account for that email address and SHALL issue a Session_JWT through the same code-entry flow used for returning visitors, requesting zero additional input fields from the visitor.
5. IF a visitor submits a one-time code that does not match the most recently issued code for that email address, or submits a code more than 600 seconds after its issuance, THEN THE Front_End SHALL display an error message indicating the code is invalid or expired, SHALL keep the visitor on the code-entry view with the submitted email address retained, and SHALL create zero Session_JWTs.
6. THE Platform SHALL store zero password values and zero password hashes in the Database, in the Front_End, and in the repository.
7. WHEN a visitor requests a one-time code for an email address, THE Front_End SHALL disable the resend control, SHALL display the whole number of seconds remaining until resend becomes available, and SHALL enable the resend control 60 seconds after that request.
8. WHEN a user selects Log out, THE Front_End SHALL discard the stored Session_JWT such that zero subsequent requests carry that Session_JWT, and SHALL display the public catalog view.
9. IF a visitor submits a value on the login view that does not match an email address format or that exceeds 254 characters, THEN THE Front_End SHALL display an error message indicating the email address is invalid, SHALL keep the visitor on the email-entry view with the submitted value retained, and SHALL request zero one-time codes from Supabase_Auth.
10. IF Supabase_Auth returns an error for a one-time code request, or returns no response within 30 seconds, THEN THE Front_End SHALL display an error message indicating the code could not be sent, SHALL keep the visitor on the email-entry view with the submitted email address retained, and SHALL re-enable the submit control.
11. IF a visitor submits 5 consecutive non-matching one-time codes for the same email address, THEN THE Platform SHALL invalidate the issued code, SHALL create zero Session_JWTs for any further submission of that code, and THE Front_End SHALL display a message indicating a new code must be requested.

### Requirement 2: Optional Google OAuth Toggle

**User Story:** As the site owner, I want Google sign-in available as a documented option, so that I can lower signup friction later without changing the login-required architecture.

#### Acceptance Criteria

1. WHERE Google OAuth credentials are present in the Supabase project configuration, THE Front_End SHALL display a "Continue with Google" control on the login view.
2. WHERE Google OAuth credentials are absent from the Supabase project configuration, THE Front_End SHALL display the email one-time-password flow as the only sign-in control and SHALL complete login successfully using that flow.
3. WHEN a visitor completes a Google OAuth sign-in, THE Supabase_Auth SHALL issue a Session_JWT equivalent in scope to a Session_JWT issued by the email one-time-password flow.
4. THE Docs SHALL describe enabling Google OAuth as an optional step and SHALL state that the Platform functions fully with the option disabled.

### Requirement 3: Automatic Profile Creation

**User Story:** As a student, I want my profile to exist the moment I first sign in, so that my referral code and account details are ready without any setup step.

#### Acceptance Criteria

1. WHEN a row is inserted into `auth.users`, THE Database SHALL insert one `profiles` row whose `id` equals the new `auth.users` id, by way of a database trigger.
2. WHEN the trigger inserts a `profiles` row, THE Database SHALL set `email` to the `auth.users` email value, `is_admin` to `false`, and `ref_code` to a value that is unique across the `profiles` table.
3. THE Database SHALL enforce uniqueness of `profiles.ref_code` with a unique constraint.
4. IF the generated Ref_Code collides with an existing `profiles.ref_code`, THEN THE Database SHALL generate a replacement Ref_Code and complete the insert.
5. WHEN a user opens Account settings, THE Front_End SHALL allow the user to update `display_name` and `gcash_number` on the user's own `profiles` row.

### Requirement 4: Server-Derived User Identity in Edge Functions

**User Story:** As the site owner, I want every privileged operation to identify the user from the verified token, so that a crafted request cannot act as another user.

#### Acceptance Criteria

1. WHEN the Create_Payment_Function, Get_Quiz_Function, Grade_Quiz_Function, Issue_Material_URL_Function, or an Admin_Function receives a request, THE receiving Edge_Function SHALL validate the supplied Session_JWT against the Supabase project by verifying the token signature, verifying that the issuing project is the Platform's Supabase project, and verifying the token expiry with zero seconds of additional tolerance, before reading any Database row, before writing any Database row, and before requesting any Materials_Bucket object.
2. WHEN the receiving Edge_Function has validated a Session_JWT, THE receiving Edge_Function SHALL set the Verified_UID to the user id claim carried by that validated token, and SHALL read that claim only from the token supplied as the request's authorization credential, ignoring any token value present in the request body or in a query parameter.
3. IF a request to the Create_Payment_Function, Get_Quiz_Function, Grade_Quiz_Function, Issue_Material_URL_Function, or an Admin_Function carries a Session_JWT that is absent, malformed, expired, carrying no user id claim, failing signature verification, or issued by a project other than the Platform's Supabase project, THEN THE receiving Edge_Function SHALL return HTTP 401 with an error response indicating authentication is required, SHALL read zero Database rows, SHALL write zero Database rows, SHALL request zero Materials_Bucket objects, and SHALL return zero Order, Enrollment, Quiz, Question, Quiz_Attempt, and Referral_Row data.
4. WHEN a request to the Create_Payment_Function, Get_Quiz_Function, Grade_Quiz_Function, Issue_Material_URL_Function, or an Admin_Function carries a request-body field, a query parameter, or a header value naming a user identity, a profile identity, or an email address, THE receiving Edge_Function SHALL ignore every such value and SHALL use the Verified_UID as the only user identity in every Database query and every Database write it performs.
5. WHEN a request carrying a valid Session_JWT references a resource whose owner user id differs from the Verified_UID, THE receiving Edge_Function SHALL resolve every query and every write against the Verified_UID only, SHALL return HTTP 403 with an error response indicating the referenced resource is not accessible, SHALL return zero fields of the other user's data, and SHALL write zero Database rows.
6. WHEN the receiving Edge_Function returns HTTP 401 or HTTP 403, THE receiving Edge_Function SHALL exclude Session_JWT values, token claim values, and any other user's identifiers from the response.
7. THE Platform SHALL include automated negative tests asserting that the Create_Payment_Function, the Get_Quiz_Function, the Grade_Quiz_Function, the Issue_Material_URL_Function, and an Admin_Function each return HTTP 401 for a request with no Session_JWT, for a request with a malformed Session_JWT, and for a request with an expired Session_JWT, each return HTTP 403 for a request whose body references another user's resource, and change zero `orders`, `enrollments`, `quiz_attempts`, and `referrals` rows in each of those four cases.

### Requirement 5: Default-Deny Row-Level Security Baseline

**User Story:** As the site owner, I want every table to deny access unless a policy explicitly allows it, so that a forgotten policy fails closed rather than leaking data.

#### Acceptance Criteria

1. THE Database SHALL have RLS enabled on `profiles`, `products`, `pack_quizzes`, `quizzes`, `questions`, `orders`, `enrollments`, `quiz_attempts`, `referrals`, and `settings`.
2. THE Migration_Set SHALL grant to Client_Roles only the policies enumerated in Requirements 6, 7, 8, and 9, and SHALL leave every other operation on every table without a Client_Role policy.
3. WHEN a Client_Role attempts an operation on a table for which no policy grants that operation to that role, THE Database SHALL return zero rows for a select and SHALL return a policy-violation error for an insert, update, or delete.
4. THE Platform SHALL include an automated test that enumerates the RLS policies present in the Database and asserts that the enumerated set equals the set declared by the Migration_Set.

### Requirement 6: Answer-Key Guarantee

**User Story:** As the site owner, I want quiz answer keys to be unreachable from any browser, so that a logged-in student with developer tools cannot extract the answers to a paid quiz.

#### Acceptance Criteria

1. THE Database SHALL have RLS enabled on `questions` with zero select policies defined for the Anon_Role, zero select policies defined for the Authenticated_Role, and zero database views and zero database routines that return the Answer_Fields to a Client_Role.
2. WHEN the Anon_Role issues a select against `questions` with any combination of requested columns, filters, ordering, or row limit, THE Database SHALL return zero rows.
3. WHILE a Session_JWT is valid and unexpired, WHEN the Authenticated_Role issues a select against `questions` with any combination of requested columns, filters, ordering, or row limit, THE Database SHALL return zero rows.
4. WHILE a Session_JWT of a user holding an Enrollment covering the quiz being queried is valid and unexpired, WHEN the Authenticated_Role issues a select against `questions`, THE Database SHALL return zero rows.
5. WHEN the Authenticated_Role issues a select that requests only the `correct_key` column, only the `explanation` column, an aggregate over either column, or that filters or orders by either column, THE Database SHALL return zero rows and SHALL report a count of zero for every such aggregate.
6. THE Platform SHALL read the Answer_Fields through the Service_Role inside the Get_Quiz_Function and the Grade_Quiz_Function only.
7. WHEN the Get_Quiz_Function returns a quiz payload, THE Get_Quiz_Function SHALL omit both Answer_Fields from every question object in the response, such that the response contains zero occurrences of the `correct_key` field, zero occurrences of the `explanation` field, and zero Answer_Fields values for every question of the Quiz.
8. THE Platform SHALL include automated negative tests asserting that a `supabase-js` client using the project anon key returns zero rows for `questions` in each of these six cases: without a session; with a valid session for a user holding no Enrollment; with a valid session for a user holding an Enrollment covering the quiz queried; requesting only the `correct_key` column; requesting only the `explanation` column; and reaching `questions` through an embedded resource on another table.
9. WHEN a Client_Role issues a select that reaches `questions` through a join, through an embedded resource on another table, through a database view, or through a database routine, THE Database SHALL return zero rows from `questions`.
10. WHERE the `answer_reveal_mode` Setting equals `answered_only`, WHEN the Grade_Quiz_Function returns a grading result for a submitted attempt, THE Grade_Quiz_Function SHALL include the `correct_key` value and the `explanation` value for each question that submitted attempt answered, and SHALL omit both the `correct_key` value and the `explanation` value for each question that submitted attempt left unanswered, so that a deliberately blank submission cannot harvest the answer key.
11. IF the Get_Quiz_Function cannot produce a quiz payload with both Answer_Fields removed, THEN THE Get_Quiz_Function SHALL return an error response indicating the quiz is unavailable and SHALL return zero question objects.
12. WHERE the `answer_reveal_mode` Setting equals `full_reveal`, WHEN the Grade_Quiz_Function returns a grading result for a submitted attempt, THE Grade_Quiz_Function SHALL include the `correct_key` value and the `explanation` value for every question of that attempt, whether that submitted attempt answered the question or left it unanswered.
13. THE Platform SHALL read the `answer_reveal_mode` Setting through the Service_Role inside the Grade_Quiz_Function only, and THE `answer_reveal_mode` Setting key SHALL be excluded from Display_Safe_Keys.
14. THE Platform SHALL include an automated test asserting that a graded submission answering zero questions of a quiz returns zero `correct_key` values and zero `explanation` values.

### Requirement 7: Owner-Scoped Reads

**User Story:** As a student, I want my profile, purchases, and results visible to me alone, so that other users of the platform cannot see my data.

#### Acceptance Criteria

1. THE Database SHALL define a select policy on `profiles` for the Authenticated_Role permitting rows where `id = auth.uid()`.
2. THE Database SHALL define a select policy on `orders`, `enrollments`, `quiz_attempts`, and `referrals` for the Authenticated_Role permitting rows where `user_id = auth.uid()`, using `referrer_user_id = auth.uid()` for `referrals`.
3. WHEN user A selects from `profiles`, `orders`, `enrollments`, `quiz_attempts`, or `referrals` while carrying a valid Session_JWT, THE Database SHALL return only rows belonging to user A.
4. WHEN user A selects from `profiles` filtered to user B's id, THE Database SHALL return zero rows.
5. WHEN user A selects from `orders`, `enrollments`, `quiz_attempts`, or `referrals` filtered to user B's id, THE Database SHALL return zero rows.
6. WHEN the Anon_Role selects from `profiles`, `orders`, `enrollments`, `quiz_attempts`, or `referrals`, THE Database SHALL return zero rows.
7. WHEN the Front_End returns a Referral_Row to the referrer, THE Front_End SHALL display the buyer identity in masked form.
8. THE Platform SHALL include automated cross-tenant negative tests covering every pairing of user A reading user B's `profiles`, `orders`, `enrollments`, `quiz_attempts`, and `referrals` rows.

### Requirement 8: Service-Role-Only Writes to Money and Access Tables

**User Story:** As the site owner, I want the tables that control money and access to be writable only by server code, so that a user cannot grant themselves an enrollment or invent a referral reward.

#### Acceptance Criteria

1. THE `orders`, `enrollments`, and `referrals` tables SHALL have zero insert policies, zero update policies, and zero delete policies defined for the Anon_Role and for the Authenticated_Role.
2. WHEN a Client_Role attempts an insert into `orders`, `enrollments`, or `referrals`, THE Database SHALL reject the statement with a policy-violation error.
3. WHEN a Client_Role attempts an update or a delete on `orders`, `enrollments`, or `referrals`, THE Database SHALL reject the statement with a policy-violation error.
4. THE Platform SHALL write rows to `orders`, `enrollments`, and `referrals` through the Service_Role inside the Create_Payment_Function, the Webhook_Function, and Admin_Functions only.
5. THE `products`, `pack_quizzes`, `quizzes`, `questions`, and `settings` tables SHALL have zero insert, update, and delete policies defined for Client_Roles, and SHALL be written through Admin_Functions using the Service_Role.
6. THE Platform SHALL include an automated negative test asserting that a `supabase-js` client with a valid Session_JWT is rejected when inserting an `enrollments` row for the user's own id.

### Requirement 9: Protected Admin Flag and Public Catalog Reads

**User Story:** As the site owner, I want users to edit their own profile without being able to make themselves an admin, and I want the catalog readable by anyone, so that self-service editing and public browsing are both safe.

#### Acceptance Criteria

1. THE Database SHALL define an update policy on `profiles` for the Authenticated_Role permitting rows where `id = auth.uid()`.
2. WHEN user A updates user A's own `profiles` row with a payload that sets `is_admin` to `true`, THE Database SHALL reject the statement by way of a column-level guard and SHALL leave `is_admin` unchanged.
3. WHEN user A updates user A's own `profiles` row with a payload that changes `ref_code`, `referred_by`, or `email`, THE Database SHALL reject the statement and SHALL leave those columns unchanged.
4. THE Database SHALL define select policies on `products`, `quizzes`, and `pack_quizzes` for the Anon_Role and the Authenticated_Role permitting rows where `published = true`, using the parent product's `published` value for `pack_quizzes`.
5. WHEN any Client_Role selects from `products`, `quizzes`, or `pack_quizzes`, THE Database SHALL return only rows whose `published` value is `true`.
6. THE Database SHALL define a select policy on `settings` for Client_Roles permitting rows whose `key` is a member of Display_Safe_Keys.
7. WHEN any Client_Role selects from `settings` requesting a key outside Display_Safe_Keys, THE Database SHALL return zero rows.
8. THE `quizzes` table SHALL expose `id`, `slug`, `title`, `subject`, `timer_minutes`, and `published` to Client_Roles, and question content SHALL reside in the `questions` table only.
9. THE `answer_reveal_mode` Setting key SHALL be excluded from Display_Safe_Keys, and WHEN any Client_Role selects from `settings` requesting the `answer_reveal_mode` key, THE Database SHALL return zero rows.
10. THE Platform SHALL include an automated test asserting that a `supabase-js` client using the project anon key returns zero rows for a `settings` select requesting the `answer_reveal_mode` key, that an update by user A of user A's own `profiles` row setting `is_admin` to `true` is rejected with `is_admin` left unchanged, and that a Client_Role select from `products` returns zero rows whose `published` value is `false`.

### Requirement 10: Public Catalog Browsing Without Login

**User Story:** As a prospective buyer, I want to see everything on offer with prices before signing in, so that I can decide what to buy without committing to an account.

#### Acceptance Criteria

1. WHEN a visitor without a Session_JWT opens the home view or the catalog view, THE Front_End SHALL display every Published_Product as a course card showing thumbnail, title, subtitle, subject, price in PHP, and the contents listed in `products.includes`.
2. WHEN a visitor without a Session_JWT opens a product detail view for a Published_Product, THE Front_End SHALL display the product description, price, and contents.
3. THE Front_End SHALL order catalog cards by `products.sort_order` ascending.
4. WHEN a visitor with a Session_JWT opens the home view or the catalog view, THE Front_End SHALL display the same Published_Product set displayed to a visitor without a Session_JWT.
5. WHEN a visitor without a Session_JWT selects Buy or Enrol on a product card, THE Front_End SHALL route the visitor to the login view and SHALL record the selected `product_id` for resumption.
6. WHEN a visitor completes login after selecting Buy or Enrol, THE Front_End SHALL return the visitor to the checkout step for the recorded `product_id`.
7. WHEN a visitor without a Session_JWT selects a material or a quiz from any view, THE Front_End SHALL route the visitor to the login view instead of opening the material or the quiz.

### Requirement 11: Server-Side Order Creation and Price Derivation

**User Story:** As the site owner, I want the purchase amount computed on the server from the database, so that a modified request cannot buy a product for a lower price.

#### Acceptance Criteria

1. WHEN the Create_Payment_Function receives a request containing a `product_id`, THE Create_Payment_Function SHALL read `products.price_php` for that `product_id` using the Service_Role and SHALL use that value as the Order amount.
2. WHEN a request to the Create_Payment_Function contains an amount, a price, or a currency field, THE Create_Payment_Function SHALL ignore those fields.
3. IF the requested `product_id` is absent from `products` or has `published = false`, THEN THE Create_Payment_Function SHALL return HTTP 404 and SHALL create zero `orders` rows.
4. WHEN the Create_Payment_Function creates an Order, THE Create_Payment_Function SHALL set `user_id` to the Verified_UID, `amount_php` to the value read from `products.price_php`, `currency` to `PHP`, and `status` to `pending`.
5. WHERE the request carries a captured Ref_Code, THE Create_Payment_Function SHALL store that Ref_Code on the `orders` row.
6. IF the Verified_UID already holds an Enrollment for the requested `product_id`, THEN THE Create_Payment_Function SHALL return a response stating the user already owns the product and SHALL create zero `orders` rows.
7. THE Platform SHALL include an automated test asserting that a Create_Payment_Function request carrying an amount, a price, and a currency field lower than or different from the stored values produces exactly one `orders` row whose `amount_php` equals `products.price_php` for the requested `product_id` and whose `currency` equals `PHP`.

### Requirement 12: HitPay Payment Request and Checkout Redirect

**User Story:** As a buyer, I want to pay with GCash or QR Ph, so that I can complete the purchase with the payment method I already use.

#### Acceptance Criteria

1. WHEN the Create_Payment_Function has created an Order, THE Create_Payment_Function SHALL call the HitPay_API to create a payment request for the Order `amount_php` in PHP with GCash and QR Ph enabled.
2. WHEN the HitPay_API returns a created payment request, THE Create_Payment_Function SHALL store the returned payment identifier in `orders.hitpay_payment_id` and the returned reference in `orders.hitpay_reference`, and SHALL return the checkout URL to the Front_End.
3. WHEN the Front_End receives a checkout URL, THE Front_End SHALL navigate the browser to that URL.
4. IF the HitPay_API returns an error or does not respond within 15 seconds, THEN THE Create_Payment_Function SHALL set the Order `status` to `failed` and SHALL return an error response, and THE Front_End SHALL display a message inviting the buyer to retry.
5. WHEN the Create_Payment_Function creates a payment request, THE Create_Payment_Function SHALL set the HitPay redirect target to the Platform's enrolled-confirmation view.
6. WHEN a buyer returns to the enrolled-confirmation view, THE Front_End SHALL poll the buyer's own `orders` and `enrollments` rows every 2 seconds for up to 30 seconds until the Order `status` is `paid` and the Enrollment exists.
7. WHILE the enrolled-confirmation poll is running without a `paid` Order, THE Front_End SHALL display a payment-confirmation-pending state with a link to My Learning.

### Requirement 13: HitPay Credential Configuration and Sandbox-to-Live Path

**User Story:** As the site owner, I want to supply my HitPay keys at setup time, so that the platform is built and testable before my live credentials exist.

#### Acceptance Criteria

1. THE Platform SHALL read the HitPay API key, the Webhook_Salt, and the HitPay API base URL from Edge Function environment variables.
2. THE Platform SHALL contain zero HitPay API key values, zero Webhook_Salt values, and zero hardcoded HitPay base URL values in the repository.
3. THE Docs SHALL list each HitPay environment variable by name with a placeholder value and the dashboard location from which the owner obtains the value.
4. THE Platform SHALL construct HitPay requests against the endpoint paths documented in the official HitPay API documentation, resolved against the configured base URL.
5. IF a required HitPay environment variable is absent at invocation time, THEN THE Create_Payment_Function SHALL return an error response naming the absent variable and SHALL create zero HitPay requests.
6. THE Docs SHALL describe a sandbox verification sequence covering create-payment, webhook receipt, enrollment grant, and referral attribution, followed by the switch to live credentials.
7. THE Platform SHALL support switching between sandbox and live HitPay environments by changing environment variable values only, with zero code changes.

### Requirement 14: Webhook Signature Verification

**User Story:** As the site owner, I want unverified webhook calls ignored, so that a forged request cannot grant free access.

#### Acceptance Criteria

1. WHEN the Webhook_Function receives a request, THE Webhook_Function SHALL compute an HMAC-SHA256 signature over the received payload using the Webhook_Salt and SHALL compare the result with the signature supplied by HitPay before reading or writing any Database row.
2. IF the computed signature differs from the supplied signature, THEN THE Webhook_Function SHALL perform zero Database writes and SHALL return a response indicating the call was not accepted.
3. IF the request carries no signature value, THEN THE Webhook_Function SHALL perform zero Database writes and SHALL return a response indicating the call was not accepted.
4. WHEN the Webhook_Function compares signatures, THE Webhook_Function SHALL use a constant-time comparison.
5. WHEN the Webhook_Function rejects a call for a signature mismatch, THE Webhook_Function SHALL log the rejection with the reported payment identifier and SHALL exclude the Webhook_Salt from the log entry.
6. THE Platform SHALL include an automated negative test posting a well-formed completed-payment payload with an invalid signature and asserting that zero `orders`, `enrollments`, and `referrals` rows change.

### Requirement 15: Paid-Amount Cross-Check

**User Story:** As the site owner, I want access granted only when the amount actually paid matches the recorded order amount, so that an underpaid or tampered payment cannot unlock a product.

#### Acceptance Criteria

1. WHEN the Webhook_Function has verified the signature of a completed-payment call, THE Webhook_Function SHALL resolve the matching Order as the single `orders` row whose `hitpay_payment_id` equals the reported payment identifier, and SHALL compare the amount reported as paid against that Order's `amount_php` value as decimal values at 2-decimal-place precision, before creating any `enrollments` rows, before creating any `referrals` rows, and before changing the Order `status`.
2. WHEN the Webhook_Function compares amounts, THE Webhook_Function SHALL also compare the reported currency against the `orders.currency` value of the matching Order as three-letter codes, with leading and trailing spaces removed and letter case ignored.
3. IF the reported paid amount is absent, is not parseable as a decimal number, or differs from `orders.amount_php` by any non-zero amount at 2-decimal-place precision with zero tolerance, including any amount greater than `orders.amount_php`, THEN THE Webhook_Function SHALL create zero `enrollments` rows, SHALL create zero `referrals` rows, SHALL leave the Order `status` unchanged from `pending`, SHALL record the mismatch for admin review, and SHALL return HTTP 200.
4. IF the reported currency is absent or differs from `orders.currency`, THEN THE Webhook_Function SHALL create zero `enrollments` rows, SHALL create zero `referrals` rows, SHALL leave the Order `status` unchanged from `pending`, SHALL record the mismatch for admin review, and SHALL return HTTP 200.
5. THE `orders.amount_php` value compared by the Webhook_Function SHALL be the value written by the Create_Payment_Function from `products.price_php` at Order creation, and THE Webhook_Function SHALL derive zero part of that comparison value from the webhook payload.
6. WHEN an Admin_User opens the payment-mismatch review list, THE Admin_Portal SHALL display every Order carrying an unresolved mismatch record, ordered by mismatch record time descending, in pages of at most 50 Orders, showing for each Order the reported amount, the reported currency, the stored `amount_php`, the stored `currency`, the reported payment identifier, and the Order `status`.
7. IF the reported payment identifier of a verified completed-payment call matches zero `orders` rows, THEN THE Webhook_Function SHALL create zero `enrollments` rows, SHALL create zero `referrals` rows, SHALL change zero `orders` rows, SHALL record the unmatched call for admin review, and SHALL return HTTP 200.
8. WHEN the Webhook_Function records an amount mismatch, a currency mismatch, or an unmatched call, THE Webhook_Function SHALL store a mismatch record retaining the reported amount, the reported currency, the reported payment identifier, the stored `amount_php`, the stored `currency`, and the recording time, SHALL associate that record with the matching Order where one exists, and SHALL retain that record until an Admin_User marks it resolved.
9. WHEN the reported paid amount equals `orders.amount_php` at 2-decimal-place precision and the reported currency equals `orders.currency`, THE Webhook_Function SHALL record zero mismatch records for that Order and SHALL proceed to the transactional fulfilment sequence for that Order.
10. THE Platform SHALL include an automated test asserting that a verified completed-payment call reporting an amount differing from the matching Order's `amount_php` creates zero `enrollments` rows, creates zero `referrals` rows, leaves that Order `status` at `pending`, and records exactly one mismatch record for that Order.

### Requirement 16: Transactional Fulfilment with Database-Level Idempotency

**User Story:** As the site owner, I want a replayed webhook to change nothing, so that duplicate notifications cannot double-grant access or double-credit a referral.

#### Acceptance Criteria

1. THE Database SHALL define a unique index on `orders.hitpay_payment_id` covering every row whose `hitpay_payment_id` is not null, a unique constraint on `referrals.order_id`, and a unique constraint on `enrollments (user_id, product_id)`.
2. WHEN the Webhook_Function processes a verified completed-payment call whose reported amount equals `orders.amount_php` and whose reported currency equals `orders.currency`, THE Webhook_Function SHALL perform the Order status update to `paid` with `paid_at` set to the commit time of that transaction in UTC, the `enrollments` insert for the Order `user_id` and `product_id`, and the `referrals` insert required by Requirement 23 within a single database transaction, and SHALL return its response within 10 seconds of receiving the call.
3. IF any statement within that transaction fails for a reason other than a unique-constraint conflict, THEN THE Database SHALL roll back the whole transaction leaving the Order `status`, the `enrollments` row count, and the `referrals` row count at their pre-call values, and THE Webhook_Function SHALL return a non-2xx response so that HitPay retries.
4. IF a unique-constraint conflict occurs on `orders.hitpay_payment_id`, `enrollments (user_id, product_id)`, or `referrals.order_id`, THEN THE Webhook_Function SHALL treat the affected insert as already applied, SHALL leave every column of the existing row unchanged, SHALL commit the remaining statements of the same transaction, and SHALL return HTTP 200.
5. WHEN the Webhook_Function receives a second verified call reporting a `hitpay_payment_id` whose Order `status` is already `paid`, THE Webhook_Function SHALL leave the row counts of `orders`, `enrollments`, and `referrals` unchanged, SHALL leave the Order `paid_at` value and every column of the existing Enrollment and Referral_Row unchanged, and SHALL return HTTP 200.
6. WHEN the Webhook_Function receives 2 or more verified calls reporting the same `hitpay_payment_id` whose processing windows overlap, THE Database SHALL admit exactly one Enrollment row for the affected `(user_id, product_id)` pair and exactly one Referral_Row for the affected `order_id`, and THE Webhook_Function SHALL return HTTP 200 for every one of those calls that does not fail for a reason covered by criterion 3.
7. THE Platform SHALL include an automated replay test that posts the same verified completed-payment payload 5 times in sequence and a second automated test that posts the same payload 5 times within a 1-second window, each asserting exactly one `paid` Order with an unchanged `paid_at` value, exactly one Enrollment, and exactly one Referral_Row, with HTTP 200 returned for every call in the sequential test and zero duplicate `enrollments` or `referrals` rows in the overlapping test.
8. IF the verified call reports a failed or cancelled payment for an Order whose `status` is `pending`, THEN THE Webhook_Function SHALL set the Order `status` to `failed`, SHALL create zero `enrollments` rows, SHALL create zero `referrals` rows, and SHALL return HTTP 200.
9. IF the verified call reports a failed or cancelled payment for an Order whose `status` is already `paid` or `refunded`, THEN THE Webhook_Function SHALL leave the Order `status`, the Enrollment, and the Referral_Row for that Order unchanged, SHALL record the out-of-order outcome for admin review, and SHALL return HTTP 200.
10. IF a verified completed-payment call reports a `hitpay_payment_id` that matches zero `orders` rows, THEN THE Webhook_Function SHALL perform zero writes to `orders`, `enrollments`, and `referrals`, SHALL record the unmatched payment for admin review, and SHALL return HTTP 200.

### Requirement 17: Refund Handling Revokes Enrollment and Voids Referral

**User Story:** As the site owner, I want a refund to remove the access and cancel the referral reward, so that refunded purchases leave no unearned benefit behind.

#### Acceptance Criteria

1. WHEN the Webhook_Function processes a verified call reporting a refund for a `hitpay_payment_id` present in `orders`, THE Webhook_Function SHALL set that Order `status` to `refunded`, and SHALL apply that status change for any reported refunded amount, whether equal to or less than the Order `amount_php`.
2. WHEN the Webhook_Function processes a verified refund call matching an Order that has an Enrollment, THE Webhook_Function SHALL revoke that Enrollment within the same transaction as the Order status change, SHALL retain the Order row and the affected user's Quiz_Attempt rows, and SHALL leave every other Enrollment held by that user unchanged.
3. WHEN the Get_Quiz_Function, the Grade_Quiz_Function, or the Issue_Material_URL_Function receives a request from a user whose Enrollment for the requested Product has been revoked, THE receiving Edge_Function SHALL return HTTP 403, SHALL return zero question objects, zero correctness data, and zero Signed_URL values, for every request received after the revoking transaction commits.
4. WHEN the Webhook_Function processes a verified refund call matching an Order whose Referral_Row has `status = available`, THE Webhook_Function SHALL set that `referrals.status` to `void` within the same transaction as the Order status change.
5. IF the Referral_Row for the refunded Order has `status = paid`, THEN THE Webhook_Function SHALL set that `referrals.status` to `void`, SHALL record a note on that Referral_Row indicating the reward was already paid out, and SHALL leave the recorded payout timestamp unchanged.
6. WHILE a Referral_Row has `status = void`, THE Front_End SHALL exclude that Referral_Row `amount_php` from the referrer's available balance and from the referrer's paid balance, and SHALL list that Referral_Row with status `void` in the referrer's ledger.
7. WHEN the Webhook_Function receives a repeated verified refund call for a `hitpay_payment_id` whose Order `status` is already `refunded`, THE Webhook_Function SHALL leave the Order row, the `enrollments` row count for the affected user and Product, and the Referral_Row `status` and note unchanged, and SHALL return HTTP 200 for every such call, including calls received concurrently.
8. IF a verified refund call references a `hitpay_payment_id` absent from `orders`, THEN THE Webhook_Function SHALL record the unmatched refund for admin review, SHALL perform zero writes to `enrollments` and zero writes to `referrals`, and SHALL return HTTP 200.
9. THE Admin_Portal SHALL provide a revoke-enrollment action and a void-referral action, each requiring an explicit confirmation from an Admin_User and each applying the state changes specified in criteria 2 and 4 through an Admin_Function using the Service_Role, for cases where a refund is handled outside the webhook.
10. IF the Order matched by a verified refund call has no Enrollment, THEN THE Webhook_Function SHALL set that Order `status` to `refunded`, SHALL create zero `enrollments` rows, and SHALL return HTTP 200.
11. IF the Order matched by a verified refund call has no Referral_Row, THEN THE Webhook_Function SHALL complete the Order status change and the Enrollment revocation, SHALL create zero `referrals` rows, and SHALL return HTTP 200.
12. IF any statement of the refund transaction fails, or the refund transaction does not commit within 15 seconds of the verified refund call being accepted, THEN THE Database SHALL roll back the Order status change, the Enrollment revocation, and the Referral_Row status change together, and THE Webhook_Function SHALL return a non-2xx response so that HitPay retries.
13. THE Platform SHALL include an automated test asserting that a verified refund call for a paid Order sets that Order `status` to `refunded`, leaves zero `enrollments` rows for that Order's `user_id` and `product_id`, sets that Order's Referral_Row `status` to `void`, and causes a subsequent Get_Quiz_Function request from that user for a quiz covered by the revoked Enrollment to return HTTP 403 with zero question objects.

### Requirement 18: Enrollment-Gated Material Delivery via Signed URLs

**User Story:** As a buyer, I want to open my purchased notes from my account, so that I get my files instantly without waiting for an email.

#### Acceptance Criteria

1. THE Materials_Bucket SHALL be configured as a private Supabase Storage bucket with public access disabled.
2. WHEN the Issue_Material_URL_Function receives a request for a `product_id`, THE Issue_Material_URL_Function SHALL query `enrollments` using the Service_Role for a row matching the Verified_UID and that `product_id`.
3. WHEN a matching Enrollment exists, THE Issue_Material_URL_Function SHALL return a Signed_URL for the material object with an expiry of 300 seconds.
4. IF no matching Enrollment exists, THEN THE Issue_Material_URL_Function SHALL return HTTP 403 and SHALL return zero Signed_URL values.
5. WHEN a Signed_URL is older than the configured expiry, THE Materials_Bucket SHALL refuse the download request.
6. WHEN a user selects a material in My Learning, THE Front_End SHALL request a fresh Signed_URL for each open action.
7. THE Front_End SHALL request Signed_URL values through the Issue_Material_URL_Function only and SHALL hold zero Storage object paths that resolve without a signature.
8. IF the material object referenced by a Product is absent from the Materials_Bucket, THEN THE Issue_Material_URL_Function SHALL return an error response stating the file is unavailable, and THE Front_End SHALL display a message inviting the user to contact support.

### Requirement 19: Enrollment-Gated Quiz Delivery

**User Story:** As a buyer, I want to take the quizzes I paid for, so that I can practise as often as I like from my account.

#### Acceptance Criteria

1. WHEN the Get_Quiz_Function receives a request for a `quiz_id`, THE Get_Quiz_Function SHALL resolve the set of Products that include that quiz through `pack_quizzes` and SHALL query `enrollments` for a row matching the Verified_UID and any Product in that set.
2. WHEN a matching Enrollment exists, THE Get_Quiz_Function SHALL return the quiz `title`, `subject`, `timer_minutes`, and the ordered list of questions with `question_number`, `question_text`, and `options`.
3. WHEN the Get_Quiz_Function builds the response, THE Get_Quiz_Function SHALL exclude `correct_key` and `explanation` from every question object.
4. IF no matching Enrollment exists, THEN THE Get_Quiz_Function SHALL return HTTP 403 and SHALL return zero question objects.
5. IF the requested quiz has `published = false`, THEN THE Get_Quiz_Function SHALL return HTTP 404.
6. THE Platform SHALL include an automated test asserting that the Get_Quiz_Function response body contains zero occurrences of the `correct_key` field and zero occurrences of the `explanation` field.

### Requirement 20: Server-Side Grading and Attempt Recording

**User Story:** As a buyer, I want my score and the explanations after I submit, so that I learn from each attempt while the answers stay off my device until then.

#### Acceptance Criteria

1. WHEN the Grade_Quiz_Function receives a submission for a `quiz_id`, THE Grade_Quiz_Function SHALL confirm an Enrollment covering that quiz for the Verified_UID before grading.
2. WHEN a matching Enrollment exists, THE Grade_Quiz_Function SHALL compare each submitted answer against `questions.correct_key` read with the Service_Role.
3. WHEN the Grade_Quiz_Function grades a submission, THE Grade_Quiz_Function SHALL count each question with no submitted answer as incorrect.
4. WHEN grading completes, THE Grade_Quiz_Function SHALL insert one `quiz_attempts` row with `user_id` set to the Verified_UID, `quiz_id`, `score`, `total`, and the submitted `answers`.
5. WHERE the `answer_reveal_mode` Setting equals `answered_only`, WHEN grading completes, THE Grade_Quiz_Function SHALL return the score, the total, per-question correctness, and the `correct_key` value and the `explanation` value for each question the submitted attempt answered, and SHALL omit both the `correct_key` value and the `explanation` value for each question the submitted attempt left unanswered, so that a deliberately blank submission cannot harvest the answer key.
6. IF no matching Enrollment exists, THEN THE Grade_Quiz_Function SHALL return HTTP 403, SHALL insert zero `quiz_attempts` rows, and SHALL return zero correctness data.
7. WHEN a submission contains an answer key absent from that question's `options`, THE Grade_Quiz_Function SHALL count that question as incorrect.
8. THE Grade_Quiz_Function SHALL compute the score from `questions` rows only and SHALL ignore any score, total, or correctness value present in the request body.
9. WHERE the `answer_reveal_mode` Setting equals `full_reveal`, WHEN grading completes, THE Grade_Quiz_Function SHALL return the score, the total, per-question correctness, and the `correct_key` value and the `explanation` value for every question of the attempt, whether the submitted attempt answered that question or left it unanswered.
10. WHEN a submitted answer for a question carries a key absent from that question's `options`, THE Grade_Quiz_Function SHALL treat that question as answered for the reveal behaviour stated in criteria 5 and 9 and SHALL count that question as incorrect, consistent with criterion 7.
11. WHEN the Grade_Quiz_Function resolves the reveal behaviour for a submission, THE Grade_Quiz_Function SHALL read the `answer_reveal_mode` Setting from the `settings` table using the Service_Role.
12. THE Migration_Set SHALL seed the `settings` row `answer_reveal_mode` with value `answered_only`.
13. THE Platform SHALL accept `answered_only` and `full_reveal` as the only `answer_reveal_mode` values and SHALL reject other values on save with a validation message.
14. IF the `answer_reveal_mode` Setting is absent from the `settings` table, THEN THE Grade_Quiz_Function SHALL apply the seeded default value `answered_only`.

### Requirement 21: Quiz-Taking Experience

**User Story:** As a student, I want a calm one-question-at-a-time quiz with a visible timer, so that practising feels like the real exam on my phone.

#### Acceptance Criteria

1. WHEN a user opens a quiz from My Learning, THE Front_End SHALL display one question at a time with the available options as selectable controls.
2. THE Front_End SHALL display a progress indicator showing the current question number and the total question count.
3. WHERE the quiz `timer_minutes` value is greater than 0, THE Front_End SHALL display a countdown initialised to that number of minutes.
4. WHERE the quiz `timer_minutes` value equals 0, THE Front_End SHALL display the quiz with no countdown.
5. WHEN the countdown reaches zero, THE Front_End SHALL submit the answers recorded so far to the Grade_Quiz_Function.
6. WHEN a user reaches the end of the question list, THE Front_End SHALL display a review screen listing each question's answered or unanswered state before submission.
7. WHILE the review screen shows at least one unanswered question, THE Front_End SHALL display a warning stating that unanswered questions are counted as incorrect.
8. WHEN the Grade_Quiz_Function returns results, THE Front_End SHALL display the score, the total, and the explanation for each question.
9. THE Front_End SHALL allow a user holding an Enrollment to start the same quiz again after viewing results.

### Requirement 22: Referral Link Capture

**User Story:** As a referrer, I want my link to be remembered when a friend visits, so that I get credited when that friend buys later.

#### Acceptance Criteria

1. THE Front_End SHALL present each user's referral link in the form `https://<site>/?ref=<ref_code>` using the user's own `profiles.ref_code`.
2. WHEN a visitor loads any page with a `ref` query parameter and no Ref_Code is stored in `localStorage`, THE Front_End SHALL store that Ref_Code value in `localStorage` with the capture timestamp.
3. WHEN a visitor loads any page with a `ref` query parameter and a Ref_Code is already stored in `localStorage` within the last 30 days, THE Front_End SHALL keep the stored Ref_Code unchanged.
4. WHEN the stored Ref_Code capture timestamp is older than 30 days, THE Front_End SHALL discard the stored Ref_Code.
5. WHEN the Front_End calls the Create_Payment_Function and a Ref_Code is stored and unexpired, THE Front_End SHALL include that Ref_Code in the request.
6. THE Front_End SHALL display referral-sharing entry points on the My Learning view and on the enrolled-confirmation view.

### Requirement 23: Referral Attribution on Confirmed Payment

**User Story:** As a referrer, I want my reward recorded automatically when my friend's payment clears, so that tracking needs no manual work.

#### Acceptance Criteria

1. WHEN the Webhook_Function processes a verified completed payment whose amount matches and whose Order carries a Ref_Code, THE Webhook_Function SHALL look up the `profiles` row whose `ref_code` equals that value.
2. WHEN the referrer `profiles` row exists and the referrer id differs from the Order `user_id`, THE Webhook_Function SHALL insert one Referral_Row with `referrer_ref_code`, `referrer_user_id`, `buyer_user_id`, `order_id`, `product_id`, `amount_php` set to the `referral_amount` Setting, `reward_type` set to the `reward_type` Setting, and `status` set to `available`.
3. IF the referrer id equals the Order `user_id`, THEN THE Webhook_Function SHALL insert zero Referral_Rows and SHALL record a self-referral note on the Order.
4. IF the Order Ref_Code matches zero `profiles` rows, THEN THE Webhook_Function SHALL insert zero Referral_Rows and SHALL complete the Enrollment grant.
5. IF a Referral_Row already exists for the Order `order_id`, THEN THE Webhook_Function SHALL insert zero additional Referral_Rows.
6. WHERE the `reward_on` Setting equals `first_purchase_only` and the buyer already has an Order with `status = paid` preceding the current Order, THE Webhook_Function SHALL insert zero Referral_Rows.
7. WHERE the `reward_on` Setting equals `every_purchase`, THE Webhook_Function SHALL insert one Referral_Row for each confirmed Order that carries a valid Ref_Code.
8. IF the Order has no Ref_Code, THEN THE Webhook_Function SHALL insert zero Referral_Rows and SHALL complete the Enrollment grant.
9. THE Platform SHALL include an automated test asserting that a verified completed payment for an Order carrying another user's valid Ref_Code inserts exactly one Referral_Row whose `referrer_user_id` equals that referrer's id, whose `amount_php` equals the `referral_amount` Setting, and whose `status` equals `available`, and that a verified completed payment for an Order carrying the buyer's own Ref_Code inserts zero Referral_Rows.

### Requirement 24: Referral Configuration Defaults

**User Story:** As the site owner, I want the reward rules editable in settings with sensible defaults, so that I can tune the program without a code change.

#### Acceptance Criteria

1. THE Migration_Set SHALL seed the `settings` rows `referral_amount` with value `9`, `reward_type` with value `cash`, `payout_threshold` with value `100`, and `reward_on` with value `every_purchase`.
2. WHEN an Admin_User saves a new `reward_type` value of `credit` through the Admin_Portal, THE Platform SHALL apply `credit` to Referral_Rows inserted after the change and SHALL leave existing Referral_Rows unchanged.
3. WHEN the Webhook_Function reads referral configuration, THE Webhook_Function SHALL read the values from the `settings` table using the Service_Role.
4. IF a referral configuration Setting is absent from the `settings` table, THEN THE Webhook_Function SHALL apply the seeded default value for that Setting.
5. THE Platform SHALL accept `cash` and `credit` as the only `reward_type` values and SHALL reject other values on save with a validation message.
6. THE Platform SHALL record referral payouts as ledger status changes and SHALL perform zero automated money transfers.

### Requirement 25: Referral Dashboard and Payout Requests

**User Story:** As a referrer, I want to see my referrals and request my payout, so that I know what I have earned and how to collect it.

#### Acceptance Criteria

1. WHEN a logged-in user opens the Earnings view, THE Front_End SHALL display the user's referral link, the count of attributed referrals, the available balance, and the paid balance.
2. WHEN the Front_End computes the available balance, THE Front_End SHALL sum the `amount_php` of the user's Referral_Rows whose `status` equals `available`.
3. WHEN the Front_End lists Referral_Rows, THE Front_End SHALL display the buyer identity in masked form and SHALL display the created date, product title, amount, and status.
4. WHERE the `reward_type` Setting equals `cash` and the available balance is at least the `payout_threshold` Setting, THE Front_End SHALL enable a payout-request control that collects a GCash number.
5. WHERE the `reward_type` Setting equals `cash` and the available balance is below the `payout_threshold` Setting, THE Front_End SHALL display the remaining amount required to reach the threshold and SHALL disable the payout-request control.
6. WHERE the `reward_type` Setting equals `credit`, THE Front_End SHALL display the available balance as redeemable credit toward a purchase.
7. WHEN a user submits a payout request, THE Platform SHALL record the request with the supplied GCash number through an Edge_Function using the Service_Role for admin review.
8. WHEN an Admin_User marks a Referral_Row as paid in the Admin_Portal, THE Platform SHALL set `referrals.status` to `paid` and SHALL set `paid_at` through an Admin_Function.

### Requirement 26: Admin Bootstrap and Admin Elevation

**User Story:** As the site owner, I want my own accounts to be admin from day one and to be able to appoint another admin later, so that administration never depends on a client-side flag.

#### Acceptance Criteria

1. THE Migration_Set SHALL set `profiles.is_admin` to `true` for the Owner_Emails `rehinaneel@gmail.com` and `nairutya.84@gmail.com`.
2. WHEN a `profiles` row is created for an address in Owner_Emails after the Migration_Set has run, THE Database SHALL set `is_admin` to `true` for that row.
3. THE Platform SHALL provide an Admin_Function that sets `profiles.is_admin` to `true` for a supplied email address.
4. WHEN that Admin_Function receives a request, THE Admin_Function SHALL read `profiles.is_admin` for the Verified_UID and SHALL proceed only where that value is `true`.
5. IF the caller's `profiles.is_admin` value is `false` or the caller's `profiles` row is absent, THEN THE Admin_Function SHALL return HTTP 403 and SHALL perform zero writes.
6. WHEN an Admin_Function performs a write, THE Admin_Function SHALL use the Service_Role and SHALL derive the caller identity from the validated Session_JWT.
7. THE Admin_Functions SHALL ignore any admin flag, role, or privilege value supplied in a request body or request header.
8. THE Platform SHALL include an automated negative test asserting that a non-admin user calling each Admin_Function receives HTTP 403 and that the target rows remain unchanged.

### Requirement 27: Admin Portal on Supabase

**User Story:** As the site owner, I want to run the platform from the familiar admin forms, so that day-to-day management needs no SQL and no spreadsheet.

#### Acceptance Criteria

1. WHEN an Admin_User opens the Admin_Portal, THE Front_End SHALL require a valid Session_JWT and SHALL confirm `profiles.is_admin` is `true` before displaying management views.
2. IF a user without `is_admin = true` opens the Admin_Portal, THEN THE Front_End SHALL display an access-denied state and SHALL display zero management views.
3. THE Admin_Portal SHALL provide forms to create, edit, price, publish, and unpublish Products, including thumbnail upload and material file upload to the Materials_Bucket.
4. THE Admin_Portal SHALL provide forms to create and edit Quizzes with `timer_minutes`, and to create, edit, reorder, and delete Questions including `correct_key` and `explanation`.
5. THE Admin_Portal SHALL provide a mapping form that assigns Quizzes to quiz-pack Products through `pack_quizzes`.
6. THE Admin_Portal SHALL provide a grant-access action that creates an Enrollment with `source` set to `comp` or `credit`, and a revoke-access action that removes an Enrollment.
7. THE Admin_Portal SHALL provide views listing Orders with status, referral balances, and the referral ledger, with actions to mark a Referral_Row paid and to void a Referral_Row.
8. THE Admin_Portal SHALL provide a form to edit `settings` values covering brand name, contact email, announcement banner, hero copy, and referral configuration.
9. WHEN an Admin_User saves any change in the Admin_Portal, THE Front_End SHALL send the change to an Admin_Function and SHALL display a confirmation toast on success.
10. WHEN an Admin_User requests a delete action, THE Front_End SHALL require an explicit confirmation before sending the request.
11. WHEN an Admin_User saves a Product, THE Admin_Function SHALL reject the save with a validation message where `price_php` is not a positive integer, where `slug` is already used by another Product, or where `type` is a value other than `material` or `quiz_pack`.

### Requirement 28: Secrets Confinement

**User Story:** As the site owner, I want every secret held server-side only, so that reading the site's JavaScript reveals nothing exploitable.

#### Acceptance Criteria

1. THE Platform SHALL hold the Supabase service-role key, the HitPay API key, the Webhook_Salt, and the SMTP credentials in Edge Function environment variables only.
2. THE Front_End SHALL contain the Supabase project URL and the Supabase anon key only.
3. THE repository SHALL contain zero service-role key values, zero HitPay API key values, zero Webhook_Salt values, and zero SMTP credential values.
4. THE Platform SHALL include an automated check that scans the deployed Front_End files for the configured secret variable names and fails where a match is found.
5. WHEN an Edge_Function returns an error response, THE Edge_Function SHALL exclude secret values and stack traces from the response body.

### Requirement 29: Output Safety

**User Story:** As the site owner, I want database content rendered as text, so that content entered in the admin portal cannot inject script into a student's browser.

#### Acceptance Criteria

1. WHEN the Front_End renders a value read from the Database, THE Front_End SHALL assign the value using `textContent`.
2. THE Front_End SHALL build dynamic list and card markup with element creation and `textContent` assignment.
3. WHEN the Front_End renders a value read from the Database into an attribute, THE Front_End SHALL set the attribute with `setAttribute` and SHALL reject values whose scheme is not `https` for link and image sources.
4. THE Platform SHALL include an automated test that stores a Product title containing HTML markup and asserts the rendered catalog card displays the markup as literal text.

### Requirement 30: Free-Tier Operation and Auth Email Delivery

**User Story:** As the site owner, I want the platform to run at zero monthly cost with reliable login emails, so that launching costs nothing beyond transaction fees.

#### Acceptance Criteria

1. THE Platform SHALL operate within the Supabase Free tier limits for Postgres, Auth, Storage, and Edge Functions.
2. THE Platform SHALL introduce zero paid services beyond the per-transaction HitPay fees.
3. THE Supabase_Auth SHALL send one-time-password emails through a custom SMTP provider configured in the Supabase project.
4. THE Docs SHALL list the custom SMTP settings required for one-time-password email delivery and SHALL name at least one transactional email provider with a free tier.
5. THE Docs SHALL state that Supabase Free projects pause after 7 days of inactivity and provide no automated backups, and SHALL recommend the Supabase Pro plan once paying users exist.
6. THE Platform SHALL function on the Supabase Free tier with zero dependencies on Supabase Pro features.

### Requirement 31: Logged-In Shell and My Learning

**User Story:** As a signed-in student, I want the site to feel like my own platform, so that my purchases and account are always one tap away.

#### Acceptance Criteria

1. WHILE a Session_JWT is present, THE Front_End SHALL display the user's `display_name` or email in the top bar with an account menu containing My Learning, Earnings, Account settings, and Log out.
2. WHILE no Session_JWT is present, THE Front_End SHALL display a Log in control in the top bar.
3. WHEN a user opens My Learning, THE Front_End SHALL list the Products covered by the user's Enrollments, grouped into materials and quizzes.
4. WHEN a user selects a material in My Learning, THE Front_End SHALL open the material through the Issue_Material_URL_Function.
5. WHEN a user selects a quiz in My Learning, THE Front_End SHALL open the quiz-taking view through the Get_Quiz_Function.
6. WHEN a user completes login, THE Front_End SHALL route the user to My Learning unless a pending checkout product is recorded.
7. WHILE a Session_JWT is present, THE Front_End SHALL continue to display the full published catalog on the catalog view.
8. THE Front_End SHALL display each Enrollment permanently for the owning user, with zero expiry applied to Enrollments whose `source` is `purchase`.

### Requirement 32: Design Continuity and Mobile-First Performance

**User Story:** As a student on a phone, I want a fast, calm, professional site, so that browsing and studying work well on a modest connection.

#### Acceptance Criteria

1. THE Front_End SHALL use the existing palette of terracotta, slate, and off-white and the existing fonts Fraunces and Manrope, applied through `css/styles.css`.
2. THE Front_End SHALL apply an 8-pixel spacing system and a single consistent type scale across views.
3. THE Front_End SHALL replace the v1 3D WebGL hero with a static mobile-first hero layout and SHALL exclude the WebGL hero script from page loads.
4. WHERE the user agent reports `prefers-reduced-motion: reduce`, THE Front_End SHALL disable transition and animation effects on decorative elements.
5. THE Front_End SHALL render the catalog view as a single-column card list at viewport widths of 480 pixels and below and as a multi-column grid at widths of 768 pixels and above.
6. THE Front_End SHALL remain a static site deployable to Cloudflare Pages with zero build step.
7. THE Front_End SHALL display a primary call-to-action on each course card that is reachable by keyboard and labelled with the product title.
8. THE Front_End SHALL present pricing, contents, refund information, and a secure-payment note on the product detail view.

### Requirement 33: Loading, Empty, and Error States

**User Story:** As a user, I want the site to tell me what is happening, so that a slow network or an empty list never looks broken.

#### Acceptance Criteria

1. WHILE a Database read or an Edge_Function call is in flight, THE Front_End SHALL display a loading state for the affected view region.
2. WHEN the user's Enrollment list is empty, THE Front_End SHALL display an empty state stating that the user has enrolled in nothing yet with a link to the catalog.
3. WHEN the published catalog is empty, THE Front_End SHALL display an empty state stating that products are coming soon.
4. WHEN the referral ledger for a user is empty, THE Front_End SHALL display an empty state with the user's referral link and sharing guidance.
5. IF a Database read or an Edge_Function call returns an error, THEN THE Front_End SHALL display an error state naming the failed action with a retry control.
6. IF an Edge_Function call returns HTTP 401, THEN THE Front_End SHALL route the user to the login view and SHALL display a message stating the session expired.
7. IF an Edge_Function call returns HTTP 403 for a material or a quiz, THEN THE Front_End SHALL display a state stating the item requires a purchase with a link to the product detail view.

### Requirement 34: Corrected Copy for the Account-First Model

**User Story:** As a prospective buyer, I want the site's promises to match how it works, so that I trust what I read before paying.

#### Acceptance Criteria

1. THE Front_End SHALL describe purchases as unlocking instantly in the buyer's account after payment.
2. THE Front_End SHALL state that an account is created by entering an email address and a one-time code, with zero passwords required.
3. THE Front_End SHALL remove the v1 statements that no account is needed and that materials are delivered by email from every page, including the FAQ view.
4. THE Front_End SHALL state on the FAQ view that logging in is required to open materials and take quizzes.
5. THE Front_End SHALL state that payment is accepted through GCash and QR Ph and that card payment is unavailable.
6. THE Docs SHALL describe the account-linked enrollment model and SHALL remove instructions for issuing and emailing access codes.

### Requirement 35: Migration and Seed of Existing Content

**User Story:** As the site owner, I want my existing products, quizzes, and files carried over, so that v2 launches with the catalog I already built.

#### Acceptance Criteria

1. THE Seed_Import SHALL create one `products` row for each active v1 product, preserving title, subject, description, `price_php`, and sort order, and mapping the v1 `type` values `material` and `quiz` to `material` and `quiz_pack`.
2. THE Seed_Import SHALL create one `quizzes` row for each distinct v1 `quiz_id`, preserving title, subject, and `timer_minutes`.
3. THE Seed_Import SHALL create one `questions` row for each v1 question row, preserving question text, options, the correct option as `correct_key`, and the explanation.
4. THE Seed_Import SHALL create `pack_quizzes` rows linking each quiz-pack Product to the Quizzes previously covered by that product's unlock scope.
5. THE Seed_Import SHALL upload each existing material file into the Materials_Bucket and SHALL record the object path on the matching Product.
6. WHEN the Seed_Import completes, THE Platform SHALL report the count of rows created per table and the count of files uploaded.
7. THE Seed_Import SHALL create at least one test account holding at least one Enrollment so that the browse, login, pay, enrol, open, take, and refer sequence is exercisable end to end.
8. WHEN the Seed_Import runs a second time against the same Database, THE Seed_Import SHALL leave the row counts of `products`, `quizzes`, `questions`, and `pack_quizzes` unchanged.
9. THE Platform SHALL retain the `apps-script/` directory unmodified and SHALL exclude every `apps-script/` file from the v2 runtime.

### Requirement 36: Documentation Updates

**User Story:** As the site owner, I want setup and daily-use guides for the new architecture, so that I can operate the platform without a developer.

#### Acceptance Criteria

1. THE `SETUP.md` document SHALL describe creating the Supabase project, applying the Migration_Set, configuring custom SMTP, creating the Materials_Bucket, and deploying each Edge_Function.
2. THE `SETUP.md` document SHALL describe obtaining the HitPay API key and Webhook_Salt, registering the Webhook_Function URL in the HitPay dashboard, and switching from sandbox to live.
3. THE `SETUP.md` document SHALL list every Edge Function environment variable by name with a placeholder value.
4. THE `ADMIN_GUIDE.md` document SHALL describe managing products, quizzes, questions, enrollments, referral payouts, and settings through the Admin_Portal under the account-first model.
5. THE `README.md` document SHALL describe the v2 architecture, the Supabase-backed stack, and the retirement of the Apps Script backend.
6. THE Docs SHALL record that referral payouts are sent manually over GCash and that the Platform performs zero automated disbursements.
