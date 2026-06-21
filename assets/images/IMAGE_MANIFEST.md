# Image Manifest — ArchPrep PH

This is the checklist of **every image the site uses**. Each image has:

1. A **placeholder file** already at the exact path (so the layout works now).
2. A sibling **`.txt` prompt file** with a ready-to-paste prompt for **Nano Banana**
   (Google's Gemini image model).

## How to replace a placeholder with a real image

1. Open the matching `.txt` file (e.g. `hero-architecture.txt`).
2. Copy the **PROMPT** section into Nano Banana and generate the image.
3. Download the result and **save it over the placeholder using the exact same
   filename** (e.g. `hero-architecture.jpg`). Keep the same name and folder.
4. Re-deploy the site (see `DEPLOYMENT.md`).
5. Tick the image off below by changing its status to **done**.

> Tip: keep images reasonably small (aim under ~300 KB each) so the site loads
> fast on mobile data. Most tools can export an optimised JPG.

## Checklist

| filename | used on | aspect ratio | size | prompt file | status |
|---|---|---|---|---|---|
| hero-architecture.jpg | index.html (hero) | 16:9 | 1600 × 900 | hero-architecture.txt | done |
| og-cover.jpg | index.html (social share preview) | 1.91:1 | 1200 × 630 | og-cover.txt | done |

## Notes

- The **favicon / logo mark** is a hand-made inline SVG (the small "roof" icon in
  the header). It needs no image file and no prompt — leave it as is, or have a
  designer refine it later.
- AI image generators are unreliable with text, so every prompt says **"no text
  in the image"**. All real text on the site is added with HTML.
- If you add new images later, follow the same pattern: reference the final
  filename in the HTML, drop a placeholder at that path, write a `<name>.txt`
  prompt, and add a row here.
