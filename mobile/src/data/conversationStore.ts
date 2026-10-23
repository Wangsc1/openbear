/**
 * 对话数据层：分页窗口 + 帧应用 + 节流投影（设计 5.2-1/3/4）。
 *
 * 与 Web ConsoleView 的语义保持一致：
 *  - 首屏 GET /state?timelineLimit=200；向上翻页 GET /operations?timelineLimit=N&beforeDisplaySeq=S，
 *    用 mergeOperationSnapshots() 合并（复用 web timelinePagination.js）；
 *  - 实时帧走 applyOperationFrame()/shouldApplyOperationFrame()（复用 web timelineProjection.js），
 *    revision 缺口时按 afterFrameSeq 用 /frames 补帧，补不上再整体 /state 重同步；
 *  - 投影 projectOperationMessages() + createTimelineReuse()（复用），再展平为行（rows.ts）。
 *
 * 流式：帧先进缓冲，按 throttleMs（默认 80ms）批量提交，一次提交只做一次投影。
 * 不依赖 React，便于 node --test 直接测试；UI 通过 subscribe() 订阅快照。
 */
import { buildTurns, flattenTurns, type ChatRow, type Turn } from './rows';
import {
  applyLiveOperationUpdate,
  applyOperationFrame,
  createTimelineReuse,
  deriveOperationRunState,
  findActiveTurnIndex,
  mergeOperationSnapshots,
  preferNewerLiveOperations,
  projectOperationMessages,
  projectionOptions,
  shouldApplyOperationFrame,
  type Frame,
  type Operation,
  type ProjectedMessage,
} from './webLogic';

export type ConversationApi = {
  state(uuid: string, params: { timelineLimit: number; beforeDisplaySeq?: number }): Promise<any>;
  operations(uuid: string, params: { timelineLimit: number; beforeDisplaySeq: number }): Promise<any>;
  frames(uuid: string, afterFrameSeq: number, limit?: number): Promise<any>;
  operationDetail(uuid: string, opId: string): Promise<any>;
};

export type ConversationSocket = {
  send(payload: Record<string, unknown>): boolean;
  close(): void;
};

export type SocketFactory = (uuid: string, afterFrameSeq: number, handlers: {
  onMessage(message: any): void;
  onOpen(): void;
  onClose(code: number, reason: string): void;
}) => ConversationSocket;

export type ConversationSnapshot = {
  version: number;
  uuid: string;
  title: string;
  /** 会话当前模型（state 接口的 conversation.model，如 OpenAI/gpt-5.6-sol），导航栏副标题用 */
  model: string;
  loading: boolean;
  error: string;
  rows: ChatRow[];
  turnCount: number;
  operationCount: number;
  hasMoreBefore: boolean;
  loadingEarlier: boolean;
  running: boolean;
  statusLabel: string;
  socketState: 'idle' | 'connecting' | 'open' | 'closed';
  lastFrameSeq: number;
  /** 最近一次投影+展平耗时（ms），性能观测用 */
  lastProjectionMs: number;
  /** 最近一次 prepend（向上翻页）新增的行数，供列表保持可见位置 */
  prependedRows: number;
  /** 会话 state 的非时间线字段（运行配置、上下文用量、累计统计、待处理插话…），输入区（B3）用；未载入时为 undefined */
  meta?: Record<string, any>;
  /** 待回答的交互（确认/选择/输入/问卷），来自 state / bootstrap / web_confirmation */
  pendingConfirmations: any[];
  /** 排队中的插话（pending_steering） */
  pendingSteering: any[];
  /** 消息隐藏状态（message-visibility）：revision、hiddenIds、items（隐藏内容抽屉） */
  visibility: { revision: number; hiddenIds: string[]; items: any[] };
  /** 搜索定位窗口已并入（正在阅读历史定位内容） */
  seekActive: boolean;
};

/**
 * 输入区（B3）挂载时注册到 store.composer、卸载时移除；b2 的“引用本轮问答”等按这个形状调用。
 * setDraftText 在 onlyIfEmpty 且已有内容时返回 false 不覆盖。
 */
