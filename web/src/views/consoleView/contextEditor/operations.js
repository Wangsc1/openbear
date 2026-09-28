// Pure context-document operations. The server preview, not this module, decides whether a branch can run.
export const clone = (value) => structuredClone(value);
export const THINKING_TYPES = new Set(['reasoning', 'thinking', 'redacted_thinking']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function assertDocument(doc) {
  if (!doc || typeof doc !== 'object' || typeof doc.system !== 'string' || !Array.isArray(doc.tools) || !Array.isArray(doc.entries)) throw Error('文档需要 system、tools 和 entries');
  const ids = new Set();
  for (const e of doc.entries) {
    if (!e || typeof e.entryId !== 'string' || !e.entryId || ids.has(e.entryId) || !e.message || typeof e.message !== 'object' || Array.isArray(e.message)) throw Error('条目需要唯一 entryId 和 message 对象');
    ids.add(e.entryId);
    const m = e.message;
    if (m.content != null && typeof m.content !== 'string' && !Array.isArray(m.content)) throw Error('content 必须是字符串或内容块数组');
    if (m.tool_calls != null && (!Array.isArray(m.tool_calls) || m.tool_calls.some(c => !c || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.arguments !== 'string'))) throw Error('tool_calls 需要 id、name、arguments');
    if (m.native_output_items != null && (!Array.isArray(m.native_output_items) || m.native_output_items.some(n => !n || typeof n.type !== 'string'))) throw Error('native_output_items 必须是原生块数组');
  }
  if (doc.tools.some(t => !t || typeof t.name !== 'string')) throw Error('工具定义需要 name');
  return doc;
}
export function normalizeDocument(doc) {
  assertDocument(doc);
  if (!['openbear-context-edit/1', 'openbear-context-edit-proof/1'].includes(doc.format)) throw Error('不支持的文档格式');
  return {...clone(doc), format: 'openbear-context-edit/1'};
}
export function importPackage(data) {
  if (data?.format !== 'openbear-context-edit-package/1' || !data.baseline || !data.working) throw Error('请选择包含 baseline 和 working 的完整上下文包');
  return {baseline: normalizeDocument(data.baseline), working: normalizeDocument(data.working), mode: data.editor?.mode === 'raw' ? 'raw' : 'compatible', targetModel: String(data.editor?.targetModel || '')};
}
export function exportPackage(baseline, working, mode, targetModel) {
  return {format: 'openbear-context-edit-package/1', baseline: clone(baseline), working: clone(working), editor: {mode, targetModel}};
}
export function nativeVisible(items = []) {
  const calls = [], parts = [];
  for (const n of items) {
    if (n.type === 'message') for (const b of n.content || []) if (['text', 'output_text'].includes(b.type)) parts.push(b.text || '');
    if (n.type === 'function_call') calls.push({id: n.call_id || n.id, name: n.name, arguments: n.arguments || '{}'});
  }
  return {content: parts.join(''), tool_calls: calls};
}
export function hasNativeVisible(items) {
  return Array.isArray(items) && items.some(item => item.type === 'message' || item.type === 'function_call');
}
export function nativeConflicts(message) {
  if (!hasNativeVisible(message.native_output_items)) return [];
  const projected = nativeVisible(message.native_output_items);
  const errors = [];
  if ((message.content != null && typeof message.content !== 'string') || (message.content ?? '') !== projected.content) errors.push('content 与原生 message 文本不一致');
  const neutralCalls = (message.tool_calls || []).map(c => ({id: c.id, name: c.name, arguments: c.arguments}));
  if (!same(neutralCalls, projected.tool_calls)) errors.push('tool_calls 与原生 function_call 不一致');
  return errors;
}
// Do not drop any unknown item/block properties, even for a text block replaced with an empty string.
export function syncNative(message, {textChanged = true} = {}) {
  if (!hasNativeVisible(message.native_output_items)) return message;
  if (message.content != null && typeof message.content !== 'string') throw Error('非文本正文请在完整 JSON 中编辑；不能自动同步原生块');
  const visibleText = message.content ?? '';
  const calls = message.tool_calls || [], used = new Set();
  let wroteText = false;
  message.native_output_items = message.native_output_items.flatMap(n => {
    if (n.type === 'message') return [{...n, content: (n.content || []).map(b => {
      if (!textChanged || !['text', 'output_text'].includes(b.type)) return b;
      const text = wroteText ? '' : visibleText;
      wroteText = true;
      return {...b, text};
    })}];
    if (n.type !== 'function_call') return [n];
    const call = calls.find(c => c.id === (n.call_id || n.id) && !used.has(c));
    if (!call) return [];
    used.add(call);
    return [{...n, call_id: call.id, name: call.name, arguments: call.arguments}];
  });
  if (textChanged && !wroteText && visibleText) message.native_output_items.push({type: 'message', role: 'assistant', content: [{type: 'output_text', text: visibleText}]});
  for (const call of calls) if (!used.has(call)) message.native_output_items.push({type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments});
  return message;
}
export function reconcileMessage(previous, edited) {
  const neutralChanged = !same(previous.content, edited.content) || !same(previous.tool_calls, edited.tool_calls);
  const nativeChanged = !same(previous.native_output_items, edited.native_output_items);
  const next = clone(edited);
  // Anthropic stores only opaque thinking/redacted_thinking blocks here. These do not project
  // content/calls and must never cause an empty projection to erase neutral fields.
  if (!hasNativeVisible(next.native_output_items) && !hasNativeVisible(previous.native_output_items)) return next;
  if (neutralChanged && nativeChanged) {
    const mismatch = nativeConflicts(next);
    if (mismatch.length) throw Error(`正文与原生数据同时改动且冲突：${mismatch.join('；')}。请手动协调，不会覆盖任何一方。`);
  } else if (nativeChanged) {
    const projected = nativeVisible(next.native_output_items);
    next.content = projected.content;
    if (projected.tool_calls.length) next.tool_calls = projected.tool_calls.map(call => ({...(previous.tool_calls || []).find(old => old.id === call.id), ...call}));
    else delete next.tool_calls;
  } else if (neutralChanged) syncNative(next, {textChanged: !same(previous.content, next.content)});
  return next;
}
// Only calls in this assistant batch can own immediately following tool results.
export function relations(doc) {
  const pairs = [], issues = [];
  let pending = new Map();
  for (const e of doc.entries) {
    const m = e.message;
    if (m.role === 'assistant') {
      for (const p of pending.values()) issues.push({entryId: p.entryId, severity: 'error', text: `${p.call.name} 缺少结果`});
      pending = new Map();
      for (const call of m.tool_calls || []) {
        if (!call.id || pending.has(call.id)) issues.push({entryId: e.entryId, severity: 'error', text: '当前批次调用 ID 为空或重复'});
        const p = {entryId: e.entryId, call, results: []};
        pairs.push(p);
        if (call.id) pending.set(call.id, p);
      }
    } else if (m.role === 'tool') {
      const p = pending.get(m.tool_call_id);
      if (p) { p.results.push(e.entryId); pending.delete(m.tool_call_id); }
      else issues.push({entryId: e.entryId, severity: 'error', text: `${m.name || '工具'} 返回找不到当前批次调用`});
    } else {
      for (const p of pending.values()) issues.push({entryId: p.entryId, severity: 'error', text: `${p.call.name} 缺少结果`});
      pending = new Map();
    }
  }
  for (const p of pending.values()) issues.push({entryId: p.entryId, severity: 'error', text: `${p.call.name} 缺少结果（普通调用不可冒充 Responses async）`});
  return {pairs, issues};
}
export function callImpact(doc, entryId, callId) {
  const pair = relations(doc).pairs.find(p => p.entryId === entryId && p.call.id === callId);
  if (!pair) throw Error('当前批次找不到调用');
  if (doc.entries.find(e => e.entryId === entryId).message.tool_calls.filter(c => c.id === callId).length !== 1) throw Error('本批次调用 ID 重复，无法安全联动删除；请先在 JSON 中处理重复 ID');
  const message = doc.entries.find(e => e.entryId === entryId).message;
  const native = (message.native_output_items || []).map((item, index) => ({item, index})).filter(({item}) => item.type === 'function_call' && (item.call_id || item.id) === callId).map(({index}) => `${entryId}.native_output_items[${index}]`);
  return {pair, remove: [`${entryId}.tool_calls[${callId}]`, ...native, ...pair.results.map(id => `${id}.message`)], retain: (message.tool_calls || []).filter(c => c.id !== callId).map(c => c.id)};
}
export function deleteCall(doc, entryId, callId, keepResults = false) {
  const next = clone(doc), {pair} = callImpact(next, entryId, callId);
  const m = next.entries.find(e => e.entryId === entryId).message;
  m.tool_calls = m.tool_calls.filter(c => c.id !== callId);
  if (!m.tool_calls.length) delete m.tool_calls;
  syncNative(m, {textChanged: false});
  if (!keepResults) next.entries = next.entries.filter(e => !pair.results.includes(e.entryId));
  return next;
}
export function reasoningImpact(doc, entryId, suffix = true) {
  const start = doc.entries.findIndex(e => e.entryId === entryId);
  if (start < 0) throw Error('找不到消息');
  const impacted = [];
  for (const e of doc.entries.slice(start, suffix ? undefined : start + 1)) {
    for (const field of ['reasoning', 'signature']) if (Object.hasOwn(e.message, field)) impacted.push(`${e.entryId}.${field}`);
    (e.message.native_output_items || []).forEach((n, i) => { if (THINKING_TYPES.has(n.type)) impacted.push(`${e.entryId}.native_output_items[${i}] (${n.type})`); });
  }
  return impacted;
}
export function deleteReasoning(doc, entryId, suffix = true) {
  const next = clone(doc), index = next.entries.findIndex(e => e.entryId === entryId);
  if (index < 0) throw Error('找不到消息');
  for (const e of next.entries.slice(index, suffix ? undefined : index + 1)) {
    delete e.message.reasoning;
    delete e.message.signature;
    if (Array.isArray(e.message.native_output_items)) e.message.native_output_items = e.message.native_output_items.filter(n => !THINKING_TYPES.has(n.type));
  }
  return next;
}
export function deleteEntries(doc, ids) {
  let next = clone(doc);
  const chosen = new Set(ids), linked = relations(next).pairs;
  for (const p of linked) {
    if (chosen.has(p.entryId)) p.results.forEach(id => chosen.add(id));
    else if (p.results.some(id => chosen.has(id))) next = deleteCall(next, p.entryId, p.call.id);
  }
  next.entries = next.entries.filter(e => !chosen.has(e.entryId));
  return next;
}
export function diffDocument(baseline, working) {
  const out = [];
  for (const field of ['system', 'tools']) if (!same(baseline[field], working[field])) out.push({id: field, before: baseline[field], after: working[field]});
  const before = new Map(baseline.entries.map(e => [e.entryId, e]));
  const after = new Map(working.entries.map(e => [e.entryId, e]));
  for (const id of new Set([...before.keys(), ...after.keys()])) if (!same(before.get(id), after.get(id))) out.push({id, before: before.get(id), after: after.get(id)});
  if (!same(baseline.entries.map(e => e.entryId), working.entries.map(e => e.entryId))) out.push({id: 'order', before: baseline.entries.map(e => e.entryId), after: working.entries.map(e => e.entryId)});
  return out;
}
export function localIssues(doc) {
  const issues = relations(doc).issues;
  for (const e of doc.entries) {
    const m = e.message;
    if (!['user', 'assistant', 'tool'].includes(m.role)) issues.push({entryId: e.entryId, severity: 'error', text: '无效角色'});
    for (const c of m.tool_calls || []) {
      try { const obj = JSON.parse(c.arguments); if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw Error(); }
      catch { issues.push({entryId: e.entryId, severity: 'error', text: `${c.name} arguments 不是 JSON 对象`}); }
    }
    for (const text of nativeConflicts(m)) issues.push({entryId: e.entryId, severity: 'error', text});
    if (m.signature && !Object.hasOwn(m, 'reasoning')) issues.push({entryId: e.entryId, severity: 'warning', text: '签名缺少 reasoning 字段，空字符串与缺失不同'});
  }
  return issues;
}
