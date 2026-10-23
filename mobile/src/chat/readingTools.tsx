/**
 * 阅读工具（B2-70～B2-75、B2-89～B2-93）与对话页“更多”菜单的接入点。
 *
 * 约定（scope-b2 接入点）：useReadingTools({ uuid, store, listRef, rows, ... }) 返回
 *   { items: ConversationMenuItem[], panels: ReactNode, ...控制方法 }
 * b4 在“更多”菜单里合并 items；panels 渲染在对话页根部（底部 Sheet）。
 *
 * - 会话内搜索：GET /search?q&includeHidden&cursor（240ms 去抖，分页“加载更多”）；隐藏结果只能单独预览原文
 *   （GET /hidden-messages/{opId}，“仅本机预览 · 未恢复显示”）；点结果 -> 定位（GET /operations/{opId}/window）；
 * - 轮次导航：3 轮以上出现；Sheet 列出各轮（当前/总数，打开时定位当前轮，运行中标记，超过 8 轮可筛选），点按跳转；
 * - 隐藏内容抽屉：列表（类型、时间）、查看原文（本机预览，含附件）、恢复显示、全部恢复（确认）；
 * - 消息操作菜单（长按）：预览正在操作的消息；隐藏本轮回复 / 只隐藏这条 / 选择多条；
 * - 多选：底部条“已选 N 条 / 取消 / 隐藏所选”；隐藏后撤销条“已隐藏 N 条 · 撤销”（6 秒后自动消失）。
 */
import { ArrowDownToLine, Eye, EyeOff, ListTree, Lock, LockOpen, RotateCcw, Search, X } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image as RNImage, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import type { ConversationStore, ConversationSnapshot } from '../data/conversationStore';
import type { ChatRow } from '../data/rows';
import { ConfirmSheet } from '../ui/Form';
import { Sheet, SheetScroll } from '../ui/Sheet';
import { showToast } from '../ui/Toast';
import { SearchField } from '../ui/conversations/ListControls';
import { Icon, Press, tap } from '../ui/primitives';
import { elevation, type Theme } from '../ui/theme';
import { apiError, fullTime, useChatApi } from './chatApi';
import type { ChatListHandle } from './ChatList';
import type { ConversationMenuItem } from './conversationTools';
import { enrichedRenderer } from './markdown/EnrichedBody';
import { DRAWER_LABELS, hiddenPreviewText, rowTargetId, visibilityTargetPreview } from './visibility';

export type ReadingToolsContext = {
  uuid: string;
  /** 会话层尚未就绪（深链冷启动、登录恢复中）时为 undefined */
  store: ConversationStore | undefined;
  snapshot: ConversationSnapshot | null;
  listRef: React.RefObject<ChatListHandle | null>;
  /** 展示层行（与列表一致，用于定位下标） */
  rows: ChatRow[];
  theme: Theme;
  followEnd: boolean;
  setFollowEnd(v: boolean): void;
  /** 当前可见的轮次 key（列表 onViewableItemsChanged 得到） */
  currentTurnKey: string;
  baseUrl: string;
  headers: Record<string, string>;
};

export type SeekState = { locating: boolean; active: boolean };

