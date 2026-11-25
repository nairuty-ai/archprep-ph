/* ALE guide (/ale-guide). The page arrives fully rendered from the Worker
 * (js/app/content/render.mjs); this adds the table-of-contents scrolling and
 * highlight, the score calculator and the syllabus tabs. */

import { $, $$ } from '../core.js';
import { mountShell } from '../shell.js';
import { scoreVerdict } from '../content/gwa.mjs';

mountShell({});

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const OFFSET = 16;

// ---------------------------------------------------------------------------
// Table of contents: smooth scroll with a 16px offset (instant with reduced
// motion), and highlight the section being read.
// ---------------------------------------------------------------------------
function scrollToSection(id, push) {
  const target = document.getElementById(id);
  if (!target) return;
  const top = target.getBoundingClientRect().top + scrollY - OFFSET;
  scrollTo({ top, behavior: reduced() ? 'auto' : 'smooth' });
  const heading = target.querySelector('h2');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
  if (push) history.replaceState(null, '', `#${id}`);
}

const tocLinks = $$('[data-toc]');
for (const link of tocLinks) {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    scrollToSection(link.dataset.toc, true);
  });
}
// Links elsewhere on the page or site that point at a section (#g-passing).
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href*="#g-"]');
  if (!a || a.hasAttribute('data-toc')) return;
  const url = new URL(a.href, location.href);
  if (url.pathname !== location.pathname) return;
  e.preventDefault();
  scrollToSection(url.hash.slice(1), true);
});

function setActive(id) {
  for (const link of tocLinks) {
    const on = link.dataset.toc === id;
    link.classList.toggle('is-active', on);
    if (on) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

const sections = tocLinks.map((l) => document.getElementById(l.dataset.toc)).filter(Boolean);
if ('IntersectionObserver' in window && sections.length) {
  const visible = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target);
      else visible.delete(e.target);
    }
    // The first section (in page order) inside the reading band wins.
    const current = sections.find((s) => visible.has(s));
    if (current) setActive(current.id);
  }, { rootMargin: '-15% 0px -60% 0px' });
  sections.forEach((s) => io.observe(s));
}

// Arriving with a hash (e.g. the home page's "Score calculator" button):
// land with the same offset once layout has settled.
if (location.hash.startsWith('#g-')) {
  requestAnimationFrame(() => {
    const target = document.getElementById(location.hash.slice(1));
    if (target) scrollTo({ top: target.getBoundingClientRect().top + scrollY - OFFSET, behavior: 'auto' });
    setActive(location.hash.slice(1));
  });
}

// ---------------------------------------------------------------------------
// Score calculator. Pure client-side; nothing is saved.
// ---------------------------------------------------------------------------
const calc = $('[data-calc]');
if (calc) {
  const inputs = { A: $('#calc-A', calc), B: $('#calc-B', calc), C: $('#calc-C', calc) };
  const presets = $$('[data-preset]', calc);
  const verdictBox = $('[data-verdict]', calc);

  function render() {
    const v = scoreVerdict({ A: inputs.A.value, B: inputs.B.value, C: inputs.C.value });
    for (const k of ['A', 'B', 'C']) {
      const val = v.scores[k];
      inputs[k].setAttribute('aria-valuetext', `Subject ${k}, ${val} percent`);
      const out = $(`#calc-${k}-val`, calc);
      out.firstChild.nodeValue = `${val}%`;
      inputs[k].closest('.calc-row').classList.toggle('is-low', val < 50);
    }
    $('[data-gwa]', calc).textContent = v.gwaText;
    $('[data-math]', calc).textContent = v.math;
    $('[data-verdict-text]', calc).textContent = v.verdict;
    $('.verdict-icon', calc).textContent = v.pass ? '✓' : '✕';
    verdictBox.className = `verdict verdict--${v.status}`;
    $('[data-reason]', calc).textContent = v.reason;
    for (const p of presets) {
      const match = +p.dataset.a === v.scores.A && +p.dataset.b === v.scores.B && +p.dataset.c === v.scores.C;
      p.setAttribute('aria-pressed', String(match));
    }
  }

  for (const input of Object.values(inputs)) input.addEventListener('input', render);
  for (const p of presets) {
    p.addEventListener('click', () => {
      inputs.A.value = p.dataset.a;
      inputs.B.value = p.dataset.b;
      inputs.C.value = p.dataset.c;
      render();
    });
  }
  render();
}

// ---------------------------------------------------------------------------
// Syllabus tabs (buttons with aria-pressed; panels are all in the HTML).
// ---------------------------------------------------------------------------
const sylTabs = $$('[data-syl]');
for (const tab of sylTabs) {
  tab.addEventListener('click', () => {
    for (const t of sylTabs) {
      const on = t === tab;
      t.setAttribute('aria-pressed', String(on));
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    }
  });
}
