/**
 * 会话树的全部操作（长按菜单 + 每个操作的完整流程），手机列表/目录页与平板树共用：
 * - 会话菜单（B1-26～B1-37）：概览、新建同级、标为已读、生成名称、重命名、复制、置顶、在目录中定位、移动、更新系统提示词、归档、属性、多选、删除；
 * - 目录菜单（B1-38～B1-46）：在此新建会话、新建子目录、重命名、置顶、移动、定时任务、目录属性、多选、删除目录（迁移 → 影响 → 确认）；
 * - 系统节点 / 根菜单（B1-47、B1-48）：新建临时会话、新建根级目录、临时会话属性；
 * - 批量整理（App 新增）：moveRows / archiveRows / deleteRows；
 * - 新会话（B1-01）：草稿属于别的目录时先确认是否更改归属。
 * 所有操作都调用真实接口；失败时 toast 给出原因，界面不做乐观修改。
 */
import { router } from 'expo-router';
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  CheckCheck,
  CheckSquare,
  Clock,
  Copy,
  Crosshair,
  FolderInput,
  FolderPlus,
  Info,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Sparkles,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react-native';
import React, { useCallback, useMemo, useState } from 'react';
import { Text } from 'react-native';

import { useSession } from '../../data/session';
import { ConversationPropertiesSheet, SystemPromptUpdateSheet } from '../../properties/ConversationPropertiesSheet';
import { FolderPropertiesSheet } from '../../properties/FolderPropertiesSheet';
import { useImpactChooser } from '../../properties/impact';
import { clearDraft, getDraft, LOCAL_DRAFT_UUID, setDraftFolder } from '../../tree/draft';
import { ARCHIVE, conversationAbilities, isRunningRow, type Row, sumImpacts, TEMP } from '../../tree/treeModel';
import { apiErrorText, markOpenedRead, parentOf, tree } from '../../tree/treeStore';
import { ActionMenu, type MenuAnchor, type MenuItem } from '../ActionMenu';
import { ConfirmSheet } from '../Form';
import { tap } from '../primitives';
import { showToast } from '../Toast';
import { MovePicker, type MoveMode } from './MovePicker';
import { OverviewSheet } from './OverviewSheet';
import { ChoiceSheet, PromptSheet } from './treeKit';

export type MenuContext = { recent?: boolean; search?: boolean; inFolderPage?: string };

type Dialog =
  | { kind: 'prompt'; title: string; hint?: string; initial?: string; submitLabel: string; run(value: string): Promise<void> }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; run(): Promise<void> }
  | { kind: 'move'; mode: MoveMode; rows: Row[]; done?: () => void }
  | { kind: 'draft'; target: string; temporary: boolean }
  | { kind: 'prompt-update'; uuid: string }
  | { kind: 'conv-props'; uuid: string }
  | { kind: 'folder-props'; folderId: string; name: string }
  | { kind: 'overview'; row: Row }
  | null;

export type TreeActionsOptions = {
  /** 打开会话（手机 push 对话页；平板切换右栏） */
  open(row: Row): void;
  /** 当前打开的会话（平板）：归档它时打开服务端给的下一个会话 */
  activeUuid?: string;
  /** 在目录中定位（手机进入目录页；平板展开路径并高亮） */
  reveal(row: Row): void;
  /** 进入多选并勾选这一项 */
  startSelect?(row: Row): void;
};