export type ComposerBridge = {
  insertReference(ref: { kind: 'turn' | 'message'; conversationUuid: string; turnUuid?: string; opId?: string; title?: string }): void;
  setDraftText(text: string, opts?: { onlyIfEmpty?: boolean }): boolean;
};

/** state 接口去掉时间线（operations/messages）后的部分。 */
export function stateWithoutTimeline(state: any): Record<string, any> {
  if (!state || typeof state !== 'object') return {};
  const { operations: _ops, messages: _messages, ...rest } = state;
  return rest;
}

export type StoreOptions = {
  initialLimit?: number;
  pageLimit?: number;
  throttleMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type Listener = (snapshot: ConversationSnapshot) => void;

/**
 * 原始数据旁路（会话面板 B4 用）：/state 的整份返回（含 usage、contextUsage、timelineTotalDurationMs 等统计字段，
 * operations 除外）与每一帧（连同应用后的 operation）。只读通知，不影响投影。
 */
export type RawEvent = { type: 'state'; state: Record<string, any> } | { type: 'frame'; frame: Frame; operation: Operation | undefined };
type RawListener = (event: RawEvent) => void;

export class ConversationStore {
  readonly uuid: string;
  private api: ConversationApi;
  private socketFactory: SocketFactory | null;
  private options: Required<StoreOptions>;
  private frameStore: { operationsById: Map<string, Operation>; revisionByOpId: Map<string, number>; orderedOpIds: string[]; lastFrameSeq: number; needsResync?: boolean; revisionGap?: any } = {
    operationsById: new Map(), revisionByOpId: new Map(), orderedOpIds: [], lastFrameSeq: 0,
  };
  private listeners = new Set<Listener>();
  private reuse = createTimelineReuse();
  private pendingFrames: Frame[] = [];
  private lastLiveResyncAt = -Infinity;
  private flushHandle: unknown = null;
  private socket: ConversationSocket | null = null;
  private disposed = false;
  private expandedWork = new Set<string>();
  private messages: ProjectedMessage[] = [];
  private turns: Turn[] = [];
  private nextBeforeDisplaySeq: number | null = null;
  private resyncing = false;
  private messageListeners = new Set<(message: any) => void>();
  /** 输入区挂载时注册（见 ComposerBridge） */
  composer?: ComposerBridge;
  private rawListeners = new Set<RawListener>();
  /** 最近一次 /state 返回（不含 operations），会话面板读取累计统计用；未加载时为 null。 */
  stateMeta: Record<string, any> | null = null;
  // b2：隐藏集合、搜索定位窗口
  private hiddenIds = new Set<string>();
  private seekBaseIds: Set<string> | null = null;
  private seekSaved: { nextBeforeDisplaySeq: number | null; hasMoreBefore: boolean } | null = null;
  snapshot: ConversationSnapshot;

  constructor(uuid: string, api: ConversationApi, socketFactory: SocketFactory | null, options: StoreOptions = {}) {
    this.uuid = uuid;
    this.api = api;
    this.socketFactory = socketFactory;
    this.options = {
      initialLimit: options.initialLimit ?? 200,
      pageLimit: options.pageLimit ?? 200,
      throttleMs: options.throttleMs ?? 80,
      now: options.now ?? (() => (globalThis.performance?.now ? globalThis.performance.now() : Date.now())),
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
    this.snapshot = {
      version: 0, uuid, title: '', model: '', loading: true, error: '', rows: [], turnCount: 0, operationCount: 0,
      hasMoreBefore: false, loadingEarlier: false, running: false, statusLabel: '', socketState: 'idle',
      lastFrameSeq: 0, lastProjectionMs: 0, prependedRows: 0,
      pendingConfirmations: [], pendingSteering: [], visibility: { revision: -1, hiddenIds: [], items: [] }, seekActive: false,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 订阅原始 state / 帧（见 RawEvent）。返回取消函数。 */
  onRaw(listener: RawListener): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  private emitRaw(event: RawEvent) {
    for (const listener of this.rawListeners) {
      try {
        listener(event);
      } catch {
        /* 旁路监听出错不影响对话数据 */
      }
    }
  }

  private rememberState(state: any) {
    if (!state || typeof state !== 'object') return;
    const { operations: _ops, messages: _messages, ...meta } = state;
    this.stateMeta = meta;
    this.emitRaw({ type: 'state', state: meta });
  }

  private emit(patch: Partial<ConversationSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch, version: this.snapshot.version + 1 };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private orderedOperations(): Operation[] {
    const { operationsById, orderedOpIds } = this.frameStore;
    const out: Operation[] = [];
    for (const id of orderedOpIds) {
      const op = operationsById.get(id);
      if (op) out.push(op);
    }
    return out;
  }

  private replaceOperations(operations: Operation[]) {
    const byId = new Map<string, Operation>();
    const revisions = new Map<string, number>();
    const ids: string[] = [];
    for (const op of operations) {
      if (!op?.opId) continue;
      if (!byId.has(op.opId)) ids.push(op.opId);
      byId.set(op.opId, op);
      revisions.set(op.opId, Number(op.revision || 0));
    }
    this.frameStore.operationsById = byId;
    this.frameStore.revisionByOpId = revisions;
    this.frameStore.orderedOpIds = ids;
  }

  /** 投影 + 展平；返回耗时。 */
  private reproject(extra: Partial<ConversationSnapshot> = {}) {
    const t0 = this.options.now();
    const ops = this.orderedOperations();
    this.messages = this.reuse(projectOperationMessages(ops, projectionOptions));
    this.turns = buildTurns(this.messages);
    const runState = deriveOperationRunState(ops);
    const activeIndex = runState.rootTurnRunning ? findActiveTurnIndex(this.turns, runState) : -1;
    const runningTurnKey = activeIndex >= 0 ? this.turns[activeIndex].key : '';
    const rows = flattenTurns(this.turns, {
      expandedWork: this.expandedWork, runningTurnKey,
      ...(this.hiddenIds.size ? { hiddenIds: this.hiddenIds, hiddenRevision: this.snapshot.visibility.revision } : {}),
    });
    const elapsed = this.options.now() - t0;
    this.emit({
      rows,
      turnCount: this.turns.length,
      operationCount: ops.length,
      running: Boolean(runState.running),
      statusLabel: String(runState.statusLabel || ''),
      lastFrameSeq: this.frameStore.lastFrameSeq,
      lastProjectionMs: Math.round(elapsed * 10) / 10,
      ...extra,
    });
  }

  async open(): Promise<void> {
    this.emit({ loading: true, error: '' });
    try {
      const state = await this.api.state(this.uuid, { timelineLimit: this.options.initialLimit });
      if (this.disposed) return;
      this.rememberState(state);
      this.replaceOperations(Array.isArray(state.operations) ? state.operations : []);
      this.frameStore.lastFrameSeq = Number(state.frameSeq || 0);
      this.nextBeforeDisplaySeq = state.hasMoreBefore ? Number(state.nextBeforeDisplaySeq) : null;
      this.acceptStateExtras(state);
      this.reproject({
        loading: false,
        title: String(state.conversation?.title || ''),
        model: String(state.conversation?.model || state.model || ''),
        hasMoreBefore: Boolean(state.hasMoreBefore),
        prependedRows: 0,
        meta: stateWithoutTimeline(state),
      });
      this.connect();
    } catch (error: any) {
      if (!this.disposed) this.emit({ loading: false, error: String(error?.message || error) });
    }
  }

  /** 向上翻页：合并更早一页，返回新增行数（prependedRows）。 */
  async loadEarlier(): Promise<number> {
    if (this.snapshot.loadingEarlier || !this.nextBeforeDisplaySeq || this.disposed) return 0;
    const before = this.nextBeforeDisplaySeq;
    this.emit({ loadingEarlier: true });
    try {
      const page = await this.api.operations(this.uuid, { timelineLimit: this.options.pageLimit, beforeDisplaySeq: before });
      if (this.disposed) return 0;
      const previousCount = this.snapshot.rows.length;
      const merged = mergeOperationSnapshots(this.orderedOperations(), Array.isArray(page.operations) ? page.operations : []);
      this.replaceOperations(merged);
      this.nextBeforeDisplaySeq = page.hasMoreBefore ? Number(page.nextBeforeDisplaySeq) : null;
      this.reproject({ loadingEarlier: false, hasMoreBefore: Boolean(page.hasMoreBefore) });
      const added = Math.max(0, this.snapshot.rows.length - previousCount);
      this.emit({ prependedRows: added });
      return added;
    } catch (error: any) {
      this.emit({ loadingEarlier: false, error: String(error?.message || error) });
      return 0;
    }
  }

  toggleWork(workKey: string) {
    if (this.expandedWork.has(workKey)) this.expandedWork.delete(workKey);
    else this.expandedWork.add(workKey);
    this.reproject({ prependedRows: 0 });
  }

  operation(opId: string): Operation | undefined {
    return this.frameStore.operationsById.get(opId);
  }

  async operationDetail(opId: string): Promise<Operation | undefined> {
    const local = this.operation(opId);
    if (local && local.detailLoaded !== false && !local.detailAvailable) return local;
    try {
      const data = await this.api.operationDetail(this.uuid, opId);
      return data?.operation || local;
    } catch {
      return local;
    }
  }

  /** 整条回复的全文（“选择文本”阅读页用）。 */
  answerText(messageId: string): string {
    const op = this.operation(messageId);
    const payload = op?.payload || {};
    if (typeof payload.text === 'string') return payload.text;
    return Array.isArray(payload.textChunks) ? payload.textChunks.join('') : '';
  }

  // ---- 实时通道 ----
  private connect() {
    if (!this.socketFactory || this.disposed) return;
    this.emit({ socketState: 'connecting' });
    this.socket = this.socketFactory(this.uuid, this.frameStore.lastFrameSeq, {
      onOpen: () => this.emit({ socketState: 'open' }),
      onClose: () => {
        if (this.disposed) return;
        this.emit({ socketState: 'closed' });
        // 简单退避重连：按 afterFrameSeq 增量续接
        this.options.setTimer(() => this.connect(), 1500);
      },
      onMessage: (message) => this.onSocketMessage(message),
    });
  }

  private onSocketMessage(message: any) {
    if (!message || typeof message !== 'object') return;
    for (const listener of [...this.messageListeners]) listener(message);
    if (message.type === 'frame' && message.frame) this.enqueueFrame(message.frame);
    else if (message.type === 'live' || message.type === 'live_snapshot') {
      // Unstored progress; queued with frames so their order is preserved.
      // Snapshot entries replace the payload whatever action they were serialized with.
      const snapshot = message.type === 'live_snapshot';
      for (const update of Array.isArray(message.ops) ? message.ops : []) {
        this.enqueueFrame({ ...update, ...(snapshot ? { action: 'snapshot' } : {}), liveUpdate: true });
      }
    }
    else if (message.type === 'resync_required') void this.resync('full');
    else this.onExtraSocketMessage(message);
  }

  // ---------------------------------------------------------------- b2 新增

  /** state 接口 / WS state 里与卡片相关的附加字段（待回答交互、插话队列、隐藏状态）。 */
  private acceptStateExtras(state: any) {
    if (!state || typeof state !== 'object') return;
    const patch: Partial<ConversationSnapshot> = {};
    if (Array.isArray(state.pendingConfirmations)) patch.pendingConfirmations = state.pendingConfirmations.filter((x: any) => x?.confirmationId);
    if (Array.isArray(state.pendingSteering)) patch.pendingSteering = state.pendingSteering;
    if (Object.keys(patch).length) this.snapshot = { ...this.snapshot, ...patch };
    if (state.messageVisibility) this.applyVisibility(state.messageVisibility, false);
  }

  /** 与 Web ConsoleView.handleWsMessage 对应的非帧消息。 */
  private onExtraSocketMessage(message: any) {
    switch (message.type) {
      case 'bootstrap':
        this.acceptStateExtras({ messageVisibility: message.messageVisibility, pendingConfirmations: message.pendingConfirmations || [], pendingSteering: message.pendingSteering || [] });
        this.emit({});
        break;
      case 'state':
        this.acceptStateExtras(message.state || {});
        this.emit({});
        break;
      case 'web_confirmation': {
        const list = message.confirmations || message.confirmation || [];
        this.setPendingConfirmations(Array.isArray(list) ? list : [list]);
        break;
      }
      case 'pending_steering': {
        const action = String(message.action || 'snapshot');
        if (action === 'drain' || action === 'clear') {
          const ids = new Set((Array.isArray(message.itemIds) ? message.itemIds : []).map(String).filter(Boolean));
          this.emit({ pendingSteering: ids.size ? this.snapshot.pendingSteering.filter((item) => !ids.has(String(item.id))) : [] });
        } else this.emit({ pendingSteering: Array.isArray(message.items) ? message.items : [] });
        break;
      }
      case 'message_visibility.changed':
        this.applyVisibility(message.visibility);
        break;
      case 'conversation_reset':
        void this.reload();
        break;
      default:
        break;
    }
  }

  setPendingConfirmations(list: any[]) {
    this.emit({ pendingConfirmations: (Array.isArray(list) ? list : []).filter((x) => x?.confirmationId) });
  }

  removePendingConfirmation(confirmationId: string) {
    this.emit({ pendingConfirmations: this.snapshot.pendingConfirmations.filter((x) => x.confirmationId !== confirmationId) });
  }

  /** 应用隐藏状态快照（revision 不前进时忽略）；返回是否生效。 */
  applyVisibility(value: any, reproject = true): boolean {
    if (!value || (value.conversationUuid && value.conversationUuid !== this.uuid)) return false;
    const revision = Number(value.revision);
    if (!Number.isFinite(revision) || revision <= this.snapshot.visibility.revision) return false;
    const hiddenIds = Array.isArray(value.hiddenIds) ? value.hiddenIds.map(String) : [];
    this.hiddenIds = new Set(hiddenIds);
    const visibility = { revision, hiddenIds, items: Array.isArray(value.items) ? value.items : [] };
    // 先写入快照：reproject 用 visibility.revision 作为单轮记忆化签名
    this.snapshot = { ...this.snapshot, visibility };
    if (reproject) this.reproject({ visibility, prependedRows: 0 });
    return true;
  }

  /** 投影后的时间线事件（Agent 详情、工具详情用；web display.js 的输入形状）。 */
  eventFor(opId: string): any {
    const id = String(opId || '');
    for (let t = this.turns.length - 1; t >= 0; t -= 1) {
      const events = this.turns[t].events;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e: any = events[i];
        if (String(e?.operation?.opId || e?.id || '') === id) return e;
      }
    }
    return undefined;
  }

  /** 本轮的用户消息（投影的 turn.user）。 */
  turnUser(turnKey: string): any {
    return this.turns.find((t) => t.key === turnKey)?.user;
  }

  /** 本轮及之后的轮数（从此处重来的影响范围）。 */
  turnsFrom(turnKey: string): number {
    const index = this.turns.findIndex((t) => t.key === turnKey);
    return index >= 0 ? this.turns.length - index : 1;
  }

  isHidden(opId: string): boolean {
    return this.hiddenIds.has(String(opId || ''));
  }

  /** 能否隐藏（与 Web messageVisibility.canTarget 相同的条件）。 */
  canTargetVisibility(opId: string): boolean {
    const op = this.operation(String(opId || ''));
    const types = ['user_message', 'assistant_message', 'reasoning', 'tool', 'agent', 'user_interaction', 'context_compaction', 'model_retry', 'notice'];
    return Boolean(op && !op.internal && !op.payload?.internal && !op.payload?.hidden && types.includes(String(op.opType)));
  }

  /** 某一轮里可隐藏的模型侧内容（不含提问与插话），与 Web assistantTargets 相同。 */
  assistantTargets(turnKey: string): string[] {
    const turn = this.turns.find((t) => t.key === turnKey);
    if (!turn) return [];
    const out: string[] = [];
    for (const event of turn.events) {
      const id = String((event as any)?.operation?.opId || (event as any)?.opId || event?.eventKey || event?.id || '');
      const op = this.operation(id);
      if (!id || !op || op.opType === 'user_message' || this.hiddenIds.has(id) || !this.canTargetVisibility(id)) continue;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /** 本轮全部回复正文（Markdown，复制/分享用；与 Web replyMarkdownText 口径一致：正文之间空一行）。 */
  turnAnswerMarkdown(turnKey: string): string {
    const turn = this.turns.find((t) => t.key === turnKey);
    if (!turn) return '';
    return turn.events
      .filter((e) => e?.kind === 'answer' && !this.hiddenIds.has(String(e.operation?.opId || e.id)))
      .map((e) => String(e.message?.content ?? ''))
      .filter((text) => text.trim())
      .join('\n\n');
  }

  /** 轮次列表（导航用）：key、用户消息摘要、是否运行中。 */
  turnList(): Array<{ key: string; title: string; userOpId: string; turnUuid: string }> {
    return this.turns
      .filter((t) => t.user && !t.user.syntheticPlaceholder)
      .map((t) => ({ key: t.key, title: String(t.user?.content || ''), userOpId: String((t.user as any)?.opId || t.user?.id || ''), turnUuid: String(t.user?.turnUuid || '') }));
  }

  /** 重新读取最新一页（删除轮次、conversation_reset 后）。 */
  async reload(): Promise<void> {
    try {
      const state = await this.api.state(this.uuid, { timelineLimit: this.options.initialLimit });
      if (this.disposed) return;
      this.seekBaseIds = null;
      this.seekSaved = null;
      this.replaceOperations(preferNewerLiveOperations(Array.isArray(state.operations) ? state.operations : [], this.frameStore.operationsById));
      this.frameStore.lastFrameSeq = Math.max(this.frameStore.lastFrameSeq, Number(state.frameSeq || 0));
      this.nextBeforeDisplaySeq = state.hasMoreBefore ? Number(state.nextBeforeDisplaySeq) : null;
      this.acceptStateExtras(state);
      this.reproject({ hasMoreBefore: Boolean(state.hasMoreBefore), prependedRows: 0, seekActive: false, error: '' });
    } catch (error: any) {
      if (!this.disposed) this.emit({ error: String(error?.message || error) });
    }
  }

  /**
   * 搜索定位：并入 /operations/{opId}/window 返回的历史窗口（与 Web locateSearchResult 相同：
   * 保留定位前已加载的页与之后的实时帧，替换上一次的定位窗口）。返回目标是否存在。
   */
  mergeSeekWindow(operations: Operation[], nextBeforeDisplaySeq: number, targetOpId: string): boolean {
    const incoming = Array.isArray(operations) ? operations : [];
    if (!incoming.some((op) => op?.opId === targetOpId)) return false;
    if (!this.seekBaseIds) {
      this.seekBaseIds = new Set(this.frameStore.orderedOpIds);
      this.seekSaved = { nextBeforeDisplaySeq: this.nextBeforeDisplaySeq, hasMoreBefore: this.snapshot.hasMoreBefore };
    }
    const base = this.orderedOperations().filter((op) => this.seekBaseIds!.has(op.opId));
    this.replaceOperations(mergeOperationSnapshots(base, incoming));
    let hasMore = Boolean(this.seekSaved?.hasMoreBefore);
    const before = Number(nextBeforeDisplaySeq || 0);
    if (before > 0 && (!this.nextBeforeDisplaySeq || before < this.nextBeforeDisplaySeq)) {
      this.nextBeforeDisplaySeq = before;
      hasMore = before > 1;
    }
    this.reproject({ prependedRows: 0, seekActive: true, hasMoreBefore: hasMore });
    return true;
  }

  /** 返回原位置：丢掉定位窗口并入的操作，恢复翻页游标。 */
  releaseSeekWindow() {
    if (!this.seekBaseIds) return;
    const base = this.seekBaseIds;
    const kept = this.orderedOperations().filter((op) => base.has(op.opId) || Number(op.displaySeq || 0) > this.maxSeq(base));
    this.replaceOperations(kept);
    this.nextBeforeDisplaySeq = this.seekSaved?.nextBeforeDisplaySeq ?? null;
    const hasMore = Boolean(this.seekSaved?.hasMoreBefore);
    this.seekBaseIds = null;
    this.seekSaved = null;
    this.reproject({ prependedRows: 0, seekActive: false, hasMoreBefore: hasMore });
  }

  private maxSeq(ids: Set<string>): number {
    let max = 0;
    for (const id of ids) max = Math.max(max, Number(this.frameStore.operationsById.get(id)?.displaySeq || 0));
    return max;
  }

  /**
   * 定位前确保目标可见：目标在某轮折叠的工作块里时展开该工作块（与用户点“已工作…”展开等价）。
   * 返回是否发生了展开。
   */
  expandWorkFor(opId: string): boolean {
    const id = String(opId || '');
    if (!id || this.rowIndexForOp(id) >= 0) return false;
    for (const turn of this.turns) {
      if (turn.events.some((e: any) => String(e?.operation?.opId || e?.id || '') === id)) {
        const workKey = `${turn.key}|work`;
        if (this.expandedWork.has(workKey)) return false;
        this.expandedWork.add(workKey);
        this.reproject({ prependedRows: 0 });
        return true;
      }
    }
    return false;
  }

  /** 行下标：按 opId（用户消息 opId、回复 messageId、工具/Agent opId）找第一行。 */
  rowIndexForOp(opId: string): number {
    const id = String(opId || '');
    return this.snapshot.rows.findIndex((row: any) => row.opId === id || row.messageId === id);
  }

  /**
   * 发送一条消息（WS send 命令）：与 Web 的 WS 负载一致 {type:'send', requestId, text, files, referenceOrder}。
   * files 是先通过 transport/uploads.ts 上传得到的 [{uploadId}]；referenceOrder 是 @ 引用的顺序。
   */
  sendMessage(text: string, extra: { files?: { uploadId: string }[]; referenceOrder?: unknown[]; requestId?: string } = {}): boolean {
    if (!this.socket) return false;
    return this.socket.send({
      type: 'send',
      text,
      requestId: extra.requestId || `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      ...(extra.files?.length ? { files: extra.files } : {}),
      ...(extra.referenceOrder?.length ? { referenceOrder: extra.referenceOrder } : {}),
    });
  }

  /** 只有文字时的简写。 */
  send(text: string): boolean {
    const value = String(text || '').trim();
    if (!value || !this.socket) return false;
    return this.socket.send({ type: 'send', text: value, requestId: `m-${Date.now().toString(36)}` });
  }

  /** 停止当前运行（WS stop 命令，与 Web ConsoleView 相同的协议；后端回 {type:'stopped'} 并推终止帧）。 */
  stop(): boolean {
    if (!this.socket) return false;
    return this.socket.send({ type: 'stop' });
  }

  enqueueFrame(frame: Frame) {
    this.pendingFrames.push(frame);
    if (this.flushHandle === null) {
      this.flushHandle = this.options.setTimer(() => this.flushFrames(), this.options.throttleMs);
    }
  }

  /** 立即提交缓冲帧（测试与离开页面时调用）。 */
  flushFrames() {
    this.flushHandle = null;
    if (!this.pendingFrames.length || this.disposed) return;
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    let changed = false;
    let liveGap = false;
    for (const frame of frames) {
      if ((frame as any).liveUpdate) {
        const result = applyLiveOperationUpdate(this.frameStore, frame);
        if (result.applied) {
          changed = true;
          if (this.rawListeners.size) this.emitRaw({ type: 'frame', frame, operation: this.frameStore.operationsById.get(frame.opId) });
        }
        if (result.gap) liveGap = true;
        continue;
      }
      if (!shouldApplyOperationFrame(frame, this.frameStore)) continue;
      if (applyOperationFrame(this.frameStore, frame)) {
        changed = true;
        if (this.rawListeners.size) this.emitRaw({ type: 'frame', frame, operation: this.frameStore.operationsById.get(frame.opId) });
      }
      if (this.frameStore.needsResync) {
        const gap = this.frameStore.revisionGap || {};
        this.frameStore.needsResync = false;
        void this.resync(gap.requiresFullState ? 'full' : 'frames', Number(gap.frameSeq || 0) - 1);
      }
    }
    if (liveGap && this.options.now() - this.lastLiveResyncAt > 1000) {
      this.lastLiveResyncAt = this.options.now();
      this.socket?.send({ type: 'live_resync' });
    }
    if (changed) this.reproject({ prependedRows: 0 });
  }

  private async resync(mode: 'frames' | 'full', afterFrameSeq = this.frameStore.lastFrameSeq) {
    if (this.resyncing) return;
    this.resyncing = true;
    try {
      if (mode === 'frames') {
        const data = await this.api.frames(this.uuid, Math.max(0, afterFrameSeq), 1000);
        for (const frame of data.frames || []) {
          if (shouldApplyOperationFrame(frame, this.frameStore)) applyOperationFrame(this.frameStore, frame);
        }
        if (!this.frameStore.needsResync) {
          this.reproject({ prependedRows: 0 });
          return;
        }
      }
      const state = await this.api.state(this.uuid, { timelineLimit: this.options.initialLimit });
      this.rememberState(state);
      const merged = mergeOperationSnapshots(this.orderedOperations(), state.operations || []);
      this.replaceOperations(merged);
      this.frameStore.lastFrameSeq = Number(state.frameSeq || this.frameStore.lastFrameSeq);
      this.frameStore.needsResync = false;
      this.reproject({ prependedRows: 0, meta: stateWithoutTimeline(state) });
    } catch (error: any) {
      this.emit({ error: String(error?.message || error) });
    } finally {
      this.resyncing = false;
    }
  }

  // ---- 输入区（B3）用的加法接口 ----

  /** 订阅会话 WS 的原始消息（ack / error / stopped / pending_steering / bootstrap…）；返回取消订阅。 */
  onMessage(listener: (message: any) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /** 向会话 WS 发一条原始命令（输入区发送前的 ping 探活等）；未连接时返回 false。 */
  sendCommand(payload: Record<string, unknown>): boolean {
    return Boolean(this.socket?.send(payload));
  }

  /** 会话 WS 当前是否可发送 */
  get socketOpen(): boolean {
    return Boolean(this.socket) && this.snapshot.socketState === 'open';
  }

  /** 重新读取 state 的非时间线字段（运行配置、用量、累计统计）；时间线不动。 */
  async refreshMeta(): Promise<void> {
    try {
      const state = await this.api.state(this.uuid, { timelineLimit: 1 });
      if (this.disposed) return;
      this.emit({ meta: stateWithoutTimeline(state), model: String(state.conversation?.model || state.model || this.snapshot.model) });
    } catch {
      /* 下次再取 */
    }
  }

  /** 运行配置保存成功后，把服务端返回的完整 runConfig 合并进 meta（输入区胶囊、副标题立即更新）。 */
  applyRunConfig(runConfig: Record<string, any>) {
    if (!runConfig || this.disposed) return;
    this.emit({ meta: { ...(this.snapshot.meta || {}), ...runConfig }, model: String(runConfig.model || this.snapshot.model) });
  }

  dispose() {
    this.disposed = true;
    this.messageListeners.clear();
    this.composer = undefined;
    if (this.flushHandle !== null) this.options.clearTimer(this.flushHandle);
    this.socket?.close();
    this.socket = null;
    this.listeners.clear();
    this.rawListeners.clear();
  }
}
