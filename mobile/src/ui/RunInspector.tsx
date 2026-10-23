/**
 * 平板右栏“本次运行”检查器（方向稿 ⑦ 右栏，宽 280）——会话面板（B4）的平板形态：
 *  - 运行状态与本次运行计时；所在目录；
 *  - 上下文用量（已用 / 触发阈值，进度条）；Tokens（输入/输出/缓存读写、命中率）；总耗时、总花费；操作数、轮次；
 *  - 会话入口：会话属性、更新系统提示词、任务记忆（条数）、编辑上下文（运行中禁用）、产物、跳到会话开头。
 * 数据与中栏 ConversationView 共用 session.storeFor(uuid) 的同一个 store（/state 的累计统计 + WS 帧增量），
 * 由 ConversationView 负责释放。
 */
import { Bookmark, ChevronRight, FilePenLine, FolderOpen, Package, ScrollText, SlidersHorizontal } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useConversationSnapshot, useSession } from '../data/session';
import { useFolderPath, useSessionStats, useTaskMemoryCount } from '../panel/hooks';
import { runStartedAtMs } from '../panel/runInfo';
import { ContextMeter } from '../panel/StatsBlock';
import { clockText, fmtTokens, statsView } from '../panel/stats';
import { usePanelActions } from '../panel/usePanelActions';
import { Icon, Pill, Press } from './primitives';
import { type Theme, useTheme } from './theme';
import { useNow } from './conversations/useConversationList';

export const INSPECTOR_WIDTH = 280;

export function RunInspector({ uuid, topInset, bottomInset }: { uuid: string; topInset: number; bottomInset: number }) {
  const theme = useTheme();
  const session = useSession();
  const [store, setStore] = useState(() => (uuid ? session.storeFor(uuid) : undefined));
  useEffect(() => {
    setStore(uuid ? session.storeFor(uuid) : undefined);
  }, [uuid, session.storeFor]);
  const snapshot = useConversationSnapshot(store);
  const summary = session.conversations.find((c) => c.conversationUuid === uuid);
  const running = Boolean(snapshot?.running ?? summary?.running);
  const now = useNow(running ? 1000 : 30000);
  const started = useMemo(() => runStartedAtMs(snapshot?.rows, Number(summary?.activeStartedAtMs || 0)), [snapshot?.rows, summary?.activeStartedAtMs]);
  const stats = useSessionStats(store);
  const view = useMemo(() => statsView(stats), [stats]);
  const path = useFolderPath(summary ? summary.folderId : store?.stateMeta?.conversation?.folderId);
  const actions = usePanelActions(uuid, { running });
  const memory = useTaskMemoryCount(uuid, !actions.draft);
  const loaded = stats.loaded;
  const ready = Boolean(snapshot && !snapshot.loading);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg, borderLeftColor: theme.line, paddingTop: topInset }]} testID="run-inspector">
      <ScrollView contentContainerStyle={{ paddingBottom: bottomInset + 16 }} showsVerticalScrollIndicator={false}>
        <View style={styles.head}>
          <Text style={[styles.h, { color: theme.textStrong }]}>本次运行</Text>
          {running ? (
            <Pill theme={theme} tone="run" dot label={started && now > started ? `运行中 · ${clockText(now - started)}` : snapshot?.statusLabel || '运行中'} />
          ) : (
            <Text style={[styles.hint, { color: theme.muted }]}>空闲</Text>
          )}
        </View>
        {path ? (
          <View style={styles.pathRow}>
            <Icon as={FolderOpen} size={14} strokeWidth={1.8} color={theme.muted} />
            <Text numberOfLines={2} style={[styles.path, { color: theme.subtle }]} testID="inspector-path">{path}</Text>
          </View>
        ) : null}

        <Card theme={theme}>
          <Text style={[styles.l, { color: theme.muted }]}>上下文</Text>
          <Text style={[styles.v, { color: theme.textStrong }]} testID="inspector-context">
            {loaded ? view.contextUsedText : '—'}
            <Text style={[styles.vSmall, { color: theme.muted }]}>{` / ${loaded ? view.contextLimitText : '—'}`}</Text>
            {loaded && view.contextPercent !== null ? <Text style={[styles.vSmall, { color: theme.muted }]}>{`  ${view.contextPercentText}`}</Text> : null}
          </Text>
          <ContextMeter theme={theme} view={view} />
        </Card>
        <Card theme={theme} row>
          <View style={styles.flex}>
            <Text style={[styles.l, { color: theme.muted }]}>总耗时</Text>
            <Text style={[styles.v, { color: theme.textStrong }]} testID="inspector-duration">{loaded ? view.durationText : '—'}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={[styles.l, { color: theme.muted }]}>总花费</Text>
            <Text style={[styles.v, { color: theme.textStrong }]} testID="inspector-cost">{loaded ? view.costText : '—'}</Text>
          </View>
        </Card>
        <Card theme={theme}>
          <View style={styles.tokensHead}>
            <Text style={[styles.l, { color: theme.muted }]}>Tokens</Text>
            <Text style={[styles.vMid, { color: theme.textStrong }]} testID="inspector-tokens">{loaded ? view.totalTokensText : '—'}</Text>
          </View>
          <TokenLine theme={theme} label="输入" value={loaded ? fmtTokens(view.parts.input) : '—'} />
          <TokenLine theme={theme} label="输出" value={loaded ? fmtTokens(view.parts.output) : '—'} />
          <TokenLine theme={theme} label="缓存读" value={loaded ? `${fmtTokens(view.parts.cache)}（${view.cachePercentText}）` : '—'} />
          <TokenLine theme={theme} label="缓存写" value={loaded ? fmtTokens(view.cacheWrite) : '—'} />
        </Card>
        <Card theme={theme} row>
          <View style={styles.flex}>
            <Text style={[styles.l, { color: theme.muted }]}>操作</Text>
            <Text style={[styles.v, { color: theme.textStrong }]}>{ready ? snapshot!.operationCount : '—'}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={[styles.l, { color: theme.muted }]}>轮次</Text>
            <Text style={[styles.v, { color: theme.textStrong }]}>{ready ? snapshot!.turnCount : '—'}</Text>
          </View>
        </Card>

        <View style={[styles.head, { paddingTop: 14 }]}>
          <Text style={[styles.h, { color: theme.textStrong }]}>会话</Text>
        </View>
        <InsRow theme={theme} icon={SlidersHorizontal} label="会话属性" disabled={actions.draft} onPress={() => actions.openSheet('properties')} testID="inspector-properties" />
        <InsRow theme={theme} icon={ScrollText} label="更新系统提示词" disabled={actions.draft} onPress={() => actions.openSheet('systemPrompt')} testID="inspector-system-prompt" />
        <InsRow theme={theme} icon={Bookmark} label="任务记忆" count={actions.draft ? undefined : memory.count === null ? '…' : String(memory.count)} highlight={Boolean(memory.count)} disabled={actions.draft} onPress={() => actions.openTaskMemory()} testID="inspector-task-memory" />
        <InsRow theme={theme} icon={FilePenLine} label="编辑上下文" count={running ? '运行中不可编辑' : undefined} disabled={actions.draft || running} onPress={() => actions.openContextEditor()} testID="inspector-context-editor" />
        <InsRow theme={theme} icon={Package} label="产物" disabled={actions.draft} onPress={() => actions.openSheet('artifacts')} testID="inspector-artifacts" />
      </ScrollView>
      {actions.panels}
    </View>
  );
}

