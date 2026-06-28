# SETUP.md — First-time setup (do this once, in order)

This guide takes you from zero to a live website. It's written for a
non-technical owner. Take it step by step; you can stop and come back anytime.

**Everything Google-related must be created while signed in to the business
Google account `rehinaneel@gmail.com`.** Sign in to that account first.

There are six parts:

1. [Create the Mission Control Google Sheet](#1-create-the-mission-control-google-sheet)
2. [Create & deploy the Apps Script Web App](#2-create--deploy-the-apps-script-web-app)
3. [The CORS deploy "gotcha" (read this!)](#3-the-cors-deploy-gotcha-read-this)
4. [Set up HitPay (GCash + QR Ph) payment links](#4-set-up-hitpay-gcash--qr-ph-payment-links)
5. [Deploy the website](#5-deploy-the-website)
6. [Choose a real brand name](#6-choose-a-real-brand-name)

---

## 1. Create the Mission Control Google Sheet

This single Sheet is your control panel. You'll add products, quizzes, prices,
and access codes here — never in code.

1. Sign in to Google as **`rehinaneel@gmail.com`**.
2. Go to <https://sheets.google.com> and create a new spreadsheet.
3. Rename it **`Mission Control`** (top-left title).
4. Open **[`sample-data/mission-control-template.md`](sample-data/mission-control-template.md)**.
   It lists **five tabs** and their exact columns, with ready-made example rows.
5. Create five tabs named **exactly**: `Products`, `Quizzes`, `AccessCodes`,
   `Settings`, `Attempts`. (Double-click a tab name to rename it; use the **+**
   at the bottom-left to add tabs.)
6. For each tab, type the **header row** (row 1) exactly as shown in the template,
   then copy in the **example rows** so the site has something to show.

> ⚠️ **Header names must match exactly** (same spelling, lower_case_with_
> underscores, no extra spaces). The backend finds columns by these names. If one
> is wrong, the site shows a message telling you which column is missing — just
> fix the spelling.

Keep this Sheet's browser tab open; you'll deploy the backend from inside it next.

---

## 2. Create & deploy the Apps Script Web App

This is the only "server". It reads your Sheet and powers the quizzes.

1. In your **Mission Control** Sheet, click **Extensions → Apps Script**. A new
   editor tab opens (this script is now *bound* to your Sheet).
2. Delete any sample code in the file `Code.gs`.
3. Open **[`apps-script/Code.gs`](apps-script/Code.gs)** from this project, copy
   **all** of it, and paste it into the editor. Click the **Save** icon.
4. (Optional sanity check) In the function dropdown, choose **`selfTest_`** and
   click **Run**. The first time, Google asks you to **authorise**:
   - Click **Review permissions** → choose **`rehinaneel@gmail.com`**.
   - You may see "Google hasn't verified this app" — this is normal for your own
     script. Click **Advanced → Go to (project name)** → **Allow**.
   - Open **View → Logs** to confirm it printed your settings/products.
5. Now deploy it as a Web App: click **Deploy → New deployment**.
   - Click the gear ⚙️ next to "Select type" → choose **Web app**.
   - **Description:** anything, e.g. `ArchPrep API v1`.
   - **Execute as:** **Me (`rehinaneel@gmail.com`)**.
   - **Who has access:** **Anyone**.  ← important, so the public site can call it.
   - Click **Deploy**, authorise again if asked.
6. Copy the **Web app URL**. It ends in **`/exec`** and looks like:
   `https://script.google.com/macros/s/AKfycb..../exec`
7. Open **[`config.js`](config.js)** in this project and paste that URL between the
   quotes:
   ```js
   APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycb..../exec",
   ```
   Save the file.

You can test the backend directly in a browser (no site needed). Paste this into
your address bar, replacing the URL with yours:

```
https://script.google.com/macros/s/AKfycb..../exec?action=getProducts
```

You should see a block of JSON listing your products. Try `?action=getQuizList`
and `?action=getSettings` too. (More test URLs are in
[`apps-script/APPS_SCRIPT_README.md`](apps-script/APPS_SCRIPT_README.md).)

---

## 3. The CORS deploy "gotcha" (read this!)

This is the **single most common thing that breaks**, so please read it once.

Your website (on Cloudflare Pages) and your backend (on Google) live on different
web addresses. Browsers are strict about this ("CORS"). The good news: this
project is already built to avoid the problem. **You don't need to change any
code** — just be aware of these rules so you don't accidentally break it:

- The site only ever calls the backend with **simple requests** (plain `GET`
  links, and `POST` sent as `text/plain`). This avoids the browser's "preflight"
  check that Apps Script can't answer.
- **Do not** edit the front-end to send JSON content-type headers or custom
  headers — that would trigger CORS errors.
- **Every time you change `Code.gs`, you must re-deploy** for the change to go
  live. Use **Deploy → Manage deployments → (edit ✏️) → Version: New version →
  Deploy**. This keeps the **same `/exec` URL**, so you don't need to touch
  `config.js` again.
- If you instead create a brand-new deployment, you'll get a **new URL** and must
  paste it into `config.js` again.

If the site ever says it can't reach the server: confirm the Web App's
**"Who has access"** is **Anyone**, and that the URL in `config.js` ends in
`/exec` (not `/dev`).

---

## 4. Set up HitPay (GCash + QR Ph) payment links

HitPay hosts the payment page. We use **payment links** only — no coding, no API.

1. Create a HitPay account at <https://www.hitpayapp.com> (Philippines).
   - Payouts require a **registered business (DTI/business registration)** and a
     **business bank account**. Prepare these for verification.
2. In the HitPay dashboard, enable **GCash** and **QR Ph** as payment methods.
   **Do not enable cards** (we keep fees lowest — this is deliberate).
3. Create **one Payment Link per product** (one for each material and each quiz
   pack you sell). For each link:
   - Set the **amount** to match the product's `price_php` in your Sheet.
   - Give it a clear **name/description** (e.g. "Structural Design — Review Notes").
   - Under the link's settings, set the **redirect URL after payment** to your
     live thank-you page: `https://YOUR-SITE.pages.dev/thank-you.html`
     (you'll have this address after Part 5 — you can come back and set it then).
4. Copy each payment link's URL and paste it into the matching product row's
   **`hitpay_link`** column in the `Products` tab of your Sheet (replace the
   `REPLACE_ME_HITPAY_LINK` placeholder).

Until a real link is pasted, that product shows a disabled **"Coming soon"**
button on the site (so you never sell something that can't be paid for).

> Note on abuse: there's no rate-limiting in v1, but quiz **access codes have an
> expiry date and an optional max-uses limit** (set in the `AccessCodes` tab),
> which is enough to limit sharing for a small business.

---

## 5. Deploy the website

The website is a plain static folder — it just needs free hosting. Full details
are in **[`DEPLOYMENT.md`](DEPLOYMENT.md)**; the short version:

1. Put this project in a GitHub repository (or use Cloudflare's direct upload).
2. In Cloudflare Pages, create a project from that repo.
   - **Build command:** _(leave empty)_
   - **Build output / root directory:** the repo root (where `index.html` is).
3. Deploy. Cloudflare gives you a URL like `https://your-site.pages.dev`.
4. Go back to **Part 4** and set each HitPay link's **redirect** to
   `https://your-site.pages.dev/thank-you.html`.

After this, your site is live and connected. Open it and check the Materials and
Quizzes pages load your products, and that the quiz flow works with a sample code
(e.g. quiz `structural-1`, code `ARCH-7F3K`).

---

## 6. Choose a real brand name

The site ships with the placeholder name **"ArchPrep PH"**. To change it
everywhere in one place:

- **Easiest:** in the Sheet's `Settings` tab, set `brand_name` to your real name.
  The whole site picks it up automatically (it's read live from the Sheet).
- Also update `BRAND_NAME` in [`config.js`](config.js) so the name still shows
  correctly for the split second before the live settings load, and if the
  backend is ever briefly unreachable.

That's it — your platform is live. For everyday tasks (adding a product, adding
quiz questions, issuing a code after a sale), see
**[`ADMIN_GUIDE.md`](ADMIN_GUIDE.md)**.

---

## 7. Admin portal setup (added)

The site now has a password-protected **admin portal** at `admin.html` (open
`https://YOUR-SITE/admin.html`) so you can manage quizzes, questions, products,
access codes, and settings through forms — no Sheet editing. Set it up once:

### 7a. Update the backend code

1. Open your Mission Control Sheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with the latest `apps-script/Code.gs` from
   this project (it now includes the admin endpoints). Save.
3. Open `Setup.gs` and replace it with the latest version too (it seeds the new
   columns for fresh Sheets). Save.

### 7b. Set your admin username and password (once)

1. In the Apps Script editor, open the function dropdown and pick
   **`setupAdminCredential`**. You can't pass arguments from the dropdown, so
   instead add a tiny temporary runner, OR run it from the editor's console:
   - Easiest: temporarily add this function, Save, run it once, then delete it:
     ```js
     function runOnce() { setupAdminCredential('admin', 'ArchPrep!2026'); }
     ```
   - Pick **`runOnce`** in the dropdown → **Run** → authorise if asked.
2. This stores a **salted SHA-256 hash** of your password in Script Properties
   (never the plaintext, never in the Sheet). **Delete the `runOnce` function**
   afterwards so the password isn't left in the editor.
3. To change the password later, repeat with a new password.

> The password is never stored in code, the Sheet, or the front-end — only a
> salted hash in server-side Script Properties.

### 7c. Re-deploy as a NEW VERSION (important)

Adding endpoints does **not** go live until you redeploy a new version:

- **Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy.**

This keeps the same `/exec` URL, so you don't change `config.js`. (If you skip
this, the portal will get "Unknown action" errors because the old code is still
being served.)

### 7d. New Sheet columns (auto-added)

The admin portal uses three new columns. **You don't have to add them by hand** —
the portal adds any that are missing the first time you save:

- `Quizzes` tab: **`timer_minutes`** (per-quiz countdown; 0 = no timer).
- `Products` tab: **`unlock_scope`** (which quizzes a quiz-pack product unlocks,
  e.g. `structural` or `all`) and **`drive_note`** (a fulfilment note for
  materials).

(If you build a fresh Sheet with the latest `Setup.gs`, they're already there.)

### 7e. Log in

Open `https://YOUR-SITE/admin.html`, log in with the username/password you set,
and you're in. The portal auto-logs-out after 8 hours, and locks out after 5
failed attempts for 15 minutes.
