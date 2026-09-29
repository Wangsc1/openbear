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

test('cost keeps two decimals with half-up rounding', () => {
  assert.equal(fmtCost(40.56968), '$40.57');
  assert.equal(fmtCost(35.92098), '$35.92');
  assert.equal(fmtCost(106.9134), '$106.91');
  assert.equal(fmtCost(0.25), '$0.25');
  assert.equal(fmtCost(1.005), '$1.01');
  assert.equal(fmtCost(2.6749), '$2.67');
  assert.equal(fmtCost(9.996), '$10.00');
});

test('tiny positive costs stay visibly non-zero and zero stays empty', () => {
  assert.equal(fmtCost(0.0049), '<$0.01');
  assert.equal(fmtCost(0.00012), '<$0.01');
  assert.equal(fmtCost(0.005), '$0.01');
  for (const empty of [0, null, undefined, -1, 'x']) assert.equal(fmtCost(empty), '—');
});
