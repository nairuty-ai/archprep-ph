/* js/app/content/render.mjs — HTML for the ALE guide and ALE cheat sheet.
 *
 * Pure string rendering, no DOM: the Cloudflare Worker (worker/index.js)
 * runs it on every (cached) request so search engines get the full page, and
 * Admin → Content runs the same function for its preview. The client scripts
 * (js/app/pages/guide.js, cheatsheet.js) only add behaviour on top.
 *
 * Every value from the JSON is escaped. Links to courses go through
 * ctx.courseHref(courseId), which the Worker resolves to a real product.
 */

import { scoreVerdict } from './gwa.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const pad2 = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11' → 'Nov 2026' (anything else is shown as given). */
export function monthLabel(updated) {
  const m = /^(\d{4})-(\d{1,2})/.exec(String(updated || ''));
  return m && MONTHS[+m[2] - 1] ? `${MONTHS[+m[2] - 1]} ${m[1]}` : String(updated || '');
}

/** 'arkiprep.com', 'https://arkiprep.com/' → 'https://arkiprep.com'; '' → fallback origin. */
export function siteOrigin(siteDomain, fallbackOrigin) {
  const raw = String(siteDomain || '').trim().replace(/\/+$/, '');
  if (!raw) return String(fallbackOrigin || '').replace(/\/+$/, '');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { return new URL(withScheme).origin; } catch { return String(fallbackOrigin || '').replace(/\/+$/, ''); }
}

const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

export const GUIDE_PATH = '/ale-guide';
export const CHEAT_PATH = '/ale-guide/cheat-sheet';
export const CHEAT_FILTERS = Object.freeze([['all', 'All'], ['A', 'Subject A'], ['B', 'Subject B'], ['C', 'Subject C'], ['X', 'Exam rules']]);

/** Defaults for anything the caller leaves out. */
function context(ctx = {}) {
  const origin = ctx.origin || 'https://arkiprep.com';
  return {
    origin,
    baseHref: ctx.baseHref || '/',
    updatedAt: ctx.updatedAt || null,
    preview: !!ctx.preview,
    courseHref: ctx.courseHref || (() => 'catalog.html'),
  };
}

// ---------------------------------------------------------------------------
// Page shell: same head, header, footer and motion setup as the other pages.
// ---------------------------------------------------------------------------
function page({ title, description, path, ctx, ld, body, script }) {
  const canonical = ctx.origin + path;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="${ctx.preview ? 'noindex, nofollow' : 'index, follow'}" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="ArkiPrep" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <base href="${esc(ctx.baseHref)}" />
  <link rel="icon" href="assets/icons/favicon.svg" type="image/svg+xml" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="css/app.css" />
  <link rel="stylesheet" href="css/content.css" />
  <script src="config.js"></script>
  <script>
    // Motion layer (js/app/motion.js): pre-animation states apply only under
    // this class, and only when the visitor hasn't asked for reduced motion.
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) document.documentElement.classList.add('motion-ready');
  </script>
  ${ld.map(jsonLd).join('\n  ')}
</head>
<body class="content-page">
  <div id="site-header"></div>
  <script src="js/app/chrome.js" data-active="guide"></script>

  <main id="main">
${body}
  </main>

  <div id="site-footer"></div>
  <script type="module" src="${esc(script)}"></script>
