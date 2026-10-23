// 中文强调预处理（src/chat/markdown/cjkEmphasis.ts）对照测试。
//
// 基准：Web 端实际使用的 markdown-it 配置（web/src/views/consoleView/markdown.js：breaks/linkify/typographer
//       + markdown-it-cjk-friendly + markdown-it-texmath），从 web/node_modules 只读引用。
// 被测：preprocessForMd4c（含 fixCjkEmphasis）后，交给与 App 相同的 md4c（react-native-enriched-markdown
//       自带源码 + App 的解析标志）解析。md4c 由 tests/support/md4c_probe.c 编译成对照程序。
// 判定：逐个强调区间（strong/em/del）比较“是否识别为强调”和“强调文字（去掉两端标点后）”是否一致；
//       只差边界标点（挪动定界符造成）单独计为“边界差异”。
//
// 运行：npm test（需要 gcc；没有基准数据时跳过真实回复部分）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { preprocessForMd4c } from '../src/chat/markdown/BodyRenderer.ts';
import { fixCjkEmphasis } from '../src/chat/markdown/cjkEmphasis.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const webModules = path.resolve(mobileRoot, '../web/node_modules');
const webRequire = createRequire(path.join(webModules, 'markdown-it', 'package.json'));
const { default: MarkdownIt } = await import(path.join(webModules, 'markdown-it/index.mjs'));
const { default: cjkFriendly } = await import(path.join(webModules, 'markdown-it-cjk-friendly/dist/index.js'));
const texmath = webRequire('markdown-it-texmath');
const katex = webRequire('katex');

const DATA = process.env.OPENBEAR_MOBILE_DATA || path.join(os.homedir(), '.cache', 'openbear-mobile');
const BENCH = process.env.OPENBEAR_BENCH_DIR || path.join(DATA, 'bench');
const PROBE_DIR = process.env.OPENBEAR_PROBE_DIR || path.join(DATA, 'build');
const REPORT = process.env.OPENBEAR_CJK_REPORT || path.join(PROBE_DIR, 'cjk-emphasis-report.json');

// ---- md4c 对照程序 ----
function buildProbe() {
  const md4c = path.join(mobileRoot, 'node_modules/react-native-enriched-markdown/cpp/md4c');
  const out = path.join(PROBE_DIR, 'md4c_probe');
  const src = path.join(here, 'support/md4c_probe.c');
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) {
    execFileSync('gcc', ['-O2', '-DMD4C_USE_UTF8=1', `-I${md4c}`, '-o', out, src, path.join(md4c, 'md4c.c')]);
  }
  return out;
}
const probe = buildProbe();
function md4cMany(docs) {
  const out = execFileSync(probe, { input: docs.join('\x1e'), maxBuffer: 1 << 28 }).toString('utf8');
  return out.split('\x1e').slice(0, docs.length);
}

// ---- Web 基准（与 markdown.js createMarkdownRenderer 相同的选项与插件） ----
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true });
md.use(cjkFriendly);
md.use(texmath, { engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: { throwOnError: false, strict: 'ignore' } });
const TAG = { strong_open: '<strong>', strong_close: '</strong>', em_open: '<em>', em_close: '</em>', s_open: '<s>', s_close: '</s>' };
function webStream(text) {
  let out = '';
  for (const tok of md.parse(text, {})) {
    if (tok.type !== 'inline') continue;
    for (const c of tok.children || []) {
      if (TAG[c.type]) out += TAG[c.type];
      else if (c.type === 'text') out += c.content;
      else if (c.type === 'code_inline') out += `<code>${c.content}</code>`;
      else if (c.type === 'softbreak' || c.type === 'hardbreak') out += ' ';
      else if (c.type === 'math_inline' || c.type === 'math_inline_double') out += `<math>${c.content}</math>`;
    }
    out += '|';
  }
  return out;
}

// ---- 比较：提取强调区间 ----
const PUNCT_EDGE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;
function spans(stream) {
  const result = [];
  const stack = [];
  const re = /<(\/?)(strong|em|s)>|<code>[\s\S]*?<\/code>|<math>[\s\S]*?<\/math>|[^<]+|</g;
  let text = '';
  for (const m of stream.replace(/<\/?a>/g, '').matchAll(re)) {
    if (m[2]) {
      if (!m[1]) stack.push({ tag: m[2], at: text.length });
      else {
        const open = stack.pop();
        if (open) result.push({ tag: open.tag, text: text.slice(open.at) });
      }
    } else {
      text += m[0].replace(/<\/?(code|math)>/g, '');
    }
  }
  return result.map((s) => ({ tag: s.tag, text: s.text, core: s.text.replace(PUNCT_EDGE, '') }));
}
// typographer 会改写引号/省略号/破折号，比较前做统一归一化
const norm = (s) => s.replace(/[“”"]/g, '"').replace(/[‘’']/g, "'").replace(/…/g, '...').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
function compare(webS, nativeS) {
  const w = spans(webS);
  const n = spans(nativeS);
  const key = (s) => `${s.tag}:${norm(s.core)}`;
  const nKeys = n.map(key);
  let exact = 0;
  let boundary = 0;
  const missing = [];
  for (const s of w) {
    const k = key(s);
    const idx = nKeys.indexOf(k);
    if (idx < 0) {
      missing.push(s);
      continue;
    }
    if (norm(n[idx].text) === norm(s.text)) exact += 1;
    else boundary += 1;
    nKeys.splice(idx, 1);
    n.splice(idx, 1);
  }
  return { web: w.length, exact, boundary, missing, extra: n };
}
function analyze(text, preprocess = true) {
  const web = webStream(text);
  const [native] = md4cMany([preprocess ? preprocessForMd4c(text) : text]);
  return { ...compare(web, native), webStream: web, native };
}

