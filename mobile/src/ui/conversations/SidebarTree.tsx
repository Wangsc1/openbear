/**
 * 平板左栏（宽度 ≥ breakpoints.split）：可展开的缩进树（B1-16 / B1-23 / B1-52），替换原来的 SidebarConversationList。
 * - 顶部：“会话 N” + 搜索 + 新建；活动条（待处理 / 未读·运行 / 全部已读）；“最近 / 目录”分段；
 * - 目录视图：缩进树（最多 7 级缩进），点目录行展开/折叠并设为“新建目标”，点会话在右栏打开并高亮；
 *   展开状态持久保存；打开会话时自动展开路径并滚动到它；
 * - 拖拽（只在目录视图、非搜索时）：长按行后拖动（不松手），按落点放到目标的“前 / 后 / 里面”（与 Web resolveTreeDrop 相同的规则），
 *   悬停目录 520ms 自动展开，靠边自动滚动；松手后走移动影响确认 + POST /api/conversation-tree/move；长按不拖动则打开菜单；
 * - 最近视图与搜索：与手机相同的数据，紧凑行。
 */
import { Archive, CheckCheck, FolderPlus, MessageSquarePlus, Plus, RefreshCw, Search, SearchX } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, type LayoutChangeEvent, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import { useSession } from '../../data/session';
import { draftRow, useDraft } from '../../tree/draft';
import { type FlatRow, flattenTree, folderMap, pathOf, recentSections, recentTime, type Row, rowId, sumImpacts, TEMP, waitingCountFor, ARCHIVE } from '../../tree/treeModel';
import { apiErrorText, parentOf, tree, useTreeIndex, useTreeSync } from '../../tree/treeStore';
import { useTreeSearch } from '../../tree/useTreeSearch';
import { resolveTreeDrop } from '../../tree/webTree';
import { useImpactChooser } from '../../properties/impact';
import { ActionMenu, type MenuItem } from '../ActionMenu';
import { Icon, IconButton, Press, Segmented, tap } from '../primitives';
import { useTheme } from '../theme';
import { showToast } from '../Toast';
import { SearchField } from './ListControls';
import { PendingSheet } from './PendingSheet';
import { FolderRow, InlineRow, ListNotice, TREE_ROW_H, TreeConversationRow } from './treeKit';
import { useNow } from './useConversationList';
import { useTreeActions } from './useTreeActions';

type Drag = { source: Row; y: number; startY: number; moved: boolean; target: FlatRow | null; zone: 'before' | 'after' | 'inside' | null; intent: ReturnType<typeof resolveTreeDrop> };

