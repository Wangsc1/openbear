/**
 * Agent 详情页（B2-37～B2-53）：独立全屏页面（原生 Stack），对应 Web AgentEventCard.vue 展开后的面板。
 * - 头部：名称、状态、副标题；“运行信息”可折叠：运行指标（模型/工具调用、Tokens、耗时、费用）、连续性条（实例、轮次、上一轮、上下文、本轮能力）；
 * - 重试工具条：Agent 模型调用失败等待重试时，“立即重试 / 取消 Agent 重试”（带 taskUuid）；
 * - 标签：执行进度 / 实例指派 / 过程记录 / 监控事件 / 启动信息 / 结果（显示与否、计数规则同 Web）；
 * - 数据：事件来自会话 store（实时帧更新）；plan / instance / events 接口按需读取，推送事件增量合并，缺口时 HTTP 补拉。
 */
import { router, useLocalSearchParams } from 'expo-router';
import { Bot, ChevronDown, ChevronLeft, ChevronUp, Copy, FileText, RefreshCw } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AgentPlan, EmptyState } from '../chat/agent/AgentPlan';
import { ActivityList } from '../chat/agent/AgentActivity';
import {
  activeAgentRetry,
  activityDisplayLines,
  activityEventLine,
  agentState,
  compactActivity,
  fallbackArguments,
  immediateSession,
  immediateTask,
  instanceLogic,
  monitorDisplayLines,
  outputSection,
  panelHead,
  planCapability,
  planLogic,
  pushedEventsAffectWorkspace,
  liveProgressLine,
  taskUuidOf,
  toneKey,
  type AgentTabId,
} from '../chat/agent/agentModel';
import { apiError, copyText, useChatApi } from '../chat/chatApi';
import { enrichedRenderer } from '../chat/markdown/EnrichedBody';
import { useConversationSnapshot, useSession } from '../data/session';
import { fmtCost, fmtNum } from '../data/webLogic';
import { showToast } from '../ui/Toast';
import { Chip, GlassBar, Icon, IconButton, NAV_ROW_HEIGHT, NavRow, Press, tap } from '../ui/primitives';
import { fonts, readingWidth, useTheme, type Theme } from '../ui/theme';

