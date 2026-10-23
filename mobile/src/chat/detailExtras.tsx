/**
 * 详情面板（app/detail.tsx）的 b2 补充视图：
 * - 交互记录（B2-69）：web buildUserInteractionView 的只读视图——状态、原问题与说明、选中项（含当时推荐）、
 *   附言/拒绝原因、输入值、每题答案；敏感交互显示“[敏感内容已隐藏]”；
 * - AgentInfo 结果的实例信息（B2-25）：web agentInfoResultView；
 * - 上下文压缩记录（B2-26）：滑动窗口显示窗口变化；模型摘要显示事实与摘要正文，按需读取完整摘要
 *   （GET /compactions/{summaryId}），失败显示原因；
 * - 批量调用切换（B2-23）：Web toolBatchLabel 的标签，切换后参数/结果跟随；大小显示（fmtBytes）。
 */
import { Check, Layers } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { agentInstance$, contextCompactionView, fmtBytes, type Operation } from '../data/webLogic';
import { Press, tap } from '../ui/primitives';
import { fonts, type Theme } from '../ui/theme';
import { apiError, useChatApi } from './chatApi';
import { enrichedRenderer } from './markdown/EnrichedBody';

function Md({ theme, text, muted }: { theme: Theme; text: string; muted?: boolean }) {
  const Body = enrichedRenderer.Component;
  const t = muted ? { ...theme, text: theme.subtle } : theme;
  return <Body markdown={text} blockKind="paragraph" streaming={false} theme={t} selectable />;
}

function toneColor(theme: Theme, tone: string) {
  return tone === 'success' ? theme.success : tone === 'danger' ? theme.danger : tone === 'warning' || tone === 'waiting' ? theme.warning : tone === 'info' ? theme.blue : theme.subtle;
}

