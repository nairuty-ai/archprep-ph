# Implementation Plan: Platform v2

## Overview

The build follows the security-first order the design implies: schema, then the grant/RLS baseline, then the transactional SQL functions that own money, then the Edge Functions, then the front end, then migration, docs, and verification. Nothing that handles money or answer keys is written before the layer beneath it is tested, because each layer's guarantee is what the layer above relies on.

Languages are fixed by the design: SQL for migrations and the fulfilment functions, TypeScript on Deno for Edge Functions, vanilla ES modules for the browser, and `node:test` plus fast-check (pinned, exact version) for tests. No build step is introduced.

Every one of the 37 correctness properties in the design is implemented as exactly one property-based test sub-task, tagged with the property number and the requirement clauses it validates.

## Tasks

- [x] 1. Project scaffolding and test harness
  - [x] 1.1 Create the Supabase and test scaffolding
    - Add `supabase/config.toml` with `verify_jwt = false` for `hitpay-webhook` only, and `supabase/migrations/`, `supabase/functions/_shared/`, `supabase/seed/` directories
    - Add `package.json` with fast-check pinned to an exact version as the only dev dependency and a `test` script running `node --test`
    - Add `.env.example` naming `SUPABASE_SERVICE_ROLE_KEY`, `HITPAY_API_KEY`, `HITPAY_WEBHOOK_SALT`, `HITPAY_API_BASE_URL`, SMTP variables, with placeholder values only
    - Update `config.js` to hold the Supabase project URL and anon key only, with no other keys
    - _Requirements: 13.1, 13.2, 28.1, 28.2, 28.3, 30.6, 32.6_

  - [x] 1.2 Build the test clients and shared generators
    - `tests/helpers/clients.mjs`: anon, per-user authenticated (real sign-in), and service-role client factories against a local Supabase instance
    - `tests/helpers/tokens.mjs`: locally minted JWT variants (valid, absent, malformed, expired, unsigned, foreign issuer, missing claim)
    - `tests/generators.mjs`: `arbQuiz`, `arbSubmission`, `arbCatalog`, `arbQueryShape`, `arbTokenVariant`, `arbWebhookDelivery`, `arbLedger`
    - Deviation from the design's `.js` filenames: the v2 test modules use `.mjs` because `package.json` deliberately omits `"type": "module"` so the retained v1 CommonJS harness (`tests/backend-test.js`) keeps running under `node --test`
    - _Requirements: 5.4, 7.8, 4.7_

- [x] 2. Database schema and provisioning triggers
  - [x] 2.1 Write the core schema migration
    - `supabase/migrations/0001_schema_core.sql`: enum types, `profiles`, `admin_bootstrap_emails` seeded with both owner emails, `products` (including `material_path`, `thumbnail_path`, integer `price_php`), `quizzes`, `pack_quizzes`, `questions` with `unique (quiz_id, question_number)`, and the `products_published_sort_idx` index
    - _Requirements: 3.3, 9.8, 26.1, 27.11, 35.1, 35.2, 35.3_

  - [x] 2.2 Write the money and access schema migration
    - `supabase/migrations/0002_schema_money.sql`: `orders` with `amount_php numeric(12,2)`, `enrollments` with `unique (user_id, product_id)`, `quiz_attempts`, `referrals` with unique `order_id` and the `referrals_no_self` check, `payment_incidents`, `payout_requests`
    - Add the partial unique index on `orders.hitpay_payment_id` covering non-null values only, plus `orders_user_idx` and `referrals_referrer_idx`
    - _Requirements: 16.1, 15.8, 25.7_

  - [x] 2.3 Write the functions and triggers migration
    - `supabase/migrations/0003_functions_triggers.sql`: `gen_ref_code()` over the unambiguous alphabet with collision retry, `handle_new_user()` setting `is_admin` from `admin_bootstrap_emails`, the `on_auth_user_created` trigger, `mask_email()`, `guard_profile_columns()` and its before-update trigger
    - _Requirements: 3.1, 3.2, 3.4, 9.2, 9.3, 26.2, 7.7_

  - [x] 2.4 Write the settings migration and seed
    - `supabase/migrations/0004_settings_seed.sql`: `settings` table with the `display_safe` boolean, seeded with `referral_amount` 9, `reward_type` cash, `payout_threshold` 100, `reward_on` every_purchase, `answer_reveal_mode` answered_only with `display_safe = false`, and the brand, contact, banner, and hero copy keys as display-safe
    - _Requirements: 20.12, 24.1, 9.9_

  - [ ]* 2.5 Write property test for profile provisioning
    - **Property 11: Signup provisions exactly one profile with a unique code**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 26.1, 26.2**

  - [ ]* 2.6 Write schema smoke tests
    - Assert the enum types, the positive-amount and currency checks, and the three uniqueness rules behind idempotency reject invalid writes even through the service role
    - _Requirements: 16.1_

