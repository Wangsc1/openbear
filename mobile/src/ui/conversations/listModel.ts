/**
 * 会话列表的纯逻辑：状态归类、筛选、分组、相对时间。不依赖 React Native，便于单测。
 * 字段语义与真实后端一致（conversation_tree.py / activity.py / conversations.py）：
 * - 需要处理：pendingInteractionCount > 0 或 activityState === 'waiting'（后端 running && needs_attention）；
 * - 运行中：running 且不是等待回答；
 * - 失败：activityState === 'failed' 或 activityResult.status === 'failed'；
 * - 未读：activityUnread。
 */
import type { ConversationSummary } from '../../data/session';

export type RowState = 'waiting' | 'running' | 'failed' | 'idle';

export const NO_FOLDER_PATH = '临时会话';

export function isWaiting(c: ConversationSummary): boolean {
  return Number(c.pendingInteractionCount || 0) > 0 || c.activityState === 'waiting';
}

export function isRunning(c: ConversationSummary): boolean {
  return !isWaiting(c) && (Boolean(c.running) || c.status === 'running' || c.activityState === 'running');
}

export function isFailed(c: ConversationSummary): boolean {
  return c.activityState === 'failed' || c.activityResult?.status === 'failed';
}

export function rowState(c: ConversationSummary): RowState {
  if (isWaiting(c)) return 'waiting';
  if (isRunning(c)) return 'running';
  if (isFailed(c)) return 'failed';
  return 'idle';
}

/** 最近活动时间（毫秒）。 */
export function activityMs(c: ConversationSummary): number {
  const sec = Number(c.lastConversationAt || 0) || Number(c.updatedAt || 0) || Number(c.createdAt || 0);
  return Math.max(sec * 1000, Number(c.latestUpdatedAtMs || 0));
}

export function folderName(c: ConversationSummary): string {
  const p = String(c.path || '').trim();
  return p || NO_FOLDER_PATH;
}

export function operationCountOf(c: ConversationSummary): number {
  return Number(c.operationCount ?? c.benchOperationCount ?? 0) || 0;
}

/** 运行时长文字：“运行中 · 6 分钟”。 */
export function runningLabel(c: ConversationSummary, now = Date.now()): string {
  const started = Number(c.activeStartedAtMs || 0);
  if (started > 0) {
    const minutes = Math.max(1, Math.round((now - started) / 60000));
    if (minutes >= 60) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return `运行中 · ${h} 小时${m ? ` ${m} 分钟` : ''}`;
    }
    return `运行中 · ${minutes} 分钟`;
  }
  const status = String(c.currentStatus || '');
  return status.startsWith('运行中') ? status : '运行中';
}

