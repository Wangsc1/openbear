/**
 * 上下文编辑器（B4-23～B4-43，对应 Web ContextEditor.vue）：全屏页面。
 *  - 手机：两层——“目录”（请求设置 + 系统提示词 / 工具定义 / 消息序列，可搜索、多选批量删除、新增消息）
 *          → 点一项进入“正文”（结构化 / JSON / 差异 / 预览）；系统返回从正文回到目录，再返回离开编辑器；
 *  - 平板（≥ 768）：目录与正文并排；
 *  - 顶栏：返回、撤销/重做、“⋯”（导入 JSON、导出完整包、加载最新、重新读取）；
 *  - 底栏：改动计数与保存状态、保存草稿、创建独立分支（填标题，满足条件才可用）。
 * 运行中不可编辑（会话运行中时只读提示，并禁止创建分支）；草稿会话没有入口（面板里禁用）。
 */
import { router, useNavigation } from 'expo-router';
import { ChevronLeft, ChevronRight, CopyPlus, Download, Ellipsis, GitBranch, ListChecks, Plus, Redo2, RefreshCw, Save, Undo2, Upload, X } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useConversationSnapshot, useSession } from '../data/session';
import { isDraftConversation } from '../panel/hooks';
import { ActionMenu, type MenuAnchor, type MenuItem } from '../ui/ActionMenu';
import { ConfirmSheet, Icon, IconButton, NavRow, OptionSheet, Press, SearchField, Sheet, TextField, showToast, tap, useTheme } from '../ui';
import type { Theme } from '../ui/theme';
import { type DocTab, DocumentPane } from './DocumentPane';
import { EntityEditor } from './EntityEditor';
import * as M from './model';
import { Banner, CheckBox, ImpactList, RadioRow, RoleTag, SmallButton } from './parts';
import { useContextEditor } from './useContextEditor';

