/**
 * 用户侧的特殊消息卡片与它们的详情（B2-14～B2-17），对应 Web WebhookMessageCard / CronMessageCard /
 * InstanceMessageCard，以及引用胶囊详情（B2-07，ReferenceInspector）。
 * 卡片在对话流里左对齐（事件来信不是“我说的话”）；详情一律用共享 Sheet。
 */
import { ArrowRight, Check, Copy, Mail, RefreshCw, Server, Timer } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { highlightLine } from '../../artifacts/codeHighlight';
import { OptionSheet } from '../../ui/Form';
import { Sheet, SheetScroll } from '../../ui/Sheet';
import { showToast } from '../../ui/Toast';
import { Icon, Press, Segmented, tap } from '../../ui/primitives';
import { fonts, type Theme } from '../../ui/theme';
import { apiError, copyText, fullTime, useChatApi } from '../chatApi';
import { KIND_LABELS, referenceErrorText, referenceScopeLabel, type Reference } from './references';

// ---------------------------------------------------------------- 通用信封卡片

function Envelope({ theme, icon, label, title, summary, meta, onPress, testID }: {
  theme: Theme; icon: any; label: string; title: string; summary?: string; meta: string[]; onPress(): void; testID?: string;
}) {
  return (
    <Press
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.envelope, { backgroundColor: theme.panel, borderColor: theme.border }]}
      accessibilityRole="button"
      accessibilityLabel={`${label}：${title}`}
      testID={testID}
    >
      <View style={[styles.envIcon, { backgroundColor: theme.surfaceSoft }]}>
        <Icon as={icon} size={17} color={theme.subtle} />
      </View>
      <View style={styles.flex}>
        <Text numberOfLines={1} style={[styles.envLabel, { color: theme.muted }]}>{label}</Text>
        <Text numberOfLines={2} style={[styles.envTitle, { color: theme.textStrong }]}>{title}</Text>
        {summary ? <Text numberOfLines={2} style={[styles.envSummary, { color: theme.subtle }]}>{summary}</Text> : null}
        <Text numberOfLines={1} style={[styles.envMeta, { color: theme.muted }]}>{meta.filter(Boolean).join('  ·  ')}</Text>
      </View>
      <Icon as={ArrowRight} size={15} color={theme.muted} />
    </Press>
  );
}

function formatEventData(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? '';
}

function JsonBlock({ theme, value, testID }: { theme: Theme; value: unknown; testID?: string }) {
  const text = formatEventData(value);
  const colors: Record<string, string | undefined> = { attr: theme.blue, string: theme.success, number: theme.warning, keyword: theme.warning };
  return (
    <Text selectable style={[styles.json, { color: theme.text, backgroundColor: theme.codeBg }]} testID={testID}>
      {text.split('\n').slice(0, 2000).map((line, i, all) => (
        <Text key={i}>
          {highlightLine(line, 'json').map((t, j) => <Text key={j} style={colors[t.kind] ? { color: colors[t.kind] } : undefined}>{t.text}</Text>)}
          {i < all.length - 1 ? '\n' : ''}
        </Text>
      ))}
    </Text>
  );
}

// ---------------------------------------------------------------- 触发器事件来信

export function eventMessageView(message: any) {
  const card = message?.eventCard || {};
  return {
    name: card.name || '外部事件',
    shortId: String(card.shortId || String(message?.opId || '').replace(/^msg:/, '') || '').slice(0, 8),
    receivedAtMs: Number(card.receivedAtMs || Number(message?.createdAtMs || 0)),
    count: Number(card.count || card.events?.length || 1),
    events: Array.isArray(card.events) ? card.events : [],
    summary: String(card.events?.find((e: any) => e.summary)?.summary || ''),
  };
}

