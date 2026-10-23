/**
 * 输入区（B3）：浮动卡片（方向稿 ②③⑥ 屏），对话页与新会话页共用。
 *
 * - 文字：系统 TextInput，片段受控（引用胶囊为带底色的“@名称”，触及即整体删除）；回车换行、按钮发送；
 *   检测到外接键盘后 Enter 发送、Shift+Enter 换行（见 hardwareKeyboard.ts）。输入 @ 打开引用选择器（卡片上方）。
 * - 待发送条：引用胶囊（点开详情）+ 附件（图片缩略图点开大图、文件块名称大小、移除需确认、上传进度）。
 * - 草稿：文字按服务器 + 会话保存（drafts/textDrafts），附件拷进 App 目录保存（drafts/attachmentDrafts，Web 同上限）。
 * - 发送：requestId + Web outboundSend 的单发送跟踪；附件先分片上传（transport/uploads）再 WS send；
 *   运行中发送 = 插话；失败恢复草稿与附件，不自动重发；停止需确认，上传中停止 = 取消上传。
 * - 工具条：+（附件、粘贴图片、@ 引用、新话题、立即压缩、清空草稿）、运行配置胶囊（模型 · 思考 · Fast · 压缩策略）、
 *   上下文用量环（点开看用量与累计统计）、发送/停止（长按切换方/圆）。
 * 布局沿用原 Composer：在父级 KeyboardAvoidingView 的纵向列里压在列表底部之上（COMPOSER_OVERLAP），
 * 键盘弹起时底部安全区留白逐帧收成 0；宽屏限宽 readingWidth。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { ArrowUp, AtSign, Brain, Camera, ChevronDown, ClipboardPaste, Eraser, Image as ImageIcon, Layers, Paperclip, Plus, SquarePen, Zap } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { useConversationSnapshot, useSession } from '../data/session';
import type { ConversationStore } from '../data/conversationStore';
import { attachmentDraftKey, attachmentDrafts, memoryOnlyIds } from '../drafts/attachmentDrafts';
import { loadDraft, setDraft } from '../drafts/textDrafts';
import { ReferenceInspector } from '../references/ReferenceInspector';
import { ReferencePanel, type ReferencePanelHandle } from '../references/ReferencePanel';
import { acceptReferenceSizes, referenceCatalog, useReferenceCatalog } from '../references/catalogStore';
import {
  applyBindings,
  applyDisplayChange,
  displayText,
  insertRefs,
  mentionAt,
  parseDraftText,
  policyReasonText,
  refDisplay,
  refFromExternal,
  referenceErrorText,
  referenceKey,
  referenceOrder as computeReferenceOrder,
  referenceToken,
  refSegments,
  removeRef,
  replaceRef,
  serialize,
  spliceSegments,
  uniqueRefs,
  applyConversationPolicy,
  type Ref,
  type Segment,
} from '../references/draftModel';
import { referencePolicyOptions } from '../references/catalogStore';
import { RunConfigEditor } from '../runconfig/RunConfigEditor';
import {
  SUMMARY,
  canCompactNow,
  contextUsageView,
  findModel,
  modelThinkingLevels,
  normalizeStrategy,
  runConfigChip,
  runConfigFromState,
  savedMessage,
  strategyLabel,
  usageTotals,
  type RunConfig,
} from '../runconfig/logic';
import { useModelOptions, useOpenBearApi } from '../runconfig/options';
import { onRunConfigSaved, saveConversationRunConfig } from '../runconfig/saveQueue';
import { apiError } from '../transport/apiAdapter';
import { HttpError } from '../transport/http';
import { uploadConversationFiles } from '../transport/uploads';
import { ConfirmSheet } from '../ui/Form';
import { Icon, Press, tap } from '../ui/primitives';
import { Sheet, SheetScroll } from '../ui/Sheet';
import { showToast } from '../ui/Toast';
import type { Theme } from '../ui/theme';
import { elevation, readingWidth } from '../ui/theme';
import { withAlpha } from '../chat/sheetKit';
import { setPendingFirstSend, takePendingFirstSend, type FirstSend } from './handoff';
import { markHardwareKeyboard, useHardwareKeyboard } from './hardwareKeyboard';
import { ImageViewer, MenuRow, PendingStrip, StatusRow, SteeringList, UsageDetails, UsageRing, type Att } from './parts';
import {
  ATTACHMENT_ONLY_TEXT,
  applyPendingSteeringEvent,
  createOutboundSendTracker,
  createRequestId,
  failureText,
  filePercent,
  initialConversationTitle,
  normalizePendingSteering,
  pastedFileName,
  restoreOutboundDraft,
  uploadStatusText,
  type SteeringItem,
  type UploadState,
} from './sendLogic';

/** 新会话页（B3-35）传入：草稿键、默认运行配置、建会话。 */
export type NewConversationContext = {
  draftKey: string;
  /** 已解析的运行配置；读不到默认配置时为 null（阻止发送） */
  runConfig: RunConfig | null;
  defaultsError: string;
  saving: boolean;
  onRunConfigChange(patch: Partial<RunConfig>): void;
  /** 用首条消息生成的标题建会话，返回会话 UUID */
  create(title: string): Promise<string>;
};

type Props = {
  theme: Theme;
  disabled: boolean;
  running: boolean;
  bottomInset: number;
  padH: number;
  /** 所在会话；新会话草稿时为 undefined */
  uuid?: string;
  store?: ConversationStore;
  /** 兼容旧接口：没有 store 时（演示页）用它发送纯文字 */
  onSend(text: string): boolean;
  onStop?: () => void;
  /** 会话当前模型展示名；state 尚未载入时胶囊显示它 */
  modelLabel?: string;
  /** 新会话页传入（可选） */
  newConversation?: NewConversationContext;
};

const LINE = 22;
const MAX_LINES = 6;
const INPUT_PAD_TOP = 4;
const INPUT_PAD_BOTTOM = 8;
const KEYBOARD_GAP = 8;
const SIDE = 10;
const BASE_CARD_HEIGHT = 10 + LINE + INPUT_PAD_TOP + INPUT_PAD_BOTTOM + 34 + 8 + 1;
/** 列表可视区伸入输入区下方的高度（= 单行卡片 + 与键盘/导航栏的间距） */
export const COMPOSER_OVERLAP = BASE_CARD_HEIGHT + KEYBOARD_GAP;

const SHAPE_KEY = 'openbear.composer.buttonShape.v1';
const STOP_MESSAGE = '停止后会中断当前正在执行的模型请求和工具任务，已产生的对话与统计会尽量保留。确定要停止吗？';

let attachmentSeq = 0;
const nextAttachmentId = () => `att-${Date.now().toString(36)}-${(attachmentSeq += 1)}`;

function baseName(value: string): string {
  const clean = String(value || '').split('?')[0];
  try {
    return decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1)) || '附件';
  } catch {
    return clean.slice(clean.lastIndexOf('/') + 1) || '附件';
  }
}

