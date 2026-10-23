/**
 * 上下文编辑器的状态与操作（纯逻辑，不依赖 React，node --test 可直接测）。
 *
 * 逐项对应 Web views/consoleView/ContextEditor.vue 的 <script setup>：editorState / load 合并规则 / change / mutate /
 * editMessage / setting / history / restore / saveRaw / askEntries / confirmDelete / openEntity / openBlock /
 * entityValue / entityView / saveEntity / revealBody / shiftBlock / createBranch 的前置条件。
 * 文档操作本身直接复用 Web 的 contextEditor/operations.js 与 sequence.js（不复制改写）。
 */
// @ts-ignore - JS module without types
import * as ops from '@openbear/web/views/consoleView/contextEditor/operations.js';
// @ts-ignore
import * as seq from '@openbear/web/views/consoleView/contextEditor/sequence.js';

// Web 的 operations.js 用 structuredClone 深拷贝；Hermes 没有时用 JSON 拷贝（文档都是纯 JSON）。
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Message = Record<string, any> & { role?: string; content?: any; tool_calls?: Call[]; native_output_items?: any[] };
export type Call = { id: string; name: string; arguments: string; [key: string]: any };
export type Entry = { entryId: string; message: Message };
export type Doc = { format?: string; system: string; tools: any[]; entries: Entry[]; origin?: any; [key: string]: any };
export type Issue = { entryId?: string; path?: string; severity: 'error' | 'warning' | string; text: string };
export type Change = { id: string; before: any; after: any };
export type Pair = { entryId: string; call: Call; results: string[] };
export type SeqRow = { key: string; source: string; index?: number; type: string; label: string; callId?: string; thinking?: boolean; preview: string; value: any };
export type ModelOption = { label: string; model: string; modelId?: string; protocol: string };

export type EditorState = {
  baseline: Doc;
  working: Doc;
  snapshotToken: string;
  revision: number;
  mode: 'compatible' | 'raw';
  targetModel: string;
  sourceModel: string;
  models: ModelOption[];
  epoch: number;
  savedEpoch: number;
  preview: any;
  previewEpoch: number;
  undo: Doc[];
  redo: Doc[];
  latestSource: any;
};

const opsAny: any = ops;
const seqAny: any = seq;
export const clone: <T>(value: T) => T = opsAny.clone;
export const assertDocument: (doc: any) => Doc = opsAny.assertDocument;
export const diffDocument: (a: Doc, b: Doc) => Change[] = opsAny.diffDocument;
export const localIssues: (doc: Doc) => Issue[] = opsAny.localIssues;
export const relations: (doc: Doc) => { pairs: Pair[]; issues: Issue[] } = opsAny.relations;
export const callImpact: (doc: Doc, entryId: string, callId: string) => { pair: Pair; remove: string[]; retain: string[] } = opsAny.callImpact;
export const reasoningImpact: (doc: Doc, entryId: string, suffix?: boolean) => string[] = opsAny.reasoningImpact;
export const exportPackage: (baseline: Doc, working: Doc, mode: string, targetModel: string) => any = opsAny.exportPackage;
export const importPackage: (data: any) => { baseline: Doc; working: Doc; mode: 'compatible' | 'raw'; targetModel: string } = opsAny.importPackage;
export const isClaudeNative: (items: any) => boolean = opsAny.isClaudeNative;
export const messageSequence: (message: Message) => { ordered: boolean; rows: SeqRow[] } = seqAny.messageSequence;
export const canMoveBlock: (message: Message, key: string, offset: number) => boolean = seqAny.canMoveBlock;

/** 撤销栈上限（整份文档快照；手机内存有限，Web 不限）。改动计数来自差异，不受影响。 */
export const UNDO_LIMIT = 80;

const pushCapped = (stack: Doc[], doc: Doc) => (stack.length >= UNDO_LIMIT ? [...stack.slice(stack.length - UNDO_LIMIT + 1), doc] : [...stack, doc]);

// ---------------------------------------------------------------- 载入