/** 摘要：优先 preview，没有就显示 currentStatus（“就绪”这种无信息量的不显示）。 */
export function previewOf(c: ConversationSummary): string {
  const preview = String(c.preview || '').trim();
  if (preview) return preview.replace(/\s+/g, ' ');
  const status = String(c.currentStatus || '').trim();
  return status && status !== '就绪' ? status : '';
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 列表右侧时间：刚刚 / 09:12 / 昨天 / 周一 / 10月8日 / 2025/10/8。 */
export function formatListTime(ms: number, now = Date.now()): string {
  if (!ms) return '';
  if (now - ms < 2 * 60 * 1000 && now >= ms - 60 * 1000) return '刚刚';
  const today = startOfDay(now);
  const day = startOfDay(ms);
  const d = new Date(ms);
  if (day === today) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const diffDays = Math.round((today - day) / 86400000);
  if (diffDays === 1) return '昨天';
  if (diffDays > 1 && diffDays < 7) return WEEKDAYS[d.getDay()];
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export type Filter = { kind: 'all' } | { kind: 'running' } | { kind: 'waiting' } | { kind: 'folder'; name: string };
export type SortKey = 'activity' | 'created';

export function filterKey(f: Filter): string {
  return f.kind === 'folder' ? `folder:${f.name}` : f.kind;
}

export function matchesFilter(c: ConversationSummary, f: Filter): boolean {
  switch (f.kind) {
    case 'running':
      return isRunning(c);
    case 'waiting':
      return isWaiting(c);
    case 'folder':
      return folderName(c) === f.name;
    default:
      return true;
  }
}

export function matchesQuery(c: ConversationSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return String(c.title || '').toLowerCase().includes(q) || folderName(c).toLowerCase().includes(q);
}

export type Counts = { running: number; waiting: number; folders: { name: string; count: number }[] };

/** 筛选 Chip 的计数；目录按最近活动排序，“临时会话”不作为目录 Chip。 */
export function countsOf(items: ConversationSummary[]): Counts {
  const folders = new Map<string, { count: number; latest: number }>();
  let running = 0;
  let waiting = 0;
  for (const c of items) {
    if (c.archived) continue;
    if (isRunning(c)) running += 1;
    if (isWaiting(c)) waiting += 1;
    const name = folderName(c);
    if (name === NO_FOLDER_PATH) continue;
    const prev = folders.get(name) || { count: 0, latest: 0 };
    folders.set(name, { count: prev.count + 1, latest: Math.max(prev.latest, activityMs(c)) });
  }
  return {
    running,
    waiting,
    folders: [...folders.entries()].sort((a, b) => b[1].latest - a[1].latest).map(([name, v]) => ({ name, count: v.count })),
  };
}

export type Section = { key: string; title: string; icon?: 'pin' | 'folder' | 'alert'; count?: number; items: ConversationSummary[] };

function sorter(sort: SortKey) {
  return (a: ConversationSummary, b: ConversationSummary) =>
    sort === 'created' ? Number(b.createdAt || 0) - Number(a.createdAt || 0) || activityMs(b) - activityMs(a) : activityMs(b) - activityMs(a);
}

/**
 * 手机列表分组：需要你处理 → 置顶 → 今天 → 昨天 → 更早。每条只出现一次（按顺序取第一个命中的组）。
 */
export function phoneSections(items: ConversationSummary[], sort: SortKey = 'activity', now = Date.now()): Section[] {
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  const groups: Record<string, ConversationSummary[]> = { attention: [], pinned: [], today: [], yesterday: [], earlier: [] };
  for (const c of [...items].filter((x) => !x.archived).sort(sorter(sort))) {
    const at = activityMs(c);
    if (isWaiting(c)) groups.attention.push(c);
    else if (c.pinned) groups.pinned.push(c);
    else if (at >= today) groups.today.push(c);
    else if (at >= yesterday) groups.yesterday.push(c);
    else groups.earlier.push(c);
  }
  const defs: [string, string, Section['icon']][] = [
    ['attention', '需要你处理', 'alert'],
    ['pinned', '置顶', 'pin'],
    ['today', '今天', undefined],
    ['yesterday', '昨天', undefined],
    ['earlier', '更早', undefined],
  ];
  return defs.filter(([key]) => groups[key].length).map(([key, title, icon]) => ({ key, title, icon, items: groups[key] }));
}

/**
 * 平板侧栏分组：需要你处理 → 置顶 → 各目录（按最近活动）→ 临时会话。
 */
export function sidebarSections(items: ConversationSummary[], sort: SortKey = 'activity'): Section[] {
  const attention: ConversationSummary[] = [];
  const pinned: ConversationSummary[] = [];
  const folders = new Map<string, ConversationSummary[]>();
  for (const c of [...items].filter((x) => !x.archived).sort(sorter(sort))) {
    if (isWaiting(c)) attention.push(c);
    else if (c.pinned) pinned.push(c);
    else {
      const name = folderName(c);
      folders.set(name, [...(folders.get(name) || []), c]);
    }
  }
  const sections: Section[] = [];
  if (attention.length) sections.push({ key: 'attention', title: '需要你处理', icon: 'alert', items: attention });
  if (pinned.length) sections.push({ key: 'pinned', title: '置顶', icon: 'pin', items: pinned });
  const folderEntries = [...folders.entries()].sort((a, b) => {
    if (a[0] === NO_FOLDER_PATH) return 1;
    if (b[0] === NO_FOLDER_PATH) return -1;
    return activityMs(b[1][0]) - activityMs(a[1][0]);
  });
  for (const [name, list] of folderEntries) sections.push({ key: `folder:${name}`, title: name, icon: 'folder', count: list.length, items: list });
  return sections;
}