export function ContextEditorScreen({ uuid }: { uuid: string }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  const session = useSession();
  const summary = session.conversations.find((c) => c.conversationUuid === uuid);
  // 对话页仍在栈里时 store 共用（不额外建连接）；运行状态以快照为准，回退到会话列表
  const store = useMemo(() => session.storeFor(uuid), [session.storeFor, uuid]); // eslint-disable-line react-hooks/exhaustive-deps
  const snapshot = useConversationSnapshot(store);
  const busy = Boolean(snapshot?.running ?? summary?.running);
  const editor = useContextEditor(uuid, busy);
  const { state, loading, pending, error, notice } = editor;

  const [layer, setLayer] = useState<'outline' | 'document'>('outline');
  const [selected, setSelected] = useState<M.Selected>('system');
  const [tab, setTab] = useState<DocTab>('structured');
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [entity, setEntity] = useState<M.EntityDraft | null>(null);
  const [dialog, setDialog] = useState<M.Dialog | null>(null);
  const [deleteMode, setDeleteMode] = useState<'paired' | 'only'>('paired');
  const [thinkingScope, setThinkingScope] = useState<'suffix' | 'one'>('suffix');
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchTitle, setBranchTitle] = useState('');
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [modelPick, setModelPick] = useState(false);
  const [modePick, setModePick] = useState(false);
  const [snapshotInfo, setSnapshotInfo] = useState(false);
  const [leaveAsk, setLeaveAsk] = useState(false);

  const draft = isDraftConversation(uuid);
  const doc = state?.working;
  const changes = useMemo(() => (state ? M.diffDocument(state.baseline, state.working) : []), [state]);
  const saved = Boolean(state && state.savedEpoch === state.epoch);
  const hints = useMemo(() => (doc ? M.localIssues(doc) : []), [doc]);
  const filtered = useMemo(() => (doc ? M.filterEntries(doc, search) : []), [doc, search]);
  const title = summary?.title || snapshot?.title || '';

  // 选中的消息被删除/撤销后回到系统提示词（同 Web）
  useEffect(() => {
    if (!doc) return;
    if (selected !== 'system' && selected !== 'tools' && !doc.entries.some((e) => e.entryId === selected)) setSelected('system');
    setChecked((list) => {
      const next = list.filter((id) => doc.entries.some((e) => e.entryId === id));
      return next.length === list.length ? list : next;
    });
  }, [doc, selected]);

  const choose = useCallback(
    (id: M.Selected) => {
      if (!editor.flushText()) return;
      setSelected(id);
      if (tab === 'diff' || tab === 'preview') setTab('structured');
      setLayer('document');
    },
    [editor, tab],
  );

  const navigation = useNavigation();
  const leaving = useRef(false);
  const leave = useCallback(() => {
    editor.flushText();
    leaving.current = true;
    router.back();
  }, [editor]);

  const back = useCallback(() => {
    if (!wide && layer === 'document') {
      editor.flushText();
      setLayer('outline');
      return true;
    }
    if (selecting) {
      setSelecting(false);
      setChecked([]);
      return true;
    }
    // 有未保存到服务器的改动：提醒（本页编辑稿在同一 App 进程内保留，回来可继续）
    if (state && !saved && changes.length) {
      setLeaveAsk(true);
      return true;
    }
    leave();
    return true;
  }, [wide, layer, selecting, state, saved, changes.length, leave, editor]);

  // 系统返回 / 手势返回：WebView 编辑器有焦点时 BackHandler 收不到，统一在页面将被移除前拦截
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', back);
    const unsubscribe = navigation.addListener('beforeRemove', (event: any) => {
      if (leaving.current) return;
      const action = event?.data?.action;
      // 创建分支后的 replace、退出登录的 dismissAll 等程序跳转直接放行
      if (action && action.type !== 'GO_BACK' && action.type !== 'POP') return;
      event.preventDefault();
      back();
    });
    return () => {
      sub.remove();
      unsubscribe();
    };
  }, [back, navigation]);

  const addEntry = (role: 'user' | 'assistant' | 'tool') => {
    const id = `edited-${M.localId()}`;
    if (editor.apply((s) => M.addEntry(s, role, selected, id))) choose(id);
  };

  const saveEntity = (d: M.EntityDraft): string | null => {
    let message: string | null = null;
    const ok = editor.apply((s) => {
      try {
        return M.saveEntity(s, d);
      } catch (e: any) {
        message = String(e?.message || e);
        return s;
      }
    });
    if (message) return message;
    if (!ok) return '保存失败';
    setEntity(null);
    if (d.kind === 'tool') {
      setSelected('tools');
      setTab('structured');
    }
    return null;
  };

  const confirm = () => {
    if (!dialog) return;
    const d = dialog;
    setDialog(null);
    if (d.kind === 'refresh') {
      editor.apply((s) => M.confirmDialog(s, d));
      setSelected('system');
      setTab('structured');
      setLayer('outline');
      editor.setNotice('已载入最新上下文；原会话及服务器旧草稿未改动');
      return;
    }
    editor.apply((s) => M.confirmDialog(s, d, { deleteMode, thinkingScope }));
    if (d.kind === 'entries') {
      setChecked([]);
      setSelecting(false);
    }
    if (d.kind === 'call' && deleteMode === 'only') showToast('已转为原始实验模式（只保存）');
  };

  const createBranch = async () => {
    const conversation = await editor.createBranch(branchTitle);
    if (!conversation) return;
    setBranchOpen(false);
    leaving.current = true;
    showToast('已创建独立分支');
    void session.refresh().catch(() => undefined);
    router.replace({ pathname: '/conversation/[uuid]', params: { uuid: conversation.conversationUuid } });
  };

  const menuItems: MenuItem[] = [
    { key: 'import', label: '导入 JSON…', icon: Upload, onPress: () => void editor.importPackage().then((ok) => ok && (setSelected('system'), setLayer('outline'))) },
    { key: 'export', label: '导出完整包', icon: Download, onPress: () => void editor.exportPackage() },
    { key: 'reload', label: '重新读取源会话', icon: RefreshCw, separatorBefore: true, onPress: () => void editor.load() },
    ...(state?.latestSource ? [{ key: 'latest', label: '加载最新上下文…', icon: CopyPlus, onPress: () => setDialog({ kind: 'refresh' }) } as MenuItem] : []),
  ];

  const branchReason = state ? M.branchBlockReason(state, { busy, title: branchTitle || 'x' }) : '';
  const modelLabel = state?.models.find((m) => m.model === state.targetModel);

  // ---------------------------------------------------------------- 顶栏
  const header = (
    <View style={{ paddingTop: insets.top, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line, backgroundColor: theme.glass }}>
      <NavRow
        theme={theme}
        title={!wide && layer === 'document' && doc ? M.selectionLabel(doc, selected) : '上下文编辑'}
        subtitle={!wide && layer === 'document' ? '上下文编辑' : title || '只编辑新分支，不改原始对话'}
        left={<IconButton icon={ChevronLeft} size={26} theme={theme} label={!wide && layer === 'document' ? '返回目录' : '返回对话'} onPress={back} testID="ce-back" />}
        right={
          <>
            <IconButton icon={Undo2} size={20} theme={theme} label="撤销" color={state?.undo.length ? theme.text : theme.disabled} onPress={state?.undo.length ? () => editor.apply((s) => M.history(s, 'undo')) : undefined} testID="ce-undo" />
            <IconButton icon={Redo2} size={20} theme={theme} label="重做" color={state?.redo.length ? theme.text : theme.disabled} onPress={state?.redo.length ? () => editor.apply((s) => M.history(s, 'redo')) : undefined} testID="ce-redo" />
            <Press
              onPress={(e) => setMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, height: 20, align: 'right' })}
              style={styles.navBtn}
              accessibilityRole="button"
              accessibilityLabel="更多操作"
              testID="ce-more"
            >
              <Icon as={Ellipsis} size={22} color={theme.text} />
            </Press>
          </>
        }
      />
    </View>
  );

  if (draft) {
    return (
      <View style={[styles.root, { backgroundColor: theme.bg }]}>
        {header}
        <Text style={[styles.placeholder, { color: theme.muted }]}>草稿会话还没有可编辑的上下文。</Text>
      </View>
    );
  }

  if (!state || !doc) {
    return (
      <View style={[styles.root, { backgroundColor: theme.bg }]} testID="context-editor">
        {header}
        <View style={styles.center}>
          {loading ? (
            <>
              <ActivityIndicator color={theme.muted} />
              <Text style={[styles.placeholder, { color: theme.muted }]}>正在读取会话上下文…</Text>
            </>
          ) : (
            <>
              <Text style={[styles.placeholder, { color: error ? theme.danger : theme.muted }]}>{error || '没有可编辑的上下文'}</Text>
              <SmallButton theme={theme} icon={RefreshCw} label="重试" onPress={() => void editor.load()} testID="ce-retry" />
            </>
          )}
        </View>
      </View>
    );
  }

  // ---------------------------------------------------------------- 目录层
  const outline = (
    <FlatList
      data={filtered}
      keyExtractor={(item) => item.entryId}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      initialNumToRender={30}
      windowSize={7}
      contentContainerStyle={{ paddingBottom: 16 }}
      testID="ce-outline"
      ListHeaderComponent={
        <View>
          {busy ? <Banner theme={theme} tone="warning" text="会话运行中：可以浏览和保存草稿，但不能创建分支；结束后再试。" testID="ce-busy" /> : null}
          {state.latestSource ? (
            <Banner
              theme={theme}
              tone="warning"
              text={`源会话已有新内容（${state.latestSource.baseline.entries.length} 条消息），当前保留的是旧快照上的编辑稿。`}
              action={<SmallButton theme={theme} label="加载最新" disabled={Boolean(pending)} onPress={() => setDialog({ kind: 'refresh' })} testID="ce-load-latest" />}
              testID="ce-latest-banner"
            />
          ) : null}
          <View style={[styles.card, { borderColor: theme.line, backgroundColor: theme.panel }]}>
            <SettingRow theme={theme} label="目标模型" value={modelLabel ? `${modelLabel.label} · ${modelLabel.protocol}` : state.targetModel || '—'} onPress={() => setModelPick(true)} testID="ce-model" />
            <SettingRow theme={theme} label="模式" value={state.mode === 'raw' ? '原始实验（只保存）' : '兼容续聊'} onPress={() => setModePick(true)} testID="ce-mode" divider />
            <SettingRow theme={theme} label="冻结快照" value={`${doc.entries.length} 条消息`} onPress={() => setSnapshotInfo(true)} testID="ce-snapshot" divider />
          </View>
          <View style={[styles.card, { borderColor: theme.line, backgroundColor: theme.panel }]}>
            <OutlineLink theme={theme} label="系统提示词" detail={`${doc.system.length.toLocaleString()} 字符`} active={wide && selected === 'system'} onPress={() => choose('system')} testID="ce-outline-system" />
            <OutlineLink theme={theme} label="工具定义" detail={`${doc.tools.length} 个`} active={wide && selected === 'tools'} onPress={() => choose('tools')} testID="ce-outline-tools" divider />
          </View>
          <View style={styles.groupHead}>
            <Text style={[styles.groupTitle, { color: theme.subtle }]}>{`消息序列 · ${doc.entries.length} 条${search ? ` · ${filtered.length} 条匹配` : ''}`}</Text>
            <Press onPress={() => (setSelecting((v) => !v), setChecked([]))} hitSlop={8} accessibilityRole="button" testID="ce-select-toggle" style={styles.textBtn}>
              <Icon as={ListChecks} size={16} color={theme.subtle} />
              <Text style={[styles.textBtnLabel, { color: theme.subtle }]}>{selecting ? '完成' : '选择'}</Text>
            </Press>
          </View>
          <View style={styles.searchRow}>
            <SearchField theme={theme} value={search} onChange={setSearch} placeholder="搜索消息内容或字段" testID="ce-search" />
          </View>
          <View style={styles.addRow}>
            <SmallButton theme={theme} icon={Plus} label="用户" onPress={() => addEntry('user')} testID="ce-add-user" />
            <SmallButton theme={theme} icon={Plus} label="助手" onPress={() => addEntry('assistant')} testID="ce-add-assistant" />
            <SmallButton theme={theme} icon={Plus} label="结果" onPress={() => addEntry('tool')} testID="ce-add-tool" />
          </View>
          {search && !filtered.length ? <Text style={[styles.placeholder, { color: theme.muted }]}>没有匹配的消息</Text> : null}
        </View>
      }
      renderItem={({ item }) => {
        const index = doc.entries.indexOf(item);
        const on = checked.includes(item.entryId);
        const issue = hints.find((h) => h.entryId === item.entryId && h.severity === 'error');
        return (
          <Press
            onPress={() => (selecting ? setChecked((list) => (on ? list.filter((id) => id !== item.entryId) : [...list, item.entryId])) : choose(item.entryId))}
            onLongPress={() => {
              tap('medium');
              setSelecting(true);
              setChecked((list) => (list.includes(item.entryId) ? list : [...list, item.entryId]));
            }}
            style={[styles.entry, { borderBottomColor: theme.line }, wide && selected === item.entryId && !selecting && { backgroundColor: theme.selected }]}
            pressedStyle={{ backgroundColor: theme.hover }}
            accessibilityRole={selecting ? 'checkbox' : 'button'}
            accessibilityState={selecting ? { checked: on } : undefined}
            testID={`ce-entry-${index}`}
          >
            {selecting ? <CheckBox theme={theme} checked={on} /> : null}
            <View style={styles.flex}>
              <View style={styles.entryHead}>
                <RoleTag theme={theme} role={String(item.message.role || '')} />
                <Text style={[styles.entryNo, { color: theme.muted }]}>{`#${index + 1}`}</Text>
                {issue ? <Text numberOfLines={1} style={[styles.entryIssue, { color: theme.danger }]}>{issue.text}</Text> : null}
              </View>
              <Text numberOfLines={2} style={[styles.snippet, { color: theme.subtle }]}>{M.snippet(item.message)}</Text>
            </View>
          </Press>
        );
      }}
    />
  );

  const selectionBar = selecting ? (
    <View style={[styles.selectionBar, { borderTopColor: theme.line, backgroundColor: theme.panel, paddingBottom: wide ? 10 : Math.max(insets.bottom, 10) }]} testID="ce-selection-bar">
      <Text style={[styles.flex, { color: theme.text, fontSize: 14.5 }]}>{`已选 ${checked.length} 条`}</Text>
      <SmallButton theme={theme} icon={X} label="取消" onPress={() => (setChecked([]), setSelecting(false))} testID="ce-select-cancel" />
      <SmallButton theme={theme} label="删除…" danger disabled={!checked.length} onPress={() => setDialog({ kind: 'entries', ids: checked, impact: M.entriesImpact(doc, checked) })} testID="ce-delete-checked" />
    </View>
  ) : null;

  const documentPane = (
    <DocumentPane
      theme={theme}
      uuid={uuid}
      state={state}
      selected={selected}
      tab={tab}
      setTab={setTab}
      choose={choose}
      apply={editor.apply}
      setPendingText={(p) => {
        editor.pendingText.current = p;
      }}
      flushText={editor.flushText}
      openEntity={(d) => editor.flushText() && setEntity(d)}
      askDialog={(d) => {
        setDeleteMode('paired');
        setThinkingScope('suffix');
        setDialog(d);
      }}
      pending={pending}
      runPreview={() => void editor.preview()}
    />
  );

  // ---------------------------------------------------------------- 底栏
  const footer = (
    <View style={[styles.footer, { borderTopColor: theme.line, backgroundColor: theme.panel, paddingBottom: Math.max(insets.bottom, 10) }]} testID="ce-footer">
      <View style={styles.flex}>
        <Text style={[styles.footerMain, { color: theme.text }]} testID="ce-change-count">{`${changes.length} 项改动`}</Text>
        <Text numberOfLines={1} style={[styles.footerSub, { color: saved ? theme.muted : theme.warning }]} testID="ce-save-state">
          {saved ? (state.revision ? `已保存 · 草稿第 ${state.revision} 版` : '已保存 / 未改动') : '未保存'}
        </Text>
      </View>
      <SmallButton theme={theme} icon={Save} label={pending === 'save' ? '保存中…' : '保存草稿'} busy={pending === 'save'} disabled={Boolean(pending) || loading} onPress={() => void editor.saveDraft()} testID="ce-save" />
      <SmallButton theme={theme} icon={GitBranch} label="创建分支" primary disabled={Boolean(pending)} onPress={() => editor.flushText() && setBranchOpen(true)} testID="ce-branch" />
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]} testID="context-editor">
      {header}
      {error || notice ? (
        <Banner theme={theme} tone={error ? 'error' : 'notice'} text={error || notice} onClose={() => (editor.setError(''), editor.setNotice(''))} testID="ce-status" />
      ) : null}
      {wide ? (
        <View style={styles.split}>
          <View style={[styles.outlinePane, { borderRightColor: theme.line }]}>
            {outline}
            {selectionBar}
          </View>
          <View style={styles.flex}>{documentPane}</View>
        </View>
      ) : layer === 'outline' ? (
        <View style={styles.flex}>
          {outline}
          {selectionBar}
        </View>
      ) : (
        <View style={styles.flex}>{documentPane}</View>
      )}
      {selecting && !wide ? null : footer}

      <ActionMenu visible={Boolean(menu)} anchor={menu} items={menuItems} onClose={() => setMenu(null)} />

      <OptionSheet
        visible={modelPick}
        title="目标模型"
        options={state.models.map((m) => ({ value: m.model, label: m.label, detail: m.protocol }))}
        value={state.targetModel}
        onClose={() => setModelPick(false)}
        onChange={(v: string) => editor.apply((s) => M.setting(s, 'targetModel', v))}
        testID="ce-model-sheet"
      />
      <OptionSheet
        visible={modePick}
        title="模式"
        options={[
          { value: 'compatible', label: '兼容续聊', detail: '编译为目标模型可执行的请求，预览通过后可创建分支' },
          { value: 'raw', label: '原始实验（只保存）', detail: '保留原样用于实验，只能保存草稿或导出，不能创建分支' },
        ]}
        value={state.mode}
        onClose={() => setModePick(false)}
        onChange={(v: string) => editor.apply((s) => M.setting(s, 'mode', v))}
        testID="ce-mode-sheet"
      />
      <Sheet visible={snapshotInfo} onClose={() => setSnapshotInfo(false)} title={`冻结快照 · ${doc.entries.length} 条消息`} testID="ce-snapshot-sheet">
        <View style={styles.sheetBody}>
          <Text style={[styles.sheetText, { color: theme.text }]}>分支冻结系统提示、工具定义及已有记忆；不会自动注入新的任务记忆；仍遵循会话压缩设置。</Text>
          <Text style={[styles.sheetText, { color: theme.muted }]}>{`源快照：${state.snapshotToken.slice(0, 16)}… · 服务器草稿第 ${state.revision} 版`}</Text>
        </View>
      </Sheet>

      <BranchSheet
        theme={theme}
        visible={branchOpen}
        title={branchTitle}
        setTitle={setBranchTitle}
        reason={branchReason}
        busy={pending === 'create'}
        previewBusy={pending === 'preview'}
        needsPreview={!M.previewReady(state) && state.mode === 'compatible' && !busy && !state.latestSource}
        onPreview={() => void editor.preview()}
        onClose={() => setBranchOpen(false)}
        onCreate={() => void createBranch()}
      />

      <DialogSheet
        theme={theme}
        dialog={dialog}
        deleteMode={deleteMode}
        setDeleteMode={setDeleteMode}
        thinkingScope={thinkingScope}
        setThinkingScope={(scope) => {
          setThinkingScope(scope);
          if (dialog?.kind === 'thinking') setDialog({ ...dialog, impact: M.reasoningImpact(doc, dialog.id, scope === 'suffix') });
        }}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
      />

      <ConfirmSheet
        visible={leaveAsk}
        title="离开上下文编辑"
        message="还有改动没有保存到服务器草稿。离开后本页编辑稿在 App 运行期间仍会保留，下次进入可以继续；也可以先保存草稿。"
        confirmLabel="离开"
        destructive={false}
        onConfirm={() => {
          setLeaveAsk(false);
          leave();
        }}
        onClose={() => setLeaveAsk(false)}
      />

      <EntityEditor draft={entity} onCancel={() => setEntity(null)} onSave={saveEntity} />
    </View>
  );
}

