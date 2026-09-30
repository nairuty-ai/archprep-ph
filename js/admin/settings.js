/* js/admin/settings.js — Settings management tab. */

import { admin } from '../api.js';
import { el } from '../dom.js';
import { renderLoading, renderError, toast } from '../states.js';

// ---- helpers ---------------------------------------------------------------

function row(label, control) {
  const wrap = el('div', { attrs: { style: 'margin-bottom:1rem' } });
  wrap.appendChild(el('label', { text: label, attrs: { style: 'display:block;font-weight:700;font-size:var(--fs-xs);margin-bottom:.35rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)' } }));
  wrap.appendChild(control);
  return wrap;
}

function textInp(value, placeholder) {
  const i = document.createElement('input');
  i.type = 'text'; i.value = value ?? ''; i.placeholder = placeholder ?? '';
  i.style.cssText = 'width:100%;min-height:var(--tap);padding:.5rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);';
  return i;
}

function numInp(value, placeholder) {
  const i = document.createElement('input');
  i.type = 'number'; i.value = value ?? ''; i.placeholder = placeholder ?? '';
  i.style.cssText = 'width:100%;min-height:var(--tap);padding:.5rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);';
  return i;
}

function radioGroup(name, options, currentValue) {
  const wrap = el('div', { attrs: { style: 'display:flex;gap:1rem;flex-wrap:wrap' } });
  for (const opt of options) {
    const label = el('label', { attrs: { style: 'display:flex;align-items:center;gap:.4rem;font-weight:600;cursor:pointer' } });
    const rb = document.createElement('input');
    rb.type = 'radio'; rb.name = name; rb.value = opt.value;
    rb.checked = opt.value === currentValue;
    rb.style.cssText = 'width:18px;height:18px;accent-color:var(--accent)';
    label.appendChild(rb);
    label.appendChild(el('span', { text: opt.label }));
    wrap.appendChild(label);
  }
  return wrap;
}

function getRadioValue(container, name) {
  const rb = container.querySelector(`input[name="${name}"]:checked`);
  return rb ? rb.value : null;
}

function saveBtn(onClick) {
  const btn = el('button', { class: 'btn btn--primary btn--sm', text: 'Save', attrs: { type: 'button', style: 'margin-top:.5rem' } });
  btn.addEventListener('click', onClick);
  return btn;
}

// ---- section builders ------------------------------------------------------

