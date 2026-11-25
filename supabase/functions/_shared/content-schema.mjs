/* COPY of js/app/content/schema.mjs for the Edge Functions (a deploy only
 * bundles files under supabase/functions). Edit the original, then copy it
 * here; tests/content-pages.test.mjs fails while the two differ. */
/* js/app/content/schema.mjs — the shape of each content page's JSON.
 *
 * validatePage(slug, json) returns a list of problems ([] = valid), each
 * { path: 'syllabus.A.groups[2].title', message: 'must be a non-empty string' }.
 * Used by Admin → Content (before save and for the preview) and by the
 * admin-content Edge Function (authoritative, before anything is written).
 * Pure: no DOM, no imports.
 */

// Tiny schema language: a spec is one of
//   'str'  non-empty string        'str?'  string, may be empty or absent
//   'int'  integer ≥ 0             'score' integer 0–100
//   'id?'  positive integer or null/absent
//   'url'  http(s) URL             'color' #rrggbb
//   ['list', spec, min, max]       ['enum', ...values]
//   { key: spec, ... }             (unknown keys are refused, to catch typos)
//   ['map', keys[], spec]          object with exactly these keys
const S = 'str';

const guideSchema = {
  updated: S,
  sources: ['list', { label: S, url: 'url' }, 1, 10],
  toc: ['list', { id: ['enum', 'g-glance', 'g-schedule', 'g-passing', 'g-syllabus', 'g-eligible', 'g-strategy', 'g-day', 'g-myths', 'g-final'], label: S }, 9, 9],
  glance: ['list', { label: S, value: S }, 1, 24],
  sessions: ['list', { day: S, time: S, length: S, code: S, name: S, format: S, weight: S, color: 'color' }, 1, 6],
  syllabus: ['map', ['A', 'B', 'C'], {
    weight: S, when: S, name: S, courseId: 'id?', cta: 'str?|null', note: S,
    groups: ['list', { title: S, items: ['list', S, 1, 30] }, 1, 12],
  }],
  eligibility: ['list', S, 1, 20],
  retakeNote: S,
  studyPlan: {
    totalHours: 'int',
    split: ['map', ['A', 'B', 'C'], 'int'],
    phases: ['list', { weeks: S, title: S, items: ['list', S, 1, 10], useLabel: S, courseId: 'id?' }, 1, 8],
    week: ['list', { day: S, task: S, kind: ['enum', 'a', 'c', 'r'] }, 1, 7],
  },
  examDayKit: ['list', { title: S, items: ['list', S, 1, 20] }, 1, 3],
  myths: ['list', { myth: S, fact: S }, 1, 20],
  finalWeek: ['list', S, 1, 14],
  calculatorPresets: ['list', { label: S, A: 'score', B: 'score', C: 'score' }, 1, 3],
};

const cheatSchema = {
  updated: S,
  keyNumbers: ['list', { value: S, label: S }, 1, 12],
  tags: ['map', ['A', 'B', 'C', 'X'], { label: S, bg: 'color', fg: 'color' }],
  cards: ['list', 'card', 1, 80],
  traps: ['list', { a: S, b: S }, 0, 20],
  recap: ['list', S, 0, 24],
};

const cardBase = { tag: ['enum', 'A', 'B', 'C', 'X'], type: ['enum', 'terms', 'compare', 'picker'], title: S };
const cardSchemas = {
  terms: { ...cardBase, rows: ['list', { term: S, meaning: S }, 1, 20] },
  compare: { ...cardBase, left: { title: S, items: ['list', S, 1, 10] }, right: { title: S, items: ['list', S, 1, 10] }, tagline: 'str?' },
  picker: { ...cardBase, header: 'str?', rows: ['list', { need: S, use: S }, 1, 20] },
};

export const SCHEMAS = Object.freeze({ 'ale-guide': guideSchema, 'ale-cheatsheet': cheatSchema });
export const PAGE_SLUGS = Object.freeze(Object.keys(SCHEMAS));

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_STR = 2000;

function check(spec, v, path, out) {
  const fail = (message) => out.push({ path: path || '(root)', message });

  if (spec === 'card') {
    if (!isObj(v)) return fail('must be an object');
    const s = cardSchemas[v.type];
    if (!s) return fail('type must be terms, compare or picker');
    return check(s, v, path, out);
  }
  if (typeof spec === 'string') {
    const optional = spec.endsWith('?') || spec.includes('?|');
    const nullable = spec.endsWith('|null');
    if (v === undefined && optional) return;
    if (v === null && (nullable || spec === 'id?')) return;
    switch (spec.replace(/\?.*$/, '').replace(/\|null$/, '')) {
      case 'str':
        if (typeof v !== 'string') return fail('must be text');
        if (!optional && !v.trim()) return fail('must not be empty');
        if (v.length > MAX_STR) return fail(`must be at most ${MAX_STR} characters`);
        return;
      case 'int':
        if (!Number.isInteger(v) || v < 0) return fail('must be a whole number ≥ 0');
        return;
      case 'score':
        if (!Number.isInteger(v) || v < 0 || v > 100) return fail('must be a whole number from 0 to 100');
        return;
      case 'id':
        if (!Number.isInteger(v) || v < 1) return fail('must be a course number (1–6) or null');
        return;
      case 'url':
        if (typeof v !== 'string' || !/^https?:\/\/[^\s"'<>]+$/.test(v)) return fail('must be an http(s) link');
        return;
      case 'color':
        if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) return fail('must be a colour like #2f5fae');
        return;
      default:
        return fail(`unknown rule ${spec}`);
    }
  }
  if (Array.isArray(spec)) {
    const [kind, ...rest] = spec;
    if (kind === 'enum') {
      if (!rest.includes(v)) fail(`must be one of ${rest.join(', ')}`);
      return;
    }
    if (kind === 'list') {
      const [item, min, max] = rest;
      if (!Array.isArray(v)) return fail('must be a list');
      if (v.length < min) fail(`needs at least ${min} item${min === 1 ? '' : 's'}`);
      if (v.length > max) fail(`allows at most ${max} items`);
      v.forEach((x, i) => check(item, x, `${path}[${i}]`, out));
      return;
    }
    if (kind === 'map') {
      const [keys, item] = rest;
      if (!isObj(v)) return fail('must be an object');
      for (const k of keys) {
        if (!(k in v)) fail(`is missing ${k}`);
        else check(item, v[k], path ? `${path}.${k}` : k, out);
      }
      for (const k of Object.keys(v)) if (!keys.includes(k)) out.push({ path: path ? `${path}.${k}` : k, message: 'is not a known field' });
      return;
    }
  }
  if (isObj(spec)) {
    if (!isObj(v)) return fail('must be an object');
    for (const [k, s] of Object.entries(spec)) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in v)) {
        if (typeof s === 'string' && (s.endsWith('?') || s.includes('?|') || s === 'id?')) continue;
        out.push({ path: p, message: 'is required' });
      } else check(s, v[k], p, out);
    }
    for (const k of Object.keys(v)) if (!(k in spec)) out.push({ path: path ? `${path}.${k}` : k, message: 'is not a known field' });
  }
}

/** Problems with this page's JSON; [] when it is valid. */
export function validatePage(slug, json) {
  const schema = SCHEMAS[slug];
  if (!schema) return [{ path: '(root)', message: `unknown page ${slug}` }];
  const out = [];
  check(schema, json, '', out);
  if (slug === 'ale-guide' && out.length === 0) {
    const ids = json.toc.map((t) => t.id);
    if (new Set(ids).size !== ids.length) out.push({ path: 'toc', message: 'has the same section twice' });
  }
  return out;
}
