/* Course detail: dark hero, content, and the buy box in one of four states
 * (README "Course detail"): new · owned material · owned with attempts left ·
 * attempts used.
 */

import {
  el, $, peso, formatDate, param, accessLine, thumb, TYPE_LABEL, SUBJECT_LABEL,
  getProduct, getProductQuizzes, getCatalog, getOwned, getLatestEnrollment,
} from '../core.js';
import { mountShell, goToLogin } from '../shell.js';
import { stateCard } from '../ui.js';

const root = $('#course');
const { user, settings } = await mountShell({ active: 'catalog' });

function showError(err) {
  root.removeAttribute('aria-busy');
  const missing = err?.code === 'not_found';
  root.replaceChildren(el('div', { class: 'wrap wrap--narrow page-pad' }, stateCard({
    icon: missing ? '?' : '⚠', tone: missing ? 'muted' : 'warn',
    title: missing ? 'Page not found' : 'We couldn’t load this page',
    body: missing ? 'This course may have been unpublished or the link is wrong.'
                  : 'Check your connection and try again.',
    cta: 'Go to catalog', ctaHref: 'catalog.html', cta2: 'Home', cta2Href: 'index.html',
  })));
}

const slug = param('slug');
const product = slug ? await getProduct(slug).catch((err) => { showError(err); return null; })
                     : (showError({ code: 'not_found' }), null);
if (product) await render(product);

