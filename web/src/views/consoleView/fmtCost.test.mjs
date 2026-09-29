import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url = new URL(`./.fmt-cost-test-${process.pid}.mjs`, import.meta.url);
let fmtCost;
try {
  const source = fs.readFileSync(new URL('./display.js', import.meta.url), 'utf8')
    .replace('import ContextCompactionIcon from "./legacy/ContextCompactionIcon.vue";', 'const ContextCompactionIcon = {};')
    .replace('import {plainText} from "./markdown.js";', 'const plainText = value => String(value || "");');
  fs.writeFileSync(url, source);
  ({fmtCost} = await import(url.href));
} finally { fs.rmSync(url, {force: true}); }

test('cost keeps two decimals with decimal half-up rounding at different magnitudes', () => {
  for (const [value, expected] of [
    [40.56968, '$40.57'], [35.92098, '$35.92'], [106.9134, '$106.91'],
    [0.25, '$0.25'], [1.005, '$1.01'], [10.075, '$10.08'], [100.005, '$100.01'],
    [2.6749, '$2.67'], [9.996, '$10.00'], ['10.075', '$10.08'],
  ]) assert.equal(fmtCost(value), expected, String(value));
});

test('tiny positive costs stay visibly non-zero and invalid/zero costs stay empty', () => {
  for (const tiny of [0.0049, 0.00012, 1e-7, 5e-324]) assert.equal(fmtCost(tiny), '<$0.01');
  assert.equal(fmtCost(0.005), '$0.01');
  assert.equal(fmtCost(1e6), '$1000000.00');
  for (const empty of [0, null, undefined, -1, 'x', NaN, Infinity]) assert.equal(fmtCost(empty), '—');
});
