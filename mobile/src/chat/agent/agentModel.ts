/**
 * Agent 详情的纯逻辑（无 React）：从投影后的 Agent 事件推导卡片/详情所需的状态。
 * 规则与 Web AgentEventCard.vue / AgentActivityList.vue 中的 computed 一一对应；展示数据全部来自复用的
 * web display.js / agentPlanPresentation.js / agentInstancePresentation.js。
 */
import {
  agentDisplayState,
  agentInstance$,
  agentPlan$,
  agentRowArgumentsDisplay,
  agentRowMetricChips,
  agentRowOutputSection,
  agentStatusMeta,
  agentTasks,
  recentEventMessage,
  toolArgumentsSummary,
  toolDisplayLabel,
  toolPreview,
} from '../../data/webLogic';

const ACTIVE = new Set(['running', 'resuming', 'queued', 'pausing', 'stopping']);

export type AgentTabId = 'plan' | 'instance' | 'activity' | 'monitor' | 'launch' | 'output';

export function agentState(event: any) {
  const state = agentDisplayState(event) || { summary: {}, rows: [], metricChips: [], recentLines: [] };
  const summary = state.summary || {};
  const rows = (state.rows || []).map((row: any) => ({ ...row, statusMeta: agentStatusMeta(row.status, summary.toolName), metricChips: agentRowMetricChips(row) }));
  return { ...state, rows, subtitle: String(summary.preview || toolPreview(event) || summary.countText || '') };
}

export function taskUuidOf(event: any, state = agentState(event)): string {
  const row = state.rows.find((item: any) => item?.taskUuid || item?.task_uuid || item?.task?.taskUuid || item?.task?.task_uuid);
  return String(
    row?.taskUuid || row?.task_uuid || row?.task?.taskUuid || row?.task?.task_uuid
      || event?.taskUuid || event?.task_uuid || event?.result?.taskUuid || event?.result?.task_uuid || '',
  ).trim();
}

export function immediateTask(event: any, state = agentState(event)): any {
  const row = state.rows.find((item: any) => item?.task && typeof item.task === 'object') || state.rows[0];
  if (row?.task) return row.task;
  return agentTasks(event)[0] || row || {};
}

export function immediateSession(event: any, state = agentState(event)): any {
  const row = state.rows.find((item: any) => item?.agentSession && typeof item.agentSession === 'object');
  if (row?.agentSession) return row.agentSession;
  const payload = event?.livePayload || {};
  return payload.agentSession || payload.result?.agentSession || {};
}

/** 当前 Agent 等待重试（Agent 自己的模型调用失败）：{attempt, maxRetries, waitId, taskUuid}。 */
export function activeAgentRetry(event: any, state = agentState(event)): any {
  const retry = immediateTask(event, state)?.output?.retry;
  const taskUuid = taskUuidOf(event, state);
  return retry?.active && retry?.waitId && taskUuid ? { ...retry, taskUuid } : null;
}

export function planCapability(event: any, taskUuid: string): boolean {
  const tasks = agentTasks(event);
  const task = tasks.find((item: any) => String(item?.taskUuid || item?.task_uuid || '').trim() === taskUuid) || (tasks.length === 1 ? tasks[0] : null);
  const mode = String(task?.planMode || task?.plan_mode || task?.input?.planMode || task?.input?.plan_mode || '').trim().toLowerCase();
  return mode !== 'direct';
}

export function primaryRow(state: ReturnType<typeof agentState>) {
  const outputAvailable = (row: any) => Boolean(row?.hasOutput && !ACTIVE.has(String(row?.status || '')));
  const index = state.rows.findIndex((row: any) => row?.hasArguments || outputAvailable(row));
  return { index, row: index >= 0 ? state.rows[index] : null };
}

export function outputSection(state: ReturnType<typeof agentState>) {
  const { row } = primaryRow(state);
  return row ? agentRowOutputSection(row) : null;
}

export function fallbackArguments(event: any, state: ReturnType<typeof agentState>): string {
  const { index, row } = primaryRow(state);
  return row ? agentRowArgumentsDisplay(event, row, index, { full: true }) : '';
}

export function isActiveAgent(event: any, state: ReturnType<typeof agentState>): boolean {
  return agentPlan$.isActiveAgentEvent(event, state);
}

/** 详情头部：标题、副标题、状态文案、样式类（running/ok/error/pending/stopped/partial）。 */
export function panelHead(event: any, state = agentState(event), instanceStatusLabel = '') {
  const active = isActiveAgent(event, state);
  const statusLabel = active ? '本轮执行中' : instanceStatusLabel || String(state.summary.label || '');
  return {
    title: active ? 'Agent 运行中' : String(state.summary.title || 'Agent'),
    subtitle: state.subtitle || '后台 Agent 任务',
    statusLabel,
    cls: active ? 'running' : String(state.summary.cls || ''),
    active,
  };
}

