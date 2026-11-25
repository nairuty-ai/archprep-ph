/* js/app/motion.js — the motion layer (MOTION_PROMPT.md). Imported by
 * shell.js, so every student page gets it as a deferred module.
 *
 * - scroll reveal for [data-reveal] blocks and [data-reveal-group] grids
 * - the hero slideshow ([data-slideshow])
 * - count-up numbers ([data-count])
 * - FAQ accordion open/close
 * Everything checks html.motion-ready, which the head script sets only when
 * the visitor has not asked for reduced motion; without it content just shows.
 */

const root = document.documentElement;
const motionOk = () => root.classList.contains('motion-ready');
const EASE_MS = 700;
const STAGGER_MS = 90;

// ---------------------------------------------------------------------------
// Scroll reveal: fade up 18px when 12% is visible, once.
// ---------------------------------------------------------------------------
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) reveal(e.target);
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' })
  : null;

function inView(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.top < innerHeight && r.bottom > 0;
}

function reveal(el) {
  io?.unobserve(el);
  let last = 0;
  if (el.hasAttribute('data-reveal-group')) {
    [...el.children].forEach((child, i) => {
      const d = Math.min(i, 5) * STAGGER_MS;
      child.style.setProperty('--d', `${d}ms`);
      last = d;
    });
  }
  el.classList.replace('reveal-pending', 'is-revealing');
  setTimeout(() => el.classList.remove('is-revealing'), EASE_MS + last + 50);
}

function track(el) {
  if (el.dataset.revealTracked) return;
  el.dataset.revealTracked = '1';
  // Only hide what is off screen right now; anything visible stays put.
  if (!motionOk() || !io || inView(el)) return;
  el.classList.add('reveal-pending');
  io.observe(el);
}

function scan(node) {
  if (node.matches?.('[data-reveal], [data-reveal-group]')) track(node);
  node.querySelectorAll?.('[data-reveal], [data-reveal-group]').forEach(track);
}

// ---------------------------------------------------------------------------
// Hero slideshow: 5s per slide, 900ms crossfade (CSS), slow zoom on the
// active slide (CSS). Pauses when the tab is hidden or the hero is off
// screen; no auto-advance with reduced motion.
// ---------------------------------------------------------------------------
function slideshow(box) {
  const slides = [...box.querySelectorAll('.hero-slide')];
  if (slides.length < 2) return;
  const label = box.querySelector('[role="img"]');
  let current = 0;
  let timer = null;
  let visible = true;

  // Each later slide is fetched and decoded off the main thread one slide
  // ahead (about 5s before it shows), never during page load.
  const ready = new Set([0]);
  function prepare(i) {
    const slide = slides[i];
    if (ready.has(i) || !slide.dataset.src) return;
    ready.add(i);
    const img = new Image();
    img.src = slide.dataset.src;
    img.decode().catch(() => {}).then(() => { slide.style.backgroundImage = `url("${slide.dataset.src}")`; });
  }

  const dots = document.createElement('div');
  dots.className = 'hero-dots';
  dots.setAttribute('role', 'group');
  dots.setAttribute('aria-label', 'Hero images');
  slides.forEach((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Show slide ${i + 1}`);
    b.addEventListener('click', () => { prepare(i); show(i); restart(); });
    dots.appendChild(b);
  });
  box.appendChild(dots);

  function show(i) {
    slides[current].classList.remove('is-active');
    current = (i + slides.length) % slides.length;
    const slide = slides[current];
    // Re-trigger the slow zoom on the incoming slide.
    slide.style.animation = 'none';
    void slide.offsetWidth;
    slide.style.animation = '';
    slide.classList.add('is-active');
    [...dots.children].forEach((d, k) => d.setAttribute('aria-current', String(k === current)));
    if (label && slide.dataset.alt) label.setAttribute('aria-label', slide.dataset.alt);
    if (motionOk()) prepare((current + 1) % slides.length);
  }

  const running = () => motionOk() && visible && !document.hidden;
  function restart() {
    clearInterval(timer);
    timer = running() ? setInterval(() => show(current + 1), 5000) : null;
  }

  document.addEventListener('visibilitychange', restart);
  if (io) {
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; restart(); }).observe(box);
  }
  show(0);
  restart();
}

// ---------------------------------------------------------------------------
// Count-up: <span data-count="2400" data-suffix="+">2,400+</span> counts from
// 0 over 1.3s (ease-out cubic, en-PH format) once it is visible.
// ---------------------------------------------------------------------------
function countUp(el) {
  const target = Number(el.dataset.count);
  const suffix = el.dataset.suffix ?? '';
  const fmt = (n) => Math.round(n).toLocaleString('en-PH') + suffix;
  if (!motionOk() || !Number.isFinite(target)) { el.textContent = fmt(target); return; }
  const run = () => {
    const start = performance.now();
    const step = (now) => {
      const t = Math.min((now - start) / 1300, 1);
      el.textContent = fmt(target * (1 - (1 - t) ** 3));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  if (!io) return run();
  const once = new IntersectionObserver(([e]) => { if (e.isIntersecting) { once.disconnect(); run(); } });
  once.observe(el);
}

// ---------------------------------------------------------------------------
// FAQ accordion: animate the panel height via grid rows (CSS) and keep the
// native <details> semantics.
// ---------------------------------------------------------------------------
function accordion(list) {
  list.classList.add('is-enhanced');
  for (const details of list.querySelectorAll('details')) {
    const summary = details.querySelector('summary');
    const panel = document.createElement('div');
    panel.className = 'acc-panel';
    const inner = document.createElement('div');
    while (summary.nextSibling) inner.appendChild(summary.nextSibling);
    panel.appendChild(inner);
    details.appendChild(panel);
    const icon = document.createElement('span');
    icon.className = 'acc-icon';
    icon.setAttribute('aria-hidden', 'true');
    summary.appendChild(icon);
    if (details.open) details.classList.add('is-open');

    summary.addEventListener('click', (e) => {
      e.preventDefault();
      if (!details.open) {
        details.open = true;
        requestAnimationFrame(() => details.classList.add('is-open'));
      } else {
        details.classList.remove('is-open');
        const close = () => { if (!details.classList.contains('is-open')) details.open = false; };
        if (motionOk()) panel.addEventListener('transitionend', close, { once: true });
        else close();
      }
    });
  }
}

// ---------------------------------------------------------------------------
function enhance(node) {
  scan(node);
  node.querySelectorAll?.('[data-slideshow]').forEach(slideshow);
  node.querySelectorAll?.('[data-count]').forEach(countUp);
  node.querySelectorAll?.('.accordion').forEach(accordion);
}

enhance(document);
// Pages render most content after loading data; reveal that too.
new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
}).observe(document.body, { childList: true, subtree: true });
