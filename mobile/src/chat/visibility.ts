/**
 * 隐藏消息的纯逻辑（无 React）：行 -> 可隐藏的操作 id、选择模式下的展示行、预览文字。
 * 规则与 Web messageVisibility.js 一致；接口 GET/PUT /api/conversations/{cid}/message-visibility。
 */
import type { ChatRow } from '../data/rows';

/** 行对应的可隐藏操作 id（用户消息、回复、工具/思考/Agent/交互/重试/状态）；工作块摘要等返回空。 */
export function rowTargetId(row: ChatRow): string {
  switch (row.type) {
    case 'user':
      return String(row.opId || '');
    case 'answer':
      return String(row.messageId || '');
    case 'tool':
    case 'reasoning':
    case 'agent':
    case 'interaction':
    case 'retry':
    case 'status':
      return String((row as any).opId || '');
    default:
      return '';
  }
}

/** 选择模式：给可选行加上 selectState（新对象，触发该行重绘）；不在选择模式时原样返回。 */
export function withSelection(rows: ChatRow[], selecting: boolean, selected: ReadonlySet<string>, canTarget: (id: string) => boolean): ChatRow[] {
  if (!selecting) return rows;
  return rows.map((row) => {
    const id = rowTargetId(row);
    if (!id || !canTarget(id)) return row;
    // 回复被切成多块时只在第一块显示勾选框
    if (row.type === 'answer' && row.blockIndex > 0) return { ...row, selectState: selected.has(id) ? 'on' : 'off', selectHidden: true } as any;
    return { ...row, selectState: selected.has(id) ? 'on' : 'off' } as any;
  });
}

const LABELS: Record<string, string> = {
  user_message: '你的消息', assistant_message: '模型回复', reasoning: '思考过程', tool: '工具记录', agent: 'Agent 记录',
  user_interaction: '交互记录', context_compaction: '上下文整理', model_retry: '模型重试', notice: '状态记录',
};

export const DRAWER_LABELS: Record<string, string> = {
  user_message: '用户消息', assistant_message: 'AI 回复', reasoning: '思考过程', tool: '工具过程', agent: 'Agent 卡片',
  user_interaction: '交互卡片', context_compaction: '上下文整理', model_retry: '重试记录', notice: '状态记录',
};

/** 操作菜单顶部的“正在操作的消息”预览（Web visibilityTargetPreview）。 */
export function visibilityTargetPreview(operation: any = {}): { label: string; text: string } {
  const label = LABELS[operation?.opType] || '消息';
  const payload = operation?.payload || {};
  const text = [payload.text, payload.content, payload.preview, Array.isArray(payload.textChunks) ? payload.textChunks.join('') : '']
    .find((value) => typeof value === 'string' && value.trim());
  const files = Array.isArray(payload.attachments) ? payload.attachments : [];
  const fallback = files.length ? `附件：${files.map((f: any) => f.fileName || f.name || '文件').join('、')}` : payload.attempt ? `第 ${payload.attempt} 次重试` : payload.name || payload.toolName || '无文字内容';
  const compact = String(text || fallback).replace(/\s+/g, ' ').trim();
  return { label, text: compact.length > 140 ? `${compact.slice(0, 139)}…` : compact };
}

/** 隐藏内容预览的正文（Web HiddenMessagesDrawer.previewText）。 */
export function hiddenPreviewText(operation: any): string {
  const p = operation?.payload || {};
  if (['user_message', 'assistant_message', 'reasoning'].includes(operation?.opType)) {
    return String(p.text || p.content || p.reasoning || (Array.isArray(p.textChunks) ? p.textChunks.join('') : ''));
  }
  return [p.text, p.content, p.arguments || p.args, p.resultText || p.result, p.preview]
    .filter(Boolean)
    .map((v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2)))
    .join('\n\n') || JSON.stringify(p, null, 2);
}
