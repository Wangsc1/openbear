/**
 * 平板会话侧栏（方向稿 ⑦ 左栏）：顶部“会话”(22/700) + 搜索/新建图标 + 筛选 Chip（全部/运行中/待处理）+
 * 分组（需要你处理 / 置顶 / 各目录 + 计数）+ 紧凑行。点搜索图标展开搜索框。
 */
import { router } from 'expo-router';
import { Folder, Pin, Plus, Search, TriangleAlert } from 'lucide-react-native';
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { ConversationSummary } from '../../data/session';
import { ActionMenu } from '../ActionMenu';
import { Icon, IconButton, tap } from '../primitives';
import { useTheme } from '../theme';
import { ConversationRow } from './ConversationRow';
import { FilterChips, SearchField } from './ListControls';
import { type Section, sidebarSections } from './listModel';
import { useConversationList } from './useConversationList';

type Entry = { kind: 'header'; key: string; section: Section; index: number } | { kind: 'row'; key: string; item: ConversationSummary; prevUuid: string };

export function SidebarConversationList({ selected, onSelect, topInset, bottomInset }: { selected: string; onSelect(uuid: string): void; topInset: number; bottomInset: number }) {
  const theme = useTheme();
  const list = useConversationList();
  const [searching, setSearching] = useState(false);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    sidebarSections(list.visible, list.sort).forEach((section, index) => {
      out.push({ kind: 'header', key: `h:${section.key}`, section, index });
      section.items.forEach((item, i) => out.push({ kind: 'row', key: item.conversationUuid, item, prevUuid: i === 0 ? '' : section.items[i - 1].conversationUuid }));
    });
    return out;
  }, [list.visible, list.sort]);

  const open = useCallback(
    (item: ConversationSummary) => {
      tap('select');
      onSelect(item.conversationUuid);
    },
    [onSelect],
  );
  const longPress = useCallback((item: ConversationSummary, at: { x: number; y: number }) => list.openMenu(item, at), [list.openMenu]);

  const renderItem = useCallback(
    ({ item: entry }: { item: Entry }) => {
      if (entry.kind === 'header') {
        const { section } = entry;
        const glyph = section.icon === 'alert' ? TriangleAlert : section.icon === 'pin' ? Pin : Folder;
        return (
          <View style={[styles.folder, entry.index > 0 && { marginTop: 6 }]}>
            <Icon as={glyph} size={15} strokeWidth={1.9} color={section.icon === 'alert' ? theme.warning : theme.subtle} />
            <Text numberOfLines={1} style={[styles.folderText, { color: theme.subtle }]}>
              {section.title}
            </Text>
            {section.count != null ? <Text style={[styles.folderCount, { color: theme.muted }]}>{section.count}</Text> : null}
          </View>
        );
      }
      const isSel = entry.item.conversationUuid === selected;
      return (
        <ConversationRow
          item={entry.item}
          theme={theme}
          compact
          now={list.now}
          selected={isSel}
          hideSeparator={!entry.prevUuid || entry.prevUuid === selected}
          onPress={open}
          onLongPress={longPress}
        />
      );
    },
    [theme, list.now, selected, open, longPress],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.sidebar, paddingTop: topInset }]} testID="conversation-sidebar">
      <View style={styles.head}>
        <Text style={[styles.h, { color: theme.textStrong }]} accessibilityRole="header">
          会话
        </Text>
        <IconButton theme={theme} icon={Search} label="搜索会话" active={searching} testID="sidebar-search" onPress={() => {
          setSearching((v) => !v);
          if (searching) list.setQuery('');
        }} />
        <IconButton theme={theme} icon={Plus} label="新会话" testID="sidebar-new" onPress={() => router.push('/conversation/new')} />
      </View>
      {searching ? <SearchField theme={theme} value={list.query} onChange={list.setQuery} autoFocus style={styles.search} testID="sidebar-search-input" /> : null}
      <FilterChips theme={theme} counts={list.counts} filter={list.filter} onChange={list.setFilter} showFolders={false} style={styles.chips} />
      <FlatList
        data={entries}
        keyExtractor={(e) => e.key}
        renderItem={renderItem}
        extraData={selected}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: bottomInset + 16 }}
        refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={theme.muted} colors={[theme.textStrong]} progressBackgroundColor={theme.panel} />}
        ListEmptyComponent={
          list.session.conversationsLoaded ? (
            <Text style={[styles.empty, { color: theme.muted }]}>{list.query || list.filter.kind !== 'all' ? '没有符合条件的会话' : '还没有会话'}</Text>
          ) : (
            <ActivityIndicator style={{ marginTop: 32 }} color={theme.muted} />
          )
        }
      />
      <ActionMenu visible={Boolean(list.menu)} anchor={list.menu?.anchor ?? null} title={list.menu?.item.title} items={list.menuItems} dim onClose={list.closeMenu} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingLeft: 20, paddingRight: 10, paddingTop: 10, paddingBottom: 4 },
  h: { flex: 1, fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  search: { marginHorizontal: 14, marginTop: 4, marginBottom: 6 },
  chips: { paddingTop: 6, paddingBottom: 10 },
  folder: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingLeft: 22, paddingRight: 20 },
  folderText: { flex: 1, fontSize: 13, fontWeight: '600' },
  folderCount: { fontSize: 13, fontVariant: ['tabular-nums'] },
  empty: { fontSize: 13.5, textAlign: 'center', paddingTop: 40 },
});
