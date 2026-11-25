/* js/app/content/gwa.mjs — ALE score calculator logic (pure, unit-tested).
 *
 * GWA = A×.30 + B×.30 + C×.40, rounded to one decimal place.
 * PASSED needs GWA ≥ 70 AND every subject ≥ 50.
 */

export const WEIGHTS = Object.freeze({ A: 0.3, B: 0.3, C: 0.4 });
export const PASS_AVERAGE = 70;
export const SUBJECT_FLOOR = 50;

const clamp = (n) => Math.min(100, Math.max(0, Math.round(Number(n) || 0)));
const round1 = (n) => Math.round(n * 10) / 10;

/** "Subject A", "Subject A and C", "Subject A, B and C". */
function joinSubjects(list) {
  if (list.length < 2) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * @param {{A:number,B:number,C:number}} scores  0–100 each
 * @returns {{scores, gwa:number, gwaText:string, pass:boolean, status:'pass'|'floor'|'average',
 *            verdict:string, reason:string, low:string[], short:number, math:string}}
 */
export function scoreVerdict(scores) {
  const sc = { A: clamp(scores?.A), B: clamp(scores?.B), C: clamp(scores?.C) };
  // Work in tenths so 70.0 is exactly 70 (0.1 floating error never flips a verdict).
  const gwa = Math.round(sc.A * 3 + sc.B * 3 + sc.C * 4) / 10;
  const low = Object.keys(sc).filter((k) => sc[k] < SUBJECT_FLOOR);
  const pass = gwa >= PASS_AVERAGE && low.length === 0;
  const short = pass || low.length ? 0 : round1(PASS_AVERAGE - gwa);
  const status = pass ? 'pass' : low.length ? 'floor' : 'average';

  const verdict = pass ? 'PASSED' : low.length ? 'FAILED · BELOW SUBJECT FLOOR' : 'FAILED · AVERAGE BELOW 70%';
  const reason = pass
    ? 'Both rules met: average is at least 70% and no subject is under 50%.'
    : low.length
      ? `Subject ${joinSubjects(low)} ${low.length > 1 ? 'are' : 'is'} under 50%. This fails the exam even ${
          gwa >= PASS_AVERAGE ? 'though the average clears 70%.' : 'before the average is considered.'}`
      : `Every subject clears 50%, but the average is ${short.toFixed(1)} points short of 70%.`;

  return {
    scores: sc, gwa, gwaText: gwa.toFixed(1), pass, status, verdict, reason, low, short,
    math: `(${sc.A} × .30) + (${sc.B} × .30) + (${sc.C} × .40)`,
  };
}
