/* ============================================================================
 * cursor.js — premium custom cursor (dot + spring-lagged ring) with magnetic
 * hover scaling and click feedback. Desktop / fine-pointer only; native cursor
 * is restored on touch and under prefers-reduced-motion.
 * ==========================================================================*/

export function initCursor() {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
  if (reduce || !fine || window.innerWidth < 821) return;

  const dot = document.createElement("div");
  const ring = document.createElement("div");
  dot.className = "cursor-dot";
  ring.className = "cursor-ring";
  document.body.appendChild(dot);
  document.body.appendChild(ring);
  document.documentElement.classList.add("has-custom-cursor");

  let mx = window.innerWidth / 2, my = window.innerHeight / 2;
  let rx = mx, ry = my;

  window.addEventListener("pointermove", (e) => {
    mx = e.clientX; my = e.clientY;
    dot.style.left = mx + "px"; dot.style.top = my + "px";
  }, { passive: true });

  // Spring-follow ring
  const tick = () => {
    rx += (mx - rx) * 0.18;
    ry += (my - ry) * 0.18;
    ring.style.left = rx + "px";
    ring.style.top = ry + "px";
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const HOVER = "a, button, .btn, input, label, summary, .card, .option, .faq-item > summary";
  document.addEventListener("pointerover", (e) => {
    if (e.target.closest && e.target.closest(HOVER)) ring.classList.add("hover");
  });
  document.addEventListener("pointerout", (e) => {
    if (e.target.closest && e.target.closest(HOVER)) ring.classList.remove("hover");
  });
  window.addEventListener("pointerdown", () => ring.classList.add("down"));
  window.addEventListener("pointerup", () => ring.classList.remove("down"));
  document.addEventListener("pointerleave", () => { dot.style.opacity = "0"; ring.style.opacity = "0"; });
  document.addEventListener("pointerenter", () => { dot.style.opacity = "1"; ring.style.opacity = "1"; });
}