- [x] 3. Grants and Row-Level Security
  - [x] 3.1 Write the revoke-and-enable baseline migration
    - `supabase/migrations/0005_rls_baseline.sql`: alter default privileges, revoke all on tables and functions from `anon` and `authenticated`, enable RLS on every table, force RLS on `profiles`, `orders`, `enrollments`, `referrals`
    - _Requirements: 5.1, 5.2_

  - [x] 3.2 Write the questions lockdown migration
    - `supabase/migrations/0006_rls_questions.sql`: revoke all on `public.questions` from client roles, grant select to `service_role` only, add the comment forbidding any future policy or client-callable definer routine over the table
    - _Requirements: 6.1, 6.6_

  - [x] 3.3 Write the profiles grants and policies migration
    - `supabase/migrations/0007_rls_profiles.sql`: select grant, column-level update grant on `display_name` and `gcash_number` only, `profiles_select_own`, `profiles_update_own`, and no insert or delete policy
    - _Requirements: 7.1, 9.1, 9.2, 9.3, 3.5_

  - [x] 3.4 Write the catalog policies migration
    - `supabase/migrations/0008_rls_catalog.sql`: column-level select grant on `products` withholding `material_path`, full select grants on `quizzes` and `pack_quizzes`, and the three published-only policies with `pack_quizzes` resolving through the parent product
    - _Requirements: 9.4, 9.5, 18.7_

  - [x] 3.5 Write the owner-scoped and service-only policies migration
    - `supabase/migrations/0009_rls_owner_scoped.sql`: select grants and own-row policies on `orders`, `enrollments`, `quiz_attempts`, `payout_requests`, the column-restricted grant on `referrals` withholding `buyer_user_id` and `referrer_user_id` with `referrals_select_own`, and zero grants plus zero policies on `payment_incidents` and `admin_bootstrap_emails`
    - _Requirements: 7.2, 8.1, 8.5_

  - [x] 3.6 Write the settings allowlist policy migration
    - `supabase/migrations/0010_rls_settings.sql`: select grant plus `settings_select_display_safe`
    - _Requirements: 9.6, 9.7, 6.13_

  - [ ]* 3.7 Write property test for the answer-key guarantee
    - **Property 1: Answer keys are unreachable from every client query shape**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.8, 6.9**

  - [ ]* 3.8 Write property test for the default-deny policy matrix
    - **Property 4: The policy matrix is default-deny**
    - **Validates: Requirements 5.3, 8.2, 8.3, 8.6**

  - [ ]* 3.9 Write property test for owner-scoped reads
    - **Property 5: Reads are isolated to the owning user**
    - **Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.7, 7.8**

  - [ ]* 3.10 Write property test for protected profile columns
    - **Property 6: Protected profile columns cannot be changed by their owner**
    - **Validates: Requirements 9.2, 9.3, 9.10**

  - [ ]* 3.11 Write property test for published-only catalog reads
    - **Property 7: Client catalog reads return exactly the published subset**
    - **Validates: Requirements 9.4, 9.5**

  - [ ]* 3.12 Write property test for the settings allowlist
    - **Property 8: Settings visibility equals the allowlist**
    - **Validates: Requirements 9.6, 9.7, 9.9, 9.10**

  - [ ]* 3.13 Write the policy inventory equality test
    - Enumerate live policies and grants and assert equality with the declared inventory table in the design; any extra policy or widened grant fails
    - _Requirements: 5.4, 5.2_

