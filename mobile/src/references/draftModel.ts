/**
 * 输入框里的引用胶囊：受控文本模型（纯逻辑，node --test 可测）。
 *
 * 方案（B3-01/B3-12～22）：React Native 的 TextInput 不能内嵌组件，这里把草稿建模为片段数组
 *   [{type:'text'} | {type:'ref'}]，在 TextInput 里渲染成带底色的“@名称”（嵌套 Text 着色），
 * 编辑时用前后缀 diff 把系统输入框的新文本映射回片段：
 *   - 触及胶囊任何一个字符的删除/替换 => 整个胶囊删除（原子性，与 Web 的 ProseMirror atom 一致）；
 *   - 在胶囊中间插入的文字放到胶囊之后。
 * 发送编码与 Web 完全一致：胶囊 -> codec.referenceToken()（`[名称](openbear://ref/...)`），文字原样，换行原样
 * （= Web documentToText）。草稿保存的也是这份编码文本，恢复时 parseDraftText() 反解析。
 * @ 触发：把胶囊位置替换成 \uFFFC 后交给 Web 的 mention.mentionAtPosition（代码块、行内代码、引号里不触发）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore - JS module without types
import * as codec from '@openbear/web/references/codec.js';
// @ts-ignore
import * as mention from '@openbear/web/references/mention.js';
// @ts-ignore
import * as sizePolicy from '@openbear/web/references/sizePolicy.js';

export type Ref = {
  kind: string;
  id: string;
  label: string;
  scope?: string;
  turns?: number;
  itemId?: string;
  mode?: string;
  modeReason?: string;
  bodyChars?: number;
  contentLimit?: number;
};
export type Segment = { type: 'text'; text: string } | { type: 'ref'; ref: Ref; uid: string };
export type Mention = { from: number; to: number; query: string; kind: string };

export const KIND_LABELS: Record<string, string> = codec.KIND_LABELS;
export const normalizeReference: (input: any) => Ref | null = codec.normalizeReference;
export const referenceKey: (ref: Ref) => string = codec.referenceKey;
export const referenceToken: (ref: Ref) => string = codec.referenceToken;
export const boundReference: (ref: Ref, binding: any) => Ref = codec.boundReference;
export const referenceErrorText: (error: any) => string = codec.referenceErrorText;
export const policyReasonText: (reason: string | undefined) => string = sizePolicy.policyReasonText;
export const policyReasonTitle: (ref: Ref) => string = sizePolicy.policyReasonTitle;
export const applyConversationPolicy: (items: any[], existing?: any[], options?: any) => Ref[] = sizePolicy.applyConversationPolicy;

let uidSeq = 0;
const nextUid = () => `r${Date.now().toString(36)}${(uidSeq += 1)}`;

/** 胶囊在输入框里显示的文字（换行压成空格，避免撑高） */
export function refDisplay(ref: Ref): string {
  return `@${String(ref.label || ref.id).replace(/\s+/g, ' ')}`;
}

export function segmentDisplay(seg: Segment): string {
  return seg.type === 'ref' ? refDisplay(seg.ref) : seg.text;
}

export function displayText(segments: Segment[]): string {
  return segments.map(segmentDisplay).join('');
}

/** 发送/保存用的编码（与 Web documentToText 一致）。 */
export function serialize(segments: Segment[]): string {
  return segments.map((seg) => (seg.type === 'ref' ? referenceToken(seg.ref) : seg.text)).join('');
}

function merge(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      if (!seg.text) continue;
      const last = out[out.length - 1];
      if (last && last.type === 'text') out[out.length - 1] = { type: 'text', text: last.text + seg.text };
      else out.push(seg);
    } else out.push(seg);
  }
  return out;
}

// ---- 反解析（codec.parseReferenceText 的 App 版本：RN 的 URL 不解析自定义协议，这里按 codec.referenceFromUrl 的规则手工解析） ----
const referencePattern = /\[((?:\\.|[^[\]\\\n])*)\]\((openbear:\/\/ref\/[^\s)]+)\)/g;

