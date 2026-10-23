/**
 * Agent 详情 · 执行进度（B2-46～B2-53），对应 Web AgentPlanWorkspace.vue。
 * 手机是单列：概览（阶段、完成步数、刷新、进度条）→ 提示条 → 步骤列表 → 版本切换 → 选中步骤详情
 * （目标、执行方法展开、最近 5 条步骤过程、结果、阻塞、完成条件与验收依据、时间）→ 完成检查 → 最近一次计划确认 → 最终交付。
 * 平板宽度时步骤列表与步骤详情并排。tooltip 在触屏上用“依据详情”展开代替。
 */
import { AlertTriangle, Check, ChevronDown, ChevronRight, Clock, Loader, RefreshCw } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { OptionSheet } from '../../ui/Form';
import { Icon, Press, tap } from '../../ui/primitives';
import type { Theme } from '../../ui/theme';
import { ActivityList } from './AgentActivity';
import { compactActivity, planLogic, relevantStepId, toneKey } from './agentModel';

function fmtTime(value: unknown): string {
  const n = Number(value || 0);
  if (!n) return '—';
  const d = new Date(n * (n < 10_000_000_000 ? 1000 : 1));
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function AgentPlan({ theme, data, loading, error, activityLines, liveProgressLine, activityLoading, activityError, onRefresh }: {
  theme: Theme; data: any; loading: boolean; error: string; activityLines: any[]; liveProgressLine?: any; activityLoading: boolean; activityError: string; onRefresh(): void;
}) {
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  const [version, setVersion] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [stepId, setStepId] = useState('');
  const [versionOpen, setVersionOpen] = useState(false);
  const [methodOpen, setMethodOpen] = useState(false);

  useEffect(() => {
    const preferred = planLogic.preferredAgentPlanVersion(data || {});
    const versions = new Set((data?.versions || []).map((v: any) => Number(v?.version || 0)).filter(Boolean));
    if (!pinned || !versions.has(version)) {
      setVersion(preferred);
      setPinned(false);
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => planLogic.buildAgentPlanView(data || {}, { planVersion: version }), [data, version]);
  const launch = useMemo(() => planLogic.initialAgentLaunch(data || {}), [data]);
  useEffect(() => {
    if (!stepId || !view.steps.some((s: any) => s.id === stepId)) setStepId(view.defaultStepId);
  }, [view, stepId]);
  useEffect(() => setMethodOpen(false), [stepId]);
  const step = view.steps.find((s: any) => s.id === stepId) || view.steps[0] || null;
  const stepActivity = useMemo(() => {
    if (!step) return [];
    const source = planLogic.agentStepActivityLines(activityLines, view.currentVersion, step.id, { startedAt: step.startedAt, completedAt: step.completedAt });
    return compactActivity(source, { modelLabel: launch.model === '—' ? '' : launch.model, thinkLevel: launch.thinkLevel === '—' ? '' : launch.thinkLevel, fastMode: launch.fastMode, limit: 5, liveProgressLine });
  }, [activityLines, view, step, launch, liveProgressLine]);
  const total = view.counts.requiredSteps;
  const pct = total ? Math.round((view.counts.completedSteps * 100) / total) : 0;
  const latestDecision = [...(view.versionDecisions || [])].reverse().find((d: any) => d.action) || null;
  const tone = (t: string) => theme[toneKey(t) === 'muted' ? 'muted' : toneKey(t)];

  if (loading && !data) {
    return <EmptyState theme={theme} icon={Loader} title="正在读取执行计划" text="从持久化任务记录中恢复步骤和验收依据…" busy />;
  }
  if (error && !data) {
    return <EmptyState theme={theme} icon={AlertTriangle} tone="danger" title="执行计划读取失败" text={error} action="重新读取" onAction={onRefresh} />;
  }
  if (!view.hasPlan) {
    return <EmptyState theme={theme} icon={Clock} title={view.phaseMeta.label} text={view.phaseMeta.description} action="刷新状态" onAction={onRefresh} busy={loading} />;
  }

  const attention = view.isHistoricalVersion
    ? { tone: 'muted', text: `正在查看历史计划 v${view.currentVersion}；当前执行版本是 v${view.activeVersion}。` }
    : view.phase === 'needs_user_decision'
      ? { tone: 'warning', text: view.state.last_controller_guidance || '自动计划调整已到上限，需要你的决定。' }
      : view.phase === 'blocked_control'
        ? { tone: 'danger', text: step?.blocker?.reason || view.state.last_controller_guidance || '主控正在处理当前阻塞。' }
        : view.taskTerminal
          ? { tone: view.taskStatus === 'failed' ? 'danger' : 'muted', text: view.phaseMeta.description }
          : null;

  const stepList = (
    <View style={{ gap: 6 }}>
      {view.steps.map((s: any) => {
        const on = step?.id === s.id;
        const color = tone(s.statusMeta.tone);
        const icon = s.status === 'completed' ? Check : ['blocked', 'failed', 'cancelled', 'interrupted'].includes(s.status) ? AlertTriangle : s.status === 'pending' ? Clock : null;
        return (
          <Press
            key={s.id}
            onPress={() => { tap('select'); setStepId(s.id); }}
            style={[styles.step, { borderColor: on ? theme.textStrong : theme.line, backgroundColor: on ? theme.selected : theme.panel }]}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            testID={`plan-step-${s.index}`}
          >
            <View style={[styles.stepNo, { backgroundColor: s.status === 'running' ? theme.blueSoft : theme.hover }]}>
              {s.status === 'running' ? <ActivityIndicator size="small" color={theme.blue} /> : icon ? <Icon as={icon} size={13} color={color} strokeWidth={2.4} /> : <Text style={[styles.stepNoText, { color: theme.subtle }]}>{s.index}</Text>}
            </View>
            <View style={styles.flex}>
              <Text numberOfLines={2} style={[styles.stepTitle, { color: theme.textStrong }]}>{s.title}</Text>
              <Text style={[styles.stepMeta, { color: theme.muted }]}>
                {s.criteria.filter((c: any) => c.satisfied).length}/{s.criteria.length} 条件 · <Text style={{ color }}>{s.statusMeta.label}</Text>
                {s.current ? <Text style={{ color: theme.blue }}> · 当前</Text> : null}
              </Text>
            </View>
            <Icon as={ChevronRight} size={15} color={theme.muted} />
          </Press>
        );
      })}
      {view.versions.length > 1 ? (
        <>
          <Press onPress={() => setVersionOpen(true)} style={[styles.version, { borderColor: theme.border }]} accessibilityRole="button" testID="plan-version">
            <View style={styles.flex}>
              <Text style={[styles.small, { color: theme.subtle }]}>计划版本</Text>
              <Text numberOfLines={1} style={[styles.body, { color: theme.text }]}>
                v{view.current.version} · {view.versions.find((v: any) => v.selected)?.typeLabel} · {view.versions.find((v: any) => v.selected)?.statusLabel}
              </Text>
              <Text numberOfLines={2} style={[styles.small, { color: theme.muted }]}>
                {view.current.diff?.changedFields?.length ? `本版变更：${view.current.diff.changedFields.join('、')}` : `共 ${view.versions.length} 个版本，可查看历次计划与执行记录。`}
              </Text>
            </View>
            <Icon as={ChevronDown} size={17} color={theme.subtle} />
          </Press>
          <OptionSheet
            visible={versionOpen}
            title="选择计划版本"
            value={String(view.currentVersion)}
            options={[...view.versions].reverse().map((v: any) => ({
              value: String(v.version),
              label: `v${v.version} · ${v.typeLabel} · ${v.statusLabel}`,
              detail: v.active ? '当前执行' : v.pending ? '等待确认' : undefined,
            }))}
            onChange={(value: string) => {
              const next = Number(value);
              setStepId('');
              setVersion(next);
              setPinned(next !== planLogic.preferredAgentPlanVersion(data || {}));
            }}
            onClose={() => setVersionOpen(false)}
            testID="plan-version-sheet"
          />
        </>
      ) : null}
    </View>
  );

  const stepDetail = step ? (
    <View style={{ gap: 12 }} testID="plan-step-detail">
      <View>
        <Text style={[styles.small, { color: theme.muted }]}>步骤 {step.index} · {step.id}</Text>
        <View style={styles.rowWrap}>
          <Text style={[styles.h2, { color: theme.textStrong }]}>{step.title}</Text>
          <Text style={[styles.badge, { color: tone(step.statusMeta.tone), backgroundColor: theme.hover }]}>{step.statusMeta.label}</Text>
        </View>
        {step.objective || view.plan.objective ? <Text style={[styles.body, { color: theme.subtle }]}>{step.objective || view.plan.objective}</Text> : null}
      </View>
      <Cell theme={theme} label="执行方法">
        <Text selectable numberOfLines={methodOpen ? undefined : 4} style={[styles.body, { color: theme.text }]}>{step.method || '等待 Agent 记录执行方法。'}</Text>
        {String(step.method || '').length > 120 ? (
          <Press onPress={() => setMethodOpen((v) => !v)} style={styles.inlineBtn} accessibilityRole="button" testID="plan-method-toggle">
            <Text style={[styles.small, { color: theme.subtle, textDecorationLine: 'underline' }]}>{methodOpen ? '收起' : '展开全部'}</Text>
          </Press>
        ) : null}
      </Cell>
      <Cell theme={theme} label="步骤过程" note="仅显示最近 5 条，完整内容请查看“过程记录”">
        {activityError ? <Text style={[styles.small, { color: theme.danger }]}>{activityError}</Text> : null}
        {activityLoading && !stepActivity.length ? (
          <View style={styles.rowWrap}><ActivityIndicator size="small" color={theme.muted} /><Text style={[styles.small, { color: theme.muted }]}>正在归集步骤事件…</Text></View>
        ) : (
          <ActivityList theme={theme} lines={stepActivity} emptyText="这个步骤暂时没有可显示的过程记录。" compact />
        )}
      </Cell>
      {step.result ? <Cell theme={theme} label="执行结果"><Text selectable style={[styles.body, { color: theme.text }]}>{step.result}</Text></Cell> : null}
      {step.blocker?.reason ? (
        <View style={[styles.note, { backgroundColor: theme.dangerSoft }]}>
          <Icon as={AlertTriangle} size={15} color={theme.danger} />
          <View style={styles.flex}><Text style={[styles.label, { color: theme.danger }]}>阻塞原因</Text><Text selectable style={[styles.body, { color: theme.text }]}>{step.blocker.reason}</Text></View>
        </View>
      ) : null}
      <Section theme={theme} title="完成条件" right={`${step.criteria.filter((c: any) => c.satisfied).length}/${step.criteria.length} 已满足`} />
      {!step.criteria.length ? <Text style={[styles.small, { color: theme.muted }]}>这个步骤没有声明完成条件。</Text> : null}
      {step.criteria.map((c: any) => (
        <View key={c.id} style={[styles.criterion, { borderColor: theme.line }]} testID="plan-criterion">
          <View style={styles.rowTop}>
            <Icon as={c.satisfied ? Check : Clock} size={15} color={tone(c.statusMeta.tone)} strokeWidth={2.4} />
            <View style={styles.flex}>
              <Text style={[styles.label, { color: theme.textStrong }]}>{c.description}</Text>
              <Text style={[styles.small, { color: theme.muted }]}>{c.note ? `判断说明：${c.note}` : `${c.required ? '必需条件' : '可选条件'} · ${c.statusMeta.label}`}</Text>
            </View>
          </View>
          {c.evidence.length ? c.evidence.map((ev: any) => <Evidence key={ev.uuid} theme={theme} evidence={ev} />) : (
            <View style={styles.rowWrap}><Icon as={AlertTriangle} size={13} color={theme.warning} /><Text style={[styles.small, { color: theme.warning }]}>尚未绑定验收依据</Text></View>
          )}
        </View>
      ))}
      {step.startedAt || step.completedAt ? <Text style={[styles.small, { color: theme.muted }]}>开始 {fmtTime(step.startedAt)}  ·  完成 {fmtTime(step.completedAt)}</Text> : null}
    </View>
  ) : <Text style={[styles.small, { color: theme.muted }]}>当前计划没有可展示的步骤。</Text>;

  return (
    <View style={{ gap: 14 }} testID="agent-plan">
      <View style={[styles.overview, { backgroundColor: theme.surfaceSoft }]}>
        <View style={styles.rowWrap}>
          <Text style={[styles.label, styles.flex, { color: theme.textStrong }]}>{view.phaseMeta.label} · {view.counts.completedSteps}/{view.counts.requiredSteps}</Text>
          <Press onPress={onRefresh} disabled={loading} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="重新读取最新状态" testID="plan-refresh">
            {loading ? <ActivityIndicator size="small" color={theme.subtle} /> : <Icon as={RefreshCw} size={16} color={theme.subtle} />}
          </Press>
        </View>
        <Text style={[styles.small, { color: theme.subtle }]}>{view.phaseMeta.description}</Text>
        <View style={[styles.progress, { backgroundColor: theme.line }]} accessibilityLabel={`必做步骤完成 ${pct}%`}>
          <View style={{ width: `${pct}%`, height: '100%', borderRadius: 2, backgroundColor: view.taskStatus === 'failed' ? theme.danger : theme.success }} />
        </View>
      </View>
      {attention ? (
        <View style={[styles.note, { backgroundColor: attention.tone === 'danger' ? theme.dangerSoft : attention.tone === 'warning' ? theme.warningSoft : theme.hover }]} testID="plan-attention">
          <Icon as={attention.tone === 'muted' ? Clock : AlertTriangle} size={15} color={attention.tone === 'danger' ? theme.danger : attention.tone === 'warning' ? theme.warning : theme.subtle} />
          <Text style={[styles.body, styles.flex, { color: theme.text }]}>{attention.text}</Text>
        </View>
      ) : null}
      {wide ? (
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <View style={{ width: 300 }}>{stepList}</View>
          <View style={styles.flex}>{stepDetail}</View>
        </View>
      ) : (
        <>
          {stepList}
          <View style={[styles.divider, { backgroundColor: theme.line }]} />
          {stepDetail}
        </>
      )}
      <Section theme={theme} title="完成检查" right={`${view.completionChecks.filter((c: any) => c.done).length}/${view.completionChecks.length} 通过`} />
      <View style={{ gap: 6 }}>
        {view.completionChecks.map((check: any) => (
          <Press
            key={check.key}
            onPress={() => {
              const id = relevantStepId(view, check);
              if (id) { tap('select'); setStepId(id); }
            }}
            style={[styles.check, { borderColor: theme.line }]}
            accessibilityRole="button"
            testID={`plan-check-${check.key}`}
          >
            <Icon as={check.done ? Check : Clock} size={15} color={check.done ? theme.success : theme.warning} strokeWidth={2.4} />
            <View style={styles.flex}>
              <Text style={[styles.label, { color: theme.textStrong }]}>{check.label}</Text>
              <Text style={[styles.small, { color: theme.muted }]}>{check.detail}</Text>
            </View>
          </Press>
        ))}
      </View>
      {latestDecision ? (
        <View style={[styles.note, { backgroundColor: theme.successSoft }]}>
          <Icon as={Check} size={15} color={theme.success} />
          <View style={styles.flex}>
            <Text style={[styles.label, { color: theme.textStrong }]}>最近一次计划确认：{latestDecision.action === 'approve' ? '已批准' : latestDecision.action}</Text>
            <Text style={[styles.body, { color: theme.subtle }]}>{latestDecision.reason || '计划决定已记录'}</Text>
          </View>
        </View>
      ) : null}
      {view.finalOutputs.length ? (
        <>
          <Section theme={theme} title="最终交付" right={`${view.counts.completedOutputs}/${view.counts.finalOutputs} 已形成`} />
          {view.finalOutputs.map((output: any) => (
            <View key={output.id} style={[styles.criterion, { borderColor: theme.line }]} testID="plan-output">
              <View style={styles.rowTop}>
                <Icon as={output.completed ? Check : Clock} size={15} color={output.completed ? theme.success : theme.muted} strokeWidth={2.4} />
                <View style={styles.flex}>
                  <Text style={[styles.label, { color: theme.textStrong }]}>{output.title}</Text>
                  <Text selectable style={[styles.body, { color: theme.subtle }]}>{output.summary || output.description}</Text>
                </View>
              </View>
              {output.sources.map((src: any) => <Evidence key={src.raw} theme={theme} evidence={{ ...src, typeLabel: src.typeLabel || src.label }} />)}
            </View>
          ))}
        </>
      ) : null}
    </View>
  );
}

function Evidence({ theme, evidence }: { theme: Theme; evidence: any }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.evidence, { backgroundColor: theme.surfaceSoft }]}>
      <View style={styles.rowWrap}>
        <Text style={[styles.badge, { color: theme.subtle, backgroundColor: theme.hover }]}>{evidence.typeLabel}</Text>
        <Press onPress={() => setOpen((v) => !v)} style={styles.inlineBtn} accessibilityRole="button" testID="evidence-toggle">
          <Text style={[styles.small, { color: theme.subtle, textDecorationLine: 'underline' }]}>{open ? '收起依据详情' : '依据详情'}</Text>
        </Press>
      </View>
      <Text selectable numberOfLines={open ? undefined : 3} style={[styles.small, { color: theme.text }]}>{evidence.summary}</Text>
      {open && evidence.uuid ? <Text selectable style={[styles.mono, { color: theme.muted }]}>记录 ID：{evidence.uuid}</Text> : null}
    </View>
  );
}

