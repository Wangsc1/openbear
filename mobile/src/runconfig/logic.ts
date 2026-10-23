/**
 * 运行配置纯逻辑（无 React，node --test 可测）。
 * - 复用 Web：runConfigState.js（串行保存队列、响应校验）、display.js（模型名、思考档位、格式化）、
 *   ledgerUsage.js / contextUsage.js / conversationWork.js（累计统计、上下文用量环）。
 * - 这里只补 Web 写在 .vue 里的小段逻辑（模型分组/标签/详情，ConsoleComposer.vue modelTags/modelFeatures），
 *   以及 App 编辑器的 RunConfig 形状与服务端字段之间的映射。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore - JS module without types
import * as runConfigState from '@openbear/web/views/consoleView/runConfigState.js';
// @ts-ignore
import * as display from '@openbear/web/views/consoleView/display.js';
// @ts-ignore
import * as ledger from '@openbear/web/views/consoleView/ledgerUsage.js';
// @ts-ignore
import * as contextUsageLib from '@openbear/web/views/consoleView/contextUsage.js';
// @ts-ignore
import * as work from '@openbear/web/views/consoleView/conversationWork.js';

/** 编辑器的值（接口见 RunConfigEditor.tsx 文件头）。contextStrategy 用服务端取值 model_summary / sliding_window。 */
export type RunConfig = {
  model?: string | null;
  thinkLevel?: string | null;
  fastMode?: boolean | null;
  agentModel?: string | null;
  agentThinkLevel?: string | null;
  agentFastMode?: boolean | null;
  contextStrategy?: 'summary' | 'sliding' | string | null;
};

export type ModelInfo = {
  key: string;
  label?: string;
  provider?: string;
  protocol?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  supportsFast?: boolean;
  thinkingLevels?: string[];
  defaultThinkingLevel?: string;
  rolloverTriggerTokens?: number;
  windowTriggerRatio?: number;
  primary?: boolean;
  [key: string]: any;
};

export const SUMMARY = 'model_summary';
export const SLIDING = 'sliding_window';
const DEFAULT_WINDOW_TRIGGER_RATIO = 0.7;

export const createRunConfigSaveQueue: (options?: any) => { enqueue(uuid: string, request: () => Promise<any>): Promise<{ response: any; runConfig: any; applied: boolean }>; appliedVersion: number } =
  runConfigState.createRunConfigSaveQueue;
export const runConfigFromResponse: (response: any, uuid?: string) => any = runConfigState.runConfigFromResponse;
export const fmtTokens: (n: number) => string = display.fmtTokens;
export const fmtCost: (n: number) => string = display.fmtCost;
export const fmtMs: (n: number) => string = display.fmtMs;
export const fmtBytes: (n: number) => string = display.fmtBytes;
export const modelThinkingLevels: (model: any) => string[] = display.modelThinkingLevels;
export const modelDefaultThinking: (model: any) => string = display.modelDefaultThinking;
export const modelLabel: (model: any) => string = display.modelLabel;
export const modelShortLabel: (model: any) => string = display.modelShortLabel;

/** 'summary' / 'sliding'（接口注释里的简写）与服务端取值统一成服务端取值；空表示未设置（继承）。 */
export function normalizeStrategy(value: unknown): '' | typeof SUMMARY | typeof SLIDING {
  const v = String(value ?? '');
  if (v === SUMMARY || v === 'summary') return SUMMARY;
  if (v === SLIDING || v === 'sliding') return SLIDING;
  return '';
}

