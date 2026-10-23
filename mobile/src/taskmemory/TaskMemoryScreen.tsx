/**
 * 任务记忆（B4-09～B4-22，对应 Web TaskMemoryDrawer.vue）：全屏页面。
 *  - 标签：会话记忆 / Agent 记忆；Agent 记忆先选 Agent 任务（可搜索的选择面板，显示名称、状态、更新时间）；
 *  - 列表：名称、说明、来源、更新时间；标记（已删除 / 自动提供给模型 / 按需读取 / Agent 可读取）；
 *    搜索（名称、说明、正文；250ms 防抖，清空）、刷新、显示已删除、分页（50 条一页）；行长按菜单：编辑 / 删除 / 恢复；
 *  - 详情（Sheet）：正文 Markdown、来源、更新时间、“有新版本”提示、技术信息（使用方式、Agent 读取、版本/大小、标识、来源轮次/运行）；
 *  - 新增/编辑（Sheet）：名称 ≤80、说明 ≤200、正文 ≤16 KiB（CodeEditor markdown 模式，超限标红）、自动向模型提供、允许 Agent 读取；
 *  - 模型可见内容预览：约 N tokens、省略条数、注入规则、原文；
 *  - 打开期间每 5 秒静默刷新（与 Web 相同），离开页面停止。
 * 请求按（会话、范围、任务）身份 + 通道做时序门控（复用 Web taskMemoryRequestGate），切换标签/任务后旧响应不会覆盖新界面。
 */
import { router, useFocusEffect } from 'expo-router';
import { Bookmark, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, Pencil, Plus, RefreshCw, RotateCcw, Trash } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Switch, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EnrichedBody } from '../chat/markdown/EnrichedBody';
import { useSession } from '../data/session';
import { formatBytes, utf8Bytes } from '../panel/format';
import { EditorPage } from '../panel/EditorPage';
import { useOpenBearApi } from '../panel/hooks';
import { apiError } from '../transport/apiAdapter';
import { ActionMenu, type MenuAnchor, type MenuItem } from '../ui/ActionMenu';
import {
  CodeEditor,
  ConfirmSheet,
  Icon,
  IconButton,
  NavRow,
  Press,
  SearchField,
  Segmented,
  Sheet,
  SheetScroll,
  TextField,
  showToast,
  tap,
  useTheme,
} from '../ui';
import { radius, type Theme } from '../ui/theme';
import {
  type AgentTask,
  BODY_MAX_BYTES,
  DESCRIPTION_MAX,
  type InjectionPreview,
  type MemoryForm,
  NAME_MAX,
  PAGE_SIZE,
  type ScopeType,
  type TaskMemoryItem,
  asAxiosError,
  createTaskMemoryRequestGate,
  emptyForm,
  emptyText,
  formFromDetail,
  formatDate,
  mutationPayload,
  pageCount,
  scopeParams,
  sourceLabel,
  statusLabel,
  taskLabel,
  taskMemoryInjectionPreview,
  taskMemoryInjectionUsage,
  taskMemoryMutationRecovery,
  validateForm,
} from './logic';

type Identity = { conversationUuid: string; scopeType: ScopeType; taskUuid: string };

