/**
 * 把 timelineProjection 的投影结果展平为列表“行”（设计 5.2-2）。
 *
 * 输入：projectOperationMessages() 的结果（复用 web/src，见 webLogic.ts）。
 * 轮次组织沿用 Web 的 ConsoleView.buildTurns + TurnList/ConversationWorkBlock 语义：
 *   - conversationTimelineEntries() 过滤可见事件、把 reasoning/answer 拆成两部分；
 *   - conversationWorkChunks() + lastAnswerIndex() 把一轮分为“工作块”（默认折叠）与“直接展示”块；
 *   - 工作块折叠时只出一行摘要（“已工作 N 分 · K 步”），展开后每个工具/推理一行。
 * 超长正文按 Markdown 顶层块切成多行（splitMarkdownForRows）。
 *
 * 行是不可变的普通对象，带稳定 key 与 type，供 LegendList / FlashList 回收复用。
 */
import { splitMarkdownForRows } from '../chat/markdown/splitBlocks';
import { toolCategory } from '../chat/timeline';
import {
  agentDisplayState,
  buildUserInteractionView,
  conversationTimelineEntries,
  eventDisplayTimeMs,
  userInteractionEventInput,
  conversationWorkChunks,
  eventPrimaryToolName,
  isAgentEvent,
  isUserInteractionEvent,
  lastAnswerIndex,
  reasoningDuration,
  toolDisplayState,
  workDurationLabel,
  type Continuation,
  type ProjectedMessage,
  type TimelineEvent,
} from './webLogic';

export type RowType =
  | 'user'
  | 'answer'
  | 'work_summary'
  | 'tool'
  | 'reasoning'
  | 'agent'
  | 'interaction'
  | 'marker'
  | 'turn_end'
  // b2 新增：模型重试卡片、实时状态行（通知 / Agent 提醒 / 排队插话 / 正在思考）
  | 'retry'
  | 'status';

type RowBase = { key: string; type: RowType; turnKey: string };

export type UserRow = RowBase & {
  type: 'user'; text: string; createdAtMs: number; synthetic: boolean;
  // ---- b2 新增（均为可选，来自投影的 turn.user） ----
  opId?: string;
  turnUuid?: string;
  /** 有落库的 transcript，可“引用本轮 / 从此处重来” */
  deleteTraceable?: boolean;
  /** user / webhook / cron / instance / telegram … */
  source?: string;
  eventCard?: any;
  cronCard?: any;
  cronRunId?: string;
  instanceCard?: any;
  attachments?: any[];
  referenceBundleId?: string;
  references?: any[];
  /** 被唤醒继续的一轮：合成行显示为接续标题 */
  continuation?: Continuation;
};
export type AnswerRow = RowBase & {
  type: 'answer';
  /** 本行 Markdown 片段 */
  markdown: string;
  blockIndex: number;
  blockCount: number;
  /** 片段的块类型（code/table/math/...），仅作提示 */
  blockKind: string;
  live: boolean;
  error: boolean;
  /** 整条回复的 opId，用于“选择全文”页 */
  messageId: string;
  /**
   * 回复尾部（只在本轮最后一个正文块上、且该轮不在运行中时出现）：耗时与 token 取自回合统计（localStats），
   * 口径同 Web tokenPartsFromStats（输入含缓存读写）。无统计时字段为 0，只显示操作按钮。
   */
  footer?: { durationMs: number; inputTokens: number; outputTokens: number; thinkLevel: string; cacheTokens?: number; replyAtMs?: number };
  /** b2：这条回复报告了“本轮执行失败”（payload.error === true） */
  failure?: boolean;
};
export type WorkSummaryRow = RowBase & {
  type: 'work_summary';
  label: string;
  stepCount: number;
  expanded: boolean;
  running: boolean;
  workKey: string;
  /** 按工具类别汇总的步骤数（按数量降序），如 [{读取,9},{终端,6}] */
  counts: Array<{ key: string; label: string; count: number }>;
};
export type ToolRow = RowBase & {
  type: 'tool';
  opId: string;
  title: string;
  preview: string;
  status: 'running' | 'ok' | 'error';
  durationMs: number;
  inWork: boolean;
  /** 仅展示层：连续同类读取步骤合并后的成员（chat/timeline.ts groupReadSteps 设置，数据层不写） */
  group?: ToolRow[];
  /** b2：展示层分组已展开（成员随后逐行出现） */
  groupExpanded?: boolean;
  /** b2：上下文压缩记录（ContextCompaction） */
  compaction?: boolean;
  /** b2：工具名（详情、隐藏等用） */
  toolName?: string;
};
export type ReasoningRow = RowBase & { type: 'reasoning'; opId: string; preview: string; durationLabel: string; active: boolean; inWork: boolean };
export type AgentRow = RowBase & {
  type: 'agent'; opId: string; title: string; status: string; preview: string; inWork: boolean;
  /** 助手卡片用（取自 web agentDisplayState 的首个任务行，纯透传）：任务标题 / 当前动作 / 状态码 / 开始时间 / 耗时 */
  taskTitle: string; current: string; statusKey: string; startedAtMs: number; durationMs: number;
  /** b2：Agent / AgentContinue / AgentMessage / AgentStop；状态文案（web agentStatusMeta）与样式类 */
  toolName?: string; statusLabel?: string; statusCls?: string;
};
export type InteractionRow = RowBase & { type: 'interaction'; opId: string; title: string; status: string; /** b2：web buildUserInteractionView 的只读视图 */ view?: any };
export type RetryRow = RowBase & { type: 'retry'; opId: string; retry: any; inWork: boolean };
export type StatusRow = RowBase & {
  type: 'status'; opId: string; text: string; preview: string; inWork: boolean;
  queued: boolean; interruption: boolean; notification: boolean; agentNotice: boolean; active: boolean; persistent: boolean; modelOutput?: any;
};
export type MarkerRow = RowBase & { type: 'marker'; text: string; tone: 'info' | 'warn' | 'error' };
export type TurnEndRow = RowBase & { type: 'turn_end'; text: string };