- [x] 4. Checkpoint - schema and RLS
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Transactional fulfilment and refund functions
  - [x] 5.1 Implement `fulfil_payment`
    - `supabase/migrations/0011_fn_fulfil_payment.sql`: `SECURITY DEFINER` function with `for update` on the order, unmatched-payment incident, early return on an already-paid order leaving `paid_at` untouched, out-of-order incident for a refunded order, amount and currency cross-check at two decimals against the stored values, status update, `on conflict do nothing` enrollment insert, and the referral attribution block honouring `reward_on`, self-referral, and unknown-code cases
    - Revoke execute from client roles, grant execute to `service_role` only
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.8, 15.9, 16.2, 16.4, 16.5, 16.6, 16.10, 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8, 24.3, 24.4, 8.4_

  - [x] 5.2 Implement `refund_payment` and `fail_payment`
    - `supabase/migrations/0012_fn_refund_fail_payment.sql`: refund sets `refunded` for any reported amount, deletes the enrollment scoped to that order's user and product, voids the referral preserving `paid_at` and appending the already-paid note, records unmatched refunds, and returns unchanged on repeat; `fail_payment` moves a pending order to `failed` and records an out-of-order incident for a paid or refunded order
    - Grant execute to `service_role` only
    - _Requirements: 17.1, 17.2, 17.4, 17.5, 17.7, 17.8, 17.10, 17.11, 17.12, 16.8, 16.9_

  - [ ]* 5.3 Write property test for the paid-amount cross-check
    - **Property 14: Access is granted only on an exact amount and currency match**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.7, 15.8, 15.9, 15.10, 16.10**

  - [ ]* 5.4 Write property test for fulfilment idempotency
    - **Property 15: Fulfilment is idempotent under any delivery sequence**
    - **Validates: Requirements 16.2, 16.4, 16.5, 16.6, 16.7**

  - [ ]* 5.5 Write property test for non-completed payment outcomes
    - **Property 16: Non-completed outcomes respect the order's current state**
    - **Validates: Requirements 16.8, 16.9**

  - [ ]* 5.6 Write property test for refund handling
    - **Property 17: A refund leaves no unearned benefit**
    - **Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5, 17.7, 17.10, 17.11, 17.13**

  - [ ]* 5.7 Write property test for referral attribution
    - **Property 18: Referral attribution is exactly-once and predicate-driven**
    - **Validates: Requirements 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8, 23.9, 24.2, 24.4**

- [~] 6. Checkpoint - money layer
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Edge Function shared modules
  - [x] 7.1 Implement the response envelope and secret scrubber
    - `supabase/functions/_shared/http.ts`: `json()`, `HttpError`, the code/message envelope, and the scrubber stripping configured secret values and stack frames from every outbound body
    - _Requirements: 28.5, 33.5_

  - [x] 7.2 Implement the user and admin gates
    - `_shared/auth.ts` `requireUser(req)` deriving the uid from the bearer token only, verifying signature, issuer, and expiry with zero tolerance; `_shared/admin.ts` `requireAdmin(req)` re-reading `profiles.is_admin` from the database on every call
    - Accept no user-identity parameter anywhere in either signature
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 26.4, 26.5, 26.6, 26.7_

  - [x] 7.3 Implement the HitPay adapter
    - `_shared/hitpay.ts`: `createPaymentRequest()` resolving the documented endpoint path against `HITPAY_API_BASE_URL` with the business API key header and a 15-second timeout, `verifyHitpaySignature()` computing HMAC-SHA256 over the raw body with a constant-time compare, and `parseHitpayPayload()` normalising completed, refunded, failed, and ignored outcomes
    - Return a `config_missing` error naming any absent environment variable before making an outbound call
    - _Requirements: 12.1, 13.1, 13.2, 13.4, 13.5, 13.7, 14.1, 14.3, 14.4_

  - [ ]* 7.4 Write property test for webhook signature verification
    - **Property 13: Unverified webhook calls change nothing**
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6**

  - [ ]* 7.5 Write property test for HitPay URL resolution
    - **Property 36: HitPay URLs resolve against the configured base**
    - **Validates: Requirements 13.4**