async function render(product) {
  document.title = `${product.title} — ArkiPrep`;

  const [quizzes, catalog, owned, latest] = await Promise.all([
    getProductQuizzes(product.id),
    getCatalog().catch(() => []),
    user ? getOwned() : {},
    user ? getLatestEnrollment(product.id) : null,
  ]);
  const own = owned[product.id] ?? null;

  // A free sample for the same subject backs the "Try free questions" button.
  const sample = catalog.find((p) => p.type === 'free' && (p.subject === product.subject || p.subject === 'ALL'));

  const checkoutHref = `checkout.html?product=${encodeURIComponent(product.slug)}`;
  const examHref = (quiz) => `exam.html?quiz=${encodeURIComponent(quiz.id)}`;

  function gated(href) {
    return (e) => {
      if (user) return;
      e.preventDefault();
      goToLogin(product.type === 'free' ? 'start' : 'buy', href);
    };
  }

  function buyState() {
    const isAttempts = product.access_mode === 'attempts';
    const used = !own && latest && latest.attempts_allowed != null && latest.attempts_used >= latest.attempts_allowed;

    if (own && product.access_mode === 'exam_date') {
      return {
        banner: ['success', `✓ You own this · access until ${formatDate(own.expires_at)} (ALE)`],
        access: 'Access ends on the ALE date. After that you can buy it again for the next exam.',
        primary: ['Open reviewer', `viewer.html?product=${encodeURIComponent(product.slug)}`],
      };
    }
    if (own && isAttempts) {
      const left = own.attempts_allowed - own.attempts_used;
      return {
        banner: ['success', `✓ You own this · ${left} of ${own.attempts_allowed} attempts left`],
        access: 'Starting an attempt uses it, even if you leave early. It auto-submits when time ends.',
        primary: quizzes[0] ? [`Start attempt ${own.attempts_used + 1}`, examHref(quizzes[0])] : null,
      };
    }
    if (own) {
      return { banner: ['success', '✓ You have access'], primary: quizzes[0] ? ['Start', examHref(quizzes[0])] : null };
    }
    if (product.type === 'free') {
      return {
        price: true,
        access: 'Free with an account · unlimited attempts',
        primary: quizzes[0] ? ['Start free', examHref(quizzes[0])] : null,
      };
    }
    if (used) {
      return {
        banner: ['warn', 'Both attempts used. Your scores and answers stay saved.'],
        price: true,
        access: `Buying again adds ${product.attempts_per_purchase} new attempts.`,
        primary: [`Buy ${product.attempts_per_purchase} more attempts · ${peso(product.price_php)}`, checkoutHref],
      };
    }
    return {
      price: true,
      access: 'Access: ' + accessLine(product, settings),
      primary: ['Buy now', checkoutHref],
      trySample: !!sample && sample.id !== product.id,
    };
  }

  function facts() {
    if (product.type === 'material') {
      return [
        product.material_pages ? `${product.material_pages} pages of reviewers (online viewer)` : 'Reviewer in the online viewer',
        'Watermarked with your email · no downloads',
        accessLine(product, settings),
      ];
    }
    const items = ['Timed like the ALE · auto-submits', 'Flag for review & question navigator',
                   'Score by subject + public leaderboard', 'Explanation for every item after you submit'];
    if (product.access_mode === 'attempts') items.push(`${product.attempts_per_purchase} attempts per purchase`);
    return items;
  }

  function buyBox() {
    const s = buyState();
    const body = el('div', { class: 'body' });
    if (s.banner) body.append(el('div', { class: `banner banner--${s.banner[0]}`, style: 'font-weight:700', text: s.banner[1] }));
    if (s.price) body.append(el('div', { class: 'price', text: peso(product.price_php) }));
    if (s.access) body.append(el('div', { style: 'font-size:14px;font-weight:700;line-height:1.45', text: s.access }));
    if (s.primary) {
      const a = el('a', { class: 'btn btn--primary btn--block', href: s.primary[1], text: s.primary[0] });
      a.addEventListener('click', gated(s.primary[1]));
      body.append(a);
    }
    if (s.trySample) {
      body.append(el('a', {
        class: 'btn btn--secondary btn--block',
        href: `product.html?slug=${encodeURIComponent(sample.slug)}`, text: 'Try free questions',
      }));
    }
    body.append(
      el('p', { class: 'small muted', style: 'text-align:center;line-height:1.45' },
        'GCash · Maya · QR Ph · Bank deposit', el('br'), 'All sales final · view online only, no downloads'),
      el('div', { class: 'stack gap-6', style: 'font-size:14px;border-top:1px solid var(--border);padding-top:12px' },
        el('strong', { style: 'font-size:15px', text: 'This course includes' }),
        ...facts().map((f) => el('span', { text: '• ' + f }))),
      el('div', { class: 'banner banner--info' },
        el('strong', { text: `Share & earn ₱${settings.referral_amount || 9}` }), ' each time a friend buys with your link.'));
    return el('aside', { class: 'buybox', attrs: { 'aria-label': 'Purchase' } }, thumb(product, 'thumb'), body);
  }

  function contentList() {
    if (product.type === 'material') {
      return [el('div', { class: 'module' },
        el('span', { style: 'font-weight:700', text: 'Reviewer (online viewer)' }),
        el('span', { class: 'muted', style: 'font-size:14px', text: product.material_pages ? `${product.material_pages} pages` : '' }))];
    }
    if (!quizzes.length) return [el('div', { class: 'module', text: 'Quiz content is being prepared.' })];
    return quizzes.map((q) => el('div', { class: 'module' },
      el('span', { style: 'font-weight:700', text: q.title }),
      el('span', { class: 'muted', style: 'font-size:14px',
        text: q.time_limit_sec ? `${Math.round(q.time_limit_sec / 60)} min · timed` : 'Untimed' })));
  }

  function paragraphs(text) {
    return (text || '').split(/\n{2,}/).map((t) => t.trim()).filter(Boolean)
      .map((t) => el('p', { style: 'font-size:16px;line-height:1.6;color:var(--text-2)', text: t }));
  }

  const includes = Array.isArray(product.includes) ? product.includes.filter((i) => typeof i === 'string') : [];

  root.removeAttribute('aria-busy');
  root.replaceChildren(
    el('section', { class: 'course-hero' }, el('div', { class: 'inner' }, el('div', { class: 'stack gap-12' },
      el('nav', { class: 'crumbs', attrs: { 'aria-label': 'Breadcrumb' } },
        el('a', { href: 'catalog.html', text: 'Browse' }), el('span', { text: '›', attrs: { 'aria-hidden': 'true' } }),
        el('a', { href: `catalog.html?type=${product.type}`, text: TYPE_LABEL[product.type] })),
      el('h1', { text: product.title }),
      product.subtitle && el('p', { class: 'sub', text: product.subtitle }),
      el('div', { class: 'row gap-12 wrap-flex', style: 'font-size:14px' },
        el('span', { class: 'hero-tag', text: TYPE_LABEL[product.type] }),
        el('span', { text: SUBJECT_LABEL[product.subject] }),
        el('span', { style: 'color:#a9c1ee', text: accessLine(product, settings) }))))),
    el('div', { class: 'course-body' },
      el('div', { class: 'stack gap-32', style: 'padding-top:32px' },
        includes.length > 0 && el('section', { class: 'card stack gap-12', style: 'border-radius:0;padding:24px' },
          el('h2', { style: 'font-size:22px;font-weight:800', text: 'What you’ll be able to do' }),
          el('ul', { class: 'learn-list' }, ...includes.map((i) => el('li', { text: i })))),
        el('section', { class: 'stack gap-12' },
          el('h2', { style: 'font-size:22px;font-weight:800', text: 'Course content' }),
          el('div', { class: 'module-list' }, ...contentList())),
        product.description && el('section', { class: 'stack gap-12' },
          el('h2', { style: 'font-size:22px;font-weight:800', text: 'About this course' }),
          ...paragraphs(product.description))),
      buyBox()),
  );

  // Phones: sticky bottom price + primary action (Mobile M3).
  const s = buyState();
  if (s.primary) {
    document.body.classList.add('has-mobile-buy');
    const bar = el('div', { class: 'mobile-buy' },
      el('div', { class: 'stack' },
        el('strong', { style: 'font-size:20px', text: own ? '✓ Owned' : peso(product.price_php) }),
        el('span', { class: 'small muted', text: accessLine(product, settings) })),
      el('a', { class: 'btn btn--primary', style: 'flex:1', href: s.primary[1], text: s.primary[0] }));
    bar.querySelector('a').addEventListener('click', gated(s.primary[1]));
    root.append(bar);
  }
}
