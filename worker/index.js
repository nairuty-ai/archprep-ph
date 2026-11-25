/* worker/index.js — Cloudflare Worker in front of the static site.
 *
 * Every request goes straight to the static assets except the two content
 * routes (wrangler.jsonc run_worker_first), which are server-rendered here so
 * search engines get the full page:
 *
 *   /ale-guide              → the ALE guide
 *   /ale-guide/cheat-sheet  → the ALE cheat sheet (?f=A|B|C|X filter)
 *
 * Data comes from Supabase with the public anon key: the settings
 * content_pages_enabled and site_domain, the page JSON from content_pages
 * (RLS returns no row while the flag is off) and the published products for
 * course links. Rendered pages are cached at the edge for 60 seconds, so an
 * admin save or switching the flag shows up within a minute. If Supabase is
 * unreachable a copy up to a day old is served instead.
 *
 * While content_pages_enabled is off both routes answer 404 with the site's
 * 404 page.
 */

import { renderGuidePage, renderCheatPage, normaliseFilter, siteOrigin } from '../js/app/content/render.mjs';
import { courseResolver } from '../js/app/content/courses.mjs';

const FRESH_SECONDS = 60;
const STALE_SECONDS = 86400;
const FETCH_TIMEOUT_MS = 5000;

const ROUTES = {
  '/ale-guide': { slug: 'ale-guide', kind: 'guide' },
  '/ale-guide/cheat-sheet': { slug: 'ale-cheatsheet', kind: 'cheat' },
};

/** Which content route a path is, a redirect for it, or null (not ours). */
export function matchRoute(pathname) {
  const path = pathname.replace(/\/index\.html$/, '');
  if (ROUTES[path]) return { ...ROUTES[path], path };
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed !== path && ROUTES[trimmed]) return { redirect: trimmed };
  if (path.endsWith('.html') && ROUTES[path.slice(0, -5)]) return { redirect: path.slice(0, -5) };
  if (path === '/ale-guide' || path.startsWith('/ale-guide/')) return { notFound: true };
  return null;
}

async function rest(env, fetchFn, pathAndQuery) {
  const res = await fetchFn(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`supabase ${res.status} for ${pathAndQuery.split('?')[0]}`);
  return res.json();
}

/** Settings, page row and products in parallel. page is null while the flag is off. */
export async function loadContent(env, fetchFn, slug) {
  const [settingsRows, pageRows, products] = await Promise.all([
    rest(env, fetchFn, 'settings?select=key,value&key=in.(content_pages_enabled,site_domain)'),
    rest(env, fetchFn, `content_pages?select=slug,json,updated_at&slug=eq.${encodeURIComponent(slug)}`),
    rest(env, fetchFn, 'products?select=slug,type,subject,status&status=eq.published&order=sort_order.asc')
      .catch(() => []),
  ]);
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  const enabled = String(settings.content_pages_enabled || '').trim().toLowerCase() === 'on';
  return { settings, page: enabled ? pageRows[0] || null : null, products };
}

/** The site's own 404 page with a 404 status. */
async function notFound(env, origin) {
  let res = await env.ASSETS.fetch(new Request(`${origin}/404.html`));
  // Static assets redirect /404.html to /404 (html_handling); follow it once.
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    res = await env.ASSETS.fetch(new Request(new URL(res.headers.get('location'), origin)));
  }
  return new Response(res.body, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${FRESH_SECONDS}` },
  });
}

function htmlResponse(html, maxAge) {
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}

/**
 * The whole request handler. deps lets tests and the local preview server
 * pass their own fetch and cache.
 */
export async function handle(request, env, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const cache = deps.cache === undefined ? (typeof caches !== 'undefined' ? caches.default : null) : deps.cache;
  const waitUntil = deps.waitUntil || ((p) => p);
  const url = new URL(request.url);
  const route = matchRoute(url.pathname);

  if (!route) return env.ASSETS.fetch(request);
  if (route.redirect) return Response.redirect(`${url.origin}${route.redirect}${url.search}${url.hash}`, 301);
  if (route.notFound) return notFound(env, url.origin);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const filter = route.kind === 'cheat' ? normaliseFilter(url.searchParams.get('f') || 'all') : null;
  const keyUrl = `${url.origin}${route.path}${filter && filter !== 'all' ? `?f=${filter}` : ''}`;
  const freshKey = new Request(keyUrl);
  const staleKey = new Request(`${keyUrl}${keyUrl.includes('?') ? '&' : '?'}__stale=1`);

  let res = cache ? await cache.match(freshKey) : null;
  if (!res) {
    try {
      const { settings, page, products } = await loadContent(env, fetchFn, route.slug);
      if (!page) {
        res = await notFound(env, url.origin);
      } else {
        const ctx = {
          origin: siteOrigin(settings.site_domain, url.origin),
          updatedAt: page.updated_at,
          courseHref: courseResolver(products),
        };
        const html = route.kind === 'guide' ? renderGuidePage(page.json, ctx) : renderCheatPage(page.json, ctx, filter);
        res = htmlResponse(html, FRESH_SECONDS);
        if (cache) waitUntil(cache.put(staleKey, htmlResponse(html, STALE_SECONDS)));
      }
      if (cache) waitUntil(cache.put(freshKey, res.clone()));
    } catch (err) {
      console.error('content render failed', err);
      const stale = cache ? await cache.match(staleKey) : null;
      res = stale
        ? new Response(stale.body, { status: 200, headers: { ...Object.fromEntries(stale.headers), 'cache-control': 'no-store' } })
        : new Response('This page is temporarily unavailable. Please try again in a minute.', {
            status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60', 'cache-control': 'no-store' },
          });
    }
  }
  return request.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

export default {
  fetch(request, env, ctx) {
    return handle(request, env, { waitUntil: (p) => ctx.waitUntil(p) });
  },
};
