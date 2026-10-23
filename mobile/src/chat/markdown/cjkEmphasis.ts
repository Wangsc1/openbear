/**
 * 中文强调预处理（“移动定界符”方案）。
 *
 * 问题：md4c 按 CommonMark 判定定界符，`**说明。**接着` 的结束 `**` 内侧是标点、外侧是字母，
 * 不是 right-flanking，无法闭合；Web 端用 markdown-it-cjk-friendly 放宽了这条规则，能正确加粗。
 *
 * 做法：先按 Web（markdown-it + cjk-friendly）的规则找出会被配对的强调定界符，再对其中
 * md4c 不能识别的一端，把定界符挪过相邻的那串标点：
 *   - 闭合：`**说明。**接着` → `**说明**。接着`
 *   - 开启：`前文**“引号”**后文` → `前文“**引号”**后文`（开引号/括号移到强调外）
 * 不改写的情况：强调内容全是标点；挪动后会与相邻的 `*`/`~` 连在一起；挪动后 md4c 仍无法识别。
 * 代价：边界上的一个（串）全角标点不加粗，视觉差异可以接受。
 *
 * 流式安全：只改写“已经成对”的定界符；未闭合的 `**` 原样保留，不会被提前改写。
 * 作用范围：逐行处理（GFM 表格行再按 `|` 分单元格）；行内代码、$…$ 公式、链接地址、
 * 自动链接、反斜杠转义内的字符不参与判定。代码围栏由调用方（outsideCode）排除。
 */

// ---- 字符分类（对齐 markdown-it utils / md4c / markdown-it-cjk-friendly） ----

/** markdown-it isWhiteSpace（md4c 的 Unicode 空白与之基本一致） */
function isWhiteSpace(code: number): boolean {
  if (code >= 0x2000 && code <= 0x200a) return true;
  switch (code) {
    case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d: case 0x20:
    case 0xa0: case 0x1680: case 0x202f: case 0x205f: case 0x3000:
      return true;
    default:
      return false;
  }
}

const PUNCT_RE = /^[\p{P}\p{S}]/u;
/** markdown-it isMdAsciiPunct || isPunctChar（Unicode P 与 S 类） */
function isPunct(code: number): boolean {
  return PUNCT_RE.test(String.fromCodePoint(code));
}

const EMOJI_RE = /^\p{Emoji_Presentation}/u;
/**
 * cjk-friendly 的 isCjkBase 近似：East Asian Width 为 F/H/W（排除 emoji）或谚文。
 * 这里不引入 get-east-asian-width 数据表，用 CJK 相关区块近似；单测以真实 cjk-friendly 为基准检查差异。
 */
function isCjk(code: number): boolean {
  if (code < 0x1100) return false;
  if (EMOJI_RE.test(String.fromCodePoint(code))) return false;
  return (
    (code >= 0x1100 && code <= 0x115f) || // 谚文字母
    (code >= 0x2e80 && code <= 0x303e) || // CJK 部首、康熙部首、CJK 符号和标点
    (code >= 0x3041 && code <= 0x33ff) || // 假名、注音、谚文兼容字母、CJK 兼容
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xfe10 && code <= 0xfe19) || // 竖排标点
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式、小写变体
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII、全角标点
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd) // 扩展 B 及以后
  );
}

// ---- 受保护区间（不参与定界符判定） ----

type Range = [number, number];

