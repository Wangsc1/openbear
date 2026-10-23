/**
 * 会话概览（B1-54）：Web 是桌面悬停浮层，App 放在长按菜单的“会话概览”里，用底部面板展示。
 * 数据走全局 WS 的 conversation-overview 订阅（与 Web catalog.watchConversationOverview 相同的协议）：
 * 打开时发送 {type:'conversation-overview', conversationUuid, subscriptionId}，关闭时用空 uuid 取消；
 * WS 断开时标记“数据可能过期”，重连后自动重新订阅。
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../../data/session';
import { Pill } from '../primitives';
import { Sheet, SheetScroll } from '../Sheet';
import { type Theme, radius, useTheme } from '../theme';
import { isRunningRow, type Row } from '../../tree/treeModel';
import { fmtCost, fmtNum, fmtTokens, formatOverviewDuration, ledgerTokenParts, totalSessionDurationMs } from '../../tree/webTree';

let serial = 0;

export function useConversationOverview(uuid: string, active: boolean) {
  const session = useSession();
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState(false);
  const sub = useRef('');
  useEffect(() => {
    if (!active || !uuid) return undefined;
    const id = `app-${++serial}`;
    sub.current = id;
    setData(null);
    setError('');
    setFresh(false);
    const off = session.onGlobalEvent((packet: any) => {
      if (packet?.type !== 'conversation-overview' || packet.subscriptionId !== id || packet.conversationUuid !== uuid) return;
      if (packet.error) {
        setError(packet.error === 'not_found' ? '会话已删除或不可访问' : '统计暂时无法读取');
        setFresh(false);
        return;
      }
      setData(packet.overview || null);
      setError('');
      setFresh(true);
    });
    return () => {
      off();
      session.sendGlobal({ type: 'conversation-overview', conversationUuid: '', subscriptionId: id });
    };
  }, [uuid, active, session.onGlobalEvent]); // eslint-disable-line react-hooks/exhaustive-deps
  // 连上（含重连）后发送订阅
  useEffect(() => {
    if (!active || !uuid || !session.globalConnected) {
      setFresh(false);
      return;
    }
    session.sendGlobal({ type: 'conversation-overview', conversationUuid: uuid, subscriptionId: sub.current });
  }, [active, uuid, session.globalConnected]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, stale: !fresh || !session.globalConnected, connected: session.globalConnected };
}

function useClock(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function OverviewSheet({ row, visible, onClose }: { row: Row | null; visible: boolean; onClose(): void }) {
  const theme = useTheme();
  const uuid = String(row?.conversationUuid || '');
  const { data, error, stale, connected } = useConversationOverview(uuid, visible);
  const config = data?.configuration || null;
  const running = !error && Boolean(data?.running ?? isRunningRow(row));
  const now = useClock(visible && running && !stale);
  const tokens = data?.usage ? ledgerTokenParts(data.usage) : null;
  const duration = data
    ? totalSessionDurationMs({ timelineTotalDurationMs: data.duration?.timelineTotalDurationMs, modelCalls: [{ total_time_ms: data.duration?.modelCallsMs || 0 }], liveMs: data.duration?.liveMs || 0, ledgerUsage: data.usage || {} })
    : null;
  const thinking = !config || config.supportsThinking === null ? '—' : config.supportsThinking ? config.thinkingLevel || '—' : '不可调节';
  const fast = !config || config.supportsFast === null ? '—' : config.supportsFast ? (config.fastMode ? '开启' : '关闭') : '不支持';
  const state = error || (!connected ? '连接已断开' : data?.status || row?.currentStatus || (running ? '运行中' : '—'));
  const startedAt = Number(data?.startedAtMs || 0);
  return (
    <Sheet visible={visible} title={data?.title || row?.title || '会话概览'} subtitle={`${data?.path || row?.path || '临时会话'}${data?.archived || row?.archived ? ' · 已归档' : ''}`} onClose={onClose} testID="overview-sheet">
      <SheetScroll contentContainerStyle={styles.body}>
        {!data && !error ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.muted} />
            <Text style={{ color: theme.muted }}>{connected ? '正在读取统计…' : '实时连接已断开，连上后自动读取'}</Text>
          </View>
        ) : null}
        <View style={[styles.card, { backgroundColor: theme.surfaceSoft, borderColor: theme.line }]}>
          <Line theme={theme} label="会话模型" value={config?.modelName || config?.model || '—'} />
          <View style={styles.modes}>
            <Text style={[styles.small, { color: theme.muted }]}>
              思考强度 <Text style={{ color: theme.text }}>{thinking}</Text>
            </Text>
            <Text style={[styles.small, { color: theme.muted }]}>
              Fast <Text style={{ color: config?.fastMode ? theme.blue : theme.text }}>{fast}</Text>
            </Text>
          </View>
        </View>
        <View style={styles.state}>
          <Pill theme={theme} tone={error ? 'error' : running && connected ? 'run' : 'neutral'} dot label={String(state)} />
          {running ? <Text style={[styles.small, { color: theme.muted }]}>已运行 {startedAt > 0 && !stale ? formatOverviewDuration(Math.max(0, now - startedAt)) : '—'}</Text> : null}
          {stale && data ? <Text style={[styles.small, { color: theme.warning }]}>数据可能已过期</Text> : null}
        </View>
        <View style={[styles.section, { borderColor: theme.line }]}>
          <Big theme={theme} label="累计 Tokens" value={tokens ? fmtTokens(tokens.input + tokens.output) : '—'} />
          <View style={styles.grid}>
            <Line theme={theme} label="输入" value={tokens ? fmtTokens(tokens.input) : '—'} half />
            <Line theme={theme} label="输出" value={tokens ? fmtTokens(tokens.output) : '—'} half />
            <Line theme={theme} label="缓存读取" value={data?.usage ? fmtTokens(data.usage.cache_read_tokens) : '—'} half />
            <Line theme={theme} label="缓存写入" value={data?.usage ? fmtTokens(data.usage.cache_write_tokens) : '—'} half />
          </View>
        </View>
        <Line theme={theme} label="累计耗时" value={formatOverviewDuration(duration)} />
        <View style={[styles.counts, { borderColor: theme.line }]}>
          <Count theme={theme} label="消息条数" value={data ? fmtNum(data.messageCount) : '—'} />
          <Count theme={theme} label="模型调用" value={data ? fmtNum(data.calls?.model) : '—'} />
          <Count theme={theme} label="工具调用" value={data ? fmtNum(data.calls?.tool) : '—'} />
        </View>
        <Big theme={theme} label="总花费" value={data?.usage ? fmtCost(data.usage.cost_usd) : '—'} />
      </SheetScroll>
    </Sheet>
  );
}

function Line({ theme, label, value, half }: { theme: Theme; label: string; value: string; half?: boolean }) {
  return (
    <View style={[styles.line, half && { width: '47%' }]}>
      <Text style={[styles.small, { color: theme.muted }]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.value, { color: theme.text }]}>
        {value}
      </Text>
    </View>
  );
}
function Big({ theme, label, value }: { theme: Theme; label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text style={[styles.small, { color: theme.muted }]}>{label}</Text>
      <Text style={[styles.big, { color: theme.textStrong }]}>{value}</Text>
    </View>
  );
}
function Count({ theme, label, value }: { theme: Theme; label: string; value: string }) {
  return (
    <View style={styles.count}>
      <Text style={[styles.small, { color: theme.muted }]}>{label}</Text>
      <Text style={[styles.big, { color: theme.textStrong }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingBottom: 12, gap: 12 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  card: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6 },
  modes: { flexDirection: 'row', gap: 18, flexWrap: 'wrap' },
  state: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  section: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10, gap: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 4 },
  line: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  small: { fontSize: 13 },
  value: { fontSize: 14, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right' },
  big: { fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  counts: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 10 },
  count: { flex: 1, gap: 2 },
});
