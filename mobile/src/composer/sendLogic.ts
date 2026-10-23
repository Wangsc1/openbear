/**
 * 发送链路纯逻辑（B3-37～B3-43）。复用 Web outboundSend.js：
 *  - createOutboundSendTracker：一次只允许一个待确认的发送（requestId 防重复），准备 30s / 回执 15s 超时；
 *  - restoreOutboundDraft：失败时把发出去的草稿和期间新输入的内容合并恢复（不自动重发）。
 * 其余是 ConsoleView.vue 里的小段逻辑：待处理插话的归一化与 WS 事件、上传进度文案。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore - JS module without types
import * as outbound from '@openbear/web/views/consoleView/outboundSend.js';
// @ts-ignore
import * as titles from '@openbear/web/conversationTitle.js';

export const createOutboundSendTracker: (options?: any) => {
  begin(data: any): any;
  markUploading(p: any): boolean;
  markPrepared(p: any): boolean;
  markSent(p: any): boolean;
  take(requestId: string): any;
  checkDeadline(): boolean;
  isCurrent(p: any): boolean;
  readonly current: any;
} = outbound.createOutboundSendTracker;
export const restoreOutboundDraft: (sent: string, current: string) => string = outbound.restoreOutboundDraft;
export const initialConversationTitle: (value: string) => string = titles.initialConversationTitle;

export const ATTACHMENT_ONLY_TEXT = '请根据我发送的附件内容回答。';

export function createRequestId(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

export type SteeringItem = { id: string; text: string; submittedAtMs: number };

/** ConsoleView.vue normalizePendingSteering */
export function normalizePendingSteering(items: any[] = []): SteeringItem[] {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: String(item?.id || item?.messageUuid || item?.turnUuid || `${Date.now()}-${Math.random()}`),
      text: String(item?.visibleText || item?.text || item?.content || '').trim(),
      submittedAtMs: Number(item?.submittedAtMs || 0) || Date.now(),
    }))
    .filter((item) => item.text);
}

/** ConsoleView.vue applyPendingSteeringEvent */
export function applyPendingSteeringEvent(current: SteeringItem[], data: any = {}): SteeringItem[] {
  const action = String(data.action || 'snapshot');
  if (action === 'drain' || action === 'clear') {
    const ids = new Set((Array.isArray(data.itemIds) ? data.itemIds : []).map((x: unknown) => String(x)).filter(Boolean));
    return ids.size ? current.filter((item) => !ids.has(String(item.id))) : [];
  }
  return normalizePendingSteering(data.items || []);
}

export type UploadState = { phase: 'preparing' | 'uploading' | 'finalizing' | 'complete' | 'failed'; percent: number };

/** 附件上的进度标记（ConsoleComposer.vue attachment-upload-state） */
export function uploadBadge(state: UploadState | undefined): string {
  if (!state) return '';
  if (state.phase === 'failed') return '失败 · 已保留';
  if (state.phase === 'finalizing') return '保存中';
  if (state.phase === 'complete') return '待确认';
  return `${state.percent}%`;
}

/** 发送状态中的上传进度（ConsoleView.vue send 的 onProgress） */
export function uploadStatusText(p: { loaded: number; total: number; fileIndex: number; fileCount: number; phase: string }): string {
  const overall = p.total ? Math.min(100, Math.floor((p.loaded * 100) / p.total)) : 100;
  return `上传附件 ${p.fileIndex + 1}/${p.fileCount} · ${overall}%${p.phase === 'finalizing' ? ' · 保存中' : ''}`;
}

export function filePercent(p: { fileLoaded: number; fileSize: number }): number {
  return p.fileSize ? Math.min(100, Math.floor((p.fileLoaded * 100) / p.fileSize)) : 100;
}

/** 剪贴板图片命名（ConsoleComposer.vue normalizePastedFile） */
export function pastedFileName(mime: string, index = 0, now = Date.now()): string {
  const prefix = String(mime || '').startsWith('image/') ? 'pasted-image' : 'pasted-file';
  const subtype = String(mime || '').split('/')[1] || '';
  const ext = subtype ? subtype.split(';')[0].replace(/^svg\+xml$/, 'svg').replace(/[^a-z0-9.+-]/gi, '') || 'bin' : 'bin';
  return `${prefix}-${now}-${index + 1}.${ext}`;
}

/** 发送失败的提示（ConsoleView.vue restoreReleasedOutboundSend / recoverUnconfirmedSend） */
export function failureText(error: string, uncertain: boolean): string {
  if (uncertain) return '发送结果未确认，草稿和附件已保留。请先核对会话再重试；不会自动重发。';
  if (error === 'aborted') return '上传已取消，草稿和附件已保留';
  if (['busy', 'conversation_compacting'].includes(error)) return '会话正在处理其他操作，草稿和附件已保留';
  return `发送失败：${error || '未知错误'}。草稿和附件已恢复，不会自动重发`;
}
