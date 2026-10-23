/**
 * 对话页“更多”菜单的条目与它们打开的面板（会话面板工作包 B4 负责）。
 * ConversationView 只渲染返回的 items 和 panels，不关心每一项做什么。
 *
 * 返回值（已有字段 items / panels 不变，其余是 B4 新增的可选字段）：
 *  - items：下拉菜单条目（兜底用；接上 onMore 后不再显示下拉菜单）；
 *  - panels：本 hook 打开的所有面板（会话面板 Sheet、会话属性、更新系统提示词、产物，以及 b2 阅读工具的面板）；
 *  - onMore：点导航栏“⋯”时调用——打开“会话面板”Sheet（头部统计 + 分组列表），代替超长下拉菜单；
 *  - headerInfo：导航栏标题与副标题（B4-01/B4-03）：
 *      title    会话标题（同一会话改名时逐字动画）；
 *      subtitle 运行中：“运行中 · m:ss”（tone=run，前面画蓝点）；等待回答：“等待你的回答”（tone=wait）；
 *               其余：所在目录路径（“/openbear/手机端”或“临时会话”，tone=muted）；
 *  - subtitle：headerInfo.subtitle 的简写。
 *
 * ConversationView 需要补的接线（合并时由主控接）：
 *   1) 导航栏“⋯”：onPress = tools.onMore ?? (() => setMenuOpen(true))；
 *   2) NavRow：title = tools.headerInfo?.title ?? snapshot.title；subtitle = tools.headerInfo?.subtitle ?? 现有副标题；
 *      tone=run 时 accessory 用 <RunDot/>，tone=wait 时 subtitleColor = theme.warning；
 *   3) ctx 补传 listRef（b2 阅读工具需要）。
 */
import { ArrowUpToLine, Bookmark, FilePenLine, LayoutList } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';

import type { ConversationStore, ConversationSnapshot } from '../data/conversationStore';
import { useSession } from '../data/session';
import { ConversationPanelSheet } from '../panel/ConversationPanelSheet';
import { useAnimatedTitle, useFolderPath, useSessionStats, useTaskMemoryCount } from '../panel/hooks';
import { runStartedAtMs, waitingForAnswer } from '../panel/runInfo';
import { clockText, statsView } from '../panel/stats';
import { usePanelActions } from '../panel/usePanelActions';

export type ConversationMenuItem = { key: string; label: string; icon: LucideIcon; testID?: string; destructive?: boolean; disabled?: boolean; onPress?: () => void };

export type ConversationToolsContext = {
  uuid: string;
  store: ConversationStore;
  snapshot: ConversationSnapshot | null;
  scrollToTop(): void;
  /** 对话列表句柄（b2 阅读工具用：轮次导航、跟随最新）。可选：ConversationView 需要补传。 */
  listRef?: React.RefObject<any>;
  /** 对话页里的阅读工具条目（搜索、对话导航、隐藏内容、多选、跟随最新）：进入会话面板的“阅读”分组；面板由对话页自己渲染 */
  readingItems?: ConversationMenuItem[];
};

export type ConversationHeaderInfo = {
  title: string;
  subtitle: string;
  tone: 'run' | 'wait' | 'muted';
  /** 所在目录路径（运行中时副标题换成运行状态，路径仍在这里） */
  path: string;
};

export type ConversationTools = {
  items: ConversationMenuItem[];
  panels: React.ReactNode;
  onMore?: () => void;
  headerInfo?: ConversationHeaderInfo;
  subtitle?: string;
};

function useTicker(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function useConversationTools(ctx: ConversationToolsContext): ConversationTools {
  const session = useSession();
  const summary = session.conversations.find((c) => c.conversationUuid === ctx.uuid);
  const running = Boolean(ctx.snapshot?.running ?? summary?.running);
  const actions = usePanelActions(ctx.uuid, { running });
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => setPanelOpen(false), [ctx.uuid]);

  const reading = { items: ctx.readingItems ?? [] };

  const stats = useSessionStats(ctx.store);
  const view = useMemo(() => statsView(stats), [stats]);
  const memory = useTaskMemoryCount(ctx.uuid, !actions.draft);
  // 会话列表里还没有（刚创建的分支、从链接打开）时，用 /state 返回的会话信息
  const stateConversation = ctx.store?.stateMeta?.conversation;
  const folderKnown = Boolean(summary) || Boolean(stateConversation);
  const folderId = summary ? summary.folderId : stateConversation?.folderId;
  const folderPath = useFolderPath(folderId);
  const path = folderKnown ? folderPath : '';
  const rawTitle = String(summary?.title || ctx.snapshot?.title || stateConversation?.title || '');
  const title = useAnimatedTitle(rawTitle, ctx.uuid);
  const waiting = useMemo(() => waitingForAnswer(ctx.snapshot?.rows), [ctx.snapshot?.rows]);
  const startedAt = useMemo(() => runStartedAtMs(ctx.snapshot?.rows, Number(summary?.activeStartedAtMs || 0)), [ctx.snapshot?.rows, summary?.activeStartedAtMs]);
  const now = useTicker(running);

  // 打开面板时刷新任务记忆计数（其他入口改过记忆后回来）
  useEffect(() => {
    if (panelOpen) void memory.refresh();
  }, [panelOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const headerInfo: ConversationHeaderInfo = running
    ? { title: title || '对话', subtitle: startedAt && now > startedAt ? `运行中 · ${clockText(now - startedAt)}` : '运行中', tone: 'run', path }
    : waiting
      ? { title: title || '对话', subtitle: '等待你的回答', tone: 'wait', path }
      : { title: title || '对话', subtitle: path, tone: 'muted', path };

  const memoryLabel = memory.count ? `任务记忆 · ${memory.count}` : '任务记忆';
  const items: ConversationMenuItem[] = [
    { key: 'panel', label: '会话面板', icon: LayoutList, testID: 'menu-panel', onPress: () => setPanelOpen(true) },
    { key: 'memory', label: memoryLabel, icon: Bookmark, testID: 'menu-task-memory', disabled: actions.draft, onPress: () => actions.openTaskMemory() },
    { key: 'context', label: '编辑上下文', icon: FilePenLine, testID: 'menu-context-editor', disabled: actions.draft || running, onPress: () => actions.openContextEditor() },
    ...reading.items,
    { key: 'top', label: '跳到顶部', icon: ArrowUpToLine, testID: 'jump-top', onPress: ctx.scrollToTop },
  ];

  const panels = (
    <>
      <ConversationPanelSheet
        visible={panelOpen}
        onClose={() => setPanelOpen(false)}
        title={rawTitle}
        path={path}
        running={running}
        waiting={waiting}
        statusLabel={String(ctx.snapshot?.statusLabel || '')}
        runStartedAt={startedAt}
        now={now}
        stats={view}
        statsLoaded={stats.loaded}
        draft={actions.draft}
        memoryCount={memory.count}
        onProperties={() => actions.openSheet('properties', true)}
        onSystemPrompt={() => actions.openSheet('systemPrompt', true)}
        onTaskMemory={() => actions.openTaskMemory(true)}
        onContextEditor={() => actions.openContextEditor(true)}
        onArtifacts={() => actions.openSheet('artifacts', true)}
        onTop={ctx.scrollToTop}
        readingItems={reading.items}
      />
      {actions.panels}
    </>
  );

  return { items, panels, onMore: () => setPanelOpen(true), headerInfo, subtitle: headerInfo.subtitle };
}
