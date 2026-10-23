/**
 * 对话页主体（单栏页面与平板双栏右栏共用）。
 * - 数据：ConversationStore（分页窗口/帧/投影），离开时释放；
 * - 导航栏：共享 GlassBar + NavRow（绝对定位，列表从栏下滑过；列表顶部留白 = 安全区 + 48）；
 *   副标题：模型名 · 思考强度；运行中换成蓝点 + “运行中 · m:ss”；有待回答的交互时为“等待你的回答”；
 * - 列表：ChatList（LegendList / FlashList 开关，滚动与翻页机制不在这里改）；
 * - 键盘：react-native-keyboard-controller 的 KeyboardAvoidingView（键盘帧同步）+ 列表 interactive 下滑收起；
 * - 详情：工具/思考/交互 -> 系统 Sheet（formSheet）；Agent -> 全屏详情页；产物 -> 全屏预览页；
 * - b2：待回答交互卡片栈（输入区正上方）、消息操作（长按）/多选隐藏/撤销条、搜索定位条、空会话欢迎页、
 *   引用胶囊详情、看大图、从此处重来、引用本轮、回复分享、模型重试控制；
 *   路由参数 focus（待处理交互 id，b1 传入）与 opId（跳到某条历史消息）；
 * - 性能打点：open -> 首屏列表 onLoad 的耗时写入 logcat（tag ReactNativeJS，前缀 [perf]），供验收脚本采集。
 */
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowDown, ChevronLeft, Copy, Ellipsis, FileDown, MessageCircle, PanelLeft, PanelRight, Share2 } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Share, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { shareTextFile } from '../artifacts/artifactStore';
import { ImageViewer } from '../artifacts/ImageViewer';
import type { ChatRow } from '../data/rows';
import { useConversationSnapshot, useSession } from '../data/session';
import { ConfirmSheet } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { showToast } from '../ui/Toast';
import { GlassBar, Icon, IconButton, NAV_ROW_HEIGHT, NavRow, Press, RunDot, tap } from '../ui/primitives';
import { elevation, readingWidth, useTheme, type Theme } from '../ui/theme';
import { referenceDisplayText, type Reference } from './cards/references';
import { ReferenceInspector } from './cards/MessageCards';
import { apiError, copyText, useChatApi } from './chatApi';
import { ChatList, type ChatListHandle } from './ChatList';
import { COMPOSER_OVERLAP, Composer } from './Composer';
import { type ConversationMenuItem, useConversationTools } from './conversationTools';
import { FrameSampler } from './FrameSampler';
import { PendingInteractions } from './interaction/PendingInteractions';
import { enrichedRenderer } from './markdown/EnrichedBody';
import { useReadingTools } from './readingTools';
import { ChatRowContext, type ChatRowContextValue } from './rowContext';
import type { RowActions } from './RowViews';
import { groupReadSteps } from './timeline';
import { withSelection } from './visibility';

type Props = {
  uuid: string;
  embedded?: boolean;
  onBack?: () => void;
  /** 平板中栏：导航栏左侧“切换侧栏”按钮（nav 工作包传入） */
  onToggleSidebar?: () => void;
  /** 平板中栏：导航栏右侧“切换检查器”按钮（nav 工作包传入） */
  onToggleInspector?: () => void;
};

/** 列表底部预留：输入区浮动卡片（sheet 工作包）覆盖在列表上，正文从它下面滑过。 */
const LIST_BOTTOM_RESERVE = 120;

/** 思考强度标签（与 Web toolCallPresentation 的思考强度文案一致）。 */
const THINK_LEVEL_LABEL: Record<string, string> = { off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };

/** 空会话快捷提示（与 Web ConsoleView.quickPrompts 相同）。 */
const QUICK_PROMPTS = ['帮我梳理一下当前项目的下一步优先级', '检查一下最近一轮工具调用和模型统计是否异常', '把这个问题拆成可执行的 TODO，并直接开始处理'];