export function TaskMemoryScreen({ uuid }: { uuid: string }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const api = useOpenBearApi();
  const session = useSession();
  const title = session.conversations.find((c) => c.conversationUuid === uuid)?.title || '';

  const [tab, setTab] = useState<ScopeType>('conversation');
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskUuid, setTaskUuid] = useState('');
  const [taskPicker, setTaskPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<TaskMemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [activeTotal, setActiveTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState('');
  const [preview, setPreview] = useState<InjectionPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detail, setDetail] = useState<TaskMemoryItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailChanged, setDetailChanged] = useState(false);
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; form: MemoryForm; baseline: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TaskMemoryItem | null>(null);
  const [discardAsk, setDiscardAsk] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ item: TaskMemoryItem; anchor: MenuAnchor } | null>(null);

  const gate = useRef(createTaskMemoryRequestGate()).current;
  const identity: Identity = { conversationUuid: uuid, scopeType: tab, taskUuid: tab === 'agent_task' ? taskUuid : '' };
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const filtersRef = useRef({ appliedQuery, includeDeleted, page });
  filtersRef.current = { appliedQuery, includeDeleted, page };
  const detailRef = useRef(detail);
  detailRef.current = detail;

  const begin = useCallback((channel: string) => gate.capture(identityRef.current, channel), [gate]);
  const current = useCallback((token: any) => gate.isCurrent(token, identityRef.current), [gate]);
  useEffect(() => () => gate.dispose(), [gate]);

  const ready = Boolean(api) && (tab === 'conversation' || Boolean(taskUuid));

  const loadList = useCallback(
    async ({ silent = false } = {}) => {
      if (!api) return;
      const token = begin('items');
      const id = identityRef.current;
      const { appliedQuery: q, includeDeleted: del, page: p } = filtersRef.current;
      if (id.scopeType === 'agent_task' && !id.taskUuid) {
        setItems([]);
        setTotal(0);
        setActiveTotal(0);
        setLoaded(true);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const data: any = await api.taskMemories(uuid, scopeParams(id, { query: q, includeDeleted: del ? 1 : 0, offset: (p - 1) * PAGE_SIZE, limit: PAGE_SIZE }));
        if (!current(token)) return;
        const f = filtersRef.current;
        if (f.appliedQuery !== q || f.includeDeleted !== del || f.page !== p) return;
        const nextTotal = Number(data?.total || 0);
        if (p > 1 && (p - 1) * PAGE_SIZE >= nextTotal) {
          setPage(Math.max(1, pageCount(nextTotal)));
          return;
        }
        const list: TaskMemoryItem[] = Array.isArray(data?.items) ? data.items : [];
        setItems(list);
        setTotal(nextTotal);
        setActiveTotal(Number(data?.activeTotal ?? list.filter((i) => !Number(i.deletedAt || 0)).length));
        setListError('');
        const open = detailRef.current;
        const latest = open ? list.find((i) => i.memoryUuid === open.memoryUuid) : null;
        if (latest && open && latest.revision !== open.revision) setDetailChanged(true);
      } catch (error) {
        if (current(token) && !silent) setListError(apiError(error));
      } finally {
        if (current(token)) {
          setLoading(false);
          setLoaded(true);
        }
      }
    },
    [api, uuid, begin, current],
  );

  const loadPreview = useCallback(async () => {
    if (!api) return;
    const token = begin('preview');
    const id = identityRef.current;
    if (id.scopeType === 'agent_task' && !id.taskUuid) {
      setPreview(null);
      return;
    }
    try {
      const data = await api.taskMemoryPreview(uuid, scopeParams(id));
      if (current(token)) setPreview(taskMemoryInjectionPreview(data));
    } catch {
      if (current(token)) setPreview(null);
    }
  }, [api, uuid, begin, current]);

  const loadTasks = useCallback(async () => {
    if (!api) return;
    const token = begin('tasks');
    setTasksLoading(true);
    try {
      const data: any = await api.taskMemoryTasks(uuid);
      if (!current(token)) return;
      const list: AgentTask[] = Array.isArray(data?.tasks) ? data.tasks : [];
      setTasks(list);
      setTaskUuid((prev) => (list.some((t) => t.taskUuid === prev) ? prev : list[0]?.taskUuid || ''));
    } catch (error) {
      if (current(token)) {
        setTasks([]);
        setTaskUuid('');
        showToast(apiError(error));
      }
    } finally {
      if (current(token)) setTasksLoading(false);
    }
  }, [api, uuid, begin, current]);

  const refreshAll = useCallback((silent = false) => Promise.all([loadList({ silent }), loadPreview()]), [loadList, loadPreview]);

  // 切换标签：清空并重新载入（Agent 记忆先取任务）
  useEffect(() => {
    gate.invalidate();
    setItems([]);
    setTotal(0);
    setActiveTotal(0);
    setLoaded(false);
    setDetail(null);
    setPreview(null);
    setQuery('');
    setAppliedQuery('');
    setIncludeDeleted(false);
    setPage(1);
    setListError('');
    if (tab === 'agent_task') {
      setTaskUuid('');
      void loadTasks();
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // 身份或筛选变化：重新读取
  useEffect(() => {
    if (tab === 'agent_task' && !taskUuid) {
      if (!tasksLoading) setLoaded(true);
      return;
    }
    void loadList();
  }, [tab, taskUuid, appliedQuery, includeDeleted, page, loadList]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void loadPreview();
  }, [tab, taskUuid, loadPreview]);

  // 搜索防抖 250ms（回到第一页）
  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedQuery(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // 打开期间每 5 秒静默刷新；回到前台立即刷新（同 Web 的定时器与窗口聚焦）
  useFocusEffect(
    useCallback(() => {
      const timer = setInterval(() => {
        if (AppState.currentState === 'active') void refreshAll(true);
      }, 5000);
      const sub = AppState.addEventListener('change', (next) => {
        if (next === 'active') void refreshAll(true);
      });
      return () => {
        clearInterval(timer);
        sub.remove();
      };
    }, [refreshAll]),
  );

  const recover = useCallback(
    async (error: any, token: any) => {
      if (!current(token)) return true;
      const recovery = taskMemoryMutationRecovery(asAxiosError(error));
      if (!recovery.refresh) return false;
      gate.invalidate();
      if (recovery.resetEditor) setEditor(null);
      showToast(recovery.message);
      await refreshAll(true);
      return true;
    },
    [current, gate, refreshAll],
  );

  const viewMemory = useCallback(
    async (item: TaskMemoryItem) => {
      if (!api) return;
      const token = begin('detail');
      setDetail({ ...item });
      setDetailLoading(true);
      setDetailError('');
      setDetailChanged(false);
      try {
        const data: any = await api.taskMemory(uuid, item.memoryUuid, scopeParams(identityRef.current, { includeDeleted: 1 }));
        if (current(token)) setDetail(data?.memory || item);
      } catch {
        if (current(token)) setDetailError('暂时无法读取正文，请重试。');
      } finally {
        if (current(token)) setDetailLoading(false);
      }
    },
    [api, uuid, begin, current],
  );

  const newMemory = useCallback(() => {
    if (tab === 'agent_task' && !taskUuid) {
      showToast('请先选择 Agent 任务');
      return;
    }
    const form = emptyForm();
    setEditor({ mode: 'create', form, baseline: JSON.stringify(form) });
  }, [tab, taskUuid]);

  const editMemory = useCallback(
    async (item: TaskMemoryItem) => {
      if (!api) return;
      const token = begin('detail');
      try {
        const data: any = await api.taskMemory(uuid, item.memoryUuid, scopeParams(identityRef.current, { includeDeleted: item.deletedAt ? 1 : 0 }));
        if (!current(token)) return;
        const full: TaskMemoryItem = data?.memory || {};
        if (full.deletedAt) {
          showToast('这条记忆已删除，请恢复后再编辑。');
          void viewMemory(full);
          return;
        }
        const form = formFromDetail(full);
        setDetail(null);
        setEditor({ mode: 'edit', form, baseline: JSON.stringify(form) });
      } catch (error) {
        if (!(await recover(error, token))) showToast(apiError(error));
      }
    },
    [api, uuid, begin, current, recover, viewMemory],
  );

  const saveMemory = useCallback(async () => {
    if (!api || !editor || saving) return;
    const errors = validateForm(editor.form);
    const first = errors.name || errors.description || errors.body;
    if (first) {
      showToast(first);
      return;
    }
    const token = begin('mutation');
    const id = identityRef.current;
    setSaving(true);
    try {
      const payload = mutationPayload(editor.form, id);
      const result: any = editor.mode === 'create'
        ? await api.createTaskMemory(uuid, payload)
        : await api.updateTaskMemory(uuid, editor.form.memoryUuid, { ...payload, revision: Number(editor.form.revision || 0) });
      if (!current(token)) return;
      setEditor(null);
      showToast(editor.mode === 'create' ? '任务记忆已创建' : '任务记忆已更新');
      if (result?.memory && detailRef.current?.memoryUuid === result.memory.memoryUuid) {
        setDetail(result.memory);
        setDetailChanged(false);
      }
      await refreshAll();
    } catch (error) {
      if (!current(token)) return;
      if (editor.mode !== 'edit' || !(await recover(error, token))) showToast(apiError(error));
    } finally {
      if (current(token)) setSaving(false);
    }
  }, [api, editor, saving, uuid, begin, current, recover, refreshAll]);

  const deleteMemory = useCallback(
    async (item: TaskMemoryItem) => {
      if (!api) return;
      const token = begin('mutation');
      try {
        await api.deleteTaskMemory(uuid, item.memoryUuid, { ...scopeParams(identityRef.current), revision: Number(item.revision || 0) });
        if (!current(token)) return;
        setConfirmDelete(null);
        if (detailRef.current?.memoryUuid === item.memoryUuid) setDetail(null);
        showToast('已删除，可在已删除记录中恢复');
        await refreshAll();
      } catch (error) {
        setConfirmDelete(null);
        if (!(await recover(error, token))) showToast(apiError(error));
      }
    },
    [api, uuid, begin, current, recover, refreshAll],
  );

  const restoreMemory = useCallback(
    async (item: TaskMemoryItem) => {
      if (!api) return;
      const token = begin('mutation');
      try {
        await api.restoreTaskMemory(uuid, item.memoryUuid, { ...scopeParams(identityRef.current), revision: Number(item.revision || 0) });
        if (!current(token)) return;
        showToast('任务记忆已恢复');
        if (detailRef.current?.memoryUuid === item.memoryUuid) void viewMemory({ ...item, deletedAt: 0 });
        await refreshAll();
      } catch (error) {
        if (!(await recover(error, token))) showToast(apiError(error));
      }
    },
    [api, uuid, begin, current, recover, refreshAll, viewMemory],
  );

  const closeEditor = useCallback(() => {
    if (!editor || saving) return;
    if (JSON.stringify(editor.form) !== editor.baseline) setDiscardAsk(true);
    else setEditor(null);
  }, [editor, saving]);

  const selectedTask = tasks.find((t) => t.taskUuid === taskUuid) || null;
  const empty = emptyText(tab, Boolean(taskUuid), appliedQuery);
  const pages = pageCount(total);
  const wide = width >= 768;

  const rowMenuItems: MenuItem[] = rowMenu
    ? rowMenu.item.deletedAt
      ? [{ key: 'restore', label: '恢复', icon: RotateCcw, onPress: () => void restoreMemory(rowMenu.item) }]
      : [
          { key: 'edit', label: '编辑', icon: Pencil, onPress: () => void editMemory(rowMenu.item) },
          { key: 'delete', label: '删除', icon: Trash, destructive: true, onPress: () => setConfirmDelete(rowMenu.item) },
        ]
    : [];

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]} testID="task-memory-screen">
      <View style={{ paddingTop: insets.top, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line, backgroundColor: theme.glass }}>
        <NavRow
          theme={theme}
          title="任务记忆"
          subtitle={title || undefined}
          left={<IconButton icon={ChevronLeft} size={26} theme={theme} label="返回" onPress={() => router.back()} testID="back" />}
          right={
            <>
              <IconButton icon={RefreshCw} size={19} theme={theme} label="刷新任务记忆" onPress={() => void refreshAll()} testID="tm-refresh" />
              <IconButton icon={Plus} theme={theme} label="新增记忆" onPress={newMemory} testID="tm-new" />
            </>
          }
        />
      </View>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }, wide && styles.wide]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={[styles.intro, { color: theme.muted }]}>会话专用资料与执行偏好；任务进度由任务与 Plan 管理。</Text>
        <View style={styles.pad}>
          <Segmented
            theme={theme}
            items={[
              { key: 'conversation', label: '会话记忆' },
              { key: 'agent_task', label: 'Agent 记忆' },
            ]}
            value={tab}
            onChange={(key) => setTab(key as ScopeType)}
          />
        </View>

        {tab === 'agent_task' ? (
          <Press
            onPress={() => setTaskPicker(true)}
            disabled={!tasks.length}
            style={[styles.taskPick, { backgroundColor: theme.panel, borderColor: theme.line }]}
            pressedStyle={{ backgroundColor: theme.hover }}
            accessibilityRole="button"
            accessibilityLabel="选择 Agent 任务"
            testID="tm-task-picker"
          >
            <View style={styles.flex}>
              <Text style={[styles.small, { color: theme.muted }]}>查看任务</Text>
              {tasksLoading ? (
                <ActivityIndicator style={{ alignSelf: 'flex-start', marginTop: 4 }} color={theme.muted} />
              ) : selectedTask ? (
                <>
                  <Text numberOfLines={1} style={[styles.taskTitle, { color: theme.text }]}>{taskLabel(selectedTask)}</Text>
                  <Text numberOfLines={1} style={[styles.small, { color: theme.muted }]}>
                    {`${selectedTask.name || 'Agent'} · ${statusLabel(selectedTask.status)} · ${formatDate(selectedTask.updatedAt)}`}
                  </Text>
                </>
              ) : (
                <Text style={[styles.taskTitle, { color: theme.muted }]}>暂无 Agent 任务</Text>
              )}
            </View>
            {tasks.length ? <Icon as={ChevronDown} size={18} color={theme.subtle} /> : null}
          </Press>
        ) : null}

        <View style={[styles.pad, styles.toolbar]}>
          <SearchField theme={theme} value={query} onChange={setQuery} placeholder="搜索名称、说明或正文" style={styles.flex} testID="tm-search" />
        </View>
        <View style={[styles.pad, styles.summaryRow]}>
          <Text style={[styles.small, { color: theme.subtle }]} testID="tm-count">
            {appliedQuery ? `找到 ${total} 条` : `${activeTotal} 条记忆`}
          </Text>
          <View style={styles.flex} />
          <Text style={[styles.small, { color: theme.subtle }]}>显示已删除</Text>
          <Switch
            value={includeDeleted}
            onValueChange={(v) => {
              tap('select');
              setIncludeDeleted(v);
              setPage(1);
            }}
            trackColor={{ true: theme.button, false: theme.surfaceSoft }}
            thumbColor={includeDeleted ? theme.buttonText : theme.panel}
            testID="tm-show-deleted"
          />
        </View>

        <View style={[styles.card, { backgroundColor: theme.panel, borderColor: theme.line }]}>
          {!loaded || (loading && !items.length) ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.muted} />
            </View>
          ) : listError && !items.length ? (
            <View style={styles.center}>
              <Text style={[styles.emptyTitle, { color: theme.danger }]}>读取失败：{listError}</Text>
              <Press onPress={() => void loadList()} style={[styles.ghostBtn, { borderColor: theme.border }]} testID="tm-retry">
                <Text style={{ color: theme.text, fontSize: 14.5 }}>重试</Text>
              </Press>
            </View>
          ) : !items.length ? (
            <View style={styles.center} testID="tm-empty">
              <Icon as={Bookmark} size={26} strokeWidth={1.5} color={theme.disabled} />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>{empty.title}</Text>
              <Text style={[styles.emptyText, { color: theme.muted }]}>{empty.description}</Text>
              {appliedQuery ? (
                <Press onPress={() => setQuery('')} style={[styles.ghostBtn, { borderColor: theme.border }]} testID="tm-clear-search">
                  <Text style={{ color: theme.text, fontSize: 14.5 }}>清空搜索</Text>
                </Press>
              ) : null}
            </View>
          ) : (
            items.map((item, index) => (
              <MemoryRow
                key={item.memoryUuid}
                theme={theme}
                item={item}
                first={index === 0}
                conversationTab={tab === 'conversation'}
                onPress={() => void viewMemory(item)}
                onMenu={(anchor) => setRowMenu({ item, anchor })}
              />
            ))
          )}
        </View>

        {total > PAGE_SIZE ? (
          <View style={[styles.pad, styles.pager]}>
            <IconButton icon={ChevronLeft} theme={theme} label="上一页" onPress={page > 1 ? () => setPage(page - 1) : undefined} color={page > 1 ? theme.text : theme.disabled} testID="tm-prev" />
            <Text style={[styles.small, { color: theme.subtle }]}>{`第 ${page} / ${pages} 页 · 共 ${total} 条`}</Text>
            <IconButton icon={ChevronRight} theme={theme} label="下一页" onPress={page < pages ? () => setPage(page + 1) : undefined} color={page < pages ? theme.text : theme.disabled} testID="tm-next" />
          </View>
        ) : null}

        <PreviewSection theme={theme} preview={preview} open={previewOpen} onToggle={() => setPreviewOpen((v) => !v)} agent={tab === 'agent_task'} />
      </ScrollView>

      <ActionMenu visible={Boolean(rowMenu)} anchor={rowMenu?.anchor ?? null} title={rowMenu?.item.name} items={rowMenuItems} dim onClose={() => setRowMenu(null)} />

      <TaskPickerSheet theme={theme} visible={taskPicker} tasks={tasks} value={taskUuid} onClose={() => setTaskPicker(false)} onChange={(v) => setTaskUuid(v)} />

      <DetailSheet
        theme={theme}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        changed={detailChanged}
        conversationTab={tab === 'conversation'}
        shortBodyMaxChars={preview?.shortBodyMaxChars || 0}
        onClose={() => {
          begin('detail');
          setDetail(null);
        }}
        onReload={() => detail && void viewMemory(detail)}
        onEdit={() => detail && void editMemory(detail)}
        onRestore={() => detail && void restoreMemory(detail)}
        onDelete={() => detail && setConfirmDelete(detail)}
      />

      <EditorSheet
        theme={theme}
        editor={editor}
        saving={saving}
        conversationTab={tab === 'conversation'}
        shortBodyMaxChars={preview?.shortBodyMaxChars || 0}
        onChange={(form) => setEditor((e) => (e ? { ...e, form } : e))}
        onClose={closeEditor}
        onSave={() => void saveMemory()}
      >
        <ConfirmSheet
          visible={discardAsk}
          title="放弃修改"
          message="尚有未保存的修改，确定放弃吗？"
          confirmLabel="放弃修改"
          onConfirm={() => {
            setDiscardAsk(false);
            setEditor(null);
          }}
          onClose={() => setDiscardAsk(false)}
        />
      </EditorSheet>

      <ConfirmSheet
        visible={Boolean(confirmDelete)}
        title="删除任务记忆"
        message={confirmDelete ? `删除“${confirmDelete.name}”？可在“显示已删除”后恢复。` : ''}
        confirmLabel="删除"
        onConfirm={() => confirmDelete && void deleteMemory(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </View>
  );
}