- [ ] 8. Payment creation and webhook endpoint
  - [-] 8.1 Implement `create-payment`
    - Read `product_id` and `ref_code` only, resolve price and published state from `products` with the service role, return 404 for absent or unpublished, return already-owned for an existing enrollment, insert the pending order with the database price and `PHP`, call HitPay with the order amount and the enrolled-confirmation redirect, store `hitpay_payment_id` and `hitpay_reference`, return the checkout URL, and mark the order `failed` on a HitPay error or timeout
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.2, 12.4, 12.5, 8.4_

  - [ ]* 8.2 Write property test for server-side price derivation
    - **Property 12: Order amounts derive from the database, never the request**
    - **Validates: Requirements 11.1, 11.2, 11.4, 11.5, 11.7**

  - [-] 8.3 Implement `hitpay-webhook`
    - Read the raw body first, verify the signature before any database access, dispatch the normalised outcome to `fulfil_payment`, `refund_payment`, or `fail_payment` with the service role, return 200 for every settled outcome including incidents and ignored events, and 5xx only on a fault so HitPay retries
    - Log rejections with the reported payment identifier and never the salt
    - _Requirements: 14.2, 14.5, 16.3, 16.7, 17.12, 15.9_

  - [ ]* 8.4 Write webhook wiring example tests
    - A forged-signature delivery changes zero rows; a rolled-back transaction returns a non-2xx; an unrelated event type returns 200 with zero writes
    - _Requirements: 14.6, 16.3, 17.12_

- [ ] 9. Content delivery functions
  - [-] 9.1 Implement `get-quiz`
    - Resolve enrollment through `pack_quizzes`, select only `id, question_number, question_text, options` so the answer fields never enter memory, return title, subject, `timer_minutes`, and the ordered questions, 403 with zero question objects when not enrolled, 404 for an unpublished quiz, and a final fail-closed assertion on the serialised payload
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 6.7, 6.11_

  - [ ]* 9.2 Write property test for answer-free quiz payloads
    - **Property 2: Quiz payloads never carry answer fields**
    - **Validates: Requirements 6.7, 6.11, 19.3, 19.6**

  - [-] 9.3 Implement `grade-quiz`
    - Confirm enrollment, read `correct_key` and `answer_reveal_mode` with the service role, count unanswered and out-of-options answers as incorrect, ignore any score, total, or correctness field in the request body, insert exactly one `quiz_attempts` row, and reveal answers per the mode with `answered_only` as the fallback when the setting row is absent
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 20.11, 20.14, 6.10, 6.12_

  - [ ]* 9.4 Write property test for answer reveal scoping
    - **Property 3: Answer reveal is scoped exactly to the submitted set**
    - **Validates: Requirements 6.10, 6.12, 6.14, 20.5, 20.9, 20.14**

  - [ ]* 9.5 Write property test for server-side grading
    - **Property 22: Grading is computed from the database alone**
    - **Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.7, 20.8, 20.10**

  - [-] 9.6 Implement `issue-material-url` and configure the buckets
    - Private `materials` bucket with public access disabled and a separate public `thumbnails` bucket; the function checks `enrollments` for the verified uid and product, returns a freshly minted 300-second signed URL, 403 with zero URLs when not enrolled, and a file-unavailable error when the object is absent
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.6, 18.8_

  - [ ]* 9.7 Write property test for the enrollment gate
    - **Property 21: Content access requires a matching enrollment**
    - **Validates: Requirements 18.2, 18.3, 18.4, 18.6, 18.7, 19.1, 19.2, 19.4, 20.6**