function protectedRanges(line: string): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      ranges.push([i, i + 2]);
      i += 2;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (line[i + n] === '`') n += 1;
      const fence = '`'.repeat(n);
      let j = line.indexOf(fence, i + n);
      while (j >= 0 && line[j + n] === '`') j = line.indexOf(fence, j + n + 1);
      if (j >= 0) {
        ranges.push([i, j + n]);
        i = j + n;
        continue;
      }
      i += n;
      continue;
    }
    if (ch === '$') {
      const dbl = line[i + 1] === '$';
      const fence = dbl ? '$$' : '$';
      const body = i + fence.length;
      const j = line.indexOf(fence, body);
      // 与 texmath 的 dollars 规则近似：内容非空、开头不是空白、单 $ 结束后不紧跟数字
      if (j > body && !/\s/.test(line[body]) && (dbl || !/\d/.test(line[j + 1] || ''))) {
        ranges.push([i, j + fence.length]);
        i = j + fence.length;
        continue;
      }
      i += fence.length;
      continue;
    }
    if (ch === ']' && line[i + 1] === '(') {
      const j = line.indexOf(')', i + 2);
      if (j > 0) {
        ranges.push([i + 1, j + 1]);
        i = j + 1;
        continue;
      }
    }
    if (ch === '<') {
      const m = /^<[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>/.exec(line.slice(i));
      if (m) {
        ranges.push([i, i + m[0].length]);
        i += m[0].length;
        continue;
      }
    }
    if (ch === 'h' || ch === 'w') {
      const m = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<?!.,:*_~'")\]]/.exec(line.slice(i));
      if (m && (i === 0 || !/[A-Za-z0-9]/.test(line[i - 1]))) {
        ranges.push([i, i + m[0].length]);
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return ranges;
}

// ---- 定界符扫描与配对（Web 规则） ----

type Delim = {
  start: number; // 定界符起点
  len: number; // 长度（* 为 1 或 2，~ 为 2）
  marker: string;
  canOpen: boolean;
  canClose: boolean;
};

function codeBefore(s: string, pos: number): number {
  if (pos <= 0) return 0x20;
  const c = s.charCodeAt(pos - 1);
  if (c >= 0xdc00 && c <= 0xdfff && pos >= 2) return s.codePointAt(pos - 2) ?? c;
  return c;
}
function codeAt(s: string, pos: number): number {
  return pos < s.length ? (s.codePointAt(pos) ?? 0x20) : 0x20;
}
function charLenBefore(s: string, pos: number): number {
  const c = s.charCodeAt(pos - 1);
  return c >= 0xdc00 && c <= 0xdfff && pos >= 2 ? 2 : 1;
}
function charLenAt(s: string, pos: number): number {
  const c = s.codePointAt(pos) ?? 0;
  return c > 0xffff ? 2 : 1;
}

/** markdown-it-cjk-friendly 的 scanDelims（canSplitWord 对 * 与 ~ 为 true；_ 不改写，见单测说明） */
function flank(s: string, start: number, end: number): { canOpen: boolean; canClose: boolean } {
  const last = codeBefore(s, start);
  const next = codeAt(s, end);
  const lastWs = isWhiteSpace(last);
  const nextWs = isWhiteSpace(next);
  if (lastWs || nextWs) return { canOpen: !nextWs, canClose: !lastWs };
  const lastP = isPunct(last);
  const nextP = isPunct(next);
  const eitherCjk = isCjk(next) || isCjk(last);
  return { canOpen: lastP || eitherCjk || !nextP, canClose: nextP || eitherCjk || !lastP };
}

/** md4c（CommonMark）的判定：只有标准左右侧规则 */
function md4cFlank(s: string, start: number, end: number): { canOpen: boolean; canClose: boolean } {
  const last = codeBefore(s, start);
  const next = codeAt(s, end);
  const lastWs = isWhiteSpace(last);
  const nextWs = isWhiteSpace(next);
  const lastP = isPunct(last);
  const nextP = isPunct(next);
  const left = !nextWs && (!nextP || lastWs || lastP);
  const right = !lastWs && (!lastP || nextWs || nextP);
  return { canOpen: left, canClose: right };
}

function scanDelims(s: string, ranges: Range[]): Delim[] {
  const delims: Delim[] = [];
  let r = 0;
  let i = 0;
  while (i < s.length) {
    while (r < ranges.length && ranges[r][1] <= i) r += 1;
    if (r < ranges.length && ranges[r][0] <= i) {
      i = ranges[r][1];
      continue;
    }
    const ch = s[i];
    if (ch !== '*' && ch !== '~') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] === ch) j += 1;
    const len = j - i;
    // 只处理 ** / * / ~~（*** 等组合强调不改写，保持原样）
    if ((ch === '*' && (len === 1 || len === 2)) || (ch === '~' && len === 2)) {
      const f = flank(s, i, j);
      if (f.canOpen || f.canClose) delims.push({ start: i, len, marker: ch, ...f });
    }
    i = j;
  }
  return delims;
}

type Pair = { open: Delim; close: Delim };