function MemoryRow({ theme, item, first, conversationTab, onPress, onMenu }: { theme: Theme; item: TaskMemoryItem; first: boolean; conversationTab: boolean; onPress(): void; onMenu(anchor: MenuAnchor): void }) {
  const deleted = Boolean(item.deletedAt);
  return (
    <Press
      onPress={onPress}
      onLongPress={(e) => onMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })}
      style={[styles.row, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]}
      pressedStyle={{ backgroundColor: theme.hover }}
      accessibilityRole="button"
      accessibilityLabel={`查看 ${item.name}`}
      testID={`tm-row-${item.memoryUuid}`}
    >
      <View style={styles.flex}>
        <Text numberOfLines={1} style={[styles.rowName, { color: deleted ? theme.muted : theme.textStrong, textDecorationLine: deleted ? 'line-through' : 'none' }]}>
          {item.name}
        </Text>
        {item.description ? (
          <Text numberOfLines={2} style={[styles.rowDesc, { color: theme.subtle }]}>
            {item.description}
          </Text>
        ) : null}
        <Text numberOfLines={1} style={[styles.rowMeta, { color: theme.muted }]}>
          {`${sourceLabel(item)} · ${formatDate(item.updatedAt)} 更新`}
        </Text>
        <View style={styles.flags}>
          {deleted ? <Flag theme={theme} label="已删除" tone="danger" /> : item.autoReinjectCatalog ? <Flag theme={theme} label="自动提供给模型" tone="on" /> : <Flag theme={theme} label="按需读取" />}
          {conversationTab && item.visibleToAgents ? <Flag theme={theme} label="Agent 可读取" /> : null}
        </View>
      </View>
      <Press
        onPress={(e) => onMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, align: 'right' })}
        hitSlop={8}
        style={styles.rowMore}
        accessibilityRole="button"
        accessibilityLabel={`${item.name} 的操作`}
        testID={`tm-row-more-${item.memoryUuid}`}
      >
        <Icon as={Ellipsis} size={18} color={theme.subtle} />
      </Press>
    </Press>
  );
}