export default function AgentDetailPage() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ uuid: string; opId: string }>();
  const uuid = String(params.uuid || '');
  const opId = String(params.opId || '');
  const session = useSession();
  const store = useMemo(() => session.storeFor(uuid), [session.storeFor, uuid]); // eslint-disable-line react-hooks/exhaustive-deps
  const snapshot = useConversationSnapshot(store);
  const api = useChatApi();
  const event = useMemo(() => store?.eventFor(opId), [store, opId, snapshot?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const state = useMemo(() => agentState(event), [event]);
  const taskUuid = useMemo(() => taskUuidOf(event, state), [event, state]);
  const canLoad = Boolean(taskUuid && uuid && api);

  // ---- 计划 ----
  const [plan, setPlan] = useState<any>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState('');
  const loadPlan = useCallback(async () => {
    if (!canLoad) return;
    setPlanLoading(true);
    setPlanError('');
    try {
      const data = await api!.rathTaskPlan(uuid, taskUuid);
      if (data?.ok === false) throw new Error(data.error || '执行计划读取失败');
      setPlan(data);
    } catch (error) {
      setPlanError(apiError(error));
    } finally {
      setPlanLoading(false);
    }
  }, [api, canLoad, uuid, taskUuid]);

  // ---- 实例 ----
  const [instance, setInstance] = useState<any>(null);
  const [instanceLoading, setInstanceLoading] = useState(false);
  const [instanceError, setInstanceError] = useState('');
  const loadInstance = useCallback(async () => {
    if (!canLoad) return;
    const currentTask = immediateTask(event, state);
    const currentSession = immediateSession(event, state);
    setInstanceLoading(true);
    setInstanceError('');
    try {
      const data = await api!.rathAgentInstance(uuid, taskUuid);
      if (data?.ok === false) throw new Error(data.error || '实例指派读取失败');
      setInstance(instanceLogic.normalizeAgentInstanceEnvelope(data, { currentTask, currentSession }));
    } catch (error) {
      setInstance(instanceLogic.localAgentInstanceEnvelope({ currentTask, currentSession }));
      setInstanceError(apiError(error));
    } finally {
      setInstanceLoading(false);
    }
  }, [api, canLoad, uuid, taskUuid, event, state]);

  // ---- 事件（过程记录 / 监控） ----
  const [lines, setLines] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [evLoading, setEvLoading] = useState(false);
  const [evError, setEvError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [beforeSeq, setBeforeSeq] = useState(0);
  const [total, setTotal] = useState(0);
  const [monitorTotal, setMonitorTotal] = useState(0);
  const linesRef = useRef<any[]>([]);
  linesRef.current = lines;
  const busy = useRef(false);
  const loadEvents = useCallback(
    async (mode: { older?: boolean; newer?: boolean; limit?: number } = {}) => {
      if (!canLoad || busy.current) return;
      busy.current = true;
      setEvLoading(true);
      setEvError('');
      try {
        const latest = Math.max(0, ...linesRef.current.map((l) => Number(l.seq || 0)));
        const data = await api!.rathTaskEvents(uuid, taskUuid, {
          beforeSeq: mode.older ? beforeSeq : 0,
          afterSeq: mode.newer ? latest : 0,
          limit: mode.newer ? 100 : mode.limit || 20,
        });
        if (data?.ok === false) throw new Error(data.error || '过程记录读取失败');
        const incoming = (Array.isArray(data?.events) ? data.events : []).map((item: any, i: number) => activityEventLine(taskUuid, item, i));
        const existing = new Set(linesRef.current.map((l) => l.key));
        const novel = incoming.filter((l: any) => !existing.has(l.key));
        const next = mode.older ? [...novel, ...linesRef.current] : mode.newer ? [...linesRef.current, ...novel].sort((a, b) => a.seq - b.seq) : incoming;
        setLines(next);
        setLoaded(true);
        setTotal(Math.max(0, Number(data?.total || next.length)));
        if (data && Object.prototype.hasOwnProperty.call(data, 'monitorTotal')) setMonitorTotal(Math.max(0, Number(data.monitorTotal) || 0));
        if (!mode.newer) {
          setHasMore(Boolean(data?.hasMore));
          setBeforeSeq(Math.max(0, Number(data?.nextBeforeSeq || 0)));
        }
      } catch (error) {
        setEvError(apiError(error));
      } finally {
        busy.current = false;
        setEvLoading(false);
      }
    },
    [api, canLoad, uuid, taskUuid, beforeSeq],
  );

  const scrollRef = useRef<ScrollView>(null);
  const atTop = useRef(false);

  // ---- 标签 ----
  const planCap = useMemo(() => planCapability(event, taskUuid), [event, taskUuid]);
  const hasPlan = useMemo(() => Boolean(plan && planLogic.buildAgentPlanView(plan).hasPlan), [plan]);
  const showPlan = Boolean(canLoad && planCap && (!plan || hasPlan));
  const output = useMemo(() => outputSection(state), [state]);
  const fallbackArgs = useMemo(() => fallbackArguments(event, state), [event, state]);
  const launch = useMemo(() => planLogic.initialAgentLaunch(plan || {}, fallbackArgs), [plan, fallbackArgs]);
  const activityLines = useMemo(() => activityDisplayLines(loaded ? lines : state.recentLines || []), [loaded, lines, state]);
  const monitorLines = useMemo(() => monitorDisplayLines(loaded ? lines : state.recentLines || [], event, state, taskUuid), [loaded, lines, event, state, taskUuid]);
  const monitorCards = useMemo(() => planLogic.buildAgentMonitorTimeline(monitorLines, plan || {}), [monitorLines, plan]);
  const localInstance = useMemo(() => instanceLogic.localAgentInstanceEnvelope({ currentTask: immediateTask(event, state), currentSession: immediateSession(event, state) }), [event, state]);
  const visibleInstance = instance || localInstance;
  const assignmentCount = Math.max(Number(visibleInstance.total || 0), Number(visibleInstance.session?.turnCount || 0), visibleInstance.tasks.length);
  const instanceView = useMemo(() => {
    const loadedTask = instance?.tasks?.find((t: any) => t.taskUuid === taskUuid)?.raw || null;
    return instanceLogic.currentAgentInstanceView({ currentTask: loadedTask || immediateTask(event, state), currentSession: instance?.session || immediateSession(event, state) });
  }, [instance, taskUuid, event, state]);
  const head = panelHead(event, state, instanceView.statusView?.label);
  const tabs = useMemo(
    () =>
      [
        { id: 'plan' as AgentTabId, label: '执行进度', show: showPlan, count: 0 },
        { id: 'instance' as AgentTabId, label: '实例指派', show: Boolean(taskUuid), count: assignmentCount },
        { id: 'activity' as AgentTabId, label: '过程记录', show: true, count: canLoad ? total : activityLines.length },
        { id: 'monitor' as AgentTabId, label: '监控事件', show: true, count: canLoad ? Math.max(monitorTotal, monitorLines.length) : monitorLines.length },
        { id: 'launch' as AgentTabId, label: '启动信息', show: Boolean(canLoad || fallbackArgs) },
        { id: 'output' as AgentTabId, label: '结果', show: Boolean(output) },
      ].filter((t) => t.show),
    [showPlan, taskUuid, assignmentCount, canLoad, total, activityLines.length, monitorTotal, monitorLines.length, fallbackArgs, output],
  );
  const [tab, setTab] = useState<AgentTabId>('plan');
  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) setTab(tabs.some((t) => t.id === 'plan') ? 'plan' : 'activity');
  }, [tabs, tab]);

  // 打开：读计划（决定是否有执行进度）、事件计数与最近事件
  useEffect(() => {
    if (!canLoad) return;
    void loadPlan();
    void loadEvents({ limit: 100 });
  }, [canLoad, taskUuid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab === 'instance' && !instance && !instanceLoading) void loadInstance();
    // 过程记录 / 监控事件：打开时停在最新一条（向上滚动加载更早记录）
    if (tab === 'activity' || tab === 'monitor') {
      atTop.current = true;
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 250);
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // 实时：Agent operation 推送的新事件增量合并；影响计划的事件触发计划重读
  const push = useMemo(() => planLogic.agentTaskPushSnapshot(event, taskUuid), [event, taskUuid]);
  const lastPushSeq = useRef(0);
  useEffect(() => {
    if (!loaded || !push?.events?.length) return;
    const novel = push.events.filter((e: any) => Number(e?.seq || 0) > lastPushSeq.current);
    lastPushSeq.current = Math.max(lastPushSeq.current, Number(push.latestSeq || 0));
    if (!novel.length) return;
    const merged = planLogic.mergeAgentEventLines(linesRef.current, push.events.map((e: any, i: number) => activityEventLine(taskUuid, e, i)));
    if (merged.gap) void loadEvents({ newer: true });
    else if (merged.novel.length) {
      setLines(merged.lines);
      setTotal((t) => Math.max(t, merged.latestSeq, merged.lines.length));
    }
    if (pushedEventsAffectWorkspace(novel)) void loadPlan();
  }, [push, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 重试 ----
  const retry = activeAgentRetry(event, state);
  const [retryPending, setRetryPending] = useState('');
  const retryAction = async (kind: 'now' | 'cancel') => {
    if (!api || !retry) return;
    setRetryPending(kind);
    try {
      if (kind === 'now') await api.conversationRetryNow(uuid, retry.waitId, retry.taskUuid);
      else await api.conversationCancelRetry(uuid, retry.waitId, retry.taskUuid);
      showToast(kind === 'now' ? '已请求立即重试' : '已取消 Agent 重试');
    } catch (error) {
      showToast(apiError(error));
    } finally {
      setRetryPending('');
    }
  };

  const [metaOpen, setMetaOpen] = useState(width >= 768);
  const padH = width >= 768 ? Math.max(24, Math.round((width - readingWidth - 120) / 2)) : 18;
  const topInset = insets.top + NAV_ROW_HEIGHT;
  const tasks = useMemo(() => (state.rows || []).map((row: any) => row.task).filter(Boolean), [state]);
  const cost = tasks.reduce((n: number, t: any) => n + Number(t.costUsd || 0), 0);
  const duration = Number(state.rows?.[0]?.metrics?.duration || 0);
  const metrics = [
    ...(state.metricChips || []).map((c: any) => c.label),
    duration ? `耗时 ${Math.round(duration / 1000)}s` : '',
    cost ? `费用 ${fmtCost(cost)}` : '',
  ].filter(Boolean);
  const statusColor = { running: theme.blue, ok: theme.success, error: theme.danger, pending: theme.warning, stopped: theme.muted, partial: theme.warning }[head.cls] || theme.subtle;

  if (!event) {
    return (
      <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: topInset }]}>
        {snapshot?.loading ? <ActivityIndicator style={{ marginTop: 40 }} color={theme.muted} /> : <EmptyState theme={theme} icon={Bot} title="找不到这个 Agent 记录" text="它可能已被删除，或不在当前加载的时间线里。" />}
        <GlassBar theme={theme}><NavRow theme={theme} title="Agent" left={<IconButton icon={ChevronLeft} size={26} theme={theme} label="返回" onPress={() => router.back()} testID="back" />} /></GlassBar>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]} testID="agent-detail">
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ paddingTop: topInset + 8, paddingBottom: insets.bottom + 40, paddingHorizontal: padH, gap: 12 }}
        scrollEventThrottle={64}
        onScroll={(e) => {
          const top = e.nativeEvent.contentOffset.y <= 40;
          if (top && !atTop.current && (tab === 'activity' || tab === 'monitor') && hasMore && !evLoading) void loadEvents({ older: true });
          atTop.current = top;
        }}
      >
        <View style={styles.headRow}>
          <View style={[styles.orb, { backgroundColor: theme.violetSoft }]}><Icon as={Bot} size={20} color={theme.violet} /></View>
          <View style={styles.flex}>
            <Text style={[styles.title, { color: theme.textStrong }]} numberOfLines={2}>{head.title}</Text>
            <Text style={[styles.small, { color: statusColor, fontWeight: '600' }]} testID="agent-status">{head.statusLabel}</Text>
          </View>
        </View>
        <Text style={[styles.body, { color: theme.subtle }]} numberOfLines={metaOpen ? undefined : 2}>{head.subtitle}</Text>
        <Press onPress={() => setMetaOpen((v) => !v)} style={styles.metaToggle} accessibilityRole="button" accessibilityState={{ expanded: metaOpen }} testID="agent-meta-toggle">
          <Text style={[styles.small, { color: theme.subtle }]}>运行信息</Text>
          <Icon as={metaOpen ? ChevronUp : ChevronDown} size={15} color={theme.subtle} />
        </Press>
        {metaOpen ? (
          <View style={{ gap: 10 }}>
            {metrics.length ? (
              <View style={styles.wrapRow} testID="agent-metrics">
                {metrics.map((m) => <Text key={m} style={[styles.pill, { color: theme.subtle, backgroundColor: theme.hover }]}>{m}</Text>)}
              </View>
            ) : null}
            {taskUuid ? (
              <View style={[styles.strip, { backgroundColor: theme.surfaceSoft }]} testID="agent-continuity">
                <Fact theme={theme} k={instanceView.legacy ? '记录' : '实例'} v={instanceView.instanceLabel} mono />
                <Fact theme={theme} k="轮次" v={instanceView.turnLabel} />
                {!instanceView.legacy ? <Fact theme={theme} k="上一轮" v={instanceView.previousLabel} mono /> : null}
                {instanceView.task?.contextSource?.label ? <Fact theme={theme} k="上下文" v={instanceView.task.contextSource.label} /> : null}
                <Fact theme={theme} k="本轮能力" v={instanceView.task?.grantedTools?.length ? instanceView.task.grantedTools.join(' · ') : '未记录'} />
              </View>
            ) : null}
          </View>
        ) : null}
        {retry ? (
          <View style={[styles.retry, { backgroundColor: theme.warningSoft }]} testID="agent-retry">
            <Text style={[styles.body, { color: theme.text }]}>Agent 模型调用失败 · 等待重试 {retry.attempt}/{retry.maxRetries}</Text>
            <View style={styles.wrapRow}>
              <SmallBtn theme={theme} label={retryPending === 'now' ? '请求中…' : '立即重试'} disabled={Boolean(retryPending)} onPress={() => void retryAction('now')} primary testID="agent-retry-now" />
              <SmallBtn theme={theme} label={retryPending === 'cancel' ? '取消中…' : '取消 Agent 重试'} disabled={Boolean(retryPending)} onPress={() => void retryAction('cancel')} testID="agent-retry-cancel" />
            </View>
            <Text style={[styles.small, { color: theme.muted }]}>取消会结束这个子任务，主会话可能继续。</Text>
          </View>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} style={{ marginHorizontal: -padH }}>
          <View style={{ width: padH - 6 }} />
          {tabs.map((t) => (
            <Chip key={t.id} theme={theme} label={`${t.label}${t.count ? ` ${t.count}` : ''}`} selected={tab === t.id} onPress={() => setTab(t.id)} testID={`agent-tab-${t.id}`} />
          ))}
          <View style={{ width: padH - 6 }} />
        </ScrollView>

        {tab === 'plan' ? (
          <AgentPlan theme={theme} data={plan} loading={planLoading} error={planError} activityLines={activityLines} liveProgressLine={liveProgressLine(event, state)} activityLoading={evLoading} activityError={evError} onRefresh={() => { void loadPlan(); void loadEvents({ newer: loaded }); }} />
        ) : tab === 'instance' ? (
          <InstanceTab theme={theme} data={visibleInstance} count={assignmentCount} loading={instanceLoading} error={instanceError} onRetry={() => void loadInstance()} />
        ) : tab === 'activity' || tab === 'monitor' ? (
          <View style={{ gap: 10 }} testID={`agent-${tab}`}>
            <Intro theme={theme} title={tab === 'activity' ? '过程记录' : '监控事件'} text={tab === 'activity' ? '实时追加业务执行事件；向上滚动加载更早记录' : '任务启动、计划审查、步骤进展、主控干预与最终交付'}
              right={tab === 'activity' ? `已载入 ${loaded ? lines.length : activityLines.length} / ${total} 条事件` : `已载入 ${monitorLines.length} / ${Math.max(monitorTotal, monitorLines.length)} 条事件`} />
            {evLoading ? <ActivityIndicator color={theme.muted} /> : hasMore ? (
              <Press onPress={() => void loadEvents({ older: true })} style={[styles.more, { borderColor: theme.border }]} accessibilityRole="button" testID="agent-load-older">
                <Text style={[styles.small, { color: theme.text }]}>上拉或点击加载更早 20 条</Text>
              </Press>
            ) : loaded && lines.length ? <Text style={[styles.small, { color: theme.muted, textAlign: 'center' }]}>已到最早一条记录</Text> : null}
            {evError ? (
              <View style={styles.wrapRow}><Text style={[styles.small, { color: theme.danger, flex: 1 }]}>{evError}</Text><SmallBtn theme={theme} label="重试" onPress={() => void loadEvents({})} /></View>
            ) : null}
            {tab === 'activity' ? (
              <ActivityList theme={theme} lines={compactActivity(activityLines, { modelLabel: launch.model === '—' ? '' : launch.model, thinkLevel: launch.thinkLevel === '—' ? '' : launch.thinkLevel, fastMode: launch.fastMode, liveProgressLine: liveProgressLine(event, state) })} />
            ) : monitorCards.length ? (
              <View style={{ gap: 8 }}>
                {monitorCards.map((card: any) => <MonitorCard key={card.key} theme={theme} card={card} />)}
              </View>
            ) : !evLoading ? <Text style={[styles.small, { color: theme.muted, textAlign: 'center' }]}>暂无监控事件。</Text> : null}
          </View>
        ) : tab === 'launch' ? (
          <View style={{ gap: 10 }} testID="agent-launch">
            <Intro theme={theme} title="启动信息" text="这里始终显示创建 task 时的原始任务，不会被后续 AgentWait 覆盖" />
            <View style={[styles.strip, { backgroundColor: theme.surfaceSoft }]}>
              <Fact theme={theme} k="Agent" v={launch.agentName} />
              <Fact theme={theme} k="模型" v={launch.model} />
              <Fact theme={theme} k="思考" v={launch.thinkLevel} />
              <Fact theme={theme} k="Fast" v={launch.fastMode ? '开启' : '关闭'} />
              <Fact theme={theme} k="工具" v={launch.tools?.length ? launch.tools.join(' · ') : '未记录'} />
            </View>
            <Frame theme={theme} title="原始任务 Prompt" action="复制任务" icon={Copy} onAction={() => void copyText(launch.prompt, '原始任务')}>
              <Text selectable style={[styles.pre, { color: theme.text }]}>{launch.prompt || '未找到原始任务参数'}</Text>
            </Frame>
          </View>
        ) : tab === 'output' && output ? (
          <View style={{ gap: 10 }} testID="agent-output">
            <Intro theme={theme} title="Agent 结果" text="任务完成后交给主控汇总的最终输出" />
            {output.text ? (
              <Frame theme={theme} title="结论内容" note={output.segmented ? `${fmtNum(Number(output.originalChars || 0))} 字符 · 当前展示摘要和首段` : ''} action="复制结果" icon={FileText} onAction={() => void copyText(output.text, 'Agent 结果')}>
                <Md theme={theme} text={output.text} />
              </Frame>
            ) : <Text style={[styles.small, { color: theme.muted }]}>Agent 尚未生成最终结果。</Text>}
          </View>
        ) : null}
      </ScrollView>
      <GlassBar theme={theme}>
        <NavRow
          theme={theme}
          title={state.summary?.toolName === 'Agent' || !state.summary?.toolName ? 'Agent 详情' : `${state.summary.toolName} 详情`}
          subtitle={snapshot?.title || undefined}
          left={<IconButton icon={ChevronLeft} size={26} theme={theme} label="返回" onPress={() => router.back()} testID="back" />}
          right={<IconButton icon={RefreshCw} theme={theme} label="刷新" onPress={() => { tap(); void loadPlan(); void loadEvents({ newer: loaded }); if (tab === 'instance') void loadInstance(); }} testID="agent-refresh" />}
        />
      </GlassBar>
    </View>
  );
}