export function editorState(result: any, draft: any = null): EditorState {
  const baseline = clone(draft?.baseline || result.baseline);
  const working = clone(draft?.working || result.baseline);
  assertDocument(baseline);
  assertDocument(working);
  const sourceModel = result.targetModel || result.models?.[0]?.model || '';
  const snapshotToken = draft?.snapshotToken || result.snapshotToken;
  return {
    baseline, working, snapshotToken, revision: result.draft?.revision ?? draft?.revision ?? 0,
    mode: draft?.mode === 'raw' ? 'raw' : 'compatible', targetModel: draft?.targetModel || sourceModel, sourceModel,
    models: result.models || [], epoch: 0, savedEpoch: 0, preview: null, previewEpoch: -1, undo: [], redo: [],
    latestSource: snapshotToken !== result.snapshotToken ? result : null,
  };
}

export function hasDraftChanges(s: any, sourceModel = ''): boolean {
  return diffDocument(s.baseline, s.working).length > 0 || s.mode === 'raw'
    || Boolean(s.targetModel && s.targetModel !== (s.sourceModel || s.baseline.origin?.modelLabel || sourceModel || s.targetModel));
}

/**
 * 服务器返回的上下文与本机已有编辑稿（同一 App 会话内的缓存）合并，规则同 Web load()：
 *  - 本机稿与服务器快照相同、或本机稿有改动：保留本机稿；快照变了则标记 latestSource（提示“加载最新”）；
 *  - 否则用服务器草稿（快照相同或草稿确有改动时），再否则用最新快照。
 */
export function resolveLoaded(result: any, current: EditorState | null): EditorState {
  if (!result?.ok) throw Error('服务器未返回上下文');
  assertDocument(result.baseline);
  if (current && (current.snapshotToken === result.snapshotToken || hasDraftChanges(current))) {
    const changed = current.snapshotToken !== result.snapshotToken;
    return { ...current, models: result.models || [], latestSource: changed ? result : null, preview: changed ? null : current.preview, previewEpoch: changed ? -1 : current.previewEpoch };
  }
  const draft = !current && result.draft && (result.draft.snapshotToken === result.snapshotToken || hasDraftChanges(result.draft, result.targetModel)) ? result.draft : null;
  return editorState(result, draft);
}

/** “加载最新上下文”：放弃本页编辑，换成源会话最新快照（服务器草稿不动）。 */
export function useLatestSource(s: EditorState): EditorState {
  if (!s.latestSource) return s;
  return editorState(s.latestSource);
}

// ---------------------------------------------------------------- 改动与历史

export function change(s: EditorState, next: Doc): EditorState {
  assertDocument(next);
  return { ...s, working: next, undo: pushCapped(s.undo, clone(s.working)), redo: [], epoch: s.epoch + 1, preview: null, previewEpoch: -1 };
}

export function mutate(s: EditorState, fn: (doc: Doc) => void): EditorState {
  const next = clone(s.working);
  fn(next);
  return change(s, next);
}

export function editMessage(s: EditorState, id: string, fn: (m: Message) => void): EditorState {
  return mutate(s, (d) => {
    const item = d.entries.find((e) => e.entryId === id);
    if (!item) throw Error('消息已不存在');
    const original = clone(item.message);
    fn(item.message);
    item.message = opsAny.reconcileMessage(original, item.message);
  });
}

/** 目标模型 / 模式：改设置会让预览失效，但不进撤销栈。 */
export function setting(s: EditorState, key: 'mode' | 'targetModel', value: string): EditorState {
  if ((s as any)[key] === value) return s;
  return { ...s, [key]: value, epoch: s.epoch + 1, preview: null, previewEpoch: -1 };
}

export function history(s: EditorState, direction: 'undo' | 'redo'): EditorState {
  if (!s[direction].length) return s;
  const other = direction === 'undo' ? 'redo' : 'undo';
  return {
    ...s,
    [direction]: s[direction].slice(0, -1),
    [other]: pushCapped(s[other], clone(s.working)),
    working: clone(s[direction][s[direction].length - 1]),
    epoch: s.epoch + 1, preview: null, previewEpoch: -1,
  };
}