// ---- 边界用例 ----
const EDGE = [
  { name: '闭合内侧句号', md: '**该星号不会被识别，而是直接显示。**这是因为它没有被识别为强调符号。' },
  { name: '开启引号', md: '这是**“引号开头”**的强调。' },
  { name: '开启括号', md: '以及**（括号）**紧贴正文。' },
  { name: '单星号斜体', md: '*斜体结尾是句号。*后面紧跟中文。' },
  { name: '删除线', md: '~~删除线，~~后面紧跟中文。' },
  { name: '嵌套', md: '**外层*内层。*继续。**后文' },
  { name: '行内代码中的星号', md: '用 `**不是强调。**里` 和 **真的。**后' },
  { name: '下划线（Web 对 _ 不放宽）', md: '__下划线。__后文 与 _单下划线。_后文' },
  { name: '链接文字', md: '[**链接文字。**说明](https://example.com/a**b。**c)后文' },
  { name: '强调包链接且前接汉字（已知剩余项）', md: '见**[文档](https://x.com)。**然后', knownResidual: true },
  { name: '强调包链接（前是空格）', md: '见 **[文档](https://x.com) 已发布。**然后' },
  { name: '全是标点（按规则不改写，已知剩余项）', md: '**。。**中文', knownResidual: true },
  { name: '闭合前是行内代码（不能挪进代码，已知剩余项）', md: '- **结束原因 `length`**时，仍可能改写。', knownResidual: true },
  { name: '相邻强调', md: '前**一。**二**三。**四' },
  { name: '数字与英文', md: '共 **14,968 个，约 91%**。以及 **h2**。还有 **Mac 接入局域网这一段**。' },
  { name: '普通情况', md: '普通：**加粗**、*斜体*、`code`、**中英 mixed 强调**、~~删~~。' },
  { name: '表格单元格', md: '| 列 | 值 |\n|---|---|\n| **说明。**后 | **数值：**12 |' },
  { name: '公式内星号', md: '公式 $a**b。**c$ 与 **说明。**后' },
  { name: '列表与标题', md: '- **第一项：**内容\n- **第二项。**内容\n\n### **标题。**后' },
  { name: 'ASCII 标点（CommonMark 本身不认，Web 也不认）', md: '**foo.**bar 与 **中文.**bar' },
];

test('边界用例：预处理后 md4c 与 Web 的强调判定一致（允许边界标点差异）', () => {
  const rows = [];
  for (const c of EDGE) {
    const before = analyze(c.md, false);
    const after = analyze(c.md, true);
    rows.push({ name: c.name, knownResidual: Boolean(c.knownResidual), input: c.md, output: preprocessForMd4c(c.md), web: after.webStream, nativeBefore: before.native, nativeAfter: after.native, missingBefore: before.missing.length, missingAfter: after.missing.length, boundary: after.boundary, extraAfter: after.extra.length });
  }
  fs.writeFileSync(REPORT.replace('.json', '-edge.json'), JSON.stringify(rows, null, 2));
  const mustPass = rows.filter((r) => !/下划线/.test(r.name) && !r.knownResidual);
  for (const r of mustPass) {
    assert.equal(r.missingAfter, 0, `${r.name}: Web 识别的强调在预处理后仍未识别\n  in : ${r.input}\n  out: ${r.output}\n  web: ${r.web}\n  md4c: ${r.nativeAfter}`);
    assert.equal(r.extraAfter, 0, `${r.name}: 预处理产生了 Web 没有的强调\n  out: ${r.output}\n  md4c: ${r.nativeAfter}`);
  }
  // 已知剩余项：预处理保持原样（不引入多余强调）
  for (const r of rows.filter((x) => x.knownResidual)) assert.equal(r.extraAfter, 0, `${r.name}: 不应引入多余强调`);
  // 预处理确实修复了此前的失败
  assert.ok(rows.filter((r) => r.missingBefore > 0 && r.missingAfter === 0).length >= 8);
});

