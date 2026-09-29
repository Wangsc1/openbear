import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./style.css', import.meta.url), 'utf8');

test('initial browser chrome contract matches verified calculator pattern', () => {
  assert.match(html, /meta name="theme-color" content="#f8f8f8"/);
  assert.match(html, /meta name="color-scheme" content="light"/);
  assert.match(html, /browserColor = dark \? "#161616" : "#f8f8f8"/);
  assert.match(html, /meta\[name="color-scheme"\].*content = resolvedTheme/);
  assert.ok(html.indexOf('browserColor =') < html.indexOf('<script type="module" src="/src/main.js"'));
});

test('fixed edge samplers expose background without any exclusion filter', () => {
  assert.match(html, /safari-tint safari-tint-top/);
  assert.match(html, /safari-tint safari-tint-bottom/);
  const sampler = css.match(/\.safari-tint\s*\{([^}]+)\}/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(sampler, /position:\s*fixed/);
  assert.match(sampler, /background:\s*var\(--ob-bg\)/);
  assert.doesNotMatch(sampler, /(?:backdrop-)?filter\s*:/);
  assert.match(css, /html, body\s*\{\s*transition:\s*none\s*!important/);
  assert.match(css, /\.safari-tint-top\s*\{\s*top:\s*-8px/);
  assert.match(css, /\.safari-tint-bottom\s*\{\s*bottom:\s*-8px/);
});
