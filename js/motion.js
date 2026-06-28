/* ============================================================================
 * motion.js — lightweight, dependency-free scroll-reveal animations.
 * Adds a subtle fade + rise to content as it scrolls into view. Fully
 * disabled for users who prefer reduced motion. No libraries, no cost.
 * ==========================================================================*/

const REVEAL_SELECTORS = [
  "main .section .card",
  "main .section--tight .card",
  "main .steps .step",
  "main .quote",
  "main .subject-group",
  "main .page-head",
  "main .section > .container > h2",
  "main .section--tight > .container > h2",
];

export function initMotion() {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return; // honour user preference; content stays fully visible

  const nodes = [];
  REVEAL_SELECTORS.forEach((sel) => {
    document.querySelectorAll(sel).forEach((n) => { if (!nodes.includes(n)) nodes.push(n); });
  });
  if (!nodes.length || !("IntersectionObserver" in window)) return;

  // Stagger cards within the same grid for a graceful cascade.
  nodes.forEach((n) => {
    n.classList.add("reveal");
    const parent = n.parentElement;
    if (parent && /grid|steps/.test(parent.className)) {
      const idx = Array.prototype.indexOf.call(parent.children, n) % 5;
      if (idx > 0) n.setAttribute("data-delay", String(idx));
    }
  });

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

  nodes.forEach((n) => io.observe(n));
}
