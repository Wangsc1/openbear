/**
 * 会话树状态（手机目录视图、目录页、平板缩进树、选择器共用一份）：
 * - 组织数据：bootstrap（根目录、计数）、按需加载的分支（children 分页、加载更多、失败重试）、全部目录（路径、选择器）；
 * - 实时状态：全局 WS 的 treeStatus（session.treeStatus）为主；WS 断开时轮询 GET /api/conversation-tree/status 兜底；
 *   回到前台、全局 WS 的会话/目录增量时重新同步已加载的分支；
 * - 已读回执、“命名中”、已解锁归档（展开过“已归档”后才允许搜索归档）、平板展开状态；
 * - 所有写操作（新建/重命名/置顶/移动/归档/删除…）都走真实接口，成功后刷新受影响的分支。
 * 模块级单例 + useSyncExternalStore：不需要在根布局再挂 Provider。切换服务器时整体重置。
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { useSession } from '../data/session';
import { type OpenBearApi, createOpenBearApi } from '../transport/apiAdapter';
import type { HttpClient } from '../transport/http';
import { ARCHIVE, type Branch, type FolderLite, PAGE_SIZE, type Row, TEMP, branchKey, branchParams, emptyBranch, indexStatus, isRunningRow, mergeRows, rowId } from './treeModel';
import { readKey, writeKey } from './persist';
import { activityReadRequests } from './webTree';

export type TreeState = {
  key: string;
  ready: boolean;
  loading: boolean;
  error: string;
  rootFolders: Row[];
  activeCount: number;
  archivedCount: number;
  temporaryCount: number;
  branches: Record<string, Branch>;
  folders: FolderLite[];
  foldersLoaded: boolean;
  readVersions: Map<string, number>;
  polledStatus: Row | null;
  generating: Set<string>;
  archiveUnlocked: boolean;
  expanded: Set<string>;
  view: 'recent' | 'folders';
  /** bootstrap 给出的“上次选中的会话”（平板首次进入自动打开，B1-24） */
  selectedUuid: string;
  /** 最近在列表里打开的会话（返回列表时高亮，B1-23） */
  lastOpened: string;
  /** 定位请求：平板树滚动到这一项 */
  revealTick: number;
  revealId: string;
};

const VIEW_KEY = 'openbear:conversation-sidebar-view';
const EXPANDED_KEY = 'openbear:conversation-tree-expanded.v1';

/** 启动时异步读取一次偏好；在读到之前用默认值（最近视图、全部折叠）。 */
let prefs: { view: 'recent' | 'folders'; expanded: Set<string> } = { view: 'recent', expanded: new Set() };
let prefsLoaded = false;
async function loadPrefs() {
  if (prefsLoaded) return;
  prefsLoaded = true;
  const [view, expanded] = await Promise.all([readKey(VIEW_KEY), readKey(EXPANDED_KEY)]);
  let set = new Set<string>();
  try {
    set = new Set(expanded ? (JSON.parse(expanded) as string[]) : []);
  } catch {
    /* ignore */
  }
  prefs = { view: view === 'folders' ? 'folders' : 'recent', expanded: set };
  tree.set({ view: prefs.view, expanded: new Set([...prefs.expanded, ...tree.state.expanded]) });
}

function initial(key = ''): TreeState {
  return {
    key,
    ready: false,
    loading: false,
    error: '',
    rootFolders: [],
    activeCount: 0,
    archivedCount: 0,
    temporaryCount: 0,
    branches: {},
    folders: [],
    foldersLoaded: false,
    readVersions: new Map(),
    polledStatus: null,
    generating: new Set(),
    archiveUnlocked: false,
    expanded: new Set(prefs.expanded),
    view: prefs.view,
    selectedUuid: '',
    lastOpened: '',
    revealTick: 0,
    revealId: '',
  };
}