/** 差异视图：还原一项（null 表示全部还原）。 */
export function restore(s: EditorState, item: Change | null): EditorState {
  return mutate(s, (d) => {
    const b = s.baseline;
    if (!item) {
      Object.assign(d, clone(b));
      return;
    }
    const id = item.id;
    if (id === 'system' || id === 'tools') (d as any)[id] = clone((b as any)[id]);
    else if (id === 'order') {
      const order = new Map(b.entries.map((e, i) => [e.entryId, i]));
      d.entries.sort((a, c) => (order.get(a.entryId) ?? Infinity) - (order.get(c.entryId) ?? Infinity));
    } else {
      const i = d.entries.findIndex((e) => e.entryId === id);
      const original = b.entries.find((e) => e.entryId === id);
      if (i >= 0) d.entries.splice(i, 1);
      if (original) d.entries.splice(Math.min(b.entries.indexOf(original), d.entries.length), 0, clone(original));
    }
  });
}

// ---------------------------------------------------------------- 消息序列

export function addEntry(s: EditorState, role: 'user' | 'assistant' | 'tool', afterId: string, id: string): EditorState {
  return mutate(s, (d) => {
    const i = d.entries.findIndex((e) => e.entryId === afterId);
    d.entries.splice(i < 0 ? d.entries.length : i + 1, 0, { entryId: id, message: role === 'tool' ? { role, content: '', name: '', tool_call_id: '' } : { role, content: '' } });
  });
}

export function moveEntry(s: EditorState, id: string, offset: number): EditorState {
  const i = s.working.entries.findIndex((e) => e.entryId === id);
  if (i < 0 || i + offset < 0 || i + offset >= s.working.entries.length) return s;
  return mutate(s, (d) => {
    [d.entries[i], d.entries[i + offset]] = [d.entries[i + offset], d.entries[i]];
  });
}

/** 批量删除前的影响：所选消息 + 联动的工具结果；若删掉的是结果，则它对应的调用也会被删。 */
export function entriesImpact(doc: Doc, ids: string[]): string[] {
  const affected = new Set(ids);
  const impact: string[] = [];
  for (const p of relations(doc).pairs) {
    if (affected.has(p.entryId)) p.results.forEach((id) => affected.add(id));
    else if (p.results.some((id) => affected.has(id))) impact.push(`${p.entryId}.tool_calls[${p.call.id}]`);
  }
  return [...affected].map((id) => `${id}.message`).concat(impact);
}

export type Dialog =
  | { kind: 'refresh' }
  | { kind: 'entries'; ids: string[]; impact: string[] }
  | { kind: 'call'; id: string; callId: string; impact: { pair: Pair; remove: string[]; retain: string[] } }
  | { kind: 'thinking'; id: string; impact: string[] }
  | { kind: 'tool'; index: number; impact: string[] };

/** 删除工具调用的影响清单（两种模式下显示的条目不同）。 */
export function callImpactLines(dialog: Extract<Dialog, { kind: 'call' }>, deleteMode: 'paired' | 'only'): { remove: string[]; retain: string[]; orphan: string[] } {
  const { pair, remove, retain } = dialog.impact;
  const resultPaths = new Set(pair.results.map((id) => `${id}.message`));
  return {
    remove: deleteMode === 'only' ? remove.filter((p) => !resultPaths.has(p)) : remove,
    retain,
    orphan: deleteMode === 'only' ? pair.results : [],
  };
}

/** 确认对话框的动作（同 Web confirmDelete）。deleteMode=only 时自动转原始实验模式。 */
export function confirmDialog(s: EditorState, dialog: Dialog, options: { deleteMode?: 'paired' | 'only'; thinkingScope?: 'suffix' | 'one' } = {}): EditorState {
  if (dialog.kind === 'refresh') return useLatestSource(s);
  if (dialog.kind === 'call') {
    const only = options.deleteMode === 'only';
    const next = mutate(s, (d) => {
      d.entries = opsAny.deleteCall(d, dialog.id, dialog.callId, only).entries;
    });
    return only ? setting(next, 'mode', 'raw') : next;
  }
  if (dialog.kind === 'thinking') return mutate(s, (d) => { d.entries = opsAny.deleteReasoning(d, dialog.id, options.thinkingScope !== 'one').entries; });
  if (dialog.kind === 'entries') return mutate(s, (d) => { d.entries = opsAny.deleteEntries(d, dialog.ids).entries; });
  return mutate(s, (d) => { d.tools.splice(dialog.index, 1); });
}