</body>
</html>
`;
}

function publisher(ctx) {
  return { '@type': 'Organization', name: 'ArkiPrep', url: ctx.origin + '/' };
}

// ---------------------------------------------------------------------------
// ALE guide
// ---------------------------------------------------------------------------
const GUIDE_TITLE = 'The Architect Licensure Exam, explained from schedule to strategy';
const GUIDE_INTRO = 'How the ALE is run, how it is scored, what each subject covers, and a 12-week plan to prepare. Reviewed by our faculty architects against PRC\u2019s published exam program and the Board of Architecture syllabi.';
export const GUIDE_DISCLAIMER = 'ArkiPrep is an independent reviewer and is not affiliated with or endorsed by the PRC or the Professional Regulatory Board of Architecture. Our questions are original practice items, not actual board questions. Always confirm dates, fees and requirements on the official PRC website.';
const KIT_STYLE = ['kit--both', 'kit--design', 'kit--leave'];
const WEEK_KIND = { a: 'Study', c: 'Design', r: 'Rest' };

function sectionHead(n, label, title, intro) {
  return `<div class="g-head" data-reveal>
          <div class="eyebrow">${pad2(n)} · ${esc(label.toUpperCase())}</div>
          <h2>${esc(title)}</h2>${intro ? `\n          <p class="g-intro">${esc(intro)}</p>` : ''}
        </div>`;
}

function syllabusPanel(code, s, ctx, active) {
  const topics = s.groups.reduce((n, g) => n + g.items.length, 0);
  const cta = s.cta && s.courseId
    ? `<a class="btn btn--primary btn--sm" href="${esc(ctx.courseHref(s.courseId))}">${esc(s.cta)}</a>`
    : '';
  return `<div class="syl-panel" id="syl-${code}" role="region" aria-label="Subject ${code} syllabus"${active ? '' : ' hidden'}>
            <div class="syl-top">
              <div class="stack gap-4">
                <div class="mono-label primary">${esc(s.when)}</div>
                <div class="syl-name">${esc(s.name)}</div>
              </div>
              <div class="muted small">${s.groups.length} topic areas · ${topics} topics</div>
            </div>
            <div class="syl-groups">
              ${s.groups.map((g) => `<div class="syl-group">
                <h3>${esc(g.title)}</h3>
                <ul class="diamond-list">${g.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>
              </div>`).join('\n              ')}
            </div>
            <div class="syl-foot">
              <p>${esc(s.note)}</p>${cta ? `\n              ${cta}` : ''}
            </div>
          </div>`;
}

function calculator(presets) {
  const first = presets[0] || { A: 74, B: 71, C: 77 };
  const v = scoreVerdict(first);
  const weights = { A: '30%', B: '30%', C: '40%' };
  const rows = ['A', 'B', 'C'].map((k) => `<div class="calc-row${v.scores[k] < 50 ? ' is-low' : ''}" data-subject="${k}">
              <div class="calc-label">
                <label for="calc-${k}"><strong>Subject ${k}</strong> <span class="muted">· ${weights[k]}</span></label>
                <output for="calc-${k}" class="calc-val" id="calc-${k}-val">${v.scores[k]}%<span class="calc-low"> · under 50</span></output>
              </div>
              <input type="range" id="calc-${k}" name="${k}" min="0" max="100" step="1" value="${v.scores[k]}" aria-valuetext="Subject ${k}, ${v.scores[k]} percent" />
            </div>`).join('\n            ');
  return `<div class="calc" id="score-calculator" data-calc>
          <div class="stack gap-18">
            <div class="calc-top">
              <h3>Score calculator</h3>
              <div class="chips chips--sm" role="group" aria-label="Example scores">
                ${presets.map((p, i) => `<button type="button" class="chip chip--sm" data-preset="${i}" data-a="${p.A}" data-b="${p.B}" data-c="${p.C}" aria-pressed="${i === 0}">${esc(p.label)}</button>`).join('\n                ')}
              </div>
            </div>
            ${rows}
          </div>
          <div class="calc-result" aria-live="polite" aria-atomic="true">
            <div class="mono-label">YOUR WEIGHTED AVERAGE</div>
            <div class="calc-gwa"><span data-gwa>${v.gwaText}</span>%</div>
            <div class="mono-small muted" data-math>${esc(v.math)}</div>
            <div class="verdict verdict--${v.status}" data-verdict><span class="verdict-icon" aria-hidden="true">${v.pass ? '✓' : '✕'}</span> <span data-verdict-text>${esc(v.verdict)}</span></div>
            <p class="calc-reason" data-reason>${esc(v.reason)}</p>
          </div>
        </div>`;
}

export function renderGuideBody(g, ctxIn) {
  const ctx = context(ctxIn);
  const toc = g.toc;
  const label = (id) => (toc.find((t) => t.id === id) || { label: id }).label;
  const num = (id) => toc.findIndex((t) => t.id === id) + 1;
  const updated = monthLabel(g.updated);
  const sp = g.studyPlan;
  const sum = sp.split.A + sp.split.B + sp.split.C;
  const perWeek = Math.round(sp.totalHours / 12);
  const byWeight = Math.round(sp.totalHours * 0.4);
  const extra = sp.split.C - byWeight;
  const sessionsBar = g.sessions.map((x) => `<span style="flex:${parseFloat(x.weight) || 1};background:${esc(x.color)}"></span>`).join('');

  return `    <section class="g-hero">
      <div class="g-hero-inner">
        <div class="eyebrow eyebrow--light">ALE GUIDE · UPDATED ${esc(updated.toUpperCase())}</div>
        <h1>${esc(GUIDE_TITLE)}</h1>
        <p class="g-lead">${esc(GUIDE_INTRO)}</p>
        <div class="row gap-10 wrap-flex">
          <a class="btn btn--light" href="ale-guide/cheat-sheet">Open the cheat sheet</a>
          <a class="btn btn--outline-light" href="${esc(ctx.courseHref(6))}">Take the free diagnostic</a>
          <a class="btn btn--outline-light" href="catalog.html">Browse reviewers</a>
        </div>
      </div>
    </section>

    <div class="g-body">
      <aside class="g-toc">
        <a class="toc-card" href="ale-guide/cheat-sheet">
          <span class="mono-label primary">QUICK REFERENCE</span>
          <strong>ALE cheat sheet →</strong>
          <span>Every key fact on one printable page</span>
        </a>
        <nav aria-label="On this page">
          <div class="mono-label toc-title">ON THIS PAGE</div>
          <ol>
            ${toc.map((t, i) => `<li><a href="ale-guide#${esc(t.id)}" data-toc="${esc(t.id)}"><span class="toc-n">${pad2(i + 1)}</span>${esc(t.label)}</a></li>`).join('\n            ')}
          </ol>
        </nav>
      </aside>

      <article class="g-main">
      <section id="g-glance" class="g-section">
        ${sectionHead(num('g-glance'), label('g-glance'), 'The exam in twelve facts')}
        <dl class="fact-grid">
          ${g.glance.map((x) => `<div><dt>${esc(x.label)}</dt><dd>${esc(x.value)}</dd></div>`).join('\n          ')}
        </dl>
      </section>

      <section id="g-schedule" class="g-section">
        ${sectionHead(num('g-schedule'), label('g-schedule'), 'Two exam days, three sessions', 'Times below follow the most recent PRC program. PRC releases the official program before every exam, and your Notice of Admission confirms your venue and room.')}
        <div class="weight-bar" aria-hidden="true">${sessionsBar}</div>
        <div class="stack gap-12" data-reveal-group>
          ${g.sessions.map((x) => `<div class="session">
            <div class="stack gap-4">
              <div class="row gap-8"><span class="dot" style="background:${esc(x.color)}" aria-hidden="true"></span><span class="mono-label ink">${esc(x.day)}</span></div>
              <div class="session-time">${esc(x.time)}</div>
              <div class="muted small">${esc(x.length)}</div>
            </div>
            <div class="session-what">
              <div class="mono-label primary">${esc(x.code)}</div>
              <h3>${esc(x.name)}</h3>
              <p>${esc(x.format)}</p>
            </div>
            <div class="session-weight"><strong>${esc(x.weight)}</strong><span class="muted small">of final grade</span></div>
          </div>`).join('\n          ')}
        </div>
      </section>

      <section id="g-passing" class="g-section">
        ${sectionHead(num('g-passing'), label('g-passing'), 'Two rules, and you need both')}
        <div class="rule-grid" data-reveal-group>
          <div class="rule">
            <div class="mono-label">RULE 1</div>
            <h3>Weighted average of at least 70%</h3>
            <div class="formula">GWA = (A × 0.30) + (B × 0.30) + (C × 0.40)</div>
            <p>Subject C carries the most weight, so a few points there move your average more than anywhere else.</p>
          </div>
          <div class="rule">
            <div class="mono-label">RULE 2</div>
            <h3>No subject below 50%</h3>
            <div class="formula formula--danger">A, B and C each ≥ 50</div>
            <p>This is a hard floor. A strong subject cannot pull a weak one up, so you can\u2019t skip any part of the syllabus.</p>
          </div>
        </div>
        ${calculator(g.calculatorPresets)}
      </section>

      <section id="g-syllabus" class="g-section">
        ${sectionHead(num('g-syllabus'), label('g-syllabus'), 'What each subject covers', 'Grouped the way the Board of Architecture syllabi describe them. Use this as your checklist: every line should feel familiar by exam week.')}
        <div class="chips" role="group" aria-label="Choose a subject" data-syl-tabs>
          ${['A', 'B', 'C'].map((k, i) => `<button type="button" class="chip" data-syl="${k}" aria-controls="syl-${k}" aria-pressed="${i === 0}">Subject ${k} · ${esc(g.syllabus[k].weight)}</button>`).join('\n          ')}
        </div>
        <div class="syl">
          ${['A', 'B', 'C'].map((k, i) => syllabusPanel(k, g.syllabus[k], ctx, i === 0)).join('\n          ')}
        </div>
      </section>

      <section id="g-eligible" class="g-section">
        ${sectionHead(num('g-eligible'), label('g-eligible'), 'Eligibility checklist')}
        <ul class="check-list">
          ${g.eligibility.map((t) => `<li><span class="tick" aria-hidden="true">✓</span>${esc(t)}</li>`).join('\n          ')}
        </ul>
        <p class="note note--warn"><strong>Retaking?</strong> ${esc(g.retakeNote)}</p>
      </section>

      <section id="g-strategy" class="g-section">
        ${sectionHead(num('g-strategy'), label('g-strategy'), 'A 12-week plan built around the weights', 'Start with hours in proportion to each subject\u2019s weight, then give design extra time. Design speed comes from repeated timed problems, not from reading.')}
        <div class="split-card">
          <div class="row-between">
            <h3>Suggested split for about ${sp.totalHours} review hours</h3>
            <span class="muted small">≈ ${perWeek} hours a week</span>
          </div>
          <div class="split-bar">
            <span class="s-a" style="flex:${sp.split.A}">A · ${sp.split.A} h</span>
            <span class="s-b" style="flex:${sp.split.B}">B · ${sp.split.B} h</span>
            <span class="s-c" style="flex:${sp.split.C}">C · ${sp.split.C} h</span>
          </div>
          ${extra > 0 && sum === sp.totalHours ? `<p class="muted small">Weights alone would give C ${byWeight} hours. The extra ${extra} come from A and B because design is the most skill-heavy subject.</p>` : ''}
        </div>
        <ol class="phase-grid" data-reveal-group>
          ${sp.phases.map((p, i) => `<li class="phase">
            <div class="row-between"><span class="mono-label">${esc(p.weeks)}</span><span class="mono-label primary">PHASE ${i + 1}</span></div>
            <h3>${esc(p.title)}</h3>
            <ul class="arrow-list">${p.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>
            <div class="phase-use">On ArkiPrep: <a href="${esc(ctx.courseHref(p.courseId))}">${esc(p.useLabel)}</a></div>
          </li>`).join('\n          ')}
        </ol>
        <div class="stack gap-10">
          <h3 class="h-sm">A typical week in phases 2 and 3</h3>
          <ul class="week-grid">
            ${sp.week.map((d) => `<li class="week-${esc(d.kind)}"><span class="mono-label">${esc(d.day)}<span class="sr-only"> · ${WEEK_KIND[d.kind] || ''}</span></span><span>${esc(d.task)}</span></li>`).join('\n            ')}
          </ul>
        </div>
      </section>

      <section id="g-day" class="g-section">
        ${sectionHead(num('g-day'), label('g-day'), 'What to bring, and what to leave home')}
        <div class="kit-grid" data-reveal-group>
          ${g.examDayKit.map((k, i) => `<div class="kit ${KIT_STYLE[i] || ''}">
            <h3>${esc(k.title)}</h3>
            <ul class="box-list">${k.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>
          </div>`).join('\n          ')}
        </div>
      </section>

      <section id="g-myths" class="g-section">
        ${sectionHead(num('g-myths'), label('g-myths'), 'What reviewees often get wrong')}
        <div class="myths">
          ${g.myths.map((m) => `<div class="myth">
            <p class="myth-false"><span class="mark" aria-hidden="true">✕</span><span><span class="sr-only">Myth: </span>${esc(m.myth)}</span></p>
            <p class="myth-true"><span class="mark" aria-hidden="true">✓</span><span><span class="sr-only">Fact: </span>${esc(m.fact)}</span></p>
          </div>`).join('\n          ')}
        </div>
      </section>

      <section id="g-final" class="g-section">
        ${sectionHead(num('g-final'), label('g-final'), 'The last-week checklist')}
        <ol class="final-grid" data-reveal-group>
          ${g.finalWeek.map((t, i) => `<li><span class="toc-n">${pad2(i + 1)}</span><span>${esc(t)}</span></li>`).join('\n          ')}
        </ol>
      </section>

      <div class="cta-band" data-reveal>
        <div class="stack gap-6">
          <h2>Find out where you stand today</h2>
          <p>25 free items across Subjects A and B, with explanations and a subject breakdown.</p>
        </div>
        <a class="btn btn--light" href="${esc(ctx.courseHref(6))}">Start free diagnostic</a>
      </div>

      <footer class="g-sources">
        <p><strong>Sources.</strong> ${g.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join(' · ')}. Last checked ${esc(updated)}.</p>
        <p>${esc(GUIDE_DISCLAIMER)}</p>
      </footer>
      </article>
    </div>`;
}

export function renderGuidePage(g, ctxIn) {
  const ctx = context(ctxIn);
  const url = ctx.origin + GUIDE_PATH;
  const description = 'Free ALE guide: the exam schedule, passing rules (70% average, 50% per subject), full syllabus, a 12-week study plan and an exam-day checklist.';
  const modified = ctx.updatedAt || g.updated;
  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'Article',
      headline: GUIDE_TITLE, description, inLanguage: 'en-PH',
      dateModified: modified, mainEntityOfPage: url, url,
      author: publisher(ctx), publisher: publisher(ctx),
    },
    {
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: g.myths.map((m) => ({
        '@type': 'Question',
        name: m.myth.replace(/^[\s“"]+|[\s”"]+$/g, ''),
        acceptedAnswer: { '@type': 'Answer', text: m.fact },
      })),
    },
  ];
  return page({
    title: 'ALE guide: the Architect Licensure Exam explained — ArkiPrep',
    description, path: GUIDE_PATH, ctx, ld,
    body: renderGuideBody(g, ctx),
    script: 'js/app/pages/guide.js',
  });
}

// ---------------------------------------------------------------------------
// ALE cheat sheet
// ---------------------------------------------------------------------------
export const CHEAT_NOTE = 'Study aid only, not for use inside the exam room. Based on PRC exam programs, the Board of Architecture syllabi, RA 9266 and PD 1096. ArkiPrep is independent and not affiliated with the PRC. Confirm details on';

/** Number of facts on one card. */
export function cardFacts(c) {
  if (c.type === 'compare') return c.left.items.length + c.right.items.length;
  return c.rows.length;
}

export function normaliseFilter(f) {
  return CHEAT_FILTERS.some(([k]) => k === f) ? f : 'all';
}

export function cheatCount(cards, filter) {
  const shown = cards.filter((c) => filter === 'all' || c.tag === filter);
  const facts = shown.reduce((n, c) => n + cardFacts(c), 0);
  return `${shown.length} card${shown.length === 1 ? '' : 's'} · ${facts} fact${facts === 1 ? '' : 's'}`;
}

function cardHtml(c, tags, hidden) {
  const t = tags[c.tag];
  const tag = `<span class="cs-tag" style="background:${esc(t.bg)};color:${esc(t.fg)}">${esc(t.label)}</span>`;
  let inner = '';
  if (c.type === 'terms') {
    inner = `<dl class="cs-terms">${c.rows.map((r) => `<div><dt>${esc(r.term)}</dt><dd>${esc(r.meaning)}</dd></div>`).join('')}</dl>`;
  } else if (c.type === 'compare') {
    inner = `<div class="cs-vs">
          <div><h4 class="vs-l">${esc(c.left.title)}</h4><ul>${c.left.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul></div>
          <div><h4 class="vs-r">${esc(c.right.title)}</h4><ul>${c.right.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul></div>
        </div>${c.tagline ? `\n        <p class="cs-tagline">${esc(c.tagline)}</p>` : ''}`;
  } else {
    inner = `<div class="cs-pick">${c.header ? `<div class="mono-label">${esc(c.header)}</div>` : ''}
          <ul>${c.rows.map((r) => `<li><span>${esc(r.need)}</span><span class="arrow" aria-label="use">→</span><strong>${esc(r.use)}</strong></li>`).join('')}</ul>
        </div>`;
  }
  return `<article class="cs-card" data-tag="${esc(c.tag)}" data-facts="${cardFacts(c)}"${hidden ? ' hidden' : ''}>
        <header><h3>${esc(c.title)}</h3>${tag}</header>
        ${inner}
      </article>`;
}

export function renderCheatBody(c, ctxIn, filterIn) {
  const ctx = context(ctxIn);
  const filter = normaliseFilter(filterIn);
  const updated = monthLabel(c.updated);
  const host = ctx.origin.replace(/^https?:\/\//, '');
  const showTail = filter === 'all' || filter === 'X';
  return `    <section class="cs-head">
      <div class="cs-head-inner">
        <nav class="cs-crumbs" aria-label="Breadcrumb"><a href="ale-guide">ALE guide</a><span aria-hidden="true">›</span><span aria-current="page">Cheat sheet</span></nav>
        <div class="cs-title-row">
          <div class="stack gap-8 cs-title">
            <div class="eyebrow">QUICK REFERENCE · UPDATED ${esc(updated.toUpperCase())}</div>
            <h1>ALE cheat sheet</h1>
            <p>The facts, terms and distinctions that come up most, grouped by subject. Use it for last-week review, not as a substitute for the reviewers.</p>
          </div>
          <div class="row gap-10 wrap-flex cs-actions">
            <button type="button" class="btn btn--secondary" data-print>Print / save PDF</button>
            <a class="btn btn--primary" href="${esc(ctx.courseHref(6))}">Test yourself free</a>
          </div>
        </div>
        <dl class="cs-nums">
          ${c.keyNumbers.map((n) => `<div><dt>${esc(n.label)}</dt><dd>${esc(n.value)}</dd></div>`).join('\n          ')}
        </dl>
        <div class="row gap-8 wrap-flex cs-filter">
          <div class="chips" role="group" aria-label="Filter cards">
            ${CHEAT_FILTERS.map(([k, l]) => `<button type="button" class="chip" data-f="${k}" aria-pressed="${k === filter}">${esc(l)}</button>`).join('\n            ')}
          </div>
          <span class="muted small" data-cs-count aria-live="polite">${cheatCount(c.cards, filter)}</span>
        </div>
      </div>
    </section>

    <div class="cs-body">
      <h2 class="sr-only">Cards</h2>
      <div class="cs-cards">
      ${c.cards.map((card) => cardHtml(card, c.tags, filter !== 'all' && card.tag !== filter)).join('\n      ')}
      </div>
      <div class="cs-tail" data-tail${showTail ? '' : ' hidden'}>
        <section class="cs-traps">
          <h2>Easy to mix up</h2>
          <ul>${c.traps.map((t) => `<li><span class="trap-a">${esc(t.a)}</span><span class="neq" aria-label="is not the same as">≠</span><span class="trap-b">${esc(t.b)}</span></li>`).join('')}</ul>
        </section>
        <section class="cs-recap">
          <h2>Night-before recap</h2>
          <ol>${c.recap.map((r, i) => `<li><span class="toc-n">${pad2(i + 1)}</span>${esc(r)}</li>`).join('')}</ol>
        </section>
      </div>
      <p class="cs-note">${esc(CHEAT_NOTE)} <a href="https://www.prc.gov.ph" target="_blank" rel="noopener">prc.gov.ph</a>.</p>
      <p class="print-only cs-print-foot">${esc(host)}${CHEAT_PATH} · Study aid only</p>
    </div>`;
}

export function renderCheatPage(c, ctxIn, filter) {
  const ctx = context(ctxIn);
  const url = ctx.origin + CHEAT_PATH;
  const description = 'Printable ALE cheat sheet: the key numbers, terms and easy-to-confuse distinctions for Subjects A, B and C, plus a night-before recap for the licensure exam.';
  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'Article',
      headline: 'ALE cheat sheet', description, inLanguage: 'en-PH',
      dateModified: ctx.updatedAt || c.updated, mainEntityOfPage: url, url,
      author: publisher(ctx), publisher: publisher(ctx),
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'ALE guide', item: ctx.origin + GUIDE_PATH },
        { '@type': 'ListItem', position: 2, name: 'Cheat sheet', item: url },
      ],
    },
  ];
  return page({
    title: 'ALE cheat sheet: key facts for the Architect Licensure Exam — ArkiPrep',
    description, path: CHEAT_PATH, ctx, ld,
    body: renderCheatBody(c, ctx, filter),
    script: 'js/app/pages/cheatsheet.js',
  });
}
