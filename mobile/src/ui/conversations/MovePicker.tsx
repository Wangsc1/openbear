/**
 * 目录选择器（移动到… / 删除目录时选迁移目标）：
 * - 按完整路径搜索；根级 / 临时会话 / 任意目录；所选目录自身与子孙禁用（多选时取并集）；
 * - App 新增：选择器里可以直接新建目录（建在当前选中的目录下，或根级），建好后自动选中；
 * - 移动单个已归档会话：取消归档、更新系统提示词两个选项（默认都开）。
 * 提交逻辑由调用方（useTreeActions）负责：onSubmit(targetFolderId, options)。
 */
import { Folder, FolderPlus, MessagesSquare, RefreshCw } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { SwitchRow } from '../Form';
import { Icon, Press } from '../primitives';
import { Sheet } from '../Sheet';
import { radius, useTheme } from '../theme';
import { showToast } from '../Toast';
import { blockedTargets, folderDepth, matchFolders, type Row } from '../../tree/treeModel';
import { apiErrorText, tree, useTree } from '../../tree/treeStore';
import { SearchField } from './ListControls';
import { PromptSheet } from './treeKit';

export type MoveMode = 'move' | 'delete';
export type MoveOptions = { unarchive: boolean; updateSnapshots: boolean };

export function MovePicker({ visible, mode, sources, busy, onSubmit, onClose }: { visible: boolean; mode: MoveMode; sources: Row[]; busy?: boolean; onSubmit(target: string, options: MoveOptions): void; onClose(): void }) {
  const theme = useTheme();
  const state = useTree();
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState('');
  const [unarchive, setUnarchive] = useState(true);
  const [updateSnapshots, setUpdateSnapshots] = useState(true);
  const [creating, setCreating] = useState(false);

  const single = sources.length === 1 ? sources[0] : null;
  const onlyConversations = sources.every((r) => r.kind === 'conversation');
  const onlyFolders = sources.every((r) => r.kind === 'folder');
  const archivedSingle = mode === 'move' && single?.kind === 'conversation' && Boolean(single.archived);

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setUnarchive(true);
    setUpdateSnapshots(true);
    // 默认选中当前所在位置（与 Web showMove 相同）
    const first = sources[0];
    setTarget(mode === 'delete' ? String(first?.parentId || '') : first?.kind === 'folder' ? String(first.parentId || '') : String(first?.folderId || ''));
    if (!state.foldersLoaded) void tree.loadFolders();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = useMemo(() => blockedTargets(sources, state.folders), [sources, state.folders]);
  const list = useMemo(() => matchFolders(state.folders, query), [state.folders, query]);
  const rootLabel = onlyConversations ? '临时会话' : onlyFolders ? '根级目录' : '根级目录 / 临时会话';
  const rootDetail = onlyConversations ? '不放在任何目录里' : onlyFolders ? '作为顶层目录' : '目录放到顶层，会话变为临时会话';
  const title = mode === 'delete' ? '迁移目录内容后删除' : sources.length > 1 ? `移动 ${sources.length} 项到…` : '移动到…';
  const targetPath = target ? state.folders.find((f) => f.folderId === target)?.path || '所选目录' : rootLabel;

  const footer = (
    <View style={styles.footer}>
      <Text numberOfLines={1} style={[styles.targetText, { color: theme.muted }]}>
        {mode === 'delete' ? '迁移到：' : '目标：'}
        <Text style={{ color: theme.text }}>{targetPath}</Text>
      </Text>
      <Press
        testID="move-submit"
        disabled={busy || blocked.has(target)}
        onPress={() => onSubmit(target, { unarchive, updateSnapshots })}
        style={[styles.submit, { backgroundColor: theme.button, opacity: busy || blocked.has(target) ? 0.55 : 1 }]}
      >
        {busy ? <ActivityIndicator color={theme.buttonText} /> : <Text style={[styles.submitText, { color: theme.buttonText }]}>{mode === 'delete' ? '下一步' : '移动'}</Text>}
      </Press>
    </View>
  );

  return (
    <>
      <Sheet visible={visible} title={title} subtitle={single ? String(single.name || single.title || '') : undefined} onClose={() => !busy && onClose()} full footer={footer} testID="move-picker">
        <View style={styles.tools}>
          <SearchField theme={theme} value={query} onChange={setQuery} placeholder="搜索完整目录路径" style={{ flex: 1 }} testID="move-search" />
          <Press onPress={() => setCreating(true)} style={[styles.newBtn, { borderColor: theme.border }]} accessibilityRole="button" accessibilityLabel="新建目录" testID="move-new-folder">
            <Icon as={FolderPlus} size={18} color={theme.text} />
            <Text style={{ color: theme.text, fontSize: 14 }}>新建</Text>
          </Press>
        </View>
        {mode === 'delete' && single ? (
          <Text style={[styles.note, { color: theme.muted }]}>目录「{single.name}」中的子目录与会话会迁移到所选位置；聊天内容不会删除。</Text>
        ) : null}
        {archivedSingle ? (
          <View style={[styles.options, { borderColor: theme.line }]}>
            <SwitchRow label="取消归档" detail="移动后恢复为普通会话。" value={unarchive} onChange={setUnarchive} testID="move-unarchive" />
            <SwitchRow label="更新系统提示词" detail="按目标目录和当前模板重新组装，现有提示词缓存将失效；运行中的会话跳过更新。" value={updateSnapshots} onChange={setUpdateSnapshots} testID="move-update" />
          </View>
        ) : null}
        <FlatList
          data={list}
          keyExtractor={(f) => f.folderId}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={30}
          ListHeaderComponent={
            !query.trim() ? (
              <PickRow icon={onlyConversations ? MessagesSquare : Folder} label={rootLabel} detail={rootDetail} selected={target === ''} onPress={() => setTarget('')} testID="move-target-root" />
            ) : null
          }
          ListEmptyComponent={
            !state.foldersLoaded ? (
              <Press onPress={() => void tree.loadFolders()} style={styles.retry} testID="move-retry">
                <Icon as={RefreshCw} size={16} color={theme.muted} />
                <Text style={{ color: theme.muted }}>目录列表加载失败，点击重试</Text>
              </Press>
            ) : query.trim() ? (
              <Text style={[styles.note, { color: theme.muted, textAlign: 'center', paddingTop: 24 }]}>没有匹配的目录</Text>
            ) : null
          }
          renderItem={({ item }) => (
            <PickRow
              icon={Folder}
              label={query.trim() ? item.path : item.name}
              detail={query.trim() ? undefined : folderDepth(item) ? item.path : undefined}
              depth={query.trim() ? 0 : folderDepth(item)}
              selected={target === item.folderId}
              disabled={blocked.has(item.folderId)}
              onPress={() => setTarget(item.folderId)}
              testID={`move-target-${item.folderId.slice(0, 8)}`}
            />
          )}
        />
      </Sheet>
      <PromptSheet
        visible={creating}
        title="新建目录"
        hint={`建在「${target ? targetPath : '根级'}」下；目录可以继续包含任意深度的子目录和会话。`}
        placeholder="目录名称"
        submitLabel="创建"
        onClose={() => setCreating(false)}
        onSubmit={async (name) => {
          try {
            const folder = await tree.createFolder(name, blocked.has(target) ? '' : target);
            await tree.loadFolders();
            if (folder?.folderId) setTarget(String(folder.folderId));
            showToast('目录已创建');
          } catch (e) {
            throw new Error(apiErrorText(e));
          }
        }}
      />
    </>
  );
}

