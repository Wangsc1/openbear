/**
 * 会话树纯逻辑（不依赖 React Native，便于单测）：
 * - 实时状态索引：把 treeStatus（全局 WS / GET /api/conversation-tree/status）与本地已读回执合成查找表；
 * - 行的实时覆盖：与 Web ConversationTree.statusAdjustedRow 相同的规则；
 * - “最近”视图的相对时间标签（Web recentLabel）、来源图标、目录路径/面包屑；
 * - 移动目标合法性（自身与子孙禁用）、批量移动影响合计、菜单可用性。
 */
import {
  activityLabel,
  activityState,
  applyActivityReadVersions,
  compareTreeItems,
  isActivityWaiting,
  pendingConversationRows,
  pendingFolderCounts,
  treeItemId,
} from './webTree';

export type Row = Record<string, any>;
export type FolderLite = { folderId: string; parentId: string; name: string; path: string };
export type Branch = { items: Row[]; nextCursor: string; hasMore: boolean; loading: boolean; error: string; loaded: boolean; pages: number };

/** 系统节点 id（与 Web 一致：临时会话属性用 __temporary 作为 folderId）。 */
export const TEMP = '__temporary';
export const ARCHIVE = '__archive';
export const PAGE_SIZE = 50;

export function emptyBranch(): Branch {
  return { items: [], nextCursor: '', hasMore: false, loading: false, error: '', loaded: false, pages: 0 };
}

/** 节点 id -> 分支 key 与 children 接口参数。 */
export function branchKey(nodeId: string): string {
  return nodeId === TEMP ? 'temporary' : nodeId === ARCHIVE ? 'archive' : `folder:${nodeId}`;
}
export function branchParams(nodeId: string): Record<string, string> {
  return nodeId === TEMP ? { systemNode: 'temporary' } : nodeId === ARCHIVE ? { systemNode: 'archive' } : { parentId: nodeId };
}

export function rowId(row: Row): string {
  return treeItemId(row);
}

export function mergeRows(existing: Row[] = [], incoming: Row[] = []): Row[] {
  const merged = new Map(existing.map((row) => [`${row.kind}:${rowId(row)}`, row]));
  for (const row of incoming) if (rowId(row)) merged.set(`${row.kind}:${rowId(row)}`, row);
  return [...merged.values()].sort(compareTreeItems);
}

export function isRunningRow(row: Row | null | undefined): boolean {
  return Boolean(row?.running || row?.status === 'running');
}

export function hasMessages(row: Row): boolean {
  return Number(row?.lastConversationAt || row?.lastInteractionAtMs || row?.messageCount || 0) > 0;
}

export type StatusIndex = {
  raw: Row | null;
  running: Map<string, Row>;
  activity: Map<string, Row>;
  recent: Map<string, Row>;
  pending: Row[];
  unread: Row[];
  runningCount: number;
  folderRunning: Record<string, number>;
  folderCounts: Record<string, number>;
  /** 每个目录（含祖先）下待处理会话数；临时会话用 __temporary */
  waitingByFolder: Map<string, number>;
};

/** 合成实时状态索引（Web applyStatus + recentUnreadRows + recentRunningCount 的同等计算）。 */
export function indexStatus(status: Row | null, readVersions: Map<string, number>, folders: FolderLite[] = []): StatusIndex {
  const data = status ? applyActivityReadVersions(status, readVersions) : null;
  const activityItems: Row[] = (data?.activityItems || data?.items || []).filter((item: Row) => !item.archived && (item.running || item.activityUnread || isActivityWaiting(item)));
  const pending = data ? pendingConversationRows(data) : [];
  const recentItems: Row[] = (data?.recentItems || []).filter((item: Row) => item?.conversationUuid && !item.archived && !item.local);
  const running = new Map<string, Row>((data?.items || []).map((item: Row) => [item.conversationUuid, item]));
  const activity = new Map<string, Row>([...activityItems, ...pending].map((item) => [item.conversationUuid, item]));
  const recent = new Map<string, Row>(recentItems.map((item) => [item.conversationUuid, item]));
  const rows = new Map<string, Row>();
  for (const item of [...recentItems, ...activityItems]) rows.set(item.conversationUuid, { ...(rows.get(item.conversationUuid) || {}), ...item });
  const live = [...rows.values()];
  const unread = live.filter((row) => row.activityUnread && !isRunningRow(row));
  const runningCount = live.filter((row) => !row.activityPending?.length && activityState(row) === 'running').length;
  return {
    raw: data,
    running,
    activity,
    recent,
    pending,
    unread,
    runningCount,
    folderRunning: { ...(data?.folderRunningCounts || {}) },
    folderCounts: { ...(data?.folderConversationCounts || {}) },
    waitingByFolder: pendingFolderCounts(pending, folders),
  };
}

