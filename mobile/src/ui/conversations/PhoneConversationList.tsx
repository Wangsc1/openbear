/**
 * 手机“会话”Tab（方向稿 ①，B1 会话树）：
 * - 大标题“会话 N”（活跃会话数）+ 搜索（整棵树：目录和会话，结果显示完整路径，可分页，可“包含已归档”）；
 * - 活动条：“待处理 N”（打开待处理面板）/ “未读 N · 运行 N”（切到“最近”并清空搜索）/ 全部标为已读；
 * - “最近 / 目录”分段（记住选择）：最近 = 按最近交互排序、带路径和状态；目录 = 逐级进入（根级 + 临时会话 + 已归档）；
 * - 长按任意行打开完整菜单；“多选整理”进入选择模式（底部批量移动/归档/删除）；
 * - 右下角“+”：新建会话（目录视图下菜单里还有新建目录、临时会话）。
 */
import { router } from 'expo-router';
import { Archive, CheckCheck, CheckSquare, Ellipsis, FolderPlus, MessageSquarePlus, Plus, RefreshCw, SearchX } from 'lucide-react-native';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Platform, RefreshControl, SectionList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '../../data/session';
import { folderMap, recentSections, recentTime, type Row, rowId, waitingCountFor } from '../../tree/treeModel';
import { apiErrorText, markOpenedRead, tree, useTreeIndex, useTreeSync } from '../../tree/treeStore';
import { useTreeSearch } from '../../tree/useTreeSearch';
import { ActionMenu, type MenuAnchor, type MenuItem } from '../ActionMenu';
import { CollapsingNavBar, LargeTitleText, SectionLabel, useCollapsingTitle, useTabBottomInset } from '../LargeTitle';
import { Icon, IconButton, NAV_ROW_HEIGHT, Press, Segmented, tap } from '../primitives';
import { elevation, useTheme } from '../theme';
import { showToast } from '../Toast';
import { SearchField } from './ListControls';
import { PendingSheet } from './PendingSheet';
import { SelectionBar, SelectionHeader, useSelection } from './SelectionBar';
import { FolderRow, InlineRow, ListNotice, TreeConversationRow } from './treeKit';
import { TreeLevelList } from './TreeLevelList';
import { useNow } from './useConversationList';
import { useTreeActions } from './useTreeActions';

const FAB_SIZE = 52;

export function openFolderPage(row: Row) {
  const id = row.kind === 'system' ? row.id : row.folderId;
  router.push({ pathname: '/folder/[id]', params: { id, name: String(row.name || '') } });
}

