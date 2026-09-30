# Platform v2 — Account-First Learning Platform on Supabase (Build Specification)

> **Audience:** AI coding agent (Kiro / Claude Opus 4.8). This is a **v2 re-architecture** of the ArchPrep PH backend, auth, and purchase model. The owner has explicitly chosen this direction and accepts that parts of v1 are rebuilt. Read this fully before coding, then give a build plan.
>
> **What carries over from v1:** the front-end pages, the design system (`styles.css`), the content (quizzes/questions/products), the admin portal's *form UX*, and all copy/branding. **What changes:** the backend and database move from Google Apps Script + Sheets to **Supabase**; access becomes **account-based** (login-first, Udemy-style); payments become **automatic via the HitPay API + webhooks** instead of manual code emailing.

---

## 1. Goal — the model, in plain terms

Build a Udemy-style learning platform:

- Anyone can **browse the full catalog without logging in** (all courses/quiz packs/materials are visible, with prices).
- Clicking **Buy/Enrol requires logging in** (passwordless). After login the user returns to complete the purchase; the catalog still shows everything — but now it's "their platform," with their name/email and an account menu in the top corner.
- Paying with **GCash / QR Ph** (via HitPay) **automatically unlocks** the item in the user's account the moment payment is confirmed — no access codes, no manual emails.
- Everything a user buys lives in their account permanently and is accessible any time they log in ("My Learning").
- **Login is required to open or take any material or quiz.**
- A referral program (from the prior referral spec) rides on top, now database-backed and auto-attributed on confirmed payment.

---

## 2. Architecture

```
Front-end (static site on Cloudflare Pages, restyled)
   │  supabase-js (auth + reads allowed by RLS)      │  fetch() to Edge Functions (privileged ops)
   ▼                                                 ▼
Supabase
   ├─ Auth            passwordless email OTP (+ optional Google later); issues JWT sessions
   ├─ Postgres + RLS  profiles, products, orders, enrollments, quizzes, questions(protected),
   │                  quiz_attempts, referrals, settings
   ├─ Storage         private bucket for material files; access via signed URLs gated by enrollment
   └─ Edge Functions  create-payment, hitpay-webhook, get-quiz, grade-quiz, issue-material-url,
                      admin-* (privileged writes)
                      │
HitPay API  ◄── create payment request / receive HMAC-verified webhook ──►  (GCash, QR Ph)
```