export type ChatRow = UserRow | AnswerRow | WorkSummaryRow | ToolRow | ReasoningRow | AgentRow | InteractionRow | MarkerRow | TurnEndRow | RetryRow | StatusRow;

/** b2：隐藏判定用的操作 id（与 web messageVisibility.visibilityOperationId 相同）。 */
export function visibilityOperationId(value: any): string {
  return String(value?.operation?.opId || value?.opId || value?.eventKey || value?.id || '');
}

export type Turn = {
  key: string;
  user: ProjectedMessage | null;
  events: TimelineEvent[];
  localStats: Record<string, any> | null;
};

/** ConsoleView.buildTurns 的最小移植：按 user 消息切轮，assistant 的 localTimeline 并入本轮。 */
export function buildTurns(messages: ProjectedMessage[]): Turn[] {
  const out: Turn[] = [];
  let current: Turn | null = null;
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (current) out.push(current);
      current = { key: String(msg.turnUuid || msg.id || `turn-${out.length}`), user: msg, events: [], localStats: null };
      continue;
    }
    if (!current) current = { key: `orphan-${out.length}`, user: null, events: [], localStats: null };
    if (Array.isArray(msg.localTimeline) && msg.localTimeline.length) {
      // 通常每轮只有一条 assistant 投影：直接复用其 localTimeline 数组（timelineReuse 保证未变化时身份不变），
      // 让 flattenTurn 的记忆化在流式时对旧轮次命中。
      current.events = current.events.length ? [...current.events, ...msg.localTimeline] : msg.localTimeline;
    }
    if (msg.localStats) current.localStats = msg.localStats;
  }
  if (current) out.push(current);
  return out;
}

function eventKey(event: TimelineEvent, part?: string) {
  return `${event.id || event.eventKey || event.operation?.opId || 'event'}:${part || 'event'}`;
}

function eventDurationMs(event: any): number {
  return Number(event?.durationMs || event?.result?.durationMs || event?.operation?.payload?.durationMs || 0) || 0;
}

function turnDurationMs(turn: Turn, entries: Array<{ event: TimelineEvent }>): number {
  return Number(turn.localStats?.durationMs || 0) || eventDurationMs(entries.at(-1)?.event);
}

