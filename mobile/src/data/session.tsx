/**
 * 应用级状态：服务器列表与当前服务器、它的 REST/WS 客户端、会话列表、对话 store 缓存、列表库开关。
 *
 * - 多服务器：servers 是 App 里添加过的全部地址，active 是当前使用的那个；切换时释放旧服务器的
 *   对话 store 与全局 WS，再用新服务器的令牌建立连接。各服务器的令牌、缓存互不影响。
 * - 不内置任何服务器地址。首次启动没有服务器时由界面进入“添加服务器”向导。
 * - 开发期可通过 OPENBEAR_DEV_SERVER_URL（app.config.ts -> extra.devServerUrl）预填向导里的地址。
 */
import Constants from 'expo-constants';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { type AppSession, type ServerProbe, currentSession, logout } from '../transport/auth';
import { HttpClient, type ServerConnection, conversationApi } from '../transport/http';
import { connectGlobalEvents, createConversationSocketFactory } from '../transport/socket';
import { ConversationStore } from './conversationStore';
import {
  type SavedServer,
  clearSession,
  defaultServerName,
  loadServers,
  loadSession,
  saveServers,
  saveSession,
  serverId,
} from './servers';

export type ListImpl = 'legend' | 'flash';

/**
 * 会话列表项。字段名与真实后端一致：
 * - app/web_console/conversation_tree.py::_tree_conversation_json 与 activity.py（目录、置顶、归档、活动状态）；
 * - conversations.py 的运行统计（operationCount 等）；
 * - preview 为演示用摘要（真实后端暂无，模拟后端提供；没有时界面回退到 currentStatus）。
 */
export type ConversationSummary = {
  conversationUuid: string;
  title: string;
  running?: boolean;
  updatedAt?: number;
  benchOperationCount?: number;
  folderId?: string;
  /** 目录路径文字；"临时会话" 表示无目录 */
  path?: string;
  origin?: string;
  pinned?: boolean;
  pinnedAt?: number;
  archived?: boolean;
  createdAt?: number;
  /** 秒 */
  lastConversationAt?: number;
  status?: 'running' | 'idle' | string;
  currentStatus?: string;
  /** running / waiting / completed / failed / idle ... */
  activityState?: string;
  activityPending?: unknown[];
  activityUnread?: boolean;
  activityVersion?: number;
  activityReadVersion?: number;
  activityResult?: { status?: string; atMs?: number; [key: string]: unknown };
  operationCount?: number;
  activeCount?: number;
  pendingInteractionCount?: number;
  activeStartedAtMs?: number;
  latestUpdatedAtMs?: number;
  preview?: string;
};

/** 会话树实时状态：/api/conversation-tree/status 与全局事件里的 treeStatus。 */
export type TreeStatus = {
  items?: any[];
  activityItems?: any[];
  recentItems?: any[];
  folderRunningCounts?: Record<string, number>;
  folderConversationCounts?: Record<string, number>;
  revision?: number;
};

/** 当前服务器的连接状态：ready 已登录可用；login 需要登录；offline 连不上（保留令牌，稍后重试）。 */
export type ConnectionState = 'none' | 'loading' | 'login' | 'ready' | 'offline';

