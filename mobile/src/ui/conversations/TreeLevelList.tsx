/**
 * 目录的一级（手机“目录”视图根级与每个目录页共用，像系统“文件”App 一样逐级进入）：
 * 先列子目录（会话数、待处理数、置顶、推荐管理标识），再列本级会话；根级额外有“临时会话”“已归档”两个系统节点。
 * 分页“加载更多”、“此目录为空”、“加载失败，点击重试”；下拉刷新；选择模式下点选/全选。
 */
import { FolderX, RefreshCw } from 'lucide-react-native';
import React, { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { draftRow, useDraft } from '../../tree/draft';
import { levelRows, pathOf, folderMap, type Row, rowId, waitingCountFor, ARCHIVE, TEMP } from '../../tree/treeModel';
import { tree, useBranch, useTree, useTreeIndex } from '../../tree/treeStore';
import { formatListTime } from './listModel';
import { useNow } from './useConversationList';
import { useTheme } from '../theme';
import { FolderRow, InlineRow, ListNotice, TreeConversationRow, type PressAt } from './treeKit';

type Props = {
  nodeId: string;
  header?: React.ReactElement | null;
  contentTop?: number;
  contentBottom?: number;
  highlight?: string;
  selecting?: boolean;
  isPicked?(row: Row): boolean;
  onToggle?(row: Row): void;
  onOpenFolder(row: Row): void;
  onOpenConversation(row: Row): void;
  onLongPress(row: Row, at: PressAt): void;
  /** 选择模式“全选”用：当前层可选的行 */
  onRows?(rows: Row[]): void;
  testID?: string;
};

export function TreeLevelList({ nodeId, header, contentTop = 0, contentBottom = 0, highlight, selecting, isPicked, onToggle, onOpenFolder, onOpenConversation, onLongPress, onRows, testID }: Props) {
  const theme = useTheme();
  const state = useTree();
  const index = useTreeIndex();
  const branch = useBranch(nodeId);
  const draft = useDraft();
  const now = useNow(60000);
  const folders = useMemo(() => folderMap(state.folders), [state.folders]);
  const draftHere = draft && nodeId !== ARCHIVE && (draft.folderId || TEMP) === (nodeId || '__none__') ? draftRow(draft, pathOf(draft.folderId, folders)) : null;
  const rows = useMemo(
    () => levelRows(nodeId, state.rootFolders, branch, { temporary: state.temporaryCount, archived: state.archivedCount }, draftHere, index),
    [nodeId, state.rootFolders, branch, state.temporaryCount, state.archivedCount, draftHere?.folderId, index], // eslint-disable-line react-hooks/exhaustive-deps
  );
  React.useEffect(() => {
    onRows?.(rows.filter((r) => r.kind !== 'system' && !r.local));
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const [refreshing, setRefreshing] = React.useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await tree.refresh();
      if (nodeId) await tree.loadBranch(nodeId, { force: true });
    } finally {
      setRefreshing(false);
    }
  }, [nodeId]);

  type Entry = { key: string; row?: Row; inline?: 'more' | 'error' | 'empty' };
  const entries = useMemo(() => {
    const out: Entry[] = rows.map((row) => ({ key: `${row.kind}:${row.kind === 'system' ? row.id : rowId(row)}`, row }));
    if (nodeId) {
      if (branch.error) out.push({ key: 'error', inline: 'error' });
      else if (branch.loaded && !rows.length) out.push({ key: 'empty', inline: 'empty' });
      if (branch.hasMore) out.push({ key: 'more', inline: 'more' });
    }
    return out;
  }, [rows, nodeId, branch.error, branch.loaded, branch.hasMore]);

  const renderItem = useCallback(
    ({ item }: { item: Entry }) => {
      if (item.inline) {
        return <InlineRow theme={theme} kind={item.inline} message={branch.error} busy={item.inline === 'more' && branch.loading} onPress={() => void tree.loadBranch(nodeId, item.inline === 'more' ? { append: true } : { force: true })} />;
      }
      const row = item.row as Row;
      if (row.kind === 'folder' || row.kind === 'system') {
        return (
          <FolderRow
            row={row}
            theme={theme}
            waiting={waitingCountFor(row, index)}
            selecting={selecting}
            checked={isPicked?.(row)}
            disabled={selecting && row.kind === 'system'}
            onPress={selecting ? (r) => r.kind !== 'system' && onToggle?.(r) : onOpenFolder}
            onLongPress={onLongPress}
          />
        );
      }
      const time = row.archived ? formatListTime(Number(row.archivedAt || 0) * 1000, now) : formatListTime(Math.max(Number(row.lastConversationAt || 0), Number(row.createdAt || 0)) * 1000, now);
      return (
        <TreeConversationRow
          row={row}
          theme={theme}
          time={row.local ? '草稿' : time}
          path={nodeId === ARCHIVE ? row.path : undefined}
          generating={state.generating.has(String(row.conversationUuid))}
          selecting={selecting}
          checked={isPicked?.(row)}
          disabled={selecting && row.local}
          highlighted={!selecting && highlight === row.conversationUuid}
          onPress={selecting ? (r) => !r.local && onToggle?.(r) : onOpenConversation}
          onLongPress={onLongPress}
        />
      );
    },
    [theme, branch.error, branch.loading, nodeId, index, selecting, isPicked, onToggle, onOpenFolder, onLongPress, now, state.generating, highlight, onOpenConversation],
  );

  const loadingFirst = nodeId ? !branch.loaded && !branch.error : !state.ready && !state.error;
  return (
    <FlatList
      testID={testID}
      data={entries}
      keyExtractor={(e) => e.key}
      renderItem={renderItem}
      extraData={[selecting, highlight, isPicked]}
      ListHeaderComponent={header}
      ListEmptyComponent={
        loadingFirst ? (
          <ActivityIndicator style={styles.loading} color={theme.muted} testID="tree-loading" />
        ) : !nodeId && state.error ? (
          <ListNotice theme={theme} icon={RefreshCw} title="会话树加载失败" hint={state.error} action="重试" onAction={() => void tree.refresh()} />
        ) : (
          <ListNotice theme={theme} icon={FolderX} title="此目录为空" />
        )
      }
      ItemSeparatorComponent={Separator}
      contentContainerStyle={{ paddingTop: contentTop, paddingBottom: contentBottom }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} progressViewOffset={contentTop} tintColor={theme.muted} colors={[theme.textStrong]} progressBackgroundColor={theme.panel} />}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      initialNumToRender={16}
      windowSize={11}
    />
  );
}

function Separator() {
  const theme = useTheme();
  return <View style={[styles.sep, { backgroundColor: theme.line }]} />;
}

const styles = StyleSheet.create({
  loading: { paddingTop: 64 },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 62 },
});
