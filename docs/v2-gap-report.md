# v2 gap report: BACKEND_RULES.md vs the current repo

Status: **waiting for owner OK** before Phase 1.
Baseline: `main` @ 0277f7d, plus uncommitted migration tooling (`supabase/scripts/`). The 138 tests pass.
Legend: ✅ exists · 🔧 must change · 🆕 new

## 0. Golden rules
| Rule | Today | Gap |
|---|---|---|
| Server decides money/access | ✅ `create-payment` computes the price; `grade-quiz` grades server-side | 🔧 Coupons, attempts and deposits will follow the same pattern |
| One transaction per money/access op | ✅ `fulfil_payment`, `refund_payment`, `fail_payment` (0011–0012) | 🔧 Rewrite as `fulfil_order` and add `approve/reject_deposit`, `start/submit_attempt`, `request_payout`, `refund_order` |
| Idempotent | ✅ unique `hitpay_payment_id`, unique `referrals.order_id`, status guards | 🆕 `payment_events.provider_event_id` unique; partial unique index on active enrollments |
| Recoverable (timeouts, repair jobs) | ❌ no background jobs | 🆕 pg_cron jobs: reconciliation 5 min, auto-submit 1 min, expiry nightly, session cleanup, outbox sender |
| Snapshot at purchase | 🔧 the order stores `amount_php` + `ref_code` only | 🆕 `price_php, discount_php, coupon_id, total_php, referrer_user_id, access_snapshot` |
| Side effects after commit (outbox) | ❌ | 🆕 `outbox` table + sender worker, 3 retries |
| Audit everything | 🔧 only `payment_incidents` | 🆕 append-only `audit_log` (no UPDATE/DELETE for any role) |
| Email only | ✅ no SMS code exists | — |

## 1. Products & pricing
- 🔧 The `product_type` enum is `material | quiz_pack`. It needs to become `material | quiz | mock | free`.
- 🔧 `price_php > 0` must allow 0 for `free`.
- 🔧 `published bool` becomes `status draft|published|unpublished`.
- 🆕 `attempts_per_purchase`, `access_mode`, `updated_at`.
- 🔧 Subject is free text today. It needs to become `'A'|'B'|'ALL'` (no C).
- 🆕 `settings.exam_date`. Changing it shifts the expiry of active material enrollments, in one transaction and audited.
- ✅ Unpublish already hides a product from the catalog (RLS `products_select_published`).

## 2. Ownership & re-buying
- 🔧 `enrollments` has `unique(user_id, product_id)`, which blocks re-buying forever. Replace it with a partial unique index `WHERE status='active'` plus `unique(order_id, product_id)`.
- 🆕 `attempts_allowed, attempts_used, expires_at, status active|ended|revoked`.
- 🆕 `ALREADY_OWNED` check in `create-payment` (today a re-buy creates a payable order).

## 3. Auth & sessions (largest behaviour change)
- 🔧 `js/supabase.js` uses `persistSession: true`. The rules require `false`, which **reverses the v2.1 "persistent login" change.** BACKEND_RULES wins.
- 🔧 `config.toml` has `otp_expiry = 3600`; it must be 600.
- 🆕 OTP limits: 5 sends/hour per email and per IP, and a 15-min lock after 5 wrong codes. Supabase can't count wrong codes per email, so send and verify will go through a new `auth-otp` Edge Function. The same function gives admins the "same response, no code sent" behaviour.
- 🆕 First-login signup:
  - `display_name` required; `mobile` required (format `09XXXXXXXXX`; it replaces `gcash_number`).
  - `consents(user_id, type, version, accepted_at)` table.
- 🆕 `sessions` table, 60s heartbeat, 30-min idle, block a second login, admin "End session" (E9).
  - Edge Functions will refuse requests from a session that isn't the user's active one.
  - Plain RLS reads (catalog, own orders) can't see sessions. That's acceptable because they expose nothing beyond the user's own rows.
- 🆕 `admins` table. It replaces `profiles.is_admin` and `admin_bootstrap_emails`, with an 8h idle limit for admins.
- 🆕 Email change via OTP to the new address. Supabase's `double_confirm_changes` already does this.

## 4. Orders & payments
- 🔧 **HitPay → PayMongo.** Replace `_shared/hitpay.{ts,mjs}`, `hitpay-webhook`, the HitPay parts of `create-payment` and their tests (`hitpay.test.mjs`, `webhook-dispatch.test.mjs`). HitPay code is removed rather than kept beside PayMongo.
- 🔧 Order ids change from uuid to `AP-xxxxx` (sequence).
- 🔧 Statuses change from `pending|paid|failed|refunded` to `created|awaiting_payment|awaiting_proof|pending_approval|on_hold|paid|failed|expired|refunded`.
- 🆕 `method`, `provider_ref`, `expires_at`, `payment_events`, `order-status` endpoint, confirming-page polling.
- 🔧 `payment_incidents` becomes `incidents` (amount mismatch → `on_hold`).

