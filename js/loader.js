/* ============================================================================
 * loader.js — brief cinematic intro overlay (logo draw-in + progress sweep).
 * Shows once per browser session, fades out on window load (max ~1.6s), and
 * is fully skipped under prefers-reduced-motion. Content is already in the DOM
 * underneath, so SEO/accessibility are unaffected.
 * ==========================================================================*/

(function () {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;
  if (sessionStorage.getItem("introShown")) return;
  sessionStorage.setItem("introShown", "1");

  const el = document.createElement("div");
  el.id = "intro-loader";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML =
    '<div style="text-align:center">' +
      '<svg class="intro-mark" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M6 42 24 6l18 36"/>' +
        '<path class="accent" d="M15 42 24 24l9 18"/>' +
      '</svg>' +
      '<div class="intro-word">ArchPrep PH</div>' +
    '</div>' +
    '<div class="intro-bar"></div>';

  const mount = () => { if (document.body && !document.getElementById("intro-loader")) document.body.appendChild(el); };
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  const finish = () => {
    const node = document.getElementById("intro-loader");
    if (node) { node.classList.add("done"); setTimeout(() => node.remove(), 800); }
  };
  // Fade out shortly after load, with a hard cap so it never lingers.
  let done = false;
  const go = () => { if (!done) { done = true; setTimeout(finish, 350); } };
  window.addEventListener("load", go);
  setTimeout(go, 1600);
})();