export function PhoneConversationList() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const bottomInset = useTabBottomInset();
  const session = useSession();
  const state = useTreeSync();
  const index = useTreeIndex();
  const search = useTreeSearch();
  const selection = useSelection();
  const now = useNow(60000);
  const { scrollY, onScroll } = useCollapsingTitle();
  const [navMenu, setNavMenu] = useState<'more' | 'new' | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const levelRows = useRef<Row[]>([]);
  const navHeight = insets.top + NAV_ROW_HEIGHT - 8;
  const view = state.view;

  const open = useCallback((row: Row) => {
    tap('light');
    tree.setLastOpened(row.conversationUuid);
    router.push({ pathname: '/conversation/[uuid]', params: { uuid: row.conversationUuid } });
  }, []);
  const reveal = useCallback(async (row: Row) => {
    try {
      const target = await tree.reveal(row.kind === 'folder' ? 'folder' : 'conversation', row.kind === 'folder' ? row.folderId : row.conversationUuid);
      search.setQuery('');
      tree.setView('folders');
      const ids = row.kind === 'folder' ? target.path : target.node === '' ? [] : target.path.length ? target.path : [target.node];
      // 逐级压入目录页，返回键可以一级一级退回（像“文件”App）
      const folders = folderMap(tree.state.folders);
      for (const id of ids) router.push({ pathname: '/folder/[id]', params: { id, name: folders.get(id)?.name || (id === '__temporary' ? '临时会话' : id === '__archive' ? '已归档' : '') } });
    } catch (error) {
      showToast(apiErrorText(error));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const actions = useTreeActions({ open, reveal: (row) => void reveal(row), startSelect: (row) => selection.start(row) });

  const sections = useMemo(() => recentSections(session.conversations as Row[], index, folderMap(state.folders), now), [session.conversations, index, state.folders, now]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([tree.refresh(), session.refresh()]);
    } catch {
      showToast('刷新失败，请检查网络');
    } finally {
      setRefreshing(false);
    }
  }, [session.refresh]);

  const readAll = useCallback(async () => {
    setReadBusy(true);
    try {
      await tree.markRead(index.unread);
      showToast('已全部标为已读');
    } catch (error) {
      showToast(apiErrorText(error));
    } finally {
      setReadBusy(false);
    }
  }, [index.unread]);

  const newMenu: MenuItem[] = [
    { key: 'new-conv', label: '新建临时会话', icon: MessageSquarePlus, onPress: () => actions.newConversation('') },
    { key: 'new-folder', label: '新建根级目录', icon: FolderPlus, onPress: () => actions.promptNewFolder('') },
  ];
  const moreMenu: MenuItem[] = [
    { key: 'refresh', label: '刷新', icon: RefreshCw, onPress: () => void refresh() },
    ...(index.unread.length ? [{ key: 'read-all', label: '全部标为已读', icon: CheckCheck, disabled: readBusy, onPress: () => void readAll() }] : []),
    { key: 'select', label: '多选整理', icon: CheckSquare, onPress: () => {
      if (view === 'recent' && !search.active) tree.setView('folders');
      selection.start();
    } },
    { key: 'archived', label: '已归档的会话', icon: Archive, onPress: () => openFolderPage({ kind: 'system', id: '__archive', name: '已归档' }) },
  ];
  const navAnchor: MenuAnchor = { x: width - 12, y: insets.top + 4, height: NAV_ROW_HEIGHT - 8, align: 'right' };

  const activity = (
    <View style={styles.activity}>
      <Press
        onPress={() => setPendingOpen(true)}
        style={[styles.activityChip, { backgroundColor: index.pending.length ? theme.warningSoft : theme.hover }]}
        accessibilityRole="button"
        accessibilityLabel={`查看待处理会话，共 ${index.pending.length} 个`}
        testID="pending-entry"
      >
        <Text style={[styles.activityText, { color: index.pending.length ? theme.warning : theme.muted, fontWeight: index.pending.length ? '600' : '400' }]}>待处理 {index.pending.length}</Text>
      </Press>
      <Press
        onPress={() => {
          search.setQuery('');
          tree.setView('recent');
        }}
        style={[styles.activityChip, { backgroundColor: theme.hover }]}
        accessibilityRole="button"
        accessibilityLabel="查看最近会话动态"
        testID="activity-summary"
      >
        <Text style={[styles.activityText, { color: index.unread.length ? theme.text : theme.muted }]}>未读 {index.unread.length}</Text>
        <Text style={[styles.activityText, { color: theme.muted }]}>·</Text>
        <Text style={[styles.activityText, { color: index.runningCount ? theme.blue : theme.muted }]}>运行 {index.runningCount}</Text>
      </Press>
      {index.unread.length ? (
        <Press onPress={() => void readAll()} disabled={readBusy} style={[styles.readAll, { borderColor: theme.border }]} accessibilityRole="button" accessibilityLabel="全部标为已读" testID="read-all">
          {readBusy ? <ActivityIndicator size="small" color={theme.muted} /> : <Icon as={CheckCheck} size={16} color={theme.text} />}
        </Press>
      ) : null}
    </View>
  );

  // 搜索框放在固定位置（不随列表切换而重新挂载，否则输入第一个字后会丢失焦点）
  const controls = (
    <View style={{ backgroundColor: theme.bg }}>
      <View style={styles.searchRow}>
        <SearchField theme={theme} value={search.query} onChange={search.setQuery} placeholder="搜索目录或会话" style={{ flex: 1 }} />
        {search.canArchive ? (
          <Press onPress={() => search.setArchived(!search.archived)} style={[styles.archiveToggle, { backgroundColor: search.archived ? theme.button : theme.hover }]} accessibilityRole="switch" accessibilityState={{ checked: search.archived }} accessibilityLabel="搜索已归档会话" testID="search-archived">
            <Icon as={Archive} size={17} color={search.archived ? theme.buttonText : theme.subtle} />
          </Press>
        ) : null}
      </View>
      {search.active ? null : activity}
      {search.active ? null : (
        <View style={styles.seg}>
          <Segmented theme={theme} value={view} onChange={(v) => tree.setView(v as 'recent' | 'folders')} items={[{ key: 'recent', label: '最近' }, { key: 'folders', label: '目录' }]} />
        </View>
      )}
    </View>
  );
  const header = (
    <View style={styles.titleRow}>
      <LargeTitleText theme={theme} title="会话" scrollY={scrollY} />
      <Text style={[styles.count, { color: theme.muted }]} testID="active-count">{state.activeCount || ''}</Text>
    </View>
  );

  const selectionTop = selection.active ? <SelectionHeader count={selection.rows.length} allSelected={selection.rows.length > 0 && selection.rows.length === levelRows.current.length} onAll={() => (selection.rows.length === levelRows.current.length ? selection.setAll([]) : selection.setAll(levelRows.current))} onDone={selection.stop} /> : null;
  const listBottom = bottomInset + (selection.active ? 110 : FAB_SIZE + 40);

  let body: React.ReactNode;
  if (search.active) {
    body = (
      <Animated.FlatList
        data={search.rows}
        keyExtractor={(row: Row) => `${row.kind}:${rowId(row)}`}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: 4, paddingBottom: listBottom }}
        renderItem={({ item }: { item: Row }) =>
          item.kind === 'folder' ? (
            <FolderRow row={item} theme={theme} waiting={waitingCountFor(item, index)} onPress={(row) => void reveal(row)} onLongPress={(row, at) => actions.openMenu(row, at, { search: true })} />
          ) : (
            <TreeConversationRow row={item} theme={theme} path={item.path} generating={state.generating.has(item.conversationUuid)} onPress={(row) => {
              markOpenedRead(row);
              if (row.archived) tree.unlockArchive();
              open(row);
            }} onLongPress={(row, at) => actions.openMenu(row, at, { search: true })} />
          )
        }
        ListFooterComponent={
          search.hasMore ? (
            <InlineRow theme={theme} kind="more" busy={search.loading} onPress={search.more} />
          ) : search.loading ? (
            <ActivityIndicator style={{ paddingVertical: 24 }} color={theme.muted} testID="search-loading" />
          ) : null
        }
        ListEmptyComponent={
          search.loading ? null : search.error ? (
            <ListNotice theme={theme} icon={RefreshCw} title="搜索失败" hint={search.error} action="重试" onAction={search.retry} />
          ) : (
            <ListNotice theme={theme} icon={SearchX} title="没有匹配的目录或会话" hint={search.canArchive && !search.archived ? '可以打开右侧的归档开关，搜索已归档会话。' : undefined} />
          )
        }
      />
    );
  } else if (view === 'folders') {
    body = (
      <TreeLevelList
        nodeId=""
        header={selectionTop}
        contentTop={0}
        contentBottom={listBottom}
        highlight={state.lastOpened}
        selecting={selection.active}
        isPicked={selection.has}
        onToggle={selection.toggle}
        onRows={(rows) => (levelRows.current = rows)}
        onOpenFolder={openFolderPage}
        onOpenConversation={actions.openConversation}
        onLongPress={(row, at) => actions.openMenu(row, at)}
        testID="tree-root"
      />
    );
  } else {
    body = (
      <Animated.ScrollView scrollEventThrottle={16} contentContainerStyle={{ paddingBottom: listBottom }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.muted} colors={[theme.textStrong]} progressBackgroundColor={theme.panel} />} keyboardShouldPersistTaps="handled">
        <RecentList sections={sections} now={now} highlight={state.lastOpened} generating={state.generating} loaded={session.conversationsLoaded} onOpen={actions.openConversation} onLongPress={(row, at) => actions.openMenu(row, at, { recent: true })} />
      </Animated.ScrollView>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]} testID="conversation-list">
      <View style={{ paddingTop: navHeight }}>
        {header}
        {controls}
      </View>
      <View style={{ flex: 1 }}>{body}</View>
      <CollapsingNavBar
        theme={theme}
        title="会话"
        scrollY={scrollY}
        testID="conv-navbar"
        right={
          <>
            <IconButton theme={theme} icon={Ellipsis} label="更多" testID="conv-more" onPress={() => setNavMenu('more')} />
          </>
        }
      />
      {selection.active ? (
        <SelectionBar
          rows={selection.rows}
          bottomInset={bottomInset}
          onMove={() => actions.moveRows(selection.rows, selection.stop)}
          onArchive={() => void actions.archiveRows(selection.rows).then(() => selection.stop())}
          onDelete={() => actions.deleteRows(selection.rows, selection.stop)}
        />
      ) : (
        <Press
          testID="new-conversation"
          accessibilityRole="button"
          accessibilityLabel="新会话"
          onPress={() => {
            tap('light');
            actions.newConversation('');
          }}
          onLongPress={() => setNavMenu('new')}
          android_ripple={{ color: 'rgba(128,128,128,0.35)', borderless: false }}
          style={[styles.fab, { bottom: bottomInset + 16, backgroundColor: theme.button }, elevation(theme, 'pop')]}
          pressedStyle={Platform.OS === 'ios' ? { opacity: 0.8, transform: [{ scale: 0.96 }] } : undefined}
        >
          <Icon as={Plus} size={24} strokeWidth={2} color={theme.buttonText} />
        </Press>
      )}
      <ActionMenu visible={navMenu === 'more'} anchor={navAnchor} items={moreMenu} onClose={() => setNavMenu(null)} />
      <ActionMenu visible={navMenu === 'new'} anchor={{ x: width - 20, y: insets.top + 400, align: 'right' }} title="新建" items={newMenu} dim onClose={() => setNavMenu(null)} />
      <PendingSheet visible={pendingOpen} onClose={() => setPendingOpen(false)} />
      {actions.element}
    </View>
  );
}

