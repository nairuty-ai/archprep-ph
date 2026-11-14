/* js/icons.js — inline SVG icons and illustrations built with createElementNS.
 *
 * Everything here is constant markup (no user or database content), built
 * node-by-node so the project's "no innerHTML" rule still holds.
 *
 * Usage:
 *   import { icon, illustration } from './icons.js';
 *   button.appendChild(icon('arrowRight', 16));
 *   card.appendChild(illustration('temple'));
 */

const NS = 'http://www.w3.org/2000/svg';

/** Build an SVG element from a [tag, attrs, children?] spec tree. */
function build(spec) {
  const [tag, attrs = {}, children = []] = spec;
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const child of children) node.appendChild(build(child));
  return node;
}

// ---------------------------------------------------------------------------
// Line icons (24×24, stroke = currentColor)
// ---------------------------------------------------------------------------
const ICONS = {
  arrowRight:   [['path', { d: 'M5 12h14' }], ['path', { d: 'm13 6 6 6-6 6' }]],
  chevronLeft:  [['path', { d: 'm15 6-6 6 6 6' }]],
  chevronRight: [['path', { d: 'm9 6 6 6-6 6' }]],
  check:        [['path', { d: 'M20 6 9 17l-5-5' }]],
  close:        [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  bolt:         [['path', { d: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z' }]],
  infinity:     [['path', { d: 'M18.2 8.2a5 5 0 1 1 0 7.6L12 12 5.8 8.2a5 5 0 1 0 0 7.6L12 12z' }]],
  device:       [['rect', { x: 7, y: 2, width: 10, height: 20, rx: 2 }], ['path', { d: 'M11 18h2' }]],
  shield:       [['path', { d: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z' }], ['path', { d: 'm9 12 2 2 4-4' }]],
  wallet:       [['rect', { x: 3, y: 6, width: 18, height: 14, rx: 2 }], ['path', { d: 'M3 10h18M16 15h2' }]],
  file:         [['path', { d: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z' }], ['path', { d: 'M14 3v5h5M9 13h6M9 17h6' }]],
  quiz:         [['rect', { x: 4, y: 3, width: 16, height: 18, rx: 2 }], ['path', { d: 'm8 9 1.5 1.5L12 8M8 15l1.5 1.5L12 14M14 9h2M14 15h2' }]],
  target:       [['circle', { cx: 12, cy: 12, r: 9 }], ['circle', { cx: 12, cy: 12, r: 5 }], ['circle', { cx: 12, cy: 12, r: 1 }]],
  chart:        [['path', { d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }]],
  user:         [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4 21c0-4 4-6 8-6s8 2 8 6' }]],
  filter:       [['path', { d: 'M4 6h16M7 12h10M10 18h4' }]],
  share:        [['circle', { cx: 18, cy: 5, r: 3 }], ['circle', { cx: 6, cy: 12, r: 3 }], ['circle', { cx: 18, cy: 19, r: 3 }], ['path', { d: 'm8.6 13.5 6.8 4M15.4 6.5l-6.8 4' }]],
  globe:        [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z' }]],
  lock:         [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }]],
  play:         [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'm10 8 6 4-6 4z' }]],
  book:         [['path', { d: 'M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z' }]],
};

/**
 * A 24×24 line icon.
 * @param {keyof ICONS} name
 * @param {number} [size=20]
 * @param {number} [stroke=2]
 */
export function icon(name, size = 20, stroke = 2) {
  const paths = ICONS[name] || ICONS.arrowRight;
  return build(['svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': stroke,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  }, paths]);
}

/** Large quotation mark used on testimonial cards. */
export function quoteMark(size = 28) {
  return build(['svg', { width: size, height: size, viewBox: '0 0 32 32', fill: 'currentColor', 'aria-hidden': 'true' }, [
    ['path', { d: 'M13 7C7.5 9 4 13.5 4 19.5 4 23 6.2 25 9 25c2.6 0 4.5-2 4.5-4.5S11.7 16 9.3 16c-.5 0-1 .1-1.3.2C8.6 12.8 10.8 10.4 14 9z' }],
    ['path', { d: 'M27 7c-5.5 2-9 6.5-9 12.5 0 3.5 2.2 5.5 5 5.5 2.6 0 4.5-2 4.5-4.5S25.7 16 23.3 16c-.5 0-1 .1-1.3.2.6-3.4 2.8-5.8 6-7.2z' }],
  ]]);
}

/** Small brand mark (the "A" frame) used on generated course covers. */
export function brandMark(size = 15) {
  return build(['svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: '#fff',
    'stroke-width': 2.6, 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  }, [['path', { d: 'M3 21 12 3l9 18' }], ['path', { d: 'M7.5 21 12 12l4.5 9' }]]]);
}

// ---------------------------------------------------------------------------
// Category illustrations (200×200). Colours come from CSS classes:
//   .ill-a  tone dark   .ill-b  tone bright   .ill-w  white   .ill-k  ink
// ---------------------------------------------------------------------------
const ILLUSTRATIONS = {
  temple: [
    ['ellipse', { cx: 100, cy: 182, rx: 84, ry: 8, class: 'ill-shadow' }],
    ['polygon', { points: '24,72 100,26 176,72', class: 'ill-a' }],
    ['polygon', { points: '52,66 100,38 148,66', class: 'ill-b' }],
    ['rect', { x: 24, y: 72, width: 152, height: 14, rx: 2, class: 'ill-k' }],
    ['rect', { x: 38, y: 90, width: 18, height: 64, rx: 3, class: 'ill-w' }],
    ['rect', { x: 71, y: 90, width: 18, height: 64, rx: 3, class: 'ill-w' }],
    ['rect', { x: 111, y: 90, width: 18, height: 64, rx: 3, class: 'ill-w' }],
    ['rect', { x: 144, y: 90, width: 18, height: 64, rx: 3, class: 'ill-w' }],
    ['rect', { x: 18, y: 156, width: 164, height: 10, rx: 2, class: 'ill-a' }],
    ['rect', { x: 10, y: 166, width: 180, height: 10, rx: 2, class: 'ill-b' }],
  ],
  building: [
    ['ellipse', { cx: 100, cy: 182, rx: 84, ry: 8, class: 'ill-shadow' }],
    ['rect', { x: 150, y: 28, width: 7, height: 148, class: 'ill-k' }],
    ['rect', { x: 84, y: 28, width: 104, height: 7, class: 'ill-k' }],
    ['path', { d: 'M100 35v28', class: 'ill-line' }],
    ['rect', { x: 92, y: 62, width: 16, height: 10, rx: 2, class: 'ill-b' }],
    ['rect', { x: 34, y: 78, width: 78, height: 98, rx: 4, class: 'ill-a' }],
    ['rect', { x: 46, y: 92, width: 16, height: 14, rx: 2, class: 'ill-w' }],
    ['rect', { x: 84, y: 92, width: 16, height: 14, rx: 2, class: 'ill-w' }],
    ['rect', { x: 46, y: 118, width: 16, height: 14, rx: 2, class: 'ill-w' }],
    ['rect', { x: 84, y: 118, width: 16, height: 14, rx: 2, class: 'ill-w' }],
    ['rect', { x: 64, y: 146, width: 18, height: 30, rx: 2, class: 'ill-b' }],
    ['rect', { x: 112, y: 120, width: 34, height: 56, rx: 3, class: 'ill-b' }],
    ['rect', { x: 20, y: 174, width: 160, height: 6, rx: 3, class: 'ill-k' }],
  ],
  blueprint: [
    ['ellipse', { cx: 100, cy: 182, rx: 80, ry: 8, class: 'ill-shadow' }],
    ['rect', { x: 26, y: 34, width: 148, height: 132, rx: 8, class: 'ill-a' }],
    ['path', { d: 'M26 67h148M26 100h148M26 133h148M63 34v132M100 34v132M137 34v132', class: 'ill-grid' }],
    ['path', { d: 'M48 56h70v42h36v50H48z', class: 'ill-plan' }],
    ['path', { d: 'M48 98h40M88 98v50', class: 'ill-plan' }],
    ['polygon', { points: '118,176 182,176 182,112', class: 'ill-w ill-fade' }],
    ['polygon', { points: '134,168 170,168 170,132', class: 'ill-a' }],
  ],
  utilities: [
    ['ellipse', { cx: 100, cy: 182, rx: 80, ry: 8, class: 'ill-shadow' }],
    ['path', { d: 'M24 60h56a20 20 0 0 1 20 20v90', class: 'ill-pipe-a' }],
    ['path', { d: 'M176 110h-36a20 20 0 0 0-20 20v40', class: 'ill-pipe-b' }],
    ['rect', { x: 70, y: 48, width: 14, height: 24, rx: 3, class: 'ill-k' }],
    ['rect', { x: 92, y: 132, width: 16, height: 14, rx: 3, class: 'ill-k' }],
    ['circle', { cx: 150, cy: 54, r: 30, class: 'ill-w' }],
    ['polygon', { points: '154,30 136,58 150,58 144,80 166,48 152,48', class: 'ill-a' }],
    ['path', { d: 'M48 120c0-10 12-24 12-24s12 14 12 24a12 12 0 0 1-24 0z', class: 'ill-b' }],
  ],
  document: [
    ['ellipse', { cx: 100, cy: 182, rx: 76, ry: 8, class: 'ill-shadow' }],
    ['rect', { x: 44, y: 26, width: 104, height: 140, rx: 8, class: 'ill-w' }],
    ['rect', { x: 60, y: 46, width: 56, height: 8, rx: 4, class: 'ill-a' }],
    ['rect', { x: 60, y: 66, width: 72, height: 6, rx: 3, class: 'ill-b ill-fade' }],
    ['rect', { x: 60, y: 80, width: 72, height: 6, rx: 3, class: 'ill-b ill-fade' }],
    ['rect', { x: 60, y: 94, width: 52, height: 6, rx: 3, class: 'ill-b ill-fade' }],
    ['circle', { cx: 120, cy: 136, r: 18, class: 'ill-a' }],
    ['path', { d: 'm112 136 6 6 10-12', class: 'ill-tick' }],
    ['rect', { x: 140, y: 70, width: 14, height: 92, rx: 4, transform: 'rotate(24 147 116)', class: 'ill-k' }],
    ['polygon', { points: '128,160 138,166 128,174', transform: 'rotate(24 147 116)', class: 'ill-b' }],
  ],
  quiz: [
    ['ellipse', { cx: 100, cy: 182, rx: 76, ry: 8, class: 'ill-shadow' }],
    ['rect', { x: 36, y: 26, width: 128, height: 144, rx: 10, class: 'ill-w' }],
    ['rect', { x: 52, y: 46, width: 22, height: 22, rx: 5, class: 'ill-a' }],
    ['path', { d: 'm57 57 4 4 8-9', class: 'ill-tick' }],
    ['rect', { x: 84, y: 50, width: 62, height: 7, rx: 3.5, class: 'ill-b ill-fade' }],
    ['rect', { x: 52, y: 84, width: 22, height: 22, rx: 5, class: 'ill-a' }],
    ['path', { d: 'm57 95 4 4 8-9', class: 'ill-tick' }],
    ['rect', { x: 84, y: 88, width: 52, height: 7, rx: 3.5, class: 'ill-b ill-fade' }],
    ['rect', { x: 52, y: 122, width: 22, height: 22, rx: 5, class: 'ill-outline' }],
    ['rect', { x: 84, y: 126, width: 62, height: 7, rx: 3.5, class: 'ill-b ill-fade' }],
    ['circle', { cx: 158, cy: 36, r: 20, class: 'ill-b' }],
    ['path', { d: 'm150 36 6 6 10-11', class: 'ill-tick' }],
  ],
};

const ILL_ORDER = ['blueprint', 'temple', 'building', 'utilities', 'document', 'quiz'];

/** Pick an illustration that fits a subject / category name. */
export function illustrationFor(name, fallbackIndex = 0) {
  const s = String(name || '').toLowerCase();
  if (/util|mechan|electr|plumb|sanit|fire/.test(s))              return 'utilities';
  if (/hist|theor|heritage/.test(s))                              return 'temple';
  if (/struct|material|construct|engineer|build/.test(s))        return 'building';
  if (/design|site|plan|urban|draft/.test(s))                     return 'blueprint';
  if (/practice|law|profession|ethic|contract|spec|manage/.test(s)) return 'document';
  if (/quiz|mock|exam|drill|test/.test(s))                        return 'quiz';
  return ILL_ORDER[Math.abs(fallbackIndex) % ILL_ORDER.length];
}

/** Full category illustration SVG. */
export function illustration(name) {
  const shapes = ILLUSTRATIONS[name] || ILLUSTRATIONS.blueprint;
  return build(['svg', { viewBox: '0 0 200 200', 'aria-hidden': 'true', focusable: 'false', class: 'ill' }, shapes]);
}