type SessionValue = {
  /** 已添加的服务器（多服务器） */
  servers: SavedServer[];
  active: SavedServer | null;
  state: ConnectionState;
  error: string;
  /** 当前服务器的 HTTP 客户端；未登录时为 null */
  http: HttpClient | null;
  /** 兼容旧调用：当前服务器地址 */
  baseUrl: string;
  signedIn: boolean;
  /** 添加服务器（登录成功后调用），并切换过去 */
  addServer(probe: ServerProbe, session: AppSession, name?: string, username?: string): Promise<void>;
  /** 已有服务器重新登录（令牌过期、被吊销后） */
  completeLogin(id: string, session: AppSession, username?: string): Promise<void>;
  switchServer(id: string): Promise<void>;
  renameServer(id: string, name: string): Promise<void>;
  removeServer(id: string): Promise<void>;
  signOut(id?: string): Promise<void>;
  retry(): void;
  conversations: ConversationSummary[];
  /** 当前服务器的会话列表是否已经取回过一次（之前显示加载中，而不是“还没有会话”） */
  conversationsLoaded: boolean;
  treeStatus: TreeStatus | null;
  globalConnected: boolean;
  /** 全局事件订阅（会话树等需要直接处理原始事件的模块使用） */
  onGlobalEvent(listener: (event: any) => void): () => void;
  /** 向全局事件 WS 发客户端消息（会话概览订阅、引用目录 resync / includeArchived）；未连接时返回 false */
  sendGlobalEvent(payload: Record<string, unknown>): boolean;
  /** sendGlobalEvent 的别名（会话树使用） */
  sendGlobal(payload: Record<string, unknown>): boolean;
  refresh(): Promise<void>;
  storeFor(uuid: string): ConversationStore;
  releaseStore(uuid: string): void;
  listImpl: ListImpl;
  setListImpl(impl: ListImpl): void;
  devServerUrl: string;
};

const SessionContext = createContext<SessionValue | null>(null);

const devServerUrl = String((Constants.expoConfig?.extra as any)?.devServerUrl || '');