function RecentList({ sections, now, highlight, generating, loaded, onOpen, onLongPress }: { sections: ReturnType<typeof recentSections>; now: number; highlight: string; generating: Set<string>; loaded: boolean; onOpen(row: Row): void; onLongPress(row: Row, at: { x: number; y: number }): void }) {
  const theme = useTheme();
  if (!sections.length) {
    return loaded ? <ListNotice theme={theme} icon={SearchX} title="暂无最近会话" hint="点右下角的按钮开始一个新会话。" /> : <ActivityIndicator style={{ paddingTop: 64 }} color={theme.muted} testID="conv-loading" />;
  }
  return (
    <View testID="recent-list">
      {sections.map((section) => (
        <View key={section.key}>
          <SectionLabel theme={theme} title={section.title} />
          {section.rows.map((row, i) => (
            <View key={row.conversationUuid}>
              {i > 0 ? <View style={[styles.sep, { backgroundColor: theme.line }]} /> : null}
              <TreeConversationRow row={row} theme={theme} time={recentTime(row, now)} path={row.path} generating={generating.has(row.conversationUuid)} highlighted={highlight === row.conversationUuid} onPress={onOpen} onLongPress={onLongPress} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

void SectionList;

const styles = StyleSheet.create({
  root: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline' },
  count: { fontSize: 17, fontVariant: ['tabular-nums'], marginLeft: -6 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 2, marginBottom: 10 },
  archiveToggle: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, marginBottom: 10 },
  activityChip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16 },
  activityText: { fontSize: 13.5, fontVariant: ['tabular-nums'] },
  readAll: { marginLeft: 'auto', width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  seg: { paddingHorizontal: 16, marginBottom: 4 },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 62 },
  fab: { position: 'absolute', right: 20, width: FAB_SIZE, height: FAB_SIZE, borderRadius: FAB_SIZE / 2, alignItems: 'center', justifyContent: 'center', overflow: Platform.OS === 'android' ? 'hidden' : 'visible' },
});