function Card({ theme, children, row }: { theme: Theme; children: React.ReactNode; row?: boolean }) {
  return <View style={[styles.card, row && styles.cardRow, { backgroundColor: theme.panel, borderColor: theme.line }]}>{children}</View>;
}

function TokenLine({ theme, label, value }: { theme: Theme; label: string; value: string }) {
  return (
    <View style={styles.tokenLine}>
      <Text style={[styles.tokenLabel, { color: theme.subtle }]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.tokenValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

function InsRow({ theme, icon, label, count, highlight, disabled, onPress, testID }: { theme: Theme; icon: LucideIcon; label: string; count?: string; highlight?: boolean; disabled?: boolean; onPress(): void; testID?: string }) {
  return (
    <Press
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={[styles.row, disabled && { opacity: 0.45 }]}
      pressedStyle={{ backgroundColor: theme.hover }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      testID={testID}
    >
      <Icon as={icon} size={17} strokeWidth={1.8} color={highlight ? theme.textStrong : theme.subtle} />
      <Text style={[styles.rowLabel, { color: theme.text }]}>{label}</Text>
      {count ? <Text numberOfLines={1} style={[styles.rowCount, { color: highlight ? theme.textStrong : theme.muted }]}>{count}</Text> : null}
      <Icon as={ChevronRight} size={15} strokeWidth={1.8} color={theme.disabled} />
    </Press>
  );
}

const styles = StyleSheet.create({
  root: { width: INSPECTOR_WIDTH, borderLeftWidth: StyleSheet.hairlineWidth },
  flex: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10, minHeight: 48 },
  h: { fontSize: 13, fontWeight: '700' },
  hint: { fontSize: 12 },
  pathRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, marginTop: -4, marginBottom: 10 },
  path: { flex: 1, fontSize: 12.5 },
  card: { marginHorizontal: 14, marginBottom: 10, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
  cardRow: { flexDirection: 'row', gap: 16 },
  l: { fontSize: 12 },
  v: { fontSize: 20, fontWeight: '700', marginTop: 3, fontVariant: ['tabular-nums'], letterSpacing: -0.2 },
  vMid: { fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  vSmall: { fontSize: 12, fontWeight: '500' },
  tokensHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 },
  tokenLine: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, paddingVertical: 2 },
  tokenLabel: { fontSize: 12.5 },
  tokenValue: { fontSize: 12.5, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, minHeight: 44 },
  rowLabel: { flex: 1, fontSize: 13.5 },
  rowCount: { fontSize: 12.5, maxWidth: 110 },
});
