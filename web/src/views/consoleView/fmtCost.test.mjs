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

test('cost keeps one decimal with half-up rounding', () => {
  assert.equal(fmtCost(40.56968), '$40.6');
  assert.equal(fmtCost(35.92098), '$35.9');
  assert.equal(fmtCost(106.9134), '$106.9');
  assert.equal(fmtCost(0.25), '$0.3');
  assert.equal(fmtCost(1.05), '$1.1');
  assert.equal(fmtCost(2.349), '$2.3');
  assert.equal(fmtCost(9.96), '$10.0');
});

test('tiny positive costs stay visibly non-zero and zero stays empty', () => {
  assert.equal(fmtCost(0.049), '<$0.1');
  assert.equal(fmtCost(0.00012), '<$0.1');
  assert.equal(fmtCost(0.05), '$0.1');
  for (const empty of [0, null, undefined, -1, 'x']) assert.equal(fmtCost(empty), '—');
});
