# ADMIN_GUIDE.md — ArchPrep PH Admin Portal

Everything you need to manage the platform day-to-day.
Access the admin portal at `/admin.html` — requires signing in with an admin account.

---

## Getting to the admin portal

1. Visit `https://your-site.com/admin.html`
2. If you're not signed in, you'll be redirected to the login page.
3. Sign in with `rehinaneel@gmail.com` or `nairutya.84@gmail.com`.
4. The admin portal opens automatically. If you see "Access denied", your account
   hasn't been granted admin rights — run the SQL from SETUP.md Part 2.1.

---

## Products tab

Products are the items students can buy: review materials and quiz packs.

### Add a product

1. Admin portal → **Products** tab
2. Fill in the **Add / Edit product** form:
   - **Title**: the product name shown on the catalog page
   - **Subtitle**: one-line description (optional)
   - **Type**: `material` (PDF/file download) or `quiz_pack` (contains quizzes)
   - **Subject**: e.g. `Structural Design`, `Building Utilities`
   - **Slug**: URL-safe identifier, e.g. `structural-design-pack` — must be unique
   - **Price (₱)**: whole number, e.g. `199`
   - **Description**: full description shown on the product page
   - **Includes**: comma-separated list of what's included (shown as bullets)
3. Click **Save product**
4. Upload a **thumbnail** (shown on catalog cards) and/or a **material file** (PDF/PPTX)
5. Click **Publish** to make it visible on the catalog

> A product must be published before students can see or buy it.
> Unpublishing hides it from the catalog without deleting it.

### Edit a product

Click **Edit** next to any product. The form pre-fills — change what you need and click **Save product**.

### Delete a product

Click **Delete**. This is blocked if any orders exist for that product (to protect financial records).

---

## Quizzes tab

Quizzes are the individual quiz sets. A `quiz_pack` product can contain multiple quizzes.

### Add a quiz

1. Admin portal → **Quizzes** tab
2. Fill in the form:
   - **Title**: quiz name
   - **Subject**: e.g. `Structural Design`
   - **Slug**: URL-safe identifier
   - **Time limit (minutes)**: set to 0 for no timer
3. Click **Save quiz**

### Assign a quiz to a product (quiz pack)

1. Click **Assign packs** next to a quiz
2. Select which `quiz_pack` products should include this quiz
3. Click **Save**

A quiz can belong to multiple packs. When a student buys a pack, they get access to all quizzes assigned to it.

---

## Questions tab

Questions belong to a quiz. Students see them in the order set here.

### Add a question

1. Admin portal → **Questions** tab
2. Select a quiz from the dropdown
3. Fill in:
   - **Question text**: the question
   - **Options A–D**: answer choices (all four are required)
   - **Correct answer**: A, B, C, or D
   - **Explanation**: shown to students after they submit (optional but recommended)
4. Click **Save question**

### Reorder questions

Drag questions to reorder them, or use the **Move up / Move down** buttons.

### Edit or delete a question

Click **Edit** or **Delete** next to any question.

> Answer keys are **never sent to student browsers** — they are only revealed
> after the student submits the quiz. This is enforced at the database level.

---

## Enrollments tab

Enrollments track which students have access to which products.

### Grant free access

To give a student access to a product without payment (e.g. for a promo or correction):

1. Admin portal → **Enrollments** tab
2. Under **Grant access**:
   - **User email**: the student's email
   - **Product**: select from dropdown
   - **Source**: `comp` (complimentary) or `credit` (credit note)
3. Click **Grant access**

### Revoke access

Click **Revoke** next to an enrollment. This removes access and voids any open referral reward linked to the order.

### Search enrollments

Use the search box to filter by email or product name.

---

## Referrals tab

Tracks referral rewards earned when referred users make a purchase.

### Status types

| Status | Meaning |
|---|---|
| `available` | Earned, eligible for payout |
| `paid` | Payout transferred to GCash |
| `void` | Cancelled (e.g. refunded order) |

### Mark a referral as paid

Once you've transferred the payout via GCash:
1. Find the referral row
2. Click **Mark paid**

This sets `paid_at` to now and changes status to `paid`.

### Void a referral

If the associated order was refunded or fraudulent:
1. Click **Void**
2. Enter a short note explaining why
3. Click **Confirm**

---

## Payouts tab

Tracks payout requests from students who've reached the ₱100 threshold.

### Process a payout

When a student requests a payout:
1. Check their GCash number shown in the request
2. Transfer the amount via GCash
3. Click **Mark sent** and enter the GCash reference number
4. The system marks all their `available` referral rows as `paid`

---

## Incidents tab

Payment incidents are logged when the HitPay webhook receives a payload that can't be processed
(e.g. unknown order ID, amount mismatch, duplicate event).

### Review an incident

Click **View** to see the full payload. Common causes:
- **amount_mismatch**: someone may have tampered with the price. Check your HitPay dashboard.
- **order_not_found**: webhook fired before the order was created. Usually safe to resolve.
- **duplicate**: the webhook fired twice for the same payment. Safe to resolve.

### Resolve an incident

Click **Resolve** once you've investigated. Resolved incidents are hidden by default
(use **Show resolved** to see them).

---

## Settings tab

Platform-wide configuration.

| Key | Description | Example |
|---|---|---|
| `referral_amount` | PHP reward per referral | `9` |
| `payout_threshold` | Minimum balance to request payout (₱) | `100` |
| `reward_type` | `cash` (GCash payout) or `credit` (applied to next order) | `cash` |
| `answer_reveal_mode` | `answered_only` (reveal only answered questions) or `full_reveal` (reveal all after submit) | `answered_only` |
| `hero_headline` | Homepage hero heading text | `Pass the ALE with confidence.` |
| `hero_subhead` | Homepage hero subheading text | `Focused review materials…` |

Click a setting to edit, click **Save** to apply. Changes are live immediately.

---

## Users tab

Lists all registered accounts.

### Grant admin rights

1. Find the user (search by email)
2. Click **Grant admin**

### Revoke admin rights

Click **Revoke admin**. Blocked if that user is the last admin.

---

## Security reminders

- The admin portal requires sign-in on every visit — sessions expire automatically.
- The `service_role` key (used by Edge Functions) is never exposed to browsers.
- Student answer keys are stored in a DB column that has **zero RLS policies** —
  no client role can ever read them; only SECURITY DEFINER functions can.
- All admin actions go through Edge Functions with `requireAdmin()` checks —
  a student with a stolen JWT cannot call admin endpoints.