/** “OpenAI/gpt-5.6-sol” -> “gpt-5.6-sol”（去掉厂商前缀）。 */
export function modelDisplayName(model: string) {
  const value = String(model || '').trim();
  const slash = value.lastIndexOf('/');
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 从尾部扫描当前轮：开始时间（用户消息）、最近的思考强度。 */
function tailInfo(rows: ChatRow[] | undefined) {
  let startMs = 0;
  let thinkLevel = '';
  if (!rows) return { startMs, thinkLevel };
  for (let i = rows.length - 1, seen = 0; i >= 0 && seen < 400; i -= 1, seen += 1) {
    const row = rows[i];
    if (!thinkLevel && row.type === 'answer' && row.footer?.thinkLevel) thinkLevel = row.footer.thinkLevel;
    if (row.type === 'user') {
      if (!startMs) startMs = row.createdAtMs;
      if (thinkLevel) break;
    }
  }
  return { startMs, thinkLevel };
}

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

function MoreMenu({ theme, visible, top, onClose, items }: { theme: Theme; visible: boolean; top: number; onClose(): void; items: ConversationMenuItem[] }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="关闭菜单" testID="more-menu-backdrop" />
      <View style={[styles.menu, { top, backgroundColor: theme.dark ? theme.raised : theme.panel, borderColor: theme.line }, elevation(theme, 'pop')]} testID="more-menu">
        {items.map((item, index) => (
          <Press
            key={item.key}
            testID={item.testID}
            accessibilityRole="menuitem"
            disabled={item.disabled}
            onPress={() => {
              tap('select');
              onClose();
              item.onPress?.();
            }}
            style={[styles.menuItem, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]}
            pressedStyle={{ backgroundColor: theme.hover }}
          >
            <Text numberOfLines={1} style={[styles.menuText, { color: item.destructive ? theme.danger : theme.text, opacity: item.disabled ? 0.45 : 1 }]}>{item.label}</Text>
            <Icon as={item.icon} size={18} color={item.destructive ? theme.danger : theme.subtle} />
          </Press>
        ))}
      </View>
    </Modal>
  );
}