- [~] 10. Checkpoint - Edge Functions for payment and content
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Payout and admin Edge Functions
  - [~] 11.1 Implement `request-payout`
    - Recompute the available balance server-side from `referrals`, reject below the threshold with `below_threshold`, and insert exactly one `payout_requests` row with the supplied GCash number
    - _Requirements: 25.7, 25.4_

  - [~] 11.2 Implement `admin-products`
    - Product create, edit, price, publish, unpublish, thumbnail upload to the public bucket, material upload to the private bucket, with validation on positive integer `price_php`, unique `slug`, and the two accepted `type` values
    - _Requirements: 27.3, 27.11, 8.5_

  - [ ]* 11.3 Write property test for product save validation
    - **Property 24: Product saves validate price, slug, and type**
    - **Validates: Requirements 27.11**

  - [~] 11.4 Implement `admin-quizzes` and `admin-questions`
    - Quiz CRUD with `timer_minutes`, `pack_quizzes` mapping, and question create, edit, reorder, and delete keeping `question_number` contiguous from 1 to N
    - _Requirements: 27.4, 27.5, 8.5_

  - [ ]* 11.5 Write property test for question numbering
    - **Property 25: Question numbering stays contiguous**
    - **Validates: Requirements 27.4**

  - [~] 11.6 Implement the remaining admin functions
    - `admin-enrollments` grant (`comp`/`credit`) and revoke, `admin-referrals` ledger with mark-paid and void, `admin-incidents` review list ordered by recording time descending in pages of at most 50 with mark-resolved, `admin-users` granting `is_admin` by email
    - _Requirements: 17.9, 25.8, 26.3, 27.6, 27.7, 15.6_

  - [~] 11.7 Implement `admin-settings`
    - Per-key validation accepting `cash`/`credit` for `reward_type` and `answered_only`/`full_reveal` for `answer_reveal_mode`, rejecting anything else with a validation message and an unchanged stored value
    - _Requirements: 20.13, 24.5, 27.8_

  - [ ]* 11.8 Write property test for enumerated setting values
    - **Property 23: Enumerated settings reject every other value**
    - **Validates: Requirements 20.13, 24.5**

  - [ ]* 11.9 Write property test for token-derived identity across all gated functions
    - **Property 9: Identity comes only from a validated token**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 28.5**

  - [ ]* 11.10 Write property test for admin authorisation
    - **Property 10: Admin authorisation is total over admin functions**
    - **Validates: Requirements 26.4, 26.5, 26.6, 26.7, 26.8**

- [ ] 12. Front-end foundation
  - [~] 12.1 Implement the Supabase client singleton
    - `js/supabase.js` reading the public URL and anon key from `config.js`, with session persistence and auto-refresh
    - _Requirements: 28.2, 30.6_

  - [~] 12.2 Implement the safe DOM helpers
    - `js/dom.js` with `el(tag, { class, text, attrs, children })`, `$`, `$$`, `peso()`, no `html` option and no `innerHTML` path, and an attribute setter rejecting any scheme other than `https` for `href` and `src`
    - _Requirements: 29.1, 29.2, 29.3_

  - [ ]* 12.3 Write property test for literal text rendering
    - **Property 31: Database content renders as literal text**
    - **Validates: Requirements 29.1, 29.2, 29.4**

  - [ ]* 12.4 Write property test for attribute scheme filtering
    - **Property 32: Only https values reach link and image attributes**
    - **Validates: Requirements 29.3**

  - [~] 12.5 Implement the state renderers
    - `js/states.js` with per-region `renderLoading()`, `renderEmpty()`, `renderError()` guaranteeing exactly one rendered state per region
    - _Requirements: 33.1, 33.2, 33.3, 33.4, 33.5_

  - [~] 12.6 Implement the API layer
    - `js/api.js` with one typed wrapper per Edge Function attaching the bearer token, plus the central status mapping: 401 clears the session and routes to login once, 403 on a material or quiz shows the purchase-required state, and network failures surface a named retryable error
    - _Requirements: 33.5, 33.6, 33.7_

  - [ ]* 12.7 Write property test for view region states
    - **Property 34: Every view region shows exactly one state**
    - **Validates: Requirements 33.1, 33.5, 33.6, 33.7**

  - [~] 12.8 Implement authentication and the login view
    - `js/auth.js` with `signIn(email)`, `verify(code)`, `signOut()`, `requireSession()`, `requireAdmin()` and the three route classes; `login.html` with email validation at 254 characters, the code step retaining the email on failure, the 60-second resend countdown, the optional Google control shown only where credentials are configured, and logout discarding the session
    - _Requirements: 1.5, 1.7, 1.8, 1.9, 1.10, 1.11, 2.1, 2.2, 2.3, 27.1, 27.2, 31.6_

  - [ ]* 12.9 Write property test for login validation and resend timing
    - **Property 37: Login input validation and resend timing follow their rules**
    - **Validates: Requirements 1.7, 1.9**

  - [~] 12.10 Implement referral capture
    - `js/referral.js` with `captureRef()` first-touch storage plus timestamp, `currentRef()` returning an unexpired code only, and 30-day expiry discarding the stored value
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5_

  - [ ]* 12.11 Write property test for referral capture
    - **Property 26: Referral capture is first-touch with a 30-day life**
    - **Validates: Requirements 22.1, 22.2, 22.3, 22.4, 22.5**

