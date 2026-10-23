/**
 * 多选整理（App 新增）：选择模式的顶部条（已选 N / 全选 / 完成）与底部操作条（移动 / 归档 / 删除）。
 * 目录可以和会话一起移动；归档、删除只对会话（含目录时禁用并说明）；运行中的会话不能删除。
 */
import { Archive, ArchiveRestore, FolderInput, Trash2 } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, Press, tap } from '../primitives';
import { elevation, useTheme } from '../theme';
import { type Row, rowId, selectionAbilities } from '../../tree/treeModel';

export function useSelection() {
  const [active, setActive] = useState(false);
  const [picked, setPicked] = useState<Map<string, Row>>(new Map());
  const keyOf = (row: Row) => `${row.kind}:${rowId(row)}`;
  const start = useCallback((row?: Row) => {
    tap('medium');
    setActive(true);
    setPicked(row ? new Map([[`${row.kind}:${rowId(row)}`, row]]) : new Map());
  }, []);
  const stop = useCallback(() => {
    setActive(false);
    setPicked(new Map());
  }, []);
  const toggle = useCallback((row: Row) => {
    tap('select');
    setPicked((current) => {
      const next = new Map(current);
      const key = `${row.kind}:${rowId(row)}`;
      if (next.has(key)) next.delete(key);
      else next.set(key, row);
      return next;
    });
  }, []);
  const setAll = useCallback((rows: Row[]) => setPicked(new Map(rows.map((r) => [`${r.kind}:${rowId(r)}`, r]))), []);
  return { active, picked, rows: [...picked.values()], start, stop, toggle, setAll, has: (row: Row) => picked.has(keyOf(row)) };
}

export function SelectionHeader({ count, allSelected, onAll, onDone }: { count: number; allSelected: boolean; onAll(): void; onDone(): void }) {
  const theme = useTheme();
  return (
    <View style={[styles.header, { backgroundColor: theme.bg, borderBottomColor: theme.line }]} testID="selection-header">
      <Press onPress={onAll} style={styles.headerBtn} testID="select-all">
        <Text style={[styles.headerBtnText, { color: theme.text }]}>{allSelected ? '全不选' : '全选'}</Text>
      </Press>
      <Text style={[styles.headerTitle, { color: theme.textStrong }]}>{count ? `已选 ${count} 项` : '选择项目'}</Text>
      <Press onPress={onDone} style={styles.headerBtn} testID="select-done">
        <Text style={[styles.headerBtnText, { color: theme.textStrong, fontWeight: '600' }]}>完成</Text>
      </Press>
    </View>
  );
}

export function SelectionBar({ rows, bottomInset, onMove, onArchive, onDelete }: { rows: Row[]; bottomInset: number; onMove(): void; onArchive(): void; onDelete(): void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const can = selectionAbilities(rows);
  const hint = !can.count ? '长按或点选项目' : can.hasFolders ? '目录只能移动；归档和删除只对会话' : can.runningCount ? `${can.runningCount} 个运行中的会话不能删除` : '';
  return (
    <View style={[styles.bar, { backgroundColor: theme.panel, borderTopColor: theme.line, paddingBottom: Math.max(bottomInset, insets.bottom, 8) }, elevation(theme, 'card')]} testID="selection-bar">
      {hint ? <Text numberOfLines={1} style={[styles.hint, { color: theme.muted }]}>{hint}</Text> : null}
      <View style={styles.actions}>
        <Action icon={FolderInput} label="移动" disabled={!can.canMove} onPress={onMove} testID="bulk-move" />
        <Action icon={can.allArchived ? ArchiveRestore : Archive} label={can.allArchived ? '取消归档' : '归档'} disabled={!can.canArchive} onPress={onArchive} testID="bulk-archive" />
        <Action icon={Trash2} label="删除" destructive disabled={!can.canDelete} onPress={onDelete} testID="bulk-delete" />
      </View>
    </View>
  );
}

function Action({ icon, label, disabled, destructive, onPress, testID }: { icon: any; label: string; disabled?: boolean; destructive?: boolean; onPress(): void; testID: string }) {
  const theme = useTheme();
  const color = disabled ? theme.disabled : destructive ? theme.danger : theme.text;
  return (
    <Press onPress={onPress} disabled={disabled} style={styles.action} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled) }} testID={testID}>
      <Icon as={icon} size={21} color={color} />
      <Text style={[styles.actionText, { color }]}>{label}</Text>
    </Press>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', height: 48, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  headerBtn: { minWidth: 64, height: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  headerBtnText: { fontSize: 15.5 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6 },
  hint: { fontSize: 12, textAlign: 'center', paddingBottom: 2 },
  actions: { flexDirection: 'row', justifyContent: 'space-around' },
  action: { minWidth: 88, height: 52, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 12 },
  actionText: { fontSize: 12.5 },
});
