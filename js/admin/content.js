/* js/admin/content.js — Admin → Content: the ALE guide and ALE cheat sheet.
 *
 * - Publishing: switch content_pages_enabled on/off and set site_domain
 *   (used for canonical links and the printed cheat-sheet footer).
 * - Editor: the page JSON with live validation (js/app/content/schema.mjs,
 *   the same rules the server applies) and a preview rendered by the same
 *   code the live site uses (js/app/content/render.mjs).
 * - History: the previous 10 versions, each viewable and restorable.
 * Every save, restore and setting change writes an audit_log row server-side.
 */

import { admin } from '../api.js';
import { el } from '../dom.js';
import { renderLoading, renderError, toast } from '../states.js';
import { validatePage } from '../app/content/schema.mjs';
import { renderGuidePage, renderCheatPage } from '../app/content/render.mjs';
import { courseResolver } from '../app/content/courses.mjs';

const PAGES = [
  { slug: 'ale-guide', label: 'ALE guide', path: '/ale-guide' },
  { slug: 'ale-cheatsheet', label: 'ALE cheat sheet', path: '/ale-guide/cheat-sheet' },
];

const CARD = 'background:var(--card,#fff);border:1px solid var(--border);border-radius:var(--radius,10px);padding:1.25rem;margin-bottom:1.25rem';
const LABEL = 'display:block;font-weight:700;font-size:var(--fs-xs);margin-bottom:.35rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)';

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function btn(text, cls = 'btn btn--outline btn--sm', attrs = {}) {
  return el('button', { class: cls, text, attrs: { type: 'button', ...attrs } });
}

function busy(button, on) {
  button.disabled = on;
  button.setAttribute('aria-busy', String(on));
}

/** JSON.parse with a readable line/column on failure. */
function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    const m = /position (\d+)/.exec(err.message);
    if (m) {
      const before = text.slice(0, Number(m[1]));
      const line = before.split('\n').length;
      const col = before.length - before.lastIndexOf('\n');
      return { error: `Not valid JSON (line ${line}, column ${col}): ${err.message}` };
    }
    return { error: `Not valid JSON: ${err.message}` };
  }
}

function previewHtml(slug, json) {
  const ctx = {
    origin: location.origin, baseHref: `${location.origin}/`, preview: true,
    courseHref: courseResolver([]),
  };
  return slug === 'ale-guide' ? renderGuidePage(json, ctx) : renderCheatPage(json, ctx, 'all');
}

// ---------------------------------------------------------------------------

