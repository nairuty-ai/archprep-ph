/* ALE guide + cheat sheet: schema, rendering (snapshots), seed parity and
 * the Worker's routing / feature flag.
 *
 * Snapshots live in tests/__snapshots__/. After an intended change to the
 * pages, refresh them with:  UPDATE_SNAPSHOTS=1 npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { validatePage } from '../js/app/content/schema.mjs';
import { renderGuidePage, renderCheatPage, cheatCount, siteOrigin, monthLabel, GUIDE_DISCLAIMER } from '../js/app/content/render.mjs';
import { courseResolver } from '../js/app/content/courses.mjs';
import { handle, matchRoute } from '../worker/index.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const guide = JSON.parse(read('content/ale-guide.json'));
const cheat = JSON.parse(read('content/ale-cheatsheet.json'));

const PRODUCTS = [
  { slug: 'subject-a-reviewer', type: 'material', subject: 'A', status: 'published' },
  { slug: 'free-diagnostic', type: 'free', subject: 'ALL', status: 'published' },
];
const CTX = { origin: 'https://arkiprep.com', updatedAt: '2026-11-20T00:00:00Z', courseHref: courseResolver(PRODUCTS) };

function snapshot(name, actual) {
  const dir = new URL('tests/__snapshots__/', root);
  const file = new URL(name, dir);
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(actual, readFileSync(file, 'utf8'), `${name} changed; run UPDATE_SNAPSHOTS=1 npm test if intended`);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
test('both content files match their schema', () => {
  assert.deepEqual(validatePage('ale-guide', guide), []);
  assert.deepEqual(validatePage('ale-cheatsheet', cheat), []);
});

test('schema catches typos, wrong types and missing fields with a path', () => {
  const g = structuredClone(guide);
  g.calculatorPresets[0].A = 120;
  g.syllabus.B.groups[1].title = '';
  delete g.retakeNote;
  g.tocc = [];
  const problems = validatePage('ale-guide', g).map((p) => `${p.path} ${p.message}`);
  assert.ok(problems.includes('calculatorPresets[0].A must be a whole number from 0 to 100'), problems.join('\n'));
  assert.ok(problems.includes('syllabus.B.groups[1].title must not be empty'));
  assert.ok(problems.includes('retakeNote is required'));
  assert.ok(problems.includes('tocc is not a known field'));

  const c = structuredClone(cheat);
  c.cards[0].type = 'table';
  c.tags.A.bg = 'blue';
  const cp = validatePage('ale-cheatsheet', c).map((p) => `${p.path} ${p.message}`);
  assert.ok(cp.includes('cards[0] type must be terms, compare or picker'), cp.join('\n'));
  assert.ok(cp.includes('tags.A.bg must be a colour like #2f5fae'));
  assert.deepEqual(validatePage('nope', {}), [{ path: '(root)', message: 'unknown page nope' }]);
});

test('the Edge Function copy of the schema is identical to the original', () => {
  const copy = read('supabase/functions/_shared/content-schema.mjs');
  const original = read('js/app/content/schema.mjs');
  assert.ok(copy.endsWith(original), 'copy js/app/content/schema.mjs into supabase/functions/_shared/content-schema.mjs');
});

test('migration 0025 seeds exactly the two content files', () => {
  const sql = read('supabase/migrations/0025_content_pages.sql');
  const seeds = Object.fromEntries([...sql.matchAll(/\('([a-z-]+)', \$seed\$(.*?)\$seed\$::jsonb\)/gs)].map((m) => [m[1], JSON.parse(m[2])]));
  assert.deepEqual(seeds['ale-guide'], guide);
  assert.deepEqual(seeds['ale-cheatsheet'], cheat);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
test('guide page snapshot', () => {
  snapshot('ale-guide.html', renderGuidePage(guide, CTX));
});

test('cheat sheet page snapshots (All and ?f=A)', () => {
  snapshot('ale-cheatsheet.html', renderCheatPage(cheat, CTX, 'all'));
  snapshot('ale-cheatsheet-f-A.html', renderCheatPage(cheat, CTX, 'A'));
});

test('guide: SEO head, nine sections, calculator and disclaimer', () => {
  const html = renderGuidePage(guide, CTX);
  assert.match(html, /<title>ALE guide: the Architect Licensure Exam explained — ArkiPrep<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{80,160}" \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/arkiprep\.com\/ale-guide" \/>/);
  const ld = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(ld.map((x) => x['@type']), ['Article', 'FAQPage']);
  assert.equal(ld[1].mainEntity.length, guide.myths.length);
  assert.equal(ld[1].mainEntity[0].name, 'My average is 72%, so I passed.');
  for (const t of guide.toc) assert.ok(html.includes(`<section id="${t.id}"`), t.id);
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  assert.ok(html.includes(GUIDE_DISCLAIMER));
  // calculator starts on the first preset, accessible
  assert.match(html, /<input type="range" id="calc-A" name="A" min="0" max="100" step="1" value="74" aria-valuetext="Subject A, 74 percent" \/>/);
  assert.match(html, /<label for="calc-A">/);
  assert.match(html, /class="calc-result" aria-live="polite"/);
  assert.match(html, /<span data-gwa>74\.3<\/span>%/);
  assert.match(html, /data-preset="0"[^>]*aria-pressed="true">Passes</);
  // syllabus: A visible with its CTA, C hidden with no CTA
  assert.match(html, /data-syl="A" aria-controls="syl-A" aria-pressed="true"/);
  assert.match(html, /id="syl-C" role="region" aria-label="Subject C syllabus" hidden>/);
  const c = html.slice(html.indexOf('id="syl-C"'), html.indexOf('id="g-eligible"'));
  assert.ok(!c.includes('btn--primary'), 'Subject C has no course CTA');
  assert.ok(c.includes('not on ArkiPrep yet'));
  // course links resolve to real products, or the filtered catalog
  assert.ok(html.includes('href="product.html?slug=subject-a-reviewer">Subject A Reviewer · ₱49</a>'));
  assert.ok(html.includes('href="catalog.html?type=material&amp;subject=B">Subject B Reviewer · ₱49</a>'));
  assert.ok(html.includes('href="product.html?slug=free-diagnostic">Take the free diagnostic</a>'));
  assert.match(html, /ALE GUIDE · UPDATED NOV 2026/);
});

test('cheat sheet: filter, count, tail panels, print footer', () => {
  const all = renderCheatPage(cheat, CTX, 'all');
  assert.match(all, /<link rel="canonical" href="https:\/\/arkiprep\.com\/ale-guide\/cheat-sheet" \/>/);
  assert.match(all, /data-f="all" aria-pressed="true"/);
  assert.ok(all.includes(`data-cs-count aria-live="polite">${cheatCount(cheat.cards, 'all')}</span>`));
  assert.match(all, /<div class="cs-tail" data-tail>/);
  assert.ok(all.includes('arkiprep.com/ale-guide/cheat-sheet · Study aid only'));
  assert.equal((all.match(/<article class="cs-card"[^>]* hidden>/g) || []).length, 0);

  const a = renderCheatPage(cheat, CTX, 'A');
  const nA = cheat.cards.filter((c) => c.tag === 'A').length;
  assert.equal((a.match(/<article class="cs-card" data-tag="A"[^>]*?(?<! hidden)>/g) || []).length, nA);
  assert.equal((a.match(/<article class="cs-card"[^>]* hidden>/g) || []).length, cheat.cards.length - nA);
  assert.match(a, /data-tail hidden>/);
  assert.match(a, /data-f="A" aria-pressed="true"/);

  const x = renderCheatPage(cheat, CTX, 'X');
  assert.match(x, /<div class="cs-tail" data-tail>/);
  assert.equal(renderCheatPage(cheat, CTX, 'bogus'), all, 'unknown filter = All');
});

test('cheat sheet count: cards and facts', () => {
  const facts = cheat.cards.reduce((n, c) => n + (c.type === 'compare' ? c.left.items.length + c.right.items.length : c.rows.length), 0);
  assert.equal(cheatCount(cheat.cards, 'all'), `${cheat.cards.length} cards · ${facts} facts`);
});

test('every value is escaped', () => {
  const g = structuredClone(guide);
  g.myths[0].fact = '<script>alert(1)</script>';
  g.sources[0].label = '"><img src=x onerror=alert(1)>';
  const html = renderGuidePage(g, CTX);
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // JSON-LD cannot break out of its script tag either
  assert.ok(!/<\/script>alert/.test(html));
  assert.ok(html.includes('\\u003cscript>alert(1)\\u003c/script>'));
});

test('site domain and month helpers', () => {
  assert.equal(siteOrigin('arkiprep.ph', 'https://x.workers.dev'), 'https://arkiprep.ph');
  assert.equal(siteOrigin('https://arkiprep.com/', 'https://x.workers.dev'), 'https://arkiprep.com');
  assert.equal(siteOrigin('', 'https://x.workers.dev/'), 'https://x.workers.dev');
  assert.equal(monthLabel('2026-11'), 'Nov 2026');
  assert.equal(monthLabel('soon'), 'soon');
});

test('course numbers map to products by type and subject', () => {
  const href = courseResolver([
    { slug: 'mock-1', type: 'mock', subject: 'ALL' },
    { slug: 'quiz-b', type: 'quiz', subject: 'B' },
    { slug: 'draft', type: 'quiz', subject: 'A', status: 'draft' },
  ]);
  assert.equal(href(3), 'product.html?slug=mock-1');
  assert.equal(href(5), 'product.html?slug=quiz-b');
  assert.equal(href(4), 'catalog.html?type=quiz&subject=A');
  assert.equal(href(6), 'catalog.html?type=free');
  assert.equal(href(null), 'catalog.html');
});

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
test('routes', () => {
  assert.deepEqual(matchRoute('/ale-guide'), { slug: 'ale-guide', kind: 'guide', path: '/ale-guide' });
  assert.deepEqual(matchRoute('/ale-guide/cheat-sheet'), { slug: 'ale-cheatsheet', kind: 'cheat', path: '/ale-guide/cheat-sheet' });
  assert.deepEqual(matchRoute('/ale-guide/'), { redirect: '/ale-guide' });
  assert.deepEqual(matchRoute('/ale-guide/cheat-sheet/'), { redirect: '/ale-guide/cheat-sheet' });
  assert.deepEqual(matchRoute('/ale-guide.html'), { redirect: '/ale-guide' });
  assert.deepEqual(matchRoute('/ale-guide/nope'), { notFound: true });
  assert.equal(matchRoute('/catalog.html'), null);
  assert.equal(matchRoute('/ale-guidebook'), null);
});

function fakeEnv() {
  return {
    SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon',
    ASSETS: { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`, { status: 200 }) },
  };
}

function fakeSupabase(flag, calls = []) {
  return async (url, init) => {
    calls.push(String(url));
    assert.equal(init.headers.apikey, 'anon');
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    let body;
    if (table === 'settings') body = [{ key: 'content_pages_enabled', value: flag }, { key: 'site_domain', value: 'arkiprep.com' }];
    else if (table === 'content_pages') {
      const slug = u.searchParams.get('slug').replace('eq.', '');
      // RLS: no rows while the flag is off
      body = flag === 'on' ? [{ slug, json: slug === 'ale-guide' ? guide : cheat, updated_at: '2026-11-20T00:00:00Z' }] : [];
    } else body = PRODUCTS;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('worker: flag off → 404 with the site 404 page; other paths untouched', async () => {
  const env = fakeEnv();
  const res = await handle(new Request('https://site.test/ale-guide'), env, { fetch: fakeSupabase('off'), cache: null });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'asset:/404.html');
  const other = await handle(new Request('https://site.test/catalog.html'), env, { fetch: fakeSupabase('off'), cache: null });
  assert.equal(await other.text(), 'asset:/catalog.html');
});

test('worker: flag on → server-rendered pages, canonical from site_domain', async () => {
  const env = fakeEnv();
  const g = await handle(new Request('https://preview.workers.dev/ale-guide'), env, { fetch: fakeSupabase('on'), cache: null });
  assert.equal(g.status, 200);
  assert.match(g.headers.get('content-type'), /text\/html/);
  assert.match(g.headers.get('cache-control'), /max-age=60/);
  const html = await g.text();
  assert.ok(html.includes('<link rel="canonical" href="https://arkiprep.com/ale-guide" />'));
  assert.ok(html.includes('product.html?slug=subject-a-reviewer'));

  const c = await handle(new Request('https://preview.workers.dev/ale-guide/cheat-sheet?f=B'), env, { fetch: fakeSupabase('on'), cache: null });
  assert.equal(c.status, 200);
  assert.match(await c.text(), /data-f="B" aria-pressed="true"/);

  const r = await handle(new Request('https://preview.workers.dev/ale-guide/?x=1'), env, { fetch: fakeSupabase('on'), cache: null });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://preview.workers.dev/ale-guide?x=1');

  const post = await handle(new Request('https://preview.workers.dev/ale-guide', { method: 'POST' }), env, { fetch: fakeSupabase('on'), cache: null });
  assert.equal(post.status, 405);
});

test('worker: cached copy is reused; a stale copy covers a Supabase outage', async () => {
  const store = new Map();
  const cache = {
    match: async (req) => store.get(req.url)?.clone() ?? null,
    put: async (req, res) => { store.set(req.url, res); },
  };
  const env = fakeEnv();
  const calls = [];
  const first = await handle(new Request('https://s.test/ale-guide'), env, { fetch: fakeSupabase('on', calls), cache });
  assert.equal(first.status, 200);
  const n = calls.length;
  await handle(new Request('https://s.test/ale-guide'), env, { fetch: fakeSupabase('on', calls), cache });
  assert.equal(calls.length, n, 'second request served from cache');

  store.delete('https://s.test/ale-guide'); // fresh copy expired
  const down = async () => { throw new Error('offline'); };
  const res = await handle(new Request('https://s.test/ale-guide'), env, { fetch: down, cache });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /The Architect Licensure Exam/);

  const none = await handle(new Request('https://s.test/ale-guide/cheat-sheet'), env, { fetch: down, cache: null });
  assert.equal(none.status, 503);
});
