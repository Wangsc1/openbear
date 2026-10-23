/**
 * 整棵树搜索（B1-11～B1-13，Web ConversationTree.runSearch）：
 * GET /api/conversation-tree/search?q&limit=50&cursor[&archiveUnlocked=1]；输入防抖 260ms；分页“更多搜索结果”；
 * 只有展开过“已归档”（archiveUnlocked）后才允许打开“包含已归档”。旧请求的结果一律丢弃。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Row } from './treeModel';
import { apiErrorText, tree, useTree } from './treeStore';

export function useTreeSearch() {
  const state = useTree();
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  const includeArchived = archived && state.archiveUnlocked;
  const text = query.trim();

  const run = useCallback(
    async (append: boolean, from = '') => {
      const api = tree.api;
      if (!api || !text) return;
      const gen = append ? generation.current : ++generation.current;
      setLoading(true);
      setError('');
      try {
        const data: any = await api.conversationTreeSearch({ q: text, limit: 50, ...(append && from ? { cursor: from } : {}), ...(includeArchived ? { archiveUnlocked: 1 } : {}) });
        if (gen !== generation.current) return;
        const incoming = (data.items || []).map((row: Row) => ({ ...row, search: true }));
        setRows((current) => (append ? [...current, ...incoming] : incoming));
        setCursor(String(data.nextCursor || ''));
        setHasMore(Boolean(data.hasMore));
      } catch (e) {
        if (gen === generation.current) setError(apiErrorText(e));
      } finally {
        if (gen === generation.current) setLoading(false);
      }
    },
    [text, includeArchived],
  );

  useEffect(() => {
    generation.current += 1;
    setRows([]);
    setCursor('');
    setHasMore(false);
    setError('');
    if (!text) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const timer = setTimeout(() => void run(false), 260);
    return () => clearTimeout(timer);
  }, [text, includeArchived, state.key]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    query,
    setQuery,
    active: Boolean(text),
    rows,
    loading,
    error,
    hasMore,
    archived: includeArchived,
    canArchive: state.archiveUnlocked,
    setArchived,
    more: () => (hasMore && !loading && cursor ? void run(true, cursor) : undefined),
    retry: () => void run(false),
  };
}
