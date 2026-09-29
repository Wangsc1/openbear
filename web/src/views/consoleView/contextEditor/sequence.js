import {clone, reconcileMessage, THINKING_TYPES} from './operations.js';

const anthropicThinking = new Set(['thinking', 'redacted_thinking']);
const names = {message: '正文', text: '正文', function_call: '工具调用', tool_use: '工具调用', reasoning: '思考', thinking: '思考', redacted_thinking: '加密思考'};
const textOf = value => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
function nativeRow(value, index) {
  const callId = ['function_call', 'tool_use'].includes(value.type) ? value.call_id || value.id : '';
  const preview = value.type === 'message' ? (value.content || []).map(b => b.text ?? b.refusal ?? `[${b.type}]`).join('\n')
    : value.type === 'text' ? value.text
    : value.type === 'tool_use' ? JSON.stringify(value.input || {}, null, 2)
    : value.type === 'function_call' ? value.arguments
    : value.type === 'reasoning' ? (value.summary || []).map(b => b.text || '').join('\n') || '原生思考数据（可能包含不可读密文）'
    : value.type === 'thinking' ? value.thinking : value.type === 'redacted_thinking' ? '加密思考，原值保留' : textOf(value);
  return {key: `native-${index}`, source: 'native_output_items', index, type: value.type,
    label: `${names[value.type] || value.type}${value.name ? ` · ${value.name}` : ''}`, callId,
    thinking: THINKING_TYPES.has(value.type), preview: textOf(preview), value};
}

// Responses and complete Claude records store interleaved output. Older Claude
// thinking-only records and Chat fields must never imply an unrecorded timeline.
export function messageSequence(message) {
  const native = message.native_output_items || [];
  const ordered = native.length > 0 && !native.every(n => anthropicThinking.has(n.type));
  const rows = native.map(nativeRow);
  if (!ordered) {
    if (!native.length && Object.hasOwn(message, 'reasoning')) rows.push({key: 'reasoning', source: 'reasoning', type: 'reasoning', label: '思考', thinking: true, value: message.reasoning, preview: textOf(message.reasoning)});
    if (message.content != null) rows.push({key: 'content', source: 'content', type: 'message', label: '正文', value: message.content, preview: textOf(message.content)});
    (message.tool_calls || []).forEach((value, index) => rows.push({key: `call-${index}`, source: 'tool_calls', index, type: 'function_call', label: `工具调用 · ${value.name}`, callId: value.id, value, preview: value.arguments}));
  }
  return {ordered, rows};
}
export function canMoveBlock(message, key, offset) {
  const {rows} = messageSequence(message), i = rows.findIndex(row => row.key === key), a = rows[i], b = rows[i + offset];
  return Math.abs(offset) === 1 && !!a && !!b && a.source === b.source && ['native_output_items', 'tool_calls'].includes(a.source);
}
export function moveBlock(message, key, offset) {
  if (!canMoveBlock(message, key, offset)) throw Error('此处没有可调整的相邻原生块；独立字段不记录跨类型顺序');
  const row = messageSequence(message).rows.find(row => row.key === key), next = clone(message);
  const items = next[row.source], target = row.index + offset;
  [items[row.index], items[target]] = [items[target], items[row.index]];
  return reconcileMessage(message, next);
}
export function replaceBlock(message, row, value) {
  const next = clone(message);
  if (row.source === 'native_output_items') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') throw Error('原生块需要 type 字段');
    next.native_output_items[row.index] = clone(value);
  } else if (row.source === 'tool_calls') next.tool_calls[row.index] = clone(value);
  else next[row.source] = clone(value);
  return reconcileMessage(message, next);
}
