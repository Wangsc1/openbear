/**
 * 新会话草稿的首次发送交接（B3-35）：新会话页建好会话后，把这次发送（文字、附件、引用顺序）交给
 * 新会话对话页的输入区，由它按正常发送链路完成上传、WS 发送和回执（失败时草稿与附件留在新会话里）。
 * 这是用户点的那一次发送，不是自动重发。
 */
import type { DraftAttachment } from '../drafts/attachmentDrafts';

export type FirstSend = { draftText: string; attachments: DraftAttachment[]; referenceOrder: string[]; createdAt: number };

const pending = new Map<string, FirstSend>();

export function setPendingFirstSend(uuid: string, value: Omit<FirstSend, 'createdAt'>) {
  pending.set(uuid, { ...value, createdAt: Date.now() });
}

export function takePendingFirstSend(uuid: string): FirstSend | null {
  const value = pending.get(uuid) || null;
  pending.delete(uuid);
  return value && Date.now() - value.createdAt < 120000 ? value : null;
}
