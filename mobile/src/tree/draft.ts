/**
 * 新会话草稿的“归属目录”（B1-01 的最小状态）。
 * 草稿正文、附件与首次发送属于输入区工作包 B3；这里只记录“当前有一个未发送草稿、它属于哪个目录”，
 * 用于“从别的目录新建会话时确认是否更改草稿归属”和在目录里显示草稿行。合并时由主控与 B3 的草稿存储统一。
 * - folderId 为空表示临时会话；
 * - B3 首次发送成功或删除草稿时调用 clearDraft()。
 */
import { useSyncExternalStore } from 'react';

import { readKey, writeKey } from './persist';

export type DraftInfo = { folderId: string; createdAt: number };

const KEY = 'openbear.console.draftFolder.v1';
const listeners = new Set<() => void>();

let current: DraftInfo | null = null;
let touched = false;

// 启动后异步读取（不在模块加载时同步读库）；读到之前已有写入则以写入为准
void readKey(KEY).then((raw) => {
  if (touched || !raw) return;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object') {
      current = { folderId: String(value.folderId || ''), createdAt: Number(value.createdAt || 0) };
      for (const fn of listeners) fn();
    }
  } catch {
    /* ignore */
  }
});

function write(next: DraftInfo | null) {
  touched = true;
  current = next;
  writeKey(KEY, next ? JSON.stringify(next) : null);
  for (const fn of listeners) fn();
}

export const LOCAL_DRAFT_UUID = 'local:new';

export function getDraft(): DraftInfo | null {
  return current;
}
export function setDraftFolder(folderId: string) {
  write({ folderId: String(folderId || ''), createdAt: current?.createdAt || Date.now() });
}
export function clearDraft() {
  write(null);
}
export function useDraft(): DraftInfo | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => current,
  );
}

/** 草稿在树里的行（与 Web 的 local 草稿行相同的形状）。 */
export function draftRow(draft: DraftInfo, path: string) {
  return { kind: 'conversation', id: LOCAL_DRAFT_UUID, conversationUuid: LOCAL_DRAFT_UUID, local: true, title: '新会话（草稿）', folderId: draft.folderId, parentId: draft.folderId, path, createdAt: Math.floor(draft.createdAt / 1000) };
}
