# ADMIN_GUIDE.md — Running the site day to day

This is your everyday handbook. **You never need to touch code.** Everything
here is done in your **Mission Control** Google Sheet and **Google Drive**, both
under **`rehinaneel@gmail.com`**.

Contents:

- [The golden rules](#the-golden-rules)
- [Add a new review material](#add-a-new-review-material)
- [Add or price a quiz pack](#add-or-price-a-quiz-pack)
- [Add quiz questions](#add-quiz-questions)
- [After a sale: issue an access code](#after-a-sale-issue-an-access-code)
- [The fulfilment checklist](#the-fulfilment-checklist)
- [Delivery email template (copy & paste)](#delivery-email-template-copy--paste)
- [Edit site text (brand, banner, hero, contact)](#edit-site-text-brand-banner-hero-contact)
- [Seeing quiz usage](#seeing-quiz-usage)
- [Troubleshooting](#troubleshooting)

---

## The golden rules

1. Edit content **only in the Sheet** (and upload files to Drive). Never edit code.
2. **Header rows must not be changed** — only add/edit rows beneath them.
3. After editing the Sheet, changes appear on the site **immediately** (refresh
   the page). You do **not** need to redeploy anything for Sheet edits.
4. Keep a column's format simple: prices are plain numbers, `active` is `TRUE`/
   `FALSE`, dates are `YYYY-MM-DD`.

---

## Add a new review material

**Step A — put the file in Drive**

1. In Google Drive (signed in as `rehinaneel@gmail.com`), keep **one folder per
   subject** (e.g. "Structural Design"). Upload the PDF/PowerPoint there.
2. You do **not** share it publicly. You'll share it privately with each buyer
   after they pay (see [fulfilment](#the-fulfilment-checklist)).
3. *(Recommended)* Watermark each PDF with "Licensed to <buyer email>" to deter
   sharing. Free PDF tools can do this.

**Step B — add a row in the `Products` tab**

Fill one row:

| column | what to put |
|---|---|
| product_id | a short unique id, e.g. `mat-utilities` |
| type | `material` |
| subject | the subject label, e.g. `Building Utilities` |
| title | the display title shoppers see |
| description | 1–2 short sentences |
| price_php | a plain number, e.g. `199` |
| hitpay_link | the HitPay payment link for this product (see SETUP Part 4) |
| active | `TRUE` to show it, `FALSE` to hide it |
| sort_order | a number controlling order (smaller appears first) |

Refresh the Materials page — your new product appears. (If `hitpay_link` is still
`REPLACE_ME...`, it shows a disabled "Coming soon" button until you add the link.)

---

## Add or price a quiz pack

A **quiz pack** is the *product* people buy (it appears on the Quizzes page). The
actual *questions* live in the `Quizzes` tab (next section).

1. In the `Products` tab, add a row with `type` = **`quiz`** (same columns as a
   material). Example: `product_id` = `quiz-utilities`, `title` = "Building
   Utilities — Quiz Pack", `price_php` = `149`.
2. To change a price, just edit `price_php` on that row.
3. To temporarily remove a pack from sale, set `active` to `FALSE`.

---

## Add quiz questions

Questions live in the **`Quizzes` tab — one row per question.**

For each question, fill a row:

| column | what to put |
|---|---|
| quiz_id | which quiz this question belongs to, e.g. `utilities-1`, `mock-2`. Use a tidy pattern: `<subject>-<number>`. Mock tests should start with `mock` (e.g. `mock-2`) so they get a timer. |
| quiz_title | the display title of the quiz, e.g. "Building Utilities — Quiz 1" |
| subject | the subject label |
| question_number | the order within the quiz: `1`, `2`, `3`, … |
| question_text | the question itself |
| option_a / option_b / option_c / option_d | the answer choices. You may leave some blank for fewer than 4 options. |
| correct_option | the letter of the correct choice: `A`, `B`, `C`, or `D` |
| explanation | shown after the student submits — explain *why* it's correct |

Tips:
- Keep all rows for one quiz together and number them in order.
- The **`correct_option`** and **`explanation`** are **never shown** to students
  until they submit — they're safe to keep here.
- The quiz id students type is the `quiz_id` value (e.g. `utilities-1`). Tell them
  this id in the email along with their access code.

---

## After a sale: issue an access code

When someone buys a **quiz pack**, you create a code that unlocks it.

In the **`AccessCodes` tab**, add a row:

| column | what to put |
|---|---|
| code | make up a short, easy code, e.g. `ARCH-9KQ2` (avoid confusing characters like O/0) |
| scope | what it unlocks: a specific quiz id (`utilities-1`), a subject prefix (`utilities` unlocks `utilities-1`, `utilities-2`, …), or `all` for everything |
| expiry_date | when it stops working, `YYYY-MM-DD`, e.g. `2027-12-31` |
| max_uses | how many times it can be submitted (e.g. `3`). Leave **blank** for unlimited. |
| uses_count | start at `0` (the system counts up automatically) |
| status | `active` (use `disabled` to switch a code off) |
| notes | for your own reference, e.g. the buyer's email |

Then email the buyer their **quiz id** and **access code** (template below).

> The system automatically increases `uses_count` each time the code is used to
> submit a quiz, and refuses the code once it hits `max_uses` or its expiry date.

---

## The fulfilment checklist

Do this for every order:

- [ ] **Confirm payment** in your HitPay dashboard (correct amount, status paid).
- [ ] **Note the buyer's email** (the one they paid with / gave you).
- [ ] **If a material was bought:** in Drive, share the file/folder with that
      email using **"specific people" (Restricted)** access, *or* send a view
      link. (Restricted is safer.)
- [ ] **If a quiz pack was bought:** add a row in `AccessCodes` (above) and note
      the **quiz id(s)** they can take.
- [ ] **Send the delivery email** (template below) with the Drive link and/or the
      quiz id + access code.
- [ ] Done. Keep the HitPay receipt for your records.

---

## Delivery email template (copy & paste)

> **Subject:** Your ArchPrep PH order — materials & quiz access
>
> Hi [Buyer name],
>
> Thank you for your purchase! Here's everything you need:
>
> **Review materials**
> [Subject] — [download/view link]
> (If asked, sign in with the email address you used to buy. Please don't share
> the file — it's licensed to you.)
>
> **Practice quiz access**
> Quiz page: https://YOUR-SITE.pages.dev/quiz.html
> Quiz code: **[quiz_id, e.g. structural-1]**
> Access code: **[code, e.g. ARCH-9KQ2]**
> Open the quiz page, enter the quiz code and your access code, and your
> questions will unlock. Your score and full explanations appear right after you
> submit.
>
> Your access code is valid until **[expiry date]**[ and can be used up to
> [max_uses] times]. If anything doesn't work, just reply to this email.
>
> Good luck with your review!
> — The ArchPrep PH team

*(Delete the part that doesn't apply if they only bought materials, or only a
quiz pack. Replace `YOUR-SITE.pages.dev` with your real site address.)*

---

## Edit site text (brand, banner, hero, contact)

In the **`Settings` tab** (key in column A, value in column B):

| key | what it controls |
|---|---|
| brand_name | the site name shown in the header and footer |
| contact_email | the email shown in the footer and FAQ |
| announcement_banner | a message bar across the top of every page. **Leave blank to hide it.** Put text in it (e.g. "Holiday sale — 20% off bundles!") to show it. |
| hero_headline | the big headline on the home page |
| hero_subhead | the supporting line under the headline |

Edit a value, save, refresh the site — the change is live. Anything left blank
falls back to sensible defaults.

The **FAQ page** text is currently fixed in the page itself. If you'd like to be
able to edit FAQs from the Sheet too, ask your developer — it's a small change.

---

## Seeing quiz usage

The **`Attempts` tab** automatically logs each graded quiz: the date/time, the
code used, the quiz id, and the score out of total. Use it to see how much your
quizzes are being used. You don't need to edit this tab — just read it.

---

## Troubleshooting

- **A product isn't showing.** Check `active` is `TRUE`, and that you didn't leave
  a blank row above it. Refresh the page.
- **The site says a column is missing.** A header in that tab is misspelled or has
  an extra space. Compare it against
  [`sample-data/mission-control-template.md`](sample-data/mission-control-template.md)
  and fix the spelling.
- **A buyer says their code doesn't work.** Check the `AccessCodes` row: is
  `status` = `active`? Is today before `expiry_date`? Is `uses_count` below
  `max_uses`? Does `scope` cover the quiz they're taking? Tell them the exact
  **quiz id** to enter — a common mistake is entering the wrong quiz.
- **"Coming soon" button on a product.** Its `hitpay_link` is still the
  `REPLACE_ME...` placeholder. Paste the real HitPay link.
- **Nothing loads / "can't reach the server".** Usually the backend URL in
  `config.js` is missing/wrong, or the Apps Script "Who has access" isn't set to
  **Anyone**. See [`SETUP.md`](SETUP.md) Parts 2–3.

---

## Using the Admin Portal (the easy way — no Sheet editing)

You now have a password-protected admin portal. It does everything described
above, but through forms. Open **`https://YOUR-SITE/admin.html`** (or add
`/admin.html` to your site address). Everything you save here goes **live on the
public site automatically** — no redeploy needed.

> First-time setup (username/password + backend update) is in `SETUP.md`
> Section 7. After that, just log in.

### Logging in
Enter your username and password. You stay logged in for 8 hours, then it asks
you to log in again. After 5 wrong attempts it locks for 15 minutes.

### The four sections
Across the top: **Quizzes · Products · Access Codes · Settings.**

### Build a quiz and its questions
1. **Quizzes → + New quiz.** Enter a **Quiz ID** (lowercase, e.g. `structural-2`),
   a title, the subject, and a **timer in minutes** (0 = no timer).
   - Tip: keep a shared prefix so one subject code unlocks all its quizzes
     (e.g. `structural-1`, `structural-2`, `structural-3` are all unlocked by a
     code with scope `structural`).
2. Click **Create & add questions.** (A quiz is saved once it has its first
   question.)
3. For each question: type the **question text**, fill **2–4 options**, click the
   **radio button** next to the correct option, and add an **explanation** (shown
   to the student after they submit). Save.
4. Use **↑ / ↓** to reorder, **Edit** to change, **Delete** to remove. Deleting
   renumbers the rest automatically.

### Create and price a product
1. **Products → + New product.**
2. Choose **Type**: *Material* (a download you fulfil from Drive) or *Quiz pack*
   (a sellable bundle that unlocks quizzes).
3. Fill subject, title, description, **price (PHP)**, and the **HitPay link**.
4. **Published / Draft toggle:** Published shows it on the public site; Draft
   hides it.
5. For a **quiz pack**, set **Unlock scope** (e.g. `structural` or `all`) so you
   know which quizzes it unlocks — this pre-fills the code form later. For a
   **material**, use **Drive note** to record which Drive file fulfils it.

### Generate and send an access code (after a sale)
1. **Access Codes → + New code.**
2. Set the **scope** (a quiz id like `structural-1`, a subject prefix like
   `structural`, or `all`), an **expiry date**, optional **max uses** (blank =
   unlimited), and a **note** (e.g. the buyer's email).
3. Click **Generate code.** The portal shows the new code with a **Copy** button
   and a **ready-to-send email** you can copy and paste to the buyer.
4. Later you can **Disable/Enable** or **Delete** any code from the list.

### Edit site text
**Settings** lets you change the brand name, contact email, announcement banner
(blank = hidden), and hero headline/subhead. Save, and the public site updates on
its next load.

### Good to know
- Every change is **live immediately** on the public site (it reads the same
  Sheet).
- Deleting anything asks you to confirm first.
- You can still edit the Sheet directly if you ever prefer to — the portal and
  the Sheet are just two views of the same data.