function InstanceTab({ theme, data, count, loading, error, onRetry }: { theme: Theme; data: any; count: number; loading: boolean; error: string; onRetry(): void }) {
  const s = data.session || {};
  return (
    <View style={{ gap: 10 }} testID="agent-instance">
      <Intro theme={theme} title={data.legacy ? '旧任务记录' : '实例指派记录'} text={data.legacy ? '旧数据只按当前任务展示，不推断同角色上下文连续' : '同一实例的每次指派独立保留状态、能力和上下文来源'} right={`${data.tasks.length} / ${count} 轮`} />
      {loading ? <View style={styles.wrapRow}><ActivityIndicator size="small" color={theme.muted} /><Text style={[styles.small, { color: theme.muted }]}>正在读取实例指派…</Text></View> : null}
      {error ? (
        <View style={[styles.retry, { backgroundColor: theme.warningSoft }]}>
          <Text style={[styles.small, { color: theme.text }]}>实例历史暂不可用，已保留当前任务的单次展示：{error}</Text>
          <SmallBtn theme={theme} label="重试" onPress={onRetry} testID="agent-instance-retry" />
        </View>
      ) : null}
      {s.agentId || data.legacy ? (
        <View style={[styles.strip, { backgroundColor: theme.surfaceSoft }]}>
          <Fact theme={theme} k={data.legacy ? '兼容方式' : '实例标识'} v={data.legacy ? 'legacy · 单任务' : s.agentId} mono />
          {!data.legacy ? <Fact theme={theme} k="实例状态" v={s.activeTaskUuid ? `当前任务 ${instanceLogic.shortAgentId(s.activeTaskUuid)}` : s.canContinue ? '空闲，可继续指派' : '空闲'} /> : null}
          {s.contextRevision ? <Fact theme={theme} k="上下文版本" v={`r${s.contextRevision}`} /> : null}
          {s.continuationBlocker ? <Fact theme={theme} k="续接限制" v={String(s.continuationBlocker)} /> : null}
        </View>
      ) : null}
      {data.tasks.map((a: any) => {
        const key = toneKey(a.statusView?.tone);
        const color = key === 'muted' ? theme.muted : theme[key];
        return (
          <View key={a.taskUuid} style={[styles.card, { borderColor: a.isCurrent ? theme.textStrong : theme.line, backgroundColor: theme.panel }]} testID="agent-assignment">
            <View style={styles.wrapRow}>
              <View style={styles.flex}>
                <Text style={[styles.small, { color: theme.muted }]}>{a.sessionTurn ? `第 ${a.sessionTurn} 次指派` : '单次记录'}{a.isCurrent ? ' · 当前' : ''}</Text>
                <Text style={[styles.label, { color: theme.textStrong }]} numberOfLines={3}>{a.title}</Text>
              </View>
              <Text style={[styles.pill, { color, backgroundColor: theme.hover }]}>{a.statusView?.label}</Text>
            </View>
            <View style={styles.strip}>
              <Fact theme={theme} k="任务" v={instanceLogic.shortAgentId(a.taskUuid)} mono />
              <Fact theme={theme} k="来源" v={a.continuedFromTaskUuid ? instanceLogic.shortAgentId(a.continuedFromTaskUuid) : '无'} mono />
              <Fact theme={theme} k="上下文" v={a.contextSource?.label || '—'} />
              {a.planMode ? <Fact theme={theme} k="模式" v={a.planMode} /> : null}
              <Fact theme={theme} k="本轮能力" v={a.grantedTools?.length ? a.grantedTools.join(' · ') : '未记录'} />
            </View>
          </View>
        );
      })}
      {!data.tasks.length && !loading ? <Text style={[styles.small, { color: theme.muted, textAlign: 'center' }]}>没有可展示的指派记录。</Text> : null}
    </View>
  );
}

