// 从 web/src/api.js 生成 mobile/src/transport/api.generated.ts：与 Web 同名、同路径、同参数的 REST 方法。
//
// Web 的 Api 对象全部是一行一个的箭头函数：api.<method>(path[, body][, {params, signal, timeout, data}]).then(unwrap)。
// 这里不执行 api.js（它依赖 axios/window），而是把源码中的 `api.` 替换成 App 的适配器 `a.` 后原样搬过来：
// 适配器提供与 axios 相同的 get/post/put/patch/delete 签名，内部转给 HttpClient（App 令牌、401 处理、User-Agent）。
// 浏览器专属的方法（上传、WebSocket URL）不在这里，由 transport 层单独实现。
//
//   node scripts/gen-api.mjs          生成
//   node scripts/gen-api.mjs --check  只检查是否与 web/src/api.js 一致（不一致时非零退出）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, '../web/src/api.js'), 'utf8');
const target = resolve(root, 'src/transport/api.generated.ts');

const start = source.indexOf('export const Api = {');
const end = source.indexOf('\n};', start);
if (start < 0 || end < 0) throw new Error('web/src/api.js: Api object not found');
const body = source.slice(start + 'export const Api = {'.length, end);

// 每个方法从 "  name: (" 开始，到下一个方法或对象结束为止（个别方法跨多行）。
const entries = [];
const lines = body.split('\n');
let current = null;
for (const line of lines) {
  const head = line.match(/^  ([A-Za-z_$][\w$]*): /);
  if (head) {
    if (current) entries.push(current);
    current = { name: head[1], text: line.trim() };
  } else if (current && line.trim()) {
    current.text += ' ' + line.trim();
  }
}
if (current) entries.push(current);

// 浏览器专属：上传走 transport/uploads.ts（分片读取本地文件）。
const SKIP = new Set(['uploadConversationFiles']);
const methods = [];
const skipped = [];
for (const { name, text } of entries) {
  if (SKIP.has(name)) {
    skipped.push(name);
    continue;
  }
  let code = text.replace(/,$/, '');
  if (!/\bapi\.(get|post|put|patch|delete)\(/.test(code)) {
    skipped.push(name);
    continue;
  }
  code = code.replace(/\bapi\.(get|post|put|patch|delete)\(/g, 'a.$1(');
  methods.push({ name, code });
}

const out = `// 由 scripts/gen-api.mjs 从 web/src/api.js 生成，不要手改；Web 增减接口后重新生成。
// 共 ${methods.length} 个方法；未生成（浏览器专属，transport 层另行实现）：${skipped.join(', ') || '无'}。
/* eslint-disable */
// @ts-nocheck
import type { AxiosLike } from './apiAdapter';

const unwrap = (response: { data: any }) => response.data;

export function createApi(a: AxiosLike) {
  return {
${methods.map((m) => `    ${m.code},`).join('\n')}
  };
}

export type OpenBearApi = ReturnType<typeof createApi>;
export const API_METHOD_NAMES = ${JSON.stringify(methods.map((m) => m.name))} as const;
`;

if (process.argv.includes('--check')) {
  const existing = readFileSync(target, 'utf8');
  if (existing !== out) {
    console.error('api.generated.ts 与 web/src/api.js 不一致，请运行 node scripts/gen-api.mjs');
    process.exit(1);
  }
  console.log(`api.generated.ts 最新（${methods.length} 个方法）`);
} else {
  writeFileSync(target, out);
  console.log(`生成 ${methods.length} 个方法 -> ${target}；跳过：${skipped.join(', ')}`);
}