function SettingRow({ theme, label, value, onPress, divider, testID }: { theme: Theme; label: string; value: string; onPress(): void; divider?: boolean; testID?: string }) {
  return (
    <Press onPress={onPress} style={[styles.setting, divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]} pressedStyle={{ backgroundColor: theme.hover }} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      <Text style={[styles.settingLabel, { color: theme.subtle }]}>{label}</Text>
      <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.settingValue, { color: theme.text }]}>{value}</Text>
      <Icon as={ChevronRight} size={16} color={theme.disabled} />
    </Press>
  );
}

function OutlineLink({ theme, label, detail, active, onPress, divider, testID }: { theme: Theme; label: string; detail: string; active?: boolean; onPress(): void; divider?: boolean; testID?: string }) {
  return (
    <Press
      onPress={onPress}
      style={[styles.setting, divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }, active && { backgroundColor: theme.selected }]}
      pressedStyle={{ backgroundColor: theme.hover }}
      accessibilityRole="button"
      testID={testID}
    >
      <Text style={[styles.linkLabel, { color: theme.textStrong }]}>{label}</Text>
      <Text style={[styles.settingValue, { color: theme.muted }]}>{detail}</Text>
    </Press>
  );
}

function BranchSheet({ theme, visible, title, setTitle, reason, busy, previewBusy, needsPreview, onPreview, onClose, onCreate }: {
  theme: Theme; visible: boolean; title: string; setTitle(v: string): void; reason: string; busy: boolean; previewBusy: boolean; needsPreview: boolean; onPreview(): void; onClose(): void; onCreate(): void;
}) {
  const ready = !reason && Boolean(title.trim());
  return (
    <Sheet visible={visible} onClose={onClose} title="创建独立分支" subtitle="生成新会话并打开；原会话不变" testID="ce-branch-sheet">
      <View style={styles.sheetBody}>
        <TextField label="新分支标题" value={title} onChangeText={setTitle} placeholder="例如：去掉第 3 轮后重试" testID="ce-branch-title" />
        {reason && reason !== '请输入分支标题' ? <Banner theme={theme} tone="warning" text={reason} testID="ce-branch-reason" /> : null}
        {needsPreview ? <SmallButton theme={theme} label={previewBusy ? '正在校验…' : '校验并预览'} busy={previewBusy} onPress={onPreview} testID="ce-branch-preview" /> : null}
        <Press onPress={onCreate} disabled={!ready || busy} style={[styles.bigButton, { backgroundColor: theme.button, opacity: !ready || busy ? 0.4 : 1 }]} accessibilityRole="button" accessibilityState={{ disabled: !ready || busy, busy }} testID="ce-branch-create">
          {busy ? <ActivityIndicator color={theme.buttonText} /> : <Text style={[styles.bigButtonText, { color: theme.buttonText }]}>创建独立分支</Text>}
        </Press>
        <Text style={[styles.sheetHint, { color: theme.muted }]}>条件：兼容续聊模式、服务端预览通过且没有错误、源会话没有新内容、会话未在运行。</Text>
      </View>
    </Sheet>
  );
}

