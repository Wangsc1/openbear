// 会话树复用的 Web 纯逻辑（与 data/webLogic.ts 相同方式：通过 @openbear/web 别名直接引用 web/src，不复制改写）。
// 这些模块是 JS（无类型），这里补最小的 TS 声明，只覆盖会话树实际使用的部分。
/* eslint-disable @typescript-eslint/no-explicit-any */

// @ts-ignore - JS module without types
import * as activity from '@openbear/web/conversationActivity.js';
// @ts-ignore
import * as interactions from '@openbear/web/components/conversationTreeInteractions.js';
// @ts-ignore
import * as policy from '@openbear/web/components/promptPolicy.js';
// @ts-ignore
import * as runDefaults from '@openbear/web/components/folderRunDefaults.js';
// @ts-ignore
import * as overviewFormat from '@openbear/web/components/conversationOverviewFormat.js';
// @ts-ignore
import * as ledger from '@openbear/web/views/consoleView/ledgerUsage.js';
// @ts-ignore
import * as runConfigState from '@openbear/web/views/consoleView/runConfigState.js';
// @ts-ignore
import * as display from '@openbear/web/views/consoleView/display.js';

type Row = Record<string, any>;

// conversationActivity.js：未读/待处理/运行状态与已读回执
export const isActivityWaiting: (item: Row) => boolean = activity.isActivityWaiting;
export const activityState: (item: Row) => string = activity.activityState;
export const activityLabel: (item: Row) => string = activity.activityLabel;
export const activityReadRequests: (items: Row[]) => { conversationUuid: string; version: number }[] = activity.activityReadRequests;
export const applyActivityReadVersions: (status: Row, versions: Map<string, number>) => Row = activity.applyActivityReadVersions;
export const pendingConversationRows: (status: Row) => Row[] = activity.pendingConversationRows;
export const pendingFolderCounts: (items: Row[], folders: Row[]) => Map<string, number> = activity.pendingFolderCounts;

// conversationTreeInteractions.js：树节点身份、排序、拖放意图
export const treeItemId: (row: Row) => string = interactions.treeItemId;
export const treeItemParent: (row: Row) => string = interactions.treeItemParent;
export const compareTreeItems: (a: Row, b: Row) => number = interactions.compareTreeItems;
export const resolveTreeDrop = interactions.resolveTreeDrop as (source: Row, target: Row, ratio: number, known: Row[]) => { zone: 'before' | 'after' | 'inside'; targetFolderId: string; beforeId: string; afterId: string } | null;

// promptPolicy.js：提示词策略
export type PromptPolicy = { text: string; overrideSystemPrompt: boolean; toolsEnabled: boolean; toolNames: string[]; userMessageTemplateEnabled: boolean };
export const normalizePromptPolicy: (value?: Row) => PromptPolicy = policy.normalizePromptPolicy;
export const promptPolicyFlags: (value?: Row) => Omit<PromptPolicy, 'text'> = policy.promptPolicyFlags;
export const conversationPromptPolicy: (properties: Row) => PromptPolicy = policy.conversationPromptPolicy;
export const conversationPolicyPayload: (properties: Row) => Row = policy.conversationPolicyPayload;
export const promptToolGroups: (items: Row[], selected: string[]) => { label: string; items: Row[] }[] = policy.promptToolGroups;

// folderRunDefaults.js：目录默认运行配置（每项可继承）
export const RUN_DEFAULT_FIELDS: readonly string[] = runDefaults.RUN_DEFAULT_FIELDS;
export const sparseRunDefaults: (value: Row) => Row = runDefaults.sparseRunDefaults;
export const normalizedRunDefaults: (layers: Row, models: Row[]) => Row = runDefaults.normalizedRunDefaults;
export const resolvedRunDefaults: (local: Row, inherited: Row, fallback: Row, resolved?: Row) => Row = runDefaults.resolvedRunDefaults;
export const hasRunDefault: (value: Row, field: string) => boolean = runDefaults.hasRunDefault;

// 概览：时长、Token 拆分、累计耗时
export const formatOverviewDuration: (ms: number | null | undefined) => string = overviewFormat.formatOverviewDuration;
export const ledgerTokenParts: (usage: Row) => { input: number; output: number } = ledger.ledgerTokenParts;
export const totalSessionDurationMs: (input: Row) => number = ledger.totalSessionDurationMs;
export const fmtTokens: (n: number) => string = display.fmtTokens;
export const fmtNum: (n: number) => string = display.fmtNum;
export const fmtCost: (n: number) => string = display.fmtCost;
export const modelThinkingLevels: (model: Row | null) => string[] = display.modelThinkingLevels;
export const modelDefaultThinking: (model: Row | null) => string = display.modelDefaultThinking;

// runConfigState.js：会话运行配置快照校验
export const runConfigFromResponse: (response: Row, uuid?: string) => Row | null = runConfigState.runConfigFromResponse;

export const REUSED_TREE_WEB_MODULES = [
  'conversationActivity.js',
  'components/conversationTreeInteractions.js',
  'components/promptPolicy.js',
  'components/folderRunDefaults.js',
  'components/conversationOverviewFormat.js',
  'views/consoleView/ledgerUsage.js',
  'views/consoleView/runConfigState.js',
  'views/consoleView/display.js',
];