- [ ] 13. Catalog, product detail, and checkout
  - [~] 13.1 Implement the public catalog
    - `index.html` featured catalog and `catalog.html` full catalog with `js/catalog.js` rendering every published product as a card with thumbnail, title, subtitle, subject, PHP price, and contents, ordered by `sort_order`, identical with and without a session, with the keyboard-reachable primary action labelled by the product title
    - _Requirements: 10.1, 10.3, 10.4, 31.7, 32.7, 33.3_

  - [~] 13.2 Implement product detail and the purchase entry point
    - `product.html` with `js/product.js` showing description, price, contents, refund information, and the secure-payment note; Buy stores the pending `product_id` and routes to login when there is no session, and calls `create-payment` with the captured referral code then redirects to the checkout URL when there is
    - _Requirements: 10.2, 10.5, 10.6, 10.7, 12.3, 12.4, 22.5, 32.8_

  - [ ]* 13.3 Write property test for catalog rendering
    - **Property 27: The catalog renders the published set identically for every visitor**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 31.7, 32.7, 32.8**

  - [ ]* 13.4 Write property test for the checkout login detour
    - **Property 28: Checkout survives the login detour**
    - **Validates: Requirements 10.5, 10.6, 31.6**

  - [~] 13.5 Implement the enrolled-confirmation view
    - `enrolled.html` polling the buyer's own `orders` and `enrollments` rows every 2 seconds for up to 30 seconds, showing the enrolled state on success, the confirmation-pending state with a My Learning link on timeout, stopping the poll in both cases, and offering the referral-sharing entry point
    - _Requirements: 12.6, 12.7, 22.6_

  - [ ]* 13.6 Write property test for the confirmation poll
    - **Property 30: The confirmation view resolves within its polling window**
    - **Validates: Requirements 12.6, 12.7**

- [ ] 14. Logged-in shell, My Learning, quiz runner, earnings
  - [~] 14.1 Implement the shell and My Learning
    - Shared top bar rendering `display_name` or email with the account menu (My Learning, Earnings, Account settings, Log out) and a Log in control when there is no session; `my-learning.html` with `js/my-learning.js` listing exactly the enrolled products grouped into materials and quizzes with no expiry filtering, opening materials through `issue-material-url` with a fresh URL per action; `account.html` with `js/account.js` editing `display_name` and `gcash_number`
    - _Requirements: 3.5, 18.6, 31.1, 31.2, 31.3, 31.4, 31.5, 31.8, 33.2, 22.6_

  - [ ]* 14.2 Write property test for the shell and My Learning
    - **Property 33: The shell and My Learning reflect session and enrollment state**
    - **Validates: Requirements 31.1, 31.2, 31.3, 31.8**

  - [~] 14.3 Implement the quiz runner
    - `quiz.html` with `js/quiz-runner.js` showing one question at a time, a progress indicator, a countdown only where `timer_minutes` is greater than zero that submits on expiry, a review screen listing answered state with the unanswered warning, results showing score, total, and the returned explanations, and a restart control
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.9_

  - [ ]* 14.4 Write property test for the quiz runner
    - **Property 29: The quiz runner state follows the quiz and the answers**
    - **Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.6, 21.7, 21.8**

  - [~] 14.5 Implement the earnings dashboard
    - `earnings.html` with `js/earnings.js` showing the referral link, referral count, available and paid balances, the ledger with masked buyer, created date, product title, amount, and status including void rows excluded from both balances, the threshold-gated payout control collecting a GCash number in cash mode, the shortfall below threshold, and redeemable credit in credit mode
    - _Requirements: 17.6, 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 33.4_

  - [ ]* 14.6 Write property test for ledger balances
    - **Property 19: Ledger balances follow from row status**
    - **Validates: Requirements 17.6, 25.1, 25.2, 25.3, 25.7, 25.8**

  - [ ]* 14.7 Write property test for payout eligibility
    - **Property 20: Payout eligibility is a strict threshold test**
    - **Validates: Requirements 25.4, 25.5, 25.6**