function MonitorCard({ theme, card }: { theme: Theme; card: any }) {
  const key = toneKey(card.tone);
  const color = key === 'muted' ? theme.muted : theme[key];
  return (
    <View style={[styles.card, { borderColor: theme.line, backgroundColor: theme.panel }]} testID="monitor-card">
      <View style={styles.wrapRow}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={[styles.small, { color: theme.muted }]}>{card.timeLabel} · {card.category}</Text>
      </View>
      <Text style={[styles.label, { color: theme.textStrong }]}>{card.title}</Text>
      {card.description ? <Text selectable style={[styles.body, { color: theme.subtle }]}>{card.description}</Text> : null}
      {(card.bullets || []).map((b: string, i: number) => <Text key={i} style={[styles.small, { color: theme.text }]}>• {b}</Text>)}
      {card.badges?.length ? <View style={styles.wrapRow}>{card.badges.map((b: string) => <Text key={b} style={[styles.pill, { color: theme.subtle, backgroundColor: theme.hover }]}>{b}</Text>)}</View> : null}
    </View>
  );
}

function Intro({ theme, title, text, right }: { theme: Theme; title: string; text: string; right?: string }) {
  return (
    <View>
      <View style={[styles.wrapRow, { justifyContent: 'space-between' }]}>
        <Text style={[styles.label, { color: theme.textStrong }]}>{title}</Text>
        {right ? <Text style={[styles.small, { color: theme.muted }]}>{right}</Text> : null}
      </View>
      <Text style={[styles.small, { color: theme.muted }]}>{text}</Text>
    </View>
  );
}