export function apiErrorText(error: any): string {
  const body = error?.body;
  const code = String(body?.error || '');
  const known: Record<string, string> = {
    network: '网络不可用，请检查连接',
    timeout: '请求超时',
    folder_name_required: '名称不能为空',
    folder_not_found: '目录不存在或已被删除',
    conversation_not_found: '会话不存在或已被删除',
    folder_cycle: '不能移动到自身或子目录里',
    folder_managed: '这个目录由推荐功能管理。先在推荐设置里关闭推荐，再删除它。',
    busy: '会话正在运行或处理其他操作，请稍后再试',
    move_neighbor_stale: '列表已变化，请刷新后再试',
  };
  if (body?.message && typeof body.message === 'string') return body.message;
  if (known[code]) return known[code];
  if (code) return code;
  // aiohttp 的 HTTPConflict(text=…) 返回纯文本，被 HttpClient 包成 bad_json + raw
  if (body?.raw) return known[String(body.raw).trim()] || String(body.raw).trim();
  return String(error?.message || error || '操作失败');
}

class TreeStore {
  state: TreeState = initial();
  api: OpenBearApi | null = null;
  http: HttpClient | null = null;
  listeners = new Set<() => void>();
  bootGeneration = 0;
  branchGeneration: Record<string, number> = {};
  /** 当前挂载的页面在看的节点（同步时只刷新这些分支） */
  visible = new Map<string, number>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  get = () => this.state;
  set(patch: Partial<TreeState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
  setBranch(nodeId: string, patch: Partial<Branch>) {
    const key = branchKey(nodeId);
    const current = this.state.branches[key] || emptyBranch();
    this.set({ branches: { ...this.state.branches, [key]: { ...current, ...patch } } });
  }
  branch(nodeId: string): Branch {
    return this.state.branches[branchKey(nodeId)] || emptyBranch();
  }

  attach(http: HttpClient | null, key: string) {
    if (http === this.http) return;
    this.http = http;
    this.api = http ? createOpenBearApi(http) : null;
    this.bootGeneration += 1;
    this.branchGeneration = {};
    this.state = initial(key);
    for (const fn of this.listeners) fn();
    void loadPrefs();
    if (this.api) {
      void this.bootstrap();
      void this.loadFolders();
    }
  }

  setView(view: 'recent' | 'folders') {
    prefs = { ...prefs, view };
    this.set({ view });
    writeKey(VIEW_KEY, view);
  }
  private saveExpanded(next: Set<string>) {
    prefs = { ...prefs, expanded: next };
    writeKey(EXPANDED_KEY, JSON.stringify([...next].slice(-200)));
  }

  setExpanded(id: string, open: boolean) {
    const next = new Set(this.state.expanded);
    if (open) next.add(id);
    else next.delete(id);
    this.set({ expanded: next });
    if (open && id === ARCHIVE) this.set({ archiveUnlocked: true });
    this.saveExpanded(next);
  }
  expandPath(ids: string[]) {
    const next = new Set(this.state.expanded);
    for (const id of ids) next.add(id);
    this.set({ expanded: next });
    this.saveExpanded(next);
  }

  unlockArchive() {
    if (!this.state.archiveUnlocked) this.set({ archiveUnlocked: true });
  }

  markVisible(nodeId: string, on: boolean) {
    const n = (this.visible.get(nodeId) || 0) + (on ? 1 : -1);
    if (n > 0) this.visible.set(nodeId, n);
    else this.visible.delete(nodeId);
  }

  async bootstrap(conversationUuid = '') {
    const api = this.api;
    if (!api) return null;
    const generation = ++this.bootGeneration;
    this.set({ loading: true, error: '' });
    try {
      const data: any = await api.conversationTreeBootstrap(conversationUuid ? { conversationUuid } : {});
      if (generation !== this.bootGeneration || api !== this.api) return null;
      this.set({
        ready: true,
        rootFolders: (Array.isArray(data.rootFolders) ? data.rootFolders : []).map((row: Row) => ({ ...row, kind: 'folder' })),
        activeCount: Number(data.activeCount || 0),
        archivedCount: Number(data.archivedCount || 0),
        temporaryCount: Number(data.temporaryCount || 0),
        ...(this.state.polledStatus ? {} : { polledStatus: data.running || null }),
        ...(this.state.selectedUuid ? {} : { selectedUuid: String(data.selected?.item?.conversationUuid || '') }),
      });
      return data;
    } catch (error) {
      if (generation === this.bootGeneration) this.set({ error: apiErrorText(error) });
      return null;
    } finally {
      if (generation === this.bootGeneration) this.set({ loading: false });
    }
  }

  async loadFolders() {
    const api = this.api;
    if (!api) return;
    try {
      const data: any = await api.conversationTreeFolders();
      if (api !== this.api) return;
      this.set({ folders: (data.items || []).map((f: any) => ({ folderId: String(f.folderId), parentId: String(f.parentId || ''), name: String(f.name || ''), path: String(f.path || f.name || '') })), foldersLoaded: true });
    } catch {
      /* 目录列表失败时，选择器显示重试 */
    }
  }

  /** 加载一个节点的子项：append 为“加载更多”；force 为重新读取（保持已加载页数）。 */
  async loadBranch(nodeId: string, { append = false, force = false, quiet = false } = {}) {
    const api = this.api;
    if (!api) return;
    const key = branchKey(nodeId);
    const current = this.branch(nodeId);
    if (current.loading && !force) return;
    if (!force && !append && current.loaded) return;
    const generation = (this.branchGeneration[key] = (this.branchGeneration[key] || 0) + 1);
    const wantedPages = append ? 1 : Math.max(1, current.pages);
    let cursor = append ? current.nextCursor : '';
    let incoming: Row[] = [];
    let nextCursor = '';
    let hasMore = false;
    let fetched = 0;
    if (nodeId === ARCHIVE) this.unlockArchive();
    this.setBranch(nodeId, { loading: true, error: quiet ? current.error : '' });
    try {
      while (fetched < wantedPages) {
        const data: any = await api.conversationTreeChildren({ ...branchParams(nodeId), ...(cursor ? { cursor } : {}), limit: PAGE_SIZE });
        if (generation !== this.branchGeneration[key] || api !== this.api) return;
        incoming = [...incoming, ...(Array.isArray(data.items) ? data.items : [])];
        nextCursor = String(data.nextCursor || '');
        hasMore = Boolean(data.hasMore);
        fetched += 1;
        if (append || !hasMore || !nextCursor) break;
        cursor = nextCursor;
      }
      this.setBranch(nodeId, {
        items: mergeRows(append ? current.items : [], incoming),
        nextCursor,
        hasMore,
        loaded: true,
        pages: append ? current.pages + fetched : fetched,
        loading: false,
        error: '',
      });
    } catch (error) {
      if (generation === this.branchGeneration[key]) this.setBranch(nodeId, { loading: false, error: apiErrorText(error) });
    }
  }

  /** 重新同步：根、目录列表、已加载并仍在显示的分支（保留页数与展开状态）。 */
  async refresh({ all = false } = {}) {
    await Promise.all([this.bootstrap(), this.loadFolders()]);
    const nodes = Object.keys(this.state.branches)
      .map((key) => (key === 'temporary' ? TEMP : key === 'archive' ? ARCHIVE : key.slice('folder:'.length)))
      .filter((id) => this.branch(id).loaded && (all || this.visible.has(id) || this.state.expanded.has(id)));
    // 不在显示的分支标记为未加载，下次进入时重新读取
    const stale: Record<string, Branch> = {};
    for (const [key, branch] of Object.entries(this.state.branches)) {
      const id = key === 'temporary' ? TEMP : key === 'archive' ? ARCHIVE : key.slice('folder:'.length);
      if (!nodes.includes(id)) stale[key] = { ...branch, loaded: false };
    }
    if (Object.keys(stale).length) this.set({ branches: { ...this.state.branches, ...stale } });
    await Promise.all(nodes.map((id) => this.loadBranch(id, { force: true, quiet: true })));
  }

  /** 写操作后刷新受影响的分支（新旧父节点）与计数。 */
  async afterMutation(nodes: string[] = []) {
    for (const id of new Set(nodes)) {
      const key = branchKey(id || TEMP);
      if (this.state.branches[key]) this.setBranch(id || TEMP, { loaded: false });
    }
    await this.refresh();
    await Promise.all([...new Set(nodes)].map((id) => this.loadBranch(id || TEMP, { force: true, quiet: true })));
  }

  async pollStatus() {
    const api = this.api;
    if (!api) return;
    try {
      const data: any = await api.conversationTreeStatus();
      if (api === this.api) this.set({ polledStatus: data });
    } catch {
      /* 兜底轮询失败不改动当前树 */
    }
  }

  async markRead(rows: Row[]) {
    const api = this.api;
    const requests = activityReadRequests(rows);
    if (!api || !requests.length) return false;
    const receipt: any = await api.readConversationActivity(requests);
    const versions = new Map(this.state.readVersions);
    for (const item of receipt?.items || []) versions.set(item.conversationUuid, Math.max(versions.get(item.conversationUuid) || 0, Number(item.activityReadVersion || 0)));
    this.set({ readVersions: versions });
    return true;
  }

  setLastOpened(uuid: string) {
    if (this.state.lastOpened !== uuid) this.set({ lastOpened: uuid });
  }

  /** 把定位到的会话/目录合并进对应分支（分支未加载到那一页时也能显示并高亮） */
  mergeLocated(folderItems: Row[] = [], item: Row | null = null) {
    for (const folder of folderItems) {
      const parent = String(folder.parentId || '');
      if (!parent) this.set({ rootFolders: mergeRows(this.state.rootFolders, [{ ...folder, kind: 'folder' }]) });
      else this.setBranch(parent, { items: mergeRows(this.branch(parent).items, [{ ...folder, kind: 'folder' }]) });
    }
    if (item?.conversationUuid) {
      const node = item.archived ? ARCHIVE : String(item.folderId || '') || TEMP;
      this.setBranch(node, { items: mergeRows(this.branch(node).items, [{ ...item, kind: 'conversation' }]) });
    }
  }

  /**
   * 在目录中定位（B1-14 / B1-23 / B1-32）：GET /api/conversation-tree/locate/{cid}（或 locate-folder/{fid}），
   * 展开路径并加载沿途分支，归档会话会解锁并展开“已归档”。返回它所在的节点 id 与路径。
   */
  async reveal(kind: 'conversation' | 'folder', id: string): Promise<{ node: string; path: string[]; item: Row | null }> {
    const api = this.requireApi();
    if (kind === 'folder') {
      const data: any = await api.locateConversationFolderInTree(id);
      const path: string[] = (data.folderPath || [id]).map(String);
      this.mergeLocated(data.folderItems || []);
      this.expandPath(path.slice(0, -1));
      await Promise.all(path.slice(0, -1).map((p) => this.loadBranch(p)));
      this.mergeLocated(data.folderItems || []);
      this.set({ revealId: id, revealTick: this.state.revealTick + 1 });
      return { node: String(path[path.length - 2] || ''), path, item: null };
    }
    const data: any = await api.locateConversationInTree(id);
    const item = data.item || null;
    const path: string[] = (data.folderPath || []).map(String);
    let node: string;
    if (item?.archived) {
      node = ARCHIVE;
      this.unlockArchive();
      this.expandPath([ARCHIVE]);
      await this.loadBranch(ARCHIVE);
    } else if (!path.length) {
      node = TEMP;
      this.expandPath([TEMP]);
      await this.loadBranch(TEMP);
    } else {
      node = path[path.length - 1];
      this.expandPath(path);
      await Promise.all(path.map((p) => this.loadBranch(p)));
    }
    this.mergeLocated(data.folderItems || [], item);
    this.set({ revealId: id, revealTick: this.state.revealTick + 1, lastOpened: id });
    return { node, path, item };
  }

  setGenerating(uuid: string, on: boolean) {
    const next = new Set(this.state.generating);
    if (on) next.add(uuid);
    else next.delete(uuid);
    this.set({ generating: next });
  }

  // ---- 写操作（与 Web 相同的接口与参数） ----
  requireApi(): OpenBearApi {
    if (!this.api) throw new Error('未连接服务器');
    return this.api;
  }
  async createFolder(name: string, parentId = '') {
    const data: any = await this.requireApi().createConversationFolder({ name: name.trim(), parentId });
    if (parentId) this.setExpanded(parentId, true);
    void this.afterMutation([parentId]);
    return data.folder as Row;
  }
  async rename(row: Row, name: string) {
    const api = this.requireApi();
    if (row.kind === 'folder') await api.updateConversationFolder(row.folderId, { name: name.trim() });
    else await api.updateConversation(row.conversationUuid, { title: name.trim() });
    void this.afterMutation([parentOf(row)]);
  }
  async togglePin(row: Row) {
    const api = this.requireApi();
    if (row.kind === 'folder') await api.updateConversationFolder(row.folderId, { pinned: !row.pinned });
    else if (row.pinned) await api.unpinConversation(row.conversationUuid);
    else await api.pinConversation(row.conversationUuid);
    void this.afterMutation([parentOf(row)]);
  }
  async generateTitle(row: Row) {
    const uuid = String(row.conversationUuid);
    this.setGenerating(uuid, true);
    try {
      const result: any = await this.requireApi().generateConversationTitle(uuid);
      void this.afterMutation([parentOf(row)]);
      return result as { title?: string; changed?: boolean };
    } finally {
      this.setGenerating(uuid, false);
    }
  }
  async duplicate(row: Row) {
    const data: any = await this.requireApi().duplicateConversation(row.conversationUuid);
    void this.afterMutation([parentOf(row)]);
    return (data.conversation || null) as Row | null;
  }
  async setArchived(row: Row, archived: boolean) {
    const result: any = await this.requireApi().setConversationArchived(row.conversationUuid, archived);
    this.forget(row);
    void this.afterMutation([parentOf(row), ARCHIVE]);
    return result as { nextConversation?: Row | null };
  }
  async deleteConversation(row: Row) {
    await this.requireApi().deleteConversation(row.conversationUuid);
    this.forget(row);
    void this.afterMutation([parentOf(row), ...(row.archived ? [ARCHIVE] : [])]);
  }
  async moveImpact(row: Row, targetFolderId: string) {
    return this.requireApi().conversationTreeMoveImpact({ kind: row.kind, id: rowId(row), targetFolderId });
  }
  /** 写操作成功后立即从所有已知分支中去掉这一项（新位置由随后的刷新给出），避免旧位置短暂残留 */
  forget(row: Row) {
    const id = `${row.kind}:${rowId(row)}`;
    const keep = (r: Row) => `${r.kind}:${rowId(r)}` !== id;
    const branches: Record<string, Branch> = {};
    for (const [key, branch] of Object.entries(this.state.branches)) branches[key] = branch.items.some((r) => !keep(r)) ? { ...branch, items: branch.items.filter(keep) } : branch;
    this.set({ branches, rootFolders: this.state.rootFolders.filter(keep) });
  }

  async move(row: Row, targetFolderId: string, opts: { beforeId?: string; afterId?: string; updateSnapshots?: boolean; unarchive?: boolean } = {}) {
    const result: any = await this.requireApi().moveConversationTreeItem({
      kind: row.kind,
      id: rowId(row),
      targetFolderId,
      beforeId: opts.beforeId || '',
      afterId: opts.afterId || '',
      updateSnapshots: Boolean(opts.updateSnapshots),
      ...(row.kind === 'conversation' && row.archived ? { unarchive: Boolean(opts.unarchive) } : {}),
    });
    this.forget(row);
    const moved = result?.organization?.item;
    if (moved) this.mergeLocated(result?.organization?.folderItems || [], moved.kind === 'folder' ? null : moved);
    if (moved?.kind === 'folder') this.mergeLocated([moved]);
    return result;
  }
  async deleteFolderImpact(row: Row, targetFolderId: string) {
    return this.requireApi().deleteConversationFolder(row.folderId, { targetFolderId, impactOnly: true });
  }
  async deleteFolder(row: Row, targetFolderId: string, updateSnapshots: boolean) {
    const result: any = await this.requireApi().deleteConversationFolder(row.folderId, { targetFolderId, updateSnapshots });
    const branches = { ...this.state.branches };
    delete branches[branchKey(row.folderId)];
    this.set({ branches });
    void this.afterMutation([row.parentId || '', targetFolderId]);
    return result;
  }
}

export function parentOf(row: Row): string {
  if (row.kind === 'folder') return String(row.parentId || '');
  if (row.archived) return ARCHIVE;
  return String(row.folderId || '') || TEMP;
}

export const tree = new TreeStore();

/** 绑定当前服务器并订阅树状态；同时负责实时状态兜底与重新同步。 */
export function useTree(): TreeState {
  const session = useSession();
  const key = `${session.active?.id || ''}`;
  useEffect(() => {
    tree.attach(session.state === 'ready' ? session.http : null, key);
  }, [session.http, session.state, key]);
  return useSyncExternalStore(tree.subscribe, tree.get);
}

/** 实时状态 + 已读回执 + 目录待处理计数（各页面用来覆盖行）。 */
export function useTreeIndex() {
  const session = useSession();
  const state = useTree();
  const status = session.globalConnected && session.treeStatus ? session.treeStatus : state.polledStatus || session.treeStatus;
  return useMemo(() => indexStatus(status as Row | null, state.readVersions, state.folders), [status, state.readVersions, state.folders]);
}

/**
 * 树同步（在会话 Tab 根挂一次）：WS 断开时轮询状态；全局增量涉及会话/目录时防抖刷新；回到前台重新同步。
 */
export function useTreeSync() {
  const session = useSession();
  const state = useTree();
  useEffect(() => {
    if (session.state !== 'ready' || session.globalConnected) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const loop = async () => {
      await tree.pollStatus();
      if (stopped) return;
      const fast = Boolean((tree.state.polledStatus?.items || []).some(isRunningRow));
      timer = setTimeout(loop, fast ? 5000 : 20000);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [session.state, session.globalConnected]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = session.onGlobalEvent((event: any) => {
      if (event?.type !== 'patch') return;
      const touched = [...(event.upserts || []), ...(event.removed || [])].some((item: any) =>
        typeof item === 'string' ? item.startsWith('chat:') || item.startsWith('folder:') : item?.kind === 'chat' || item?.kind === 'folder',
      );
      if (!touched) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tree.refresh(), 1500);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [session.onGlobalEvent]);
  useEffect(() => {
    let last = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      if (last.match(/inactive|background/) && next === 'active') {
        void tree.refresh();
        if (!session.globalConnected) void tree.pollStatus();
      }
      last = next;
    });
    return () => sub.remove();
  }, [session.globalConnected]);
  return state;
}

/** 某个节点的分支：挂载时加载（已加载则不重复），并登记为“正在显示”。 */
export function useBranch(nodeId: string) {
  const state = useTree();
  useEffect(() => {
    if (!state.ready && nodeId === '') return undefined;
    tree.markVisible(nodeId, true);
    if (nodeId) void tree.loadBranch(nodeId);
    return () => tree.markVisible(nodeId, false);
  }, [nodeId, state.key, state.ready]);
  return state.branches[branchKey(nodeId)] || emptyBranch();
}

/** 打开会话前的已读标记（B1-67：可见内容自动标为已读）。不消耗运行中的结果。 */
export function markOpenedRead(row: Row | null | undefined) {
  if (!row || !row.activityUnread || isRunningRow(row)) return;
  void tree.markRead([row]).catch(() => undefined);
}
