/* ALE score calculator: GWA = A×.30 + B×.30 + C×.40; PASSED needs GWA ≥ 70
 * and every subject ≥ 50. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreVerdict } from '../js/app/content/gwa.mjs';

const guide = JSON.parse(readFileSync(new URL('../content/ale-guide.json', import.meta.url), 'utf8'));
const preset = (label) => guide.calculatorPresets.find((p) => p.label === label);

test('preset "Passes" (74 / 71 / 77) passes with 74.3', () => {
  const v = scoreVerdict(preset('Passes'));
  assert.equal(v.gwaText, '74.3');
  assert.equal(v.pass, true);
  assert.equal(v.verdict, 'PASSED');
  assert.equal(v.reason, 'Both rules met: average is at least 70% and no subject is under 50%.');
});

test('preset "Fails on floor" (88 / 86 / 46) fails on Subject C although the average clears 70', () => {
  const v = scoreVerdict(preset('Fails on floor'));
  assert.equal(v.gwaText, '70.6');
  assert.equal(v.pass, false);
  assert.equal(v.status, 'floor');
  assert.equal(v.verdict, 'FAILED · BELOW SUBJECT FLOOR');
  assert.deepEqual(v.low, ['C']);
  assert.match(v.reason, /^Subject C is under 50%\. This fails the exam even though the average clears 70%\.$/);
});

test('preset "Fails on average" (68 / 66 / 70) is 1.8 points short', () => {
  const v = scoreVerdict(preset('Fails on average'));
  assert.equal(v.gwaText, '68.2');
  assert.equal(v.status, 'average');
  assert.equal(v.verdict, 'FAILED · AVERAGE BELOW 70%');
  assert.equal(v.short, 1.8);
  assert.equal(v.reason, 'Every subject clears 50%, but the average is 1.8 points short of 70%.');
});

test('edge: an average of exactly 70.0 passes', () => {
  for (const s of [{ A: 70, B: 70, C: 70 }, { A: 60, B: 60, C: 85 }, { A: 50, B: 100, C: 65 }]) {
    const v = scoreVerdict(s); // 70.0, 18+18+34 = 70.0, 15+30+26 = 71.0
    assert.ok(v.gwa >= 70, JSON.stringify(s));
    assert.equal(v.pass, true, JSON.stringify(s));
  }
  const v = scoreVerdict({ A: 60, B: 60, C: 85 });
  assert.equal(v.gwaText, '70.0');
  assert.equal(v.verdict, 'PASSED');
});

test('edge: just under 70 fails on the average with the points short', () => {
  const v = scoreVerdict({ A: 71, B: 66, C: 72 }); // 21.3 + 19.8 + 28.8 = 69.9
  assert.equal(v.gwaText, '69.9');
  assert.equal(v.status, 'average');
  assert.equal(v.short, 0.1);
  assert.equal(v.reason, 'Every subject clears 50%, but the average is 0.1 points short of 70%.');
});

test('edge: a subject at exactly 50 is allowed, 49 is not', () => {
  const at = scoreVerdict({ A: 80, B: 50, C: 80 }); // 24 + 15 + 32 = 71
  assert.equal(at.pass, true);
  assert.deepEqual(at.low, []);
  const below = scoreVerdict({ A: 80, B: 49, C: 80 }); // 70.7 but B < 50
  assert.equal(below.pass, false);
  assert.equal(below.status, 'floor');
  assert.deepEqual(below.low, ['B']);
});

test('several subjects under the floor are all named', () => {
  const v = scoreVerdict({ A: 40, B: 45, C: 90 });
  assert.deepEqual(v.low, ['A', 'B']);
  assert.match(v.reason, /^Subject A and B are under 50%\. This fails the exam even before the average is considered\.$/);
});

test('inputs are clamped to whole numbers 0–100', () => {
  const v = scoreVerdict({ A: '150', B: -5, C: 'x' });
  assert.deepEqual(v.scores, { A: 100, B: 0, C: 0 });
  assert.equal(v.gwaText, '30.0');
});

test('one decimal place, no floating-point drift', () => {
  for (let a = 0; a <= 100; a += 7) for (let b = 0; b <= 100; b += 9) for (let c = 0; c <= 100; c += 11) {
    const v = scoreVerdict({ A: a, B: b, C: c });
    assert.match(v.gwaText, /^\d{1,3}\.\d$/);
    assert.equal(v.gwa, (a * 3 + b * 3 + c * 4) / 10);
  }
});