function firstLine(text: string, limit = 120) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export type FlattenOptions = {
  /** 已展开的工作块 workKey 集合 */
  expandedWork?: ReadonlySet<string>;
  /** 正在运行的根轮次 key（该轮工作块强制展开，与 Web 的 running 行为一致） */
  runningTurnKey?: string;
  /** b2：已隐藏的操作 id（message-visibility）；不传时行为与之前完全相同 */
  hiddenIds?: ReadonlySet<string>;
  /** b2：隐藏集合的版本号（参与单轮记忆化签名） */
  hiddenRevision?: number;
  splitMinChars?: number;
  splitTargetChars?: number;
};

const answerSplitCache = new WeakMap<object, { text: string; blocks: ReturnType<typeof splitMarkdownForRows> }>();

function splitAnswer(event: TimelineEvent, text: string, options: FlattenOptions) {
  const holder = (event.message || event) as object;
  const cached = answerSplitCache.get(holder);
  if (cached && cached.text === text) return cached.blocks;
  const blocks = splitMarkdownForRows(text, { minSplitChars: options.splitMinChars, targetChars: options.splitTargetChars });
  answerSplitCache.set(holder, { text, blocks });
  return blocks;
}

function entryRows(turnKey: string, entry: { event: TimelineEvent; index: number; part?: string }, inWork: boolean, options: FlattenOptions): ChatRow[] {
  const { event, part } = entry;
  const key = `${turnKey}|${eventKey(event, part)}`;
  if (event.kind === 'answer' && part === 'reasoning') {
    const reasoning = String(event.message?.reasoning || '');
    const duration = reasoningDuration(event);
    return [{
      key, type: 'reasoning', turnKey, opId: String(event.operation?.opId || event.id),
      preview: firstLine(reasoning), durationLabel: duration ? workDurationLabel(duration) : '',
      active: Boolean(event.reasoningActive), inWork,
    }];
  }
  if (event.kind === 'answer') {
    const text = String(event.message?.content || '');
    if (!text.trim() && event.message?.error) {
      return [{ key, type: 'marker', turnKey, text: '回复出错', tone: 'error' }];
    }
    const blocks = splitAnswer(event, text, options);
    const failure = Boolean((event as any).failure || (event.message as any)?.failure);
    return blocks.map((block, blockIndex) => ({
      ...(failure ? { failure } : {}),
      key: `${key}#${blockIndex}`,
      type: 'answer' as const,
      turnKey,
      markdown: block.text,
      blockIndex,
      blockCount: blocks.length,
      blockKind: block.kind,
      live: Boolean(event.message?.live),
      error: Boolean(event.message?.error),
      messageId: String(event.operation?.opId || event.id),
    }));
  }
  if (isUserInteractionEvent(event)) {
    let view: any;
    try {
      view = buildUserInteractionView(userInteractionEventInput(event));
    } catch {
      view = undefined;
    }
    return [{ key, type: 'interaction', turnKey, opId: String(event.operation?.opId || event.id), title: String(view?.title || '交互问答'), status: String(event.operation?.status || ''), view }];
  }
  if (event.kind === 'model_retry') {
    return [{ key, type: 'retry', turnKey, opId: String(event.operation?.opId || event.id), retry: (event as any).retry || {}, inWork }];
  }
  if (event.kind === 'live_status') {
    const e = event as any;
    return [{
      key, type: 'status', turnKey, opId: String(e.id || ''), text: String(e.status || ''), preview: String(e.preview || ''), inWork,
      queued: Boolean(e.queued), interruption: Boolean(e.interruption), notification: Boolean(e.notification), agentNotice: Boolean(e.agentNotice),
      active: e.active !== false && !e.queued, persistent: Boolean(e.persistentRunIndicator), modelOutput: e.modelOutput || undefined,
    }];
  }
  if (event.kind === 'tool' && isAgentEvent(event)) {
    // agentDisplayState 返回 {summary, rows}：卡片取 summary 的状态文案与首个任务行（任务标题/当前动作/耗时）。
    const state = agentDisplayState(event) || {};
    const summary = state.summary || {};
    const first = (Array.isArray(state.rows) && state.rows[0]) || {};
    const task = first.task || {};
    return [{
      key, type: 'agent', turnKey, opId: String(event.operation?.opId || event.id),
      title: String(first.name || summary.countText || eventPrimaryToolName(event) || 'Agent'),
      status: String(summary.label || event.operation?.status || ''),
      preview: firstLine(String(summary.preview || event.livePreview || '')),
      inWork,
      taskTitle: firstLine(String(first.title || summary.preview || ''), 80),
      current: firstLine(String(first.current || ''), 120),
      statusKey: String(first.status || event.operation?.status || ''),
      startedAtMs: Number(task.startedAtMs || event.operation?.createdAtMs || 0) || 0,
      durationMs: Number(first.metrics?.duration || 0) || 0,
      toolName: String(summary.toolName || eventPrimaryToolName(event) || 'Agent'),
      statusLabel: String(summary.label || ''),
      statusCls: String(summary.cls || ''),
    }];
  }
  if (event.kind === 'tool' || event.kind === 'live_tool' || event.kind === 'tool_group') {
    const state = toolDisplayState(event) || {};
    return [{
      key, type: 'tool', turnKey, opId: String(event.operation?.opId || event.id),
      title: String(state.title || event.toolName || 'Tool'), preview: firstLine(String(state.preview || ''), 140),
      status: (state.status || 'running') as ToolRow['status'], durationMs: eventDurationMs(event), inWork,
      toolName: String(event.toolName || eventPrimaryToolName(event) || ''),
      ...(event.toolName === 'ContextCompaction' || event.operation?.opType === 'context_compaction' ? { compaction: true } : {}),
    }];
  }
  return [{ key, type: 'marker', turnKey, text: String(event.kind || '事件'), tone: 'info' }];
}