export function useReadingTools(ctx: ReadingToolsContext) {
  const { uuid, snapshot, listRef, rows, theme } = ctx;
  // 未就绪时用一个什么也不做的占位，保证 hooks 顺序不变
  const store = (ctx.store || NULL_STORE) as ConversationStore;
  const api = useChatApi();
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [menuRow, setMenuRow] = useState<ChatRow | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [undoIds, setUndoIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [seek, setSeek] = useState<SeekState>({ locating: false, active: false });
  const [highlight, setHighlight] = useState('');
  const pendingScroll = useRef<string>('');
  const visibility = snapshot?.visibility || { revision: -1, hiddenIds: [], items: [] };

  // ---- 隐藏 ----
  const mutate = useCallback(
    async (data: any): Promise<boolean> => {
      if (!api || busy) return false;
      setBusy(true);
      try {
        const result = await api.updateMessageVisibility(uuid, data);
        store.applyVisibility(result?.visibility);
        if (data.hidden) {
          setUndoIds((data.opIds || []).filter((id: string) => store.isHidden(id)));
          setSelecting(false);
          setSelected(new Set());
        }
        return true;
      } catch (error) {
        showToast(apiError(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, busy, store, uuid],
  );
  const hide = useCallback((ids: string[]) => mutate({ opIds: [...new Set(ids.filter(Boolean))], hidden: true }), [mutate]);
  const restore = useCallback((ids: string[]) => mutate({ opIds: ids, hidden: false }), [mutate]);
  useEffect(() => {
    if (!undoIds.length) return undefined;
    const t = setTimeout(() => setUndoIds([]), 6000);
    return () => clearTimeout(t);
  }, [undoIds]);
  useEffect(() => {
    if (!api || !uuid) return;
    // 打开会话时确保有最新的隐藏状态（state 接口已带；这里兜底读取一次，用于抽屉条目）
    if (!ctx.store) return;
    api.messageVisibility(uuid).then((r: any) => store.applyVisibility(r?.visibility)).catch(() => undefined);
  }, [api, uuid, store]); // eslint-disable-line react-hooks/exhaustive-deps

  const hideTurnReply = useCallback((turnKey: string) => {
    const targets = store.assistantTargets(turnKey);
    if (!targets.length) {
      showToast('这一轮没有可隐藏的回复');
      return;
    }
    void hide(targets);
  }, [hide, store]);

  const toggleSelect = useCallback((row: ChatRow) => {
    const id = rowTargetId(row);
    if (!id || !store.canTargetVisibility(id)) return;
    tap('select');
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [store]);

  const openMessageMenu = useCallback((row: ChatRow) => {
    const id = rowTargetId(row);
    if (!id || !store.canTargetVisibility(id) || store.isHidden(id)) return;
    setMenuRow(row);
  }, [store]);

  // ---- 定位 ----
  const scrollToOp = useCallback((opId: string, animated = true) => {
    const index = rows.findIndex((row: any) => row.opId === opId || row.messageId === opId);
    if (index < 0) return false;
    listRef.current?.scrollToIndex(index, animated, 0.3);
    setHighlight(opId);
    setTimeout(() => setHighlight(''), 2600);
    return true;
  }, [rows, listRef]);

  // 行变化后完成挂起的定位（窗口并入后再滚动）
  useEffect(() => {
    if (!pendingScroll.current) return;
    const id = pendingScroll.current;
    const t = setTimeout(() => {
      if (scrollToOp(id, false)) {
        pendingScroll.current = '';
        // 估算高度的列表第一次跳转可能不准：布局测量后再校正一次
        setTimeout(() => scrollToOp(id, false), 450);
      }
      setSeek((s) => ({ ...s, locating: false }));
    }, 160);
    return () => clearTimeout(t);
  }, [rows, scrollToOp]);

  const locate = useCallback(
    async (opId: string) => {
      if (!opId) return false;
      if (store.isHidden(opId)) {
        showToast('这条消息已隐藏，请在隐藏内容中预览');
        return false;
      }
      ctx.setFollowEnd(false);
      // 目标在折叠的工作块里：先展开，等行更新后再滚动
      if (store.expandWorkFor(opId)) {
        setSeek((s) => ({ locating: true, active: s.active || true }));
        pendingScroll.current = opId;
        return true;
      }
      if (rows.some((row: any) => row.opId === opId || row.messageId === opId)) {
        setSeek((s) => ({ locating: false, active: s.active || true }));
        return scrollToOp(opId);
      }
      if (!api) return false;
      setSeek({ locating: true, active: true });
      try {
        // 用户消息/回复：用 /operations/{opId}/window 取历史窗口（与 Web 搜索定位相同）
        if (/^(msg|assistant):/.test(opId)) {
          const data = await api.conversationOperationWindow(uuid, opId);
          const ok = store.mergeSeekWindow(data?.operations || [], Number(data?.nextBeforeDisplaySeq || 0), opId);
          if (!ok) throw new Error('目标消息已不存在');
        } else {
          // 其他操作（Agent、工具、交互）：后端 window 只支持消息，按页向上加载直到出现（最多 15 页）
          let found = Boolean(store.operation(opId));
          for (let i = 0; i < 30 && !found && store.snapshot.hasMoreBefore; i += 1) {
            await store.loadEarlier();
            found = Boolean(store.operation(opId));
          }
          if (!found) throw new Error('没有在历史记录中找到这条内容');
        }
        store.expandWorkFor(opId);
        pendingScroll.current = opId;
        return true;
      } catch (error) {
        showToast(apiError(error));
        setSeek({ locating: false, active: Boolean(store.snapshot.seekActive) });
        return false;
      }
    },
    [api, ctx, rows, scrollToOp, store, uuid],
  );

  const returnFromSeek = useCallback(() => {
    store.releaseSeekWindow();
    setSeek({ locating: false, active: false });
    ctx.setFollowEnd(true);
    setTimeout(() => listRef.current?.scrollToEnd(false), 80);
  }, [store, ctx, listRef]);

  const toLatest = useCallback(() => {
    store.releaseSeekWindow();
    setSeek({ locating: false, active: false });
    ctx.setFollowEnd(true);
    setTimeout(() => listRef.current?.scrollToEnd(true), 80);
  }, [store, ctx, listRef]);

  // ---- 菜单项（b4 合并） ----
  const turns = useMemo(() => store.turnList(), [store, snapshot?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const hiddenCount = visibility.items.length || visibility.hiddenIds.length;
  const items: ConversationMenuItem[] = [
    { key: 'search', label: '搜索此会话', icon: Search, testID: 'menu-search', onPress: () => setSearchOpen(true) },
    ...(turns.length >= 3 ? [{ key: 'turns', label: `对话导航 · ${turns.length} 轮`, icon: ListTree, testID: 'menu-turns', onPress: () => setNavOpen(true) }] : []),
    { key: 'hidden', label: hiddenCount ? `隐藏内容 · ${hiddenCount}` : '隐藏内容', icon: EyeOff, testID: 'menu-hidden', onPress: () => setHiddenOpen(true) },
    { key: 'select', label: '选择多条隐藏', icon: Eye, testID: 'menu-select', onPress: () => { setSelecting(true); setSelected(new Set()); } },
    {
      key: 'follow',
      label: ctx.followEnd ? '跟随最新消息：开' : '跟随最新消息：关',
      icon: ctx.followEnd ? Lock : LockOpen,
      testID: 'menu-follow',
      onPress: () => {
        const next = !ctx.followEnd;
        ctx.setFollowEnd(next);
        if (next) listRef.current?.scrollToEnd(true);
        showToast(next ? '已开启：新消息到来时自动滚到底部' : '已关闭：新消息不会打断阅读');
      },
    },
  ];

  const panels = (
    <>
      <SearchSheet theme={theme} uuid={uuid} open={searchOpen} onClose={() => setSearchOpen(false)} onLocate={(id) => { setSearchOpen(false); void locate(id); }} disabled={!snapshot || snapshot.loading} />
      <TurnNavSheet theme={theme} open={navOpen} onClose={() => setNavOpen(false)} turns={turns} currentKey={ctx.currentTurnKey} running={Boolean(snapshot?.running)}
        onPick={(t) => { setNavOpen(false); void locate(t.userOpId); }} />
      <HiddenDrawer theme={theme} uuid={uuid} open={hiddenOpen} onClose={() => setHiddenOpen(false)} items={visibility.items} busy={busy} onRestore={(ids) => void restore(ids)} onRestoreAll={() => void mutate({ restoreAll: true })} baseUrl={ctx.baseUrl} headers={ctx.headers} />
      <MessageMenu theme={theme} row={menuRow} store={store} onClose={() => setMenuRow(null)}
        onHideOne={(id) => { setMenuRow(null); void hide([id]); }}
        onHideTurn={(turnKey) => { setMenuRow(null); hideTurnReply(turnKey); }}
        onSelect={(id) => { setMenuRow(null); setSelecting(true); setSelected(new Set([id])); }} />
    </>
  );

  return {
    items,
    panels,
    selecting,
    selected,
    toggleSelect,
    openMessageMenu,
    hideTurnReply,
    locate,
    seek,
    highlight,
    returnFromSeek,
    toLatest,
    bar: (
      <VisibilityBar theme={theme} selecting={selecting} count={selected.size} busy={busy} undoCount={undoIds.length}
        onCancel={() => { setSelecting(false); setSelected(new Set()); }}
        onHide={() => void hide([...selected])}
        onUndo={() => { const ids = undoIds; setUndoIds([]); void restore(ids); }}
        onDismiss={() => setUndoIds([])} />
    ),
    seekBar: seek.active || snapshot?.seekActive ? (
      <View style={[styles.seekBar, { backgroundColor: theme.panel, borderColor: theme.border }, elevation(theme, 'pop')]} testID="seek-bar">
        {seek.locating ? <ActivityIndicator size="small" color={theme.muted} /> : null}
        <Text numberOfLines={1} style={[styles.barText, { color: theme.text }]}>{seek.locating ? '正在定位历史消息…' : '正在阅读搜索定位内容'}</Text>
        <Press onPress={returnFromSeek} style={styles.barBtn} accessibilityRole="button" testID="seek-return"><Text style={[styles.barBtnText, { color: theme.text }]}>返回原位置</Text></Press>
        <Press onPress={toLatest} style={[styles.barBtn, { backgroundColor: theme.button }]} accessibilityRole="button" testID="seek-latest">
          <Icon as={ArrowDownToLine} size={14} color={theme.buttonText} />
          <Text style={[styles.barBtnText, { color: theme.buttonText }]}>最新消息</Text>
        </Press>
      </View>
    ) : null,
  };
}

const NULL_STORE = {
  snapshot: { seekActive: false, running: false },
  turnList: () => [],
  isHidden: () => false,
  canTargetVisibility: () => false,
  applyVisibility: () => false,
  assistantTargets: () => [],
  expandWorkFor: () => false,
  mergeSeekWindow: () => false,
  releaseSeekWindow: () => undefined,
  operation: () => undefined,
  loadEarlier: async () => 0,
};

// ---------------------------------------------------------------- 搜索

function SearchSheet({ theme, uuid, open, onClose, onLocate, disabled }: { theme: Theme; uuid: string; open: boolean; onClose(): void; onLocate(opId: string): void; disabled?: boolean }) {
  const api = useChatApi();
  const [query, setQuery] = useState('');
  const [includeHidden, setIncludeHidden] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [cursor, setCursor] = useState<any>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [previewId, setPreviewId] = useState('');
  const [previewText, setPreviewText] = useState('');
  const gen = useRef(0);
  const search = useCallback(
    async (more: boolean) => {
      const q = query.trim();
      if (!q || !api || (more && !cursor)) return;
      const seq = ++gen.current;
      setSearching(true);
      setError('');
      try {
        const data = await api.conversationSearch(uuid, { q, includeHidden, ...(more ? { cursor } : {}) });
        if (seq !== gen.current) return;
        setItems((prev) => (more ? [...prev, ...(data.items || [])] : data.items || []));
        setCursor(data.nextCursor || null);
      } catch (e) {
        if (seq === gen.current) setError(apiError(e));
      } finally {
        if (seq === gen.current) setSearching(false);
      }
    },
    [api, uuid, query, includeHidden, cursor],
  );
  useEffect(() => {
    gen.current += 1;
    setItems([]);
    setCursor(null);
    setError('');
    setPreviewId('');
    setSearching(false);
    if (!query.trim()) return undefined;
    const t = setTimeout(() => void search(false), 240);
    return () => clearTimeout(t);
  }, [query, includeHidden]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = async (item: any) => {
    if (previewId === item.opId) {
      setPreviewId('');
      return;
    }
    setPreviewId(item.opId);
    setPreviewText('');
    try {
      const data = await api!.hiddenMessagePreview(uuid, item.opId);
      setPreviewText(String(data.operation?.payload?.text || '无文字内容'));
    } catch (e) {
      setPreviewText(apiError(e));
    }
  };
  return (
    <Sheet visible={open} onClose={onClose} title="搜索此会话" full testID="search-sheet">
      <View style={styles.sheetPad}>
        <SearchField theme={theme} value={query} onChange={setQuery} placeholder="搜索用户消息与模型回复" autoFocus testID="conv-inner-search" />
        <View style={styles.switchRow}>
          <Text style={[styles.body, { color: theme.text, flex: 1 }]}>包含隐藏消息 <Text style={[styles.small, { color: theme.muted }]}>隐藏内容仅可单独预览</Text></Text>
          <Switch value={includeHidden} onValueChange={setIncludeHidden} testID="search-include-hidden" trackColor={{ true: theme.button, false: theme.surfaceSoft }} />
        </View>
        <Text style={[styles.small, { color: theme.muted }]}>搜索当前会话全部历史 · 仅正文，不含工具日志和思考内容</Text>
      </View>
      <SheetScroll contentContainerStyle={styles.sheetBody} keyboardDismissMode="on-drag">
        {disabled ? <Text style={[styles.info, { color: theme.muted }]}>会话还在读取，稍后再搜索</Text> : error ? <Text style={[styles.info, { color: theme.danger }]}>{error}</Text> : !query.trim() ? <Text style={[styles.info, { color: theme.muted }]}>输入关键词开始搜索</Text> : !items.length && !searching ? <Text style={[styles.info, { color: theme.muted }]}>没有找到匹配消息</Text> : null}
        {items.map((item) => (
          <View key={item.opId} style={[styles.result, { borderTopColor: theme.line }]} testID="search-result">
            <View style={styles.resultMeta}>
              <Text style={[styles.small, { color: theme.subtle, fontWeight: '600' }]}>{item.type === 'user_message' ? '我的消息' : '模型回复'}</Text>
              <Text style={[styles.small, { color: theme.muted }]}>{fullTime(Number(item.createdAtMs || 0))}</Text>
            </View>
            {item.hidden ? (
              <>
                <Press onPress={() => void preview(item)} style={styles.resultLink} accessibilityRole="button" testID="search-hidden-preview">
                  <Icon as={EyeOff} size={15} color={theme.subtle} />
                  <Text style={[styles.body, { color: theme.text, flex: 1 }]}>隐藏消息 · {previewId === item.opId ? '收起预览' : '明确预览原文'}</Text>
                </Press>
                {previewId === item.opId ? (
                  <View style={[styles.preview, { borderColor: theme.border }]}>
                    <Text selectable style={[styles.body, { color: theme.text }]}>{previewText || '正在读取…'}</Text>
                    <Text style={[styles.small, { color: theme.muted, marginTop: 6 }]}>仅本机预览 · 未恢复显示</Text>
                  </View>
                ) : null}
              </>
            ) : (
              <Press onPress={() => onLocate(item.opId)} style={styles.resultLink} accessibilityRole="button" testID="search-result-link">
                <Text numberOfLines={4} style={[styles.body, { color: theme.text }]}>{item.snippet}</Text>
              </Press>
            )}
          </View>
        ))}
        {searching ? <ActivityIndicator style={{ marginVertical: 16 }} color={theme.muted} /> : null}
        {cursor && !searching ? (
          <Press onPress={() => void search(true)} style={[styles.more, { borderColor: theme.border }]} accessibilityRole="button" testID="search-more">
            <Text style={[styles.body, { color: theme.text }]}>加载更多结果</Text>
          </Press>
        ) : null}
      </SheetScroll>
    </Sheet>
  );
}

// ---------------------------------------------------------------- 轮次导航

function TurnNavSheet({ theme, open, onClose, turns, currentKey, running, onPick }: {
  theme: Theme; open: boolean; onClose(): void; turns: Array<{ key: string; title: string; userOpId: string }>; currentKey: string; running: boolean; onPick(t: { key: string; userOpId: string }): void;
}) {
  const [filter, setFilter] = useState('');
  const [scrollKey, setScrollKey] = useState(0);
  const currentIndex = Math.max(0, turns.findIndex((t) => t.key === currentKey));
  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return turns.map((t, i) => ({ ...t, index: i })).filter((t) => !q || t.title.toLowerCase().includes(q));
  }, [turns, filter]);
  useEffect(() => {
    if (!open) return undefined;
    setFilter('');
    setScrollKey((n) => n + 1);
    return undefined;
  }, [open]);
  return (
    <Sheet visible={open} onClose={onClose} title="对话导航" subtitle={`${currentIndex + 1} / ${turns.length} 轮`} full testID="turn-nav-sheet">
      {turns.length > 8 ? <View style={styles.sheetPad}><SearchField theme={theme} value={filter} onChange={setFilter} placeholder="筛选轮次" testID="turn-filter" /></View> : null}
      <SheetScroll key={scrollKey} contentOffset={{ x: 0, y: Math.max(0, currentIndex * 56 - 120) }} contentContainerStyle={{ paddingBottom: 20 }}>
        {list.map((t) => {
          const current = t.key === currentKey;
          const last = t.index === turns.length - 1;
          return (
            <Press key={t.key} onPress={() => { tap('select'); onPick(t); }} style={[styles.turn, current && { backgroundColor: theme.selected }]} accessibilityRole="button" accessibilityState={{ selected: current }} testID={`turn-${t.index + 1}`}>
              <Text style={[styles.turnNo, { color: current ? theme.textStrong : theme.muted }]}>{t.index + 1}</Text>
              <Text numberOfLines={2} style={[styles.body, { flex: 1, color: current ? theme.textStrong : theme.text, fontWeight: current ? '600' : '400' }]}>{t.title.replace(/\s+/g, ' ').trim() || '（无文字）'}</Text>
              {last && running ? <View style={[styles.runDot, { backgroundColor: theme.blue }]} /> : null}
            </Press>
          );
        })}
      </SheetScroll>
    </Sheet>
  );
}

// ---------------------------------------------------------------- 隐藏内容抽屉

function HiddenDrawer({ theme, uuid, open, onClose, items, busy, onRestore, onRestoreAll, baseUrl, headers }: {
  theme: Theme; uuid: string; open: boolean; onClose(): void; items: any[]; busy: boolean; onRestore(ids: string[]): void; onRestoreAll(): void; baseUrl: string; headers: Record<string, string>;
}) {
  const api = useChatApi();
  const [previewId, setPreviewId] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  useEffect(() => {
    if (!open) setPreviewId('');
  }, [open]);
  useEffect(() => {
    if (previewId && !items.some((i) => i.opId === previewId)) setPreviewId('');
  }, [items, previewId]);
  const show = async (id: string) => {
    if (previewId === id) {
      setPreviewId('');
      return;
    }
    setPreviewId(id);
    setPreview(null);
    setLoading(true);
    try {
      const data = await api!.hiddenMessagePreview(uuid, id);
      setPreview(data.operation);
    } catch (e) {
      setPreviewId('');
      showToast(apiError(e));
    } finally {
      setLoading(false);
    }
  };
  const Body = enrichedRenderer.Component;
  const files = Array.isArray(preview?.payload?.attachments) ? preview.payload.attachments : [];
  return (
    <>
      <Sheet visible={open} onClose={onClose} title="隐藏内容" full testID="hidden-drawer">
        <View style={styles.sheetPad}>
          <View style={[styles.intro, { backgroundColor: theme.surfaceSoft }]}>
            <Icon as={EyeOff} size={16} color={theme.subtle} />
            <Text style={[styles.small, { color: theme.subtle, flex: 1 }]}>只隐藏展示，不删除记录，也不改变 AI 上下文。查看原文仅在本机预览；恢复会同步到所有设备。</Text>
          </View>
          <View style={styles.summary}>
            <Text style={[styles.small, { color: theme.subtle }]}>{items.length} 条隐藏内容</Text>
            {items.length ? (
              <Press onPress={() => setConfirmAll(true)} disabled={busy} style={styles.linkBtn} accessibilityRole="button" testID="hidden-restore-all">
                <Text style={[styles.body, { color: theme.blue }]}>全部恢复</Text>
              </Press>
            ) : null}
          </View>
        </View>
        <SheetScroll contentContainerStyle={styles.sheetBody}>
          {!items.length ? (
            <View style={styles.empty}>
              <Icon as={EyeOff} size={28} color={theme.muted} />
              <Text style={[styles.body, { color: theme.textStrong, fontWeight: '600' }]}>没有隐藏的内容</Text>
              <Text style={[styles.small, { color: theme.muted }]}>长按消息，选择“只隐藏这条”。</Text>
            </View>
          ) : null}
          {items.map((item) => (
            <View key={item.opId} style={[styles.hiddenItem, { borderBottomColor: theme.line }]} testID="hidden-item">
              <View style={styles.resultMeta}>
                <Text style={[styles.body, { color: theme.textStrong, fontWeight: '600' }]}>{DRAWER_LABELS[item.type] || '消息'}</Text>
                <Text style={[styles.small, { color: theme.muted }]}>{fullTime(Number(item.createdAtMs || 0))}</Text>
              </View>
              <View style={styles.hiddenActions}>
                <Press onPress={() => void show(item.opId)} disabled={busy} style={[styles.outlineBtn, { borderColor: theme.border }]} accessibilityRole="button" testID="hidden-preview">
                  <Icon as={Eye} size={14} color={theme.text} />
                  <Text style={[styles.small, { color: theme.text }]}>{previewId === item.opId ? '收起原文' : '查看原文'}</Text>
                </Press>
                <Press onPress={() => onRestore([item.opId])} disabled={busy} style={[styles.outlineBtn, { borderColor: theme.border }]} accessibilityRole="button" testID="hidden-restore">
                  <Icon as={RotateCcw} size={14} color={theme.text} />
                  <Text style={[styles.small, { color: theme.text }]}>恢复显示</Text>
                </Press>
              </View>
              {previewId === item.opId ? (
                <View style={[styles.preview, { borderColor: theme.border }]} testID="hidden-preview-body">
                  <Text style={[styles.small, { color: theme.muted, marginBottom: 6 }]}>本机临时预览 · 尚未恢复</Text>
                  {loading ? <ActivityIndicator color={theme.muted} /> : (
                    <>
                      <Body markdown={hiddenPreviewText(preview).slice(0, 20000) || '（无文字）'} blockKind="paragraph" streaming={false} theme={theme} selectable />
                      {files.map((f: any, i: number) => {
                        const raw = String(f.previewUrl || f.contentUrl || f.downloadUrl || '');
                        const uri = raw.startsWith('/') ? `${baseUrl}${raw}` : raw;
                        return String(f.mimeType || '').startsWith('image/') || f.kind === 'image' ? (
                          <RNImage key={i} source={{ uri, headers }} style={styles.previewImg} resizeMode="contain" />
                        ) : (
                          <Text key={i} style={[styles.small, { color: theme.blue }]}>{f.fileName || f.name || '附件'}</Text>
                        );
                      })}
                    </>
                  )}
                </View>
              ) : null}
            </View>
          ))}
        </SheetScroll>
      </Sheet>
      <ConfirmSheet visible={confirmAll} title="恢复全部隐藏内容？" message="这些内容将重新出现在所有设备的聊天页面中。" confirmLabel="全部恢复" destructive={false} busy={busy}
        onConfirm={() => { setConfirmAll(false); onRestoreAll(); }} onClose={() => setConfirmAll(false)} />
    </>
  );
}

// ---------------------------------------------------------------- 消息操作菜单（长按）

function MessageMenu({ theme, row, store, onClose, onHideOne, onHideTurn, onSelect }: {
  theme: Theme; row: ChatRow | null; store: ConversationStore; onClose(): void; onHideOne(id: string): void; onHideTurn(turnKey: string): void; onSelect(id: string): void;
}) {
  const id = row ? rowTargetId(row) : '';
  const op = id ? store.operation(id) : undefined;
  const preview = visibilityTargetPreview(op || {});
  const isUser = row?.type === 'user';
  return (
    <Sheet visible={Boolean(row)} onClose={onClose} title="消息操作" testID="message-menu">
      <View style={styles.sheetBody}>
        <View style={[styles.menuPreview, { backgroundColor: theme.surfaceSoft }]}>
          <Text style={[styles.small, { color: theme.muted }]}>{preview.label}</Text>
          <Text numberOfLines={3} style={[styles.body, { color: theme.text }]}>{preview.text}</Text>
        </View>
        {!isUser && row ? <MenuRow theme={theme} icon={EyeOff} label="隐藏本轮回复" detail="含工作详情，保留提问和插话" onPress={() => onHideTurn(row.turnKey)} testID="menu-hide-turn" /> : null}
        <MenuRow theme={theme} icon={EyeOff} label="只隐藏这条" detail="只影响显示，不删记录、不改 AI 上下文；会同步到所有设备" onPress={() => onHideOne(id)} testID="menu-hide-one" />
        <MenuRow theme={theme} icon={Eye} label="选择多条" onPress={() => onSelect(id)} testID="menu-select-many" />
      </View>
    </Sheet>
  );
}

function MenuRow({ theme, icon, label, detail, onPress, testID }: { theme: Theme; icon: any; label: string; detail?: string; onPress(): void; testID?: string }) {
  return (
    <Press onPress={() => { tap('select'); onPress(); }} style={styles.menuRow} pressedStyle={{ backgroundColor: theme.hover }} accessibilityRole="button" testID={testID}>
      <Icon as={icon} size={18} color={theme.subtle} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.menuLabel, { color: theme.text }]}>{label}</Text>
        {detail ? <Text style={[styles.small, { color: theme.muted }]}>{detail}</Text> : null}
      </View>
    </Press>
  );
}

// ---------------------------------------------------------------- 多选条 / 撤销条

function VisibilityBar({ theme, selecting, count, busy, undoCount, onCancel, onHide, onUndo, onDismiss }: {
  theme: Theme; selecting: boolean; count: number; busy: boolean; undoCount: number; onCancel(): void; onHide(): void; onUndo(): void; onDismiss(): void;
}) {
  if (!selecting && !undoCount) return null;
  return (
    <View style={[styles.bar, { backgroundColor: theme.panel, borderColor: theme.border }, elevation(theme, 'pop')]} testID={selecting ? 'select-bar' : 'undo-bar'}>
      {selecting ? (
        <>
          <Text style={[styles.barText, { color: theme.text }]}>已选 <Text style={{ fontWeight: '700', color: theme.textStrong }}>{count}</Text> 条</Text>
          <Press onPress={onCancel} disabled={busy} style={styles.barBtn} accessibilityRole="button" testID="select-cancel"><Text style={[styles.barBtnText, { color: theme.text }]}>取消</Text></Press>
          <Press onPress={onHide} disabled={busy || !count} style={[styles.barBtn, { backgroundColor: theme.button, opacity: busy || !count ? 0.45 : 1 }]} accessibilityRole="button" testID="select-hide">
            {busy ? <ActivityIndicator size="small" color={theme.buttonText} /> : <Icon as={EyeOff} size={14} color={theme.buttonText} />}
            <Text style={[styles.barBtnText, { color: theme.buttonText }]}>{busy ? '正在隐藏…' : '隐藏所选'}</Text>
          </Press>
        </>
      ) : (
        <>
          <Text style={[styles.barText, { color: theme.text }]}>已隐藏 {undoCount} 条内容</Text>
          <Press onPress={onUndo} disabled={busy} style={styles.barBtn} accessibilityRole="button" testID="undo-hide"><Text style={[styles.barBtnText, { color: theme.text }]}>撤销</Text></Press>
          <Press onPress={onDismiss} style={styles.barIcon} accessibilityRole="button" accessibilityLabel="关闭提示"><Icon as={X} size={16} color={theme.subtle} /></Press>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sheetPad: { paddingHorizontal: 20, paddingBottom: 8, gap: 6 },
  sheetBody: { paddingHorizontal: 20, paddingBottom: 24, gap: 8 },
  body: { fontSize: 14.5, lineHeight: 21 },
  small: { fontSize: 12.5, lineHeight: 18 },
  info: { fontSize: 13.5, textAlign: 'center', paddingVertical: 24 },
  switchRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  result: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  resultMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  resultLink: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingVertical: 6 },
  preview: { borderWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed', borderRadius: 10, padding: 10, marginTop: 6 },
  previewImg: { width: '100%', height: 180, marginTop: 8, borderRadius: 8 },
  more: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  turn: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 20, paddingVertical: 6 },
  turnNo: { width: 28, fontSize: 13, fontVariant: ['tabular-nums'], textAlign: 'right' },
  runDot: { width: 8, height: 8, borderRadius: 4 },
  intro: { flexDirection: 'row', gap: 8, borderRadius: 12, padding: 10, alignItems: 'flex-start' },
  summary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
  linkBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 48 },
  hiddenItem: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  hiddenActions: { flexDirection: 'row', gap: 8 },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  menuPreview: { borderRadius: 12, padding: 10, gap: 2, marginBottom: 4 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 8, borderRadius: 10, paddingHorizontal: 4 },
  menuLabel: { fontSize: 15.5 },
  bar: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 22, paddingLeft: 16, paddingRight: 5, minHeight: 50, maxWidth: '94%', zIndex: 30 },
  seekBar: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 22, paddingLeft: 14, paddingRight: 5, minHeight: 50, maxWidth: '96%', zIndex: 30 },
  barText: { fontSize: 13.5, flexShrink: 1 },
  barBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 40, borderRadius: 20, paddingHorizontal: 12 },
  barBtnText: { fontSize: 13.5, fontWeight: '600' },
  barIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});

export const _readingToolsInternals = { Pressable };