// ---------------------------------------------------------------- 选择与展示

export type Selected = 'system' | 'tools' | string;

export function findEntry(doc: Doc | undefined, id: Selected): Entry | undefined {
  return doc?.entries.find((e) => e.entryId === id);
}

export function selectionLabel(doc: Doc, selected: Selected): string {
  if (selected === 'system') return '系统提示词';
  if (selected === 'tools') return '工具定义';
  const index = doc.entries.findIndex((e) => e.entryId === selected);
  return `${doc.entries[index]?.message.role || '消息'} · 第 ${index + 1} 条`;
}

export function rawObject(doc: Doc, selected: Selected): any {
  if (selected === 'system') return { system: doc.system };
  if (selected === 'tools') return doc.tools;
  return findEntry(doc, selected)?.message;
}

export function rawText(doc: Doc, selected: Selected): string {
  return JSON.stringify(rawObject(doc, selected) ?? {}, null, 2);
}

/** “完整 JSON”视图：应用编辑后的 JSON（无效时抛错，编辑稿不变）。 */
export function applyRaw(s: EditorState, selected: Selected, raw: string): EditorState {
  const parsed = JSON.parse(raw);
  const next = clone(s.working);
  if (selected === 'system') {
    if (typeof parsed?.system !== 'string') throw Error('system 必须是字符串');
    next.system = parsed.system;
  } else if (selected === 'tools') next.tools = parsed;
  else {
    const item = next.entries.find((e) => e.entryId === selected);
    if (!item) throw Error('消息已不存在');
    item.message = opsAny.reconcileMessage(findEntry(s.working, selected)!.message, parsed);
  }
  assertDocument(next);
  return change(s, next);
}

export function snippet(message: Message): string {
  if (message.role === 'tool') return `${message.name || '工具结果'} · ${typeof message.content === 'string' ? message.content : '内容块'}`;
  if (message.tool_calls?.length) return message.tool_calls.map((c) => c.name || '未命名调用').join(' · ');
  if (typeof message.content === 'string' && message.content) return message.content;
  if (Array.isArray(message.content)) return `${message.content.length} 个内容块`;
  return message.reasoning ? '思考内容' : '无正文';
}

export function filterEntries(doc: Doc, search: string): Entry[] {
  const q = search.trim().toLowerCase();
  if (!q) return doc.entries;
  return doc.entries.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
}

export function contentLanguage(value: string): 'json' | 'plaintext' {
  try {
    JSON.parse(value);
    return 'json';
  } catch {
    return 'plaintext';
  }
}