export function ConversationView({ uuid, embedded = false, onBack, onToggleSidebar, onToggleInspector }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const session = useSession();
  const api = useChatApi();
  const params = useLocalSearchParams<{ focus?: string; opId?: string }>();
  // StrictMode/重新进入时 store 可能已被释放：在 effect 中重新获取，离开时释放（切换会话不累积内存）。
  const [store, setStore] = useState(() => session.storeFor(uuid));
  useEffect(() => {
    setStore(session.storeFor(uuid));
    return () => session.releaseStore(uuid);
  }, [uuid, session.storeFor, session.releaseStore]);
  const snapshot = useConversationSnapshot(store);
  const listRef = useRef<ChatListHandle>(null);
  const openedAt = useRef(Date.now());
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [layoutWidth, setLayoutWidth] = useState(embedded ? 0 : window.width);
  const [listHeight, setListHeight] = useState(0);
  const [trayHeight, setTrayHeight] = useState(0);
  const [followEnd, setFollowEnd] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [currentTurnKey, setCurrentTurnKey] = useState('');
  const [retryPending, setRetryPending] = useState<ChatRowContextValue['retryPending']>(null);
  const [deletingTurn, setDeletingTurn] = useState('');
  const [refTarget, setRefTarget] = useState<{ ref: Reference; token: string; bundleId: string } | null>(null);
  const [viewer, setViewer] = useState<{ urls: string[]; index: number } | null>(null);
  const [shareTurn, setShareTurn] = useState('');
  const [restart, setRestart] = useState<{ row: Extract<ChatRow, { type: 'user' }>; step: 1 | 2; preserve: boolean } | null>(null);
  const lastRowCount = useRef(0);
  const lastTailKey = useRef('');

  useEffect(() => {
    openedAt.current = Date.now();
    lastRowCount.current = 0;
    lastTailKey.current = '';
    console.log(`[perf] open conversation=${uuid} list=${session.listImpl}`);
  }, [uuid, session.listImpl]);

  // 首帧数据就绪
  useEffect(() => {
    if (snapshot && !snapshot.loading && snapshot.rows.length && lastRowCount.current === 0) {
      console.log(`[perf] data-ready conversation=${uuid} ms=${Date.now() - openedAt.current} ops=${snapshot.operationCount} rows=${snapshot.rows.length} projectionMs=${snapshot.lastProjectionMs}`);
    }
    if (snapshot) {
      // 只在末尾真正追加了新行时提示；展开中间的工作块也会增加行数，但末行不变。
      const tailKey = snapshot.rows[snapshot.rows.length - 1]?.key || '';
      if ((!atBottom || !followEnd) && snapshot.rows.length > lastRowCount.current && snapshot.prependedRows === 0 && lastRowCount.current > 0 && tailKey !== lastTailKey.current) setHasNew(true);
      lastRowCount.current = snapshot.rows.length;
      lastTailKey.current = tailKey;
    }
  }, [snapshot, uuid, atBottom, followEnd]);

  const baseUrl = session.http?.baseUrl || '';
  const headers = useMemo(() => (session.http ? session.http.headers() : {}), [session.http]);

  // ---- 展示层行：读取合并 / 多选 ----
  const groupedRows = useMemo(() => groupReadSteps(snapshot?.rows ?? [], expandedGroups), [snapshot?.rows, expandedGroups]);

  const reading = useReadingTools({
    uuid, store, snapshot: snapshot ?? null, listRef, rows: groupedRows, theme, followEnd, setFollowEnd, currentTurnKey, baseUrl, headers,
  });
  const rows = useMemo(
    () => withSelection(groupedRows, reading.selecting, reading.selected, (id) => Boolean(store?.canTargetVisibility(id))),
    [groupedRows, reading.selecting, reading.selected, store],
  );

  // ---- 行操作 ----
  const quoteTurn = useCallback((row: ChatRow) => {
    if (row.type !== 'user' || !row.turnUuid) return;
    const title = referenceDisplayText(row.text || '本轮问答').replace(/\s+/g, ' ').slice(0, 70);
    if (store.composer?.insertReference) {
      store.composer.insertReference({ kind: 'turn', conversationUuid: uuid, turnUuid: row.turnUuid, opId: row.opId, title });
      tap();
    } else showToast('输入框暂不支持插入引用（等待输入区接入）');
  }, [store, uuid]);

  const startRestart = useCallback((row: ChatRow) => {
    if (row.type !== 'user') return;
    if (store.snapshot.running) {
      showToast('请先停止当前运行并等待收尾，再删除历史轮次');
      return;
    }
    setRestart({ row, step: 1, preserve: false });
  }, [store]);

  const doRestart = useCallback(async (row: Extract<ChatRow, { type: 'user' }>, preserve: boolean) => {
    if (!api || !row.turnUuid) return;
    setRestart(null);
    setDeletingTurn(row.turnUuid);
    const user = store.turnUser(row.turnKey);
    const original = String(user?.content || row.text || '');
    const attachments = Array.isArray(user?.attachments) ? user.attachments : [];
    try {
      const result = await api.deleteConversationTurnSuffix(uuid, row.turnUuid);
      await store.reload();
      void session.refresh().catch(() => undefined);
      let restored = false;
      if (!preserve && original && store.composer?.setDraftText) restored = store.composer.setDraftText(original, { onlyIfEmpty: true });
      const n = Array.isArray(result?.deletedRootTurns) ? result.deletedRootTurns.length : 1;
      showToast(restored ? `已删除 ${n} 轮内容，原消息已放回输入框` : `已删除 ${n} 轮内容，可以从这里继续`);
      if (attachments.length) setTimeout(() => showToast('原消息包含附件，附件需要重新上传'), 1800);
      setTimeout(() => listRef.current?.scrollToEnd(false), 120);
    } catch (error) {
      showToast(apiError(error));
    } finally {
      setDeletingTurn('');
    }
  }, [api, store, uuid, session]);

  const retryAction = useCallback(async (retry: any, action: 'now' | 'cancel') => {
    if (!api || !retry?.waitId) return;
    setRetryPending({ waitId: retry.waitId, action });
    try {
      if (action === 'now') await api.conversationRetryNow(uuid, retry.waitId, retry.taskUuid || '');
      else await api.conversationCancelRetry(uuid, retry.waitId, retry.taskUuid || '');
    } catch (error) {
      showToast(apiError(error));
    } finally {
      setRetryPending(null);
    }
  }, [api, uuid]);

  const actions: RowActions = useMemo(
    () => ({
      toggleWork: (workKey) => store.toggleWork(workKey),
      openDetail: (opId, kind) => (kind === 'agent' ? router.push({ pathname: '/agent', params: { uuid, opId } }) : router.push({ pathname: '/detail', params: { uuid, opId, kind } })),
      openFullText: (messageId) => router.push({ pathname: '/fulltext', params: { uuid, messageId } }),
      answerText: (messageId: string) => store.answerText(messageId),
      operation: (opId: string) => store.operation(opId),
      turnMarkdown: (turnKey: string) => store.turnAnswerMarkdown(turnKey),
      openMessageMenu: reading.openMessageMenu,
      toggleSelect: reading.toggleSelect,
      inspectReference: (ref, token, bundleId) => setRefTarget({ ref, token, bundleId }),
      openImages: (urls, index) => setViewer({ urls, index }),
      openArtifact: (cid, aid, label) => router.push({ pathname: '/artifact', params: { uuid: cid, aid, label } }),
      quoteTurn,
      restartFrom: startRestart,
      copyUser: (row) => {
        if (row.type === 'user') void copyText(referenceDisplayText(row.text) === row.text ? row.text : row.text, '消息');
        else void copyText(store.turnAnswerMarkdown(row.turnKey) || ((row as any).markdown ?? ''), '本轮回复');
      },
      shareReply: (turnKey) => setShareTurn(turnKey),
      hideReply: reading.hideTurnReply,
      retryNow: (retry) => void retryAction(retry, 'now'),
      cancelRetry: (retry) => void retryAction(retry, 'cancel'),
      locateOp: (opId) => void reading.locate(opId),
      toggleGroup: (key) => setExpandedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    }),
    [store, uuid, reading.openMessageMenu, reading.toggleSelect, reading.hideTurnReply, reading.locate, quoteTurn, startRestart, retryAction],
  );

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const bottom = distance < 80;
    setAtBottom((prev) => (prev === bottom ? prev : bottom));
    if (bottom) setHasNew(false);
  }, []);

  const onStartReached = useCallback(() => {
    if (!store.snapshot.hasMoreBefore || store.snapshot.loadingEarlier) return;
    const t0 = Date.now();
    void store.loadEarlier().then((added) => console.log(`[perf] page-earlier conversation=${uuid} added=${added} ms=${Date.now() - t0}`));
  }, [store, uuid]);

  const onLoad = useCallback(
    (info: { elapsedTimeInMs: number }) => {
      console.log(`[perf] first-render conversation=${uuid} list=${session.listImpl} openToListLoadMs=${Date.now() - openedAt.current} listMs=${Math.round(info.elapsedTimeInMs)}`);
    },
    [uuid, session.listImpl],
  );

  const onViewable = useCallback((info: { viewableItems: Array<{ item: ChatRow }> }) => {
    const first = info.viewableItems?.find((v) => v?.item)?.item;
    if (first?.turnKey) setCurrentTurnKey((prev) => (prev === first.turnKey ? prev : first.turnKey));
  }, []);

  const onRootLayout = useCallback((event: LayoutChangeEvent) => {
    const w = Math.round(event.nativeEvent.layout.width);
    setLayoutWidth((prev) => (prev === w ? prev : w));
  }, []);

  // 路由参数：opId -> 定位到历史消息（数据就绪后执行一次）
  const handledOp = useRef('');
  const readingRef = useRef(reading);
  readingRef.current = reading;
  useEffect(() => {
    const opId = String(params.opId || '');
    if (!opId || handledOp.current === opId || !snapshot || snapshot.loading) return;
    handledOp.current = opId;
    console.log(`[b2] locate route opId=${opId}`);
    setTimeout(() => void readingRef.current.locate(opId).then((ok) => console.log(`[b2] locate result=${ok}`)), 400);
  }, [params.opId, snapshot?.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusId = String(params.focus || '').replace(/^(interaction|confirmation)[:/]/, '');
  const [focusHandled, setFocusHandled] = useState('');

  // 边距：手机 18；宽栏（平板中栏）正文限宽 readingWidth 并居中（列宽 680，内边距 24）。
  const contentWidth = layoutWidth || window.width;
  const padH = contentWidth >= 600 ? Math.max(24, Math.round((contentWidth - readingWidth) / 2) + 24) : 18;
  const topInset = (embedded ? 0 : insets.top) + NAV_ROW_HEIGHT;

  const header = snapshot?.hasMoreBefore ? (
    <View style={styles.loadingEarlier} testID="loading-earlier">
      {snapshot.loadingEarlier ? (
        <>
          <ActivityIndicator size="small" color={theme.muted} />
          <Text style={[styles.loadingText, { color: theme.muted }]}>正在加载更早内容…</Text>
        </>
      ) : null}
    </View>
  ) : null;

  // 导航栏副标题
  const running = Boolean(snapshot?.running);
  const pending = snapshot?.pendingConfirmations || [];
  const tail = useMemo(() => tailInfo(snapshot?.rows), [snapshot?.rows]);
  const now = useTicker(running);
  let subtitle = '';
  let subtitleColor: string | undefined;
  let accessory: React.ReactNode = null;
  if (running) {
    subtitle = tail.startMs && now > tail.startMs ? `运行中 · ${clock(now - tail.startMs)}` : '运行中';
    accessory = <RunDot theme={theme} />;
  } else if (pending.length) {
    subtitle = '等待你的回答';
    subtitleColor = theme.warning;
  } else {
    const model = modelDisplayName(snapshot?.model || '');
    const level = THINK_LEVEL_LABEL[tail.thinkLevel] || '';
    subtitle = [model, level].filter(Boolean).join(' · ');
  }

  const tools = useConversationTools({
    uuid,
    store,
    snapshot: snapshot ?? null,
    scrollToTop: () => listRef.current?.scrollToTop(false),
    listRef,
    readingItems: reading.items,
  });
  // 空闲时副标题显示所在目录（模型与思考强度已在输入区胶囊里）；没有目录信息时仍显示模型
  if (!running && !pending.length && tools.headerInfo?.path) subtitle = tools.headerInfo.path;
  // 会话面板（b4）未接管时的兜底下拉菜单：阅读工具在前，按 key 去重
  const menuItems = useMemo(() => [...reading.items, ...tools.items.filter((item) => !reading.items.some((r) => r.key === item.key))], [reading.items, tools.items]);
  const moreButton = <IconButton icon={Ellipsis} theme={theme} label="更多" onPress={tools.onMore ?? (() => setMenuOpen(true))} testID="more" />;

  const rowContext = useMemo<ChatRowContextValue>(
    () => ({ uuid, running, retryPending, baseUrl, headers, selecting: reading.selecting, deletingTurn }),
    [uuid, running, retryPending, baseUrl, headers, reading.selecting, deletingTurn],
  );
  const kind = session.active?.kind || 'controller';
  const welcome = !snapshot?.loading && !snapshot?.error && snapshot && !snapshot.rows.length && !snapshot.hasMoreBefore ? (
    <View style={[styles.welcome, { paddingTop: topInset + 40 }]} testID="welcome">
      <View style={[styles.welcomeMark, { backgroundColor: theme.surfaceSoft }]}><Icon as={MessageCircle} size={26} color={theme.subtle} /></View>
      <Text style={[styles.welcomeTitle, { color: theme.textStrong }]}>今天想让 OpenBear 做什么？</Text>
      <Text style={[styles.welcomeText, { color: theme.subtle }]}>
        {kind === 'controller' ? '手机上同样可以进行长对话、查看过程与产物；Telegram 继续保留熟悉的模型、思考、工具和本轮统计交互语义。' : '在这里开始对话，管理模型、工具与任务；聊天、记忆和文件属于此实例。'}
      </Text>
      <View style={styles.quick}>
        {QUICK_PROMPTS.map((prompt) => (
          <Press
            key={prompt}
            onPress={() => {
              tap();
              if (store.composer?.setDraftText) store.composer.setDraftText(prompt);
              else showToast('输入框暂不支持填入（等待输入区接入）');
            }}
            style={[styles.quickBtn, { borderColor: theme.border, backgroundColor: theme.panel }]}
            accessibilityRole="button"
            testID="quick-prompt"
          >
            <Text style={[styles.quickText, { color: theme.text }]}>{prompt}</Text>
          </Press>
        ))}
      </View>
    </View>
  ) : null;

  const bottomStack = COMPOSER_OVERLAP + 10 + (pending.length ? trayHeight + 6 : 0);
  const shareText = shareTurn && store ? store.turnAnswerMarkdown(shareTurn) : '';

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]} testID="conversation-view" onLayout={onRootLayout}>
      <KeyboardAvoidingView behavior="padding" style={styles.flex} keyboardVerticalOffset={0}>
        <View style={styles.flex} onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}>
          {snapshot?.loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.muted} />
              <Text style={[styles.loadingText, { color: theme.muted, marginTop: 10 }]}>正在读取会话…</Text>
            </View>
          ) : snapshot?.error && !snapshot.rows.length ? (
            <View style={styles.center}>
              <Text style={{ color: theme.danger, textAlign: 'center', paddingHorizontal: 24 }}>{snapshot.error}</Text>
              <Press onPress={() => void store.reload()} style={[styles.retryBtn, { backgroundColor: theme.button }]} accessibilityRole="button" testID="conversation-retry">
                <Text style={{ color: theme.buttonText, fontWeight: '600' }}>重试</Text>
              </Press>
            </View>
          ) : welcome ? (
            welcome
          ) : (
            <ChatRowContext.Provider value={rowContext}>
              <FrameSampler label={session.listImpl} />
              <ChatList
                key={`${uuid}:${session.listImpl}`}
                ref={listRef}
                impl={session.listImpl}
                rows={rows}
                theme={theme}
                renderer={enrichedRenderer}
                actions={actions}
                padH={padH}
                topInset={topInset}
                bottomInset={LIST_BOTTOM_RESERVE + (pending.length ? trayHeight : 0)}
                onStartReached={onStartReached}
                onScroll={onScroll}
                onLoad={onLoad}
                header={header}
                followEnd={followEnd && !reading.seek.active}
                onViewableItemsChanged={onViewable}
              />
            </ChatRowContext.Provider>
          )}
          {reading.seekBar ? <View style={[styles.seekWrap, { top: topInset + 8 }]} pointerEvents="box-none">{reading.seekBar}</View> : null}
          {pending.length ? (
            <PendingInteractions
              theme={theme}
              uuid={uuid}
              store={store}
              items={pending}
              bottom={COMPOSER_OVERLAP + 6}
              maxHeight={Math.max(220, Math.round((listHeight || window.height) * 0.58))}
              padH={padH}
              focusId={focusId && focusHandled !== focusId ? focusId : undefined}
              onFocusHandled={() => setFocusHandled(focusId)}
              onHeight={setTrayHeight}
            />
          ) : null}
          {reading.bar ? <View style={[styles.barWrap, { bottom: bottomStack }]} pointerEvents="box-none">{reading.bar}</View> : null}
          {hasNew && !atBottom ? (
            <Press
              onPress={() => {
                tap();
                listRef.current?.scrollToEnd(true);
                setHasNew(false);
              }}
              accessibilityRole="button"
              accessibilityLabel="有新内容，回到底部"
              style={[styles.newPill, { bottom: bottomStack + (reading.selecting ? 60 : 4), backgroundColor: theme.panel, borderColor: theme.border }, elevation(theme, 'pop')]}
              testID="new-content"
            >
              <Icon as={ArrowDown} size={14} color={theme.text} strokeWidth={2} />
              <Text style={[styles.newPillText, { color: theme.text }]}>新内容</Text>
            </Press>
          ) : !atBottom ? (
            <Press
              onPress={() => listRef.current?.scrollToEnd(false)}
              accessibilityRole="button"
              accessibilityLabel="回到底部"
              style={[styles.toBottom, { bottom: bottomStack + (reading.selecting ? 60 : 4), backgroundColor: theme.panel, borderColor: theme.border }, elevation(theme, 'pop')]}
              testID="jump-bottom"
            >
              <Icon as={ArrowDown} size={17} color={theme.subtle} strokeWidth={2} />
            </Press>
          ) : null}
        </View>
        <Composer
          theme={theme}
          disabled={snapshot?.socketState !== 'open'}
          running={Boolean(snapshot?.running)}
          bottomInset={embedded ? 10 : insets.bottom}
          padH={padH}
          uuid={uuid}
          store={store}
          onSend={(text) => store.send(text)}
          onStop={() => store.stop()}
          modelLabel={[modelDisplayName(snapshot?.model || ''), THINK_LEVEL_LABEL[tail.thinkLevel] || ''].filter(Boolean).join(' · ') || undefined}
        />
      </KeyboardAvoidingView>
      <GlassBar theme={theme} withInset={!embedded}>
        <NavRow
          theme={theme}
          title={tools.headerInfo?.title || snapshot?.title || '对话'}
          subtitle={subtitle || undefined}
          subtitleColor={subtitleColor}
          accessory={accessory}
          left={
            embedded ? (
              <IconButton icon={PanelLeft} theme={theme} label="切换侧栏" onPress={onToggleSidebar} testID="toggle-sidebar" />
            ) : (
              <IconButton icon={ChevronLeft} size={26} theme={theme} label="返回" onPress={onBack ?? (() => router.back())} testID="back" />
            )
          }
          right={
            embedded ? (
              <>
                <IconButton icon={PanelRight} theme={theme} label="切换检查器" onPress={onToggleInspector} testID="toggle-inspector" />
                {moreButton}
              </>
            ) : (
              moreButton
            )
          }
        />
      </GlassBar>
      <MoreMenu theme={theme} visible={menuOpen} top={topInset + 4} onClose={() => setMenuOpen(false)} items={menuItems} />
      {tools.panels}
      {reading.panels}
      <ReferenceInspector theme={theme} conversationUuid={uuid} target={refTarget} onClose={() => setRefTarget(null)} />
      <ImageViewer
        visible={Boolean(viewer)}
        images={(viewer?.urls || []).map((u) => ({ uri: u, headers: baseUrl && u.startsWith(baseUrl) ? headers : undefined }))}
        index={viewer?.index || 0}
        onClose={() => setViewer(null)}
      />
      <Sheet visible={Boolean(shareTurn)} onClose={() => setShareTurn('')} title="分享回复" subtitle={shareText ? `${shareText.length.toLocaleString()} 字符 · Markdown` : undefined} testID="share-sheet">
        <View style={styles.shareBody}>
          <ShareRow theme={theme} icon={Share2} label="分享 Markdown 文本" onPress={() => { const t = shareText; setShareTurn(''); void Share.share({ message: t }).catch(() => undefined); }} testID="share-text" />
          <ShareRow theme={theme} icon={FileDown} label="分享 .md 文件" detail="系统分享面板中可选择“存储到文件”" onPress={() => {
            const t = shareText;
            setShareTurn('');
            void shareTextFile(`${(snapshot?.title || 'reply').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}.md`, t).catch((e) => showToast(String(e?.message || e)));
          }} testID="share-file" />
          <ShareRow theme={theme} icon={Copy} label="复制 Markdown" onPress={() => { const t = shareText; setShareTurn(''); void copyText(t, 'Markdown'); }} testID="share-copy" />
        </View>
      </Sheet>
      <ConfirmSheet
        visible={restart?.step === 1}
        title="从此处重新开始？"
        confirmLabel="删除本轮及之后"
        message={(() => {
          if (!restart) return '';
          const affected = store.turnsFrom(restart.row.turnKey);
          const preview = referenceDisplayText(restart.row.text).replace(/\s+/g, ' ').trim().slice(0, 72);
          return `将永久删除这轮${affected > 1 ? `及后续 ${affected - 1} 轮` : ''}内容。相关回答、工具/Agent 过程、附件引用和覆盖删除点的模型摘要会一起移除，Agent 仅能从可靠的存活检查点续接，之后可从删除点之前继续对话。会话/实例便笺仍保留当前版本；这不会撤销已发生的文件修改、配置变更、发送或其他现实副作用。${preview ? `\n\n起点：${preview}${preview.length >= 72 ? '…' : ''}` : ''}`;
        })()}
        onConfirm={() => {
          if (!restart) return;
          // 探测输入框是否已有内容：onlyIfEmpty 写入空串不会改动任何内容，返回 false 即“已有内容”
          const bridge = store.composer;
          const hasDraft = bridge?.setDraftText ? !bridge.setDraftText('', { onlyIfEmpty: true }) : false;
          if (hasDraft) setRestart({ ...restart, step: 2, preserve: true });
          else void doRestart(restart.row, false);
        }}
        onClose={() => setRestart(null)}
      />
      <ConfirmSheet
        visible={restart?.step === 2}
        title="输入框已有内容"
        confirmLabel="保留现有内容并继续"
        message="当前输入框已有内容。继续删除会保留现有输入内容，不会把被删除的原消息覆盖到输入框。是否继续？"
        onConfirm={() => restart && void doRestart(restart.row, true)}
        onClose={() => setRestart(null)}
      />
    </View>
  );
}

