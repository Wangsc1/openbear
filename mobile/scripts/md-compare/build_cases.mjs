#!/usr/bin/env node
// 生成 Markdown 逐类对比用例：真实语料片段（来自只读导出的 markdown-corpus.json）+ 针对性边界用例。
// 输出 <数据目录>/bench/md-cases.json，供 App 的 /mdlab 页面（经模拟后端提供）与 Web 参考渲染共用同一批内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = process.env.OPENBEAR_MOBILE_DATA || path.join(os.homedir(), '.cache', 'openbear-mobile');
const BENCH = process.env.OPENBEAR_BENCH_DIR || path.join(DATA, 'bench');
const corpus = JSON.parse(fs.readFileSync(path.join(BENCH, 'markdown-corpus.json'), 'utf8'));

/** 截取包含某个特征的一段（按空行对齐，不切断围栏/表格） */
function excerpt(text, pattern, maxChars = 900) {
  const blocks = text.split(/\n{2,}/);
  const index = blocks.findIndex((b) => pattern.test(b));
  if (index < 0) return text.slice(0, maxChars);
  let start = Math.max(0, index - 1);
  let out = [];
  let size = 0;
  for (let i = start; i < blocks.length && size < maxChars; i += 1) {
    out.push(blocks[i]);
    size += blocks[i].length;
  }
  let result = out.join('\n\n');
  const fences = (result.match(/^```/gm) || []).length;
  if (fences % 2) result += '\n```';
  return result;
}

const pick = (key, index) => corpus[key][index]?.text || '';

const cases = [
  {
    id: 'cjk-emphasis-real',
    category: '中文强调',
    source: corpus.cjk_emphasis[1]?.opId,
    markdown: excerpt(pick('cjk_emphasis', 1), /\*\*[^*]*[。，：！？）】」]\*\*[\u4e00-\u9fff]/, 700),
  },
  {
    id: 'cjk-emphasis-edge',
    category: '中文强调',
    source: 'synthetic (markdown-it-cjk-friendly README cases)',
    markdown: [
      '**该星号不会被识别，而是直接显示。**这是因为它没有被识别为强调符号。',
      '',
      '这是**“引号开头”**的强调，以及**（括号）**紧贴正文。',
      '',
      '*斜体结尾是句号。*后面紧跟中文；~~删除线，~~后面紧跟中文。',
      '',
      '普通情况：**加粗**、*斜体*、`行内代码`、**中英 mixed 强调**。',
    ].join('\n'),
  },
  {
    id: 'code-real',
    category: '代码',
    source: corpus.code_fence[2]?.opId,
    markdown: excerpt(pick('code_fence', 2), /^```/m, 1200),
  },
  {
    id: 'code-edge',
    category: '代码',
    source: 'synthetic',
    markdown: [
      '行内代码 `const x = a<b && c>d;` 与中文混排。',
      '',
      '```typescript',
      'export function projectOperationMessages(operations: Operation[], options = {}): ProjectedMessage[] {',
      '  // 一行很长的注释，用来观察长代码行是横向滚动还是自动换行 ———————————————————————',
      '  return normalizeOperations(operations).map((op) => ({ ...op, displaySeq: Number(op.displaySeq || 0) }));',
      '}',
      '```',
      '',
      '```bash',
      'adb shell dumpsys gfxinfo dev.openbear.app reset && echo "done"',
      '```',
    ].join('\n'),
  },
  {
    id: 'table-real',
    category: '表格',
    source: corpus.table[3]?.opId,
    markdown: excerpt(pick('table', 3), /^\|/m, 900),
  },
  {
    id: 'table-wide',
    category: '表格',
    source: corpus.table[0]?.opId,
    markdown: excerpt(pick('table', 0), /^\|/m, 1100),
  },
  {
    id: 'math-edge',
    category: '公式',
    source: 'synthetic (OpenBear 使用 markdown-it-texmath：$ / $$ / \\( \\) / \\[ \\])',
    markdown: [
      '行内公式 $E = mc^2$，以及 $\\frac{a}{b} + \\sqrt{x^2+y^2}$。',
      '',
      '块公式（$$）：',
      '',
      '$$',
      '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
      '$$',
      '',
      '括号分隔：\\(\\alpha + \\beta\\) 与块：',
      '',
      '\\[',
      '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
      '\\]',
      '',
      '价格写法 $13.47 和 $5 不应被当成公式。',
    ].join('\n'),
  },
  {
    id: 'math-real',
    category: '公式',
    source: corpus.math[1]?.opId,
    markdown: excerpt(pick('math', 1), /\$/, 700),
  },
  {
    id: 'link-quote-real',
    category: '链接和引用',
    source: corpus.link[2]?.opId,
    markdown: excerpt(pick('link', 2), /\]\(/, 700),
  },
  {
    id: 'link-quote-edge',
    category: '链接和引用',
    source: 'synthetic',
    markdown: [
      '外链：[Expo SDK 57 文档](https://docs.expo.dev/versions/v57.0.0/)，裸链接 https://github.com/software-mansion/enriched-markdown 。',
      '',
      '产物链接：[openbear-native-app-design.md](/api/conversations/3ff04ebc/artifacts/workspace/artifacts/openbear-mobile/openbear-native-app-design.md)',
      '',
      '> 引用块第一段，含 **强调** 和 `code`。',
      '>',
      '> 第二段引用。',
      '',
      '- 列表项一',
      '  - 嵌套项',
      '- 列表项二',
      '',
      '1. 有序一',
      '2. 有序二',
    ].join('\n'),
  },
  {
    id: 'heading-real',
    category: '标题与段落',
    source: corpus.heading[2]?.opId,
    markdown: excerpt(pick('heading', 2), /^#{1,4} /m, 800),
  },
];

const out = path.join(BENCH, 'md-cases.json');
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2));
console.log(`wrote ${out}`);
for (const c of cases) console.log(c.id, c.category, c.markdown.length, c.source || '');