export const display = (v: unknown): string => (v === undefined ? '（不存在）' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export function issueTarget(doc: Doc, issue: Issue | undefined): Selected | '' {
  if (issue?.entryId && doc.entries.some((e) => e.entryId === issue.entryId)) return issue.entryId;
  if (/^system(?:\.|$)/.test(issue?.path || '')) return 'system';
  if (/^tools(?:\[|\.|$)/.test(issue?.path || '')) return 'tools';
  return '';
}

export function toolRows(doc: Doc, filter: string): { tool: any; index: number }[] {
  const q = filter.trim().toLowerCase();
  return doc.tools.map((tool, index) => ({ tool, index })).filter(({ tool }) => !q || `${tool.name} ${tool.description || ''}`.toLowerCase().includes(q));
}

export function extraFields(message: Message | undefined): string[] {
  return ['reasoning', 'signature', 'native_output_items'].filter((field) => message && Object.prototype.hasOwnProperty.call(message, field));
}

export function targetProtocol(s: EditorState): string {
  return s.models.find((m) => m.model === s.targetModel)?.protocol || '';
}

export function orderNote(s: EditorState, message: Message): string {
  const sequence = messageSequence(message);
  if (!sequence.ordered) return '此消息只保存了独立字段，未记录完整交错顺序；以下不是生成时间线。只能调整同一数组内的顺序，不能跨正文、思考、调用字段移动。';
  const protocol = targetProtocol(s);
  const kept = protocol === 'responses' || (['claude', 'anthropic'].includes(protocol) && isClaudeNative(message.native_output_items));
  return `从上到下是已保存的原生块顺序，可逐块上移或下移。${kept ? '调整会写入实际请求；' : '切换协议不保证保留此顺序；'}签名、密文是否允许续接以服务端校验为准。`;
}

// ---------------------------------------------------------------- 预览与分支

export function previewReady(s: EditorState): boolean {
  return Boolean(s.preview && s.previewEpoch === s.epoch);
}

export function serverIssues(s: EditorState): Issue[] {
  return previewReady(s) ? s.preview.issues || [] : [];
}

export function requestData(s: EditorState) {
  return { baseline: clone(s.baseline), working: clone(s.working), mode: s.mode, targetModel: s.targetModel };
}

/** 创建独立分支的前置条件（同 Web createBranch）；满足时返回空字符串。 */
export function branchBlockReason(s: EditorState, { busy, title }: { busy: boolean; title: string }): string {
  if (busy) return '会话运行中不能创建分支；草稿保留';
  if (s.latestSource) return '源会话已有新内容，请先加载最新上下文；当前编辑稿可保存或导出';
  if (s.mode !== 'compatible') return '原始实验稿只可保存或导出，不可执行';
  if (!previewReady(s)) return '编辑或目标变化后须重新运行服务器预览';
  if (s.preview.payload == null) return '服务器未生成实际请求载荷，不能创建分支';
  if (serverIssues(s).some((i) => i.severity === 'error') || localIssues(s.working).some((i) => i.severity === 'error')) return '请先处理服务端或本地结构错误';
  if (!title.trim()) return '请输入分支标题';
  return '';
}

const ERROR_TEXT: Record<string, string> = {
  busy: '会话运行中',
  draft_conflict: '服务器草稿已被其他页面更新',
  context_source_changed: '源会话已有新内容',
  raw_draft_not_executable: '原始实验稿不可执行',
  context_validation_failed: '上下文校验未通过',
  model_not_found: '目标模型不存在',
};

/** 请求失败文案（同 Web failure；409 给出“草稿仍保留”的说明）。兼容 HttpError(status, body) 与 axios 形状。 */
export function failure(e: any): string {
  const status = Number(e?.status ?? e?.response?.status ?? 0);
  const data = e?.body ?? e?.response?.data ?? {};
  const code = String(data?.message || data?.error || '');
  const text = ERROR_TEXT[code] ? `${ERROR_TEXT[code]}（${code}）` : code;
  if (status === 409) return `冲突（409）：${text || '源快照过期、会话运行中或草稿修订已变化'}。草稿仍保留；请导出并核对源会话，不会覆盖。`;
  if (status === 0 && data?.error === 'timeout') return '请求超时，请重试';
  if (status === 0 && data?.error === 'network') return '网络不可用，请重试';
  return String(text || e?.message || '请求失败');
}

/** 导入完整包（同 Web upload）：基线与编辑稿都换成包里的，撤销历史清空。 */
export function importIntoState(s: EditorState, data: any): EditorState {
  const pkg = importPackage(data);
  return { ...s, baseline: pkg.baseline, working: pkg.working, mode: pkg.mode, targetModel: pkg.targetModel || s.targetModel, epoch: s.epoch + 1, preview: null, previewEpoch: -1, undo: [], redo: [] };
}

// ---------------------------------------------------------------- 字段 / 工具 / 调用 / 内容块编辑

export type EntityDraft = {
  kind: 'tool' | 'call' | 'field';
  index: number;
  field: string;
  entryId: string;
  data: any;
  view: 'fields' | 'raw';
  raw: string;
  text: string;
  json: boolean;
  block?: Omit<SeqRow, 'value'> & { value?: undefined };
  blockTextIndex?: number;
  blockTextField?: boolean;
};

export function openEntity(doc: Doc, selected: Selected, kind: EntityDraft['kind'], index = -1, field = '', newCallId = ''): EntityDraft {
  const entry = findEntry(doc, selected);
  const value = kind === 'tool'
    ? (index < 0 ? { name: '', description: '', parameters: { type: 'object', properties: {} } } : doc.tools[index])
    : kind === 'call'
      ? (index < 0 ? { id: newCallId || `call_${Date.now().toString(36)}`, name: '', arguments: '{}' } : entry!.message.tool_calls![index])
      : entry!.message[field];
  const data = clone(value);
  return {
    kind, index, field, entryId: selected, data, view: 'fields', raw: JSON.stringify(data, null, 2),
    text: kind === 'tool' ? JSON.stringify(data.parameters ?? {}, null, 2) : kind === 'call' ? data.arguments : typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    json: kind !== 'field' || typeof data !== 'string',
  };
}

/** 点开助手消息的一个内容块（调用块 -> 调用编辑；独立字段 -> 字段编辑；原生块 -> 块编辑，单一文本块只编辑文字）。 */
export function openBlock(doc: Doc, selected: Selected, row: SeqRow): EntityDraft {
  const entry = findEntry(doc, selected)!;
  if (row.source === 'tool_calls' || (['function_call', 'tool_use'].includes(row.type) && entry.message.tool_calls?.some((c) => c.id === row.callId))) {
    return openEntity(doc, selected, 'call', entry.message.tool_calls!.findIndex((c) => c.id === row.callId));
  }
  if (row.source !== 'native_output_items') return openEntity(doc, selected, 'field', -1, row.source);
  const data = clone(row.value);
  const textIndexes: number[] = data.type === 'message' ? (data.content || []).flatMap((b: any, i: number) => (['text', 'output_text'].includes(b.type) ? [i] : [])) : [];
  const blockTextIndex = textIndexes.length === 1 ? textIndexes[0] : -1;
  const blockTextField = data.type === 'text';
  return {
    kind: 'field', index: -1, field: `内容块 ${(row.index ?? 0) + 1} · ${row.label}`, block: { ...row, value: undefined }, blockTextIndex, blockTextField,
    entryId: selected, data, view: 'fields', raw: JSON.stringify(data, null, 2),
    text: blockTextField ? data.text || '' : blockTextIndex >= 0 ? data.content[blockTextIndex].text || '' : JSON.stringify(data, null, 2),
    json: !blockTextField && blockTextIndex < 0,
  };
}

export function entityValue(draft: EntityDraft): any {
  if (draft.view === 'raw') return JSON.parse(draft.raw);
  if (draft.kind === 'field') {
    if (draft.blockTextField) return { ...clone(draft.data), text: draft.text };
    if ((draft.blockTextIndex ?? -1) >= 0) {
      const value = clone(draft.data);
      value.content[draft.blockTextIndex!].text = draft.text;
      return value;
    }
    return draft.json ? JSON.parse(draft.text) : draft.text;
  }
  const value = clone(draft.data);
  if (draft.kind === 'tool') value.parameters = JSON.parse(draft.text);
  else value.arguments = draft.text;
  return value;
}

/** 字段编辑 ⇄ 完整 JSON 切换（JSON 无效时抛错，留在原视图）。 */
export function entityView(draft: EntityDraft, view: 'fields' | 'raw'): EntityDraft {
  if (draft.view === view) return draft;
  const value = entityValue(draft);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('定义必须是 JSON 对象');
  return { ...draft, data: value, raw: JSON.stringify(value, null, 2), text: draft.kind === 'tool' ? JSON.stringify(value.parameters ?? {}, null, 2) : value.arguments, view };
}

/** 保存字段/工具/调用/内容块编辑到编辑稿（同 Web saveEntity）。 */
export function saveEntity(s: EditorState, draft: EntityDraft): EditorState {
  const value = entityValue(draft);
  if (draft.kind === 'tool') {
    if (!value || typeof value.name !== 'string' || !value.name.trim()) throw Error('请输入工具名称');
    if (!value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) throw Error('参数必须是 JSON 对象');
    return mutate(s, (d) => {
      if (draft.index < 0) d.tools.push(value);
      else d.tools[draft.index] = value;
    });
  }
  if (draft.kind === 'call') {
    if (!value || typeof value.name !== 'string' || typeof value.id !== 'string' || typeof value.arguments !== 'string') throw Error('调用需要 name、id 和字符串 arguments');
    return editMessage(s, draft.entryId, (m) => {
      if (draft.index < 0 && messageSequence(m).ordered) {
        m.native_output_items!.push(opsAny.nativeCall(value, isClaudeNative(m.native_output_items)));
        m.tool_calls ||= [];
        m.tool_calls.push(value);
      } else {
        m.tool_calls ||= [];
        if (draft.index < 0) m.tool_calls.push(value);
        else m.tool_calls[draft.index] = value;
      }
    });
  }
  if (draft.block) {
    const block = draft.block;
    return mutate(s, (d) => {
      const item = d.entries.find((e) => e.entryId === draft.entryId);
      if (!item) throw Error('消息已不存在');
      item.message = seqAny.replaceBlock(item.message, block, value);
    });
  }
  return editMessage(s, draft.entryId, (m) => {
    m[draft.field] = value;
  });
}

/**
 * “＋ 正文块 / ＋ 添加正文”（同 Web revealBody）：有原生顺序时追加一个空文本块并打开它；
 * 否则（独立字段）确保 content 存在并打开 content 字段编辑。返回新状态与要打开的编辑草稿。
 */
export function revealBody(s: EditorState, selected: Selected): { state: EditorState; draft: EntityDraft } {
  const entry = findEntry(s.working, selected);
  if (!entry) throw Error('消息已不存在');
  if (messageSequence(entry.message).ordered) {
    const state = editMessage(s, selected, (m) => {
      m.native_output_items!.push(isClaudeNative(m.native_output_items) ? { type: 'text', text: '' } : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] });
    });
    const rows = messageSequence(findEntry(state.working, selected)!.message).rows;
    return { state, draft: openBlock(state.working, selected, rows[rows.length - 1]) };
  }
  const state = entry.message.content == null ? editMessage(s, selected, (m) => { m.content = ''; }) : s;
  return { state, draft: openEntity(state.working, selected, 'field', -1, 'content') };
}