function fileSize(uri: string, known?: number | null): number {
  if (typeof known === 'number' && known >= 0) return known;
  try {
    return Number(new File(uri).size) || 0;
  } catch {
    return 0;
  }
}

function stateFromRunConfig(cfg: RunConfig | null, models: any[]) {
  if (!cfg) return null;
  const info = findModel(models, cfg.model);
  return {
    model: cfg.model,
    thinkingLevel: cfg.thinkLevel,
    effectiveThinkingLevel: cfg.thinkLevel,
    thinkingLevels: modelThinkingLevels(info),
    fastMode: Boolean(cfg.fastMode),
    contextStrategy: normalizeStrategy(cfg.contextStrategy),
  };
}

/** 等一个 pong 证明 WS 不是半开连接（Web probeSocket）。 */
function probe(store: ConversationStore, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const off = store.onMessage((m) => {
      if (m?.type === 'pong' && !done) {
        done = true;
        clearTimeout(timer);
        off();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      off();
      reject(new Error('连接无响应，请稍后重试'));
    }, timeoutMs);
    if (!store.sendCommand({ type: 'ping' })) {
      done = true;
      clearTimeout(timer);
      off();
      reject(new Error('连接未就绪，请稍后重试'));
    }
  });
}

export function Composer({ theme, disabled, running, bottomInset, uuid, store, onSend, onStop, modelLabel, newConversation }: Props) {
  const session = useSession();
  const api = useOpenBearApi();
  const models = useModelOptions();
  const catalog = useReferenceCatalog();
  const hardware = useHardwareKeyboard();
  const snapshot = useConversationSnapshot(store);
  const meta = snapshot?.meta;
  const { height: screenHeight } = useWindowDimensions();

  const serverId = session.active?.id || 'default';
  const draftKey = uuid || newConversation?.draftKey || 'local:new|';
  const attKey = attachmentDraftKey(serverId, draftKey);

  // ---- 状态 ----
  const [segments, setSegmentsState] = useState<Segment[]>([]);
  const segmentsRef = useRef<Segment[]>([]);
  const setSegments = useCallback((next: Segment[]) => {
    segmentsRef.current = next;
    setSegmentsState(next);
  }, []);
  const [attachments, setAttachmentsState] = useState<Att[]>([]);
  const attachmentsRef = useRef<Att[]>([]);
  const setAttachments = useCallback((next: Att[]) => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
  }, []);
  const loadedKey = useRef('');
  const [draftLoaded, setDraftLoaded] = useState(false);
  const selectionRef = useRef({ start: 0, end: 0 });
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [forcedSelection, setForcedSelectionState] = useState<{ start: number; end: number } | undefined>();
  const forcedAt = useRef(0);
  const setForcedSelection = useCallback((value: { start: number; end: number } | undefined) => {
    if (value) {
      forcedAt.current = Date.now();
      selectionRef.current = value;
    }
    setForcedSelectionState(value);
  }, []);
  const [focused, setFocused] = useState(false);
  const [dismissedMention, setDismissedMention] = useState('');
  const [progress, setProgress] = useState<Record<string, UploadState>>({});
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<{ text: string; busy?: boolean; tone?: 'danger' | 'normal' }>({ text: '' });
  const [sendPending, setSendPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [steering, setSteering] = useState<SteeringItem[]>([]);
  const [menu, setMenu] = useState<'none' | 'attach' | 'runcfg' | 'usage' | 'stop' | 'clear'>('none');
  const [removeTarget, setRemoveTarget] = useState<Att | null>(null);
  const [viewer, setViewer] = useState<Att | null>(null);
  const [inspectUid, setInspectUid] = useState('');
  const [saving, setSaving] = useState(0);
  const [compacting, setCompacting] = useState(false);
  const [round, setRound] = useState(true);
  const [validation, setValidation] = useState<any>(null);
  const [invalidKeys, setInvalidKeys] = useState<Set<string>>(new Set());
  const [clipboardImage, setClipboardImage] = useState(false);
  const [runTab, setRunTab] = useState<'main' | 'agent'>('main');
  const orderRef = useRef<string[]>([]);
  const lastSoftEnter = useRef(0);
  const panelRef = useRef<ReferencePanelHandle>(null);
  const inputRef = useRef<TextInput>(null);
  const autoSend = useRef<FirstSend | null>(null);
  const previewGen = useRef(0);

  // 发送/停止按钮形状偏好（B3-41）
  useEffect(() => {
    let alive = true;
    Storage.getItemAsync(SHAPE_KEY)
      .then((value) => alive && setRound(value !== 'square'))
      .catch(() => undefined); // 默认圆形
    return () => {
      alive = false;
    };
  }, []);
  const toggleShape = () => {
    tap('medium');
    const next = !round;
    setRound(next);
    void Storage.setItemAsync(SHAPE_KEY, next ? 'circle' : 'square').catch(() => undefined);
    showToast(next ? '发送按钮已改为圆形' : '发送按钮已改为方形');
  };

  // ---- 草稿载入（切换会话/服务器、App 重启后恢复） ----
  useEffect(() => {
    let cancelled = false;
    loadedKey.current = '';
    setDraftLoaded(false);
    setProgress({});
    setValidation(null);
    const first = uuid ? takePendingFirstSend(uuid) : null;
    autoSend.current = first;
    if (first) {
      setSegments(parseDraftText(first.draftText));
      setAttachments(first.attachments);
      orderRef.current = first.referenceOrder;
      loadedKey.current = draftKey;
      setDraftLoaded(true);
      return undefined;
    }
    setSegments([]);
    setAttachments([]);
    void Promise.all([loadDraft(serverId, draftKey).catch(() => ''), attachmentDrafts().load(attKey)]).then(([text, record]) => {
      if (cancelled) return;
      const segs = parseDraftText(text);
      setSegments(segs);
      orderRef.current = computeReferenceOrder([], segs);
      setAttachments(record.items.map((item: any) => ({ id: String(item.id), file: item.file })));
      loadedKey.current = draftKey;
      setDraftLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [serverId, draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 文字草稿保存 ----
  const trackerRef = useRef<ReturnType<typeof createOutboundSendTracker> | null>(null);
  const recoverRef = useRef<(pending: any) => void>(() => undefined);
  if (!trackerRef.current) trackerRef.current = createOutboundSendTracker({ onTimeout: (pending: any) => recoverRef.current(pending) });
  const tracker = trackerRef.current;

  useEffect(() => {
    if (loadedKey.current !== draftKey) return;
    const text = serialize(segments);
    const pending = tracker.current;
    const preparing = pending && !pending.storageReleased && pending.draftKey === draftKey;
    setDraft(serverId, draftKey, preparing ? restoreOutboundDraft(pending.draftText, text) : text);
    orderRef.current = computeReferenceOrder(orderRef.current, segments);
  }, [segments, draftLoaded, serverId, draftKey, tracker]);

  // ---- 外部接口（b2：引用本轮问答、放回原消息） ----
  const insertAtCursor = useCallback(
    (refs: Ref[]) => {
      const values = applyConversationPolicy(refs, uniqueRefs(segmentsRef.current), referencePolicyOptions()).filter(Boolean);
      if (!values.length) return;
      const at = Math.min(selectionRef.current.start, displayText(segmentsRef.current).length);
      const { segments: next, cursor } = insertRefs(segmentsRef.current, at, Math.max(at, selectionRef.current.end), values);
      setSegments(next);
      setForcedSelection({ start: cursor, end: cursor });
      setTimeout(() => inputRef.current?.focus(), 50);
    },
    [setSegments],
  );
  useEffect(() => {
    if (!store) return undefined;
    const bridge = {
      insertReference(input: { kind: 'turn' | 'message'; conversationUuid: string; turnUuid?: string; opId?: string; title?: string }) {
        const ref = refFromExternal(input);
        if (ref) insertAtCursor([ref]);
      },
      setDraftText(text: string, opts?: { onlyIfEmpty?: boolean }) {
        if (opts?.onlyIfEmpty && serialize(segmentsRef.current).trim()) return false;
        const segs = parseDraftText(text);
        setSegments(segs);
        const end = displayText(segs).length;
        setForcedSelection({ start: end, end });
        return true;
      },
    };
    store.composer = bridge;
    return () => {
      if (store.composer === bridge) store.composer = undefined;
    };
  }, [store, insertAtCursor, setSegments]);

  // ---- 运行配置 ----
  useEffect(() => {
    if (!store || !uuid) return undefined;
    return onRunConfigSaved(uuid, (runConfig) => store.applyRunConfig(runConfig));
  }, [store, uuid]);
  const runState = newConversation ? stateFromRunConfig(newConversation.runConfig, models.models) : meta;
  const chip = runState ? runConfigChip(runState, models.models) : null;
  const editorValue: RunConfig = newConversation ? newConversation.runConfig || {} : runConfigFromState(meta);
  const savingAny = saving > 0 || Boolean(newConversation?.saving);
  const onEditorChange = (patch: Partial<RunConfig>) => {
    if (newConversation) {
      newConversation.onRunConfigChange(patch);
      return;
    }
    if (!api || !uuid) return;
    setSaving((n) => n + 1);
    saveConversationRunConfig(api, uuid, patch)
      .then(({ response }) => showToast(savedMessage(patch, running, response)))
      .catch((error) => {
        const code = apiError(error);
        showToast(code === 'run_is_active' ? '当前有运行中的任务，结束后再切换模型' : `保存失败：${code}`);
      })
      .finally(() => setSaving((n) => n - 1));
  };

  // 用量、累计统计
  const usageView = useMemo(() => contextUsageView(meta, findModel(models.models, meta?.model)), [meta, models.models]);
  const totals = useMemo(() => usageTotals(meta), [meta]);
  const compactState = canCompactNow(meta, usageView, running);
  const isSummary = normalizeStrategy(runState?.contextStrategy) === SUMMARY;

  // 运行结束后刷新用量与累计统计
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void store?.refreshMeta();
      setStatus((s) => (s.text === '已请求停止' ? { text: '' } : s));
    }
    wasRunning.current = running;
  }, [running, store]);

  const compact = async () => {
    if (!api || !uuid || compacting) return;
    if (!compactState.ok) {
      showToast(compactState.reason);
      return;
    }
    setCompacting(true);
    try {
      const data: any = await api.conversationCompact(uuid);
      if (data?.ok === false) throw new Error(data.message || data.error || '压缩失败');
      await store?.refreshMeta();
      showToast('上下文压缩完成');
    } catch (error) {
      showToast(apiError(error));
    } finally {
      setCompacting(false);
    }
  };

  // ---- 待处理插话 ----
  useEffect(() => {
    if (meta?.pendingSteering) setSteering(normalizePendingSteering(meta.pendingSteering));
  }, [meta?.pendingSteering]);

  // ---- 发送 ----
  const restore = useCallback(
    (pending: any, text: string) => {
      if (!pending) return;
      try {
        pending.uploadController?.abort();
      } catch {
        /* ignore */
      }
      const restored = restoreOutboundDraft(pending.draftText, serialize(segmentsRef.current));
      const segs = parseDraftText(restored);
      setSegments(segs);
      setDraft(serverId, pending.draftKey, restored);
      if (pending.attachments.length) {
        setProgress(Object.fromEntries(pending.attachments.map((a: Att) => [a.id, { phase: 'failed', percent: 0 }])));
        const ids = new Set(attachmentsRef.current.map((a) => a.id));
        const merged = [...attachmentsRef.current, ...pending.attachments.filter((a: Att) => !ids.has(a.id))];
        setAttachments(merged);
        if (pending.storageReleased) void attachmentDrafts().save(attKey, merged);
      }
      setLocked(new Set());
      setUploading(false);
      setSendPending(false);
      setStatus({ text, tone: 'danger' });
    },
    [serverId, attKey, setSegments, setAttachments],
  );
  recoverRef.current = (pending: any) => {
    const uncertain = pending?.phase === 'sent';
    restore(pending, failureText('send_timeout', uncertain));
    showToast(uncertain ? '发送结果未确认，草稿和附件已保留' : '消息未能发送，草稿和附件已恢复');
    void store?.refreshMeta();
  };

  const finish = useCallback(
    (pending: any) => {
      const ids = new Set(pending.attachments.map((a: Att) => a.id));
      setAttachments(attachmentsRef.current.filter((a) => !ids.has(a.id)));
      setProgress({});
      setLocked(new Set());
      setUploading(false);
      setSendPending(false);
      if (pending.wasRunning) {
        setStatus({ text: '插话已提交，等待当前运行处理' });
        setTimeout(() => setStatus((s) => (s.text === '插话已提交，等待当前运行处理' ? { text: '' } : s)), 4000);
      } else setStatus({ text: '' });
    },
    [setAttachments],
  );

  const handlers = useRef({ finish, restore });
  handlers.current = { finish, restore };
  useEffect(() => {
    if (!store) return undefined;
    return store.onMessage((m) => {
      if (m.type === 'pending_steering') setSteering((s) => applyPendingSteeringEvent(s, m));
      else if (m.type === 'bootstrap' && Array.isArray(m.pendingSteering)) setSteering(normalizePendingSteering(m.pendingSteering));
      else if (m.type === 'stopped') setStatus({ text: '已请求停止' });
      else if ((m.type === 'ack' || m.type === 'error') && m.requestId) {
        const pending = trackerRef.current?.take(String(m.requestId));
        if (!pending) return;
        if (m.type === 'ack') handlers.current.finish(pending);
        else {
          const reason = m.referenceError ? referenceErrorText(m.referenceError) : String(m.error || 'send_failed');
          handlers.current.restore(pending, failureText(reason, false));
          showToast(`发送失败：${reason}`);
          if (m.referenceError?.key) setInvalidKeys(new Set([String(m.referenceError.key)]));
        }
      }
    });
  }, [store]);

  const hasText = serialize(segments).trim().length > 0;
  const connected = newConversation ? true : snapshot?.socketState === 'open';
  const canSend =
    !disabled &&
    !sendPending &&
    !savingAny &&
    !compacting &&
    connected &&
    (running ? hasText && attachments.length === 0 : hasText || attachments.length > 0) &&
    (!newConversation || Boolean(newConversation.runConfig));

  const sendNew = async (segs: Segment[], atts: Att[]) => {
    const ctx = newConversation!;
    if (!ctx.runConfig) {
      showToast(ctx.defaultsError || '会话默认配置尚未读取完成，草稿和附件已保留');
      return;
    }
    setSendPending(true);
    setStatus({ text: '正在创建会话…', busy: true });
    try {
      const plain = segs.map((s) => (s.type === 'ref' ? s.ref.label : s.text)).join('').trim();
      const title = initialConversationTitle(plain || (atts.length ? ATTACHMENT_ONLY_TEXT : '新会话'));
      const newUuid = await ctx.create(title);
      const draftText = serialize(segs);
      setPendingFirstSend(newUuid, { draftText, attachments: atts, referenceOrder: computeReferenceOrder(orderRef.current, segs) });
      setDraft(serverId, newUuid, draftText);
      await attachmentDrafts().move(attKey, attachmentDraftKey(serverId, newUuid));
      setSegments([]);
      setAttachments([]);
      setStatus({ text: '' });
      router.replace(`/conversation/${encodeURIComponent(newUuid)}`);
    } catch (error) {
      const message = `创建会话失败：${apiError(error)}。草稿和附件已保留`;
      setStatus({ text: message, tone: 'danger' });
      showToast(message);
    } finally {
      setSendPending(false);
    }
  };

  const send = async () => {
    if (tracker.current || sendPending) return;
    const segs = segmentsRef.current;
    const draftText = serialize(segs);
    const text = draftText.trim();
    const atts = attachmentsRef.current;
    if (!text && !atts.length) return;
    if (uniqueRefs(segs).length && (!referenceCatalog.ready || !catalog.connected)) {
      showToast('引用目录尚未连接，请稍后发送；草稿已保留');
      setStatus({ text: '引用目录尚未连接，草稿已保留', tone: 'danger' });
      return;
    }
    if (running && atts.length) {
      showToast('运行中暂不追加附件，可以先停止或等当前轮完成');
      return;
    }
    if (savingAny) {
      showToast('运行配置保存中，请稍候');
      return;
    }
    tap('light');
    if (newConversation) {
      await sendNew(segs, atts);
      return;
    }
    if (!store || !uuid) {
      if (onSend(text)) setSegments([]);
      return;
    }
    if (!store.socketOpen || !session.http) {
      showToast('连接未就绪，请稍后发送；草稿已保留');
      return;
    }
    const startedRunning = running;
    const requestId = createRequestId();
    const referenceOrder = computeReferenceOrder(orderRef.current, segs);
    const pending = tracker.begin({ requestId, conversationUuid: uuid, draftKey, draftText, attachments: atts, wasRunning: startedRunning });
    if (!pending) return;
    setSendPending(true);
    setLocked(new Set(atts.map((a) => a.id)));
    setProgress(Object.fromEntries(atts.map((a) => [a.id, { phase: 'preparing', percent: 0 }])));
    setStatus({ text: startedRunning ? '插话排队中' : '提交中', busy: true });
    setValidation(null);
    setSegments([]);
    setForcedSelection({ start: 0, end: 0 });
    try {
      let files: { uploadId: string }[] = [];
      if (atts.length) {
        pending.uploadController = new AbortController();
        tracker.markUploading(pending);
        setUploading(true);
        setStatus({ text: '上传附件中', busy: true });
        files = await uploadConversationFiles(session.http, uuid, atts.map((a) => a.file), {
          signal: pending.uploadController.signal,
          onProgress: (p) => {
            if (!tracker.isCurrent(pending)) return;
            setProgress((prev) => ({ ...prev, [atts[p.fileIndex].id]: { phase: p.phase, percent: filePercent(p) } }));
            setStatus({ text: uploadStatusText(p), busy: true });
          },
        });
        if (!tracker.isCurrent(pending)) return;
        tracker.markPrepared(pending);
        setUploading(false);
        setStatus({ text: startedRunning ? '插话排队中' : '提交中', busy: true });
      }
      await probe(store);
      if (!tracker.isCurrent(pending)) return;
      pending.storageReleased = true;
      if (atts.length) {
        const cleared = await attachmentDrafts().removeItems(attKey, atts.map((a) => a.id));
        if (!tracker.isCurrent(pending)) return;
        if (!cleared) throw new Error('attachment_draft_clear_failed');
      }
      setDraft(serverId, draftKey, serialize(segmentsRef.current));
      // 只有附件时用默认文案（与 Web 相同）
      if (!store.sendMessage(text || ATTACHMENT_ONLY_TEXT, { files, referenceOrder, requestId })) throw new Error('ws_closed');
      tracker.markSent(pending);
    } catch (error) {
      if (!tracker.isCurrent(pending)) return;
      tracker.take(requestId);
      const code = apiError(error);
      restore(pending, failureText(code, false));
      if (code !== 'aborted') showToast(failureText(code, false));
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // 新会话首次发送：进入对话页、连接就绪后按正常链路发送这一条
  useEffect(() => {
    if (!autoSend.current || !draftLoaded || !store || snapshot?.socketState !== 'open' || snapshot?.loading) return;
    autoSend.current = null;
    const timer = setTimeout(() => void sendRef.current(), 300);
    return () => clearTimeout(timer);
  }, [draftLoaded, store, snapshot?.socketState, snapshot?.loading]);

  // ---- 停止 ----
  const requestStop = () => {
    const pending = tracker.current;
    if (pending && pending.phase === 'uploading') {
      tap('medium');
      pending.uploadController?.abort();
      return;
    }
    Keyboard.dismiss();
    setMenu('stop');
  };
  const confirmStop = async () => {
    setMenu('none');
    if (store && store.socketOpen && store.stop()) {
      setStatus({ text: '已请求停止' });
      showToast('已请求停止');
      return;
    }
    if (!store) {
      onStop?.();
      return;
    }
    if (!api || !uuid) return;
    try {
      const data: any = await api.conversationStop(uuid);
      const text = data?.stoppedRun || data?.stoppedTasks ? '已请求停止' : '没有运行中的任务';
      setStatus({ text });
      showToast(text);
    } catch (error) {
      showToast(apiError(error));
    }
  };

  // ---- 引用：@ 选择器、预览校验、详情 ----
  const mention = useMemo(() => (focused && selection.start === selection.end ? mentionAt(segments, selection.start) : null), [focused, segments, selection]);
  const mentionKey = mention ? `${mention.from}:${mention.kind}:${mention.query}` : '';
  const showPanel = Boolean(mention) && dismissedMention !== mentionKey && !sendPending;
  const closePanel = useCallback(() => setDismissedMention(mentionKey), [mentionKey]);
  useEffect(() => {
    if (!showPanel) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closePanel();
      return true;
    });
    return () => sub.remove();
  }, [showPanel, closePanel]);
  const selectRefs = (refs: Ref[]) => {
    if (!mention) return;
    const { segments: next, cursor } = insertRefs(segmentsRef.current, mention.from, mention.to, refs);
    setSegments(next);
    setForcedSelection({ start: cursor, end: cursor });
    selectionRef.current = { start: cursor, end: cursor };
    setSelection({ start: cursor, end: cursor });
  };

  const currentRefs = refSegments(segments).map(({ ref, uid }) => ({ ref, uid, key: referenceKey(ref) }));
  const previewKey = uniqueRefs(segments).map((r) => referenceToken(r)).join('\n');
  useEffect(() => {
    if (!api) return undefined;
    const gen = ++previewGen.current;
    if (!previewKey) {
      setValidation(null);
      setInvalidKeys(new Set());
      return undefined;
    }
    const timer = setTimeout(async () => {
      const text = serialize(segmentsRef.current);
      try {
        const result: any = await (api.referencePreview as any)(text, uuid || '', orderRef.current);
        if (gen !== previewGen.current) return;
        setValidation(result);
        setInvalidKeys(new Set());
        acceptReferenceSizes(result?.bindings || result?.items || [], result?.conversationContentLimit);
        if (serialize(segmentsRef.current) === text) {
          const next = applyBindings(segmentsRef.current, result?.bindings || []);
          if (next !== segmentsRef.current) setSegments(next);
        }
      } catch (error) {
        if (gen !== previewGen.current) return;
        const body = error instanceof HttpError && error.body && typeof error.body === 'object' ? error.body : { ok: false, error: '引用目录暂时不可用' };
        setValidation(body);
        const detail = body.referenceError;
        if (detail?.code === 'reference_unavailable' && detail.key) setInvalidKeys(new Set([String(detail.key)]));
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [previewKey, api, uuid, setSegments]);
  const sizeWarnings = [...new Set(currentRefs.map(({ ref }) => policyReasonText(ref.modeReason)).filter(Boolean))].map((t) => t.replace('将仅提及', '已仅提及'));
  const validationText = validation?.ok === false ? `${referenceErrorText(validation.error)}${validation.referenceError?.label ? `：${validation.referenceError.label}` : ''}` : '';
  const inspected = currentRefs.find((r) => r.uid === inspectUid) || null;

  // ---- 输入 ----
  const onChangeText = (next: string) => {
    const prev = displayText(segmentsRef.current);
    let { segments: updated, cursor } = applyDisplayChange(segmentsRef.current, next);
    // 粘贴/外部带入的引用 token（推荐卡“复制引用”、Web 复制的消息）转成胶囊，发送编码不变
    if (next.includes('openbear://ref/') && updated.some((seg) => seg.type === 'text' && seg.text.includes('openbear://ref/'))) {
      let tail = 0;
      while (tail < Math.min(prev.length, next.length) && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
      updated = parseDraftText(serialize(updated));
      cursor = Math.max(0, displayText(updated).length - tail);
    }
    setSegments(updated);
    if (cursor !== undefined) setForcedSelection({ start: cursor, end: cursor });
    // 外接键盘检测（Android）：插入了一个换行，且没有软键盘的 Enter 按键事件
    if (Platform.OS === 'android' && !hardware && next.length === prev.length + 1 && Date.now() - lastSoftEnter.current > 300) {
      let at = 0;
      while (at < prev.length && prev[at] === next[at]) at += 1;
      if (next[at] === '\n' && next.slice(at + 1) === prev.slice(at)) {
        markHardwareKeyboard();
        setTimeout(() => {
          setSegments(spliceSegments(segmentsRef.current, at, at + 1, []));
          setForcedSelection({ start: at, end: at });
          enterRef.current();
        }, 0);
      }
    }
  };
  const handleEnter = () => {
    if (showPanel && panelRef.current?.chooseHighlighted()) return;
    if (canSend) void send();
  };
  const enterRef = useRef(handleEnter);
  enterRef.current = handleEnter;

  // ---- 附件 ----
  const addAttachments = (items: Att[]) => {
    if (!items.length) return;
    if (running || sendPending) {
      showToast('运行中暂不能添加附件');
      return;
    }
    const next = [...attachmentsRef.current, ...items];
    const memOnly = memoryOnlyIds(next);
    setAttachments(next.map((a) => ({ ...a, memoryOnly: memOnly.has(a.id) })));
    void attachmentDrafts().save(attKey, next.map(({ id, file }) => ({ id, file })));
    if (items.some((i) => memOnly.has(i.id))) showToast('附件超过草稿保存上限（单个 32MB、合计 96MB），只保留在本次使用期间');
  };
  const removeAttachment = (target: Att) => {
    const next = attachmentsRef.current.filter((a) => a.id !== target.id);
    setAttachments(next);
    setProgress((p) => {
      const { [target.id]: _drop, ...rest } = p;
      return rest;
    });
    void attachmentDrafts().save(attKey, next.map(({ id, file }) => ({ id, file })));
  };
  const clearDraft = () => {
    setSegments([]);
    setAttachments([]);
    setProgress({});
    setValidation(null);
    setStatus({ text: '' });
    void attachmentDrafts().remove(attKey);
    setDraft(serverId, draftKey, '');
    setMenu('none');
  };

  const pick = async (source: 'library' | 'camera' | 'file') => {
    try {
      if (source === 'file') {
        const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
        if (result.canceled) return;
        addAttachments(
          result.assets.map((a) => ({
            id: nextAttachmentId(),
            file: { uri: a.uri, name: a.name || baseName(a.uri), type: a.mimeType || 'application/octet-stream', size: fileSize(a.uri, a.size) },
          })),
        );
        return;
      }
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          showToast('无法使用相机：请在系统设置中允许 OpenBear 使用相机');
          return;
        }
      }
      const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsMultipleSelection: source === 'library', quality: 0.9 };
      const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled) return;
      addAttachments(
        result.assets.map((a) => ({
          id: nextAttachmentId(),
          file: { uri: a.uri, name: a.fileName || baseName(a.uri), type: a.mimeType || 'image/jpeg', size: fileSize(a.uri, a.fileSize) },
        })),
      );
    } catch (error: any) {
      showToast(`选择失败：${String(error?.message || error)}`);
    }
  };
  const pasteImage = async () => {
    try {
      const image = await Clipboard.getImageAsync({ format: 'png' });
      if (!image?.data) {
        showToast('剪贴板里没有图片');
        return;
      }
      const mime = /^data:([^;,]+)/.exec(image.data)?.[1] || 'image/png';
      const name = pastedFileName(mime);
      const file = new File(Paths.cache, name);
      file.create({ overwrite: true });
      file.write(image.data.replace(/^data:[^,]*,/, ''), { encoding: 'base64' });
      addAttachments([{ id: nextAttachmentId(), file: { uri: file.uri, name, type: mime, size: fileSize(file.uri) } }]);
    } catch (error: any) {
      showToast(`粘贴失败：${String(error?.message || error)}`);
    }
  };
  const openMenu = (which: 'attach' | 'runcfg' | 'usage') => {
    tap('light');
    Keyboard.dismiss();
    setMenu(which);
    if (which === 'attach') void Clipboard.hasImageAsync().then(setClipboardImage).catch(() => setClipboardImage(false));
  };
  // 关闭面板后再拉起系统选择器（iOS 不能在 Modal 消失过程中再弹出另一个控制器）
  const afterMenu = (fn: () => void) => {
    setMenu('none');
    setTimeout(fn, Platform.OS === 'ios' ? 450 : 150);
  };
  const insertAt = () => {
    afterMenu(() => {
      const at = Math.min(selectionRef.current.start, displayText(segmentsRef.current).length);
      const before = displayText(segmentsRef.current).slice(0, at);
      const insert = before && !/\s$/.test(before) ? ' @' : '@';
      setSegments(spliceSegments(segmentsRef.current, at, at, [{ type: 'text', text: insert }]));
      const cursor = at + insert.length;
      setForcedSelection({ start: cursor, end: cursor });
      inputRef.current?.focus();
    });
  };
  const newTopic = () => {
    afterMenu(() => {
      const folderId = uuid ? session.conversations.find((c) => c.conversationUuid === uuid)?.folderId || '' : '';
      router.push({ pathname: '/conversation/new', params: folderId ? { folderId } : { temporary: '1' } });
    });
  };

  // ---- 布局 ----
  const idleGap = bottomInset <= 0 ? SIDE : Platform.OS === 'ios' ? Math.max(bottomInset - 8, SIDE) : bottomInset + KEYBOARD_GAP;
  const inset = Math.max(idleGap - KEYBOARD_GAP, 0);
  const { progress: kbProgress } = useReanimatedKeyboardAnimation();
  const rootStyle = useAnimatedStyle(() => ({ paddingBottom: KEYBOARD_GAP + inset * (1 - kbProgress.value) }), [inset]);
  const placeholder = newConversation ? '描述你要做的事，或 @ 引用记忆和文件' : running ? '补充说明，会在下一步生效' : '继续追问，或 @ 引用记忆和文件';
  const fadeTop = withAlpha(theme.bg, 0);
  const showStop = (running || uploading) && !hasText;
  const attachBlocked = running || sendPending ? '运行中暂不能添加附件，可以先停止或等当前轮完成' : '';
  const chipLabel = chip ? chip.model : modelLabel || '模型';

  return (
    <Animated.View style={[styles.root, rootStyle]} pointerEvents="box-none" testID="composer">
      <LinearGradient pointerEvents="none" colors={[fadeTop, theme.bg]} locations={[0, 0.3]} style={styles.fade} />
      <View style={styles.holder} pointerEvents="box-none">
        <View style={styles.column} pointerEvents="box-none">
          {showPanel && mention ? (
            <ReferencePanel
              ref={panelRef}
              theme={theme}
              query={mention.query}
              kind={mention.kind}
              currentConversation={uuid || ''}
              selectedRefs={uniqueRefs(segments)}
              onSelect={selectRefs}
              onClose={closePanel}
              maxHeight={Math.min(340, Math.round(screenHeight * 0.42))}
            />
          ) : null}
          <SteeringList theme={theme} items={steering} />
          <View style={[styles.card, { backgroundColor: theme.panel, borderColor: theme.border }, Platform.OS === 'android' ? styles.androidShadow : elevation(theme, 'pop')]} testID="composer-card">
            <PendingStrip
              theme={theme}
              refs={currentRefs}
              invalidKeys={invalidKeys}
              attachments={attachments}
              progress={progress}
              locked={locked}
              onOpenRef={(uid) => {
                Keyboard.dismiss();
                setInspectUid(uid);
              }}
              onRemoveRef={(uid) => setSegments(removeRef(segmentsRef.current, uid))}
              onOpenImage={(a) => setViewer(a)}
              onRemoveAttachment={(a) => {
                Keyboard.dismiss();
                setRemoveTarget(a);
              }}
            />
            <TextInput
              ref={inputRef}
              testID="composer-input"
              style={[styles.input, { color: theme.text }]}
              onChangeText={onChangeText}
              onSelectionChange={(e) => {
                const sel = e.nativeEvent.selection;
                // 受控光标：原生先报告旧位置时不清除，等到与目标一致（或用户移动到别处且文本已同步）再交还给系统
                if (forcedSelection && (sel.start !== forcedSelection.start || sel.end !== forcedSelection.end)) {
                  if (displayText(segmentsRef.current).length >= forcedSelection.start && Date.now() - forcedAt.current < 250) return;
                }
                selectionRef.current = sel;
                setSelection(sel);
                if (forcedSelection) setForcedSelection(undefined);
              }}
              selection={forcedSelection}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyPress={(e) => {
                if (e.nativeEvent.key === 'Enter') lastSoftEnter.current = Date.now();
              }}
              onSubmitEditing={() => enterRef.current()}
              placeholder={placeholder}
              placeholderTextColor={theme.muted}
              multiline
              submitBehavior={hardware ? 'submit' : 'newline'}
              textAlignVertical="top"
              scrollEnabled
              maxLength={100000}
              cursorColor={theme.textStrong}
              selectionColor={Platform.OS === 'ios' ? theme.textStrong : withAlpha(theme.dark ? '#f4f4f5' : '#18181b', 0.28)}
              selectionHandleColor={theme.textStrong}
              underlineColorAndroid="transparent"
              accessibilityLabel="消息输入框"
            >
              {segments.length ? (
                <Text>
                  {segments.map((seg, index) =>
                    seg.type === 'ref' ? (
                      <Text
                        key={seg.uid}
                        style={{
                          backgroundColor: invalidKeys.has(referenceKey(seg.ref)) ? theme.dangerSoft : theme.selected,
                          color: invalidKeys.has(referenceKey(seg.ref)) ? theme.danger : theme.textStrong,
                          fontWeight: '600',
                        }}
                      >
                        {refDisplay(seg.ref)}
                      </Text>
                    ) : (
                      <Text key={`t${index}`}>{seg.text}</Text>
                    ),
                  )}
                </Text>
              ) : null}
            </TextInput>
            {validationText || sizeWarnings.length ? (
              <Text numberOfLines={2} style={[styles.note, { color: validationText ? theme.danger : theme.warning }]} testID="reference-validation">
                {validationText || sizeWarnings.join('；')}
              </Text>
            ) : null}
            <StatusRow theme={theme} text={status.text} busy={status.busy} tone={status.tone} />
            <View style={styles.bar}>
              <Press onPress={() => openMenu('attach')} accessibilityRole="button" accessibilityLabel="添加附件、引用与更多" hitSlop={4} testID="composer-attach" style={styles.cbtn} android_ripple={{ color: theme.selected, borderless: true, radius: 20 }}>
                <Icon as={Plus} size={22} color={theme.subtle} />
              </Press>
              <Press
                onPress={() => openMenu('runcfg')}
                accessibilityRole="button"
                accessibilityLabel={`运行配置：${chipLabel}${chip?.thinking ? `，思考 ${chip.thinking}` : ''}${chip?.fast ? '，Fast 已开启' : ''}，${strategyLabel(chip?.strategy, true)}`}
                hitSlop={{ top: 6, bottom: 6 }}
                testID="composer-model"
                style={[styles.model, { backgroundColor: theme.hover }]}
              >
                <Icon as={Brain} size={14} color={theme.subtle} strokeWidth={2} />
                <Text numberOfLines={1} style={[styles.modelText, { color: theme.subtle }]}>
                  {chipLabel}
                  {chip?.thinking ? ` · ${chip.thinking}` : ''}
                </Text>
                {chip?.fast ? <Icon as={Zap} size={13} color={theme.subtle} strokeWidth={2} /> : null}
                {chip ? <Text style={[styles.strategy, { color: theme.muted }]}>{strategyLabel(chip.strategy, true)}</Text> : null}
                {savingAny ? <ActivityIndicator size="small" color={theme.muted} style={styles.mini} /> : <Icon as={ChevronDown} size={14} color={theme.subtle} strokeWidth={2} />}
              </Press>
              {meta ? (
                <Pressable onPress={() => openMenu('usage')} hitSlop={6} style={styles.ring} accessibilityRole="button" accessibilityLabel={`上下文：已用 ${usageView.usedLabel} / 压缩阈值 ${usageView.thresholdLabel}，${usageView.percentLabel}`} testID="composer-usage">
                  <UsageRing theme={theme} view={usageView} />
                  {usageView.percent !== null ? <Text style={[styles.ringText, { color: usageView.tone === 'normal' ? theme.muted : usageView.tone === 'danger' ? theme.danger : theme.warning }]}>{Math.round(usageView.percent)}%</Text> : null}
                </Pressable>
              ) : null}
              <View style={styles.flex} />
              {showStop ? (
                <Pressable
                  testID="composer-stop"
                  accessibilityRole="button"
                  accessibilityLabel={uploading ? '取消上传' : '停止生成'}
                  accessibilityHint="长按切换按钮形状"
                  onPress={requestStop}
                  onLongPress={toggleShape}
                  delayLongPress={550}
                  hitSlop={4}
                  style={({ pressed }) => [styles.send, round ? styles.round : styles.square, { backgroundColor: theme.button, opacity: pressed ? 0.55 : 1 }]}
                >
                  <View style={[styles.stopGlyph, { backgroundColor: theme.buttonText }]} />
                </Pressable>
              ) : (
                <Pressable
                  testID="composer-send"
                  accessibilityRole="button"
                  accessibilityLabel={running ? '插话' : '发送'}
                  accessibilityHint="长按切换按钮形状"
                  accessibilityState={{ disabled: !canSend }}
                  onPress={() => canSend && void send()}
                  onLongPress={toggleShape}
                  delayLongPress={550}
                  hitSlop={4}
                  style={({ pressed }) => [styles.send, round ? styles.round : styles.square, { backgroundColor: canSend ? theme.button : theme.surfaceSoft, opacity: pressed ? 0.7 : 1 }]}
                >
                  {sendPending ? <ActivityIndicator size="small" color={theme.muted} /> : <Icon as={ArrowUp} size={18} color={canSend ? theme.buttonText : theme.disabled} strokeWidth={2.2} />}
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </View>

      {/* + 菜单 */}
      <Sheet visible={menu === 'attach'} title="添加" onClose={() => setMenu('none')} testID="attach-panel">
        <SheetScroll>
          <MenuRow theme={theme} icon={ImageIcon} label="相册" detail={attachBlocked || '从相册选择图片（可多选）'} disabled={Boolean(attachBlocked)} onPress={() => afterMenu(() => void pick('library'))} testID="attach-library" />
          <MenuRow theme={theme} icon={Camera} label="拍照" detail={attachBlocked || '用相机拍一张'} disabled={Boolean(attachBlocked)} onPress={() => afterMenu(() => void pick('camera'))} testID="attach-camera" />
          <MenuRow theme={theme} icon={Paperclip} label="文件" detail={attachBlocked || '从文件中选择（可多选）'} disabled={Boolean(attachBlocked)} onPress={() => afterMenu(() => void pick('file'))} testID="attach-file" />
          {clipboardImage ? (
            <MenuRow theme={theme} icon={ClipboardPaste} label="粘贴图片" detail={attachBlocked || '把剪贴板里的图片作为附件'} disabled={Boolean(attachBlocked)} onPress={() => afterMenu(() => void pasteImage())} testID="attach-paste" />
          ) : null}
          <MenuRow theme={theme} icon={AtSign} label="引用" detail="记忆、文档、凭证、会话、推荐" onPress={insertAt} testID="attach-reference" />
          <View style={[styles.divider, { backgroundColor: theme.line }]} />
          <MenuRow theme={theme} icon={SquarePen} label="新话题" detail="在新会话里开始" onPress={newTopic} testID="composer-new-topic" />
          {store && isSummary ? (
            <MenuRow
              theme={theme}
              icon={Layers}
              label={compacting ? '正在压缩上下文…' : '立即压缩上下文'}
              detail={compactState.ok ? '用模型摘要压缩当前上下文' : compactState.reason}
              disabled={!compactState.ok || compacting}
              onPress={() => afterMenu(() => void compact())}
              testID="composer-compact"
            />
          ) : null}
          <MenuRow
            theme={theme}
            icon={Eraser}
            label="清空草稿"
            detail={running ? '运行中不能清空' : !hasText && !attachments.length ? '草稿是空的' : '移除输入的文字和待发送附件'}
            disabled={running || (!hasText && !attachments.length) || sendPending}
            onPress={() => setMenu('clear')}
            testID="composer-clear"
          />
        </SheetScroll>
      </Sheet>

      {/* 运行配置 */}
      <Sheet visible={menu === 'runcfg'} title="运行配置" subtitle={newConversation ? '新会话' : running ? '运行中修改：主模型下一轮生效，Agent 设置用于新 Agent' : undefined} onClose={() => setMenu('none')} full testID="runcfg-sheet">
        <SheetScroll>
          {newConversation && !newConversation.runConfig ? (
            <Text style={[styles.note, styles.sheetNote, { color: newConversation.defaultsError ? theme.danger : theme.muted }]}>{newConversation.defaultsError || '正在读取默认配置…'}</Text>
          ) : null}
          <RunConfigEditor
            value={editorValue}
            onChange={onEditorChange}
            running={running}
            saving={savingAny}
            tab={runTab}
            onTabChange={setRunTab}
            disabled={Boolean(newConversation && !newConversation.runConfig)}
            testID="runcfg-editor"
            footer={
              store && meta ? (
                <View style={styles.footer}>
                  {isSummary ? (
                    <Press
                      onPress={() => void compact()}
                      disabled={!compactState.ok || compacting}
                      style={[styles.compactBtn, { borderColor: theme.border, opacity: compactState.ok && !compacting ? 1 : 0.5 }]}
                      accessibilityRole="button"
                      testID="runcfg-compact"
                    >
                      {compacting ? <ActivityIndicator size="small" color={theme.text} /> : <Icon as={Layers} size={16} color={theme.text} />}
                      <Text style={[styles.compactText, { color: theme.text }]}>{compacting ? '正在压缩…' : '立即压缩'}</Text>
                      <Text numberOfLines={1} style={[styles.note, { color: theme.muted, flex: 1 }]}>{compactState.ok ? '' : compactState.reason}</Text>
                    </Press>
                  ) : null}
                  <Text style={[styles.note, { color: theme.muted }]} testID="runcfg-totals">
                    上下文 {usageView.usedLabel} / {usageView.thresholdLabel}（{usageView.percentLabel}） · 总 Tokens {totals.tokens}（{totals.cache}） · 花费 {totals.cost} · 耗时 {totals.duration}
                  </Text>
                </View>
              ) : null
            }
          />
        </SheetScroll>
      </Sheet>

      {/* 上下文用量与累计统计 */}
      <Sheet visible={menu === 'usage'} title="用量" onClose={() => setMenu('none')} testID="usage-sheet">
        <SheetScroll>
          <UsageDetails theme={theme} view={usageView} totals={totals} strategy={normalizeStrategy(meta?.contextStrategy) || 'sliding_window'} />
          {store && isSummary ? (
            <View style={styles.footer}>
              <Press onPress={() => void compact()} disabled={!compactState.ok || compacting} style={[styles.compactBtn, { borderColor: theme.border, opacity: compactState.ok && !compacting ? 1 : 0.5 }]} testID="usage-compact">
                {compacting ? <ActivityIndicator size="small" color={theme.text} /> : <Icon as={Layers} size={16} color={theme.text} />}
                <Text style={[styles.compactText, { color: theme.text }]}>{compacting ? '正在压缩…' : '立即压缩'}</Text>
                <Text numberOfLines={1} style={[styles.note, { color: theme.muted, flex: 1 }]}>{compactState.ok ? '' : compactState.reason}</Text>
              </Press>
            </View>
          ) : null}
        </SheetScroll>
      </Sheet>

      <ConfirmSheet visible={menu === 'stop'} title="确认停止当前任务" message={STOP_MESSAGE} confirmLabel="停止" onConfirm={() => void confirmStop()} onClose={() => setMenu('none')} />
      <ConfirmSheet
        visible={menu === 'clear'}
        title="清空草稿"
        message={`将移除输入的文字${attachments.length ? `和 ${attachments.length} 个待发送附件` : ''}。`}
        confirmLabel="清空"
        onConfirm={clearDraft}
        onClose={() => setMenu('none')}
      />
      <ConfirmSheet
        visible={Boolean(removeTarget)}
        title="移除附件"
        message={removeTarget ? `从这条消息里移除“${removeTarget.file.name}”？` : ''}
        confirmLabel="移除"
        onConfirm={() => {
          if (removeTarget) removeAttachment(removeTarget);
          setRemoveTarget(null);
        }}
        onClose={() => setRemoveTarget(null)}
      />
      <ReferenceInspector
        visible={Boolean(inspected)}
        reference={inspected?.ref || null}
        currentConversation={uuid || ''}
        editable
        onUpdate={(ref) => inspected && setSegments(replaceRef(segmentsRef.current, inspected.uid, ref))}
        onRemove={() => {
          if (inspected) setSegments(removeRef(segmentsRef.current, inspected.uid));
          setInspectUid('');
        }}
        onClose={() => setInspectUid('')}
      />
      {viewer ? <ImageViewer uri={viewer.file.uri} name={viewer.file.name} onClose={() => setViewer(null)} /> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: { marginTop: -COMPOSER_OVERLAP, zIndex: 20, overflow: 'visible' },
  holder: { paddingHorizontal: SIDE, alignItems: 'center' },
  column: { width: '100%', maxWidth: readingWidth },
  fade: { position: 'absolute', left: 0, right: 0, top: -28, bottom: 0 },
  card: { width: '100%', borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, paddingTop: 10, paddingRight: 10, paddingBottom: 8, paddingLeft: 16 },
  androidShadow: { elevation: 3, shadowColor: '#000' },
  input: {
    fontSize: 16,
    lineHeight: LINE,
    minHeight: LINE + INPUT_PAD_TOP + INPUT_PAD_BOTTOM,
    maxHeight: LINE * MAX_LINES + INPUT_PAD_TOP + INPUT_PAD_BOTTOM,
    paddingTop: INPUT_PAD_TOP,
    paddingBottom: INPUT_PAD_BOTTOM,
    paddingHorizontal: 0,
    marginRight: 6,
  },
  note: { fontSize: 12.5, lineHeight: 17 },
  sheetNote: { paddingHorizontal: 20, paddingBottom: 8 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: -8 },
  cbtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  model: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 10, borderRadius: 15, overflow: 'hidden', flexShrink: 1 },
  modelText: { fontSize: 13, flexShrink: 1 },
  strategy: { fontSize: 11.5 },
  mini: { transform: [{ scale: 0.6 }], width: 14, height: 14 },
  ring: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 34, paddingHorizontal: 4 },
  ringText: { fontSize: 11.5, fontVariant: ['tabular-nums'] },
  send: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  round: { borderRadius: 17 },
  square: { borderRadius: 9 },
  stopGlyph: { width: 11, height: 11, borderRadius: 2.5 },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 20, marginVertical: 4 },
  footer: { paddingHorizontal: 16, paddingTop: 14, gap: 8 },
  compactBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12 },
  compactText: { fontSize: 14.5, fontWeight: '500' },
});
