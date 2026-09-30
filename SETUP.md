# SETUP.md — ArchPrep PH v2 Deployment Guide

Complete first-time setup: Supabase database, Edge Functions, HitPay payments, and Cloudflare Pages.
Follow every step in order. You can stop and come back anytime.

**Owner accounts bootstrapped as admins:**
- `rehinaneel@gmail.com`
- `nairutya.84@gmail.com`

---

## Overview

| Layer | Technology | Cost |
|---|---|---|
| Database + Auth | Supabase (free tier) | Free |
| Backend functions | Supabase Edge Functions (Deno) | Free |
| File storage | Supabase Storage | Free (1 GB) |
| Website hosting | Cloudflare Pages | Free |
| Payments | HitPay | 0% fee (GCash) |

---

## Part 1 — Supabase project

### 1.1 Create the project

1. Go to [supabase.com](https://supabase.com) and sign up / log in.
2. Click **New project**.
3. Set:
   - **Name**: `archprep-ph`
   - **Database password**: generate a strong one and save it somewhere safe
   - **Region**: Southeast Asia (Singapore) — closest to Philippines
4. Wait ~2 minutes for provisioning.

### 1.2 Copy your project credentials

In your project, go to **Project Settings → API**. You need:

| Value | Where to find it |
|---|---|
| **Project URL** | "Project URL" field — looks like `https://XXXX.supabase.co` |
| **anon/public key** | Under "Project API keys" → `anon` `public` |
| **service_role key** | Under "Project API keys" → `service_role` **Keep this secret — never put in frontend code** |

Keep this tab open.

---

## Part 2 — Database migrations

You need to run 12 migration files in exact order. Open **SQL Editor** in your Supabase dashboard (left sidebar).

For each file below, click **New query**, paste the entire file content, click **Run**:

| Order | File |
|---|---|
| 1 | `supabase/migrations/0001_schema_core.sql` |
| 2 | `supabase/migrations/0002_schema_money.sql` |
| 3 | `supabase/migrations/0003_functions_triggers.sql` |
| 4 | `supabase/migrations/0004_settings_seed.sql` |
| 5 | `supabase/migrations/0005_rls_baseline.sql` |
| 6 | `supabase/migrations/0006_rls_questions_lockdown.sql` |
| 7 | `supabase/migrations/0007_rls_profiles.sql` |
| 8 | `supabase/migrations/0008_rls_catalog.sql` |
| 9 | `supabase/migrations/0009_rls_owner_scoped.sql` |
| 10 | `supabase/migrations/0010_rls_settings.sql` |
| 11 | `supabase/migrations/0011_fn_fulfil_payment.sql` |
| 12 | `supabase/migrations/0012_fn_refund_fail_payment.sql` |

> **Tip:** If a migration fails, do not skip it — fix the error and re-run before proceeding.

### 2.1 Bootstrap admin accounts

After all migrations run, go to **SQL Editor** and run:

```sql
-- The owner emails. These profiles are created automatically on first sign-in;
-- this query marks them as admin once they exist.
-- Run this AFTER both owners have signed in at least once.
UPDATE profiles SET is_admin = true
WHERE email IN ('rehinaneel@gmail.com', 'nairutya.84@gmail.com');
```

> The `admin_bootstrap_emails` table (created in migration 0001) is also checked
> during profile creation — so if you run the migration before signing in, the
> trigger will automatically set `is_admin = true` when those emails first sign in.

---

## Part 3 — Storage buckets

In your Supabase dashboard, go to **Storage** (left sidebar).

### 3.1 Create two buckets

Click **New bucket** for each:

| Bucket name | Public? | Use |
|---|---|---|
| `thumbnails` | **Yes** (public) | Product card images |
| `materials` | **No** (private) | Downloadable review materials (PDF, PPTX) |

### 3.2 Storage policies

The RLS migrations already added policies for the `materials` bucket.
For the `thumbnails` bucket (public), no extra policy is needed.

---

## Part 4 — Email (SMTP for OTP codes)

By default, Supabase sends OTP emails through their shared SMTP.
For production, configure a custom SMTP so emails land in inboxes reliably.

### 4.1 Option A — Resend (recommended, free 3000 emails/month)

1. Sign up at [resend.com](https://resend.com).
2. Add your domain or use the free `@resend.dev` address for testing.
3. Create an API key.
4. In Supabase: **Project Settings → Auth → SMTP Settings**.
5. Toggle **Enable custom SMTP** on.
6. Fill in:
   - **Host**: `smtp.resend.com`
   - **Port**: `465`
   - **User**: `resend`
   - **Password**: your Resend API key
   - **Sender email**: `noreply@yourdomain.com` (or your Resend test address)
   - **Sender name**: `ArchPrep PH`

### 4.2 OTP email template (optional customization)

In Supabase: **Authentication → Email Templates → Magic Link / OTP**.
You can customise the subject and body. Default template works fine.

---

## Part 5 — Edge Functions

### 5.1 Install the Supabase CLI

```bash
npm install -g supabase
supabase login
```

### 5.2 Link your project

In the project root directory (where `supabase/` folder is):

```bash
supabase link --project-ref YOUR-PROJECT-REF
```

Replace `YOUR-PROJECT-REF` with the ref from your project URL
(e.g. if URL is `https://abcdefgh.supabase.co`, the ref is `abcdefgh`).

### 5.3 Set Edge Function secrets

Run each of these (replace the placeholder values):

```bash
# Your Supabase service-role key (from Part 1.2)
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="eyJhbGci..."

# HitPay API key (from your HitPay dashboard → API Keys)
supabase secrets set HITPAY_API_KEY="your-hitpay-api-key"

# HitPay webhook salt (from HitPay dashboard → Payment Buttons → Webhook)
supabase secrets set HITPAY_WEBHOOK_SALT="your-hitpay-webhook-salt"

# Supabase JWT secret (from Project Settings → API → JWT Settings → JWT Secret)
supabase secrets set SUPABASE_JWT_SECRET="your-jwt-secret"
```

> **Important:** The `SUPABASE_URL` and `SUPABASE_ANON_KEY` are automatically
> injected into Edge Functions by Supabase — you do **not** need to set them.

### 5.4 Deploy all Edge Functions

```bash
supabase functions deploy
```

This deploys all functions defined in `supabase/functions/` at once.
It reads the JWT settings from `supabase/config.toml` automatically.

Verify deployment: in your Supabase dashboard, go to **Edge Functions** — you should
see 15 functions listed, all with a green "Active" status.

---

## Part 6 — HitPay setup

### 6.1 Create a HitPay account

1. Go to [hitpay.com](https://hitpay.com) and sign up for a business account.
2. Complete KYC verification (required for live payments).
3. Enable **GCash** and **QR Ph** as payment methods.

### 6.2 Sandbox testing (before going live)

HitPay provides a sandbox environment at [dashboard.sandbox.hit-pay.com](https://dashboard.sandbox.hit-pay.com).
Use sandbox keys while testing — no real money moves.

Update your secrets to sandbox values:
```bash
supabase secrets set HITPAY_API_KEY="sandbox-key-here"
supabase secrets set HITPAY_SALT="sandbox-salt-here"
```

Also update `supabase/functions/_shared/hitpay.ts` — the `HITPAY_BASE` constant:
- Sandbox: `https://api.sandbox.hit-pay.com/v1`
- Live:    `https://api.hit-pay.com/v1`

### 6.3 Configure the webhook

In your HitPay dashboard → **Settings → Payment Buttons / API → Webhook**:

- **Webhook URL**: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/hitpay-webhook`
- **Copy the salt** shown — you already set it as `HITPAY_SALT` above.

### 6.4 Switch to live keys

When ready to accept real payments:

1. Get your live API key from the HitPay live dashboard.
2. Update secrets:
   ```bash
   supabase secrets set HITPAY_API_KEY="live-key"
   supabase secrets set HITPAY_WEBHOOK_SALT="live-salt"
   ```
3. Update `HITPAY_BASE` in `hitpay.ts` to the live URL.
4. Re-deploy: `supabase functions deploy hitpay-webhook create-payment`

---

## Part 7 — Website (Cloudflare Pages)

### 7.1 Update config.js

Open `config.js` in the project root. Replace the placeholder values with your real credentials:

```js
window.APP_CONFIG = {
  SUPABASE_URL:      'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGci...',  // anon/public key from Part 1.2
};
```

> **Never** put the `service_role` key in `config.js` — it's frontend-visible.

### 7.2 Deploy to Cloudflare Pages

1. Push your code to a GitHub repository (if you haven't already):
   ```bash
   git add .
   git commit -m "v2: Supabase-native platform"
   git push origin main
   ```
2. Go to [pages.cloudflare.com](https://pages.cloudflare.com) and sign up / log in.
3. Click **Create a project → Connect to Git**.
4. Select your GitHub repository.
5. Build settings:
   - **Framework preset**: None
   - **Build command**: *(leave empty)*
   - **Build output directory**: `/` (root)
6. Click **Save and Deploy**.

### 7.3 Add your custom domain (optional)

In Cloudflare Pages → your project → **Custom domains** → **Set up a custom domain**.
Follow the DNS setup instructions.

### 7.4 Add the site URL to Supabase Auth

In Supabase: **Authentication → URL Configuration**:
- **Site URL**: `https://your-domain.com` (or your `.pages.dev` URL)
- **Redirect URLs**: add `https://your-domain.com/*`

This is required for OTP email links to work correctly.

---

## Part 8 — First-run checklist

Work through this after everything is deployed:

- [ ] **Sign in** at your live URL — you should receive a 6-digit OTP email
- [ ] **Admin access** — sign in as `rehinaneel@gmail.com`, visit `/admin.html` — you should see the admin portal
- [ ] **Create a product** — in admin portal → Products → add one test product, set price, upload a thumbnail, publish it
- [ ] **Test checkout** — in sandbox mode, go through the full buy flow: catalog → product → pay (HitPay sandbox) → enrolled.html → My Learning
- [ ] **Verify webhook** — check admin portal → Incidents for any webhook failures; verify the order appears as paid
- [ ] **Verify enrollment** — the test product should appear in My Learning immediately after payment
- [ ] **Test quiz** (if you have a quiz product) — take a quiz, submit, verify score + explanations appear
- [ ] **Test material download** — open a material from My Learning, verify the signed URL works
- [ ] **Test referral** — visit `/?ref=TESTCODE`, sign in, buy something, check that a referral row appears
- [ ] **Switch to live HitPay keys** when all tests pass

---

## Part 9 — Ongoing admin tasks

See [ADMIN_GUIDE.md](ADMIN_GUIDE.md) for:
- Adding and publishing products
- Managing quizzes and questions
- Granting free access to students
- Processing referral payouts
- Monitoring payment incidents

---

## Troubleshooting

**OTP email not arriving**
→ Check spam/promotions. If consistently missing, configure custom SMTP (Part 4).

**Edge Function returns 401**
→ The JWT secret in secrets may not match the project's JWT secret. Re-run:
`supabase secrets set SUPABASE_JWT_SECRET="..."` and redeploy.

**Webhook returns 400 / HMAC mismatch**
→ Verify `HITPAY_SALT` matches exactly what HitPay shows in the dashboard.
Whitespace counts — copy-paste carefully.

**Products not showing on catalog**
→ Make sure the product is set to `published = true` in the admin portal.

**Materials signed URL fails**
→ Check that the `materials` bucket exists and the `material_path` on the product
was set when uploading (admin portal → Products → upload material).