test('未闭合与流式截断：只改写已成对的定界符，任一前缀都不产生 Web 没有的强调', () => {
  const doc = '这是**说明。**接着讲，**“引号”**、*斜体。*与 ~~删除，~~ 还有 `**代码。**` 以及**未闭合。';
  // 未闭合的 ** 原样保留
  assert.ok(fixCjkEmphasis('**未闭合。').startsWith('**未闭合。'));
  assert.equal(fixCjkEmphasis('前文**说明。'), '前文**说明。');
  const prefixes = [];
  for (let i = 1; i <= doc.length; i += 1) prefixes.push(doc.slice(0, i));
  const natives = md4cMany(prefixes.map((p) => preprocessForMd4c(p)));
  const raw = md4cMany(prefixes);
  let introduced = 0;
  let missingAfter = 0;
  let missingBefore = 0;
  const notes = [];
  prefixes.forEach((p, i) => {
    const web = webStream(p);
    const a = compare(web, natives[i]);
    const b = compare(web, raw[i]);
    // 预处理不得引入未预处理时没有的多余强调
    if (a.extra.length > b.extra.length) introduced += 1;
    if (b.extra.length) notes.push(`前缀 ${i + 1}（未预处理也存在）：${b.extra.map((s) => s.text).join('/')}`);
    missingAfter += a.missing.length;
    missingBefore += b.missing.length;
  });
  fs.writeFileSync(REPORT.replace('.json', '-stream.json'), JSON.stringify({ prefixes: prefixes.length, missingBefore, missingAfter, introduced, notes }, null, 2));
  assert.equal(introduced, 0, '预处理在流式前缀中引入了 Web 没有的强调');
  assert.equal(missingAfter, 0, '流式前缀中 Web 识别的强调未被识别');
  assert.ok(missingBefore > 0);
});

test('真实回复：基准三对话的助手正文（含 227 条 CJK 标点边界）', { skip: !fs.existsSync(path.join(BENCH, 'manifest.json')) }, () => {
  const BOUNDARY = /[。，、；：！？）」』”》】]\*\*[\u4e00-\u9fff]|\*\*[“（「《【]/;
  const docs = [];
  for (const u of ['a6a877ad-298a-4270-a444-ce4c2b5c292b', 'fed2ce26-0699-4ba0-a989-6c512fc1b16b', 'd8e18cc9-d50b-48b3-b44a-0e8b107de4ca']) {
    const ops = JSON.parse(fs.readFileSync(path.join(BENCH, 'conv', u, 'operations.json'), 'utf8'));
    for (const op of ops) {
      if (op.opType !== 'assistant_message') continue;
      const t = op.payload?.text || (op.payload?.textChunks || []).join('');
      if (t.trim()) docs.push({ id: `${u.slice(0, 8)}:${op.displaySeq}`, text: t, boundary: BOUNDARY.test(t) });
    }
  }
  const natBefore = md4cMany(docs.map((d) => d.text));
  const natAfter = md4cMany(docs.map((d) => preprocessForMd4c(d.text)));
  // Parse each document with the Web renderer once; both aggregates and the
  // residual list reuse the same per-document comparisons.
  const compared = docs.map((d, i) => {
    const web = webStream(d.text);
    return { before: compare(web, natBefore[i]), after: compare(web, natAfter[i]) };
  });
  const agg = (subset) => {
    const s = { docs: 0, webSpans: 0, before: { matched: 0, missing: 0, extra: 0, docsAllOk: 0 }, after: { exact: 0, boundary: 0, missing: 0, extra: 0, docsAllOk: 0 } };
    for (const i of subset) {
      const { before: b, after: a } = compared[i];
      s.docs += 1;
      s.webSpans += a.web;
      s.before.matched += b.exact + b.boundary;
      s.before.missing += b.missing.length;
      s.before.extra += b.extra.length;
      if (!b.missing.length && !b.extra.length) s.before.docsAllOk += 1;
      s.after.exact += a.exact;
      s.after.boundary += a.boundary;
      s.after.missing += a.missing.length;
      s.after.extra += a.extra.length;
      if (!a.missing.length && !a.extra.length) s.after.docsAllOk += 1;
    }
    return s;
  };
  const all = docs.map((_, i) => i);
  const boundaryDocs = all.filter((i) => docs[i].boundary);
  const residual = [];
  for (const i of all) {
    const a = compared[i].after;
    if (a.missing.length || a.extra.length) residual.push({ id: docs[i].id, missing: a.missing.map((s) => `${s.tag}:${s.text}`), extra: a.extra.map((s) => `${s.tag}:${s.text}`) });
  }
  const result = { all: agg(all), boundaryDocs: agg(boundaryDocs), residual };
  fs.writeFileSync(REPORT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ all: result.all, boundaryDocs: result.boundaryDocs, residualDocs: residual.length }, null, 1));
  assert.equal(result.boundaryDocs.docs, 227);
  // 修复后：缺失的强调大幅减少，且不引入 Web 没有的强调
  assert.ok(result.all.after.missing * 10 <= result.all.before.missing, '修复后缺失的强调应下降一个数量级');
  assert.ok(result.all.after.extra <= result.all.before.extra, '修复不应引入新的多余强调');
});