export function useTreeActions(options: TreeActionsOptions) {
  const session = useSession();
  const [menu, setMenu] = useState<{ row: Row; anchor: MenuAnchor; ctx: MenuContext } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState('');
  const [impactElement, chooseImpact] = useImpactChooser();

  const afterChange = useCallback(() => {
    void session.refresh().catch(() => undefined);
  }, [session.refresh]);

  const guard = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (error) {
      showToast(apiErrorText(error));
    } finally {
      setBusy('');
    }
  }, []);

  // ---- 新会话（B1-01 / B1-03 / B1-05 / B1-26 / B1-38） ----
  const goNew = useCallback((folderId: string) => {
    router.push({ pathname: '/conversation/new', params: folderId ? { folderId } : { temporary: '1' } });
  }, []);
  const newConversation = useCallback(
    (folderId = '') => {
      const target = folderId === TEMP ? '' : String(folderId || '');
      const draft = getDraft();
      if (draft && draft.folderId !== target) {
        setDialog({ kind: 'draft', target, temporary: !target });
        return;
      }
      setDraftFolder(draft ? draft.folderId : target);
      goNew(draft ? draft.folderId : target);
    },
    [goNew],
  );

  const promptNewFolder = useCallback(
    (parentId = '') => {
      const parent = parentId === TEMP || parentId === ARCHIVE ? '' : parentId;
      const path = parent ? tree.state.folders.find((f) => f.folderId === parent)?.path || '所选目录' : '';
      setDialog({
        kind: 'prompt',
        title: parent ? '新建子目录' : '新建根级目录',
        hint: `${parent ? `建在「${path}」下。` : ''}目录可继续包含任意深度的子目录和会话。`,
        submitLabel: '创建',
        run: async (name) => {
          await tree.createFolder(name, parent);
          showToast('目录已创建');
        },
      });
    },
    [],
  );

  // ---- 移动 / 删除目录 ----
  const moveRows = useCallback((rows: Row[], done?: () => void) => setDialog({ kind: 'move', mode: 'move', rows, done }), []);
  const submitMove = useCallback(
    async (rows: Row[], target: string, opts: { unarchive: boolean; updateSnapshots: boolean }, done?: () => void) => {
      setBusy('move');
      try {
        const archivedSingle = rows.length === 1 && rows[0].kind === 'conversation' && rows[0].archived;
        const movable = archivedSingle ? rows : rows.filter((row) => (row.kind === 'folder' ? String(row.parentId || '') : String(row.folderId || '')) !== target || row.archived);
        if (!movable.length) {
          setDialog(null);
          return;
        }
        let updateSnapshots = archivedSingle ? opts.updateSnapshots : false;
        if (!archivedSingle) {
          const impacts = await Promise.all(movable.map((row) => tree.moveImpact(row, target)));
          setBusy('');
          const choice = await chooseImpact(movable.length > 1 ? `移动 ${movable.length} 项` : '移动', sumImpacts(impacts as any[]));
          if (choice === null) return;
          updateSnapshots = choice === true;
          setBusy('move');
        }
        let skipped = 0;
        let failed = 0;
        let firstError = '';
        for (const row of movable) {
          try {
            const result: any = await tree.move(row, target, { updateSnapshots, unarchive: archivedSingle ? opts.unarchive : false });
            skipped += Number(result?.skippedRunningCount || 0);
          } catch (error) {
            failed += 1;
            firstError = firstError || apiErrorText(error);
          }
        }
        void tree.afterMutation([...movable.map(parentOf), target || TEMP]);
        afterChange();
        setDialog(null);
        if (!failed) done?.();
        if (failed) showToast(`${movable.length - failed} 项已移动，${failed} 项失败：${firstError}`);
        else showToast(skipped ? `已移动；${skipped} 个运行中会话的快照本次跳过，不会延后更新` : movable.length > 1 ? `已移动 ${movable.length} 项` : '已移动');
      } catch (error) {
        showToast(apiErrorText(error));
      } finally {
        setBusy('');
      }
    },
    [afterChange, chooseImpact],
  );
  const submitDeleteFolder = useCallback(
    async (row: Row, target: string) => {
      setBusy('move');
      try {
        const impact: any = await tree.deleteFolderImpact(row, target);
        setBusy('');
        setDialog({
          kind: 'confirm',
          title: `删除目录「${row.name}」`,
          message: `目录中的子目录与会话会迁移到「${target ? tree.state.folders.find((f) => f.folderId === target)?.path || '所选目录' : '根级 / 临时会话'}」；聊天内容不会删除。`,
          confirmLabel: '迁移并删除',
          run: async () => {
            const choice = await chooseImpact('删除并迁移', impact);
            if (choice === null) return;
            const result: any = await tree.deleteFolder(row, target, choice === true);
            afterChange();
            showToast(`目录已删除，聊天内容已迁移${result?.skippedRunningCount ? `；运行中快照跳过 ${result.skippedRunningCount} 个` : ''}`);
          },
        });
      } catch (error) {
        showToast(apiErrorText(error));
        setBusy('');
      }
    },
    [afterChange, chooseImpact],
  );

  // ---- 批量（App 新增） ----
  const archiveRows = useCallback(
    async (rows: Row[]) => {
      const conversations = rows.filter((r) => r.kind === 'conversation' && !r.local);
      const archiving = !conversations.every((r) => r.archived);
      let failed = 0;
      await guard('archive', async () => {
        for (const row of conversations) {
          try {
            await tree.requireApi().setConversationArchived(row.conversationUuid, archiving);
            tree.forget(row);
          } catch {
            failed += 1;
          }
        }
        void tree.afterMutation([...conversations.map(parentOf), ARCHIVE]);
        afterChange();
      });
      showToast(failed ? `${conversations.length - failed} 个已${archiving ? '归档' : '取消归档'}，${failed} 个失败` : `已${archiving ? '归档' : '取消归档'} ${conversations.length} 个会话`);
      return !failed;
    },
    [guard, afterChange],
  );
  const deleteRows = useCallback(
    (rows: Row[], done?: () => void) => {
      const conversations = rows.filter((r) => r.kind === 'conversation');
      const running = conversations.filter(isRunningRow).length;
      setDialog({
        kind: 'confirm',
        title: conversations.length > 1 ? `删除 ${conversations.length} 个会话` : `删除会话「${conversations[0]?.title || '新会话'}」`,
        message: `${running ? `其中 ${running} 个正在运行，不能删除，会被跳过。` : ''}删除后会话的聊天记录、附件和产物关联将无法恢复。`,
        confirmLabel: '删除',
        run: async () => {
          let failed = 0;
          for (const row of conversations.filter((r) => !isRunningRow(r))) {
            if (row.local || row.conversationUuid === LOCAL_DRAFT_UUID) {
              clearDraft();
              continue;
            }
            try {
              await tree.requireApi().deleteConversation(row.conversationUuid);
              tree.forget(row);
            } catch {
              failed += 1;
            }
          }
          void tree.afterMutation([...conversations.map(parentOf)]);
          afterChange();
          showToast(failed ? `${failed} 个删除失败` : '已删除');
          done?.();
        },
      });
    },
    [afterChange],
  );

  // ---- 单项操作 ----
  const archiveOne = useCallback(
    async (row: Row) => {
      await guard('archive', async () => {
        const archiving = !row.archived;
        const result = await tree.setArchived(row, archiving);
        afterChange();
        showToast(archiving ? '已归档' : '已取消归档');
        if (archiving && options.activeUuid && options.activeUuid === row.conversationUuid) {
          if (result?.nextConversation?.conversationUuid) options.open(result.nextConversation);
          else newConversation(String(row.folderId || ''));
        }
      });
    },
    [guard, afterChange, options, newConversation],
  );

  const conversationItems = useCallback(
    (row: Row, ctx: MenuContext): MenuItem[] => {
      const can = conversationAbilities(row, tree.state.generating.has(String(row.conversationUuid)));
      const items: MenuItem[] = [];
      if (!can.local) items.push({ key: 'overview', label: '会话概览', icon: BarChart3, onPress: () => setDialog({ kind: 'overview', row }) });
      items.push({ key: 'new-sibling', label: '新建同级会话', icon: MessageSquarePlus, onPress: () => newConversation(String(row.folderId || '')) });
      if (can.canMarkRead)
        items.push({
          key: 'read',
          label: '标为已读',
          icon: CheckCheck,
          onPress: () => void guard('read', async () => void (await tree.markRead([row]))),
        });
      items.push({
        key: 'generate-title',
        label: tree.state.generating.has(String(row.conversationUuid)) ? '正在生成…' : '生成会话名称',
        icon: Sparkles,
        disabled: !can.canGenerateTitle,
        onPress: () =>
          void (async () => {
            showToast('正在生成会话名称…');
            try {
              const result = await tree.generateTitle(row);
              afterChange();
              showToast(result?.changed ? '会话名称已生成' : '会话名称无需更新');
            } catch (error) {
              showToast(apiErrorText(error));
            }
          })(),
      });
      items.push({
        key: 'rename',
        label: '重命名',
        icon: Pencil,
        disabled: !can.canRename,
        onPress: () =>
          setDialog({
            kind: 'prompt',
            title: '重命名会话',
            initial: String(row.title || ''),
            submitLabel: '保存',
            run: async (value) => {
              await tree.rename(row, value);
              afterChange();
            },
          }),
      });
      items.push({
        key: 'duplicate',
        label: '复制会话',
        icon: Copy,
        disabled: !can.canDuplicate,
        onPress: () =>
          void guard('duplicate', async () => {
            const copy = await tree.duplicate(row);
            afterChange();
            showToast('已复制会话');
            if (copy?.conversationUuid) options.open(copy);
          }),
      });
      items.push({ key: 'pin', label: row.pinned ? '取消置顶' : '置顶', icon: row.pinned ? StarOff : Star, disabled: !can.canPin, onPress: () => void guard('pin', async () => void (await tree.togglePin(row))) });
      if (ctx.recent || ctx.search) items.push({ key: 'locate', label: '在目录中定位', icon: Crosshair, separatorBefore: true, onPress: () => options.reveal(row) });
      items.push({ key: 'move', label: '移动到…', icon: FolderInput, disabled: !can.canMove, separatorBefore: !(ctx.recent || ctx.search), onPress: () => moveRows([row]) });
      items.push({ key: 'refresh-prompt', label: '更新系统提示词…', icon: RefreshCw, disabled: !can.canUpdatePrompt, onPress: () => setDialog({ kind: 'prompt-update', uuid: row.conversationUuid }) });
      items.push({ key: 'archive', label: row.archived ? '取消归档' : '归档', icon: row.archived ? ArchiveRestore : Archive, disabled: !can.canArchive, onPress: () => void archiveOne(row) });
      items.push({ key: 'properties', label: '会话属性', icon: Info, onPress: () => setDialog({ kind: 'conv-props', uuid: row.conversationUuid }) });
      if (options.startSelect && !can.local) items.push({ key: 'select', label: '多选整理', icon: CheckSquare, onPress: () => options.startSelect?.(row) });
      items.push({ key: 'delete', label: '删除会话', icon: Trash2, destructive: true, separatorBefore: true, disabled: !can.canDelete, onPress: () => deleteRows([row]) });
      return items;
    },
    [afterChange, archiveOne, deleteRows, guard, moveRows, newConversation, options],
  );

  const folderItems = useCallback(
    (row: Row): MenuItem[] => {
      return [
        { key: 'new-conversation', label: '在此新建会话', icon: MessageSquarePlus, onPress: () => newConversation(row.folderId) },
        { key: 'new-folder', label: '新建子目录', icon: FolderPlus, onPress: () => promptNewFolder(row.folderId) },
        {
          key: 'rename',
          label: '重命名',
          icon: Pencil,
          separatorBefore: true,
          onPress: () =>
            setDialog({
              kind: 'prompt',
              title: '重命名目录',
              initial: String(row.name || ''),
              submitLabel: '保存',
              run: async (value) => {
                await tree.rename(row, value);
                afterChange();
              },
            }),
        },
        { key: 'pin', label: row.pinned ? '取消置顶' : '置顶', icon: row.pinned ? StarOff : Star, onPress: () => void guard('pin', async () => void (await tree.togglePin(row))) },
        { key: 'move', label: '移动到…', icon: FolderInput, onPress: () => moveRows([row]) },
        {
          key: 'cron',
          label: '定时任务',
          icon: Clock,
          onPress: () => {
            router.navigate('/automation');
            showToast(`按目录「${row.name}」筛选定时任务将在后续版本支持`);
          },
        },
        { key: 'properties', label: '目录属性', icon: Info, onPress: () => setDialog({ kind: 'folder-props', folderId: row.folderId, name: row.name }) },
        ...(options.startSelect ? [{ key: 'select', label: '多选整理', icon: CheckSquare, onPress: () => options.startSelect?.(row) }] : []),
        {
          key: 'delete-folder',
          label: '删除目录',
          icon: Trash2,
          destructive: true,
          separatorBefore: true,
          onPress: () => setDialog({ kind: 'move', mode: 'delete', rows: [row] }),
        },
      ];
    },
    [afterChange, guard, moveRows, newConversation, options, promptNewFolder],
  );

  /** 系统节点（临时会话 / 已归档）与根菜单。folderId 给出时（目录页的“+”）额外提供“在此新建会话 / 新建子目录”。 */
  const rootItems = useCallback(
    (systemNode: '' | 'temporary' | 'archive', folderId = ''): MenuItem[] => {
      const items: MenuItem[] = [];
      if (folderId) {
        const path = tree.state.folders.find((f) => f.folderId === folderId)?.path || '当前目录';
        items.push({ key: 'new-here', label: `新建会话 · ${path}`, icon: MessageSquarePlus, onPress: () => newConversation(folderId) });
        items.push({ key: 'new-sub', label: `新建目录 · ${path}`, icon: FolderPlus, onPress: () => promptNewFolder(folderId) });
      }
      if (systemNode !== 'archive') items.push({ key: 'new-temp', label: '新建临时会话', icon: MessageSquarePlus, separatorBefore: Boolean(folderId), onPress: () => newConversation('') });
      items.push({ key: 'new-root-folder', label: '新建根级目录', icon: FolderPlus, onPress: () => promptNewFolder('') });
      if (systemNode === 'temporary') items.push({ key: 'temp-props', label: '临时会话属性', icon: Info, separatorBefore: true, onPress: () => setDialog({ kind: 'folder-props', folderId: TEMP, name: '临时会话' }) });
      return items;
    },
    [newConversation, promptNewFolder],
  );

  const openMenu = useCallback((row: Row, at: { x: number; y: number }, ctx: MenuContext = {}) => {
    tap('medium');
    setMenu({ row, anchor: { x: at.x, y: at.y }, ctx });
  }, []);

  const menuItems = useMemo(() => {
    if (!menu) return [];
    const { row, ctx } = menu;
    if (row.kind === 'folder') return folderItems(row);
    if (row.kind === 'system') return rootItems(row.id === TEMP ? 'temporary' : 'archive');
    if (row.kind === 'root') return rootItems('', row.folderId || '');
    return conversationItems(row, ctx);
  }, [menu, folderItems, rootItems, conversationItems]);

  const menuTitle = menu ? (menu.row.kind === 'folder' ? menu.row.path || menu.row.name : menu.row.kind === 'conversation' ? menu.row.title || '新会话' : menu.row.kind === 'system' ? menu.row.name : undefined) : undefined;

  const openConversation = useCallback(
    (row: Row) => {
      if (row.local || row.conversationUuid === LOCAL_DRAFT_UUID) {
        goNew(String(row.folderId || ''));
        return;
      }
      markOpenedRead(row);
      options.open(row);
    },
    [goNew, options],
  );

  const d = dialog;
  const element = (
    <>
      <ActionMenu visible={Boolean(menu)} anchor={menu?.anchor ?? null} title={menuTitle} items={menuItems} dim onClose={() => setMenu(null)} />
      <PromptSheet
        visible={d?.kind === 'prompt'}
        title={d?.kind === 'prompt' ? d.title : ''}
        hint={d?.kind === 'prompt' ? d.hint : undefined}
        initial={d?.kind === 'prompt' ? d.initial || '' : ''}
        submitLabel={d?.kind === 'prompt' ? d.submitLabel : '保存'}
        placeholder="名称"
        onClose={() => setDialog(null)}
        onSubmit={async (value) => {
          if (d?.kind !== 'prompt') return;
          try {
            await d.run(value);
          } catch (error) {
            throw new Error(apiErrorText(error));
          }
        }}
      />
      <ConfirmSheet
        visible={d?.kind === 'confirm'}
        title={d?.kind === 'confirm' ? d.title : ''}
        message={d?.kind === 'confirm' ? d.message : undefined}
        confirmLabel={d?.kind === 'confirm' ? d.confirmLabel : '确认'}
        busy={busy === 'confirm'}
        onClose={() => busy !== 'confirm' && setDialog(null)}
        onConfirm={() => {
          if (d?.kind !== 'confirm') return;
          setBusy('confirm');
          void d
            .run()
            .then(() => setDialog(null))
            .catch((error) => showToast(apiErrorText(error)))
            .finally(() => setBusy(''));
        }}
      />
      <MovePicker
        visible={d?.kind === 'move'}
        mode={d?.kind === 'move' ? d.mode : 'move'}
        sources={d?.kind === 'move' ? d.rows : []}
        busy={busy === 'move'}
        onClose={() => setDialog(null)}
        onSubmit={(target, opts) => {
          if (d?.kind !== 'move') return;
          if (d.mode === 'delete') void submitDeleteFolder(d.rows[0], target);
          else void submitMove(d.rows, target, opts, d.done);
        }}
      />
      <ChoiceSheet
        visible={d?.kind === 'draft'}
        title="更改草稿归属"
        message={`当前未发送草稿属于「${getDraft()?.folderId ? tree.state.folders.find((f) => f.folderId === getDraft()?.folderId)?.path || '另一目录' : '临时会话'}」。是否明确把该草稿（含文字和附件）改到新的目标？`}
        testID="draft-reassign"
        choices={[
          { key: 'change', label: '更改归属', tone: 'primary', testID: 'draft-change' },
          { key: 'keep', label: '保持原归属', tone: 'plain', testID: 'draft-keep' },
        ]}
        onChoose={(key) => {
          if (d?.kind !== 'draft') return;
          setDialog(null);
          if (key === null) return;
          const folder = key === 'change' ? d.target : getDraft()?.folderId || '';
          setDraftFolder(folder);
          showToast('已聚焦未发送的新会话');
          goNew(folder);
        }}
      />
      <SystemPromptUpdateSheet uuid={d?.kind === 'prompt-update' ? d.uuid : ''} visible={d?.kind === 'prompt-update'} onClose={() => setDialog(null)} />
      <ConversationPropertiesSheet uuid={d?.kind === 'conv-props' ? d.uuid : ''} visible={d?.kind === 'conv-props'} onClose={() => setDialog(null)} />
      <FolderPropertiesSheet folderId={d?.kind === 'folder-props' ? d.folderId : ''} name={d?.kind === 'folder-props' ? d.name : ''} visible={d?.kind === 'folder-props'} onClose={() => setDialog(null)} />
      <OverviewSheet row={d?.kind === 'overview' ? d.row : null} visible={d?.kind === 'overview'} onClose={() => setDialog(null)} />
      {impactElement}
      {busy && busy !== 'confirm' && busy !== 'move' ? <Text accessibilityLiveRegion="polite" style={{ position: 'absolute', opacity: 0 }}>{busy}</Text> : null}
    </>
  );

  return {
    element,
    busy,
    openMenu,
    closeMenu: () => setMenu(null),
    openConversation,
    newConversation,
    promptNewFolder,
    moveRows,
    archiveRows,
    deleteRows,
    showFolderProperties: (folderId: string, name: string) => setDialog({ kind: 'folder-props', folderId, name }),
    menuFor: (row: Row, ctx: MenuContext = {}) => (row.kind === 'folder' ? folderItems(row) : row.kind === 'system' ? rootItems(row.id === TEMP ? 'temporary' : 'archive') : row.kind === 'root' ? rootItems('', row.folderId || '') : conversationItems(row, ctx)),
  };
}
