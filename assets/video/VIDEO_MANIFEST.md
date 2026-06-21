# Video Manifest — ArchPrep PH

**Status for v1: no video is used.** Per the build spec (Section 10.4), video is
optional and kept out of v1 to keep the site fast and simple on mobile data.

This file exists so that **if** you decide to add a short hero loop or an
explainer video later, you follow the same safe workflow as images:

1. Reference the **final filename** in the HTML (e.g. `assets/video/hero-loop.mp4`).
2. Add a **static poster image** at its final path (e.g.
   `assets/video/hero-loop-poster.jpg`) with its own `.txt` prompt, so the page
   looks fine before the video exists.
3. Create a `<name>.txt` description/prompt file containing: purpose, length,
   aspect ratio, scene description, and a paste-ready generation prompt.
4. Lazy-load the video and always provide the poster as a fallback, so it never
   blocks the page.
5. Add a row to the checklist below.

## Checklist

| filename | used on | aspect ratio | length | poster | prompt file | status |
|---|---|---|---|---|---|---|
| _(none yet)_ | — | — | — | — | — | not used in v1 |

## Template for a future video prompt file (`<name>.txt`)

```
VIDEO: <base filename>.mp4
USED ON: <which page / section>
PURPOSE: <what it must communicate>
LENGTH: <e.g. 6–10 seconds, silent loop>
ASPECT RATIO: <e.g. 16:9>   RECOMMENDED SIZE: <e.g. 1920 x 1080>
POSTER IMAGE: <base filename>-poster.jpg  (create a placeholder + its own .txt)
SCENE: <detailed description of the shot, motion, pacing, palette to match the
       site: ink #1B2430, terracotta #C2703D, off-white #F7F5F0>
AVOID: on-screen text, logos, watermarks, fast/jarring motion, audio that
       autoplays.

PROMPT (paste into your video generator):
<one strong natural-language paragraph, ending with the aspect ratio.>
```
