# DEPLOYMENT.md — Putting the website online (free)

The website is a **plain static folder** (HTML, CSS, JS). It needs no build step
and no server, so it can be hosted for free. We recommend **Cloudflare Pages**;
**Netlify** and **GitHub Pages** are fine fallbacks.

> Before deploying, make sure you've set `APPS_SCRIPT_URL` in
> [`config.js`](config.js) (see [`SETUP.md`](SETUP.md) Part 2). The site will
> deploy without it, but the catalogue and quizzes won't load until it's set.

---

## Option A — Cloudflare Pages (recommended)

### A1. Put the project on GitHub (one-time)

1. Create a free GitHub account if you don't have one.
2. Create a new repository (e.g. `archprep-ph`) and upload all the files in this
   folder to it. (You can drag-and-drop files in the GitHub web uploader, or use
   GitHub Desktop.)

### A2. Connect Cloudflare Pages

1. Create a free account at <https://dash.cloudflare.com> → **Workers & Pages**.
2. Click **Create application → Pages → Connect to Git** and pick your repo.
3. Configure the build settings:
   - **Framework preset:** **None**
   - **Build command:** _(leave empty)_
   - **Build output directory:** `/` (the repo root — where `index.html` is)
4. Click **Save and Deploy**. After a minute you'll get a live URL like
   `https://archprep-ph.pages.dev`.

### A3. Finish the payment redirect

Go back to [`SETUP.md`](SETUP.md) Part 4 and set each HitPay payment link's
**post-payment redirect** to:

```
https://YOUR-SITE.pages.dev/thank-you.html
```

### A4. Redeploying after changes

- **Changed the Sheet** (products, prices, questions, codes, settings)? **Nothing
  to do** — the site reads the Sheet live. Just refresh.
- **Changed `config.js` or any HTML/CSS/JS file?** Push the change to GitHub;
  Cloudflare redeploys automatically within a minute. (With direct upload,
  re-upload the changed files in the Pages dashboard.)
- **Changed `apps-script/Code.gs`?** That's the backend — redeploy it in Apps
  Script (Deploy → Manage deployments → New version). See `SETUP.md` Part 3.

---

## Attaching a custom domain (optional)

If you buy a domain (e.g. `archprep.ph`) — the only optional cost in the whole
project:

1. In Cloudflare Pages → your project → **Custom domains → Set up a domain**.
2. Enter your domain and follow the prompts. If the domain is registered with
   Cloudflare, this is automatic; otherwise you'll point your domain's
   nameservers/DNS to Cloudflare as instructed.
3. HTTPS is provisioned automatically and free.
4. Update your HitPay redirect (Part 4) and your delivery email template to use
   the new domain.

---

## Option B — Netlify (fallback)

1. Create a free account at <https://netlify.com>.
2. **Add new site → Deploy manually**, then drag the whole project folder onto
   the upload area (or connect your GitHub repo).
3. No build command needed; publish directory is the project root.
4. You'll get a `*.netlify.app` URL. Set the HitPay redirect to
   `https://YOUR-SITE.netlify.app/thank-you.html`.

---

## Option C — GitHub Pages (fallback)

1. Push the project to a GitHub repo.
2. Repo **Settings → Pages → Build and deployment**: Source = **Deploy from a
   branch**, Branch = `main`, folder = `/ (root)`. Save.
3. Your site appears at `https://YOUR-USERNAME.github.io/REPO/`.
4. Set the HitPay redirect to `.../thank-you.html` on that address.

> Note: on GitHub Pages the site lives in a sub-path (`/REPO/`). All links in this
> project are **relative** (e.g. `materials.html`, `assets/images/...`), so they
> work correctly in a sub-path without changes.

---

## Quick post-deploy checklist

- [ ] Home page loads and looks right on a phone and a laptop.
- [ ] Materials page lists your products from the Sheet.
- [ ] Quizzes page lists your quiz packs.
- [ ] On the quiz page, a sample code works end-to-end (e.g. quiz `structural-1`,
      code `ARCH-7F3K`): questions load → submit → score + explanations show.
- [ ] A "Buy" button opens the correct HitPay payment page.
- [ ] After a test payment, HitPay redirects to your `thank-you.html`.
- [ ] The footer shows your real contact email (from the `Settings` tab).