- [~] 15. Checkpoint - student-facing flows
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Admin portal front-end
  - [~] 16.1 Implement the admin shell and guard
    - `admin.html` requiring a session and a confirmed `profiles.is_admin`, rendering an access-denied state with zero management views otherwise, with the navigation for every management area
    - _Requirements: 27.1, 27.2_

  - [~] 16.2 Implement the catalog management views
    - `js/admin/products.js`, `js/admin/quizzes.js`, `js/admin/questions.js` calling `admin-products`, `admin-quizzes`, `admin-questions`, carrying over the v1 guided form UX with inline validation messages, confirmation toasts on save, and explicit confirmation before delete
    - _Requirements: 27.3, 27.4, 27.5, 27.9, 27.10, 27.11_

  - [~] 16.3 Implement the operations management views
    - `js/admin/enrollments.js` grant and revoke with confirmation, `js/admin/referrals.js` balances, ledger, mark paid, void, `js/admin/incidents.js` mismatch review list paged at 50 with mark-resolved, `js/admin/settings.js` editing brand, contact, banner, hero copy, and referral configuration
    - _Requirements: 15.6, 17.9, 25.8, 26.3, 27.6, 27.7, 27.8, 27.9, 27.10_

  - [ ]* 16.4 Write admin example tests
    - One case each: a product form round trip, a question reorder round trip, the revoke-enrollment action, the void-referral action, the delete confirmation gate, and a non-admin seeing the access-denied state
    - _Requirements: 17.9, 27.2, 27.9, 27.10_

- [ ] 17. Design pass and copy correction
  - [~] 17.1 Apply the mobile-first design pass
    - Extend `css/styles.css` with the 8px spacing system and single type scale on the existing palette and fonts, single-column cards at 480px and below with a multi-column grid at 768px and above, and the `prefers-reduced-motion` branch; remove the WebGL hero, `js/hero3d.js`, `js/fx.js`, `js/cursor.js`, and `js/config-loader.js` from every page load and replace the hero with a static layout
    - _Requirements: 32.1, 32.2, 32.3, 32.4, 32.5, 32.6_

  - [~] 17.2 Correct the account-first copy
    - Rewrite copy across `index.html`, `faq.html`, and the remaining views to describe instant in-account unlocking, passwordless email-and-code signup, login required to open materials and take quizzes, and GCash and QR Ph as the payment methods with no card option; remove every "no account needed" and email-delivery statement; retire `thank-you.html` in favour of `enrolled.html`
    - _Requirements: 34.1, 34.2, 34.3, 34.4, 34.5_

  - [ ]* 17.3 Write design and copy example tests
    - The reduced-motion branch, the column count at 480px and 768px, the absence of the WebGL hero script from every page, and a scan asserting the retired v1 phrases appear nowhere
    - _Requirements: 32.3, 32.4, 32.5, 34.3_

- [ ] 18. Migration and seed
  - [~] 18.1 Implement the v1 export script
    - `supabase/seed/export-v1.js` reading products, quiz list, and questions from the v1 Web App endpoints with an admin token and writing `supabase/seed/v1-export.json`
    - _Requirements: 35.1, 35.2, 35.3_

  - [~] 18.2 Implement the idempotent importer
    - `supabase/seed/import.js` mapping v1 to v2 per the design's mapping table, expanding `unlock_scope` into `pack_quizzes` and printing the derived expansion before insert, using `on conflict do nothing` on slug and `(quiz_id, question_number)`, uploading material files to the private bucket recording `material_path` and thumbnails to the public bucket, and reporting per-table created counts and the uploaded-file count
    - _Requirements: 35.1, 35.2, 35.3, 35.4, 35.5, 35.6, 35.8, 35.9_

  - [ ]* 18.3 Write property test for the importer
    - **Property 35: The import maps v1 content faithfully and is idempotent**
    - **Validates: Requirements 35.1, 35.2, 35.3, 35.4, 35.6, 35.8**

  - [~] 18.4 Seed the test accounts
    - Create at least one test account holding one purchase enrollment and one comp enrollment so the browse, login, pay, enrol, open, take, and refer sequence is exercisable end to end
    - _Requirements: 35.7_