/** 简化的 balance_pairs：闭合匹配最近的同类同长度开启；未配对的定界符不处理（流式安全） */
function pairDelims(delims: Delim[]): Pair[] {
  const stack: Delim[] = [];
  const pairs: Pair[] = [];
  for (const d of delims) {
    if (d.canClose) {
      let k = stack.length - 1;
      while (k >= 0 && !(stack[k].marker === d.marker && stack[k].len === d.len)) k -= 1;
      if (k >= 0) {
        pairs.push({ open: stack[k], close: d });
        stack.length = k; // 中间未配对的开启作废（与 markdown-it 相同）
        continue;
      }
    }
    if (d.canOpen) stack.push(d);
  }
  return pairs;
}

// ---- 改写 ----

type Edit = { from: number; len: number; to: number; text: string };

function rewriteUnit(s: string): string {
  if (!/[*~]/.test(s)) return s;
  const ranges = protectedRanges(s);
  const pairs = pairDelims(scanDelims(s, ranges));
  if (!pairs.length) return s;
  // 挪动不能跨过受保护区间（链接地址、代码、公式）或链接方括号
  const blocked = (pos: number) => s[pos] === '[' || s[pos] === ']' || ranges.some(([a, b]) => pos >= a && pos < b);
  const edits: Edit[] = [];
  for (const { open, close } of pairs) {
    const contentStart = open.start + open.len;
    const contentEnd = close.start;
    if (contentEnd <= contentStart) continue;
    const okOpen = md4cFlank(s, open.start, contentStart).canOpen;
    const okClose = md4cFlank(s, close.start, close.start + close.len).canClose;
    if (okOpen && okClose) continue;
    let newOpen = contentStart; // 新的内容起点（开启定界符插入位置）
    let newClose = contentEnd; // 新的内容终点（闭合定界符插入位置）
    if (!okClose) {
      // 闭合：前一个是标点、后一个是字母数字 → 挪到这串标点前面
      while (newClose > contentStart && isPunct(codeBefore(s, newClose)) && s[newClose - 1] !== '*' && s[newClose - 1] !== '~' && !blocked(newClose - 1)) {
        newClose -= charLenBefore(s, newClose);
      }
    }
    if (!okOpen) {
      // 开启：后一个是开引号/开括号等标点、前一个是字母 → 挪到这串标点后面
      while (newOpen < newClose && isPunct(codeAt(s, newOpen)) && s[newOpen] !== '*' && s[newOpen] !== '~' && !blocked(newOpen)) {
        newOpen += charLenAt(s, newOpen);
      }
    }
    if (newClose <= newOpen) continue; // 内容全是标点：不改写
    const marker = s.slice(open.start, contentStart);
    // 挪动后不能与相邻的 * / ~ 连在一起，且 md4c 必须能识别
    const candidate =
      s.slice(0, open.start) + s.slice(contentStart, newOpen) + marker + s.slice(newOpen, newClose) + marker + s.slice(newClose, contentEnd) + s.slice(close.start + close.len);
    const o = open.start + (newOpen - contentStart);
    const c = o + marker.length + (newClose - newOpen);
    const nearMarker = (pos: number) => /[*~]/.test(candidate[pos - 1] || '') || /[*~]/.test(candidate[pos + marker.length] || '');
    if (nearMarker(o) || nearMarker(c)) continue;
    if (!md4cFlank(candidate, o, o + marker.length).canOpen || !md4cFlank(candidate, c, c + marker.length).canClose) continue;
    edits.push({ from: open.start, len: open.len, to: newOpen, text: marker });
    edits.push({ from: close.start, len: close.len, to: newClose, text: marker });
  }
  if (!edits.length) return s;
  // 统一应用：先删除所有被挪动的定界符，再在新位置插入（位置都以原文坐标表示）
  const removed = new Set<number>();
  for (const e of edits) for (let k = 0; k < e.len; k += 1) removed.add(e.from + k);
  const inserts = new Map<number, string[]>();
  for (const e of edits) inserts.set(e.to, [...(inserts.get(e.to) || []), e.text]);
  let out = '';
  for (let k = 0; k <= s.length; k += 1) {
    const ins = inserts.get(k);
    if (ins) out += ins.join('');
    if (k < s.length && !removed.has(k)) out += s[k];
  }
  return out;
}

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

/** 对一段（不含代码围栏的）Markdown 文本做 CJK 强调定界符改写。 */
export function fixCjkEmphasis(text: string): string {
  if (!text || !/[*~]/.test(text)) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!/[*~]/.test(line)) return line;
      if (TABLE_ROW_RE.test(line)) return line.split(/(?<!\\)\|/).map(rewriteUnit).join('|');
      return rewriteUnit(line);
    })
    .join('\n');
}
