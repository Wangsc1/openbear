// 构建内嵌编辑器：vite build -> 把 JS/CSS 内联进 index.html -> 写 src/editor/editorHtml.generated.ts。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '../../web');
const require = createRequire(resolve(web, 'package.json'));
const { build } = require('vite');

await build({ configFile: resolve(here, 'vite.config.mjs') });

const dist = resolve(here, 'dist');
let html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const assets = resolve(dist, 'assets');
const files = readdirSync(assets);
for (const name of files.filter((f) => f.endsWith('.css'))) {
  const css = readFileSync(resolve(assets, name), 'utf8');
  html = html.replace(new RegExp(`<link[^>]*href="[^"]*${name}"[^>]*>`), () => `<style>${css}</style>`);
}
for (const name of files.filter((f) => f.endsWith('.js'))) {
  // </script 出现在脚本内容里会提前结束标签
  const js = readFileSync(resolve(assets, name), 'utf8').replace(/<\/script/gi, '<\\/script');
  html = html.replace(new RegExp(`<script[^>]*src="[^"]*${name}"[^>]*></script>`), () => `<script type="module">${js}</script>`);
}
if (/src="\.?\/?assets\//.test(html) || /href="\.?\/?assets\//.test(html)) throw new Error('editor html still references external assets');

const out = resolve(here, '../src/editor/editorHtml.generated.ts');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `// 由 editor/build.mjs 生成的内嵌编辑器（Monaco，自包含 HTML），不要手改。\n/* eslint-disable */\nexport const EDITOR_HTML = ${JSON.stringify(html)};\n`,
);
console.log(`editor html ${(html.length / 1024 / 1024).toFixed(2)} MB -> ${out}`);