export async function init(container) {
  renderLoading(container, 'Loading content…');
  let data;
  try {
    data = await admin.listContent();
  } catch (err) {
    renderError(container, err.message || 'Could not load the content pages.', () => init(container));
    return;
  }

  const state = { slug: PAGES[0].slug, dirty: false };
  container.innerHTML = '';

  // ---- Publishing ----------------------------------------------------------
  const pub = el('section', { attrs: { style: CARD, 'aria-labelledby': 'content-pub-title' } });
  const enabled = () => String(data.settings.content_pages_enabled || '').toLowerCase() === 'on';
  const status = el('span', { attrs: { style: 'font-weight:800' } });
  const toggle = btn('');
  const domain = el('input', {
    attrs: {
      id: 'content-domain', type: 'text', placeholder: 'arkiprep.com', autocomplete: 'off',
      style: 'width:100%;max-width:320px;min-height:var(--tap,44px);padding:.5rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm,6px);font:inherit',
    },
  });
  domain.value = data.settings.site_domain || '';
  const saveDomain = btn('Save domain');
  const links = el('div', { attrs: { style: 'display:flex;gap:1rem;flex-wrap:wrap;font-size:var(--fs-sm)' } });

  function drawPub() {
    status.textContent = enabled() ? 'Live: the pages, header link and home block are visible.' : 'Hidden: the pages return 404 and the header link and home block are off.';
    status.style.color = enabled() ? 'var(--success, #1f7a4f)' : 'var(--muted)';
    toggle.textContent = enabled() ? 'Turn pages off' : 'Turn pages on';
    toggle.className = enabled() ? 'btn btn--outline btn--sm' : 'btn btn--primary btn--sm';
    links.replaceChildren(...PAGES.map((p) => el('a', { text: `Open ${p.label} ↗`, attrs: { href: p.path, target: '_blank', rel: 'noopener' } })));
  }

  toggle.addEventListener('click', async () => {
    const next = enabled() ? 'off' : 'on';
    const msg = next === 'on'
      ? 'Publish the ALE guide and cheat sheet? They become public, the header gets an "ALE guide" link and the home page shows the exam block (within about a minute).'
      : 'Hide the ALE guide and cheat sheet? Both pages will return 404 and the header link and home block disappear.';
    if (!confirm(msg)) return;
    busy(toggle, true);
    try {
      await admin.contentSettings({ content_pages_enabled: next });
      data.settings.content_pages_enabled = next;
      drawPub();
      toast(next === 'on' ? 'Content pages are on.' : 'Content pages are off.');
    } catch (err) {
      toast(err.message || 'Could not change the setting.', 'error');
    } finally { busy(toggle, false); }
  });

  saveDomain.addEventListener('click', async () => {
    busy(saveDomain, true);
    try {
      const res = await admin.contentSettings({ site_domain: domain.value });
      data.settings.site_domain = res.settings.site_domain;
      domain.value = res.settings.site_domain;
      toast('Site domain saved.');
    } catch (err) {
      toast(err.message || 'Could not save the domain.', 'error');
    } finally { busy(saveDomain, false); }
  });

  pub.append(
    el('h3', { text: 'Publishing', attrs: { id: 'content-pub-title', style: 'margin:0 0 .75rem;font-size:var(--fs-md)' } }),
    el('div', { attrs: { style: 'display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem' }, children: [status, toggle] }),
    el('label', { text: 'Site domain (canonical links, printed footer)', attrs: { for: 'content-domain', style: LABEL } }),
    el('div', { attrs: { style: 'display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:.75rem' }, children: [domain, saveDomain] }),
    el('p', { text: 'Leave empty to use whatever address the site is opened on.', attrs: { style: 'margin:0 0 .75rem;font-size:var(--fs-xs);color:var(--muted)' } }),
    links,
  );
  drawPub();

  // ---- Page picker + editor -----------------------------------------------
  const picker = el('div', { attrs: { role: 'group', 'aria-label': 'Page', style: 'display:flex;gap:.5rem;margin-bottom:1rem;flex-wrap:wrap' } });
  const meta = el('p', { attrs: { style: 'margin:0 0 .5rem;font-size:var(--fs-sm);color:var(--muted)' } });
  const area = el('textarea', {
    attrs: {
      id: 'content-json', spellcheck: 'false', 'aria-describedby': 'content-problems',
      style: 'width:100%;min-height:460px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:.75rem;border:1px solid var(--border);border-radius:var(--radius-sm,6px);tab-size:2;white-space:pre',
    },
  });
  const problems = el('div', { attrs: { id: 'content-problems', role: 'status', 'aria-live': 'polite', style: 'margin:.75rem 0;font-size:var(--fs-sm)' } });
  const saveBtn = btn('Save', 'btn btn--primary btn--sm');
  const resetBtn = btn('Discard changes');
  const previewBtn = btn('Refresh preview');
  const frame = el('iframe', {
    attrs: {
      title: 'Page preview', sandbox: 'allow-scripts allow-same-origin',
      style: 'width:100%;height:720px;border:1px solid var(--border);border-radius:var(--radius-sm,6px);background:#fff',
    },
  });
  const history = el('div');

  const page = () => data.pages.find((p) => p.slug === state.slug);

  function check() {
    const parsed = parseJson(area.value);
    if (parsed.error) {
      problems.replaceChildren(el('p', { text: parsed.error, attrs: { style: 'color:var(--danger,#9b2a1f);margin:0;font-weight:700' } }));
      saveBtn.disabled = true;
      return null;
    }
    const list = validatePage(state.slug, parsed.value);
    if (list.length) {
      problems.replaceChildren(
        el('p', { text: `${list.length} problem${list.length === 1 ? '' : 's'} to fix before saving:`, attrs: { style: 'color:var(--danger,#9b2a1f);margin:0 0 .25rem;font-weight:700' } }),
        el('ul', { attrs: { style: 'margin:0;padding-left:1.25rem' }, children: list.slice(0, 30).map((p) => el('li', { text: `${p.path} ${p.message}` })) }),
      );
      saveBtn.disabled = true;
      return null;
    }
    problems.replaceChildren(el('p', { text: state.dirty ? '✓ Valid. Unsaved changes.' : '✓ Valid. No changes.', attrs: { style: 'color:var(--success,#1f7a4f);margin:0;font-weight:700' } }));
    saveBtn.disabled = !state.dirty;
    return parsed.value;
  }

  function preview(json) {
    try {
      frame.srcdoc = previewHtml(state.slug, json);
    } catch (err) {
      frame.srcdoc = `<p style="font:14px sans-serif;padding:1rem">Preview failed: ${String(err.message).replace(/</g, '&lt;')}</p>`;
    }
  }

  function drawHistory() {
    const versions = data.versions.filter((v) => v.slug === state.slug);
    history.replaceChildren(
      el('h3', { text: 'Previous versions', attrs: { style: 'margin:0 0 .5rem;font-size:var(--fs-md)' } }),
      el('p', { text: 'The last 10 saved versions. Restoring one saves it as the current page (and keeps the current one here).', attrs: { style: 'margin:0 0 .75rem;font-size:var(--fs-sm);color:var(--muted)' } }),
    );
    if (!versions.length) {
      history.appendChild(el('p', { text: 'No earlier versions yet.', attrs: { style: 'margin:0;font-size:var(--fs-sm)' } }));
      return;
    }
    const list = el('ol', { attrs: { style: 'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:.5rem' } });
    for (const v of versions) {
      const view = btn('Preview');
      const restore = btn('Restore');
      view.addEventListener('click', async () => {
        busy(view, true);
        try {
          const { version } = await admin.getContentVersion(v.id);
          preview(version.json);
          frame.scrollIntoView({ behavior: 'smooth', block: 'start' });
          toast(`Previewing the version from ${when(v.saved_at)}. Nothing changed yet.`);
        } catch (err) { toast(err.message || 'Could not load that version.', 'error'); } finally { busy(view, false); }
      });
      restore.addEventListener('click', async () => {
        if (state.dirty && !confirm('You have unsaved changes in the editor. Restoring discards them. Continue?')) return;
        if (!confirm(`Restore the version saved ${when(v.saved_at)}? It replaces the live page.`)) return;
        busy(restore, true);
        try {
          await admin.restoreContent(v.id);
          toast('Version restored. The live page updates within a minute.');
          await reload();
        } catch (err) { toast(err.message || 'Could not restore that version.', 'error'); busy(restore, false); }
      });
      list.appendChild(el('li', {
        attrs: { style: 'display:flex;justify-content:space-between;gap:1rem;align-items:center;flex-wrap:wrap;padding:.5rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm,6px)' },
        children: [
          el('span', { text: `${when(v.saved_at)} · ${v.saved_by_email || 'seed'}`, attrs: { style: 'font-size:var(--fs-sm)' } }),
          el('span', { attrs: { style: 'display:flex;gap:.5rem' }, children: [view, restore] }),
        ],
      }));
    }
    history.appendChild(list);
  }

  function load(slug) {
    if (state.dirty && slug !== state.slug && !confirm('Discard your unsaved changes to this page?')) return;
    state.slug = slug;
    state.dirty = false;
    for (const b of picker.children) b.setAttribute('aria-pressed', String(b.dataset.slug === slug));
    for (const b of picker.children) b.className = b.dataset.slug === slug ? 'btn btn--primary btn--sm' : 'btn btn--outline btn--sm';
    const p = page();
    area.value = JSON.stringify(p.json, null, 2);
    meta.textContent = `Last updated ${when(p.updated_at)}${p.updated_by_email ? ` by ${p.updated_by_email}` : ' (seeded)'} · the JSON's own "updated" field is the date shown on the page.`;
    preview(p.json);
    check();
    drawHistory();
  }

  async function reload() {
    data = await admin.listContent();
    const slug = state.slug;
    state.dirty = false;
    state.slug = null;
    load(slug);
  }

  for (const p of PAGES) {
    const b = btn(p.label, 'btn btn--outline btn--sm', { 'aria-pressed': 'false', 'data-slug': p.slug });
    b.dataset.slug = p.slug;
    b.addEventListener('click', () => load(p.slug));
    picker.appendChild(b);
  }

  let timer = null;
  area.addEventListener('input', () => {
    state.dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { const v = check(); if (v) preview(v); }, 400);
  });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Indent instead of leaving the editor; Esc then Tab still moves focus.
      if (area.dataset.escaped === '1') { area.dataset.escaped = ''; return; }
      e.preventDefault();
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
    } else if (e.key === 'Escape') {
      area.dataset.escaped = '1';
    }
  });
  previewBtn.addEventListener('click', () => { const v = check(); if (v) preview(v); });
  resetBtn.addEventListener('click', () => {
    if (state.dirty && !confirm('Discard your unsaved changes?')) return;
    state.dirty = false;
    const slug = state.slug;
    state.slug = null;
    load(slug);
  });
  saveBtn.addEventListener('click', async () => {
    const json = check();
    if (!json) return;
    busy(saveBtn, true);
    try {
      await admin.saveContent({ slug: state.slug, json, expected_updated_at: page().updated_at });
      toast('Saved. The live page updates within a minute.');
      await reload();
    } catch (err) {
      const reason = err.details?.reason;
      if (reason === 'STALE_CONTENT') {
        toast('Someone else saved this page since you opened it. Copy your changes, reload the tab and apply them again.', 'error', 8000);
      } else if (reason === 'CONTENT_INVALID' && Array.isArray(err.details?.problems)) {
        problems.replaceChildren(el('ul', { children: err.details.problems.map((p) => el('li', { text: `${p.path} ${p.message}` })) }));
        toast('The server found problems in the content.', 'error');
      } else {
        toast(err.message || 'Could not save.', 'error');
      }
    } finally { busy(saveBtn, false); check(); }
  });

  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  const editor = el('section', { attrs: { style: CARD, 'aria-labelledby': 'content-edit-title' } });
  editor.append(
    el('h3', { text: 'Edit a page', attrs: { id: 'content-edit-title', style: 'margin:0 0 .75rem;font-size:var(--fs-md)' } }),
    picker,
    meta,
    el('label', { text: 'Page content (JSON)', attrs: { for: 'content-json', style: LABEL } }),
    area,
    problems,
    el('div', { attrs: { style: 'display:flex;gap:.5rem;flex-wrap:wrap' }, children: [saveBtn, resetBtn, previewBtn] }),
  );

  const prev = el('section', { attrs: { style: CARD, 'aria-label': 'Preview' } });
  prev.append(
    el('h3', { text: 'Preview', attrs: { style: 'margin:0 0 .5rem;font-size:var(--fs-md)' } }),
    el('p', { text: 'Rendered exactly as the live page. Course links point to the catalog here; the live page links the matching course.', attrs: { style: 'margin:0 0 .75rem;font-size:var(--fs-sm);color:var(--muted)' } }),
    frame,
  );

  const hist = el('section', { attrs: { style: CARD } });
  hist.appendChild(history);

  container.append(pub, editor, prev, hist);
  load(state.slug);
}
