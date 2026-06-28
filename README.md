# ArchPrep PH — ALE Review & Quiz Platform

A low-cost website that sells **review materials** and **practice quizzes** to
student architects preparing for the Philippine **Architect Licensure
Examination (ALE)**. Built to run on **free tiers only** — no monthly software
cost.

## What it does

- Shows a catalogue of **review materials** (PDF/PowerPoint) and **quiz packs**.
- Buyers pay with **GCash or QR Ph** via **HitPay payment links** (no card
  payments, no on-site checkout).
- Materials are delivered **manually by email** (no accounts, no login).
- Buyers unlock quizzes with an **access code**; quizzes are **graded
  server-side** so correct answers never reach the browser.
- The owner manages everything from **one Google Sheet** and **Google Drive** —
  no code editing required.

## The stack (all free)

| Part | Technology | Cost |
|---|---|---|
| Front-end | Plain HTML + CSS + vanilla JS (ES modules) | Free |
| Hosting | Cloudflare Pages (static) | Free |
| Backend | One Google Apps Script Web App | Free |
| Data + admin panel | One Google Sheet ("Mission Control") | Free |
| Materials storage | Google Drive | Free |
| Payments | HitPay payment links (GCash / QR Ph) | Per-transaction fee only |

All Google assets are owned by **`rehinaneel@gmail.com`**.

## Quick start (5 lines)

1. Create the **Mission Control** Google Sheet from
   [`sample-data/mission-control-template.md`](sample-data/mission-control-template.md)
   under `rehinaneel@gmail.com`.
2. Paste [`apps-script/Code.gs`](apps-script/Code.gs) into the Sheet's Apps
   Script, deploy it as a Web App, and copy the `/exec` URL.
3. Paste that URL into [`config.js`](config.js) (`APPS_SCRIPT_URL`).
4. Create HitPay payment links (GCash + QR Ph) and paste them into the Sheet.
5. Deploy this folder to Cloudflare Pages (see [`DEPLOYMENT.md`](DEPLOYMENT.md)).

Full walkthrough: **[`SETUP.md`](SETUP.md)**. Day-to-day owner tasks:
**[`ADMIN_GUIDE.md`](ADMIN_GUIDE.md)**.

## Try it locally

You only need a static file server (the quiz/catalogue features need the backend
URL in `config.js`, but the pages and design render without it):

```sh
# from the repo root, using Python (already common on most machines):
python -m http.server 8080
# then open http://localhost:8080
```

Until `APPS_SCRIPT_URL` is set in `config.js`, the catalogue and quiz pages show
a friendly "not connected yet" message — that's expected.

## Project structure

```
README.md  SETUP.md  ADMIN_GUIDE.md  DEPLOYMENT.md   ← docs
config.js                                            ← the only file to edit after deploy
index.html  materials.html  quizzes.html  quiz.html  thank-you.html  faq.html
css/styles.css                                       ← design system
js/  config-loader.js  ui.js  catalogue.js  quiz.js  ← front-end logic
apps-script/  Code.gs  APPS_SCRIPT_README.md         ← the backend
assets/images/  (placeholders + Nano Banana prompt .txt files + IMAGE_MANIFEST.md)
assets/video/   VIDEO_MANIFEST.md                    ← (no video in v1)
assets/icons/   favicon.svg                          ← hand-made SVG
sample-data/  mission-control-template.md            ← the Sheet structure + seed data
```

## Replacing the placeholder images

This project ships with **placeholder images** and a **Nano Banana prompt** for
each one. See [`assets/images/IMAGE_MANIFEST.md`](assets/images/IMAGE_MANIFEST.md)
for the checklist and how to swap in the real images.

## Design / behaviour assumptions (per the build spec, Section 21)

These reasonable defaults were chosen where the spec allowed a choice:

- **Host:** Cloudflare Pages (Netlify / GitHub Pages work too — see
  `DEPLOYMENT.md`).
- **Brand name:** placeholder **"ArchPrep PH"**, read from `config.js` and the
  Settings tab so it can be changed in one place. Pick a real name later.
- **Unanswered quiz questions** are counted as **incorrect**, with a clear
  warning on the review screen before submitting.
- **Mock tests** (any `quiz_id` starting with `mock`) show an optional countdown
  timer; default 60 minutes, configurable via `MOCK_TEST_MINUTES` in `config.js`
  (set to `0` to disable).
- **No video in v1** (kept out for speed; see `assets/video/VIDEO_MANIFEST.md`).
- **Access-code scope** supports `all`, an exact quiz id, or a subject prefix
  (e.g. `structural` unlocks `structural-1`, `structural-2`, …).

## Admin portal (added)

There is now a password-protected **admin portal** at `admin.html` (e.g.
`/admin`) so the owner manages quizzes, questions, products, access codes, and
site settings through forms instead of editing the Sheet by hand. Changes save
to the same Sheet the public site reads, so they go live with no redeploy.

- One admin login only (set once via `setupAdminCredential` in the Apps Script
  editor). Auth is enforced **server-side** on every admin request with a
  session token — see `apps-script/APPS_SCRIPT_README.md` and `SETUP.md`.
- Per-quiz timers now live in the `Quizzes` tab (`timer_minutes` column).
- Setup and walkthrough: `SETUP.md` (admin setup) and `ADMIN_GUIDE.md` (daily use).

**Student login is intentionally NOT built (deferred to phase 2).** Reason:
there is no payment-API integration, so purchases can't be auto-linked to
accounts; access codes already gate quizzes; and storing student passwords would
create exactly the data-leak liability this project avoids. The only login in
the system is the single admin login.

## What this project deliberately does NOT do (v1 out of scope)

No **student** accounts / student login / student password storage (phase-2
item, see above), no on-site card payments, no HitPay API integration, no
automated delivery, no paid hosting/database/services, and the agent did not
generate real photos (placeholders + prompts are provided instead). See the
build spec's Sections 2 and 20.

## Security highlights

- Quiz **answer keys never reach the browser** — grading happens in Apps Script;
  `correct_option` is returned only by the `gradeQuiz` endpoint after a valid
  submission.
- Access codes are validated **server-side** on every quiz load and grade.
- No passwords and no card data are collected or stored anywhere.
- Sheet content is rendered with `textContent` (never `innerHTML`) to prevent
  injection.
