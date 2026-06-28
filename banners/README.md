# Home-page banner carousel

Drop your promotional banner images in **this folder** and they appear in the
rotating carousel on the home page automatically. No code or redeploy of the
backend is needed — just add the image files and refresh the site.

## How it works

- Name your images **exactly** `banner1.jpg`, `banner2.jpg`, `banner3.jpg`, … up to
  `banner20.jpg`.
- The site shows them **in order** and stops at the first missing number. So:
  - 5 files (`banner1`–`banner5`) → 5 slides.
  - 7 files → 7 slides.
  - 0 files → the banner section is hidden (nothing breaks).
- **No gaps:** numbering must be continuous. If you have `banner1`, `banner3` but no
  `banner2`, the carousel stops at `banner1`. Keep them sequential.
- You can use `.jpg`, `.jpeg`, `.png`, or `.webp` — any of these works for each
  banner (the site checks all four for each number).

## Recommended size

- **1600 × 500 px** (a wide 16:5 banner). Keep each file reasonably small
  (aim under ~300 KB) so the page stays fast on mobile.

## Generating banner art

Each `bannerN.txt` here is a ready-to-paste **Nano Banana** prompt for an on-brand
banner background. Generate the image, add any promo text yourself (e.g. in Canva —
AI image text is unreliable, so the prompts say "no text in the image" and leave a
calm area on the left for your wording), then save it as `bannerN.jpg` here.

You don't have to use the prompts — any image named `bannerN.jpg` at the right size
works. The prompts are just a head start for a consistent, professional look.

## Tips

- Put your most important promo as `banner1.jpg` (it shows first).
- 3–6 banners is a good number; too many and visitors won't see them all.
- The carousel auto-advances, and visitors can swipe or use the arrows/dots.