function Cell({ theme, label, note, children }: { theme: Theme; label: string; note?: string; children: React.ReactNode }) {
  return (
    <View style={[styles.cell, { backgroundColor: theme.surfaceSoft }]}>
      <Text style={[styles.label, { color: theme.subtle }]}>{label}{note ? <Text style={[styles.small, { color: theme.muted, fontWeight: '400' }]}>{`  ${note}`}</Text> : null}</Text>
      {children}
    </View>
  );
}

function Section({ theme, title, right }: { theme: Theme; title: string; right?: string }) {
  return (
    <View style={[styles.rowWrap, { justifyContent: 'space-between', marginTop: 4 }]}>
      <Text style={[styles.label, { color: theme.textStrong }]}>{title}</Text>
      {right ? <Text style={[styles.small, { color: theme.muted }]}>{right}</Text> : null}
    </View>
  );
}

export function EmptyState({ theme, icon, title, text, action, onAction, busy, tone }: {
  theme: Theme; icon: any; title: string; text?: string; action?: string; onAction?: () => void; busy?: boolean; tone?: 'danger';
}) {
  return (
    <View style={styles.empty} testID="agent-empty">
      {busy && !action ? <ActivityIndicator color={theme.muted} /> : <Icon as={icon} size={22} color={tone === 'danger' ? theme.danger : theme.muted} />}
      <Text style={[styles.label, { color: tone === 'danger' ? theme.danger : theme.textStrong, textAlign: 'center' }]}>{title}</Text>
      {text ? <Text style={[styles.small, { color: theme.muted, textAlign: 'center' }]}>{text}</Text> : null}
      {action ? (
        <Press onPress={onAction} disabled={busy} style={[styles.emptyBtn, { backgroundColor: theme.button, opacity: busy ? 0.6 : 1 }]} accessibilityRole="button" testID="agent-empty-action">
          {busy ? <ActivityIndicator size="small" color={theme.buttonText} /> : <Icon as={RefreshCw} size={14} color={theme.buttonText} />}
          <Text style={[styles.label, { color: theme.buttonText }]}>{action}</Text>
        </Press>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  rowWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  overview: { borderRadius: 14, padding: 12, gap: 6 },
  progress: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 4 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  stepNo: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  stepNoText: { fontSize: 12, fontWeight: '700' },
  stepTitle: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  stepMeta: { fontSize: 12, marginTop: 1 },
  version: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10, minHeight: 52 },
  h2: { fontSize: 17, fontWeight: '700', lineHeight: 24, flexShrink: 1 },
  badge: { fontSize: 11.5, fontWeight: '600', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 7, overflow: 'hidden' },
  body: { fontSize: 14, lineHeight: 21 },
  small: { fontSize: 12.5, lineHeight: 18 },
  label: { fontSize: 13.5, fontWeight: '600', lineHeight: 19 },
  mono: { fontSize: 12, fontFamily: 'monospace' },
  cell: { borderRadius: 12, padding: 10, gap: 6 },
  inlineBtn: { minHeight: 32, justifyContent: 'center' },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 12, padding: 10 },
  criterion: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10, gap: 8 },
  evidence: { borderRadius: 10, padding: 8, gap: 4 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10, minHeight: 48 },
  divider: { height: StyleSheet.hairlineWidth },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 36, paddingHorizontal: 16 },
  emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, borderRadius: 20, paddingHorizontal: 18, marginTop: 6 },
});
