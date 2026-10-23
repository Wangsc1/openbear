// 单一入口：App 实际复用的 web/src 纯逻辑模块（通过 Metro 别名 @openbear/web 直接引用，web/ 不改）。
// 只在这里集中导入，便于统计“实际复用了哪些模块”，也便于将来迁到 packages/core。
//
// 注意：这些模块是 JS（无类型），这里补最小的 TS 声明，类型只覆盖 App 实际使用的字段。
/* eslint-disable @typescript-eslint/no-explicit-any */

// @ts-ignore - JS module without types
import * as projection from '@openbear/web/timelineProjection.js';
// @ts-ignore
import * as pagination from '@openbear/web/views/consoleView/timelinePagination.js';
// @ts-ignore
import * as timeline from '@openbear/web/views/consoleView/conversationTimeline.js';
// @ts-ignore
import * as work from '@openbear/web/views/consoleView/conversationWork.js';
// @ts-ignore
import * as display from '@openbear/web/views/consoleView/display.js';
// @ts-ignore
import * as toolCall from '@openbear/web/views/consoleView/toolCallPresentation.js';
// @ts-ignore
import * as toolArgs from '@openbear/web/views/consoleView/toolArgumentsPresentation.js';
// @ts-ignore
import * as reuse from '@openbear/web/views/consoleView/timelineReuse.js';
// @ts-ignore
import * as interaction from '@openbear/web/views/consoleView/userInteractionPresentation.js';
// @ts-ignore
import * as agentPlan from '@openbear/web/views/consoleView/agentPlanPresentation.js';
// web markdown.js 的移植替身（plainText/answerContent），见 src/web-shims/markdown.js
// @ts-ignore
import * as markdownShim from '@openbear/web/views/consoleView/markdown.js';
// ---- b2（对话消息与卡片）复用的纯逻辑 ----
// @ts-ignore
import * as agentInstance from '@openbear/web/views/consoleView/agentInstancePresentation.js';
// @ts-ignore
import * as modelRetry from '@openbear/web/views/consoleView/modelRetryPresentation.js';
// @ts-ignore
import * as interactionState from '@openbear/web/views/consoleView/userInteractionState.js';
// @ts-ignore
import * as questionnaire from '@openbear/web/views/consoleView/questionnaireState.js';
// @ts-ignore
import * as replyShare from '@openbear/web/views/consoleView/replyMarkdownShare.js';
// @ts-ignore
import * as reasoningPreviewMod from '@openbear/web/views/consoleView/reasoningPreview.js';
// @ts-ignore
import * as modelOutput from '@openbear/web/views/consoleView/modelOutputPresentation.js';
// @ts-ignore
import * as htmlPreview from '@openbear/web/artifacts/htmlPreview.js';
// artifactFiles.js 依赖 vue/markdown-it/sessionBoundary，替身见 src/web-shims/artifactFiles.js；artifactPresentation.js 原样复用
// @ts-ignore
import * as artifactFiles from '@openbear/web/artifacts/artifactFiles.js';
// @ts-ignore
import * as artifactPresentationMod from '@openbear/web/artifacts/artifactPresentation.js';

export type Operation = {
  opId: string;
  opType: string;
  displaySeq: number;
  revision: number;
  status?: string;
  lifecycle?: string;
  payload: Record<string, any>;
  operationOrder?: number;
  detailAvailable?: boolean;
  detailLoaded?: boolean;
  [key: string]: any;
};

export type Frame = {
  frameSeq: number;
  opId: string;
  opType: string;
  action: string;
  revision: number;
  displaySeq: number;
  payload: Record<string, any>;
  [key: string]: any;
};

export type Continuation = {
  rootTurnUuid: string;
  runIds: string[];
  source: string;
  rootUserOpId: string;
  /** 秒 */
  rootStartedAt: number;
  rootPreview: string;
};