function Fact({ theme, k, v, mono }: { theme: Theme; k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.fact}>
      <Text style={[styles.factK, { color: theme.muted }]}>{k}</Text>
      <Text selectable numberOfLines={3} style={[styles.factV, { color: theme.text }, mono && { fontFamily: fonts.mono, fontSize: 12.5 }]}>{v || '—'}</Text>
    </View>
  );
}

function Frame({ theme, title, note, action, icon, onAction, children }: { theme: Theme; title: string; note?: string; action: string; icon: any; onAction(): void; children: React.ReactNode }) {
  return (
    <View style={[styles.frame, { borderColor: theme.line }]}>
      <View style={[styles.frameHead, { borderBottomColor: theme.line }]}>
        <View style={styles.flex}>
          <Text style={[styles.label, { color: theme.textStrong }]}>{title}</Text>
          {note ? <Text style={[styles.small, { color: theme.muted }]}>{note}</Text> : null}
        </View>
        <Press onPress={onAction} style={[styles.frameBtn, { backgroundColor: theme.hover }]} accessibilityRole="button" testID="agent-copy">
          <Icon as={icon} size={14} color={theme.text} />
          <Text style={[styles.small, { color: theme.text, fontWeight: '600' }]}>{action}</Text>
        </Press>
      </View>
      <View style={{ padding: 12 }}>{children}</View>
    </View>
  );
}

