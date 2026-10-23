/**
 * 把一条 Markdown 正文按“顶层块”切分，用于超长回复分行虚拟化（设计 5.2-2）。
 *
 * 只做行级扫描，不做完整解析：识别围栏代码块（``` / ~~~）、$$ 数学块、\[ \] 数学块、
 * 表格、引用、列表、标题、分隔线与普通段落；块之间以空行或块类型变化为界。
 * 保证：拼接 blocks.join('') === 原文（无损），代码/数学围栏不会被切开；
 * 未闭合的围栏（流式中）延伸到文末。
 *
 * 小块合并：相邻小块合并到 targetChars 左右，避免一条普通回复被切成几十个单元格。
 */
export type MarkdownBlockKind = 'code' | 'math' | 'table' | 'quote' | 'list' | 'heading' | 'rule' | 'paragraph' | 'blank';

export type MarkdownBlock = { kind: MarkdownBlockKind; text: string };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const MATH_OPEN_RE = /^ {0,3}(\$\$|\\\[)\s*$/;
const MATH_INLINE_BLOCK_RE = /^ {0,3}\$\$.*\$\$\s*$/;
const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/;
const RULE_RE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^ {0,3}([-+*]|\d{1,9}[.)])(\s|$)/;
const TABLE_RE = /^\s*\|.*\|\s*$/;
const INDENTED_RE = /^( {2,}|\t)\S/;

function lineKind(line: string): MarkdownBlockKind {
  if (!line.trim()) return 'blank';
  if (HEADING_RE.test(line)) return 'heading';
  if (RULE_RE.test(line)) return 'rule';
  if (QUOTE_RE.test(line)) return 'quote';
  if (LIST_RE.test(line)) return 'list';
  if (TABLE_RE.test(line)) return 'table';
  return 'paragraph';
}

/** 拆成无损的原始顶层块（含尾随空行），不做合并。 */
export function splitTopLevelBlocks(source: string): MarkdownBlock[] {
  const text = String(source || '');
  if (!text) return [];
  // 保留换行符，保证无损拼接
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const blocks: MarkdownBlock[] = [];
  let current: MarkdownBlock | null = null;
  const push = () => {
    if (current && current.text) blocks.push(current);
    current = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const bare = line.replace(/\n$/, '');
    const fence = FENCE_RE.exec(bare);
    if (fence) {
      push();
      const marker = fence[1];
      let body = line;
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        body += next;
        i += 1;
        const close = next.replace(/\n$/, '').trim();
        if (close.startsWith(marker[0].repeat(marker.length)) && /^(`{3,}|~{3,})$/.test(close)) break;
      }
      blocks.push({ kind: 'code', text: body });
      continue;
    }
    if (MATH_OPEN_RE.test(bare) && !MATH_INLINE_BLOCK_RE.test(bare)) {
      push();
      const closer = bare.trim() === '$$' ? '$$' : '\\]';
      let body = line;
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        body += next;
        i += 1;
        if (next.trim() === closer) break;
      }
      blocks.push({ kind: 'math', text: body });
      continue;
    }
    const kind = lineKind(bare);
    if (kind === 'blank') {
      // 空行归入当前块尾部（无损），作为块边界
      if (current) {
        (current as MarkdownBlock).text += line;
        push();
      } else if (blocks.length) {
        blocks[blocks.length - 1].text += line;
      } else {
        current = { kind: 'blank', text: line };
      }
      i += 1;
      continue;
    }
    const cur = current as MarkdownBlock | null;
    const continues =
      cur &&
      (cur.kind === kind ||
        // 列表项的缩进续行/段落续行仍属于该列表
        (cur.kind === 'list' && (INDENTED_RE.test(bare) || kind === 'paragraph')) ||
        // 引用中的懒续行
        (cur.kind === 'quote' && kind === 'paragraph'));
    if (!continues || kind === 'heading' || kind === 'rule') {
      push();
      current = { kind, text: line };
      if (kind === 'heading' || kind === 'rule') push();
    } else {
      cur!.text += line;
    }
    i += 1;
  }
  push();
  return blocks;
}

/**
 * 切分并合并小块：只有当正文超过 minSplitChars 时才切分；
 * 相邻块合并到 targetChars 左右；代码/数学/表格这类独立块始终单独成行（便于原生组件回收）。
 */
export function splitMarkdownForRows(source: string, options: { minSplitChars?: number; targetChars?: number } = {}): MarkdownBlock[] {
  const text = String(source || '');
  const minSplitChars = options.minSplitChars ?? 1200;
  const targetChars = options.targetChars ?? 900;
  if (text.length <= minSplitChars) return text ? [{ kind: 'paragraph', text }] : [];
  const raw = splitTopLevelBlocks(text);
  const standalone = (kind: MarkdownBlockKind) => kind === 'code' || kind === 'math' || kind === 'table';
  const out: MarkdownBlock[] = [];
  for (const block of raw) {
    const last = out[out.length - 1];
    if (
      last &&
      !standalone(block.kind) &&
      !standalone(last.kind) &&
      last.text.length + block.text.length <= targetChars &&
      // 标题后紧跟的内容并入同一行，避免标题孤行
      true
    ) {
      last.text += block.text;
      last.kind = last.kind === block.kind ? last.kind : 'paragraph';
    } else if (last && block.kind === 'blank') {
      last.text += block.text;
    } else {
      out.push({ ...block });
    }
  }
  // 标题孤立在块末尾时，把它挪到下一块开头
  for (let index = 0; index < out.length - 1; index += 1) {
    const match = /(^|\n)( {0,3}#{1,6} [^\n]*\n\s*)$/.exec(out[index].text);
    if (match && match.index + match[1].length > 0) {
      const heading = match[2];
      out[index].text = out[index].text.slice(0, out[index].text.length - heading.length);
      out[index + 1].text = heading + out[index + 1].text;
    }
  }
  return out.filter((block) => block.text.length > 0);
}