export function SessionProvider({ children, initialListImpl }: { children: React.ReactNode; initialListImpl?: ListImpl }) {
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [activeId, setActiveId] = useState('');
  const [connection, setConnection] = useState<ServerConnection | null>(null);
  const [state, setState] = useState<ConnectionState>('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [conversationRows, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [treeStatus, setTreeStatus] = useState<TreeStatus | null>(null);
  const [globalConnected, setGlobalConnected] = useState(false);
  const [listImpl, setListImpl] = useState<ListImpl>(initialListImpl || 'legend');
  const stores = useRef(new Map<string, ConversationStore>());
  const globalListeners = useRef(new Set<(event: any) => void>());
  const globalSender = useRef<((payload: Record<string, unknown>) => boolean) | null>(null);
  const loaded = useRef(false);

  const active = useMemo(() => servers.find((s) => s.id === activeId) || null, [servers, activeId]);

  // 会话列表项 + 实时状态（运行中、等待回答、未读）。无效条目（没有 conversationUuid）一律丢弃。
  const conversations = useMemo(() => {
    const rows = conversationRows.filter((row) => typeof row?.conversationUuid === 'string' && row.conversationUuid);
    if (!treeStatus) return rows;
    const live = new Map<string, any>();
    for (const item of [...(treeStatus.items || []), ...(treeStatus.activityItems || [])]) {
      if (item?.conversationUuid) live.set(item.conversationUuid, { ...(live.get(item.conversationUuid) || {}), ...item });
    }
    return rows.map((row) => {
      const item = live.get(row.conversationUuid);
      if (!item) return row.running ? { ...row, running: false, status: 'idle' } : row;
      return { ...row, ...item, title: row.title || item.title };
    });
  }, [conversationRows, treeStatus]);

  const persist = useCallback(async (next: SavedServer[], nextActive: string) => {
    setServers(next);
    setActiveId(nextActive);
    await saveServers(next, nextActive);
  }, []);

  useEffect(() => {
    void loadServers().then(({ servers: list, activeId: id }) => {
      loaded.current = true;
      setServers(list);
      setActiveId(list.some((s) => s.id === id) ? id : list[0]?.id || '');
      if (!list.length) setState('none');
    });
  }, []);

  const disposeStores = useCallback(() => {
    for (const store of stores.current.values()) store.dispose();
    stores.current.clear();
  }, []);

  // 当前服务器变化：读取令牌、确认会话仍有效
  useEffect(() => {
    if (!loaded.current) return undefined;
    disposeStores();
    setConversations([]);
    setConversationsLoaded(false);
    setTreeStatus(null);
    setConnection(null);
    setError('');
    if (!active) {
      setState(servers.length ? 'loading' : 'none');
      return undefined;
    }
    let cancelled = false;
    setState('loading');
    void (async () => {
      const session = await loadSession(active.id);
      if (cancelled) return;
      if (!session) {
        setState('login');
        return;
      }
      const conn: ServerConnection = { baseUrl: active.baseUrl, ...session };
      try {
        const current = await currentSession(new HttpClient(conn, 12000));
        if (cancelled) return;
        if (!current.ok) {
          await clearSession(active.id);
          setState('login');
          return;
        }
        setConnection(conn);
        setState('ready');
      } catch (err: any) {
        if (cancelled) return;
        setError(String(err?.body?.error || err?.message || err));
        setState('offline');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active?.id, active?.baseUrl, attempt, disposeStores]); // eslint-disable-line react-hooks/exhaustive-deps

  const http = useMemo(() => {
    if (!connection) return null;
    const client = new HttpClient(connection);
    client.onUnauthorized = () => {
      if (!active) return;
      void clearSession(active.id);
      setConnection(null);
      setState('login');
    };
    return client;
  }, [connection, active]);

  const refresh = useCallback(async () => {
    if (!http) return;
    const data = await conversationApi(http).list();
    setConversations(Array.isArray(data?.items) ? data.items : []);
    setConversationsLoaded(true);
  }, [http]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (state === 'ready') void refresh().catch(() => undefined);
  }, [state, refresh]);

  // 全局事件 WS：会话运行状态、未读等
  useEffect(() => {
    if (!connection || state !== 'ready') return undefined;
    return connectGlobalEvents(
      connection,
      (event) => {
        for (const listener of globalListeners.current) listener(event);
        // snapshot/patch 的 items/upserts 是引用目录（会话、记忆、文档…），不是会话列表项。
        // 会话的运行、未读状态在 treeStatus（与 /api/conversation-tree/status 同构）；会话增删改时重新拉列表。
        if (event.treeStatus) setTreeStatus(event.treeStatus);
        const changed = [...(event.upserts || []), ...(event.removed || [])].some((item: any) =>
          typeof item === 'string' ? item.startsWith('chat:') : item?.kind === 'chat',
        );
        if (event.type === 'patch' && changed) void refreshRef.current().catch(() => undefined);
      },
      setGlobalConnected,
      (send) => {
        globalSender.current = send;
      },
    );
  }, [connection, state]);

  const sendGlobalEvent = useCallback((payload: Record<string, unknown>) => Boolean(globalSender.current?.(payload)), []);

  // 回到前台时确认登录仍有效（令牌可能在其他设备上被撤销、网关可能换了账号）；401/409 交给 onUnauthorized。
  // 顺便刷新会话列表，补上后台期间 WS 断开错过的变化。
  useEffect(() => {
    if (!http || state !== 'ready') return undefined;
    let last = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      if (last.match(/inactive|background/) && next === 'active') {
        void currentSession(http)
          .then((current) => {
            if (current.ok) void refreshRef.current().catch(() => undefined);
          })
          .catch(() => undefined);
      }
      last = next;
    });
    return () => sub.remove();
  }, [http, state]);

  const onGlobalEvent = useCallback((listener: (event: any) => void) => {
    globalListeners.current.add(listener);
    return () => {
      globalListeners.current.delete(listener);
    };
  }, []);

  const touch = useCallback(
    (list: SavedServer[], id: string, patch: Partial<SavedServer> = {}) =>
      list.map((s) => (s.id === id ? { ...s, ...patch, lastUsedAt: Date.now() } : s)),
    [],
  );

  const addServer = useCallback(
    async (probe: ServerProbe, session: AppSession, name?: string, username?: string) => {
      const existing = servers.find((s) => s.baseUrl === probe.baseUrl && (s.username || '') === (username || ''));
      const id = existing?.id || serverId();
      await saveSession(id, session);
      const entry: SavedServer = {
        id,
        baseUrl: probe.baseUrl,
        name: name?.trim() || existing?.name || defaultServerName(probe.baseUrl),
        kind: probe.kind,
        login: probe.login,
        version: probe.version,
        instancesFeature: probe.instancesFeature,
        username,
        addedAt: existing?.addedAt || Date.now(),
        lastUsedAt: Date.now(),
      };
      const next = existing ? servers.map((s) => (s.id === id ? entry : s)) : [...servers, entry];
      await persist(next, id);
      setAttempt((n) => n + 1);
    },
    [servers, persist],
  );

  const completeLogin = useCallback(
    async (id: string, session: AppSession, username?: string) => {
      await saveSession(id, session);
      await persist(touch(servers, id, username ? { username } : {}), id);
      setAttempt((n) => n + 1);
    },
    [servers, persist, touch],
  );

  const switchServer = useCallback(
    async (id: string) => {
      if (id === activeId) return;
      await persist(touch(servers, id), id);
    },
    [servers, activeId, persist, touch],
  );

  const renameServer = useCallback(
    async (id: string, name: string) => {
      await persist(servers.map((s) => (s.id === id ? { ...s, name: name.trim() || defaultServerName(s.baseUrl) } : s)), activeId);
    },
    [servers, activeId, persist],
  );

  const signOut = useCallback(
    async (id?: string) => {
      const target = id || activeId;
      const server = servers.find((s) => s.id === target);
      const session = target ? await loadSession(target) : null;
      if (server && session) {
        try {
          await logout(new HttpClient({ baseUrl: server.baseUrl, ...session }, 8000));
        } catch {
          /* 服务器不可达时也清掉本地令牌 */
        }
      }
      if (target) await clearSession(target);
      if (target === activeId) {
        setConnection(null);
        setState('login');
      }
    },
    [servers, activeId],
  );

  const removeServer = useCallback(
    async (id: string) => {
      await signOut(id);
      const next = servers.filter((s) => s.id !== id);
      const nextActive = id === activeId ? next.sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]?.id || '' : activeId;
      await persist(next, nextActive);
      if (!next.length) setState('none');
    },
    [servers, activeId, persist, signOut],
  );

  const storeFor = useCallback(
    (uuid: string) => {
      let store = stores.current.get(uuid);
      if (!store && http && connection) {
        store = new ConversationStore(uuid, conversationApi(http), createConversationSocketFactory(connection));
        stores.current.set(uuid, store);
        void store.open();
      }
      return store as ConversationStore;
    },
    [http, connection],
  );

  // 离开对话即释放（设计 5.2-5：切换会话不累积内存）
  const releaseStore = useCallback((uuid: string) => {
    const store = stores.current.get(uuid);
    if (store) {
      store.dispose();
      stores.current.delete(uuid);
    }
  }, []);

  const value: SessionValue = {
    servers,
    active,
    state,
    error,
    http,
    baseUrl: active?.baseUrl || '',
    signedIn: state === 'ready',
    addServer,
    completeLogin,
    switchServer,
    renameServer,
    removeServer,
    signOut,
    retry: () => setAttempt((n) => n + 1),
    conversations,
    conversationsLoaded,
    treeStatus,
    globalConnected,
    onGlobalEvent,
    sendGlobalEvent,
    sendGlobal: sendGlobalEvent,
    refresh,
    storeFor,
    releaseStore,
    listImpl,
    setListImpl,
    devServerUrl,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

export function useConversationSnapshot(store: ConversationStore | undefined) {
  const [snapshot, setSnapshot] = useState(store?.snapshot);
  useEffect(() => {
    if (!store) return undefined;
    setSnapshot(store.snapshot);
    return store.subscribe(setSnapshot);
  }, [store]);
  return snapshot;
}