function ShareRow({ theme, icon, label, detail, onPress, testID }: { theme: Theme; icon: any; label: string; detail?: string; onPress(): void; testID?: string }) {
  return (
    <Press onPress={() => { tap('select'); onPress(); }} style={styles.shareRow} pressedStyle={{ backgroundColor: theme.hover }} accessibilityRole="button" testID={testID}>
      <Icon as={icon} size={19} color={theme.subtle} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15.5, color: theme.text }}>{label}</Text>
        {detail ? <Text style={{ fontSize: 12.5, color: theme.muted }}>{detail}</Text> : null}
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingEarlier: { height: 36, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  loadingText: { fontSize: 12.5 },
  retryBtn: { height: 40, paddingHorizontal: 22, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  newPill: {
    position: 'absolute', alignSelf: 'center', height: 34, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 12, paddingRight: 14, flexDirection: 'row', alignItems: 'center', gap: 6, overflow: 'hidden',
  },
  newPillText: { fontSize: 13, fontWeight: '600' },
  toBottom: {
    position: 'absolute', alignSelf: 'center', width: 36, height: 36, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  menu: { position: 'absolute', right: 10, width: 230, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  menuItem: { height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 16 },
  menuText: { fontSize: 15, flex: 1 },
  seekWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 30 },
  barWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 30 },
  welcome: { flex: 1, alignItems: 'center', paddingHorizontal: 28, gap: 10 },
  welcomeMark: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  welcomeTitle: { fontSize: 21, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  welcomeText: { fontSize: 14, lineHeight: 21, textAlign: 'center', maxWidth: 480 },
  quick: { alignSelf: 'stretch', gap: 8, marginTop: 14, maxWidth: 560, width: '100%', alignItems: 'stretch' },
  quickBtn: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, minHeight: 48 },
  quickText: { fontSize: 14.5, lineHeight: 20 },
  shareBody: { paddingHorizontal: 12, paddingBottom: 8 },
  shareRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 54, paddingHorizontal: 10, borderRadius: 12 },
});
