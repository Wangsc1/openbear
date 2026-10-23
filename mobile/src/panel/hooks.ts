/**
 * 会话面板的数据钩子（B4）：
 *  - useOpenBearApi：绑定当前服务器的生成接口表（与 Web Api 同名方法）；
 *  - useSessionStats：累计统计（/state 基线 + WS 帧增量），与中栏对话共用同一个 ConversationStore；
 *  - useFolderPath：会话所在目录路径（会话树目录表，按服务器缓存）；
 *  - useTaskMemoryCount / useArtifactCount：面板与检查器上的计数徽标；
 *  - useAnimatedTitle：同一会话改名时逐字显示（Web AnimatedConversationTitle 的等价物）。
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ConversationStore } from '../data/conversationStore';
import { useSession } from '../data/session';
import { createOpenBearApi, type OpenBearApi } from '../transport/apiAdapter';
import { applyStatsFrame, emptyStats, folderPathText, type SessionStats, statsFromState } from './stats';
import { nextTitleFrames } from './title';

export function useOpenBearApi(): OpenBearApi | null {
  const session = useSession();
  return useMemo(() => (session.http ? createOpenBearApi(session.http) : null), [session.http]);
}

/** 是否是还没创建到服务器上的草稿会话（Web 的 local: 前缀）。 */
export function isDraftConversation(uuid: string | undefined | null): boolean {
  const value = String(uuid || '');
  return !value || value.startsWith('local:');
}

export function useSessionStats(store: ConversationStore | undefined | null): SessionStats {
  const [stats, setStats] = useState<SessionStats>(() => (store?.stateMeta ? statsFromState(store.stateMeta) : emptyStats()));
  useEffect(() => {
    if (!store) {
      setStats(emptyStats());
      return undefined;
    }
    setStats(store.stateMeta ? statsFromState(store.stateMeta) : emptyStats());
    return store.onRaw((event) => {
      if (event.type === 'state') setStats(statsFromState(event.state));
      else {
        // 与 Web 一致：stats 帧优先用合并后的 operation payload（帧 payload 可能只是增量）
        const op = event.operation;
        const frame = op ? { ...event.frame, payload: op.payload || event.frame.payload, lifecycle: op.lifecycle, status: op.status } : event.frame;
        setStats((current) => applyStatsFrame(current, frame));
      }
    });
  }, [store]);
  return stats;
}

type FolderRow = { folderId: string; path: string };
const folderCache = new Map<string, { at: number; byId: Map<string, string> }>();

/** 目录 id -> 路径（“a / b / c”）。同一服务器 60 秒内复用。 */
export function useFolderPath(folderId: string | undefined | null): string {
  const session = useSession();
  const api = useOpenBearApi();
  const key = session.active?.id || '';
  const cached = folderCache.get(key);
  const [byId, setById] = useState<Map<string, string> | null>(cached?.byId || null);
  useEffect(() => {
    if (!api || !folderId) return undefined;
    const hit = folderCache.get(key);
    if (hit && Date.now() - hit.at < 60000 && hit.byId.has(folderId)) {
      setById(hit.byId);
      return undefined;
    }
    let cancelled = false;
    void api
      .conversationTreeFolders()
      .then((data: any) => {
        const map = new Map<string, string>();
        for (const row of (Array.isArray(data?.items) ? data.items : []) as FolderRow[]) {
          if (row?.folderId) map.set(row.folderId, String(row.path || ''));
        }
        folderCache.set(key, { at: Date.now(), byId: map });
        if (!cancelled) setById(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, folderId, key]);
  if (!folderId) return folderPathText('');
  const path = byId?.get(folderId);
  return path === undefined ? '' : folderPathText(path);
}

/** 会话记忆的有效条数（不含已删除），与 Web 任务记忆入口徽标一致。 */
export function useTaskMemoryCount(uuid: string, enabled = true) {
  const api = useOpenBearApi();
  const [count, setCount] = useState<number | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!api || !enabled || isDraftConversation(uuid)) return;
    const mine = ++seq.current;
    try {
      const data: any = await api.taskMemories(uuid, { scopeType: 'conversation', includeDeleted: 0, offset: 0, limit: 1 });
      if (mine === seq.current) setCount(Number(data?.activeTotal ?? data?.total ?? 0));
    } catch {
      /* 保留上一次的计数 */
    }
  }, [api, uuid, enabled]);
  useEffect(() => {
    setCount(null);
    void refresh();
  }, [refresh]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  return { count, refresh };
}

export type ArtifactItem = {
  artifactUuid: string;
  conversationUuid: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  inlinePreview?: boolean;
  contentUrl: string;
  previewUrl?: string;
  downloadUrl?: string;
  workspacePath?: string;
};

/** GET /api/conversations/{cid}/artifacts（后端已有，Web 未用）。 */
export function useArtifacts(uuid: string, enabled = true) {
  const session = useSession();
  const [items, setItems] = useState<ArtifactItem[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!session.http || !enabled || isDraftConversation(uuid)) return;
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const data: any = await session.http.get(`/api/conversations/${encodeURIComponent(uuid)}/artifacts`);
      if (mine !== seq.current) return;
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err: any) {
      if (mine === seq.current) setError(String(err?.body?.error || err?.message || err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [session.http, uuid, enabled]);
  useEffect(() => {
    setItems(null);
    void refresh();
  }, [refresh]);
  return { items, error, loading, refresh };
}

/**
 * 标题动画：同一会话（identity 不变）标题变化时先清空再逐字显示（50ms/字，与 Web 相同节奏）；
 * 切换会话或首次显示直接给出完整标题。
 */
export function useAnimatedTitle(title: string, identity: string): string {
  const [shown, setShown] = useState(title);
  const last = useRef({ title, identity });
  useEffect(() => {
    const previous = last.current;
    last.current = { title, identity };
    if (previous.identity !== identity || previous.title === title || !previous.title) {
      setShown(title);
      return undefined;
    }
    const frames = nextTitleFrames(title);
    let index = 0;
    setShown('');
    const timers: ReturnType<typeof setTimeout>[] = [];
    // 先留 140ms 空白（Web 的模糊淡出），再逐字出现
    frames.forEach((frame, i) => {
      timers.push(
        setTimeout(() => {
          index = i;
          setShown(frame);
        }, 140 + i * 50),
      );
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
      if (index < frames.length - 1) setShown(title);
    };
  }, [title, identity]);
  return shown;
}
