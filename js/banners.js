/* ============================================================================
 * banners.js — home-page promotional carousel.
 *
 * Static-site friendly: there is no directory listing, so we PROBE for
 * banners/banner1.jpg, banner2.jpg, … in order and stop at the first one that
 * doesn't exist. Whatever loads (up to 20) becomes the carousel. If none load,
 * the section stays hidden so the layout never breaks.
 *
 * Crossfade transitions, autoplay (pause on hover/focus), dots, arrows, and
 * touch swipe. Honours prefers-reduced-motion (no autoplay; manual only).
 * ==========================================================================*/

const MAX_BANNERS = 20;
const EXTS = ["jpg", "jpeg", "png", "webp"]; // accepts any of these per banner
const AUTOPLAY_MS = 5000;

const root = document.getElementById("banner-carousel");

document.addEventListener("DOMContentLoaded", () => {
  if (!root) return;
  probeBanners().then((urls) => { if (urls.length) buildCarousel(urls); });
});

/** Load an image; resolve true if it exists, false otherwise. */
function imageExists(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/** Find the first existing extension for bannerN; null if none. */
async function findBanner(n) {
  for (const ext of EXTS) {
    const url = `banners/banner${n}.${ext}`;
    // eslint-disable-next-line no-await-in-loop
    if (await imageExists(url)) return url;
  }
  return null;
}

/** Probe banner1..N in order; stop at the first gap. */
async function probeBanners() {
  const urls = [];
  for (let i = 1; i <= MAX_BANNERS; i++) {
    // eslint-disable-next-line no-await-in-loop
    const url = await findBanner(i);
    if (!url) break;
    urls.push(url);
  }
  return urls;
}

function buildCarousel(urls) {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const track = document.createElement("div");
  track.className = "banner-track";

  const slides = urls.map((url, i) => {
    const slide = document.createElement("div");
    slide.className = "banner-slide" + (i === 0 ? " active" : "");
    slide.style.backgroundImage = `url("${url}")`;
    slide.setAttribute("role", "group");
    slide.setAttribute("aria-label", `Promotion ${i + 1} of ${urls.length}`);
    track.appendChild(slide);
    return slide;
  });

  root.replaceChildren(track);
  root.removeAttribute("hidden");

  let current = 0;
  let timer = null;

  const show = (idx) => {
    current = (idx + slides.length) % slides.length;
    slides.forEach((s, i) => s.classList.toggle("active", i === current));
    if (dots) [...dots.children].forEach((d, i) => d.classList.toggle("active", i === current));
  };
  const next = () => show(current + 1);
  const prev = () => show(current - 1);

  // Controls only make sense with 2+ slides.
  let dots = null;
  if (slides.length > 1) {
    const prevBtn = mkArrow("prev", "‹", "Previous banner", prev);
    const nextBtn = mkArrow("next", "›", "Next banner", next);
    root.appendChild(prevBtn);
    root.appendChild(nextBtn);

    dots = document.createElement("div");
    dots.className = "banner-dots";
    urls.forEach((_, i) => {
      const dot = document.createElement("button");
      dot.className = "banner-dot" + (i === 0 ? " active" : "");
      dot.type = "button";
      dot.setAttribute("aria-label", `Go to banner ${i + 1}`);
      dot.addEventListener("click", () => { show(i); restart(); });
      dots.appendChild(dot);
    });
    root.appendChild(dots);

    const start = () => { if (!reduce) timer = setInterval(next, AUTOPLAY_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const restart = () => { stop(); start(); };

    root.addEventListener("mouseenter", stop);
    root.addEventListener("mouseleave", start);
    root.addEventListener("focusin", stop);
    root.addEventListener("focusout", start);
    document.addEventListener("visibilitychange", () => { document.hidden ? stop() : start(); });

    // Touch swipe
    let x0 = null;
    track.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    track.addEventListener("touchend", (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) { dx < 0 ? next() : prev(); restart(); }
      x0 = null;
    });

    start();
  }
}

function mkArrow(cls, glyph, label, handler) {
  const b = document.createElement("button");
  b.className = "banner-arrow " + cls;
  b.type = "button";
  b.textContent = glyph;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", handler);
  return b;
}