- [ ] 19. Documentation and final verification
  - [~] 19.1 Rewrite `SETUP.md`
    - Creating the Supabase project, applying the migration set, configuring custom SMTP with a named free-tier provider, creating both buckets, deploying each Edge Function, every environment variable by name with a placeholder and its dashboard location, registering the webhook URL, the sandbox verification sequence, the switch to live, the Free-tier pause and backup caveat with the Pro recommendation, and Google OAuth as an optional step
    - _Requirements: 2.4, 13.3, 13.6, 30.3, 30.4, 30.5, 36.1, 36.2, 36.3_

  - [~] 19.2 Rewrite `ADMIN_GUIDE.md` and `README.md`
    - Admin guide covering products, quizzes, questions, enrollments, referral payouts, incidents, and settings under the account-first model with the access-code instructions removed; README describing the v2 Supabase architecture and the retirement of the Apps Script backend; both recording that payouts are sent manually over GCash with zero automated disbursement
    - _Requirements: 24.6, 34.6, 36.4, 36.5, 36.6_

  - [ ]* 19.3 Write the secret scan and smoke check suites
    - Scan the front-end files and repository for every configured secret variable name and value; assert RLS is enabled per table, the seeded settings rows exist, the private bucket refuses an unsigned fetch, and `apps-script/` is excluded from the runtime
    - _Requirements: 18.1, 18.5, 28.3, 28.4, 30.1, 30.2, 35.9_

  - [ ]* 19.4 Write the sandbox integration tests
    - One to three examples each, run on demand: HitPay sandbox payment creation, a real signed webhook delivery through to the enrollment grant and referral row, OTP email delivery through SMTP, signed-URL expiry refusal, and the material upload path
    - _Requirements: 1.2, 1.3, 1.4, 12.1, 12.2, 13.6, 18.5, 30.3_

- [~] 20. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP. The money, RLS, and answer-key properties (1, 3, 4, 5, 13, 14, 15, 17, 18, 22) are the ones worth keeping even under time pressure, since they are the guarantees the requirements state as individually testable.
- Property tests use fast-check at 100 iterations, and 500 for properties 1, 3, 13, 14, 15, 17, 18, and 22 per the testing strategy. Each carries the tag comment naming the feature and property number.
- A failing property run's counterexample is recorded verbatim, not paraphrased.
- Layer 1 tests need a local Supabase instance (`supabase start`); the RLS properties must run against real Postgres.
- `apps-script/` is not edited by any task and stays excluded from the v2 runtime.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.4"] },
    { "id": 3, "tasks": ["2.3", "3.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6"] },
    { "id": 5, "tasks": ["2.5", "2.6", "3.7", "3.8", "3.9", "3.10", "3.11", "3.12", "3.13"] },
    { "id": 6, "tasks": ["5.1", "5.2", "7.1"] },
    { "id": 7, "tasks": ["5.3", "5.4", "5.5", "5.6", "5.7", "7.2", "7.3"] },
    { "id": 8, "tasks": ["7.4", "7.5", "8.1", "8.3", "9.1", "9.3", "9.6"] },
    { "id": 9, "tasks": ["8.2", "8.4", "9.2", "9.4", "9.5", "9.7", "11.1", "11.2", "11.4", "11.6", "11.7"] },
    { "id": 10, "tasks": ["11.3", "11.5", "11.8", "11.9", "11.10"] },
    { "id": 11, "tasks": ["12.1", "12.2", "12.5"] },
    { "id": 12, "tasks": ["12.3", "12.4", "12.6", "12.10"] },
    { "id": 13, "tasks": ["12.7", "12.8", "12.11"] },
    { "id": 14, "tasks": ["12.9", "13.1", "13.2", "13.5"] },
    { "id": 15, "tasks": ["13.3", "13.4", "13.6", "14.1", "14.3", "14.5"] },
    { "id": 16, "tasks": ["14.2", "14.4", "14.6", "14.7", "16.1"] },
    { "id": 17, "tasks": ["16.2", "16.3", "18.1"] },
    { "id": 18, "tasks": ["16.4", "17.1", "18.2"] },
    { "id": 19, "tasks": ["17.2", "18.3", "18.4"] },
    { "id": 20, "tasks": ["17.3", "19.1"] },
    { "id": 21, "tasks": ["19.2", "19.3"] },
    { "id": 22, "tasks": ["19.4"] }
  ]
}
```