export type ProjectedMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: number;
  syntheticPlaceholder?: boolean;
  /** 一轮在后续轮次开始后被唤醒继续时，按实际时间单独成块（见 web timelineProjection） */
  continuation?: Continuation;
  localTimeline?: TimelineEvent[];
  localStats?: Record<string, any> | null;
  turnUuid?: string;
  [key: string]: any;
};

export type TimelineEvent = {
  kind: string;
  id: string;
  eventKey?: string;
  message?: { content?: string; reasoning?: string; live?: boolean; error?: boolean; failure?: boolean; reasoningDeferred?: boolean } | null;
  operation?: Operation;
  calls?: Array<{ id: string; name: string; arguments: string }>;
  toolName?: string;
  live?: boolean;
  status?: string;
  preview?: string;
  [key: string]: any;
};

export const projectOperationMessages: (ops: Operation[], options?: any) => ProjectedMessage[] = projection.projectOperationMessages;
export const applyOperationFrame: (store: any, frame: Frame) => boolean = projection.applyOperationFrame;
export const shouldApplyOperationFrame: (frame: Frame, store: any) => boolean = projection.shouldApplyOperationFrame;
export const applyLiveOperationUpdate: (store: any, update: Frame) => { applied: boolean; gap?: boolean } = projection.applyLiveOperationUpdate;
export const preferNewerLiveOperations: (incoming: Operation[], currentById: Map<string, Operation>) => Operation[] = projection.preferNewerLiveOperations;
export const deriveOperationRunState: (ops: Operation[]) => any = projection.deriveOperationRunState;
export const withTransientIdleThinking: (turns: any[], runState: any, options?: any) => any[] = projection.withTransientIdleThinking;
export const findActiveTurnIndex: (turns: any[], runState: any) => number = projection.findActiveTurnIndex;
export const normalizeOperations: (ops: Operation[]) => Operation[] = projection.normalizeOperations;
export const eventStartedAtMs: (event: any) => number = projection.eventStartedAtMs;
export const eventDisplayTimeMs: (event: any) => number = projection.eventDisplayTimeMs;
export const eventUpdatedAtMs: (event: any) => number = projection.eventUpdatedAtMs;

export const mergeOperationSnapshots: (current: Operation[], incoming: Operation[]) => Operation[] = pagination.mergeOperationSnapshots;
export const conversationTimelineEntries: (events: TimelineEvent[], primary?: any, isAgent?: any) => Array<{ event: TimelineEvent; index: number; part?: string }> =
  timeline.conversationTimelineEntries;
export const lastAnswerIndex: (events: TimelineEvent[]) => number = work.lastAnswerIndex;
export const conversationWorkChunks: (entries: any[], resultIndex: number) => Array<{ kind: 'work' | 'exposed'; key: string; entries: any[] }> =
  work.conversationWorkChunks;
export const workDurationLabel: (ms: number) => string = work.workDurationLabel;
export const reasoningDuration: (event: any) => number = work.reasoningDuration;

export const toolDisplayState: (event: any, activeIndex?: number, opts?: { includeDetail?: boolean }) => any = display.toolDisplayState;
export const toolSummaryTitle: (event: any) => string = display.toolSummaryTitle;
export const isAgentEvent: (event: any) => boolean = display.isAgentEvent;
export const agentSummary: (event: any) => { preview: string } = display.agentSummary;
export const agentDisplayState: (event: any) => any = display.agentDisplayState;
export const eventPrimaryToolName: (event: any) => string = display.eventPrimaryToolName;
export const fmtTokens: (n: number) => string = display.fmtTokens;
export const fmtMs: (ms: number) => string = display.fmtMs;
export const toolDisplayLabel: (name: string, fallback?: string) => string = toolCall.toolDisplayLabel;
export const buildToolArgumentsView: (toolName: string, raw: any) => any = toolArgs.buildToolArgumentsView;
export const toolArgumentsRawPayload: (toolName: string, raw: any) => any = toolArgs.toolArgumentsRawPayload;
export const createTimelineReuse: () => (next: ProjectedMessage[]) => ProjectedMessage[] = reuse.createTimelineReuse;
export const isUserInteractionEvent: (event: any) => boolean = interaction.isUserInteractionEvent;
export const buildUserInteractionView: (input: any) => any = interaction.buildUserInteractionView;
export const userInteractionEventInput: (event: any, operationOverride?: any) => any = interaction.userInteractionEventInput;
export const contextCompactionView: (value: any) => any = agentPlan.contextCompactionView;
export const answerContent: (text: string) => string = markdownShim.answerContent;