export function referenceFromUrl(href: string, label = ''): Ref | null {
  const m = /^openbear:\/\/ref\/([^?#]*)(?:\?([^#]*))?(?:#.*)?$/.exec(href);
  if (!m) return null;
  let parts: string[];
  try {
    parts = m[1].split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.length !== (['turn', 'message'].includes(parts[0]) ? 3 : 2)) return null;
  const params = new Map<string, string[]>();
  for (const pair of (m[2] || '').split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const key = decodeURIComponent((at < 0 ? pair : pair.slice(0, at)).replace(/\+/g, ' '));
    const value = at < 0 ? '' : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
    params.set(key, [...(params.get(key) || []), value]);
  }
  const get = (k: string) => (params.get(k) || [null])[0];
  const modes = params.get('mode') || [];
  if (modes.length > 1 || (modes.length === 1 && !['content', 'mention'].includes(modes[0]))) return null;
  const scope = get('scope') || 'full';
  const turns = get('turns');
  if (!['full', 'recent'].includes(scope) || (turns !== null && !/^[+-]?\d+$/.test(turns))) return null;
  return normalizeReference({ kind: parts[0], id: parts[1], itemId: parts[2], label, scope, turns, mode: get('mode'), modeReason: get('reason') });
}

export function parseDraftText(value: string): Segment[] {
  const text = String(value || '');
  if (!text.includes('openbear://ref/')) return text ? [{ type: 'text', text }] : [];
  const out: Segment[] = [];
  let offset = 0;
  for (const match of text.matchAll(referencePattern)) {
    const ref = referenceFromUrl(match[2], match[1].replace(/\\(.)/g, '$1'));
    if (!ref) continue;
    const at = match.index ?? 0;
    if (at > offset) out.push({ type: 'text', text: text.slice(offset, at) });
    out.push({ type: 'ref', ref, uid: nextUid() });
    offset = at + match[0].length;
  }
  if (offset < text.length) out.push({ type: 'text', text: text.slice(offset) });
  return merge(out);
}

// ---- 编辑 ----

/** 把输入框的新显示文本映射回片段。返回新片段、需要强制设置的光标（undefined 表示保持系统光标）。 */
export function applyDisplayChange(segments: Segment[], next: string): { segments: Segment[]; cursor?: number } {
  const prev = displayText(segments);
  if (prev === next) return { segments };
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start += 1;
  let suffix = 0;
  while (suffix < max - start && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  let removeStart = start;
  let removeEnd = prev.length - suffix;
  let inserted = next.slice(start, next.length - suffix);
  // 扩展到整个被触及的胶囊；纯插入落在胶囊内部时，挪到胶囊之后
  let pos = 0;
  let touched = false;
  for (const seg of segments) {
    const len = segmentDisplay(seg).length;
    if (seg.type === 'ref') {
      const s = pos;
      const e = pos + len;
      if (removeEnd > removeStart && s < removeEnd && removeStart < e) {
        removeStart = Math.min(removeStart, s);
        removeEnd = Math.max(removeEnd, e);
        touched = true;
      } else if (removeEnd === removeStart && s < removeStart && removeStart < e) {
        removeStart = removeEnd = e;
        touched = true;
      }
    }
    pos += len;
  }
  if (touched) {
    // 删除范围变大了：被扩展吞掉的旧文字不应再算作插入内容；重新从 prev 计算
    inserted = next.slice(start, next.length - suffix);
  }
  const result = spliceSegments(segments, removeStart, removeEnd, inserted ? [{ type: 'text', text: inserted }] : []);
  return { segments: result, cursor: touched ? removeStart + inserted.length : undefined };
}

/** 在显示坐标 [from, to) 替换为给定片段（被范围触及的胶囊整体移除）。 */
export function spliceSegments(segments: Segment[], from: number, to: number, insert: Segment[]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  let placed = false;
  const place = () => {
    if (!placed) {
      out.push(...insert);
      placed = true;
    }
  };
  for (const seg of segments) {
    const text = segmentDisplay(seg);
    const s = pos;
    const e = pos + text.length;
    pos = e;
    if (seg.type === 'ref') {
      if (e <= from) out.push(seg);
      else if (s >= to && !(s === from && to === from)) {
        place();
        out.push(seg);
      } else if (s === from && to === from) {
        place();
        out.push(seg);
      } else place(); // 触及：整体删除
      continue;
    }
    if (e <= from) {
      out.push(seg);
      continue;
    }
    if (s >= to) {
      place();
      out.push(seg);
      continue;
    }
    if (from > s) out.push({ type: 'text', text: seg.text.slice(0, from - s) });
    place();
    if (to < e) out.push({ type: 'text', text: seg.text.slice(to - s) });
  }
  place();
  return merge(out);
}

/** 插入引用（每个后面跟一个空格，与 Web insertReference 相同），返回新片段与插入后的光标。 */
export function insertRefs(segments: Segment[], from: number, to: number, refs: Ref[]): { segments: Segment[]; cursor: number } {
  const insert: Segment[] = [];
  let length = 0;
  for (const ref of refs) {
    insert.push({ type: 'ref', ref, uid: nextUid() }, { type: 'text', text: ' ' });
    length += refDisplay(ref).length + 1;
  }
  return { segments: spliceSegments(segments, from, to, insert), cursor: from + length };
}

export function replaceRef(segments: Segment[], uid: string, ref: Ref): Segment[] {
  return segments.map((seg) => (seg.type === 'ref' && seg.uid === uid ? { ...seg, ref } : seg));
}

export function removeRef(segments: Segment[], uid: string): Segment[] {
  return merge(segments.filter((seg) => !(seg.type === 'ref' && seg.uid === uid)));
}

export function refSegments(segments: Segment[]): { ref: Ref; uid: string }[] {
  return segments.filter((s): s is Extract<Segment, { type: 'ref' }> => s.type === 'ref').map((s) => ({ ref: s.ref, uid: s.uid }));
}

/** 去重后的引用（Web referencesInText） */
export function uniqueRefs(segments: Segment[]): Ref[] {
  const map = new Map<string, Ref>();
  for (const { ref } of refSegments(segments)) map.set(referenceKey(ref), ref);
  return [...map.values()];
}

/** 发送时的 referenceOrder（Web editorPolicy.referenceOrder：保留已有顺序，新出现的追加在后） */
export function referenceOrder(previous: string[], segments: Segment[]): string[] {
  const keys = [...new Set(refSegments(segments).map(({ ref }) => referenceKey(ref)))];
  return [...previous.filter((key) => keys.includes(key)), ...keys.filter((key) => !previous.includes(key))];
}

/** 光标处的 @ 提及（显示坐标） */
export function mentionAt(segments: Segment[], cursor: number): Mention | null {
  const masked = segments.map((seg) => (seg.type === 'ref' ? '\uFFFC'.repeat(refDisplay(seg.ref).length) : seg.text)).join('');
  const before = masked.slice(0, Math.max(0, Math.min(cursor, masked.length)));
  return mention.mentionAtPosition({ doc: { textBetween: () => before }, pos: before.length });
}

/** 预览接口的绑定结果写回胶囊（Web applyPreviewBindings） */
export function applyBindings(segments: Segment[], bindings: any[]): Segment[] {
  if (!Array.isArray(bindings) || !bindings.length) return segments;
  let changed = false;
  const out = segments.map((seg) => {
    if (seg.type !== 'ref') return seg;
    const binding = bindings.find((item) => (item?.requestedKey || item?.key) === referenceKey(seg.ref));
    if (!binding) return seg;
    const value = boundReference(seg.ref, binding);
    if (!value || referenceToken(value) === referenceToken(seg.ref)) return seg;
    changed = true;
    return { ...seg, ref: value };
  });
  return changed ? out : segments;
}

/** 新增引用按服务端上限降级（Web SizePolicy 插件：已有引用先占额度） */
export function enforcePolicy(newRefs: Ref[], existing: Ref[], options: any): Ref[] {
  return applyConversationPolicy(newRefs, existing, options).filter(Boolean);
}

/** b2 等外部插入的 {kind:'turn'|'message', conversationUuid, turnUuid?, opId?, title?} -> 引用 */
export function refFromExternal(input: { kind: 'turn' | 'message'; conversationUuid: string; turnUuid?: string; opId?: string; title?: string }): Ref | null {
  const itemId = input.kind === 'turn' ? input.turnUuid || '' : input.opId || '';
  return normalizeReference({ kind: input.kind, id: input.conversationUuid, itemId, label: input.title || (input.kind === 'turn' ? '本轮问答' : '消息') });
}

export function refTitle(ref: Ref): string {
  const scope = ref.mode === 'mention' ? '仅提及' : ref.kind === 'chat' ? (ref.scope === 'recent' ? `最近${ref.turns || 20}轮` : '全文') : '';
  return [KIND_LABELS[ref.kind] || '引用', scope].filter(Boolean).join(' · ');
}
