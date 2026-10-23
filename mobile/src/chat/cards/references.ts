/**
 * 引用胶囊解析（纯逻辑，供单测）。Web 的 references/codec.js 顶层依赖 markdown-it，不能直接进 RN；
 * 这里按同一语法 [label](openbear://ref/<kind>/<id>[/<itemId>]?scope=&turns=&mode=) 做行内切分，
 * 规则与 codec.referenceFromUrl / referenceScopeLabel 一致（代码段内不识别）。
 */
export const KIND_LABELS: Record<string, string> = { mem: '记忆', doc: '文档', secret: '凭证', chat: '会话', turn: '本轮问答', message: '消息', rec: '推荐' };
const KINDS = Object.keys(KIND_LABELS);

export type Reference = { kind: string; id: string; itemId?: string; label: string; scope: 'full' | 'recent'; turns?: number; mode?: 'mention'; modeReason?: string };
export type TextPart = { type: 'text'; text: string } | { type: 'reference'; ref: Reference; token: string };

function parseQuery(query: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    const key = decodeURIComponent(k);
    (out[key] ||= []).push(decodeURIComponent(v.replace(/\+/g, ' ')));
  }
  return out;
}

export function referenceFromUrl(href: string, label = ''): Reference | null {
  const prefix = 'openbear://ref/';
  if (!String(href || '').startsWith(prefix)) return null;
  const rest = href.slice(prefix.length);
  const q = rest.indexOf('?');
  let parts: string[];
  try {
    parts = (q >= 0 ? rest.slice(0, q) : rest).split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  const params = parseQuery(q >= 0 ? rest.slice(q + 1) : '');
  const kind = parts[0];
  if (!KINDS.includes(kind)) return null;
  if (parts.length !== (['turn', 'message'].includes(kind) ? 3 : 2)) return null;
  const modes = params.mode || [];
  if (modes.length > 1 || (modes.length === 1 && !['content', 'mention'].includes(modes[0]))) return null;
  const scope = (params.scope?.[0] || 'full') as 'full' | 'recent';
  if (!['full', 'recent'].includes(scope)) return null;
  const id = parts[1];
  if (!id || id.length > 160) return null;
  const ref: Reference = { kind, id, label: String(label || id).slice(0, 300), scope };
  if (['turn', 'message'].includes(kind)) ref.itemId = parts[2];
  if (scope === 'recent') {
    const n = Number(params.turns?.[0] ?? 20);
    ref.turns = Math.max(1, Math.min(50, Number.isFinite(n) ? Math.trunc(n) : 20));
  }
  if (modes[0] === 'mention') {
    ref.mode = 'mention';
    if (params.reason?.[0]) ref.modeReason = params.reason[0];
  }
  return ref;
}

const PATTERN = /\[((?:\\.|[^[\]\\\n])*)\]\((openbear:\/\/ref\/[^\s)]+)\)/g;

/** 行内切分：普通文字与引用胶囊交替；代码段（`…`、``` 围栏）内不识别。 */
export function parseReferenceText(value: string): TextPart[] {
  const text = String(value || '');
  if (!text.includes('openbear://ref/')) return text ? [{ type: 'text', text }] : [];
  const code: Array<[number, number]> = [];
  for (const m of text.matchAll(/```[\s\S]*?(```|$)|`[^`\n]*`/g)) code.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
  const parts: TextPart[] = [];
  let offset = 0;
  for (const m of text.matchAll(PATTERN)) {
    const index = m.index ?? 0;
    if (inCode(index)) continue;
    const ref = referenceFromUrl(m[2], m[1].replace(/\\(.)/g, '$1'));
    if (!ref) continue;
    if (index > offset) parts.push({ type: 'text', text: text.slice(offset, index) });
    parts.push({ type: 'reference', ref, token: m[0] });
    offset = index + m[0].length;
  }
  if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) });
  return parts;
}

/** 胶囊上的范围文字（仅提及 / 全文 / 最近 N 轮）。 */
export function referenceScopeLabel(ref: Reference): string {
  if (ref.mode === 'mention') return '仅提及';
  if (ref.kind === 'chat') return ref.scope === 'recent' ? `最近${ref.turns || 20}轮` : '全文';
  return '';
}

/** 显示用纯文本（引用替换为标签；复制消息、预览用）。 */
export function referenceDisplayText(value: string): string {
  return parseReferenceText(value).map((p) => (p.type === 'reference' ? p.ref.label : p.text)).join('');
}

export function referenceErrorText(code: string): string {
  const map: Record<string, string> = {
    invalid_reference_mode: '引用模式无效，请重新选择引用内容或仅提及',
    reference_unavailable: '引用对象已删除、停用或无法访问，请检查胶囊',
    history_output_limit: '引用内容超过 History 单次输出上限，请缩小会话范围',
    reference_budget_exceeded: '引用材料超出当前模型输入预算，请缩小范围或移除部分引用',
    too_many_references: '单条消息最多引用 30 个不同对象',
    protected_storage_unavailable: '凭证保护存储不可用，请先检查服务端配置',
  };
  return map[code] || code || '引用内容暂时无法读取';
}
