/**
 * 会话列表的界面状态（手机列表与平板侧栏共用）：搜索词、筛选、排序、下拉刷新、长按菜单、相对时间的“现在”。
 * 菜单项这一轮只做 UI：点了关菜单并 toast，不调用接口。
 */
import { Archive, Pencil, Pin, PinOff, Trash2 } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ConversationSummary } from '../../data/session';
import { useSession } from '../../data/session';
import type { MenuAnchor, MenuItem } from '../ActionMenu';
import { tap } from '../primitives';
import { showToast } from '../Toast';
import { type Filter, type SortKey, countsOf, matchesFilter, matchesQuery } from './listModel';

/** 每 30 秒刷新一次“现在”，让“刚刚 / 运行中 · N 分钟”保持新鲜。 */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useConversationList() {
  const session = useSession();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [sort, setSort] = useState<SortKey>('activity');
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<{ item: ConversationSummary; anchor: MenuAnchor } | null>(null);
  const now = useNow();

  const all = session.conversations;
  const counts = useMemo(() => countsOf(all), [all]);
  const visible = useMemo(() => all.filter((c) => !c.archived && matchesFilter(c, filter) && matchesQuery(c, query)), [all, filter, query]);

  // 筛选的目录消失（例如刷新后）时回到“全部”
  useEffect(() => {
    if (filter.kind === 'folder' && !counts.folders.some((f) => f.name === filter.name)) setFilter({ kind: 'all' });
  }, [counts, filter]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await session.refresh();
    } catch {
      showToast('刷新失败，请检查网络');
    } finally {
      setRefreshing(false);
    }
  }, [session.refresh]);

  const openMenu = useCallback((item: ConversationSummary, anchor: MenuAnchor) => {
    tap('medium');
    setMenu({ item, anchor });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const menuItems: MenuItem[] = useMemo(() => {
    if (!menu) return [];
    const { item } = menu;
    const title = item.title || '新会话';
    return [
      { key: 'pin', label: item.pinned ? '取消置顶' : '置顶', icon: item.pinned ? PinOff : Pin, onPress: () => showToast(`${item.pinned ? '取消置顶' : '置顶'}「${title}」：即将支持`) },
      { key: 'rename', label: '重命名', icon: Pencil, onPress: () => showToast('重命名：即将支持') },
      { key: 'archive', label: '归档', icon: Archive, onPress: () => showToast(`归档「${title}」：即将支持`) },
      { key: 'delete', label: '删除', icon: Trash2, destructive: true, separatorBefore: true, onPress: () => showToast('删除：即将支持') },
    ];
  }, [menu]);

  return { session, all, visible, counts, query, setQuery, filter, setFilter, sort, setSort, refreshing, refresh, menu, menuItems, openMenu, closeMenu, now };
}