// ---- b2 ----
export const agentStatusMeta: (status: string, toolName?: string) => { label: string; cls: string } = display.agentStatusMeta;
export const agentTasks: (event: any) => any[] = display.agentTasks;
export const agentRowMetricChips: (row: any) => Array<{ key: string; label: string }> = display.agentRowMetricChips;
export const agentRowArgumentsDisplay: (event: any, row: any, index?: number, opts?: { full?: boolean }) => string = display.agentRowArgumentsDisplay;
export const agentRowOutputSection: (row: any) => { text: string; segmented?: boolean; originalChars?: number } | null = display.agentRowOutputSection;
export const recentEventMessage: (item: any) => string = display.recentEventMessage;
export const toolPreview: (event: any) => string = display.toolPreview;
export const fmtNum: (n: number) => string = display.fmtNum;
export const fmtCost: (n: number) => string = display.fmtCost;
export const fmtBytes: (n: number) => string = display.fmtBytes;
export const modelRetryReasonLabel: (retry: any) => string = display.modelRetryReasonLabel;
export const tokenPartsFromStats: (stats: any) => { input: number; output: number; cache: number } = display.tokenPartsFromStats;
export const cachePct: (cache: number, input: number) => string = display.cachePct;
export const toolResultItems: (event: any) => any[] = display.toolResultItems;
export const toolBatchSize: (event: any) => number = display.toolBatchSize;
export const toolBatchLabel: (event: any, idx: number) => string = display.toolBatchLabel;
export const toolResultForIndex: (event: any, idx: number) => any = display.toolResultForIndex;
export const toolResultText: (event: any, active?: any) => string = display.toolResultText;
export const callArgumentsDisplay: (call: any) => string = display.callArgumentsDisplay;
export const toolArgumentsSummary: (toolName: string, raw: any) => string = toolArgs.toolArgumentsSummary;

