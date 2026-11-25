/* js/app/content/courses.mjs — turn the courseId numbers used in the content
 * JSON into links to real products.
 *
 * The content (from the design prototype) numbers courses 1–6. Products here
 * have slugs, types and subjects, so each number maps to "the first published
 * product of this type and subject"; when there isn't one yet the link opens
 * the catalog filtered the same way.
 */

export const COURSE_KINDS = Object.freeze({
  1: { type: 'material', subject: 'A', label: 'Subject A reviewer' },
  2: { type: 'material', subject: 'B', label: 'Subject B reviewer' },
  3: { type: 'mock', subject: null, label: 'Full mock board' },
  4: { type: 'quiz', subject: 'A', label: 'Subject A quiz pack' },
  5: { type: 'quiz', subject: 'B', label: 'Subject B quiz pack' },
  6: { type: 'free', subject: null, label: 'Free diagnostic' },
});

/**
 * @param {Array<{slug:string,type:string,subject:string,status?:string}>} products
 *        published products in display order
 * @returns {(courseId:number|null) => string} relative href (page uses <base href="/">)
 */
export function courseResolver(products = []) {
  const live = products.filter((p) => !p.status || p.status === 'published');
  return (id) => {
    const kind = COURSE_KINDS[id];
    if (!kind) return 'catalog.html';
    const match = live.find((p) => p.type === kind.type && (!kind.subject || p.subject === kind.subject));
    if (match) return `product.html?slug=${encodeURIComponent(match.slug)}`;
    const q = new URLSearchParams({ type: kind.type });
    if (kind.subject) q.set('subject', kind.subject);
    return `catalog.html?${q}`;
  };
}
