#!/usr/bin/env node
/* supabase/scripts/gen_content_seed.mjs — writes the seed block of
 * migration 0025 from content/ale-guide.json and content/ale-cheatsheet.json,
 * so the page content is never retyped by hand.
 *
 *   node supabase/scripts/gen_content_seed.mjs
 *
 * Only for building 0025 before it is applied. Once a migration is applied it
 * is never edited; later content changes go through Admin → Content.
 * tests/content-pages.test.mjs checks the seed still matches the JSON files.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migration = root + 'supabase/migrations/0025_content_pages.sql';
const pages = [['ale-guide', 'content/ale-guide.json'], ['ale-cheatsheet', 'content/ale-cheatsheet.json']];

const START = '-- BEGIN GENERATED SEED';
const END = '-- END GENERATED SEED';

const rows = pages.map(([slug, file]) => {
  const json = JSON.stringify(JSON.parse(readFileSync(root + file, 'utf8')));
  if (json.includes('$seed$')) throw new Error(`${file} contains the dollar-quote tag`);
  return `  ('${slug}', $seed$${json}$seed$::jsonb)`;
});

const block = `${START} (supabase/scripts/gen_content_seed.mjs)
insert into public.content_pages (slug, json) values
${rows.join(',\n')}
on conflict (slug) do nothing;
${END}`;

const sql = readFileSync(migration, 'utf8');
const a = sql.indexOf(START);
const b = sql.indexOf(END);
if (a < 0 || b < 0) throw new Error('seed markers not found in 0025');
writeFileSync(migration, sql.slice(0, a) + block + sql.slice(b + END.length));
console.log('seed written to', migration);