function PickRow({ icon, label, detail, depth = 0, selected, disabled, onPress, testID }: { icon: any; label: string; detail?: string; depth?: number; selected: boolean; disabled?: boolean; onPress(): void; testID?: string }) {
  const theme = useTheme();
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: Boolean(disabled) }}
      style={[styles.pick, { paddingLeft: 16 + Math.min(6, depth) * 16 }, selected && { backgroundColor: theme.button }, disabled && { opacity: 0.4 }]}
      pressedStyle={{ backgroundColor: selected ? theme.button : theme.hover }}
    >
      <Icon as={icon} size={18} strokeWidth={1.8} color={selected ? theme.buttonText : theme.subtle} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[styles.pickLabel, { color: selected ? theme.buttonText : theme.text }]}>
          {label}
        </Text>
        {detail ? (
          <Text numberOfLines={1} style={[styles.pickDetail, { color: selected ? theme.buttonText : theme.muted }]}>
            {disabled ? '不能移动到自身或子目录' : detail}
          </Text>
        ) : disabled ? (
          <Text style={[styles.pickDetail, { color: theme.muted }]}>不能移动到自身或子目录</Text>
        ) : null}
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  tools: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  newBtn: { height: 38, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth },
  note: { fontSize: 13, lineHeight: 19, paddingHorizontal: 20, paddingBottom: 8 },
  options: { marginHorizontal: 12, marginBottom: 6, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingVertical: 6, paddingRight: 16, marginHorizontal: 8, borderRadius: 10 },
  pickLabel: { fontSize: 15.5 },
  pickDetail: { fontSize: 12, marginTop: 1 },
  retry: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 24 },
  footer: { gap: 8 },
  targetText: { fontSize: 13 },
  submit: { height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 16, fontWeight: '600' },
});
