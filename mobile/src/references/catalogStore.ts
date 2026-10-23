/**
 * 引用目录（B3-12～B3-17、B3-22）：直接复用 Web references/catalog.js 的目录状态、快照/增量应用和搜索
 * （中文 / 拼音 / 首字母 / `*` 通配 / Fuse 模糊），数据来自会话层已经连着的全局 WS（session.onGlobalEvent）。
 * App 不用 catalog.js 自己的 WebSocket（start/stopReferenceCatalog 依赖浏览器），而是：
 *  - 挂载时若目录未就绪 / 已过期，向全局 WS 发 {type:'resync', includeArchived}，服务端回完整快照；
 *  - snapshot / patch 交给 applyCatalogPacket；序号对不上（返回 false）或收到 resync/stale 时重新请求快照；
 *  - 切换服务器时清空目录。
 * React 通过 useReferenceCatalog() 的版本号得知变化。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react';

import { useSession } from '../data/session';
// @ts-ignore - JS module without types
import * as catalog from '@openbear/web/references/catalog.js';
// @ts-ignore
import * as messages from '@openbear/web/references/conversationMessages.js';
// @ts-ignore
import * as presentation from '@openbear/web/references/presentation.js';

export const referenceCatalog: {
  items: any[];
  ready: boolean;
  connected: boolean;
  stale: boolean;
  includeArchived: boolean;
  conversationContentLimit: number;
} = catalog.referenceCatalog;
export const searchReferences: (query: string, opts?: { kind?: string; currentConversation?: string; limit?: number; items?: any[] | null }) => any[] = catalog.searchReferences as any;
export const acceptReferenceSizes: (items: any[], limit?: number) => void = catalog.acceptReferenceSizes;
export const referencePolicyOptions: () => any = catalog.referencePolicyOptions;
export const conversationMessages: (rows: any[]) => any[] = messages.conversationMessages;
export const referenceCandidateDetail: (item: any) => string = presentation.referenceCandidateDetail;

let version = 0;
const listeners = new Set<() => void>();
function bump() {
  version += 1;
  for (const fn of [...listeners]) fn();
}

let sender: ((payload: Record<string, unknown>) => boolean) | null = null;
let serverKey = '';
let subscription: { off: () => void; count: number; key: string } | null = null;

function requestScope() {
  referenceCatalog.stale = true;
  sender?.({ type: 'resync', includeArchived: referenceCatalog.includeArchived });
}

function handle(packet: any) {
  if (!packet || typeof packet !== 'object') return;
  if (packet.type === 'resync' || packet.type === 'stale') {
    requestScope();
    bump();
    return;
  }
  if (packet.type !== 'snapshot' && packet.type !== 'patch') return;
  if (!catalog.applyCatalogPacket(packet)) requestScope();
  bump();
}

function resetForServer(key: string) {
  if (serverKey === key) return;
  serverKey = key;
  Object.assign(referenceCatalog, { ready: false, stale: false, includeArchived: false, epoch: '', seq: 0, items: [] });
  bump();
}

export function setIncludeArchived(value: boolean) {
  if (referenceCatalog.includeArchived === Boolean(value)) return;
  referenceCatalog.includeArchived = Boolean(value);
  requestScope();
  bump();
}

export type CatalogState = { version: number; ready: boolean; connected: boolean; stale: boolean; includeArchived: boolean };

/** 订阅引用目录（全 App 共用一个全局 WS 监听，按引用计数）。 */
export function useReferenceCatalog(): CatalogState {
  const session = useSession();
  const [, setTick] = useState(version);
  const key = `${session.active?.id || ''}|${session.baseUrl}`;
  useEffect(() => {
    const fn = () => setTick(version);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  useEffect(() => {
    resetForServer(key);
    sender = session.sendGlobalEvent;
    if (!subscription || subscription.key !== key) {
      subscription?.off();
      subscription = { off: session.onGlobalEvent(handle), count: 0, key };
    }
    subscription.count += 1;
    return () => {
      if (!subscription) return;
      subscription.count -= 1;
      if (subscription.count <= 0) {
        subscription.off();
        subscription = null;
      }
    };
  }, [key, session.onGlobalEvent, session.sendGlobalEvent]);
  // 连上（或重连）后目录未就绪/过期：请求快照
  useEffect(() => {
    referenceCatalog.connected = session.globalConnected;
    if (session.globalConnected && (!referenceCatalog.ready || referenceCatalog.stale)) {
      const timer = setTimeout(() => {
        if (!referenceCatalog.ready || referenceCatalog.stale) requestScope();
      }, 400);
      bump();
      return () => clearTimeout(timer);
    }
    bump();
    return undefined;
  }, [session.globalConnected, key]);
  return {
    version,
    ready: Boolean(referenceCatalog.ready),
    connected: Boolean(session.globalConnected),
    stale: Boolean(referenceCatalog.stale),
    includeArchived: Boolean(referenceCatalog.includeArchived),
  };
}