function SmallBtn({ theme, label, onPress, disabled, primary, testID }: { theme: Theme; label: string; onPress(): void; disabled?: boolean; primary?: boolean; testID?: string }) {
  return (
    <Press onPress={onPress} disabled={disabled} style={[styles.smallBtn, { backgroundColor: primary ? theme.button : theme.hover, opacity: disabled ? 0.5 : 1 }]} accessibilityRole="button" testID={testID}>
      <Text style={[styles.small, { color: primary ? theme.buttonText : theme.text, fontWeight: '600' }]}>{label}</Text>
    </Press>
  );
}

function Md({ theme, text }: { theme: Theme; text: string }) {
  const Body = enrichedRenderer.Component;
  return <Body markdown={text} blockKind="paragraph" streaming={false} theme={theme} selectable />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  orb: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700', lineHeight: 25 },
  body: { fontSize: 14, lineHeight: 21 },
  small: { fontSize: 12.5, lineHeight: 18 },
  label: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  pre: { fontSize: 13, lineHeight: 20, fontFamily: fonts.mono },
  metaToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 36 },
  wrapRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  pill: { fontSize: 12, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  strip: { borderRadius: 12, padding: 10, gap: 6 },
  fact: { flexDirection: 'row', gap: 10 },
  factK: { width: 64, fontSize: 12.5, lineHeight: 19 },
  factV: { flex: 1, fontSize: 13, lineHeight: 19 },
  retry: { borderRadius: 12, padding: 10, gap: 8 },
  tabs: { gap: 6, alignItems: 'center', paddingVertical: 4 },
  more: { alignSelf: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10, gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  frame: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  frameHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  frameBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 36, borderRadius: 18, paddingHorizontal: 12 },
  smallBtn: { minHeight: 38, borderRadius: 19, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
});
