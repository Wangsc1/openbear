/**
 * 会话累计统计块（B4-04 / B4-06）：总 Tokens（输入/输出/缓存读/缓存写明细）、缓存命中率、总耗时、总花费、上下文用量。
 * 手机会话面板头部与平板右栏检查器共用。Web 在桌面靠悬停看明细，这里直接展开显示。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Theme } from '../ui/theme';
import type { StatsView } from './stats';
import { fmtTokens } from './stats';

export function ContextMeter({ theme, view }: { theme: Theme; view: StatsView }) {
  const pct = view.contextPercent === null ? 0 : Math.max(0, Math.min(100, view.contextPercent));
  const tone = view.contextPercent !== null && view.contextPercent >= 90 ? theme.warning : theme.textStrong;
  return (
    <View style={[styles.meter, { backgroundColor: theme.line }]} accessibilityLabel={`上下文用量 ${view.contextPercentText}`}>
      <View style={{ width: `${pct}%`, backgroundColor: tone, height: '100%', borderRadius: 3 }} />
    </View>
  );
}

export function StatsBlock({ theme, view, loaded, compact }: { theme: Theme; view: StatsView; loaded: boolean; compact?: boolean }) {
  const dash = (v: string) => (loaded ? v : '—');
  return (
    <View style={[styles.card, { backgroundColor: theme.dark ? theme.raised : theme.bg, borderColor: theme.line }]} testID="session-stats">
      <View style={styles.headRow}>
        <Text style={[styles.caption, { color: theme.muted }]}>会话统计</Text>
        <Text style={[styles.total, { color: theme.textStrong }]} testID="stats-total-tokens">
          {dash(view.totalTokensText)}
          <Text style={[styles.unit, { color: theme.muted }]}> Tokens</Text>
        </Text>
      </View>
      <View style={styles.grid}>
        <Metric theme={theme} label="输入" value={dash(fmtTokens(view.parts.input))} />
        <Metric theme={theme} label="输出" value={dash(fmtTokens(view.parts.output))} />
        <Metric theme={theme} label="缓存读" value={dash(fmtTokens(view.parts.cache))} hint={loaded ? `命中 ${view.cachePercentText}` : undefined} />
        <Metric theme={theme} label="缓存写" value={dash(fmtTokens(view.cacheWrite))} />
      </View>
      <View style={[styles.sep, { backgroundColor: theme.line }]} />
      <View style={styles.row}>
        <Metric theme={theme} label="总耗时" value={dash(view.durationText)} wide testID="stats-duration" />
        <Metric theme={theme} label="总花费" value={dash(view.costText)} wide testID="stats-cost" />
        {compact ? null : <Metric theme={theme} label="缓存命中" value={dash(view.cachePercentText)} wide />}
      </View>
      <View style={[styles.sep, { backgroundColor: theme.line }]} />
      <View style={styles.ctxRow}>
        <Text style={[styles.label, { color: theme.subtle }]}>上下文</Text>
        <Text numberOfLines={1} style={[styles.ctxValue, { color: theme.text }]} testID="stats-context">
          {loaded ? `${view.contextUsedText} / ${view.contextLimitText}` : '—'}
          {loaded && view.contextPercent !== null ? <Text style={{ color: theme.muted }}>{`（${view.contextPercentText}）`}</Text> : null}
        </Text>
      </View>
      <ContextMeter theme={theme} view={view} />
    </View>
  );
}

function Metric({ theme, label, value, hint, wide, testID }: { theme: Theme; label: string; value: string; hint?: string; wide?: boolean; testID?: string }) {
  return (
    <View style={wide ? styles.metricWide : styles.metric} testID={testID}>
      <Text style={[styles.label, { color: theme.subtle }]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.value, { color: theme.textStrong }]}>
        {value}
      </Text>
      {hint ? <Text style={[styles.hint, { color: theme.muted }]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
  headRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  caption: { fontSize: 12.5 },
  total: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  unit: { fontSize: 11.5, fontWeight: '400' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, rowGap: 8 },
  metric: { width: '25%', minWidth: 0, paddingRight: 6 },
  metricWide: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', gap: 10 },
  label: { fontSize: 12 },
  value: { fontSize: 15, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums'] },
  hint: { fontSize: 11.5, marginTop: 1 },
  sep: { height: StyleSheet.hairlineWidth, marginVertical: 10 },
  ctxRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  ctxValue: { flexShrink: 1, fontSize: 13.5, fontVariant: ['tabular-nums'] },
  meter: { height: 6, borderRadius: 3, marginTop: 8, overflow: 'hidden' },
});
