/* ============================================================================
 * fx.js — advanced, dependency-free micro-interactions & scroll motion.
 * Site-wide enhancements: scroll progress bar, sticky-nav shrink, parallax,
 * 3D card tilt, magnetic buttons, button ripples, step-line draw-in, and
 * smooth anchor scrolling. All gated by prefers-reduced-motion and pointer
 * type so it never harms accessibility or touch/low-power devices.
 * ==========================================================================*/

const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = window.matchMedia && window.matchMedia("(pointer: fine)").matches;

export function initFx() {
  scrollProgressAndNav();
  rippleButtons();
  smoothAnchors();
  meshBackground();
  splitHeadings();
  if (reduceMotion) return;     // the rest is purely decorative motion
  parallax();
  stepLineDraw();
  if (finePointer) {
    cardTilt();
    magneticButtons();
  }
}

/* ---- Animated mesh-gradient background (floating soft blobs) ---- */
function meshBackground() {
  const conn = navigator.connection;
  if (conn && conn.saveData) return;
  if (document.querySelector(".mesh-bg")) return;
  const bg = document.createElement("div");
  bg.className = "mesh-bg";
  bg.setAttribute("aria-hidden", "true");
  bg.innerHTML = '<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>';
  document.body.prepend(bg);
}

/* ---- Word-reveal typography on key headings ---- */
function splitHeadings() {
  if (reduceMotion) return;
  const heads = document.querySelectorAll("main .hero h1, main .section > .container > h2, main .section--tight > .container > h2, main .page-head h1");
  heads.forEach((h) => {
    if (h.dataset.split) return;
    h.dataset.split = "1";
    const words = h.textContent.split(/(\s+)/); // keep spaces
    h.textContent = "";
    words.forEach((w) => {
      if (/^\s+$/.test(w)) { h.appendChild(Object.assign(document.createElement("span"), { className: "split-space" })); return; }
      const word = document.createElement("span");
      word.className = "split-word";
      const inner = document.createElement("span");
      inner.textContent = w;
      word.appendChild(inner);
      h.appendChild(word);
    });
    h.classList.add("split-ready");
    // stagger via transition-delay on inner spans
    h.querySelectorAll(".split-word > span").forEach((s, i) => { s.style.transitionDelay = (i * 0.045) + "s"; });
  });

  if (!("IntersectionObserver" in window)) {
    heads.forEach((h) => h.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
  }, { threshold: 0.2 });
  heads.forEach((h) => io.observe(h));
}

/* ---- Scroll progress bar + sticky-nav shrink (rAF-throttled) ---- */
function scrollProgressAndNav() {
  const bar = document.createElement("div");
  bar.className = "scroll-progress";
  document.body.appendChild(bar);
  const header = document.querySelector(".site-header");
  let ticking = false;
  const update = () => {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    const pct = max > 0 ? (h.scrollTop / max) * 100 : 0;
    bar.style.width = pct + "%";
    if (header) header.classList.toggle("scrolled", h.scrollTop > 8);
    ticking = false;
  };
  window.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
}

/* ---- Parallax on [data-parallax] (hero media, banner) ---- */
function parallax() {
  const nodes = Array.from(document.querySelectorAll("[data-parallax]"));
  if (!nodes.length) return;
  let ticking = false;
  const update = () => {
    const vh = window.innerHeight;
    nodes.forEach((n) => {
      const rect = n.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const off = (center - vh / 2) / vh;            // -0.5..0.5-ish
      const speed = Number(n.getAttribute("data-parallax")) || 12;
      n.style.transform = `translate3d(0, ${(-off * speed).toFixed(1)}px, 0)`;
    });
    ticking = false;
  };
  window.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  window.addEventListener("resize", update);
  update();
}

/* ---- Step connector line draws in when the steps scroll into view ---- */
function stepLineDraw() {
  const steps = document.querySelector(".steps");
  if (!steps || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { steps.classList.add("drawn"); io.disconnect(); } });
  }, { threshold: 0.3 });
  io.observe(steps);
}

/* ---- 3D tilt on cards (pointer-driven), with a soft shine ---- */
function cardTilt() {
  const cards = document.querySelectorAll(".card");
  cards.forEach((card) => {
    const parent = card.parentElement;
    if (parent && !parent.classList.contains("tilt-wrap")) {
      // wrap perspective on the grid once
      if (!parent.dataset.tiltWrapped) { parent.classList.add("tilt-wrap"); parent.dataset.tiltWrapped = "1"; }
    }
    card.classList.add("tilt");
    if (!card.querySelector(".tilt-shine")) {
      const shine = document.createElement("span");
      shine.className = "tilt-shine";
      card.appendChild(shine);
    }
    const MAX = 7;
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      const rx = (py - 0.5) * -2 * MAX;
      const ry = (px - 0.5) * 2 * MAX;
      card.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-3px)`;
      card.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
      card.style.setProperty("--my", (py * 100).toFixed(1) + "%");
      card.classList.add("tilting");
    });
    card.addEventListener("pointerleave", () => {
      card.style.transform = "";
      card.classList.remove("tilting");
    });
  });
}

/* ---- Magnetic primary buttons (gentle pull toward cursor) ---- */
function magneticButtons() {
  document.querySelectorAll(".btn--primary, .btn--secondary").forEach((btn) => {
    btn.classList.add("magnetic");
    const STR = 0.3;
    btn.addEventListener("pointermove", (e) => {
      const r = btn.getBoundingClientRect();
      const x = (e.clientX - (r.left + r.width / 2)) * STR;
      const y = (e.clientY - (r.top + r.height / 2)) * STR;
      btn.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    });
    btn.addEventListener("pointerleave", () => { btn.style.transform = ""; });
  });
}

/* ---- Material-style ripple on any button click ---- */
function rippleButtons() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest(".btn");
    if (!btn || reduceMotion) return;
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const span = document.createElement("span");
    span.className = "ripple";
    span.style.width = span.style.height = size + "px";
    span.style.left = (e.clientX - r.left - size / 2) + "px";
    span.style.top = (e.clientY - r.top - size / 2) + "px";
    btn.appendChild(span);
    setTimeout(() => span.remove(), 650);
  });
}

/* ---- Smooth scrolling for in-page anchor links ---- */
function smoothAnchors() {
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      if (id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    });
  });
}
