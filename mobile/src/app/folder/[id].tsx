/**
 * 目录页（手机“目录”视图逐级进入的一级）：顶部返回 + 当前目录名 + 可点的路径面包屑（一步跳回任意上级），
 * 右上“+”（在此新建会话 / 新建子目录 / 新建临时会话 / 新建根级目录）与“更多”（目录菜单：重命名、置顶、移动、属性、多选…）。
 * id 可以是目录 uuid，或系统节点 __temporary（临时会话）/ __archive（已归档）。
 */
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, ChevronRight, Ellipsis, Plus } from 'lucide-react-native';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ARCHIVE, crumbsFor, folderMap, type Row, TEMP } from '../../tree/treeModel';
import { apiErrorText, tree, useTree, useTreeSync } from '../../tree/treeStore';
import { ActionMenu } from '../../ui/ActionMenu';
import { Icon, IconButton, NAV_ROW_HEIGHT, Press, tap } from '../../ui/primitives';
import { useTheme } from '../../ui/theme';
import { showToast } from '../../ui/Toast';
import { openFolderPage } from '../../ui/conversations/PhoneConversationList';
import { SelectionBar, SelectionHeader, useSelection } from '../../ui/conversations/SelectionBar';
import { TreeLevelList } from '../../ui/conversations/TreeLevelList';
import { useTreeActions } from '../../ui/conversations/useTreeActions';

export default function FolderPage() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const id = String(params.id || '');
  const state = useTreeSync();
  const selection = useSelection();
  const levelRows = useRef<Row[]>([]);
  const [menu, setMenu] = useState<'plus' | 'more' | null>(null);
  const folders = useMemo(() => folderMap(state.folders), [state.folders]);
  const system = id === TEMP || id === ARCHIVE;
  const folder = folders.get(id);
  const name = system ? (id === TEMP ? '临时会话' : '已归档') : folder?.name || String(params.name || '目录');
  const crumbs = crumbsFor(id, folders);
  const known = useMemo(() => [...state.rootFolders, ...Object.values(state.branches).flatMap((b) => b.items)].find((r) => r.kind === 'folder' && r.folderId === id), [state.rootFolders, state.branches, id]);
  const folderRow: Row = known || { kind: 'folder', id, folderId: id, parentId: folder?.parentId || '', name, path: folder?.path || name };

  const open = useCallback((row: Row) => {
    tap('light');
    tree.setLastOpened(row.conversationUuid);
    router.push({ pathname: '/conversation/[uuid]', params: { uuid: row.conversationUuid } });
  }, []);
  const reveal = useCallback(async (row: Row) => {
    try {
      const target = await tree.reveal('conversation', row.conversationUuid);
      if (target.node !== id) router.push({ pathname: '/folder/[id]', params: { id: target.node } });
    } catch (error) {
      showToast(apiErrorText(error));
    }
  }, [id]);
  const actions = useTreeActions({ open, reveal: (row) => void reveal(row), startSelect: (row) => selection.start(row) });

  /** 跳回任意上级：根级回到 Tab；目录在栈里时 dismissTo，否则替换。 */
  const jump = (target: string) => {
    if (target === id) return;
    if (!target) {
      router.dismissAll();
      return;
    }
    router.dismissTo({ pathname: '/folder/[id]', params: { id: target } });
  };

  const plusItems = actions.menuFor({ kind: 'root', folderId: system ? '' : id });
  const moreItems = system ? actions.menuFor({ kind: 'system', id, name }) : actions.menuFor(folderRow);
  const selectItem = { key: 'select-here', label: '多选整理', onPress: () => selection.start() };
  const anchor = { x: width - 12, y: insets.top + 4, height: NAV_ROW_HEIGHT - 8, align: 'right' as const };

  const header = (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.crumbs} testID="breadcrumbs">
        <Press onPress={() => jump('')} style={styles.crumb} testID="crumb-root" accessibilityRole="link">
          <Text style={[styles.crumbText, { color: theme.subtle }]}>会话</Text>
        </Press>
        {crumbs.map((c, i) => (
          <View key={c.id} style={styles.crumbWrap}>
            <Icon as={ChevronRight} size={13} color={theme.disabled} />
            <Press onPress={() => jump(c.id)} disabled={i === crumbs.length - 1} style={styles.crumb} testID={`crumb-${i}`} accessibilityRole="link">
              <Text numberOfLines={1} style={[styles.crumbText, { color: i === crumbs.length - 1 ? theme.textStrong : theme.subtle, fontWeight: i === crumbs.length - 1 ? '600' : '400' }]}>
                {c.name}
              </Text>
            </Press>
          </View>
        ))}
      </ScrollView>
      {selection.active ? (
        <SelectionHeader
          count={selection.rows.length}
          allSelected={selection.rows.length > 0 && selection.rows.length === levelRows.current.length}
          onAll={() => (selection.rows.length === levelRows.current.length ? selection.setAll([]) : selection.setAll(levelRows.current))}
          onDone={selection.stop}
        />
      ) : null}
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]} testID="folder-page">
      <View style={{ paddingTop: insets.top, backgroundColor: theme.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line }}>
        <View style={styles.nav}>
          <IconButton theme={theme} icon={ChevronLeft} size={26} label="返回" testID="back" onPress={() => router.back()} />
          <Text numberOfLines={1} style={[styles.title, { color: theme.textStrong }]} accessibilityRole="header">
            {name}
          </Text>
          {id !== ARCHIVE ? <IconButton theme={theme} icon={Plus} label="新建" testID="folder-plus" onPress={() => setMenu('plus')} /> : <View style={{ width: 40 }} />}
          <IconButton theme={theme} icon={Ellipsis} label="更多" testID="folder-more" onPress={() => setMenu('more')} />
        </View>
      </View>
      <TreeLevelList
        nodeId={id}
        header={header}
        contentBottom={insets.bottom + (selection.active ? 110 : 24)}
        highlight={state.lastOpened}
        selecting={selection.active}
        isPicked={selection.has}
        onToggle={selection.toggle}
        onRows={(rows) => (levelRows.current = rows)}
        onOpenFolder={openFolderPage}
        onOpenConversation={actions.openConversation}
        onLongPress={(row, at) => actions.openMenu(row, at)}
        testID="folder-list"
      />
      {selection.active ? (
        <SelectionBar
          rows={selection.rows}
          bottomInset={insets.bottom}
          onMove={() => actions.moveRows(selection.rows, selection.stop)}
          onArchive={() => void actions.archiveRows(selection.rows).then(() => selection.stop())}
          onDelete={() => actions.deleteRows(selection.rows, selection.stop)}
        />
      ) : null}
      <ActionMenu visible={menu === 'plus'} anchor={anchor} title="新建" items={plusItems} onClose={() => setMenu(null)} />
      <ActionMenu visible={menu === 'more'} anchor={anchor} title={system ? name : folderRow.path || name} items={[...moreItems.filter((m) => m.key !== 'select'), selectItem]} onClose={() => setMenu(null)} />
      {actions.element}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  nav: { height: NAV_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, gap: 2 },
  title: { flex: 1, fontSize: 17, fontWeight: '600', marginLeft: 2 },
  crumbs: { alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6 },
  crumbWrap: { flexDirection: 'row', alignItems: 'center' },
  crumb: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 6, maxWidth: 220 },
  crumbText: { fontSize: 13.5 },
});