export function WebhookCard({ theme, message }: { theme: Theme; message: any }) {
  const api = useChatApi();
  const view = useMemo(() => eventMessageView(message), [message]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'event' | 'input'>('event');
  const [selected, setSelected] = useState('');
  const [picker, setPicker] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    setDetail(null);
    setError('');
    if (!open || tab !== 'event' || !selected || !api) return;
    setLoading(true);
    try {
      const data = await api.webhookEvent(selected);
      setDetail(data.event);
    } catch (e) {
      setError(apiError(e));
    } finally {
      setLoading(false);
    }
  }, [api, open, tab, selected]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setCopied(false), [tab, selected, open]);
  const body = detail?.raw?.body ?? detail?.raw?.content ?? '';
  const show = () => {
    const first = view.events[0]?.eventId || '';
    setSelected(first);
    setTab(first ? 'event' : 'input');
    setOpen(true);
  };
  const arrival = view.receivedAtMs ? fullTime(view.receivedAtMs) : '时间未知';
  return (
    <>
      <Envelope
        theme={theme}
        icon={Mail}
        label={`事件来信${view.count > 1 ? ` · 合并 ${view.count} 条` : ''}`}
        title={view.name}
        summary={view.summary}
        meta={[arrival, view.shortId ? `#${view.shortId}` : '']}
        onPress={show}
        testID="card-webhook"
      />
      <Sheet visible={open} onClose={() => setOpen(false)} title="事件来信" subtitle={`${view.name} · ${arrival} · #${view.shortId}`} full testID="webhook-sheet"
        right={
          <Press
            onPress={async () => {
              const ok = await copyText(tab === 'input' ? String(message.content || '') : formatEventData(body), tab === 'input' ? '模型输入' : '事件材料');
              setCopied(ok);
            }}
            disabled={loading || (tab === 'event' && !detail?.raw)}
            style={[styles.iconBtn, (loading || (tab === 'event' && !detail?.raw)) && { opacity: 0.4 }]}
            accessibilityRole="button"
            accessibilityLabel="复制内容"
            testID="webhook-copy"
          >
            <Icon as={copied ? Check : Copy} size={18} color={theme.subtle} />
          </Press>
        }
      >
        <View style={styles.sheetPad}>
          <Segmented
            theme={theme}
            items={[{ key: 'event', label: '事件材料' }, { key: 'input', label: '模型输入' }]}
            value={tab}
            onChange={(k) => (k === 'event' && !view.events.length ? showToast('这个批次没有可读取的事件材料') : setTab(k as any))}
          />
        </View>
        <SheetScroll contentContainerStyle={styles.sheetBody}>
          {tab === 'event' ? (
            <>
              {view.events.length > 1 ? (
                <Press onPress={() => setPicker(true)} style={[styles.select, { borderColor: theme.border }]} accessibilityRole="button" testID="webhook-batch">
                  <Text style={[styles.small, { color: theme.muted }]}>批次中的事件</Text>
                  <Text numberOfLines={1} style={[styles.body, { color: theme.text }]}>
                    {(() => {
                      const i = view.events.findIndex((e: any) => e.eventId === selected);
                      const e = view.events[i] || {};
                      return `${i + 1} · ${fullTime(Number(e.receivedAtMs || 0))} · ${String(e.summary || '').slice(0, 48) || `#${String(e.eventId || '').slice(0, 8)}`}`;
                    })()}
                  </Text>
                </Press>
              ) : null}
              {loading ? (
                <ActivityIndicator color={theme.muted} style={{ marginTop: 20 }} />
              ) : error ? (
                <View style={styles.errorRow}>
                  <Text style={[styles.body, { color: theme.danger, flex: 1 }]}>{error}</Text>
                  <Press onPress={() => void load()} style={[styles.smallBtn, { backgroundColor: theme.hover }]} accessibilityRole="button" testID="webhook-retry">
                    <Icon as={RefreshCw} size={14} color={theme.text} />
                    <Text style={[styles.small, { color: theme.text, fontWeight: '600' }]}>重试</Text>
                  </Press>
                </View>
              ) : detail?.raw ? (
                <>
                  <Text style={[styles.h3, { color: theme.textStrong }]}>消息正文 <Text style={[styles.small, { color: theme.muted }]}>{detail.raw.contentType}</Text></Text>
                  <JsonBlock theme={theme} value={body} testID="webhook-body" />
                  {detail.raw.query?.length ? (<><Text style={[styles.h3, { color: theme.textStrong }]}>Query 参数</Text><JsonBlock theme={theme} value={detail.raw.query} /></>) : null}
                  {detail.derived != null ? (<><Text style={[styles.h3, { color: theme.textStrong }]}>前置处理材料</Text><JsonBlock theme={theme} value={detail.derived} /></>) : null}
                </>
              ) : (
                <Text style={[styles.body, { color: theme.subtle }]}>原始事件材料已清理或不可用；仍可查看当时保存的模型输入。</Text>
              )}
            </>
          ) : (
            <>
              <Text style={[styles.small, { color: theme.subtle }]}>当时发送的处理提示词与事件内容，原文保留。</Text>
              <Text selectable style={[styles.json, { color: theme.text, backgroundColor: theme.codeBg }]} testID="webhook-input">{String(message.content || '')}</Text>
            </>
          )}
        </SheetScroll>
      </Sheet>
      <OptionSheet
        visible={picker}
        title="批次中的事件"
        value={selected}
        options={view.events.map((e: any, i: number) => ({ value: String(e.eventId), label: `${i + 1} · ${fullTime(Number(e.receivedAtMs || 0))}`, detail: String(e.summary || '').slice(0, 80) || `#${String(e.eventId).slice(0, 8)}` }))}
        onChange={(v: string) => setSelected(v)}
        onClose={() => setPicker(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------- 定时任务

const CRON_LABELS: Record<string, string> = {
  starting: '启动中', running: '运行中', completed: '已完成', failed: '失败', timed_out: '执行超时', tokens_exceeded: 'Tokens 超限', cost_exceeded: '金额超限',
  cancelled: '已取消', interrupted: '已中断', post_failed: '后置失败', missed: '已错过', pre: '前置脚本', model: '模型执行', post: '后置脚本', finished: '结束',
  scheduled: '定时', manual: '手动',
};
const cronLabel = (v: unknown) => CRON_LABELS[String(v)] || (v ? String(v) : '—');
const num = (v: unknown) => (v == null ? '—' : Number(v).toLocaleString('zh-CN', { maximumSignificantDigits: 15 }));

export function scheduleText(schedule: any = {}): string {
  const t = (v: any) => (v ? fullTime(typeof v === 'number' ? v : Date.parse(v)) : '—');
  const rest = schedule.skipHolidays ? ' · 跳过休息日（含调休）' : '';
  if (schedule.kind === 'at') return `一次性 · ${t(schedule.at)}${rest}`;
  if (schedule.kind === 'every') {
    const s = Number(schedule.everySeconds || 0);
    const unit = s % 86400 === 0 ? [86400, '天'] : s % 3600 === 0 ? [3600, '时'] : s % 60 === 0 ? [60, '分'] : [1, '秒'];
    return `每 ${num(s / (unit[0] as number))} ${unit[1]}${rest}`;
  }
  return `${schedule.expression || '—'}${schedule.second ? ` · 第 ${schedule.second} 秒` : ''} · ${schedule.timezone || '—'}${rest}`;
}

export function CronCard({ theme, message }: { theme: Theme; message: any }) {
  const api = useChatApi();
  const card = message.cronCard || {};
  const runId = String(card.runId || message.cronRunId || String(message.opId || '').replace(/^msg:/, ''));
  const name = card.name || '定时任务';
  const trigger = ({ scheduled: '自动触发', manual: '手动执行' } as Record<string, string>)[card.trigger] || '任务执行';
  const startedAt = Number(card.startedAtMs || message.createdAtMs || 0);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inputOpen, setInputOpen] = useState(false);
  const load = useCallback(async () => {
    if (!api || !runId) return;
    setLoading(true);
    setError('');
    try {
      setData(await api.cronRun(runId));
    } catch (e) {
      setError(apiError(e));
    } finally {
      setLoading(false);
    }
  }, [api, runId]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  const run = data?.run;
  return (
    <>
      <Envelope theme={theme} icon={Timer} label={`定时任务 · ${trigger}`} title={name} summary={card.schedule ? scheduleText(card.schedule) : ''} meta={[startedAt ? fullTime(startedAt) : '', runId ? `#${runId.slice(0, 8)}` : '']} onPress={() => setOpen(true)} testID="card-cron" />
      <Sheet visible={open} onClose={() => setOpen(false)} title="执行详情" subtitle={name} full testID="cron-sheet"
        right={<Press onPress={() => void load()} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="刷新">{loading ? <ActivityIndicator size="small" color={theme.subtle} /> : <Icon as={RefreshCw} size={17} color={theme.subtle} />}</Press>}>
        <SheetScroll contentContainerStyle={styles.sheetBody}>
          <Press onPress={() => setInputOpen((v) => !v)} style={[styles.select, { borderColor: theme.border }]} accessibilityRole="button" testID="cron-input-toggle">
            <Text style={[styles.body, { color: theme.text, fontWeight: '600' }]}>模型输入 · 原文 {inputOpen ? '▾' : '▸'}</Text>
            <Text style={[styles.small, { color: theme.muted }]}>当时发送的任务指令与前置脚本输出，原文保留。</Text>
          </Press>
          {inputOpen ? (
            <>
              <Press onPress={() => void copyText(String(message.content || ''), '模型输入')} style={[styles.smallBtn, { backgroundColor: theme.hover, alignSelf: 'flex-start' }]} accessibilityRole="button" testID="cron-copy-input">
                <Icon as={Copy} size={14} color={theme.text} />
                <Text style={[styles.small, { color: theme.text, fontWeight: '600' }]}>复制模型输入</Text>
              </Press>
              <Text selectable style={[styles.json, { color: theme.text, backgroundColor: theme.codeBg }]}>{String(message.content || '')}</Text>
            </>
          ) : null}
          {loading && !run ? <ActivityIndicator color={theme.muted} style={{ marginTop: 16 }} /> : null}
          {error ? (
            <View style={styles.errorRow}>
              <Text style={[styles.body, { color: theme.danger, flex: 1 }]}>{error}</Text>
              <Press onPress={() => void load()} style={[styles.smallBtn, { backgroundColor: theme.hover }]} accessibilityRole="button" testID="cron-retry"><Text style={[styles.small, { color: theme.text, fontWeight: '600' }]}>重试</Text></Press>
            </View>
          ) : null}
          {run ? (
            <>
              <Text style={[styles.h2, { color: theme.textStrong }]}>{run.jobName}</Text>
              <Text selectable style={[styles.small, { color: theme.muted, fontFamily: fonts.mono }]}>{run.id}</Text>
              <Text style={[styles.body, { color: theme.text }]}><Text style={{ fontWeight: '700' }}>{cronLabel(run.status)}</Text>  {cronLabel(run.phase)} · {cronLabel(run.trigger)}</Text>
              <View style={[styles.facts, { backgroundColor: theme.surfaceSoft }]}>
                {([
                  ['原业务结果', cronLabel(run.outcome)], ['计划时间', run.scheduledAt ? fullTime(Date.parse(run.scheduledAt) || Number(run.scheduledAt)) : '—'],
                  ['开始', run.startedAt ? fullTime(Date.parse(run.startedAt) || Number(run.startedAt)) : '—'], ['结束', run.finishedAt ? fullTime(Date.parse(run.finishedAt) || Number(run.finishedAt)) : '—'],
                  ['耗时（秒）', num(run.durationSeconds)], ['总 Tokens', num(run.totalTokens)], ['费用（USD）', run.costUsd == null ? '—' : `$${num(run.costUsd)}`],
                  ['模型调用', num(run.modelCalls)], ['会话 ID', run.conversationId || '—'], ['主轮 ID', run.rootTurnId || '—'],
                ] as Array<[string, string]>).map(([k, v]) => (
                  <View key={k} style={styles.fact}><Text style={[styles.factK, { color: theme.muted }]}>{k}</Text><Text selectable style={[styles.factV, { color: theme.text }]}>{v}</Text></View>
                ))}
              </View>
              {run.error ? (<><Text style={[styles.h3, { color: theme.danger }]}>错误</Text><Text selectable style={[styles.json, { color: theme.text, backgroundColor: theme.dangerSoft }]}>{typeof run.error === 'string' ? run.error : JSON.stringify(run.error, null, 2)}</Text></>) : null}
              <Text style={[styles.h3, { color: theme.textStrong }]}>最终输出</Text>
              <Text selectable style={[styles.json, { color: theme.text, backgroundColor: theme.codeBg }]}>{run.finalText || '（暂无输出）'}</Text>
            </>
          ) : null}
        </SheetScroll>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------- 实例部署 / 维护

export function InstanceCard({ theme, message }: { theme: Theme; message: any }) {
  const card = message.instanceCard || {};
  const maintenance = card.kind === 'maintenance';
  const title = card.name || '实例';
  const summary = maintenance ? card.instructions || '按指定范围维护实例。' : '交付文件、构建镜像、启动容器，再检查并报告结果。';
  const target = [card.server, card.workspacePath, card.port ? `端口 ${card.port}` : ''].filter(Boolean).join(' · ');
  const startedAt = Number(card.startedAtMs || message.createdAtMs || 0);
  const operationId = String(card.operationId || String(message.opId || '').replace(/^msg:/, ''));
  const [open, setOpen] = useState(false);
  return (
    <>
      <Envelope theme={theme} icon={Server} label={`${maintenance ? '实例维护' : '实例部署'} · 主控发起`} title={title} summary={summary} meta={[target, startedAt ? fullTime(startedAt) : '', operationId ? `#${operationId.slice(0, 8)}` : '']} onPress={() => setOpen(true)} testID="card-instance" />
      <Sheet visible={open} onClose={() => setOpen(false)} title={`${maintenance ? '维护' : '部署'}指令 · ${title}`} full
        right={<Press onPress={() => void copyText(String(message.content || ''), '原始指令')} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="复制"><Icon as={Copy} size={17} color={theme.subtle} /></Press>}>
        <SheetScroll contentContainerStyle={styles.sheetBody}>
          <Text style={[styles.small, { color: theme.muted }]}>主控发给执行模型的原始指令。实例凭证通过受保护的引用提供，不在这里显示。</Text>
          <Text selectable style={[styles.json, { color: theme.text, backgroundColor: theme.codeBg }]}>{String(message.content || '')}</Text>
        </SheetScroll>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------- 引用详情

export function ReferenceInspector({ theme, conversationUuid, target, onClose }: { theme: Theme; conversationUuid: string; target: { ref: Reference; token: string; bundleId: string } | null; onClose(): void }) {
  const api = useChatApi();
  const [details, setDetails] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!target || !api) return;
    setBusy(true);
    setError('');
    setDetails(null);
    try {
      setDetails(await api.referenceInspect(target.token, conversationUuid, target.bundleId || ''));
    } catch (e: any) {
      setError(referenceErrorText(String(e?.body?.error || '')) || apiError(e));
    } finally {
      setBusy(false);
    }
  }, [api, target, conversationUuid]);
  useEffect(() => {
    void load();
  }, [load]);
  const ref = target?.ref;
  const mention = ref?.mode === 'mention' || details?.item?.mode === 'mention';
  return (
    <Sheet visible={Boolean(target)} onClose={onClose} title={ref ? `${KIND_LABELS[ref.kind] || '引用'}：${ref.label}` : '引用详情'} subtitle={ref ? referenceScopeLabel(ref) || undefined : undefined} testID="reference-sheet">
      <SheetScroll contentContainerStyle={styles.sheetBody}>
        {busy ? (
          <View style={styles.errorRow}><ActivityIndicator size="small" color={theme.muted} /><Text style={[styles.body, { color: theme.muted }]}>正在读取引用信息…</Text></View>
        ) : error ? (
          <View style={styles.errorRow}>
            <Text style={[styles.body, { color: theme.danger, flex: 1 }]}>{error}</Text>
            <Press onPress={() => void load()} style={[styles.smallBtn, { backgroundColor: theme.hover }]} accessibilityRole="button"><Text style={[styles.small, { color: theme.text, fontWeight: '600' }]}>重试</Text></Press>
          </View>
        ) : details ? (
          <>
            <Text style={[styles.small, { color: theme.subtle }]} testID="reference-version">
              {details.frozen ? '本条消息引用时的版本' : '当前来源'} · 约 {Number(details.item?.estimatedTokens || 0).toLocaleString()} Tokens
            </Text>
            {mention ? <Text style={[styles.small, { color: theme.subtle }]}>仅提供名称与定位，不附正文。</Text> : null}
            {details.item?.sensitive && !mention ? (
              <Text style={[styles.body, { color: theme.warning }]}>凭证会在发送时提供给当前模型。这里不展示或复制凭证值，草稿与胶囊只保存引用。</Text>
            ) : (
              <Text selectable style={[styles.json, { color: theme.text, backgroundColor: theme.codeBg }]}>
                {mention ? JSON.stringify(details.item?.locator || {}, null, 2) : details.content || '内容为空'}
              </Text>
            )}
            {details.previewTruncated ? <Text style={[styles.small, { color: theme.muted }]}>此处仅展示部分预览，不代表发送内容被截断。</Text> : null}
          </>
        ) : null}
      </SheetScroll>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  envelope: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 12, maxWidth: 520, width: '100%' },
  envIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  envLabel: { fontSize: 12 },
  envTitle: { fontSize: 15, fontWeight: '600', lineHeight: 21 },
  envSummary: { fontSize: 13, lineHeight: 19, marginTop: 1 },
  envMeta: { fontSize: 11.5, marginTop: 3, fontVariant: ['tabular-nums'] },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sheetPad: { paddingHorizontal: 20, paddingBottom: 8 },
  sheetBody: { paddingHorizontal: 20, paddingBottom: 24, gap: 10 },
  select: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10, gap: 2, minHeight: 48 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  smallBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 36, borderRadius: 18, paddingHorizontal: 14 },
  json: { fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 19, padding: 12, borderRadius: 12, overflow: 'hidden' },
  h2: { fontSize: 17, fontWeight: '700' },
  h3: { fontSize: 13.5, fontWeight: '600', marginTop: 6 },
  body: { fontSize: 14, lineHeight: 21 },
  small: { fontSize: 12.5, lineHeight: 18 },
  facts: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  fact: { flexDirection: 'row', gap: 10, paddingVertical: 5 },
  factK: { width: 84, fontSize: 12.5 },
  factV: { flex: 1, fontSize: 13 },
});