function DialogSheet({ theme, dialog, deleteMode, setDeleteMode, thinkingScope, setThinkingScope, onClose, onConfirm }: {
  theme: Theme;
  dialog: M.Dialog | null;
  deleteMode: 'paired' | 'only';
  setDeleteMode(v: 'paired' | 'only'): void;
  thinkingScope: 'suffix' | 'one';
  setThinkingScope(v: 'suffix' | 'one'): void;
  onClose(): void;
  onConfirm(): void;
}) {
  const kind = dialog?.kind;
  const message = kind === 'refresh'
    ? '这会放弃当前页的编辑并载入源会话最新上下文。原会话和已保存的服务器草稿不会被删除；只有再次保存新稿时才会替换服务器草稿。'
    : kind === 'call'
      ? '按本批次 call ID 关联，保留其余并行调用。历史工具不会重新执行。'
      : kind === 'thinking'
        ? '删除整组思考，不伪造或重签。当前工具回合原样回放限制仍由服务器校验。'
        : kind === 'tool'
          ? '仅从编辑稿移除此工具定义，不卸载工具，也不删除历史调用。'
          : '以下关联项将联动删除，不补造工具结果。可通过撤销恢复。';
  let lines: { label: string; path: string }[] = [];
  if (dialog?.kind === 'call') {
    const l = M.callImpactLines(dialog, deleteMode);
    lines = [...l.remove.map((p) => ({ label: '删除', path: p })), ...l.retain.map((p) => ({ label: '保留并行调用', path: p })), ...l.orphan.map((p) => ({ label: '保留孤儿结果', path: p }))];
  } else if (dialog && dialog.kind !== 'refresh') lines = dialog.impact.map((p) => ({ label: '删除', path: p }));
  return (
    <Sheet visible={Boolean(dialog)} onClose={onClose} title={kind === 'refresh' ? '加载最新上下文' : '确认删除'} testID="ce-dialog">
      <View style={styles.sheetBody}>
        <Text style={[styles.sheetText, { color: theme.text }]}>{message}</Text>
        {kind === 'call' ? (
          <>
            <RadioRow theme={theme} label="删除调用及关联返回" checked={deleteMode === 'paired'} onPress={() => setDeleteMode('paired')} testID="ce-delete-paired" />
            <RadioRow theme={theme} label="仅删调用，保留返回" detail="自动转为原始实验模式（只保存）" checked={deleteMode === 'only'} onPress={() => setDeleteMode('only')} testID="ce-delete-only" />
          </>
        ) : null}
        {kind === 'thinking' ? (
          <>
            <RadioRow theme={theme} label="本条及之后思考" checked={thinkingScope === 'suffix'} onPress={() => setThinkingScope('suffix')} />
            <RadioRow theme={theme} label="仅本条" detail="后续签名需另行核对" checked={thinkingScope === 'one'} onPress={() => setThinkingScope('one')} />
          </>
        ) : null}
        <ImpactList theme={theme} lines={lines} />
        <Press onPress={onConfirm} style={[styles.bigButton, { backgroundColor: kind === 'refresh' ? theme.button : theme.danger }]} accessibilityRole="button" testID="ce-dialog-confirm">
          <Text style={[styles.bigButtonText, { color: kind === 'refresh' ? theme.buttonText : '#fff' }]}>{kind === 'refresh' ? '放弃本页编辑并加载' : '确认删除'}</Text>
        </Press>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24 },
  placeholder: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24, paddingVertical: 12, lineHeight: 20 },
  navBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  split: { flex: 1, flexDirection: 'row' },
  outlinePane: { width: 340, borderRightWidth: StyleSheet.hairlineWidth },
  card: { marginHorizontal: 12, marginTop: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  setting: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 48 },
  settingLabel: { fontSize: 13.5, width: 64 },
  settingValue: { flex: 1, fontSize: 14, textAlign: 'right' },
  linkLabel: { fontSize: 15, fontWeight: '500' },
  groupHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  groupTitle: { flex: 1, fontSize: 12.5, fontWeight: '600' },
  textBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, paddingHorizontal: 6 },
  textBtnLabel: { fontSize: 13.5 },
  searchRow: { paddingHorizontal: 12, paddingTop: 4 },
  addRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  entryHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  entryNo: { fontSize: 12, fontVariant: ['tabular-nums'] },
  entryIssue: { flex: 1, fontSize: 12 },
  snippet: { fontSize: 13.5, lineHeight: 19, marginTop: 4 },
  selectionBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  footerMain: { fontSize: 14, fontWeight: '600' },
  footerSub: { fontSize: 12, marginTop: 1 },
  sheetBody: { paddingHorizontal: 20, paddingBottom: 8, gap: 12 },
  sheetText: { fontSize: 14.5, lineHeight: 21 },
  sheetHint: { fontSize: 12, lineHeight: 17 },
  bigButton: { height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  bigButtonText: { fontSize: 16, fontWeight: '600' },
});