function Flag({ theme, label, tone }: { theme: Theme; label: string; tone?: 'on' | 'danger' }) {
  const color = tone === 'danger' ? theme.danger : tone === 'on' ? theme.textStrong : theme.subtle;
  const bg = tone === 'danger' ? theme.dangerSoft : tone === 'on' ? theme.selected : theme.hover;
  return (
    <View style={[styles.flag, { backgroundColor: bg }]}>
      <Text style={[styles.flagText, { color }]}>{label}</Text>
    </View>
  );
}

function PreviewSection({ theme, preview, open, onToggle, agent }: { theme: Theme; preview: InjectionPreview | null; open: boolean; onToggle(): void; agent: boolean }) {
  return (
    <View style={[styles.card, { backgroundColor: theme.panel, borderColor: theme.line, marginTop: 18 }]}>
      <Press onPress={onToggle} style={styles.previewHead} pressedStyle={{ backgroundColor: theme.hover }} accessibilityRole="button" accessibilityState={{ expanded: open }} testID="tm-preview-toggle">
        <View style={styles.flex}>
          <Text style={[styles.rowName, { color: theme.text }]}>
            模型可见内容预览
            {preview?.omittedCount ? <Text style={{ color: theme.warning }}>{` · 省略 ${preview.omittedCount} 条`}</Text> : null}
          </Text>
          <Text style={[styles.small, { color: theme.muted }]}>{preview ? `约 ${preview.tokens} tokens` : '—'}</Text>
        </View>
        <Icon as={open ? ChevronDown : ChevronRight} size={18} color={theme.subtle} />
      </Press>
      {open ? (
        <View style={styles.previewBody} testID="tm-preview">
          {preview ? (
            <>
              <Text style={[styles.note, { color: theme.subtle }]}>
                {preview.shortBodyMaxChars
                  ? `按当前注入规则预览：不超过 ${preview.shortBodyMaxChars} 字符的短正文直接提供，长资料按需读取；总预算 ${preview.maxTokens} tokens。`
                  : `当前服务提供名称与说明，正文按需读取；总预算 ${preview.maxTokens} tokens。`}
              </Text>
              {preview.includedCount !== null ? (
                <Text style={[styles.note, { color: theme.subtle }]}>
                  {`已纳入 ${preview.includedCount} 条`}
                  {preview.omittedCount ? `，因预算省略 ${preview.omittedCount} 条；未显示不代表没有记录` : ''}
                  。Agent 可见内容也可能包含已共享的会话便笺。
                </Text>
              ) : null}
              {agent ? <Text style={[styles.note, { color: theme.subtle }]}>此处按允许 TaskMemory 工具预览。实际私有便笺是否提供取决于本轮有效授权；已共享的会话便笺不依赖此工具授权。</Text> : null}
              <ScrollView horizontal style={[styles.pre, { backgroundColor: theme.codeBg }]} contentContainerStyle={{ padding: 12 }}>
                <Text selectable style={[styles.mono, { color: theme.text }]}>
                  {preview.text || '暂无自动提供的内容'}
                </Text>
              </ScrollView>
            </>
          ) : (
            <Text style={[styles.note, { color: theme.muted }]}>暂时无法读取预览。</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

function TaskPickerSheet({ theme, visible, tasks, value, onClose, onChange }: { theme: Theme; visible: boolean; tasks: AgentTask[]; value: string; onClose(): void; onChange(v: string): void }) {
  const [q, setQ] = useState('');
  useEffect(() => {
    if (visible) setQ('');
  }, [visible]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tasks.filter((t) => !needle || `${taskLabel(t)} ${t.name || ''} ${statusLabel(t.status)}`.toLowerCase().includes(needle));
  }, [tasks, q]);
  return (
    <Sheet visible={visible} onClose={onClose} title="选择 Agent 任务" subtitle={`${tasks.length} 个任务`} testID="tm-task-sheet">
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <SearchField theme={theme} value={q} onChange={setQ} placeholder="搜索任务名称、Agent、状态" testID="tm-task-search" />
      </View>
      <SheetScroll>
        {list.map((task) => {
          const on = task.taskUuid === value;
          return (
            <Press
              key={task.taskUuid}
              onPress={() => {
                tap('select');
                onChange(task.taskUuid);
                onClose();
              }}
              style={[styles.taskRow, on && { backgroundColor: theme.selected }]}
              pressedStyle={{ backgroundColor: theme.hover }}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
            >
              <Text numberOfLines={1} style={[styles.rowName, { color: theme.textStrong, fontWeight: on ? '600' : '500' }]}>{taskLabel(task)}</Text>
              <Text numberOfLines={1} style={[styles.small, { color: theme.muted }]}>{`${task.name || 'Agent'} · ${statusLabel(task.status)} · ${formatDate(task.updatedAt)}`}</Text>
            </Press>
          );
        })}
        {!list.length ? <Text style={[styles.emptyText, { color: theme.muted, padding: 24 }]}>没有匹配的任务</Text> : null}
      </SheetScroll>
    </Sheet>
  );
}

function DetailSheet({
  theme, detail, loading, error, changed, conversationTab, shortBodyMaxChars, onClose, onReload, onEdit, onRestore, onDelete,
}: {
  theme: Theme;
  detail: TaskMemoryItem | null;
  loading: boolean;
  error: string;
  changed: boolean;
  conversationTab: boolean;
  shortBodyMaxChars: number;
  onClose(): void;
  onReload(): void;
  onEdit(): void;
  onRestore(): void;
  onDelete(): void;
}) {
  const [techOpen, setTechOpen] = useState(false);
  const deleted = Boolean(detail?.deletedAt);
  return (
    <Sheet
      visible={Boolean(detail)}
      onClose={onClose}
      title={detail?.name || ''}
      subtitle={detail ? `${sourceLabel(detail)} · ${formatDate(detail.updatedAt)} 更新${deleted ? ' · 已删除' : ''}` : undefined}
      full
      testID="tm-detail"
      footer={
        detail ? (
          <View style={styles.footerRow}>
            {deleted ? (
              <PrimaryButton theme={theme} label="恢复记忆" icon={RotateCcw} onPress={onRestore} testID="tm-detail-restore" />
            ) : (
              <>
                <GhostButton theme={theme} label="删除" icon={Trash} danger onPress={onDelete} testID="tm-detail-delete" />
                <PrimaryButton theme={theme} label="编辑" icon={Pencil} disabled={loading || Boolean(error)} onPress={onEdit} testID="tm-detail-edit" />
              </>
            )}
          </View>
        ) : null
      }
    >
      <SheetScroll contentContainerStyle={styles.detailBody}>
        {detail?.description ? <Text style={[styles.detailDesc, { color: theme.subtle }]}>{detail.description}</Text> : null}
        {changed ? (
          <View style={[styles.notice, { backgroundColor: theme.warningSoft }]} testID="tm-detail-changed">
            <Text style={[styles.noticeText, { color: theme.warning }]}>这条记忆有新版本。</Text>
            <Press onPress={onReload} hitSlop={8}>
              <Text style={[styles.link, { color: theme.textStrong }]}>查看最新内容</Text>
            </Press>
          </View>
        ) : null}
        {error ? (
          <View style={[styles.notice, { backgroundColor: theme.dangerSoft }]}>
            <Text style={[styles.noticeText, { color: theme.danger }]}>{error}</Text>
            <Press onPress={onReload} hitSlop={8}>
              <Text style={[styles.link, { color: theme.textStrong }]}>重新加载</Text>
            </Press>
          </View>
        ) : loading ? (
          <View style={[styles.center, { paddingVertical: 28 }]}>
            <ActivityIndicator color={theme.muted} />
          </View>
        ) : detail?.body ? (
          <View style={styles.md}>
            <EnrichedBody markdown={detail.body} blockKind="paragraph" streaming={false} theme={theme} />
          </View>
        ) : (
          <Text style={[styles.emptyText, { color: theme.muted, textAlign: 'left' }]}>这条记忆没有正文。</Text>
        )}
        {detail ? (
          <View style={[styles.tech, { borderColor: theme.line }]}>
            <Press onPress={() => setTechOpen((v) => !v)} style={styles.techHead} accessibilityRole="button" accessibilityState={{ expanded: techOpen }} testID="tm-detail-tech">
              <Text style={[styles.small, { color: theme.subtle, flex: 1 }]}>详细信息</Text>
              <Icon as={techOpen ? ChevronDown : ChevronRight} size={16} color={theme.muted} />
            </Press>
            {techOpen ? (
              <View style={styles.techBody}>
                <KV theme={theme} k="使用方式" v={taskMemoryInjectionUsage(detail, shortBodyMaxChars)} />
                {conversationTab ? <KV theme={theme} k="Agent 读取" v={detail.visibleToAgents ? '允许同会话中已获授权的 Agent 读取' : '不向 Agent 共享'} /> : null}
                <KV theme={theme} k="版本 / 大小" v={`第 ${detail.revision} 版 · ${formatBytes(Number(detail.sizeBytes || 0))}`} />
                <KV theme={theme} k="记忆标识" v={detail.memoryUuid} mono />
                {detail.sourceTurnUuid ? <KV theme={theme} k="来源轮次" v={detail.sourceTurnUuid} mono /> : null}
                {detail.sourceRunUuid ? <KV theme={theme} k="来源运行" v={detail.sourceRunUuid} mono /> : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </SheetScroll>
    </Sheet>
  );
}

function KV({ theme, k, v, mono }: { theme: Theme; k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={[styles.small, { color: theme.muted, width: 84 }]}>{k}</Text>
      <Text selectable style={[mono ? styles.mono : styles.small, { color: theme.text, flex: 1 }]}>{v}</Text>
    </View>
  );
}

function EditorSheet({
  theme, editor, saving, conversationTab, shortBodyMaxChars, onChange, onClose, onSave, children,
}: {
  theme: Theme;
  editor: { mode: 'create' | 'edit'; form: MemoryForm } | null;
  saving: boolean;
  conversationTab: boolean;
  shortBodyMaxChars: number;
  onChange(form: MemoryForm): void;
  onClose(): void;
  onSave(): void;
  /** 叠在编辑页上的确认面板（放弃修改） */
  children?: React.ReactNode;
}) {
  const form = editor?.form;
  const errors = form ? validateForm(form) : {};
  const bytes = form ? utf8Bytes(form.body) : 0;
  const over = bytes > BODY_MAX_BYTES;
  const set = (patch: Partial<MemoryForm>) => form && onChange({ ...form, ...patch });
  const nameLen = form ? Array.from(form.name).length : 0;
  const descLen = form ? Array.from(form.description).length : 0;
  return (
    <EditorPage
      visible={Boolean(editor)}
      title={editor?.mode === 'edit' ? '编辑记忆' : '新增记忆'}
      subtitle={conversationTab ? '会话记忆' : 'Agent 记忆'}
      onCancel={onClose}
      onSave={onSave}
      saving={saving}
      saveDisabled={!form?.name.trim() || Boolean(errors.name) || Boolean(errors.description) || over}
      testID="tm-editor"
    >
      {form ? (
        <ScrollView contentContainerStyle={{ paddingVertical: 8 }} keyboardShouldPersistTaps="handled">
          <TextField
            label={`名称（${nameLen}/${NAME_MAX}）`}
            value={form.name}
            editable={!saving}
            onChangeText={(name) => set({ name })}
            placeholder="例如：界面偏好、本次测试服务器"
            error={nameLen > NAME_MAX ? errors.name : undefined}
            testID="tm-name"
          />
          <TextField
            label={`简短说明（${descLen}/${DESCRIPTION_MAX}）· 帮助定位较长资料，不必重复短正文`}
            value={form.description}
            editable={!saving}
            multiline
            onChangeText={(description) => set({ description })}
            placeholder="用一两句话概括重点"
            error={errors.description}
            style={{ minHeight: 64 }}
            testID="tm-description"
          />
          <View style={styles.bodyHead}>
            <Text style={[styles.fieldLabel, { color: theme.subtle }]}>正文 · 支持 Markdown</Text>
            <Text style={[styles.fieldLabel, { color: over ? theme.danger : theme.muted }]} testID="tm-body-size">
              {`${formatBytes(bytes)} / 16 KiB`}
            </Text>
          </View>
          <View style={styles.bodyEditorWrap}>
            <CodeEditor
              mode="markdown"
              completionMode="memory"
              value={form.body}
              readOnly={saving}
              onChange={(body) => set({ body })}
              style={[styles.bodyEditor, over && { borderColor: theme.danger, borderWidth: 1 }]}
              testID="tm-body"
            />
            {!form.body ? (
              <Text pointerEvents="none" style={[styles.placeholder, { color: theme.muted }]}>
                记录本会话使用的资料或持续偏好，例如：界面保持 macOS 风格和当前字号。不记录调查过程、测试流水或任务进度。
              </Text>
            ) : null}
          </View>
          {over ? <Text style={[styles.hint, { color: theme.danger }]}>{errors.body}</Text> : null}
          <SwitchLine
            theme={theme}
            label="自动向模型提供"
            detail={shortBodyMaxChars ? `短正文（≤ ${shortBodyMaxChars} 字符）直接提供，长资料按需读取；受总预算限制。` : '按当前服务的注入规则提供；实际内容可在预览中查看。'}
            value={form.autoReinjectCatalog}
            disabled={saving}
            onChange={(autoReinjectCatalog) => set({ autoReinjectCatalog })}
            testID="tm-auto"
          />
          {conversationTab ? (
            <SwitchLine
              theme={theme}
              label="允许 Agent 读取"
              detail="共享便笺作为同会话 Agent 的工作输入；不授予记忆工具或修改权限。"
              value={form.visibleToAgents}
              disabled={saving}
              onChange={(visibleToAgents) => set({ visibleToAgents })}
              testID="tm-agents"
            />
          ) : null}
        </ScrollView>
      ) : null}
      {children}
    </EditorPage>
  );
}

function SwitchLine({ theme, label, detail, value, disabled, onChange, testID }: { theme: Theme; label: string; detail: string; value: boolean; disabled?: boolean; onChange(v: boolean): void; testID?: string }) {
  return (
    <View style={styles.switchLine}>
      <View style={styles.flex}>
        <Text style={[styles.rowName, { color: theme.text }]}>{label}</Text>
        <Text style={[styles.small, { color: theme.muted, marginTop: 2 }]}>{detail}</Text>
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={(v) => {
          tap('select');
          onChange(v);
        }}
        trackColor={{ true: theme.button, false: theme.surfaceSoft }}
        thumbColor={value ? theme.buttonText : theme.panel}
        testID={testID}
      />
    </View>
  );
}

export function PrimaryButton({ theme, label, onPress, disabled, busy, icon, testID }: { theme: Theme; label: string; onPress(): void; disabled?: boolean; busy?: boolean; icon?: any; testID?: string }) {
  return (
    <Press onPress={onPress} disabled={disabled} style={[styles.primary, { backgroundColor: theme.button, opacity: disabled && !busy ? 0.45 : 1 }]} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }} testID={testID}>
      {busy ? <ActivityIndicator color={theme.buttonText} /> : (
        <>
          {icon ? <Icon as={icon} size={16} color={theme.buttonText} /> : null}
          <Text style={[styles.primaryText, { color: theme.buttonText }]}>{label}</Text>
        </>
      )}
    </Press>
  );
}

export function GhostButton({ theme, label, onPress, disabled, icon, danger, testID }: { theme: Theme; label: string; onPress(): void; disabled?: boolean; icon?: any; danger?: boolean; testID?: string }) {
  const color = danger ? theme.danger : theme.text;
  return (
    <Press onPress={onPress} disabled={disabled} style={[styles.ghost, { borderColor: theme.border, opacity: disabled ? 0.45 : 1 }]} accessibilityRole="button" testID={testID}>
      {icon ? <Icon as={icon} size={16} color={color} /> : null}
      <Text style={[styles.ghostText, { color }]}>{label}</Text>
    </Press>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  scroll: { paddingTop: 8 },
  wide: { maxWidth: 760, width: '100%', alignSelf: 'center' },
  intro: { fontSize: 13, lineHeight: 19, paddingHorizontal: 20, marginBottom: 10 },
  pad: { paddingHorizontal: 16 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, minHeight: 44 },
  small: { fontSize: 12.5, lineHeight: 17 },
  card: { marginHorizontal: 16, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 32, paddingHorizontal: 24, gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
  emptyText: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  ghostBtn: { height: 40, paddingHorizontal: 18, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingLeft: 14, paddingRight: 4, paddingVertical: 12 },
  rowName: { fontSize: 15, fontWeight: '500' },
  rowDesc: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  rowMeta: { fontSize: 12, marginTop: 5 },
  rowMore: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 7 },
  flag: { height: 22, paddingHorizontal: 8, borderRadius: 11, justifyContent: 'center' },
  flagText: { fontSize: 11.5, fontWeight: '500' },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 10 },
  taskPick: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginTop: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 10, minHeight: 56 },
  taskTitle: { fontSize: 15, fontWeight: '500', marginTop: 2 },
  taskRow: { paddingHorizontal: 20, paddingVertical: 10, minHeight: 56, justifyContent: 'center' },
  previewHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 12, minHeight: 52 },
  previewBody: { paddingHorizontal: 14, paddingBottom: 14, gap: 8 },
  note: { fontSize: 12.5, lineHeight: 18 },
  pre: { borderRadius: 10, maxHeight: 360 },
  mono: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
  detailBody: { paddingHorizontal: 20, paddingBottom: 20, gap: 12 },
  detailDesc: { fontSize: 14, lineHeight: 20 },
  notice: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  noticeText: { fontSize: 13.5 },
  link: { fontSize: 13.5, fontWeight: '600', textDecorationLine: 'underline' },
  md: { minHeight: 40 },
  tech: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 4 },
  techHead: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  techBody: { gap: 8, paddingBottom: 6 },
  kv: { flexDirection: 'row', gap: 10 },
  footerRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  primary: { height: 44, minWidth: 96, paddingHorizontal: 18, borderRadius: 22, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 15, fontWeight: '600' },
  ghost: { height: 44, paddingHorizontal: 16, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: 15 },
  bodyHead: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 8 },
  fieldLabel: { fontSize: 12.5, fontWeight: '500' },
  bodyEditorWrap: { marginHorizontal: 14, marginTop: 6 },
  bodyEditor: { height: 260, borderRadius: radius.md },
  placeholder: { position: 'absolute', left: 14, right: 14, top: 12, fontSize: 14, lineHeight: 20 },
  hint: { fontSize: 12.5, paddingHorizontal: 14, marginTop: 4 },
  switchLine: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
});