/** 与 ConsoleComposer.vue compactThinkingLabel 相同。 */
export function thinkLabel(level: string | null | undefined): string {
  const map: Record<string, string> = { off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
  return map[String(level || '')] || String(level || '') || '默认';
}

export function strategyLabel(value: unknown, short = false): string {
  const v = normalizeStrategy(value) || SLIDING;
  if (short) return v === SUMMARY ? '摘要压缩' : '滑窗压缩';
  return v === SUMMARY ? '模型摘要' : '滑动窗口';
}

/** 模型列表按渠道分组 + 搜索（与 ConsoleView.vue modelGroups 相同的匹配字段）。 */
export function groupModels(models: ModelInfo[], query = ''): { provider: string; models: ModelInfo[] }[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models || []) {
    const hay = `${model.key || ''} ${model.label || ''} ${model.provider || ''} ${model.protocol || ''}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const key = model.provider || 'default';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(model);
  }
  return Array.from(groups.entries()).map(([provider, items]) => ({ provider, models: items }));
}

export function rolloverTriggerForModel(model: ModelInfo | null | undefined, ratio?: number): number {
  const explicit = Number(model?.rolloverTriggerTokens || 0);
  if (explicit > 0) return explicit;
  const r = Number(model?.windowTriggerRatio || ratio || DEFAULT_WINDOW_TRIGGER_RATIO);
  return Math.round(Number(model?.contextWindow || 0) * r);
}

export type ModelTag = { id: string; label: string; feature?: 'brain' | 'zap' };

/** ConsoleComposer.vue modelTags。 */
export function modelTags(model: ModelInfo): ModelTag[] {
  const tags: ModelTag[] = [];
  if (model?.contextWindow) tags.push({ id: 'context', label: `${fmtTokens(model.contextWindow)} 上下文` });
  const trigger = rolloverTriggerForModel(model);
  if (trigger > 0) tags.push({ id: 'compression', label: `${fmtTokens(trigger)} 压缩` });
  if (model?.maxTokens) tags.push({ id: 'output', label: `${fmtTokens(model.maxTokens)} 输出` });
  if (model?.reasoning) tags.push({ id: 'reasoning', label: '思考', feature: 'brain' });
  if (model?.supportsFast) tags.push({ id: 'fast', label: 'Fast', feature: 'zap' });
  return tags;
}

/** ConsoleComposer.vue modelFeatures（Web 悬停浮层的内容；App 点“ⓘ”打开）。 */
export function modelFeatures(model: ModelInfo): { id: string; label: string; value: string }[] {
  const features = [{ id: 'protocol', label: '接口协议', value: model.protocol || '未声明' }];
  const trigger = rolloverTriggerForModel(model);
  if (trigger > 0) features.push({ id: 'compression', label: '压缩阈值', value: `${fmtTokens(trigger)} tokens` });
  if (model.contextWindow) features.push({ id: 'context', label: '上下文窗口', value: `${fmtTokens(model.contextWindow)} tokens` });
  if (model.maxTokens) features.push({ id: 'output', label: '输出上限', value: `${fmtTokens(model.maxTokens)} tokens` });
  if (model.reasoning) features.push({ id: 'reasoning', label: '思考能力', value: '支持推理' });
  if (model.supportsFast) features.push({ id: 'fast', label: 'Fast 模式', value: '支持加速' });
  return features;
}

export function findModel(models: ModelInfo[], key: string | null | undefined): ModelInfo | null {
  if (!key) return null;
  return models.find((m) => m.key === key) || null;
}

/** 会话 state（或保存接口返回的 runConfig）-> 编辑器的值。 */
export function runConfigFromState(state: any): RunConfig {
  const agent = state?.agentRunConfig || {};
  return {
    model: String(state?.model || ''),
    thinkLevel: String(state?.thinkingLevel || state?.effectiveThinkingLevel || ''),
    fastMode: Boolean(state?.fastRequested ?? state?.fastMode),
    agentModel: String(agent.model || ''),
    agentThinkLevel: String(agent.thinkLevel || ''),
    agentFastMode: agent.fastMode === true || agent.fastMode === false ? agent.fastMode : null,
    contextStrategy: normalizeStrategy(state?.contextStrategy) || SLIDING,
  };
}

/** 运行配置胶囊（ConsoleComposer.vue runConfigModelText / runConfigThinkingBadge）。 */
export function runConfigChip(state: any, models: ModelInfo[]) {
  const info = findModel(models, state?.model);
  const levels = Array.isArray(state?.thinkingLevels) && state.thinkingLevels.length ? state.thinkingLevels : modelThinkingLevels(info);
  const effective = String(state?.effectiveThinkingLevel || state?.thinkingLevel || 'off');
  return {
    model: info ? modelShortLabel(info) : modelShortLabel({ key: String(state?.model || '').replace(/^.*\//, '') }) || '模型',
    thinking: levels.length && effective && effective !== 'off' ? thinkLabel(effective) : '',
    fast: Boolean(state?.fastMode || state?.effectiveFastMode),
    strategy: normalizeStrategy(state?.contextStrategy) || SLIDING,
  };
}

// ---- 新会话草稿：默认配置（ConsoleView.vue applyLocalRunDefaults / completeLocalRunConfig） ----

export type ConversationDefaults = {
  contextStrategy?: string;
  mainModel?: string;
  mainThinkingLevel?: string;
  mainFastMode?: boolean;
  agentModel?: string;
  agentThinkLevel?: string;
  agentFastMode?: boolean | null;
  revision?: number;
};

export function primaryModel(models: ModelInfo[], preferredKey = ''): ModelInfo | null {
  return models.find((m) => m.key === preferredKey) || models.find((m) => m.primary) || models[0] || null;
}

/** 把目录/全局默认配置落到当前可用的模型上（模型不存在时回退到主模型，档位不支持时用模型默认）。 */
export function resolveDraftRunConfig(defaults: ConversationDefaults, models: ModelInfo[], primaryKey = ''): RunConfig {
  const strategy = defaults.contextStrategy === SUMMARY ? SUMMARY : SLIDING;
  const main = findModel(models, defaults.mainModel) || primaryModel(models, primaryKey);
  if (!main) return { model: '', thinkLevel: '', fastMode: false, agentModel: '', agentThinkLevel: '', agentFastMode: null, contextStrategy: strategy };
  const mainLevels = modelThinkingLevels(main);
  const thinkLevel = mainLevels.includes(String(defaults.mainThinkingLevel || '')) ? String(defaults.mainThinkingLevel) : modelDefaultThinking(main) || 'off';
  const agentInfo = findModel(models, defaults.agentModel);
  const effectiveAgent = agentInfo || main;
  const agentLevels = modelThinkingLevels(effectiveAgent);
  const agentThink = agentLevels.includes(String(defaults.agentThinkLevel || '')) ? String(defaults.agentThinkLevel) : '';
  let agentFast: boolean | null = null;
  if (defaults.agentFastMode === false) agentFast = false;
  else if (defaults.agentFastMode === true && effectiveAgent?.supportsFast) agentFast = true;
  return {
    model: main.key,
    thinkLevel,
    fastMode: defaults.mainFastMode === true && Boolean(main.supportsFast),
    agentModel: agentInfo ? agentInfo.key : '',
    agentThinkLevel: agentThink,
    agentFastMode: agentFast,
    contextStrategy: strategy,
  };
}

/** POST /api/conversations 的 runConfig（completeLocalRunConfig）。 */
export function createPayloadFromRunConfig(cfg: RunConfig) {
  return {
    contextStrategy: normalizeStrategy(cfg.contextStrategy) || SLIDING,
    mainModel: String(cfg.model || ''),
    mainThinkingLevel: String(cfg.thinkLevel || 'off'),
    mainFastMode: Boolean(cfg.fastMode),
    agentModel: String(cfg.agentModel || ''),
    agentThinkLevel: String(cfg.agentThinkLevel || ''),
    agentFastMode: cfg.agentFastMode === true || cfg.agentFastMode === false ? cfg.agentFastMode : null,
  };
}

/** 编辑器的一项修改 -> PATCH /api/conversations/defaults 的字段名。 */
export function defaultsPatchFromRunConfig(patch: Partial<RunConfig>): Partial<ConversationDefaults> {
  const out: Record<string, unknown> = {};
  if (patch.model !== undefined) out.mainModel = patch.model || '';
  if (patch.thinkLevel !== undefined) out.mainThinkingLevel = patch.thinkLevel || '';
  if (patch.fastMode !== undefined) out.mainFastMode = Boolean(patch.fastMode);
  if (patch.agentModel !== undefined) out.agentModel = patch.agentModel || '';
  if (patch.agentThinkLevel !== undefined) out.agentThinkLevel = patch.agentThinkLevel || '';
  if (patch.agentFastMode !== undefined) out.agentFastMode = patch.agentFastMode;
  if (patch.contextStrategy !== undefined) out.contextStrategy = normalizeStrategy(patch.contextStrategy) || SLIDING;
  return out as Partial<ConversationDefaults>;
}

/** 一项修改对应哪个会话接口（每项一次请求，按点击顺序进串行队列）。 */
export function conversationRequestsForPatch(patch: Partial<RunConfig>): { kind: string; args: any[] }[] {
  const out: { kind: string; args: any[] }[] = [];
  if (patch.model !== undefined && patch.model) out.push({ kind: 'conversationSetModel', args: [patch.model] });
  if (patch.thinkLevel !== undefined && patch.thinkLevel) out.push({ kind: 'conversationSetThinking', args: [patch.thinkLevel] });
  if (patch.fastMode !== undefined) out.push({ kind: 'conversationSetFast', args: [Boolean(patch.fastMode)] });
  if (patch.contextStrategy !== undefined) out.push({ kind: 'conversationSetContextStrategy', args: [normalizeStrategy(patch.contextStrategy) || SLIDING] });
  if (patch.agentModel !== undefined) out.push({ kind: 'conversationSetAgentRunConfig', args: [{ model: patch.agentModel || '' }] });
  if (patch.agentThinkLevel !== undefined) out.push({ kind: 'conversationSetAgentRunConfig', args: [{ thinkLevel: patch.agentThinkLevel || '' }] });
  if (patch.agentFastMode !== undefined) out.push({ kind: 'conversationSetAgentRunConfig', args: [{ fastMode: patch.agentFastMode }] });
  return out;
}

/** 成功提示（与 ConsoleView.vue 的文案一致）。 */
export function savedMessage(patch: Partial<RunConfig>, running: boolean, response?: any): string {
  if (patch.model) return response?.nextRun ?? running ? `已保存模型：${patch.model}，下一轮运行生效` : `已切换模型：${patch.model}`;
  if (patch.thinkLevel !== undefined) return running ? '思考强度已保存，下一次调用生效' : `思考强度：${thinkLabel(patch.thinkLevel)}`;
  if (patch.fastMode !== undefined) return running ? 'Fast 模式已保存，下一次调用生效' : patch.fastMode ? 'Fast 模式已开启' : 'Fast 模式已关闭';
  if (patch.contextStrategy !== undefined) return `已切换${strategyLabel(patch.contextStrategy)}${running ? '，下个安全边界生效' : ''}`;
  const agentText =
    patch.agentModel !== undefined ? (patch.agentModel ? `Agent 模型已设为 ${patch.agentModel}` : 'Agent 模型已跟随主模型')
    : patch.agentThinkLevel !== undefined ? (patch.agentThinkLevel ? `Agent 思考已设为 ${patch.agentThinkLevel}` : 'Agent 思考已跟随主会话')
    : patch.agentFastMode !== undefined ? (patch.agentFastMode === null ? 'Agent Fast 已跟随主会话' : `Agent Fast 已${patch.agentFastMode ? '开启' : '关闭'}`)
    : '已保存';
  return running ? `${agentText}，下一次新 Agent 生效` : agentText;
}

// ---- 上下文用量与累计统计（ContextUsageMeter.vue / ConsoleView.vue） ----

export function contextUsageView(meta: any, model: ModelInfo | null) {
  const usage = meta?.usage || {};
  const legacy = Math.max(0, Number(usage.last_input_tokens || 0) + Number(usage.last_cache_read_tokens || 0) + Number(usage.last_cache_write_tokens || 0));
  const server = meta?.contextUsage && typeof meta.contextUsage.known === 'boolean' ? meta.contextUsage : null;
  const resolved = contextUsageLib.resolveContextUsage(server, legacy);
  const window = Number(model?.contextWindow || meta?.contextWindow || 0);
  const explicit = Number(model?.rolloverTriggerTokens || meta?.rolloverTriggerTokens || 0);
  const ratio = Number(model?.windowTriggerRatio || meta?.windowTriggerRatio || DEFAULT_WINDOW_TRIGGER_RATIO);
  const threshold = explicit > 0 ? explicit : window ? Math.round(window * ratio) : 0;
  const meter = work.contextMeter({ ...resolved, window, threshold });
  const known = Boolean(resolved.known);
  return {
    known,
    used: meter.used as number,
    usedLabel: known ? fmtTokens(meter.used) : '待实测',
    windowLabel: meter.capacity ? fmtTokens(meter.capacity) : '未声明',
    thresholdLabel: meter.trigger ? fmtTokens(meter.trigger) : '未设置',
    /** 尚无实测时为 null（不以 0% 代替） */
    percent: meter.triggerPercent as number | null,
    percentLabel: meter.triggerPercent === null ? '—' : `${meter.triggerPercent.toFixed(1)}%`,
    fill: meter.triggerPercent === null ? 0 : Math.min(100, meter.triggerPercent),
    tone: (meter.triggerPercent === null ? 'normal' : meter.tone) as 'normal' | 'warning' | 'danger',
  };
}

export function canCompactNow(meta: any, view: ReturnType<typeof contextUsageView>, running: boolean): { ok: boolean; reason: string } {
  if (normalizeStrategy(meta?.contextStrategy) !== SUMMARY) return { ok: false, reason: '仅“模型摘要”策略可以手动压缩' };
  if (running) return { ok: false, reason: '运行中不能压缩' };
  if (!view.known) return { ok: false, reason: '上下文用量尚无实测值' };
  const min = Number(meta?.manualCompactMinPercent ?? 50);
  if ((view.percent ?? 0) < min) return { ok: false, reason: `用量达到压缩阈值的 ${min}% 后才能手动压缩` };
  return { ok: true, reason: '' };
}

export function usageTotals(meta: any) {
  const base = ledger.normalizeLedgerUsageBaseline(meta?.usage || {});
  const parts = ledger.ledgerTokenParts(base);
  const total = parts.input + parts.output;
  const durationMs = ledger.totalSessionDurationMs({
    turns: [],
    modelCalls: Array.isArray(meta?.modelCalls) ? meta.modelCalls : [],
    timelineTotalDurationMs: meta?.timelineTotalDurationMs,
    ledgerUsage: base,
  });
  return {
    tokens: fmtTokens(total),
    cache: display.cachePct(parts.cache, parts.input) as string,
    cost: fmtCost(Number(base.cost_usd || 0)),
    duration: fmtMs(durationMs),
    detail: display.tokenLine(parts) as string,
  };
}