export function SidebarTree({ selected, onSelect, topInset, bottomInset }: { selected: string; onSelect(uuid: string): void; topInset: number; bottomInset: number }) {
  const theme = useTheme();
  const session = useSession();
  const state = useTreeSync();
  const index = useTreeIndex();
  const search = useTreeSearch();
  const draft = useDraft();
  const now = useNow(60000);
  const [searching, setSearching] = useState(false);
  const [plusMenu, setPlusMenu] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [targetFolder, setTargetFolder] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [moving, setMoving] = useState('');
  const [impactElement, chooseImpact] = useImpactChooser();
  const list = useRef<FlatList<FlatRow>>(null);
  const listTop = useRef(0);
  const listHeight = useRef(0);
  const scrollY = useRef(0);
  const expandTimer = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const folders = useMemo(() => folderMap(state.folders), [state.folders]);

  const open = useCallback(
    (row: Row) => {
      tap('select');
      tree.setLastOpened(row.conversationUuid);
      onSelect(row.conversationUuid);
    },
    [onSelect],
  );
  const reveal = useCallback(async (row: Row) => {
    try {
      search.setQuery('');
      setSearching(false);
      tree.setView('folders');
      await tree.reveal(row.kind === 'folder' ? 'folder' : 'conversation', row.kind === 'folder' ? row.folderId : row.conversationUuid);
    } catch (error) {
      showToast(apiErrorText(error));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const actions = useTreeActions({ open, activeUuid: selected, reveal: (row) => void reveal(row) });

  // 打开（或首次自动打开）的会话：在树里展开路径并高亮（B1-23）
  const revealed = useRef('');
  useEffect(() => {
    if (!selected || !state.ready || revealed.current === selected) return;
    revealed.current = selected;
    if (state.view === 'folders') void tree.reveal('conversation', selected).catch(() => undefined);
  }, [selected, state.ready, state.view]);

  const draftHere = draft ? draftRow(draft, pathOf(draft.folderId, folders)) : null;
  const rows = useMemo(
    () => flattenTree(state.rootFolders, state.branches, state.expanded, { temporary: state.temporaryCount, archived: state.archivedCount }, index, draftHere),
    [state.rootFolders, state.branches, state.expanded, state.temporaryCount, state.archivedCount, index, draftHere?.folderId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const knownRows = useMemo(() => rows.map((r) => r.row).filter((r) => r.kind === 'folder' || r.kind === 'conversation'), [rows]);

  // 定位后滚动到目标行
  useEffect(() => {
    if (!state.revealId) return;
    const i = rows.findIndex((r) => (r.row.kind === 'folder' ? r.row.folderId : r.row.conversationUuid) === state.revealId);
    if (i >= 0) setTimeout(() => list.current?.scrollToIndex({ index: i, viewPosition: 0.4, animated: true }), 80);
  }, [state.revealTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback((row: Row) => {
    const id = row.kind === 'system' ? row.id : row.folderId;
    const opening = !tree.state.expanded.has(id);
    tree.setExpanded(id, opening);
    if (opening) void tree.loadBranch(id);
  }, []);
  const pressFolder = useCallback(
    (row: Row) => {
      tap('select');
      setTargetFolder(row.kind === 'system' ? (row.id === TEMP ? '' : targetFolder) : row.folderId);
      toggle(row);
    },
    [toggle, targetFolder],
  );

  // ---- 拖拽 ----
  const rowAt = (pageY: number) => {
    const y = pageY - listTop.current + scrollY.current;
    const i = Math.floor(y / TREE_ROW_H);
    return { i, ratio: (y - i * TREE_ROW_H) / TREE_ROW_H };
  };
  const stopTimers = () => {
    if (expandTimer.current) clearTimeout(expandTimer.current.timer);
    expandTimer.current = null;
    if (scrollTimer.current) clearInterval(scrollTimer.current);
    scrollTimer.current = null;
  };
  const dragStart = useCallback(
    (i: number, pageY: number) => {
      const target = rows[i];
      if (!target || state.view !== 'folders' || search.active || moving) return false;
      const source = target.row;
      if (!['folder', 'conversation'].includes(source.kind) || source.local || source.archived) return false;
      tap('medium');
      setDrag({ source, y: pageY, startY: pageY, moved: false, target: null, zone: null, intent: null });
      return true;
    },
    [rows, state.view, search.active, moving],
  );
  const dragMove = useCallback(
    (pageY: number) => {
      setDrag((current) => {
        if (!current) return current;
        // 长按先出菜单；手指真正移动后收起菜单、进入拖拽（与 iPad“文件”相同）
        const moved = current.moved || Math.abs(pageY - current.startY) > 12;
        if (!moved) return current;
        if (!current.moved) actions.closeMenu();
        const { i, ratio } = rowAt(pageY);
        const target = rows[i] || null;
        const targetRow = target ? (target.inline === 'empty' ? target.row : target.row) : { kind: 'root', id: '__root' };
        const intent = target && target.inline && target.inline !== 'empty' ? null : resolveTreeDrop(current.source, targetRow, ratio, knownRows);
        // 悬停目录 520ms 自动展开
        const folderId = intent?.zone === 'inside' && target?.row.kind === 'folder' ? target.row.folderId : '';
        if (folderId && !tree.state.expanded.has(folderId)) {
          if (expandTimer.current?.id !== folderId) {
            if (expandTimer.current) clearTimeout(expandTimer.current.timer);
            expandTimer.current = { id: folderId, timer: setTimeout(() => {
              tree.setExpanded(folderId, true);
              void tree.loadBranch(folderId);
            }, 520) };
          }
        } else if (expandTimer.current) {
          clearTimeout(expandTimer.current.timer);
          expandTimer.current = null;
        }
        // 靠边自动滚动
        const edge = pageY - listTop.current;
        const dir = edge < 40 ? -1 : edge > listHeight.current - 40 ? 1 : 0;
        if (dir && !scrollTimer.current) {
          scrollTimer.current = setInterval(() => {
            scrollY.current = Math.max(0, scrollY.current + dir * 18);
            list.current?.scrollToOffset({ offset: scrollY.current, animated: false });
          }, 40);
        } else if (!dir && scrollTimer.current) {
          clearInterval(scrollTimer.current);
          scrollTimer.current = null;
        }
        return { ...current, y: pageY, moved: true, target, zone: intent?.zone || null, intent };
      });
    },
    [rows, knownRows, actions],
  );
  const dragEnd = useCallback(
    (pageY: number) => {
      stopTimers();
      setDrag((current) => {
        if (!current || !current.moved) return null;
        const { i, ratio } = rowAt(pageY);
        const target = rows[i];
        const intent = target && !(target.inline && target.inline !== 'empty') ? resolveTreeDrop(current.source, target.row, ratio, knownRows) : null;
        if (intent) void commitDrop(current.source, intent);
        return null;
      });
    },
    [rows, knownRows], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const commitDrop = async (source: Row, intent: NonNullable<ReturnType<typeof resolveTreeDrop>>) => {
    setMoving(rowId(source));
    try {
      let updateSnapshots = false;
      const currentParent = source.kind === 'folder' ? String(source.parentId || '') : String(source.folderId || '');
      if (currentParent !== intent.targetFolderId) {
        const impact = await tree.moveImpact(source, intent.targetFolderId);
        const choice = await chooseImpact('移动', sumImpacts([impact as any]));
        if (choice === null) return;
        updateSnapshots = choice === true;
      }
      const result: any = await tree.move(source, intent.targetFolderId, { beforeId: intent.beforeId, afterId: intent.afterId, updateSnapshots });
      void tree.afterMutation([parentOf(source), intent.targetFolderId || TEMP]);
      void session.refresh().catch(() => undefined);
      if (result?.skippedRunningCount) showToast(`已移动；${result.skippedRunningCount} 个运行中会话的快照本次跳过，不会延后更新`);
    } catch (error) {
      showToast(apiErrorText(error));
    } finally {
      setMoving('');
    }
  };

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(420)
        .onStart((e) => {
          runOnJS(startFromGesture)(e.absoluteY);
        })
        .onUpdate((e) => {
          runOnJS(dragMove)(e.absoluteY);
        })
        .onEnd((e) => {
          runOnJS(dragEnd)(e.absoluteY);
        })
        .onFinalize(() => {
          runOnJS(stopTimers)();
        }),
    [dragMove, dragEnd], // eslint-disable-line react-hooks/exhaustive-deps
  );
  function startFromGesture(pageY: number) {
    const { i } = rowAt(pageY);
    dragStart(i, pageY);
  }

  const renderTreeRow = useCallback(
    ({ item }: { item: FlatRow }) => {
      if (item.inline) {
        const node = item.node || '';
        const branch = tree.branch(node);
        return <InlineRow theme={theme} compact depth={item.depth} kind={item.inline} message={branch.error} busy={item.inline === 'more' && branch.loading} onPress={() => void tree.loadBranch(node, item.inline === 'more' ? { append: true } : { force: true })} />;
      }
      const row = item.row;
      const isTarget = drag?.target?.key === item.key;
      if (row.kind === 'folder' || row.kind === 'system') {
        const id = row.kind === 'system' ? row.id : row.folderId;
        return (
          <FolderRow
            row={row}
            theme={theme}
            compact
            depth={item.depth}
            waiting={waitingCountFor(row, index)}
            expanded={state.expanded.has(id)}
            highlighted={(row.kind === 'folder' && targetFolder === row.folderId) || (row.kind === 'system' && row.id === TEMP && targetFolder === '' && false)}
            dropInside={isTarget && drag?.zone === 'inside'}
            busy={tree.branch(id).loading || moving === id}
            onPress={pressFolder}
            onToggle={toggle}
            onLongPress={(r, at) => actions.openMenu(r, at)}
          />
        );
      }
      return (
        <TreeConversationRow
          row={row}
          theme={theme}
          compact
          depth={item.depth}
          highlighted={row.conversationUuid === selected || (isTarget && drag?.zone === 'inside')}
          generating={state.generating.has(row.conversationUuid)}
          dropLine={isTarget && (drag?.zone === 'before' || drag?.zone === 'after') ? drag.zone : null}
          onPress={actions.openConversation}
          onLongPress={(r, at) => actions.openMenu(r, at)}
        />
      );
    },
    [theme, index, state.expanded, state.generating, targetFolder, drag, moving, selected, pressFolder, toggle, actions],
  );

  const recent = useMemo(() => recentSections(session.conversations as Row[], index, folders, now).flatMap((s) => s.rows), [session.conversations, index, folders, now]);
  const targetLabel = targetFolder ? pathOf(targetFolder, folders) || '所选目录' : '临时会话';
  const plusItems: MenuItem[] = [
    ...(targetFolder ? [{ key: 'new-here', label: `新建会话 · ${targetLabel}`, icon: MessageSquarePlus, onPress: () => actions.newConversation(targetFolder) }] : []),
    { key: 'new-folder', label: targetFolder ? `新建目录 · ${targetLabel}` : '新建根级目录', icon: FolderPlus, onPress: () => actions.promptNewFolder(targetFolder) },
    { key: 'new-temp', label: '新建临时会话', icon: MessageSquarePlus, separatorBefore: true, onPress: () => actions.newConversation('') },
    { key: 'refresh', label: '刷新目录树', icon: RefreshCw, separatorBefore: true, onPress: () => void tree.refresh() },
  ];

  let body: React.ReactNode;
  if (search.active) {
    body = (
      <FlatList
        data={search.rows}
        keyExtractor={(row) => `${row.kind}:${rowId(row)}`}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: bottomInset + 16 }}
        renderItem={({ item }) =>
          item.kind === 'folder' ? (
            <FolderRow row={item} theme={theme} waiting={waitingCountFor(item, index)} onPress={(row) => void reveal(row)} onLongPress={(row, at) => actions.openMenu(row, at, { search: true })} />
          ) : (
            <TreeConversationRow row={item} theme={theme} path={item.path} highlighted={item.conversationUuid === selected} onPress={(row) => {
              if (row.archived) tree.unlockArchive();
              void reveal(row);
              actions.openConversation(row);
            }} onLongPress={(row, at) => actions.openMenu(row, at, { search: true })} />
          )
        }
        ListFooterComponent={search.hasMore ? <InlineRow theme={theme} kind="more" busy={search.loading} onPress={search.more} /> : search.loading ? <ActivityIndicator style={{ padding: 20 }} color={theme.muted} /> : null}
        ListEmptyComponent={search.loading ? null : search.error ? <ListNotice theme={theme} icon={RefreshCw} title="搜索失败" hint={search.error} action="重试" onAction={search.retry} /> : <ListNotice theme={theme} icon={SearchX} title="没有匹配的目录或会话" />}
      />
    );
  } else if (state.view === 'recent') {
    body = (
      <FlatList
        data={recent}
        keyExtractor={(row) => row.conversationUuid}
        contentContainerStyle={{ paddingBottom: bottomInset + 16 }}
        renderItem={({ item }) => <TreeConversationRow row={item} theme={theme} time={recentTime(item, now)} path={item.path} highlighted={item.conversationUuid === selected} onPress={actions.openConversation} onLongPress={(row, at) => actions.openMenu(row, at, { recent: true })} />}
        ListEmptyComponent={session.conversationsLoaded ? <ListNotice theme={theme} icon={SearchX} title="暂无最近会话" /> : <ActivityIndicator style={{ marginTop: 32 }} color={theme.muted} />}
      />
    );
  } else {
    body = (
      <GestureDetector gesture={gesture}>
        <View style={{ flex: 1 }} onLayout={(e: LayoutChangeEvent) => {
          listHeight.current = e.nativeEvent.layout.height;
          (e.target as any)?.measure?.((_x: number, _y: number, _w: number, _h: number, _px: number, py: number) => (listTop.current = py));
        }}>
          <FlatList
            ref={list}
            data={rows}
            keyExtractor={(r) => r.key}
            renderItem={renderTreeRow}
            extraData={[drag, targetFolder, selected, moving]}
            getItemLayout={(_d, i) => ({ length: TREE_ROW_H, offset: TREE_ROW_H * i, index: i })}
            onScroll={(e) => (scrollY.current = e.nativeEvent.contentOffset.y)}
            scrollEventThrottle={16}
            scrollEnabled={!drag}
            onScrollToIndexFailed={() => undefined}
            contentContainerStyle={{ paddingBottom: bottomInset + 16 }}
            refreshControl={<RefreshControl refreshing={state.loading && state.ready} onRefresh={() => void tree.refresh()} tintColor={theme.muted} colors={[theme.textStrong]} progressBackgroundColor={theme.panel} />}
            ListEmptyComponent={state.error ? <ListNotice theme={theme} icon={RefreshCw} title="会话树加载失败" hint={state.error} action="重试" onAction={() => void tree.refresh()} /> : <ActivityIndicator style={{ marginTop: 32 }} color={theme.muted} />}
            testID="sidebar-tree"
          />
          {drag?.moved ? (
            <View pointerEvents="none" style={[styles.ghost, { top: drag.y - listTop.current - 18, backgroundColor: theme.raised, borderColor: theme.border }]}>
              <Text numberOfLines={1} style={{ color: theme.textStrong, fontSize: 14 }}>
                {drag.source.kind === 'folder' ? drag.source.name : drag.source.title}
              </Text>
              <Text style={{ color: drag.intent ? theme.blue : theme.muted, fontSize: 12 }}>{drag.intent ? (drag.intent.zone === 'inside' ? '放到里面' : drag.intent.zone === 'before' ? '放在前面' : '放在后面') : '不能放在这里'}</Text>
            </View>
          ) : null}
        </View>
      </GestureDetector>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.sidebar, paddingTop: topInset }]} testID="conversation-sidebar">
      <View style={styles.head}>
        <Text style={[styles.h, { color: theme.textStrong }]} accessibilityRole="header">
          会话 <Text style={[styles.count, { color: theme.muted }]}>{state.activeCount || ''}</Text>
        </Text>
        <IconButton theme={theme} icon={Search} label="搜索会话" active={searching} testID="sidebar-search" onPress={() => {
          if (searching) search.setQuery('');
          setSearching((v) => !v);
        }} />
        <IconButton theme={theme} icon={Plus} label="新建会话或目录" testID="sidebar-new" onPress={() => setPlusMenu(true)} />
      </View>
      {searching ? (
        <View style={styles.searchRow}>
          <SearchField theme={theme} value={search.query} onChange={search.setQuery} autoFocus style={{ flex: 1 }} testID="sidebar-search-input" />
          {search.canArchive ? (
            <Press onPress={() => search.setArchived(!search.archived)} style={[styles.archiveToggle, { backgroundColor: search.archived ? theme.button : theme.hover }]} accessibilityLabel="搜索已归档会话" testID="sidebar-search-archived">
              <Icon as={Archive} size={16} color={search.archived ? theme.buttonText : theme.subtle} />
            </Press>
          ) : null}
        </View>
      ) : null}
      <View style={styles.activity}>
        <Press onPress={() => setPendingOpen(true)} style={[styles.chip, { backgroundColor: index.pending.length ? theme.warningSoft : theme.hover }]} testID="sidebar-pending">
          <Text style={[styles.chipText, { color: index.pending.length ? theme.warning : theme.muted }]}>待处理 {index.pending.length}</Text>
        </Press>
        <Press onPress={() => {
          search.setQuery('');
          setSearching(false);
          tree.setView('recent');
        }} style={[styles.chip, { backgroundColor: theme.hover }]} testID="sidebar-activity">
          <Text style={[styles.chipText, { color: theme.muted }]}>未读 {index.unread.length} · 运行 {index.runningCount}</Text>
        </Press>
        {index.unread.length ? (
          <IconButton theme={theme} icon={CheckCheck} size={17} label="全部标为已读" testID="sidebar-read-all" onPress={() => void tree.markRead(index.unread).then(() => showToast('已全部标为已读')).catch((e) => showToast(apiErrorText(e)))} />
        ) : null}
      </View>
      {search.active ? null : (
        <View style={styles.seg}>
          <Segmented theme={theme} value={state.view} onChange={(v) => tree.setView(v as 'recent' | 'folders')} items={[{ key: 'recent', label: '最近' }, { key: 'folders', label: '目录' }]} />
        </View>
      )}
      {body}
      <ActionMenu visible={plusMenu} anchor={{ x: 300, y: topInset + 52, align: 'right' }} title="新建" items={plusItems} onClose={() => setPlusMenu(false)} />
      <PendingSheet visible={pendingOpen} activeUuid={selected} onClose={() => setPendingOpen(false)} onOpen={(row) => open(row)} />
      {actions.element}
      {impactElement}
    </View>
  );
}

void ARCHIVE;

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingLeft: 20, paddingRight: 10, paddingTop: 10, paddingBottom: 4 },
  h: { flex: 1, fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  count: { fontSize: 15, fontWeight: '400' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 14, marginTop: 4, marginBottom: 6 },
  archiveToggle: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 4 },
  chip: { height: 30, borderRadius: 15, paddingHorizontal: 11, justifyContent: 'center' },
  chipText: { fontSize: 12.5, fontVariant: ['tabular-nums'] },
  seg: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 8 },
  ghost: { position: 'absolute', left: 24, right: 24, height: 44, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, justifyContent: 'center', opacity: 0.95 },
});
