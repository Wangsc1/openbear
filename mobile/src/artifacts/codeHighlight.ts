/**
 * 轻量代码高亮（产物预览的源码视图用，纯逻辑）：把一行切成带类别的片段（注释/字符串/数字/关键字/标签/属性）。
 * 只做读代码时的视觉区分，不做语法分析；未知语言整行原样返回。
 */
export type Token = { text: string; kind: '' | 'comment' | 'string' | 'number' | 'keyword' | 'tag' | 'attr' | 'heading' | 'punct' };

const KEYWORDS: Record<string, string[]> = {
  javascript: 'const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of null undefined true false this super yield'.split(' '),
  typescript: 'const let var function return if else for while do switch case break continue new class extends implements interface type enum import export from default async await try catch finally throw typeof instanceof in of null undefined true false this super readonly public private protected as keyof'.split(' '),
  python: 'def return if elif else for while in not and or import from as class try except finally raise with lambda None True False pass break continue yield async await global nonlocal is assert del'.split(' '),
  bash: 'if then else elif fi for in do done while case esac function return export local echo exit set unset source'.split(' '),
  go: 'func return if else for range switch case break continue package import var const type struct interface map chan go defer select nil true false'.split(' '),
  rust: 'fn let mut return if else for while loop match struct enum impl trait pub use mod crate self Self true false as where async await move ref'.split(' '),
  java: 'public private protected class interface extends implements return if else for while new static final void int boolean null true false import package try catch finally throw throws this super'.split(' '),
  sql: 'select from where and or not insert into values update set delete create table index join left right inner outer on group by order having limit as null is in like distinct'.split(' '),
  c: 'int char float double void return if else for while do switch case break continue struct typedef static const unsigned long short sizeof include define null'.split(' '),
  json: 'true false null'.split(' '),
  yaml: 'true false null yes no'.split(' '),
};
KEYWORDS.cpp = KEYWORDS.c;
KEYWORDS.csharp = KEYWORDS.java;
KEYWORDS.kotlin = KEYWORDS.java;
KEYWORDS.swift = KEYWORDS.rust;
KEYWORDS.ruby = KEYWORDS.python;
KEYWORDS.php = KEYWORDS.javascript;
KEYWORDS.powershell = KEYWORDS.bash;
KEYWORDS.ini = KEYWORDS.yaml;

const LINE_COMMENT: Record<string, string> = {
  javascript: '//', typescript: '//', go: '//', rust: '//', java: '//', c: '//', cpp: '//', csharp: '//', kotlin: '//', swift: '//', php: '//',
  python: '#', bash: '#', yaml: '#', ruby: '#', powershell: '#', ini: '#', dockerfile: '#', makefile: '#', sql: '--',
};

export function highlightLine(line: string, language: string): Token[] {
  const lang = String(language || '').toLowerCase();
  if (!line) return [{ text: '', kind: '' }];
  if (lang === 'markdown') {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return [{ text: line, kind: 'heading' }];
    if (/^\s{0,3}(```|~~~)/.test(line)) return [{ text: line, kind: 'comment' }];
  }
  if (lang === 'diff') {
    if (line.startsWith('+')) return [{ text: line, kind: 'string' }];
    if (line.startsWith('-')) return [{ text: line, kind: 'tag' }];
    if (line.startsWith('@@')) return [{ text: line, kind: 'keyword' }];
    return [{ text: line, kind: '' }];
  }
  if (lang === 'xml') {
    const out: Token[] = [];
    const re = /(<!--.*?-->)|(<\/?[\w:-]+)|(\s[\w:-]+)(?==)|("[^"]*"|'[^']*')|(\/?>)/g;
    let last = 0;
    for (const m of line.matchAll(re)) {
      const i = m.index ?? 0;
      if (i > last) out.push({ text: line.slice(last, i), kind: '' });
      out.push({ text: m[0], kind: m[1] ? 'comment' : m[2] || m[5] ? 'tag' : m[3] ? 'attr' : 'string' });
      last = i + m[0].length;
    }
    if (last < line.length) out.push({ text: line.slice(last), kind: '' });
    return out;
  }
  const words = KEYWORDS[lang];
  const comment = LINE_COMMENT[lang];
  if (!words && !comment) return [{ text: line, kind: '' }];
  const keywordSet = new Set(words || []);
  const out: Token[] = [];
  const re = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\/\/|#|--)/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    const i = m.index ?? 0;
    if (m[4]) {
      if (comment && m[4] === comment && (comment !== '#' || i === 0 || /\s/.test(line[i - 1]))) {
        if (i > last) out.push({ text: line.slice(last, i), kind: '' });
        out.push({ text: line.slice(i), kind: 'comment' });
        return out;
      }
      continue;
    }
    if (i > last) out.push({ text: line.slice(last, i), kind: '' });
    if (m[1]) out.push({ text: m[0], kind: lang === 'json' && /^\s*:/.test(line.slice(i + m[0].length)) ? 'attr' : 'string' });
    else if (m[2]) out.push({ text: m[0], kind: 'number' });
    else out.push({ text: m[0], kind: keywordSet.has(lang === 'sql' ? m[0].toLowerCase() : m[0]) ? 'keyword' : '' });
    last = i + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), kind: '' });
  return mergeTokens(out);
}

function mergeTokens(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === t.kind) prev.text += t.text;
    else out.push({ ...t });
  }
  return out;
}

/** 文本按行分块（列表虚拟化用）。 */
export function chunkLines(text: string, size = 120): Array<{ start: number; lines: string[] }> {
  const lines = String(text || '').split('\n');
  const out: Array<{ start: number; lines: string[] }> = [];
  for (let i = 0; i < lines.length; i += size) out.push({ start: i, lines: lines.slice(i, i + size) });
  return out;
}
