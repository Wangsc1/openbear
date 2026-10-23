/**
 * 会话累计统计与头部信息（B4-01～B4-06）的纯逻辑。
 *
 * 口径与 Web ConsoleView / ConsoleHeader / MobileConversationTools 完全一致，直接复用 Web 的纯逻辑：
 *  - ledgerUsage.js：normalizeLedgerUsageBaseline / ledgerTokenParts / applyLedgerUsageSnapshot / totalSessionDurationMs；
 *  - display.js：fmtTokens / fmtMs / fmtCost / cachePct / conversationPathText / tokenLine；
 *  - contextUsage.js：resolveContextUsage / mergeStatsContextUsage / invalidateContextUsage。
 * 数据来自 GET /state（usage、contextUsage、timelineTotalDurationMs、modelCalls）与会话 WS 帧
 * （stats 帧里的 ledgerUsage / contextUsage；其他帧 payload.ledgerUsage），不依赖 React，便于 node --test。
 */
// @ts-ignore - JS module without types
import * as ledger from '@openbear/web/views/consoleView/ledgerUsage.js';
// @ts-ignore
import * as display from '@openbear/web/views/consoleView/display.js';
// @ts-ignore
import * as contextUsageLogic from '@openbear/web/views/consoleView/contextUsage.js';

export type LedgerUsage = {
  ledger_revision: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  stat_total_time_ms_sum?: number;
  [key: string]: any;
};

export type ContextUsage = {
  known: boolean;
  tokens: number;
  rolloverTriggerTokens: number;
  percent: number | null;
  [key: string]: any;
};

export type SessionStats = {
  usage: LedgerUsage;
  contextUsage: ContextUsage;
  /** 时间线累计耗时（stats 操作 durationMs 之和；state 接口给出） */
  timelineTotalDurationMs: number;
  /** model_calls 明细的 total_time_ms 之和（旧后端回退口径） */
  modelCallsMs: number;
  /** 最近一次 stats 帧的 durationMs（运行中实时值） */
  liveMs: number;
  /** stats 帧里的本轮 durationMs，按 opId 记录；求和得到时间线耗时的实时补充 */
  statsDurations: Record<string, number>;
  rolloverTriggerTokens: number;
  contextWindow: number;
  loaded: boolean;
};

const ledgerAny: any = ledger;
const displayAny: any = display;
const ctxAny: any = contextUsageLogic;
export const normalizeLedgerUsageBaseline: (usage?: any) => LedgerUsage = ledgerAny.normalizeLedgerUsageBaseline;
export const ledgerTokenParts: (usage?: any) => { input: number; output: number; cache: number } = ledgerAny.ledgerTokenParts;
export const applyLedgerUsageSnapshot: (current: any, snapshot: any) => { usage: LedgerUsage; applied: boolean } = ledgerAny.applyLedgerUsageSnapshot;
export const totalSessionDurationMs: (input: { turns?: any[]; modelCalls?: any[]; liveMs?: number; timelineTotalDurationMs?: number; ledgerUsage?: any }) => number = ledgerAny.totalSessionDurationMs;
export const fmtTokens: (n: number) => string = displayAny.fmtTokens;
export const fmtMs: (ms: number) => string = displayAny.fmtMs;
export const fmtCost: (n: number) => string = displayAny.fmtCost;
export const cachePct: (cache: number, input: number) => string = displayAny.cachePct;
export const conversationPathText: (path: string) => string = displayAny.conversationPathText;
export const tokenLine: (parts: { input: number; output: number; cache: number }) => string = displayAny.tokenLine;
export const resolveContextUsage: (server: any, legacy?: number) => ContextUsage = ctxAny.resolveContextUsage;
export const mergeStatsContextUsage: (current: any, stats: any, defaults?: any) => ContextUsage = ctxAny.mergeStatsContextUsage;
export const invalidateContextUsage: (current: any, defaults?: any) => ContextUsage = ctxAny.invalidateContextUsage;

export function emptyStats(): SessionStats {
  return {
    usage: normalizeLedgerUsageBaseline({}),
    contextUsage: { known: false, tokens: 0, rolloverTriggerTokens: 0, percent: null },
    timelineTotalDurationMs: 0,
    modelCallsMs: 0,
    liveMs: 0,
    statsDurations: {},
    rolloverTriggerTokens: 0,
    contextWindow: 0,
    loaded: false,
  };
}

/** GET /state 的返回 -> 统计基线（与 Web ConsoleView 读取 chatState 的字段一致）。 */
export function statsFromState(state: any): SessionStats {
  const rollover = Number(state?.rolloverTriggerTokens || state?.contextUsage?.rolloverTriggerTokens || 0);
  const modelCalls = Array.isArray(state?.modelCalls) ? state.modelCalls : [];
  return {
    usage: normalizeLedgerUsageBaseline(state?.usage || {}),
    contextUsage: resolveContextUsage(state?.contextUsage, Number(state?.usage?.last_input_tokens || 0)),
    timelineTotalDurationMs: Math.max(0, Number(state?.timelineTotalDurationMs || 0)),
    modelCallsMs: modelCalls.reduce((sum: number, row: any) => sum + Number(row?.total_time_ms || 0), 0),
    liveMs: 0,
    statsDurations: {},
    rolloverTriggerTokens: rollover,
    contextWindow: Number(state?.contextWindow || 0),
    loaded: true,
  };
}