- The browser talks to Supabase directly for **auth** and for **reads that RLS permits** (e.g. the public catalog, the user's own purchases). Anything privileged or secret — creating a payment, handling the webhook, reading quiz answers, grading, minting a material download URL, admin writes — goes through **Edge Functions** that hold secrets and use the service role.
- Secrets (HitPay API key + webhook salt, service-role key, SMTP creds) live only in Edge Function environment variables, never in the client.

---

## 3. Cost (keep it near-zero; this is a hard constraint)

- Supabase **Free** to start ($0): Postgres, Auth (50k monthly active users), Storage, Edge Functions. Note: free projects **pause after 7 days of inactivity** and have no automated backups — document that the owner should move to **Pro ($25/mo)** once there are real paying users (removes the pause, adds capacity). Do not assume Pro; build to run on Free.
- Cloudflare Pages hosting: free.
- HitPay: no monthly/setup fee; per-transaction only (~2.3% GCash, ~1% QR Ph). API + webhooks included.
- **Auth email:** Supabase's built-in email is rate-limited for testing only. For production, configure **custom SMTP** using a free-tier transactional email provider (e.g. Brevo/Resend/SendGrid free tier) for the login OTP emails. Document this in SETUP. Do not build a custom email service.
- No other paid services. No new servers.

---

## 4. Authentication (passwordless, Supabase Auth)

- Use **Supabase Auth email OTP** (6-digit code or magic link — pick OTP for a fast Udemy-like flow) as the login. **No passwords anywhere.** Same one flow serves signup and login (first login creates the account; a `profiles` row is created via a trigger).
- Optional, recommended for low-friction signup: enable **Google sign-in** (Supabase OAuth). It needs Google OAuth credentials in setup; make it a documented optional toggle, not a hard dependency.
- Sessions are Supabase JWTs managed by `supabase-js` (persisted, auto-refreshed). The front-end uses the session to gate UI and to call Edge Functions (which verify the JWT).
- On the server side, every Edge Function that acts for a user **verifies the Supabase JWT** and derives the user id from it — never trusts a user id sent from the client.
- Configure custom SMTP (Section 3) so OTP emails send reliably at volume.

---

## 5. Data model (Postgres) + Row-Level Security

Create these tables. **Enable RLS on every table** and add the policies described. RLS is the core security guarantee — get it right.

### `profiles`
`id (uuid, = auth.uid())`, `email`, `display_name`, `is_admin (bool, default false)`, `ref_code (unique)`, `referred_by (ref_code, nullable)`, `gcash_number (nullable)`, `created_at`.
- Created automatically on signup via a trigger from `auth.users`.
- RLS: a user can `select`/`update` **only their own** row (`id = auth.uid()`); `is_admin` is not user-updatable (only via service role). No public read.

### `products`  (the sellable catalog items — courses / quiz packs / materials)
`id`, `slug (unique)`, `type ('material' | 'quiz_pack')`, `subject`, `title`, `subtitle`, `description`, `price_php (int)`, `currency ('PHP')`, `thumbnail_path`, `includes (jsonb: what's inside)`, `published (bool)`, `sort_order`, `created_at`.
- RLS: **public read where `published = true`** (anon + authenticated). Writes: admin only (service role via admin Edge Functions).
- A quiz-pack product maps to one or more `quizzes` (see `pack_quizzes`).

### `pack_quizzes`  (which quizzes belong to a quiz-pack product)
`product_id`, `quiz_id`. RLS: public read for published packs.

### `quizzes`
`id`, `slug`, `title`, `subject`, `timer_minutes (int, 0 = none)`, `published (bool)`, `created_at`.
- RLS: public read of **metadata** for published quizzes (title, subject, timer, question count) — but questions/answers are NOT here.

### `questions`  (answers protected)
`id`, `quiz_id`, `question_number`, `question_text`, `options (jsonb: [{key,label}])`, `correct_key`, `explanation`, `created_at`.
- **RLS: NO select policy for anon or authenticated roles.** This table is readable **only by the service role** (Edge Functions). The browser can never read `correct_key`/`explanation`. Questions reach students only via the `get-quiz` Edge Function (answers stripped) and are graded by `grade-quiz`.

### `orders`
`id`, `user_id`, `product_id`, `amount_php`, `currency`, `status ('pending'|'paid'|'failed'|'refunded')`, `hitpay_payment_id (unique, nullable)`, `hitpay_reference`, `ref_code (nullable, referral captured at checkout)`, `created_at`, `paid_at`.
- RLS: a user can `select` **only their own** orders. Inserts/updates: service role (Edge Functions) only. The unique `hitpay_payment_id` enforces webhook idempotency.

### `enrollments`  (what a user owns / can access)
`id`, `user_id`, `product_id`, `source ('purchase'|'comp'|'credit')`, `order_id (nullable)`, `created_at`.
- RLS: a user can `select` **only their own** enrollments. Inserts: service role only (created by the webhook, or by an admin "grant access" action).
- Access to any material/quiz is checked against this table server-side.

### `quiz_attempts`
`id`, `user_id`, `quiz_id`, `score`, `total`, `answers (jsonb)`, `created_at`.
- RLS: user can `select`/`insert` **only their own**. (Insert also happens via `grade-quiz` service role; choose one path and keep answers/grading server-authoritative.)

### `referrals`  (ledger)
`id`, `referrer_ref_code`, `referrer_user_id`, `buyer_user_id`, `order_id (unique)`, `product_id`, `amount_php`, `reward_type ('cash'|'credit')`, `status ('available'|'paid'|'void')`, `created_at`, `paid_at`, `notes`.
- RLS: a referrer can `select` their own ledger rows (buyer identity masked in the API response). Writes: service role only. `order_id` unique → idempotent attribution.

### `settings`  (key/value; admin-editable config)
`key`, `value`. Holds referral config (`referral_amount` default 9, `reward_type` default `cash`, `payout_threshold` default 100, `reward_on` default `every_purchase`), brand/contact/hero copy, etc. RLS: public read of display-safe keys; writes admin only.

**Admin policies:** an authenticated user with `profiles.is_admin = true` may perform admin reads; all admin *writes* go through `admin-*` Edge Functions using the service role (do not rely solely on client-side admin flags). Enforce admin in the Edge Function by checking `is_admin` for the caller's verified uid.

---

## 6. Security model (the professional guarantee)

- **RLS on every table**, default-deny; users reach only their own rows; catalog is the only broadly public read (published only).
- **Quiz answers never leave the server:** `questions` has no client select policy; only `get-quiz` (answers stripped) and `grade-quiz` (server-side grading) expose questions, and only to enrolled users.
- **Access is enforced server-side:** opening a material or starting a quiz requires a verified JWT **and** a matching `enrollments` row, checked in the Edge Function — never trusted from the client.
- **Secrets only in Edge Functions** (HitPay key/salt, service role, SMTP). Never in the browser bundle.
- **Webhook authenticity:** verify HitPay's HMAC-SHA256 signature on every webhook before acting; ignore unverified calls.
- **Idempotency:** unique `hitpay_payment_id` on orders and unique `order_id` on referrals prevent double-processing / double-payout.
- **Output safety:** render dynamic content with `textContent`.
- **Money integrity:** amounts, enrollment grants, and referral eligibility are computed server-side from the DB, never from client input.

---

## 7. Payment flow (HitPay API + webhook — this is what makes it automatic)

Use HitPay's REST API and webhook confirmation (HMAC-SHA256 verified). Build a **sandbox → production** path and test in sandbox first.

1. **create-payment (Edge Function, JWT-verified):** input `product_id` (+ the captured `ref_code` if any). Server looks up the product price (never trust a client price), creates an `orders` row `status='pending'`, calls the HitPay API to create a payment request for that PHP amount with GCash + QR Ph enabled, stores the returned reference, and returns the **checkout URL**. The front-end redirects the user to HitPay.
2. Customer pays on HitPay (GCash / QR Ph).
3. **hitpay-webhook (Edge Function, public endpoint):** HitPay POSTs on completion. **Verify the HMAC signature** using the webhook salt. If valid and status is completed: look up the order by HitPay payment id, set `status='paid'` + `paid_at`, and — idempotently (unique `hitpay_payment_id`) — **create the `enrollments` row(s)** granting access, then run **referral attribution** (Section 9). Return 200.
4. The user is redirected back to a "You're enrolled" page; because the webhook already granted access, the item now appears in **My Learning** immediately (the page can poll the order/enrollment briefly if the redirect beats the webhook).

Document the HitPay setup in SETUP: get API key + salt from the HitPay dashboard, register the production webhook URL (the Edge Function URL), and use the correct HitPay base URL/environment. Reference HitPay's official API docs for exact endpoints and the current base URL — do not hardcode a guessed URL.

---

## 8. Content delivery (protected, automatic)

- **Materials:** store files in a **private Supabase Storage bucket**. To open a material, the front-end calls **issue-material-url (Edge Function, JWT-verified)** which checks the user's `enrollments`, and if valid returns a **short-lived signed URL** to the file. Files are never public and never shared manually. (Migration: upload the existing Drive PDFs into the bucket.)
- **Quizzes:** `get-quiz (Edge Function)` verifies JWT + enrollment, returns the quiz's questions **with options but without `correct_key`/`explanation`**. `grade-quiz (Edge Function)` verifies JWT + enrollment, grades server-side against `questions`, records a `quiz_attempts` row, and returns score + per-question correctness + explanations. Timer comes from `quizzes.timer_minutes`.
- Access codes from v1 are **replaced by account-linked enrollments.** Keep an admin **"grant access"** action (creates a `comp`/`credit` enrollment) for freebies, support, or credit redemption.

---

## 9. Referral program (now DB-backed, auto-attributed)

Carry over the rules from the referral spec, adapted to Postgres:

- Each `profiles` row has a unique `ref_code`; the referral link is `https://<site>/?ref=<ref_code>`. On load, capture `?ref` to `localStorage` (first-touch, 30-day). Carry it into `create-payment` so it lands on the `orders` row.
- **Attribution runs in the webhook** when an order is confirmed paid: if the order has a valid `ref_code`, the referrer exists and isn't the buyer (self-referral guard), and no `referrals` row exists for this `order_id` (idempotent), insert a `referrals` row `status='available'`, amount = `settings.referral_amount` (default ₱9), `reward_type` per config. Optionally honor `reward_on = first_purchase_only`.
- **Student dashboard** ("Earnings"): shows referral link, referrals (buyer masked), and available/paid balance; in cash mode a payout request at/above `payout_threshold` (default ₱100) with GCash number; in credit mode the redeemable balance.
- **Admin:** view balances/ledger, mark paid (after manual GCash payout or credit fulfillment), void on refund. Config (amount, reward type, threshold, reward scope) editable in Settings.
- Payout money movement stays **manual** (admin sends GCash); only the tracking is automated. No automated disbursement.

---

## 10. The Udemy-style front-end (UX)

Reuse the pages/design system; restructure the flows:

- **Public catalog:** home + a courses/catalog page show all published products with clean **course cards** (thumbnail, title, subtitle, subject, price, what's included). No login needed to browse.
- **Login gate on purchase:** clicking Buy/Enrol when logged out routes to a passwordless login (email → code), then returns the user to complete checkout. Don't force login just to browse.
- **Logged-in shell ("your platform"):** a top bar showing the user's name/email and an **account menu** (My Learning, Earnings/Referrals, Account settings, Log out). Catalog still fully visible.
- **My Learning:** the user's owned items — materials (open → signed URL) and quizzes (open → take). This is the home base after login.
- **Quiz-taking:** one question at a time, progress bar, optional timer (from `timer_minutes`), review screen, submit → results with score + explanations. Answers only ever arrive at grade time.
- **Referral entry points:** on My Learning and after a purchase, invite sharing the referral link.
- **Fix contradictory copy:** the current site says "no account to create" and "materials delivered by email" — update all such copy to reflect the account-first, instant-access model.

---

## 11. Design & professional finishing (make it feel like a real platform)

Aim for **clean, fast, content-first, trustworthy** — the Udemy kind of professional, not flashy.

- Strong, consistent type scale and spacing (8px system); generous whitespace; clear visual hierarchy; obvious primary CTAs.
- Polished **course-card grid**, a proper **My Learning dashboard**, clear pricing and "what's included," and trust signals (real testimonials once available, clear refund/delivery info, secure-payment note).
- Keep the existing palette (terracotta/slate/off-white) and fonts (Fraunces + Manrope) for brand continuity, applied consistently.
- **Recommendation:** significantly tone down or remove the heavy 3D/WebGL hero and motion effects from v1 in favor of a fast, calm, professional layout. Reserve motion for small, tasteful touches. Prioritize load speed and clarity on mobile (most users are on phones). Respect `prefers-reduced-motion`.
- Every state designed: loading, empty ("You haven't enrolled in anything yet"), and error.

---

## 12. Migration & seed

- Move existing `products`, `quizzes`, and `questions` from the v1 Google Sheet into Supabase tables (a one-time import script, or re-entry via the admin portal). Preserve the sample quizzes so the flow is testable.
- Upload existing material files from Drive into the private Storage bucket and link them to products.
- Provide seed data + a couple of test accounts so the full flow (browse → login → sandbox-pay → enrol → open/take → referral) can be exercised end-to-end.

---

## 13. Admin (on Supabase)

Keep a **custom admin portal** (the v1 form UX is good), now backed by Supabase with an admin role:

- Admin identity = `profiles.is_admin = true`; all admin **writes** go through `admin-*` Edge Functions that verify the caller is admin (service role performs the write).
- Manage: products (create/price/publish, upload thumbnails + material files to Storage), quizzes + questions (with correct answers + explanations, per-quiz timer), enrollments (grant/revoke access, for comps/credit), referrals (balances, mark paid, void), and settings/config.
- Reuse existing guided forms, confirmations, toasts, empty states.
- (Supabase Studio's table editor exists as a fallback, but the owner should use the custom portal.)

---

## 14. Definition of done

- [ ] Anyone can browse the full published catalog without logging in.
- [ ] Buying requires passwordless login; after login the user completes checkout and the catalog still shows everything, with their name/email + account menu visible.
- [ ] Paying via HitPay (sandbox then live) triggers the HMAC-verified webhook, which idempotently creates the enrollment; the item appears in My Learning automatically with no codes or manual email.
- [ ] Materials open via short-lived signed URLs gated by enrollment; files are never public.
- [ ] Quizzes: questions reach the browser without answers; grading is server-side; results show score + explanations; timer from `timer_minutes`.
- [ ] RLS verified: a logged-in user cannot read another user's profile/orders/enrollments/attempts, and no client role can read `questions.correct_key` (add tests).
- [ ] Referral attribution runs on confirmed payment, idempotent, with self-referral/void guards; dashboard + admin payout tracking work; config-driven.
- [ ] Login-first enforced: no material/quiz opens without a valid session + enrollment.
- [ ] Runs on Supabase Free; SMTP configured for auth email; secrets only in Edge Functions.
- [ ] Clean, professional, mobile-first finishing; contradictory v1 copy fixed; all states designed.
- [ ] Docs updated (SETUP with Supabase + HitPay API + webhook + SMTP setup; ADMIN_GUIDE for the new model; README noting the v2 architecture).

---

## 15. Out of scope / guardrails

- No passwords (passwordless only). No storing card data (HitPay handles payment).
- No automated cash disbursement (referral payouts recorded, paid manually by admin).
- No paid services beyond the optional Supabase Pro upgrade when scaling.
- Do not expose secrets or the service-role key to the client. Do not bypass RLS from the client.

---

## 16. Build order (stages, each testable)

1. Supabase project + schema + RLS + `profiles` trigger; passwordless auth working end-to-end on the front-end (login/logout, account menu).
2. Catalog from `products` (public browse) + course cards; My Learning shell.
3. HitPay integration: `create-payment` + `hitpay-webhook` (sandbox), enrollment on confirmed payment, "You're enrolled" flow.
4. Content delivery: `get-quiz` + `grade-quiz` + `issue-material-url`; quiz-taking + material opening gated by enrollment.
5. Referral system (capture → attribution in webhook → dashboard → admin payouts).
6. Admin portal on Supabase (products/quizzes/questions/enrollments/referrals/settings).
7. Migration/seed, professional design pass, docs, tests. Then switch HitPay from sandbox to live.

Before coding, give a short build plan and confirm the RLS/answer-key approach and the webhook idempotency plan. Ask a concise question only if an ambiguity affects security or money handling.
