#!/usr/bin/env node
/* Local preview of the content routes, without Cloudflare or a database.
 *
 *   node tests/helpers/content-preview-server.mjs [port]   (default 8099)
 *
 * Static files come from the repo; /ale-guide… go through worker/index.js
 * with the content from content/*.json and content_pages_enabled = on.
 * Used for screenshots and Lighthouse; not part of the site.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../../worker/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.argv[2]) || 8099;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};
const guide = JSON.parse(await readFile(root + 'content/ale-guide.json', 'utf8'));
const cheat = JSON.parse(await readFile(root + 'content/ale-cheatsheet.json', 'utf8'));
const flag = process.env.CONTENT_FLAG || 'on';

async function asset(pathname) {
  let p = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p.endsWith('/')) p += 'index.html';
  for (const candidate of [p, `${p}.html`]) {
    try {
      const body = await readFile(root + candidate.replace(/^\//, ''));
      return new Response(body, { status: 200, headers: { 'content-type': TYPES[extname(candidate)] || 'application/octet-stream' } });
    } catch { /* try next */ }
  }
  return new Response(await readFile(root + '404.html'), { status: 404, headers: { 'content-type': TYPES['.html'] } });
}

const env = {
  SUPABASE_URL: 'https://local.test', SUPABASE_ANON_KEY: 'local',
  ASSETS: { fetch: (req) => asset(new URL(req.url).pathname) },
};
const fakeFetch = async (url) => {
  const u = new URL(url);
  const table = u.pathname.split('/').pop();
  let body = [];
  if (table === 'settings') body = [{ key: 'content_pages_enabled', value: flag }, { key: 'site_domain', value: process.env.SITE_DOMAIN || '' }];
  if (table === 'content_pages' && flag === 'on') {
    const slug = u.searchParams.get('slug').replace('eq.', '');
    body = [{ slug, json: slug === 'ale-guide' ? guide : cheat, updated_at: '2026-11-25T00:00:00Z' }];
  }
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
};

createServer(async (req, res) => {
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method });
  const out = await handle(request, env, { fetch: fakeFetch, cache: null });
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`content preview on http://127.0.0.1:${port}/ale-guide (flag ${flag})`));