/**
 * 应用一帧（会话 WS 的 frame）：
 *  - stats 帧：ledgerUsage（带 revision 的绝对账本，只增不减）、contextUsage、本轮 durationMs；
 *  - 上下文窗口轮转/压缩完成：上下文用量失效（待实测）；
 *  - 其他帧 payload.ledgerUsage：账本快照。
 * 返回新对象；没有变化时返回原对象。
 */
export function applyStatsFrame(current: SessionStats, frame: any): SessionStats {
  if (!frame || typeof frame !== 'object') return current;
  const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {};
  let next = current;
  const ledgerResult = applyLedgerUsageSnapshot(current.usage, payload.ledgerUsage);
  if (ledgerResult.applied) next = { ...next, usage: ledgerResult.usage };
  if (frame.opType === 'stats') {
    const merged = mergeStatsContextUsage(next.contextUsage, payload.contextUsage, { rolloverTriggerTokens: next.rolloverTriggerTokens });
    if (merged !== next.contextUsage) next = { ...next, contextUsage: merged };
    const duration = Math.max(0, Number(payload.durationMs || 0));
    const opId = String(frame.opId || '');
    if (duration && opId && next.statsDurations[opId] !== duration) {
      next = { ...next, statsDurations: { ...next.statsDurations, [opId]: duration }, liveMs: 0 };
    }
    // 旧后端：stats 只给 ledgerCostUsd（没有带 revision 的账本），且账本从未应用过时才采用
    const legacyCost = Number(payload.ledgerCostUsd);
    if (!payload.ledgerUsage && Number(next.usage.ledger_revision || 0) <= 0 && Number.isFinite(legacyCost) && legacyCost >= 0 && legacyCost !== next.usage.cost_usd) {
      next = { ...next, usage: { ...next.usage, cost_usd: legacyCost } };
    }
  } else if (
    ['context_window', 'context_compaction'].includes(frame.opType)
    && (frame.lifecycle === 'terminal' || frame.action === 'terminal' || payload.status === 'completed' || frame.status === 'completed')
    && payload.windowVersion
  ) {
    const invalidated = invalidateContextUsage(next.contextUsage, { ...payload, rolloverTriggerTokens: next.rolloverTriggerTokens });
    if (invalidated !== next.contextUsage) next = { ...next, contextUsage: invalidated };
  }
  return next;
}

export type StatsView = {
  totalTokens: number;
  totalTokensText: string;
  /** 明细（悬停文案的等价物，在面板里直接展示） */
  tokensDetail: string;
  parts: { input: number; output: number; cache: number };
  cacheWrite: number;
  cachePercentText: string;
  durationMs: number;
  durationText: string;
  costUsd: number;
  costText: string;
  /** 上下文：已用 / 触发阈值（百分比）；未知时“待实测” */
  contextUsedText: string;
  contextLimitText: string;
  contextPercent: number | null;
  contextPercentText: string;
};

/** 与 Web ConsoleView 的 totalTokensDisplay / totalDurationMs / totalCostDisplay / contextDisplay 一致的展示值。 */
export function statsView(stats: SessionStats): StatsView {
  const usage = normalizeLedgerUsageBaseline(stats.usage);
  const parts = ledgerTokenParts(usage);
  const totalTokens = parts.input + parts.output;
  // /state 的时间线累计 + 打开之后新到的 stats 帧（每轮一条，按 opId 去重）
  const timelineMs = stats.timelineTotalDurationMs + Object.values(stats.statsDurations).reduce((a, b) => a + b, 0);
  const durationMs = totalSessionDurationMs({
    turns: [],
    modelCalls: [{ total_time_ms: stats.modelCallsMs }],
    liveMs: stats.liveMs,
    timelineTotalDurationMs: timelineMs,
    ledgerUsage: usage,
  });
  const rollover = Number(stats.contextUsage.rolloverTriggerTokens || stats.rolloverTriggerTokens || 0);
  const known = Boolean(stats.contextUsage.known);
  const percent = known && rollover ? Math.min(999, (Number(stats.contextUsage.tokens || 0) * 100) / rollover) : null;
  return {
    totalTokens,
    totalTokensText: fmtTokens(totalTokens),
    tokensDetail: `${totalTokens.toLocaleString('en-US')} Tokens（输入 + 输出，缓存已包含在输入中）\n${tokenLine(parts)}`,
    parts,
    cacheWrite: usage.cache_write_tokens,
    cachePercentText: cachePct(parts.cache, parts.input),
    durationMs,
    durationText: fmtMs(durationMs),
    costUsd: Number(usage.cost_usd || 0),
    costText: fmtCost(Number(usage.cost_usd || 0)),
    contextUsedText: known ? fmtTokens(Number(stats.contextUsage.tokens || 0)) : '待实测',
    contextLimitText: rollover ? fmtTokens(rollover) : '∞',
    contextPercent: percent,
    contextPercentText: percent === null ? '—' : `${percent.toFixed(1)}%`,
  };
}

/** 会话所在目录路径文字（与 Web conversationPathText 一致：“/a/b”；临时会话为“临时会话”）。 */
export function folderPathText(path: string | undefined | null): string {
  const raw = String(path || '').trim();
  if (!raw || raw === '临时会话') return '临时会话';
  return conversationPathText(raw);
}

/** 运行计时：m:ss / h:mm:ss。 */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