const turnRowsCache = new WeakMap<TimelineEvent[], { sig: string; rows: ChatRow[]; user: unknown; turnKey: string }>();

/** 单轮展平（按事件数组身份 + 展开状态记忆化；流式时只有当前轮会重算）。 */
export function flattenTurn(turn: Turn, options: FlattenOptions = {}): ChatRow[] {
  const running = options.runningTurnKey === turn.key;
  const workKey = `${turn.key}|work`;
  const expanded = options.expandedWork?.has(workKey) ?? false;
  const hidden = options.hiddenIds && options.hiddenIds.size ? options.hiddenIds : null;
  const sig = `${running}|${expanded}|${hidden ? options.hiddenRevision ?? hidden.size : ''}`;
  const cached = turnRowsCache.get(turn.events);
  if (cached && cached.sig === sig && cached.user === turn.user && cached.turnKey === turn.key) {
    return cached.rows;
  }
  const rows: ChatRow[] = [];
  const events = hidden ? turn.events.filter((event) => !hidden.has(visibilityOperationId(event))) : turn.events;
  if (turn.user && !(hidden && hidden.has(visibilityOperationId(turn.user)))) {
    const u = turn.user as any;
    rows.push({
      key: `${turn.key}|user`, type: 'user', turnKey: turn.key,
      text: String(turn.user.content || ''), createdAtMs: Number(turn.user.createdAt || 0) * 1000,
      synthetic: Boolean(turn.user.syntheticPlaceholder),
      opId: String(u.opId || u.id || ''), turnUuid: String(u.turnUuid || ''), deleteTraceable: Boolean(u.deleteTraceable),
      source: String(u.source || 'user'), eventCard: u.eventCard || undefined, cronCard: u.cronCard || undefined, cronRunId: u.cronRunId || '',
      instanceCard: u.instanceCard || undefined,
      attachments: Array.isArray(u.attachments) && u.attachments.length ? u.attachments : undefined,
      referenceBundleId: u.referenceBundleId || '', references: Array.isArray(u.references) ? u.references : undefined,
      ...(u.continuation ? { continuation: u.continuation } : {}),
    });
  }
  const entries = conversationTimelineEntries(events, eventPrimaryToolName, isAgentEvent);
  const resultIndex = lastAnswerIndex(events);
  const chunks = conversationWorkChunks(entries, resultIndex);
  const workStepCount = chunks.filter((c) => c.kind === 'work').reduce((n, c) => n + c.entries.length, 0);
  const counts = workCounts(chunks);
  // Web：未运行且有最终回复时，工作块默认折叠；没有最终回复（resultIndex<0）时默认展开。
  const open = running || expanded || resultIndex < 0;
  let summaryEmitted = false;
  for (const chunk of chunks) {
    if (chunk.kind === 'work') {
      if (!summaryEmitted && !running) {
        const duration = workDurationLabel(turnDurationMs(turn, entries));
        rows.push({
          key: `${turn.key}|work-summary`, type: 'work_summary', turnKey: turn.key,
          label: `已工作${duration ? ` ${duration}` : ''}`, stepCount: workStepCount,
          expanded: open, running, workKey, counts,
        });
        summaryEmitted = true;
      }
      if (!open) continue;
      for (const entry of chunk.entries) rows.push(...entryRows(turn.key, entry, true, options));
    } else {
      for (const entry of chunk.entries) rows.push(...entryRows(turn.key, entry, false, options));
    }
  }
  // 回复尾部：挂在本轮最后一个正文块上（不新增行，不改变行 key；运行中的轮次不显示）。
  if (!running) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.type !== 'answer') continue;
      if (row.blockIndex === row.blockCount - 1 && !row.live) rows[i] = { ...row, footer: turnFooter(turn, entries) };
      break;
    }
  }
  turnRowsCache.set(turn.events, { sig, rows, user: turn.user, turnKey: turn.key });
  return rows;
}