function activityTimeLabel(value: unknown): string {
  const n = Number(value || 0);
  if (!n) return '—';
  const d = new Date(n * (n < 10_000_000_000 ? 1000 : 1));
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** /agents/{tid}/events 的事件 -> 过程记录行（与 Web activityEventLine 相同）。 */
export function activityEventLine(taskUuid: string, item: any, index = 0) {
  const source = { ...(item && typeof item === 'object' ? item : {}), taskUuid, detail: item?.detail && typeof item.detail === 'object' ? item.detail : {} };
  const kind = String(source.kind || 'event');
  return {
    key: `${taskUuid}|${source.seq || index}|${kind}`,
    seq: Number(source.seq || 0),
    ts: Number(source.ts || 0),
    kind,
    summary: String(source.summary || ''),
    detail: source.detail,
    toolName: String(source.detail.name || source.name || 'Tool'),
    rawArguments: source.detail.arguments ?? source.arguments ?? '',
    timeLabel: activityTimeLabel(source.ts),
    message: recentEventMessage(source) || String(source.summary || source.kind || 'Agent 动态'),
  };
}

/** 过程记录展示行（Web activityDisplayLines：去掉不展示的种类，上下文压缩与工具开始行补充说明）。 */
export function activityDisplayLines(lines: any[]): any[] {
  return lines
    .filter((item) => !agentPlan$.isActivityExcludedEventKind(item.kind))
    .map((item) => {
      const compaction = agentPlan$.agentCompactionActivityView(item);
      if (compaction?.isCompaction) {
        return { ...item, kind: 'context_compaction_compact', compaction, compactedOutput: compaction.output, emptyOutputText: compaction.emptyOutputText, message: compaction.message, tone: compaction.failed ? 'danger' : 'success' };
      }
      if (item.kind !== 'tool_call_started') return item;
      const toolName = String(item.toolName || item.detail?.name || 'Tool');
      const rawArguments = item.rawArguments ?? item.detail?.arguments ?? '';
      const summary = toolArgumentsSummary(toolName, rawArguments);
      return { ...item, toolName, rawArguments, toolDescription: String(item.toolDescription || item.description || item.detail?.description || summary), message: `调用工具 ${toolName}${summary ? ` · ${summary}` : ''}` };
    });
}

/** 监控事件（Web monitorDisplayLines）：已加载事件 + 推送的 recentEvents 中的监控种类，按时间排序去重。 */
export function monitorDisplayLines(base: any[], event: any, state: ReturnType<typeof agentState>, taskUuid: string): any[] {
  const candidates = [event?.livePayload?.recentEvents, event?.result?.recentEvents, ...state.rows.flatMap((row: any) => [row?.recentEvents, row?.task?.recentEvents, row?.payload?.recentEvents])];
  const byKey = new Map<string, any>();
  for (const item of base) if (agentPlan$.isAgentMonitorEventKind(item.kind)) byKey.set(item.key, item);
  for (const events of candidates) {
    if (!Array.isArray(events)) continue;
    for (const item of events) {
      if (!agentPlan$.isAgentMonitorEventKind(item?.kind || item?.type)) continue;
      const line = activityEventLine(taskUuid, item);
      byKey.set(line.key, line);
    }
  }
  const ms = (v: any) => Number(v || 0) * (Number(v || 0) < 10_000_000_000 ? 1000 : 1);
  return [...byKey.values()].sort((a, b) => ms(a.ts) - ms(b.ts) || Number(a.seq || 0) - Number(b.seq || 0));
}

const TOOL_STATUS: Record<string, string> = { running: '执行中', success: '执行完成 √', failed: '执行失败 ×', denied: '已拒绝 ×' };
const MODEL_STATUS: Record<string, string> = { running: '调用中', success: '执行完成 √', failed: '调用失败 ×', ended: '调用已结束' };
const STATUS_TONE: Record<string, string> = { running: 'active', success: 'success', failed: 'danger', denied: 'danger', ended: 'muted' };

function declaredStatus(line: any, allowed: Record<string, string>): string {
  const declared = String(line.processStatus || line.modelStatus || '').trim().toLowerCase();
  if (allowed[declared]) return declared;
  if (line.kind === 'tool_call_denied') return 'denied';
  if (line.kind === 'tool_call_failed' || line.tone === 'danger') return 'failed';
  if (line.tone === 'success' || line.kind === 'tool_call_finished') return 'success';
  return 'running';
}

function recordedText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** AgentActivityList.presentedLines 的移植：模型调用行 / 工具调用行 / 普通消息行。 */
export function presentActivityLines(lines: any[]): any[] {
  return lines.map((line) => {
    const detail = line?.detail && typeof line.detail === 'object' ? line.detail : {};
    if (line.processType === 'model' || line.kind === 'model_call_compact') {
      const status = declaredStatus(line, MODEL_STATUS);
      return {
        ...line,
        processModel: {
          label: String(line.modelLabel || detail.modelLabel || detail.model || '模型'),
          thinkLevel: String(line.modelThinkLevel || detail.thinkLevel || detail.think_level || '').trim(),
          fastMode: Boolean(line.modelFastMode),
          description: String(line.modelDescription || '').trim(),
          status: String(line.modelStatusText || MODEL_STATUS[status]),
          statusTone: STATUS_TONE[status],
          failure: recordedText(detail.error ?? detail.reason),
        },
      };
    }
    const isTool = line.kind !== 'context_compaction_compact'
      && (line.processStatus || ['tool_call_started', 'tool_call_finished', 'tool_call_failed', 'tool_call_denied', 'tool_call_compact'].includes(line.kind));
    if (!isTool) return line;
    const name = String(line.toolName || detail.name || 'Tool');
    const rawArguments = line.rawArguments ?? detail.arguments ?? '';
    const status = declaredStatus(line, TOOL_STATUS);
    return {
      ...line,
      processTool: {
        name,
        label: toolDisplayLabel(name),
        rawArguments,
        description: toolArgumentsSummary(name, rawArguments) || String(line.toolDescription || line.description || '').trim(),
        result: recordedText(detail.resultText ?? detail.result ?? detail.resultPreview ?? detail.result_preview),
        resultIsPreview: detail.resultText == null && detail.result == null,
        fullDescription: String(line.description || detail.description || line.toolDescription || ''),
        failure: recordedText(detail.error ?? detail.reason),
        status: TOOL_STATUS[status],
        statusTone: STATUS_TONE[status],
      },
    };
  });
}

/** Streaming progress of the task's running model call (pushed with the task only), as the event line it used to be. */
export function liveProgressLine(event: any, state = agentState(event)): any {
  const live = agentPlan$.liveProgressEvent(immediateTask(event, state)?.liveProgress);
  return live ? { ...activityEventLine(taskUuidOf(event, state), live), attemptId: live.attemptId } : null;
}

export function compactActivity(lines: any[], options: { modelLabel?: string; thinkLevel?: string; fastMode?: boolean; nowMs?: number; limit?: number; liveProgressLine?: any }) {
  const out = agentPlan$.compactAgentStepActivityLines(lines, { modelLabel: options.modelLabel || '', thinkLevel: options.thinkLevel || '', fastMode: Boolean(options.fastMode), nowMs: options.nowMs ?? Date.now(), liveProgressLine: options.liveProgressLine || null });
  return options.limit && options.limit > 0 ? out.slice(-options.limit) : out;
}

/** 计划“完成检查”点按时跳到的步骤（Web selectRelevantStep）。 */
export function relevantStepId(view: any, check: any): string {
  if (!check || check.done) return '';
  const target = (view?.steps || []).find((step: any) => {
    if (check.key === 'steps') return step.required && step.status !== 'completed';
    if (check.key === 'criteria') return step.criteria.some((c: any) => c.required && !c.satisfied);
    if (check.key === 'evidence') return step.criteria.some((c: any) => c.required && !c.evidence.length);
    return false;
  });
  return target ? String(target.id) : '';
}

export function pushedEventsAffectWorkspace(events: any[]): boolean {
  return (Array.isArray(events) ? events : []).some((item) => {
    const kind = String(item?.kind || item?.type || '');
    return kind.startsWith('plan_') || ['task_completed', 'task_failed', 'task_cancelled', 'task_interrupted', 'needs_openbear_control'].includes(kind);
  });
}

export function workspaceRefreshKey(event: any, state: ReturnType<typeof agentState>, taskUuid: string): string {
  const row = state.rows.find((item: any) => String(item?.taskUuid || '') === taskUuid) || state.rows[0] || {};
  const runtime = event?.livePayload?.planRuntime || event?.livePayload?.plan_runtime || {};
  return [taskUuid, row.status, runtime.phase, runtime.activePlanVersion, runtime.pendingPlanVersion, runtime.currentStepId, runtime.rowRevision, runtime.latestEventSeq].join('|');
}

export const instanceLogic = agentInstance$;
export const planLogic = agentPlan$;

/** 语义色调 -> 主题色键。 */
export function toneKey(tone: string): 'blue' | 'success' | 'danger' | 'warning' | 'muted' {
  const t = String(tone || '').toLowerCase();
  if (['active', 'running', 'info', 'blue', 'current'].includes(t)) return 'blue';
  if (['success', 'ok', 'done', 'completed'].includes(t)) return 'success';
  if (['danger', 'error', 'failed'].includes(t)) return 'danger';
  if (['warning', 'pending', 'waiting', 'blocked', 'partial'].includes(t)) return 'warning';
  return 'muted';
}