export const agentPlan$ = agentPlan as {
  buildAgentPlanView(snapshot: any, options?: { planVersion?: number }): any;
  preferredAgentPlanVersion(snapshot: any): number;
  initialAgentLaunch(snapshot: any, fallbackArguments?: string): any;
  agentStepActivityLines(events: any[], planVersion: number, stepId: string, interval?: any): any[];
  compactAgentStepActivityLines(events: any[], options?: any): any[];
  liveProgressEvent(liveProgress: any): any | null;
  buildAgentMonitorTimeline(events: any[], snapshot: any): any[];
  isAgentMonitorEventKind(kind: string): boolean;
  isActivityExcludedEventKind(kind: string): boolean;
  isActiveAgentEvent(event: any, state: any): boolean;
  agentTaskPushSnapshot(event: any, taskUuid: string): { operationRevision: number; latestSeq: number; events: any[] };
  mergeAgentEventLines(current: any[], incoming: any[]): { lines: any[]; novel: any[]; gap: boolean; latestSeq: number };
  agentCompactionActivityView(event: any): any;
  planPhaseMeta(value: string): any;
};
export const agentInstance$ = agentInstance as {
  currentAgentInstanceView(input: any): any;
  localAgentInstanceEnvelope(input: any): any;
  normalizeAgentInstanceEnvelope(data: any, input: any): any;
  shortAgentId(value: string, length?: number): string;
  agentInfoResultView(toolName: string, value: any): any;
};
export const retryWaitLabel: (retry: any) => string = modelRetry.retryWaitLabel;
export const retryStatusView: (retry: any) => { label: string; tone: string } = modelRetry.retryStatusView;
export const interaction$ = interactionState as {
  createInteractionDraft(item: any): { selectedIndexes: number[]; value: string; text: string };
  toggleInteractionOption(item: any, draft: any, index: number): any;
  clearInteractionSelection(draft: any): any;
  interactionPrimaryActionLabel(item: any, draft: any, submitting?: boolean): string;
  interactionRejectActionLabel(draft: any): string;
  validateInteractionDraft(item: any, draft: any): string;
  buildInteractionAnswer(item: any, draft: any, intent?: string): any;
  interactionRevision(item: any): number;
  isInteractionExpired(item: any, nowMs?: number): boolean;
  interactionExpiryLabel(item: any, nowMs?: number): string;
  isTerminalInteractionError(error: any): boolean;
  interactionErrorCode(error: any): string;
};
export const questionnaire$ = questionnaire as {
  createQuestionnaireDraft(questions: any[]): { answers: Record<string, { selectedValues: any[]; text: string }> };
  ensureQuestionAnswer(draft: any, question: any): { selectedValues: any[]; text: string };
  toggleQuestionChoice(draft: any, question: any, value: any): any;
  clearQuestionChoice(draft: any, question: any): void;
  isQuestionChoiceSelected(draft: any, question: any, option: any): boolean;
  validateQuestionnaire(questions: any[], draft: any): Record<string, string>;
  buildQuestionnaireAnswer(questions: any[], draft: any, cancelled?: boolean): any;
};
export const replyMarkdownText: (entries: any[]) => string = replyShare.replyMarkdownText;
export const reasoningPreviewText: (value: string) => string = reasoningPreviewMod.reasoningPreviewText;
export const modelOutputView: (progress: any, nowMs?: number) => any = modelOutput.modelOutputView;
export const htmlPreviewDocument: (source: string) => string = htmlPreview.htmlPreviewDocument;
export const artifactFormat: (meta: any) => { kind: string; label: string; language: string; sourceOnly?: boolean } = artifactFiles.artifactFormat;
export const formatFileSize: (bytes: number) => string = artifactFiles.formatFileSize;
export const artifactSharedPath: (meta: any) => string = artifactFiles.artifactSharedPath;
export const extractArtifactSummary: (text: string, kind: string) => { title: string; excerpt: string } = artifactFiles.extractArtifactSummary;
export const ARTIFACT_TEXT_PREVIEW_LIMIT: number = artifactFiles.TEXT_PREVIEW_LIMIT;
export const ARTIFACT_SUMMARY_LIMIT: number = artifactFiles.SUMMARY_LIMIT;
export const artifactPresentation: (meta: any) => { category: string; label: string; badge: string; action: string; previewable: boolean } =
  artifactPresentationMod.artifactPresentation;
export const plainText: (text: string) => string = markdownShim.plainText;

/** 与 Web ConsoleView.operationProjectionOptions() 相同的投影选项。 */
export const projectionOptions = { answerContent, agentSummary };

/** 报告用：本入口实际引用的 web/src 模块清单。 */
export const REUSED_WEB_MODULES = [
  'timelineProjection.js',
  'views/consoleView/timelinePagination.js',
  'views/consoleView/conversationTimeline.js',
  'views/consoleView/conversationWork.js',
  'views/consoleView/display.js',
  'views/consoleView/toolCallPresentation.js',
  'views/consoleView/toolArgumentsPresentation.js',
  'views/consoleView/timelineReuse.js',
  'views/consoleView/userInteractionPresentation.js',
  'views/consoleView/agentPlanPresentation.js',
  'views/consoleView/agentInstancePresentation.js',
  'views/consoleView/modelRetryPresentation.js',
  'views/consoleView/userInteractionState.js',
  'views/consoleView/questionnaireState.js',
  'views/consoleView/replyMarkdownShare.js',
  'views/consoleView/reasoningPreview.js',
  'artifacts/htmlPreview.js',
  'artifacts/artifactPresentation.js',
  // 传递依赖（由上面的模块导入）
  'views/consoleView/modelOutputPresentation.js',
  'views/consoleView/taskMemoryPresentation.js',
];