## 5. Bank deposits: 🆕 entirely
`bank_deposits` table, private `deposit-proofs` bucket, `submit-bank-proof`, `admin-deposits` (approve/reject guarded by `WHERE status='pending_approval'`), duplicate detection (`reference_no` per bank, `proof_sha256`), and the over/underpaid → `balance_ledger` credit. Also the SLA alert at upload, a reminder at 12h and an overdue badge at 24h.

## 6. Coupons: 🆕 entirely
`coupons` with reserve / release / convert-to-use. They stack with referrals.

## 7. Referrals & balance
- ✅ First-touch `?ref=` capture with a 30-day TTL (`js/referral.js`, localStorage), ₱9 setting, self-referral check constraint.
- 🔧 `0013_referral_bind_on_signup` **does not exist in this repo.** Today the ref code is sent per order and never bound to the profile. Phase 1 will add the bind-at-signup logic as a new migration.
- 🔧 Self-referral today blocks only the same user id. Add same email and same mobile.
- 🆕 `balance_ledger` replaces the status-based balance.
  - `referrals.status available|paid|void` maps to ledger rows (available→`referral`, paid→`payout`).
  - `payout_requests` becomes `payouts`, with a negative ledger row in the same transaction.
- 🔧 `js/earnings.js` statuses become Available / Redeemed / Void.

## 8. Exams & attempts
- 🔧 `quiz_attempts` is written once at grading.
- 🆕 `attempts` (`started_at, ends_at, status, question_ids` snapshot) and `attempt_answers` (autosave, flags).
- 🆕 `start-attempt`, `save-answer`, `submit-attempt` replace `get-quiz` / `grade-quiz`.
- 🔧 `questions` gains `version, topic, status`, and `correct_key` becomes `correct_index`. Editing a question creates a new version.
- ✅ The answer-key lockdown (0006) and `answered_only` reveal are kept.
- 🆕 Public leaderboard (best attempt per user per quiz). It needs a definer function, since anon can't read profiles today.
- 🆕 Passing rule display, E10.

## 9. Materials viewer
- 🔧 `issue-material-url` signs the **whole file** today, so the student gets a downloadable PDF.
- 🆕 Per-page images with ≤5 min signed URLs and a watermark overlay. Edge Functions can't render PDFs, so **proposal: the admin portal renders pages in the browser (PDF.js) at upload and stores PNGs in the private bucket.** PPTX must be exported to PDF before upload.

## 10. Refunds & issues
- ✅ `refund_payment` exists.
- 🔧 Extend it: void the reward through the ledger and revoke the enrollment only if this order granted it.
- 🆕 PayMongo refund API, student `issues` with proof upload, admin Manual fulfil with a required reason.

## 11. Admin portal
`admin.html` + `js/admin.js` (1,174 lines) + `js/admin/*` have products, quizzes, questions, enrollments, referrals, settings and incidents. 🆕 Overview, Orders + timeline, Bank deposits, Coupons, Students & sessions, Audit log, CSV import (500 rows, drafts, one transaction). 🔧 Settings keys extend `0004_settings_seed`.

## 12. Emails
🆕 Outbox + 12 templates. E1 (login code) is the Supabase Auth email template; E2–E12 go through the outbox sender. **The sender needs an email API key** (SETUP.md already suggests Resend).

## 13. Security & ops
- ✅ RLS on every table, a 280-check verify script, and secrets kept only in function env.
- 🆕 Rate limits on public endpoints, webhook/job failure alerts, a staging project, and data export/delete by email (manual at launch).

## 14. Acceptance tests
- ✅ 138 Node unit tests exist today (HMAC, CORS, auth gate, payload scrubbing).
- 🆕 The 12 acceptance tests need a real Postgres. Phase 7 will run them against the Docker `supabase/postgres` image already used to test the migrations.

---

## Conflicts found in the handoff itself
1. The student prototype's bank-deposit copy says "You'll get an email **or SMS**". The rules say email only, so the UI copy will say email.
2. The student prototype still shows "Credit for courses you own / upgrade price" lines. The rules say no upgrade pricing, so they'll be dropped.
3. The admin Settings prototype shows `expiry_reminder_days`, `reward_type` and `coupon_stack_referral`, which §11 doesn't list. They'll be display-only unless you want them live.
4. §4 step 1 of `fulfil_order` allows `pending_approval`, but that is the bank-deposit state, which goes through `approve_deposit`. Plan: `approve_deposit` calls `fulfil_order`, so both paths share one grant function.
5. Percent coupons on ₱49 give fractional pesos (10% = ₱4.90; the prototype shows ₱5). Plan: **round the discount to the nearest peso.**

## Migration strategy
"Never edit old migrations" means 0001–0012 stay as they are, and v2 is **new migrations 0013+** that transform existing rows (e.g. `quiz_pack`→`quiz`, referral statuses → ledger rows, `payout_requests` → `payouts`). The live project currently holds only test data, but the transform path is written anyway so it is safe either way.