function buildReferralSection(settings, section) {
  section.appendChild(el('h3', { text: 'Referral Config', attrs: { style: 'margin:0 0 1rem;font-size:var(--fs-md)' } }));

  const amountInp = numInp(settings.referral_amount, '150');
  const thresholdInp = numInp(settings.payout_threshold, '500');

  const rewardTypeGroup = radioGroup('reward_type',
    [{ value: 'cash', label: 'Cash (GCash)' }, { value: 'credit', label: 'Store credit' }],
    settings.reward_type ?? 'cash');

  const rewardOnGroup = radioGroup('reward_on',
    [{ value: 'every_purchase', label: 'Every purchase' }, { value: 'first_purchase_only', label: 'First purchase only' }],
    settings.reward_on ?? 'every_purchase');

  section.appendChild(row('Referral amount (PHP)', amountInp));
  section.appendChild(row('Payout threshold (PHP)', thresholdInp));
  section.appendChild(row('Reward type', rewardTypeGroup));
  section.appendChild(row('Reward on', rewardOnGroup));

  section.appendChild(saveBtn(async (e) => {
    const btn = e.target;
    btn.disabled = true;
    try {
      await Promise.all([
        admin.upsertSetting('referral_amount', String(amountInp.value)),
        admin.upsertSetting('payout_threshold', String(thresholdInp.value)),
        admin.upsertSetting('reward_type', getRadioValue(section, 'reward_type') ?? 'cash'),
        admin.upsertSetting('reward_on', getRadioValue(section, 'reward_on') ?? 'every_purchase'),
      ]);
      toast('Referral settings saved.');
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false;
  }));
}

function buildAnswerRevealSection(settings, section) {
  section.appendChild(el('h3', { text: 'Answer Reveal', attrs: { style: 'margin:0 0 1rem;font-size:var(--fs-md)' } }));

  const revealGroup = radioGroup('answer_reveal_mode',
    [{ value: 'answered_only', label: 'Answered questions only' }, { value: 'full_reveal', label: 'Full reveal after submit' }],
    settings.answer_reveal_mode ?? 'answered_only');

  section.appendChild(row('Answer reveal mode', revealGroup));

  section.appendChild(saveBtn(async (e) => {
    const btn = e.target;
    btn.disabled = true;
    try {
      await admin.upsertSetting('answer_reveal_mode', getRadioValue(section, 'answer_reveal_mode') ?? 'answered_only');
      toast('Answer reveal setting saved.');
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false;
  }));
}

function buildBrandSection(settings, section) {
  section.appendChild(el('h3', { text: 'Brand & Contact', attrs: { style: 'margin:0 0 1rem;font-size:var(--fs-md)' } }));

  const brandNameInp     = textInp(settings.brand_name, 'ArchPrep PH');
  const contactEmailInp  = textInp(settings.contact_email, 'hello@archprep.ph');
  const heroHeadInp      = textInp(settings.hero_headline, '');
  const heroSubInp       = textInp(settings.hero_subhead, '');

  const bannerArea = document.createElement('textarea');
  bannerArea.value = settings.announcement_banner ?? '';
  bannerArea.placeholder = 'Announcement banner text (leave blank to hide)';
  bannerArea.style.cssText = 'width:100%;min-height:72px;padding:.5rem .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:var(--font-body);font-size:var(--fs-sm);resize:vertical;';

  section.appendChild(row('Brand name', brandNameInp));
  section.appendChild(row('Contact email', contactEmailInp));
  section.appendChild(row('Hero headline', heroHeadInp));
  section.appendChild(row('Hero subhead', heroSubInp));
  section.appendChild(row('Announcement banner', bannerArea));

  section.appendChild(saveBtn(async (e) => {
    const btn = e.target;
    btn.disabled = true;
    try {
      await Promise.all([
        admin.upsertSetting('brand_name', brandNameInp.value.trim()),
        admin.upsertSetting('contact_email', contactEmailInp.value.trim()),
        admin.upsertSetting('hero_headline', heroHeadInp.value.trim()),
        admin.upsertSetting('hero_subhead', heroSubInp.value.trim()),
        admin.upsertSetting('announcement_banner', bannerArea.value.trim()),
      ]);
      toast('Brand settings saved.');
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false;
  }));
}

// ---- init ------------------------------------------------------------------

export async function init(container, params) {
  container.innerHTML = '';
  container.appendChild(el('h2', { text: 'Settings', attrs: { style: 'margin:0 0 1.25rem' } }));

  const loadArea = el('div');
  container.appendChild(loadArea);

  async function load() {
    renderLoading(loadArea, 'Loading settings…');
    try {
      const res = await admin.listSettings();
      const settings = {};
      const rows = res.settings ?? res ?? [];
      // Normalise: [{key,value}] → {}
      if (Array.isArray(rows)) {
        for (const r of rows) settings[r.key] = r.value;
      } else {
        Object.assign(settings, rows);
      }

      loadArea.innerHTML = '';

      const cardStyle = 'background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;margin-bottom:1.5rem;';

      const s1 = el('div', { attrs: { style: cardStyle } });
      buildReferralSection(settings, s1);
      loadArea.appendChild(s1);

      const s2 = el('div', { attrs: { style: cardStyle } });
      buildAnswerRevealSection(settings, s2);
      loadArea.appendChild(s2);

      const s3 = el('div', { attrs: { style: cardStyle } });
      buildBrandSection(settings, s3);
      loadArea.appendChild(s3);

    } catch (err) {
      renderError(loadArea, err.message, load);
    }
  }

  load();
}
