import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScore, segments, nextPosition, createClickGate, sanitizeLayout } from '../extension/core.mjs';

function scoreImage(systems = 3, extraStaff = false) {
  const width = 800, height = 1100;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const line = y => { for (let x = 65; x < 740; x++) { const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; } };
  for (let s = 0; s < systems; s++) for (const top of [110 + s * 280, 210 + s * 280]) for (let k = 0; k < 5; k++) line(top + k * 8);
  if (extraStaff) for (let k = 0; k < 5; k++) line(970 + k * 8);
  return { width, height, data };
}
test('pairs piano staves and retains annotation margins', () => {
  const result = analyzeScore(scoreImage());
  assert.equal(result.staffCount, 6); assert.equal(result.cuts.length, 2);
  assert.ok(result.crop.top * 1100 <= 60);
  assert.ok(result.crop.bottom * 1100 >= 860);
  assert.ok(result.cuts[0] * 1100 > 242 && result.cuts[0] * 1100 < 390);
});
test('odd staff count and blank page fall back without hiding content', () => {
  for (const image of [scoreImage(3, true), scoreImage(0)]) {
    const result = analyzeScore(image); assert.equal(result.confidence, 'manual');
    assert.deepEqual(result.crop, { left: 0, right: 1, top: 0, bottom: 1 });
  }
});
test('segments cross PDF pages and advance in groups without duplicate final step', () => {
  const page = analyzeScore(scoreImage());
  const list = segments([page, page], 'two'); assert.equal(list.length, 6);
  assert.equal(list[3].page, 1);
  assert.deepEqual([0, 2, 4].map(i => nextPosition(i, 6, 'two', 1)), [2, 4, 4]);
  assert.equal(nextPosition(2, 5, 'two', 1), 4);
  assert.equal(nextPosition(0, 6, 'two', -1), 0);
  assert.equal(segments([page, page], 'page').length, 2);
});
test('click gate rejects bounce and accepts a later intentional press', () => {
  let now = 0; const gate = createClickGate(() => now);
  assert.equal(gate.accept(350), true); now = 20; assert.equal(gate.accept(350), false);
  now = 349; assert.equal(gate.accept(350), false); now = 350; assert.equal(gate.accept(350), true);
  gate.reset(); assert.equal(gate.accept(350), true);
});
test('layout drops invalid and duplicate cuts', () => {
  const p = sanitizeLayout({ crop: { top: .1, bottom: .9, left: 0, right: 1 }, cuts: [.5, .501, -.2, .95, NaN, .3] });
  assert.deepEqual(p.cuts, [.3, .5]);
});