export function InteractionRecord({ theme, view }: { theme: Theme; view: any }) {
  if (!view) return null;
  const redacted = view.redactedText || '[敏感内容已隐藏]';
  return (
    <View style={{ gap: 12 }} testID="interaction-record">
      <View style={styles.row}>
        <Text style={[styles.badge, { color: toneColor(theme, view.statusTone), backgroundColor: theme.hover }]} testID="interaction-status">{view.statusLabel}</Text>
        <Text style={[styles.small, { color: theme.muted, flex: 1 }]}>{view.actionName}{view.sourceLabel ? ` · 来自${view.sourceLabel}` : ''}</Text>
      </View>
      <Text style={[styles.body, { color: theme.subtle }]}>{view.intro}</Text>
      {view.sensitive ? (
        <View style={[styles.box, { backgroundColor: theme.warningSoft }]}>
          <Text style={[styles.body, { color: theme.warning }]}>这是敏感交互：问题说明与答案不在历史中显示。</Text>
          <Text style={[styles.mono, { color: theme.text }]}>{redacted}</Text>
        </View>
      ) : null}
      {view.body ? <Md theme={theme} text={view.body} /> : null}
      {view.options?.length ? (
        <View style={{ gap: 6 }}>
          <Text style={[styles.label, { color: theme.muted }]}>选项</Text>
          {view.options.map((o: any) => (
            <View key={o.key || o.value} style={[styles.opt, { borderColor: o.selected ? theme.textStrong : theme.border }]}>
              <View style={[styles.radio, { borderColor: o.selected ? theme.textStrong : theme.border, borderWidth: o.selected ? 5 : 1.5 }]} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.body, { color: theme.text, fontWeight: o.selected ? '600' : '400' }]}>{o.label}</Text>
                {o.description ? <Text style={[styles.small, { color: theme.muted }]}>{o.description}</Text> : null}
              </View>
              {o.selected ? <Text style={[styles.small, { color: theme.textStrong, fontWeight: '600' }]}>已选</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
      {view.selectedDecisionLabel ? <Fact theme={theme} k="你的选择" v={view.selectedDecisionLabel} /> : null}
      {view.confirmText ? <Fact theme={theme} k={view.statusKey === 'rejected' ? '拒绝原因' : '附言'} v={view.confirmText} /> : null}
      {view.selectText ? <Fact theme={theme} k={view.answerMode === 'free_text' ? '你的答案' : '补充说明'} v={view.selectText} /> : null}
      {view.action === 'prompt' ? <Fact theme={theme} k="你的回答" v={view.sensitive ? redacted : view.promptValue || '（空）'} /> : null}
      {(view.questions || []).map((q: any) => (
        <View key={q.id} style={[styles.question, { borderColor: theme.line }]} testID="interaction-question">
          <Text style={[styles.label, { color: theme.textStrong }]}>{q.number}. {q.question} <Text style={[styles.small, { color: q.required ? theme.danger : theme.muted }]}>{q.required ? '必填' : '选填'}</Text></Text>
          {q.description ? <Md theme={theme} text={q.description} muted /> : null}
          {q.options.map((o: any) => (
            <View key={o.key || o.value} style={styles.row}>
              {o.selected ? <Check size={14} color={theme.success} /> : <View style={{ width: 14 }} />}
              <Text style={[styles.body, { color: o.selected ? theme.textStrong : theme.subtle, flex: 1, fontWeight: o.selected ? '600' : '400' }]}>{o.label}</Text>
              {o.recommended ? <Text style={[styles.badge, { color: theme.success, backgroundColor: theme.successSoft }]}>当时建议</Text> : null}
            </View>
          ))}
          {q.recommendationReason ? <Text style={[styles.small, { color: theme.subtle }]}>推荐理由：{q.recommendationReason}</Text> : null}
          {q.answerText ? <Fact theme={theme} k="回答" v={q.answerText} /> : !q.answered ? <Text style={[styles.small, { color: theme.muted }]}>未回答</Text> : null}
        </View>
      ))}
      {view.malformed ? <Text style={[styles.small, { color: theme.muted }]}>这条交互记录缺少原始参数，只能显示状态。</Text> : null}
    </View>
  );
}

export function AgentInfoView({ theme, toolName, resultText }: { theme: Theme; toolName: string; resultText: string }) {
  let info: any;
  try {
    info = agentInstance$.agentInfoResultView(toolName, resultText);
  } catch {
    info = null;
  }
  if (!info?.isAgentInfo || !info.hasData) return null;
  const s = info.session || {};
  return (
    <View style={{ gap: 8, marginBottom: 12 }} testID="agentinfo-view">
      <Text style={[styles.label, { color: theme.muted }]}>实例信息（只读）</Text>
      <View style={[styles.box, { backgroundColor: theme.surfaceSoft }]}>
        <Fact theme={theme} k="实例" v={info.instanceLabel} mono />
        <Fact theme={theme} k="状态" v={info.availabilityLabel} />
        {s.turnCount ? <Fact theme={theme} k="指派轮次" v={`${s.turnCount} 轮`} /> : null}
        {s.contextRevision ? <Fact theme={theme} k="上下文版本" v={`r${s.contextRevision}`} /> : null}
        {s.continuationBlocker ? <Fact theme={theme} k="续接限制" v={String(s.continuationBlocker)} /> : null}
      </View>
      {(info.tasks || []).map((t: any) => (
        <View key={t.taskUuid} style={[styles.question, { borderColor: theme.line }]}>
          <View style={styles.row}>
            <Text style={[styles.small, { color: theme.muted, flex: 1 }]}>{t.sessionTurn ? `第 ${t.sessionTurn} 次指派` : '单次记录'} · {agentInstance$.shortAgentId(t.taskUuid)}</Text>
            <Text style={[styles.badge, { color: toneColor(theme, t.statusView?.tone), backgroundColor: theme.hover }]}>{t.statusView?.label}</Text>
          </View>
          <Text style={[styles.body, { color: theme.textStrong }]} numberOfLines={3}>{t.title}</Text>
          <Text style={[styles.small, { color: theme.subtle }]}>上下文：{t.contextSource?.label || '—'} · 能力：{t.grantedTools?.length ? t.grantedTools.join(' · ') : '未记录'}</Text>
        </View>
      ))}
    </View>
  );
}

export function CompactionView({ theme, uuid, op }: { theme: Theme; uuid: string; op: Operation }) {
  const api = useChatApi();
  const payload = op.payload || {};
  const base = contextCompactionView({ ...payload, name: 'ContextCompaction' });
  const [full, setFull] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const summaryId = String(base.summaryId || '');
  const window = base.strategy === 'sliding_window';
  useEffect(() => {
    if (window || !summaryId || !api || base.output) return;
    let alive = true;
    setLoading(true);
    api
      .conversationCompaction(uuid, summaryId)
      .then((data: any) => alive && setFull(String(data?.compaction?.compactedOutput || data?.compactedOutput || data?.summary || '')))
      .catch((e: any) => alive && setError(apiError(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [api, uuid, summaryId, window, base.output]);
  const output = full || base.output || '';
  return (
    <View style={{ gap: 10 }} testID="compaction-view">
      <View style={styles.row}>
        <Layers size={16} color={base.failed ? theme.danger : theme.success} />
        <Text style={[styles.label, { color: base.failed ? theme.danger : theme.textStrong }]}>{base.message}</Text>
      </View>
      <View style={[styles.box, { backgroundColor: theme.surfaceSoft }]}>
        {(base.detailFacts || []).map((fact: string) => <Text key={fact} style={[styles.body, { color: theme.text }]}>{fact}</Text>)}
        {base.removedBatches != null ? <Text style={[styles.body, { color: theme.text }]}>移出批次 {base.removedBatches} · 保留批次 {base.retainedBatches}</Text> : null}
        {summaryId ? <Text selectable style={[styles.mono, { color: theme.muted }]}>{summaryId}</Text> : null}
      </View>
      {window ? null : (
        <>
          <Text style={[styles.label, { color: theme.muted }]}>{full ? '完整摘要' : base.previewLabel || '摘要'}</Text>
          {loading ? (
            <View style={styles.row}><ActivityIndicator size="small" color={theme.muted} /><Text style={[styles.small, { color: theme.muted }]}>正在读取完整压缩摘要…</Text></View>
          ) : error ? (
            <Text style={[styles.body, { color: theme.danger }]} testID="compaction-error">完整摘要读取失败：{error}</Text>
          ) : null}
          {output ? <Md theme={theme} text={output} /> : base.outputPreview ? <Md theme={theme} text={base.outputPreview} muted /> : !loading ? <Text style={[styles.body, { color: theme.muted }]}>{base.emptyOutputText}</Text> : null}
        </>
      )}
    </View>
  );
}

export function BatchTabs({ theme, labels, value, onChange }: { theme: Theme; labels: string[]; value: number; onChange(i: number): void }) {
  if (labels.length <= 1) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} testID="batch-tabs">
      {labels.map((label, i) => (
        <Press key={`${i}:${label}`} onPress={() => { tap('select'); onChange(i); }} style={[styles.tab, value === i ? { backgroundColor: theme.button } : { borderColor: theme.border, borderWidth: StyleSheet.hairlineWidth }]} accessibilityRole="tab" accessibilityState={{ selected: value === i }} testID={`batch-tab-${i}`}>
          <Text numberOfLines={1} style={[styles.small, { color: value === i ? theme.buttonText : theme.subtle, fontWeight: value === i ? '600' : '400' }]}>{i + 1} · {label}</Text>
        </Press>
      ))}
    </ScrollView>
  );
}

export function sizeLabel(text: string): string {
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(String(text || '')).length : String(text || '').length;
  return bytes ? fmtBytes(bytes) : '';
}

function Fact({ theme, k, v, mono }: { theme: Theme; k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.fact}>
      <Text style={[styles.factK, { color: theme.muted }]}>{k}</Text>
      <Text selectable style={[mono ? styles.mono : styles.body, { color: theme.text, flex: 1 }]}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { fontSize: 12, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, overflow: 'hidden' },
  body: { fontSize: 14, lineHeight: 21 },
  small: { fontSize: 12.5, lineHeight: 18 },
  label: { fontSize: 13, fontWeight: '600' },
  mono: { fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 19 },
  box: { borderRadius: 12, padding: 10, gap: 4 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  radio: { width: 18, height: 18, borderRadius: 9 },
  question: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10, gap: 6 },
  fact: { flexDirection: 'row', gap: 10, paddingVertical: 3 },
  factK: { width: 72, fontSize: 12.5, lineHeight: 20 },
  tabs: { gap: 6, paddingBottom: 10 },
  tab: { minHeight: 34, borderRadius: 17, paddingHorizontal: 12, justifyContent: 'center', maxWidth: 220 },
});
