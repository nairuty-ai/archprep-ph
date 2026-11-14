/* js/product.js — product (course) detail page.
 *
 * Reads ?slug from the URL, fetches the product, renders a course-landing
 * layout (dark title band + sticky purchase card), and handles the
 * Buy now → PayMongo checkout flow.
 */

import { api, ApiError }                      from './api.js';
import { getSession }                         from './supabase.js';
import { el, peso, setText }                  from './dom.js';
import { renderLoading, renderError }         from './states.js';
import { currentRef }                         from './referral.js';
import { buildThumb, buildCourseCard, typeLabel } from './catalog.js';
import { buildCarousel }                      from './carousel.js';
import { icon }                               from './icons.js';

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------
export async function initProduct(container) {
  const params = new URLSearchParams(location.search);
  const slug = params.get('slug');

  const shell = () => {
    container.innerHTML = '';
    const box = el('div', { class: 'container', attrs: { style: 'padding-top:3rem;padding-bottom:3rem' } });
    container.appendChild(box);
    return box;
  };

  if (!slug) {
    renderError(shell(), 'No course specified. Please go back to the catalog.', () => { location.href = '/catalog.html'; });
    return;
  }

  renderLoading(shell(), 'Loading course…');

  let product;
  try {
    product = await api.getProduct(slug);
  } catch (err) {
    renderError(shell(), err.message || 'Could not load this course.', () => initProduct(container));
    return;
  }

  document.title = product.title + ' — ArchPrep PH';

  // Does the signed-in user already own this product?
  const session = await getSession();
  let alreadyOwned = false;
  if (session) {
    try {
      const enrollments = await api.getEnrollments();
      alreadyOwned = enrollments.some((e) => e.product_id === product.id);
    } catch {
      // Non-fatal — falls back to the buy button.
    }
  }

  _render(container, product, session, alreadyOwned);
  _renderRelated(container, product);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function _render(container, product, session, alreadyOwned) {
  container.innerHTML = '';
  const type = product.type || 'material';

  // ---- Title band ---------------------------------------------------------
  const crumbs = el('nav', {
    class: 'breadcrumb',
    attrs: { 'aria-label': 'Breadcrumb' },
    children: [
      el('a', { text: 'Catalog', attrs: { href: '/catalog.html' } }),
      el('span', { class: 'sep', text: '›', attrs: { 'aria-hidden': 'true' } }),
      el('a', { text: type === 'quiz_pack' ? 'Practice quizzes' : 'Review materials', attrs: { href: '/catalog.html?type=' + type } }),
    ],
  });
  if (product.subject) {
    crumbs.appendChild(el('span', { class: 'sep', text: '›', attrs: { 'aria-hidden': 'true' } }));
    crumbs.appendChild(el('a', { text: product.subject, attrs: { href: '/catalog.html?subject=' + encodeURIComponent(product.subject) } }));
  }

  const heroMain = el('div', { class: 'course-hero-main', children: [crumbs, el('h1', { text: product.title || '' })] });
  if (product.subtitle) heroMain.appendChild(el('p', { class: 'course-hero-sub', text: product.subtitle }));

  const badges = el('div', {
    class: 'course-hero-badges',
    children: [el('span', {
      class: type === 'quiz_pack' ? 'course-badge course-badge--quiz' : 'course-badge',
      text: typeLabel(type),
    })],
  });
  if (alreadyOwned) badges.appendChild(el('span', { class: 'course-badge course-badge--owned', text: 'Purchased' }));
  if (product.subject) badges.appendChild(el('span', { text: product.subject }));
  heroMain.appendChild(badges);

  heroMain.appendChild(el('p', {
    class: 'course-hero-meta',
    children: [document.createTextNode('Created by '), el('a', { text: 'ArchPrep PH', attrs: { href: '/catalog.html' } })],
  }));

  heroMain.appendChild(el('ul', {
    class: 'course-hero-facts',
    attrs: { role: 'list' },
    children: [
      fact('bolt', 'Instant access after payment'),
      fact('globe', 'English'),
      fact('device', 'Phone, tablet or laptop'),
    ],
  }));

  const hero = el('section', {
    class: 'course-hero',
    children: [el('div', { class: 'container course-hero-inner', children: [heroMain] })],
  });

  // ---- Purchase card --------------------------------------------------------
  const actionArea = el('div', { class: 'buy-actions', attrs: { id: 'product-action-area' } });
  _renderActionArea(actionArea, product, session, alreadyOwned);

  const includes = type === 'quiz_pack'
    ? [['quiz', 'Exam-style practice questions'], ['chart', 'Instant scoring when you submit']]
    : [['file', 'Focused review material'], ['book', 'Open it any time from My learning']];
  includes.push(['bolt', 'Unlocks the moment payment clears'], ['infinity', 'No expiry — yours to keep'], ['device', 'Access on mobile and desktop']);

  const buyBody = el('div', {
    class: 'buy-card-body',
    children: [
      el('p', { class: 'buy-price', text: peso(product.price_php) }),
      actionArea,
      el('p', { class: 'buy-note', text: 'Secure checkout by PayMongo · GCash, Maya, GrabPay or card' }),
      el('div', {
        class: 'buy-includes',
        children: [
          el('h3', { text: 'This course includes:' }),
          el('ul', {
            class: 'icon-list',
            attrs: { role: 'list' },
            children: includes.map(([ic, text]) => el('li', { children: [icon(ic, 16), el('span', { text })] })),
          }),
        ],
      }),
      el('div', {
        class: 'buy-share',
        children: [
          el('a', { text: 'Share & earn ₱9', attrs: { href: '/earnings.html' } }),
          el('a', { text: 'Questions?', attrs: { href: '/faq.html' } }),
        ],
      }),
    ],
  });

  const buyCard = el('aside', {
    class: 'buy-card',
    attrs: { 'aria-label': 'Purchase' },
    children: [buildThumb(product), buyBody],
  });

  // ---- Main column ----------------------------------------------------------
  const main = el('div', { class: 'course-main' });

  const includesItems = Array.isArray(product.includes) ? product.includes.filter(Boolean) : [];
  if (includesItems.length) {
    main.appendChild(el('section', {
      class: 'learn-box',
      children: [
        el('h2', { text: "What's included" }),
        el('ul', {
          class: 'learn-list',
          attrs: { role: 'list' },
          children: includesItems.map((item) => el('li', { children: [icon('check', 16, 2.4), el('span', { text: String(item) })] })),
        }),
      ],
    }));
  }

  if (product.description) {
    main.appendChild(el('section', {
      class: 'course-section course-desc',
      children: [el('h2', { text: 'Description' }), el('p', { text: product.description })],
    }));
  }

  main.appendChild(el('section', {
    class: 'course-section',
    children: [
      el('h2', { text: 'How access works' }),
      el('ol', {
        class: 'access-steps',
        attrs: { role: 'list' },
        children: [
          accessStep('1', 'Sign in with your email', 'Free account, no password — we email you a 6-digit code.'),
          accessStep('2', 'Pay securely', 'GCash, Maya, GrabPay or card through PayMongo checkout.'),
          accessStep('3', 'Open it in My learning', type === 'quiz_pack'
            ? 'Start the quiz right away and see your score when you submit.'
            : 'Open your review material any time, on any device.'),
        ],
      }),
    ],
  }));

  const layout = el('div', { class: 'container course-layout', children: [buyCard, main] });

  container.appendChild(hero);
  container.appendChild(layout);
}

function fact(ic, text) {
  return el('li', { children: [icon(ic, 16), el('span', { text })] });
}

function accessStep(n, title, text) {
  return el('li', {
    children: [
      el('span', { class: 'step-dot', text: n, attrs: { 'aria-hidden': 'true' } }),
      el('div', { children: [el('strong', { text: title }), el('span', { text })] }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Related courses
// ---------------------------------------------------------------------------
async function _renderRelated(container, product) {
  let products;
  try {
    products = await api.getCatalog();
  } catch {
    return; // Optional section — skip quietly.
  }
  const others = products.filter((p) => p.id !== product.id);
  if (!others.length) return;

  const sameSubject = others.filter((p) => product.subject && p.subject === product.subject);
  const rest = others.filter((p) => !sameSubject.includes(p));
  const picks = [...sameSubject, ...rest].slice(0, 12);

  container.appendChild(el('section', {
    class: 'section--tight',
    attrs: { 'aria-label': 'More courses' },
    children: [el('div', {
      class: 'container',
      children: [
        el('h2', { class: 'section-title', text: 'More courses you might like', attrs: { style: 'margin-bottom:1.25rem' } }),
        buildCarousel(picks.map(buildCourseCard), { label: 'More courses' }),
      ],
    })],
  }));
}

// ---------------------------------------------------------------------------
// Action area
// ---------------------------------------------------------------------------
function _ownedLink() {
  return el('a', {
    class: 'btn btn--dark btn--lg btn--block',
    text: 'Go to My learning',
    attrs: { href: '/my-learning.html' },
  });
}

function _renderActionArea(area, product, session, alreadyOwned) {
  area.innerHTML = '';

  if (alreadyOwned) {
    area.appendChild(el('p', { class: 'text-success mb-0', text: '✓ You own this course.', attrs: { style: 'font-weight:700;font-size:var(--fs-sm)' } }));
    area.appendChild(_ownedLink());
    return;
  }

  const btn = el('button', {
    class: 'btn btn--primary btn--lg btn--block',
    text: 'Buy now',
    attrs: {
      type: 'button',
      'aria-label': 'Buy ' + product.title + ' for ' + peso(product.price_php),
    },
  });
  area.appendChild(btn);

  if (!session) {
    area.appendChild(el('p', {
      class: 'buy-note',
      text: 'You’ll sign in with your email (free) before paying.',
      attrs: { style: 'margin-top:0' },
    }));
  }

  const errMsg = el('p', { class: 'buy-error', attrs: { role: 'alert' } });
  area.appendChild(errMsg);

  btn.addEventListener('click', async () => {
    if (!session) {
      // Save intended product and redirect to login.
      sessionStorage.setItem('pending_product_id', product.id);
      sessionStorage.setItem('login_redirect', '/product.html?slug=' + encodeURIComponent(product.slug));
      location.href = '/login.html';
      return;
    }

    btn.disabled = true;
    setText(btn, 'Processing…');
    errMsg.textContent = '';

    try {
      const { checkout_url } = await api.createPayment({
        product_id: product.id,
        ref_code: currentRef(),
      });
      location.href = checkout_url;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'already_owned') {
        area.innerHTML = '';
        area.appendChild(el('p', { class: 'text-success mb-0', text: '✓ You already own this course.', attrs: { style: 'font-weight:700;font-size:var(--fs-sm)' } }));
        area.appendChild(_ownedLink());
      } else {
        errMsg.textContent = err.message || 'Payment could not be started. Please try again.';
        btn.disabled = false;
        setText(btn, 'Buy now');
      }
    }
  });
}