/** 工作块内按工具类别计数（读取 9 · 终端 6 · 搜索 2），按数量降序；思考与中间正文不计。 */
function workCounts(chunks: Array<{ kind: string; entries: Array<{ event: TimelineEvent; part?: string }> }>): WorkSummaryRow['counts'] {
  const map = new Map<string, { key: string; label: string; count: number }>();
  for (const chunk of chunks) {
    if (chunk.kind !== 'work') continue;
    for (const { event, part } of chunk.entries) {
      if (event.kind === 'answer' || part === 'reasoning' || isUserInteractionEvent(event)) continue;
      if (event.kind !== 'tool' && event.kind !== 'live_tool' && event.kind !== 'tool_group') continue;
      const category = isAgentEvent(event) ? toolCategory('Agent') : toolCategory(eventPrimaryToolName(event));
      const item = map.get(category.key);
      if (item) item.count += 1;
      else map.set(category.key, { ...category, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** 本轮用量（口径同 Web tokenPartsFromStats：输入 = 输入 + 缓存读写，含专家用量）。 */
function turnFooter(turn: Turn, entries: Array<{ event: TimelineEvent }>): NonNullable<AnswerRow['footer']> {
  const stats = turn.localStats || {};
  const u = stats.usage || {};
  const eu = stats.expertUsage || {};
  const inputTokens = Number(u.inputTokens || 0) + Number(u.cacheReadTokens || 0) + Number(u.cacheWriteTokens || 0)
    + Number(eu.inputTokens || 0) + Number(eu.cacheReadTokens || 0) + Number(eu.cacheWriteTokens || 0);
  const outputTokens = Number(u.outputTokens || 0) + Number(eu.outputTokens || 0);
  const cacheTokens = Number(u.cacheReadTokens || 0) + Number(eu.cacheReadTokens || 0);
  let replyAtMs = 0;
  for (let i = entries.length - 1; i >= 0 && !replyAtMs; i -= 1) replyAtMs = Number(eventDisplayTimeMs(entries[i].event) || 0);
  return { durationMs: turnDurationMs(turn, entries), inputTokens, outputTokens, thinkLevel: String(stats.thinkLevel || ''), cacheTokens, replyAtMs };
}

export function flattenTurns(turns: Turn[], options: FlattenOptions = {}): ChatRow[] {
  const out: ChatRow[] = [];
  for (const turn of turns) {
    const rows = flattenTurn(turn, options);
    for (const row of rows) out.push(row);
  }
  return out;
}

/** 行类型 -> 回收池类型（answer 再按块种类细分，避免代码块与段落互相回收导致高度跳变）。 */
export function rowRecycleType(row: ChatRow): string {
  if (row.type === 'answer') return row.blockKind === 'code' || row.blockKind === 'table' || row.blockKind === 'math' ? `answer-${row.blockKind}` : 'answer';
  return row.type;
}