export function shiftBlock(s: EditorState, selected: Selected, rowKey: string, offset: number): EditorState {
  return mutate(s, (d) => {
    const e = d.entries.find((x) => x.entryId === selected);
    if (!e) throw Error('消息已不存在');
    e.message = seqAny.moveBlock(e.message, rowKey, offset);
  });
}

/** “离开编辑区即应用”的文本提交（系统提示词 / 消息正文）；没有变化时原样返回。 */
export function commitText(s: EditorState, id: Selected, field: string, value: string): EditorState {
  if (id === 'system') return s.working.system === value ? s : mutate(s, (d) => { d.system = value; });
  const entry = findEntry(s.working, id);
  if (!entry || entry.message[field] === value) return s;
  return editMessage(s, id, (m) => { m[field] = value; });
}

/** 消息元信息（角色 / 工具名 / 对应调用 ID）。 */
export function setField(s: EditorState, selected: Selected, key: string, value: any): EditorState {
  if (selected === 'system') return mutate(s, (d) => { d.system = value; });
  return editMessage(s, selected, (m) => { m[key] = value; });
}

export function pairsFor(doc: Doc, selected: Selected): Pair[] {
  return relations(doc).pairs.filter((p) => p.entryId === selected || p.results.includes(selected));
}

/** 本地生成的消息/调用 ID（不要求密码学随机，只需在文档内唯一）。 */
export function localId(): string {
  const c: any = (globalThis as any).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