/** 行的实时覆盖（Web statusAdjustedRow）：会话叠加运行/活动状态，目录叠加运行数与会话数。 */
export function liveRow(row: Row, index: StatusIndex): Row {
  if (!index.raw || !row) return row;
  if (row.kind === 'folder') {
    const count = index.folderCounts[row.folderId];
    return { ...row, runningDescendantCount: Number(index.folderRunning[row.folderId] || 0), ...(Number.isFinite(count) ? { conversationCount: count } : {}) };
  }
  if (row.kind !== 'conversation' || row.archived) return row;
  const status = index.running.get(row.conversationUuid);
  const act = index.activity.get(row.conversationUuid);
  return {
    ...row,
    ...(status || {}),
    ...(act || { activityUnread: false, activityState: '', activityPending: [] }),
    title: row.title || status?.title || act?.title,
    running: Boolean(status),
    status: status ? 'running' : 'idle',
  };
}

/** 待处理数（目录行、临时会话节点）。 */
export function waitingCountFor(row: Row, index: StatusIndex): number {
  const id = row.kind === 'system' ? row.id : row.folderId;
  return index.waitingByFolder.get(id) || 0;
}

/** “最近”视图的状态文字（Web ConversationTree.recentLabel）。 */
export function recentLabel(row: Row, now = Date.now()): string {
  const state = row.activityPending?.length ? 'waiting' : activityState({ ...row, readWhileSelected: false });
  const label = activityLabel({ ...row, activityState: state, readWhileSelected: false });
  if (state === 'waiting' || state === 'running') return label;
  const settled = ['completed', 'idle', 'read'].includes(state);
  if (row.activityUnread) return settled ? '完成待查看' : `${label}待查看`;
  if (!settled) return label;
  const at = Number(row.lastInteractionAtMs || row.activityAtMs || 0);
  if (!at) return activityLabel(row);
  const elapsed = Math.max(0, now - at);
  return elapsed < 60000 ? '刚刚' : elapsed < 3600000 ? `${Math.floor(elapsed / 60000)} 分钟前` : elapsed < 86400000 ? `${Math.floor(elapsed / 3600000)} 小时前` : `${Math.floor(elapsed / 86400000)} 天前`;
}

/** “最近”视图右侧的时间：只要相对时间（状态由胶囊表达，避免同一状态显示两次）。 */
export function recentTime(row: Row, now = Date.now()): string {
  const at = interactionAt(row);
  if (!at) return '';
  return recentLabel({ ...row, activityUnread: false, activityPending: [], running: false, activityState: 'idle', activityResult: {}, lastInteractionAtMs: at }, now);
}

/** 行上的状态胶囊：等待处理（带具体动作）、运行中、命名中、X 待查看。 */
export type RowBadge = { tone: 'wait' | 'run' | 'error' | 'neutral'; label: string } | null;
export function rowBadge(row: Row, generating = false): RowBadge {
  if (isActivityWaiting(row)) return { tone: 'wait', label: activityLabel(row) };
  if (generating) return { tone: 'neutral', label: '命名中' };
  if (isRunningRow(row)) return { tone: 'run', label: '运行中' };
  if (row.activityUnread) {
    const state = activityState(row);
    if (['failed', 'error', 'interrupted', 'partial', 'cancelled'].includes(state)) return { tone: 'error', label: `${activityLabel(row)}待查看` };
    return { tone: 'neutral', label: '完成待查看' };
  }
  const state = String(row.activityState || row.activityResult?.status || '');
  if (state === 'failed' || state === 'error') return { tone: 'error', label: '失败' };
  return null;
}

export type Origin = 'deployment' | 'maintenance' | 'cron' | 'webhook' | 'user';
export const ORIGIN_LABEL: Record<Origin, string> = { deployment: '实例部署会话', maintenance: '实例维护会话', cron: '定时任务创建', webhook: '触发器创建', user: '' };
export function originOf(row: Row): Origin {
  const value = String(row?.origin || row?.originKind || row?.origin_kind || '');
  return (['deployment', 'maintenance', 'cron', 'webhook'] as const).includes(value as any) ? (value as Origin) : 'user';
}

/** 最近交互时间（毫秒）：人工交互优先，其次活动结果时间、会话更新时间。 */
export function interactionAt(row: Row): number {
  const sec = Number(row.lastConversationAt || 0) || Number(row.updatedAt || 0) || Number(row.createdAt || 0);
  return Math.max(Number(row.lastInteractionAtMs || 0), Number(row.activityAtMs || 0), sec * 1000);
}

export function folderMap(folders: FolderLite[]): Map<string, FolderLite> {
  return new Map(folders.map((f) => [f.folderId, f]));
}

export function pathOf(folderId: string, folders: Map<string, FolderLite>): string {
  if (!folderId) return '临时会话';
  return folders.get(folderId)?.path || '';
}

/** 根到自身的目录 id 链。 */
export function ancestorIds(folderId: string, folders: Map<string, FolderLite>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current = String(folderId || '');
  while (current && !seen.has(current)) {
    seen.add(current);
    out.unshift(current);
    current = folders.get(current)?.parentId || '';
  }
  return out;
}

export function crumbsFor(folderId: string, folders: Map<string, FolderLite>): { id: string; name: string }[] {
  if (folderId === TEMP) return [{ id: TEMP, name: '临时会话' }];
  if (folderId === ARCHIVE) return [{ id: ARCHIVE, name: '已归档' }];
  return ancestorIds(folderId, folders).map((id) => ({ id, name: folders.get(id)?.name || '目录' }));
}

export function descendantIds(folderId: string, folders: FolderLite[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const f of folders) children.set(f.parentId, [...(children.get(f.parentId) || []), f.folderId]);
  const out = new Set<string>([folderId]);
  const queue = [folderId];
  while (queue.length) {
    for (const child of children.get(queue.shift() as string) || []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/** 移动目标里禁用的目录：所选目录自身及其子孙（Web invalidMoveTarget，扩展到多选）。 */
export function blockedTargets(sources: Row[], folders: FolderLite[]): Set<string> {
  const blocked = new Set<string>();
  for (const row of sources) if (row.kind === 'folder') for (const id of descendantIds(row.folderId, folders)) blocked.add(id);
  return blocked;
}

/** 按完整路径过滤目录（不区分大小写）。 */
export function matchFolders(folders: FolderLite[], query: string): FolderLite[] {
  const q = query.trim().toLowerCase();
  return folders.filter((f) => !q || f.path.toLowerCase().includes(q));
}

export function folderDepth(folder: FolderLite): number {
  return Math.max(0, folder.path.split(' / ').length - 1);
}

export type Impact = { affectedCount: number; updatableCount: number; runningCount: number; archivedCount: number };
export function sumImpacts(list: Partial<Impact>[]): Impact {
  return list.reduce<Impact>(
    (acc, item) => ({
      affectedCount: acc.affectedCount + Number(item?.affectedCount || 0),
      updatableCount: acc.updatableCount + Number(item?.updatableCount || 0),
      runningCount: acc.runningCount + Number(item?.runningCount || 0),
      archivedCount: acc.archivedCount + Number(item?.archivedCount || 0),
    }),
    { affectedCount: 0, updatableCount: 0, runningCount: 0, archivedCount: 0 },
  );
}

/** 会话菜单各项是否可用（Web 菜单的 :disabled 条件）。 */
export function conversationAbilities(row: Row, generating = false) {
  const local = Boolean(row.local) || String(row.conversationUuid || '').startsWith('local:');
  const running = isRunningRow(row);
  return {
    local,
    running,
    canGenerateTitle: !local && !running && hasMessages(row) && !generating,
    generateHint: local ? '草稿' : running ? '当前轮完成后再生成' : !hasMessages(row) ? '还没有可用于命名的内容' : generating ? '正在生成…' : '',
    canRename: !local,
    canDuplicate: !local && !running,
    canPin: !local,
    canMove: !local,
    canUpdatePrompt: !local && !running,
    canArchive: !local,
    canDelete: !running,
    canMarkRead: Boolean(row.activityUnread) && Number(row.activityVersion) > 0,
  };
}

/** 批量操作可用性：目录只能批量移动；运行中的会话不能删除。 */
export function selectionAbilities(rows: Row[]) {
  const folders = rows.filter((r) => r.kind === 'folder');
  const conversations = rows.filter((r) => r.kind === 'conversation');
  return {
    count: rows.length,
    canMove: rows.length > 0,
    canArchive: conversations.length > 0 && folders.length === 0,
    canDelete: conversations.length > 0 && folders.length === 0 && !conversations.some(isRunningRow),
    hasFolders: folders.length > 0,
    runningCount: conversations.filter(isRunningRow).length,
    allArchived: conversations.length > 0 && conversations.every((r) => r.archived),
  };
}

/** 待处理面板里每个事项的标签（Web PendingConversations.requestLabel）。 */
export function pendingRequestLabel(row: Row, request: Row): string {
  return activityLabel({ ...row, activityPending: [request] });
}

/**
 * “最近”视图（B1-15）：全部活跃会话叠加实时状态，按最近交互排序，带目录路径；
 * 分组：需要你处理 → 今天 → 昨天 → 更早（与原手机列表一致的分组表达）。
 */
export type RecentSection = { key: string; title: string; rows: Row[] };
export function recentSections(conversations: Row[], index: StatusIndex, folders: Map<string, FolderLite>, now = Date.now()): RecentSection[] {
  const byId = new Map<string, Row>();
  for (const c of conversations) if (c?.conversationUuid && !c.archived) byId.set(c.conversationUuid, { kind: 'conversation', ...c });
  for (const r of [...index.recent.values(), ...index.activity.values()]) if (r?.conversationUuid && !r.archived) byId.set(r.conversationUuid, { ...(byId.get(r.conversationUuid) || {}), ...r, kind: 'conversation' });
  const rows: Row[] = [...byId.values()].map((row) => {
    const live = liveRow(row, index);
    const recent = index.recent.get(row.conversationUuid);
    return { ...live, lastInteractionAtMs: Number(recent?.lastInteractionAtMs || row.lastInteractionAtMs || 0), path: row.path || pathOf(String(row.folderId || ''), folders) || '所属目录' };
  });
  rows.sort((a, b) => interactionAt(b) - interactionAt(a) || String(a.conversationUuid).localeCompare(String(b.conversationUuid)));
  const day = new Date(now);
  const today = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const groups: Record<string, Row[]> = { attention: [], today: [], yesterday: [], earlier: [] };
  for (const row of rows) {
    const at = interactionAt(row);
    if (isActivityWaiting(row)) groups.attention.push(row);
    else if (at >= today) groups.today.push(row);
    else if (at >= today - 86400000) groups.yesterday.push(row);
    else groups.earlier.push(row);
  }
  const titles: Record<string, string> = { attention: '需要你处理', today: '今天', yesterday: '昨天', earlier: '更早' };
  return Object.keys(groups).filter((k) => groups[k].length).map((key) => ({ key, title: titles[key], rows: groups[key] }));
}

/** 目录层级的显示行：子目录在前、会话在后（服务端已排序），草稿行插到本级会话里；系统节点只在根级出现。 */
export function levelRows(nodeId: string, rootFolders: Row[], branch: Branch, counts: { temporary: number; archived: number }, draft: Row | null, index: StatusIndex): Row[] {
  if (nodeId === '') {
    return [
      ...rootFolders.map((row) => liveRow(row, index)),
      { kind: 'system', id: TEMP, name: '临时会话', count: index.raw && Number.isFinite(index.folderCounts['']) ? index.folderCounts[''] : counts.temporary },
      { kind: 'system', id: ARCHIVE, name: '已归档', count: counts.archived },
    ];
  }
  const items = branch.items.map((row) => liveRow(row, index));
  if (draft && !items.some((r) => r.conversationUuid === draft.conversationUuid)) return [...items, draft].sort(compareTreeItems);
  return items;
}

/** 平板缩进树的一行。 */
export type FlatRow = { key: string; depth: number; row: Row; inline?: 'more' | 'error' | 'empty'; node?: string };

/**
 * 平板缩进树的可见行（Web visibleRows）：根目录 → 展开的子目录与会话（递归）→ 临时会话 → 已归档。
 * 每个展开的分支后面跟“加载失败 / 此目录为空 / 加载更多”。缩进最多 7 级。
 */
export function flattenTree(rootFolders: Row[], branches: Record<string, Branch>, expanded: Set<string>, counts: { temporary: number; archived: number }, index: StatusIndex, draft: Row | null): FlatRow[] {
  const out: FlatRow[] = [];
  const inline = (node: string, depth: number, items: Row[]) => {
    const branch = branches[branchKey(node)] || emptyBranch();
    if (branch.error) out.push({ key: `error:${node}`, depth, row: { kind: 'error', id: `error:${node}` }, inline: 'error', node });
    else if (branch.loaded && !items.length) out.push({ key: `empty:${node}`, depth, row: { kind: 'empty', id: `empty:${node}`, parentId: node === TEMP ? '' : node, systemNode: node === TEMP ? 'temporary' : '' }, inline: 'empty', node });
    if (branch.hasMore) out.push({ key: `more:${node}`, depth, row: { kind: 'more', id: `more:${node}` }, inline: 'more', node });
  };
  const withDraft = (items: Row[], folderId: string) => (draft && String(draft.folderId || '') === folderId && !items.some((r) => r.conversationUuid === draft.conversationUuid) ? [...items, draft].sort(compareTreeItems) : items);
  const walk = (folders: Row[], depth: number, seen: Set<string>) => {
    for (const raw of folders) {
      const folder = liveRow(raw, index);
      out.push({ key: `folder:${folder.folderId}`, depth, row: folder });
      if (!expanded.has(folder.folderId) || seen.has(folder.folderId)) continue;
      const nextSeen = new Set(seen).add(folder.folderId);
      const branch = branches[branchKey(folder.folderId)] || emptyBranch();
      const items = withDraft(branch.items, folder.folderId);
      for (const child of items) {
        if (child.kind === 'folder') walk([child], depth + 1, nextSeen);
        else out.push({ key: `conversation:${child.conversationUuid}`, depth: depth + 1, row: liveRow(child, index) });
      }
      inline(folder.folderId, depth + 1, items);
    }
  };
  walk(rootFolders, 0, new Set());
  for (const [id, name, count] of [
    [TEMP, '临时会话', index.raw && Number.isFinite(index.folderCounts['']) ? index.folderCounts[''] : counts.temporary],
    [ARCHIVE, '已归档', counts.archived],
  ] as const) {
    out.push({ key: `system:${id}`, depth: 0, row: { kind: 'system', id, name, count, systemNode: id === TEMP ? 'temporary' : 'archive' } });
    if (!expanded.has(id)) continue;
    const branch = branches[branchKey(id)] || emptyBranch();
    const items = id === TEMP ? withDraft(branch.items, '') : branch.items;
    for (const child of items) out.push({ key: `conversation:${child.conversationUuid}`, depth: 1, row: liveRow(child, index) });
    inline(id, 1, items);
  }
  return out;
}

/** “新会话草稿属于别的目录”判断（B1-01）：返回 true 时需要询问是否更改草稿归属。 */
export function draftNeedsReassign(draft: { folderId: string } | null, target: string): boolean {
  return Boolean(draft) && String(draft?.folderId || '') !== String(target || '');
}
