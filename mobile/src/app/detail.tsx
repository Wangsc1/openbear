/**
 * 详情面板：系统 Sheet（expo-router Stack presentation='formSheet'，Android 上是原生 BottomSheet，
 * 可停靠 50% / 92%，下拉或系统返回关闭；配置在 _layout.tsx，不在这里改）。方向稿第 ⑤ 屏。
 *
 * 完整内容通过 /operations/{opId}/detail 懒加载，按种类展示：
 * - 工具：头部（类别图标块 + 类别名 + 结论“退出码 1 / 完成 · 耗时 · 时间” + 更多）
 *   + 分段控件 输出 / 参数 / 原始 + 底部操作（复制输出、引用到输入框）。
 *   输出：终端 -> 终端风格输出块（等宽、可横向滚动或折行、失败行红色）；读取 -> 带行号的文件内容；
 *   搜索 -> 结果列表；其它 -> Markdown / 键值 / 代码块。
 *   参数：web 复用的 buildToolArgumentsView 结构化为键值对（值等宽，长值可展开）+ 命令/内容块。
 *   原始：完整 JSON（等宽、可横向滚动）。
 * - 思考：标题“思考” + 耗时，全文（正文渲染、次要色）。
 * - 助手（Agent）：任务名 + 状态/耗时，结果摘要（Markdown），有进度则列出最近进展。
 * - 交互问答：问题、说明、选项与用户的回答。
 * - 加载中：骨架；出错：一句错误 + 重试。
 */
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { ChevronDown, ChevronUp, Copy, Ellipsis, FileJson, TextQuote, WrapText, type LucideIcon } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { enrichedRenderer } from '../chat/markdown/EnrichedBody';
import {
  asText,
  clip,
  formatClock,
  formatDuration,
  isFailureLine,
  parseFileResult,
  parseKeyValueLines,
  parseMaybeJson,
  parseSearchResult,
  parseTerminalResult,
  toolOutcome,
  type Outcome,
} from '../chat/detailParse';
import { AgentInfoView, BatchTabs, CompactionView, InteractionRecord, sizeLabel } from '../chat/detailExtras';
import { BottomPanel, PanelRow, useToast } from '../chat/sheetKit';
import { INTERACTION_KIND, REASONING_KIND, toolKind } from '../chat/toolKinds';
import { useSession } from '../data/session';
import { buildToolArgumentsView, buildUserInteractionView, toolBatchLabel, toolBatchSize, toolResultForIndex, toolResultText, userInteractionEventInput, type Operation } from '../data/webLogic';
import { Icon, Press, Segmented, tap } from '../ui/primitives';
import { fonts, radius, type Theme, type as typeScale, useTheme } from '../ui/theme';

const OUTPUT_LIMIT = 60000;
const OUTPUT_LINES = 1500;
const MONO = { fontFamily: fonts.mono, fontSize: typeScale.mono, lineHeight: typeScale.monoLine };

type Kind = 'tool' | 'reasoning' | 'agent' | 'interaction';
type Tab = 'output' | 'args' | 'raw';

export default function DetailSheet() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ uuid: string; opId: string; kind: string }>();
  const uuid = String(params.uuid);
  const opId = String(params.opId);
  const session = useSession();
  const [op, setOp] = useState<Operation | undefined>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [detailFailed, setDetailFailed] = useState(false);
  const [toastNode, toast] = useToast(theme, insets.bottom + 84);

  useEffect(() => {
    let alive = true;
    setState('loading');
    const store = session.storeFor(uuid);
    if (!store) return undefined;
    store
      .operationDetail(opId)
      .then((value) => {
        if (!alive) return;
        setOp(value);
        // 按需读取的全文（如已完成的思考）仍是未加载状态：说明 /detail 请求失败、只拿到了本地摘要
        setDetailFailed(Boolean(value && value.detailAvailable && value.detailLoaded === false));
        setState(value ? 'ready' : 'error');
      })
      .catch(() => alive && setState('error'));
    return () => {
      alive = false;
    };
  }, [uuid, opId, session.storeFor, attempt]);

  const kind = resolveKind(String(params.kind || ''), op);

  return (
    <View style={[styles.root, { backgroundColor: theme.panel }]} testID="detail-sheet">
      {state === 'loading' ? (
        <Skeleton theme={theme} />
      ) : state === 'error' || !op ? (
        <View style={styles.errorBox} testID="detail-error">
          <Text style={[styles.errorText, { color: theme.subtle }]}>没能加载这条操作的详情</Text>
          <Press onPress={() => setAttempt((n) => n + 1)} style={[styles.retry, { backgroundColor: theme.button }]} accessibilityRole="button" testID="detail-retry">
            <Text style={[styles.retryText, { color: theme.buttonText }]}>重试</Text>
          </Press>
        </View>
      ) : kind === 'reasoning' ? (
        <ReasoningDetail theme={theme} op={op} bottom={insets.bottom} detailFailed={detailFailed} />
      ) : kind === 'agent' ? (
        <AgentDetail theme={theme} op={op} bottom={insets.bottom} toast={toast} />
      ) : kind === 'interaction' ? (
        <InteractionDetail theme={theme} op={op} bottom={insets.bottom} event={session.storeFor(uuid)?.eventFor(opId)} />
      ) : (
        <ToolDetail theme={theme} op={op} bottom={insets.bottom} toast={toast} uuid={uuid} event={session.storeFor(uuid)?.eventFor(opId)} />
      )}
      {toastNode}
    </View>
  );
}

function resolveKind(param: string, op?: Operation): Kind {
  if (op?.opType === 'reasoning') return 'reasoning';
  if (op?.opType === 'user_interaction') return 'interaction';
  if (op?.opType === 'agent' || (op && toolKind(toolNameOf(op)).key === 'agent')) return 'agent';
  if (param === 'reasoning' || param === 'agent' || param === 'interaction') return param;
  return 'tool';
}

function toolNameOf(op: Operation): string {
  const p = op.payload || {};
  return String(p.name || p.toolName || p.rootToolName || op.opType || '');
}

function opText(op: Operation): string {
  const p = op.payload || {};
  if (typeof p.text === 'string') return p.text;
  return Array.isArray(p.textChunks) ? p.textChunks.join('') : '';
}

function durationOf(op: Operation): number {
  const p = op.payload || {};
  const explicit = Number(p.durationMs || 0);
  if (explicit) return explicit;
  const start = Number(op.createdAtMs || p.startedAtMs || 0);
  const terminal = Number(op.terminalAtMs || 0);
  // 没有 terminalAtMs 的已结束操作（如回放快照）用最后更新时间近似
  const end = terminal > start ? terminal : op.lifecycle === 'terminal' ? Number(op.updatedAtMs || 0) : 0;
  return start && end && end > start ? end - start : 0;
}

// ---------------------------------------------------------------------------------------------
// 头部

function Header({ theme, icon, tint, title, outcome, meta, onMore }: { theme: Theme; icon: LucideIcon; tint: { fg: string; bg: string }; title: string; outcome?: Outcome; meta: string[]; onMore?: () => void }) {
  const toneColor = outcome ? { ok: theme.success, error: theme.danger, run: theme.blue, muted: theme.subtle }[outcome.tone] : theme.muted;
  const parts = meta.filter(Boolean);
  return (
    <View style={styles.head} testID="detail-head">
      <View style={[styles.headIcon, { backgroundColor: tint.bg }]}>
        <Icon as={icon} size={19} color={tint.fg} strokeWidth={1.9} />
      </View>
      <View style={styles.headText}>
        <Text numberOfLines={1} style={[styles.headTitle, { color: theme.textStrong }]} testID="detail-title">
          {title}
        </Text>
        <Text numberOfLines={1} style={[styles.headMeta, { color: theme.muted }]} testID="detail-meta">
          {outcome ? <Text style={{ color: toneColor, fontWeight: '600' }}>{outcome.label}</Text> : null}
          {parts.map((part, i) => (
            <Text key={`${i}-${part}`}>{`${outcome || i > 0 ? '  ·  ' : ''}${part}`}</Text>
          ))}
        </Text>
      </View>
      {onMore ? (
        <Press onPress={onMore} accessibilityRole="button" accessibilityLabel="更多" hitSlop={6} style={[styles.more, { backgroundColor: theme.hover }]} testID="detail-more" android_ripple={{ color: theme.selected, borderless: true, radius: 20 }}>
          <Icon as={Ellipsis} size={18} color={theme.text} />
        </Press>
      ) : null}
    </View>
  );
}

function tintFor(theme: Theme, key: string, outcome?: Outcome): { fg: string; bg: string } {
  if (outcome?.tone === 'error') return { fg: theme.danger, bg: theme.dangerSoft };
  if (outcome?.tone === 'run') return { fg: theme.blue, bg: theme.blueSoft };
  switch (key) {
    case 'terminal':
      return { fg: theme.text, bg: theme.surfaceSoft };
    case 'read':
      return { fg: theme.blue, bg: theme.blueSoft };
    case 'search':
      return { fg: theme.success, bg: theme.successSoft };
    case 'edit':
      return { fg: theme.warning, bg: theme.warningSoft };
    case 'agent':
    case 'reasoning':
      return { fg: theme.violet, bg: theme.violetSoft };
    case 'interaction':
      return { fg: theme.warning, bg: theme.warningSoft };
    default:
      return { fg: theme.subtle, bg: theme.surfaceSoft };
  }
}

// ---------------------------------------------------------------------------------------------
// 工具详情

function ToolDetail({ theme, op, bottom, toast, uuid, event }: { theme: Theme; op: Operation; bottom: number; toast(m: string): void; uuid: string; event?: any }) {
  const p = op.payload || {};
  // b2：批量调用（一次模型返回多个工具调用）——按 Web toolBatchLabel 切换，参数/结果跟随
  const batchSize = event ? toolBatchSize(event) : 0;
  const [batchIndex, setBatchIndex] = useState(0);
  const batchLabels = useMemo(() => (batchSize > 1 ? Array.from({ length: batchSize }, (_, i) => toolBatchLabel(event, i)) : []), [event, batchSize]);
  const batchCall = batchSize > 1 ? event?.calls?.[batchIndex] : null;
  const batchResult = batchSize > 1 ? toolResultForIndex(event, batchIndex) : null;
  const name = batchCall?.name || toolNameOf(op);
  const kind = toolKind(name);
  const rawArgs = batchCall ? batchCall.arguments ?? '' : p.arguments ?? p.args ?? p.previewArguments ?? '';
  const resultText = batchSize > 1 ? asText(batchResult ? toolResultText(event, batchResult) : '') : asText(p.resultText ?? p.result ?? p.outputPreview ?? (op.opType === 'context_compaction' ? p.compactedOutput : '') ?? '');
  const isCompaction = op.opType === 'context_compaction' || name === 'ContextCompaction';
  const terminal = kind.key === 'terminal' ? parseTerminalResult(resultText) : null;
  const outcome = toolOutcome(String(op.status || p.status || ''), resultText, terminal?.exitCode ?? null);
  const [tab, setTab] = useState<Tab>('output');
  const [menu, setMenu] = useState(false);

  const argsView = useMemo(() => {
    try {
      return buildToolArgumentsView(name, rawArgs);
    } catch {
      return null;
    }
  }, [name, rawArgs]);

  const outputText = terminal ? terminal.output : resultText;
  const copyOutput = useCallback(async () => {
    tap('light');
    await Clipboard.setStringAsync(outputText || asText(parseMaybeJson(rawArgs)));
    toast('已复制输出');
  }, [outputText, rawArgs, toast]);
  const session = useSession();
  const quote = useCallback(async () => {
    tap('light');
    const head = `${kind.label}${argsView?.summary ? `：${argsView.summary}` : ''}`;
    const [body] = clip(outputText, 4000, 60);
    const block = `> ${head}\n\n\`\`\`\n${body}\n\`\`\``;
    // b2：输入区（b3）接入后直接插入输入框；未接入时复制到剪贴板
    const bridge = session.storeFor(uuid)?.composer;
    if (bridge?.insertReference) {
      bridge.insertReference({ kind: 'message', conversationUuid: uuid, opId: op.opId, title: head.slice(0, 70) });
      toast('已引用到输入框');
      return;
    }
    await Clipboard.setStringAsync(block);
    toast('已复制引用，可粘贴到输入框');
  }, [kind.label, argsView, outputText, toast, session, uuid, op.opId]);
  const copyRaw = useCallback(async () => {
    await Clipboard.setStringAsync(JSON.stringify(op, null, 2));
    toast('已复制原始 JSON');
  }, [op, toast]);
  const copyArgs = useCallback(async () => {
    await Clipboard.setStringAsync(asText(parseMaybeJson(rawArgs)));
    toast('已复制参数');
  }, [rawArgs, toast]);

  const onMore = () => {
    tap('light');
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ options: ['复制参数', '复制原始 JSON', '取消'], cancelButtonIndex: 2 }, (index) => {
        if (index === 0) void copyArgs();
        if (index === 1) void copyRaw();
      });
    } else setMenu(true);
  };

  const meta = [formatDuration(durationOf(op)), formatClock(Number(op.createdAtMs || p.startedAtMs || 0)), tab === 'args' ? sizeLabel(asText(parseMaybeJson(rawArgs))) : sizeLabel(outputText)];
  const title = isCompaction ? '上下文压缩' : kind.key === 'tool' ? shortToolName(name) : kind.label;

  return (
    <>
      <Header theme={theme} icon={kind.icon} tint={tintFor(theme, kind.key, outcome)} title={title} outcome={outcome} meta={meta} onMore={onMore} />
      <View style={styles.segWrap}>
        <Segmented
          theme={theme}
          items={[
            { key: 'output', label: '输出' },
            { key: 'args', label: '参数' },
            { key: 'raw', label: '原始' },
          ]}
          value={tab}
          onChange={(key) => setTab(key as Tab)}
        />
      </View>
      {batchLabels.length > 1 ? <View style={{ paddingHorizontal: 20 }}><BatchTabs theme={theme} labels={batchLabels} value={batchIndex} onChange={setBatchIndex} /></View> : null}
      <ScrollView style={styles.flex} contentContainerStyle={[styles.body, { paddingBottom: 96 + bottom }]} nestedScrollEnabled testID={`detail-tab-${tab}`}>
        {tab === 'output' && isCompaction ? (
          <CompactionView theme={theme} uuid={uuid} op={op} />
        ) : tab === 'output' ? (
          <>
            <AgentInfoView theme={theme} toolName={name} resultText={resultText} />
            <ToolOutput theme={theme} kindKey={kind.key} resultText={resultText} terminal={terminal} argsView={argsView} running={outcome.tone === 'run'} />
          </>
        ) : tab === 'args' ? (
          <ArgsView theme={theme} view={argsView} raw={rawArgs} />
        ) : (
          <MonoBlock theme={theme} text={JSON.stringify(op, null, 2)} wrapDefault={false} testID="detail-raw" />
        )}
      </ScrollView>
      <View style={[styles.actions, { paddingBottom: Math.max(bottom, 12), backgroundColor: theme.panel, borderTopColor: theme.line }]}>
        <ActionButton theme={theme} icon={Copy} label="复制输出" onPress={() => void copyOutput()} testID="detail-copy" />
        <ActionButton theme={theme} icon={TextQuote} label="引用到输入框" onPress={() => void quote()} testID="detail-quote" />
      </View>
      <BottomPanel theme={theme} visible={menu} title="更多" onClose={() => setMenu(false)} testID="detail-more-panel">
        <PanelRow theme={theme} icon={Copy} label="复制参数" onPress={() => { setMenu(false); void copyArgs(); }} />
        <PanelRow theme={theme} icon={FileJson} label="复制原始 JSON" onPress={() => { setMenu(false); void copyRaw(); }} />
      </BottomPanel>
    </>
  );
}

function shortToolName(name: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return mcp ? mcp[2] : name || '工具';
}

function ToolOutput({ theme, kindKey, resultText, terminal, argsView, running }: { theme: Theme; kindKey: string; resultText: string; terminal: ReturnType<typeof parseTerminalResult> | null; argsView: any; running: boolean }) {
  // 命令/路径等关键参数放在输出上方（方向稿：命令、目录结构化显示）
  const primary = primaryRows(argsView, kindKey);
  const summary = primary.length ? <KeyValues theme={theme} rows={primary} compact /> : null;
  if (!resultText.trim()) {
    return (
      <>
        {summary}
        <Text style={[styles.empty, { color: theme.muted }]}>{running ? '正在运行，还没有输出…' : '没有输出'}</Text>
      </>
    );
  }
  if (terminal) {
    return (
      <>
        {summary}
        <MonoBlock theme={theme} text={terminal.output || '（无输出）'} wrapDefault={false} highlightFailures testID="detail-terminal" />
        {terminal.meta.length ? <Text style={[styles.footNote, { color: theme.muted }]}>{terminal.meta.filter((m) => !['status', 'exit_code', 'output_path', 'truncated'].includes(m.key) || (m.key === 'truncated' && m.value === 'true')).map((m) => `${m.key}: ${m.value}`).join('  ·  ')}</Text> : null}
      </>
    );
  }
  if (kindKey === 'read') {
    const file = parseFileResult(resultText);
    if (file) return <FileBlock theme={theme} file={file} />;
  }
  if (kindKey === 'search') {
    const hits = parseSearchResult(resultText);
    if (hits.length) return <SearchList theme={theme} hits={hits} />;
  }
  const json = parseMaybeJson(resultText);
  if (json && typeof json === 'object') {
    const summaryText = typeof (json as any).summary === 'string' ? (json as any).summary : '';
    if (summaryText) return <MarkdownBody theme={theme} markdown={summaryText} />;
    return (
      <>
        {summary}
        <MonoBlock theme={theme} text={JSON.stringify(json, null, 2)} wrapDefault testID="detail-json" />
      </>
    );
  }
  const pairs = parseKeyValueLines(resultText);
  if (pairs) {
    return (
      <>
        {summary}
        <KeyValues theme={theme} rows={pairs.map((pair) => ({ label: pair.key, value: pair.value, mono: true }))} />
      </>
    );
  }
  return (
    <>
      {summary}
      <MarkdownBody theme={theme} markdown={clip(resultText, OUTPUT_LIMIT)[0]} />
    </>
  );
}

function primaryRows(view: any, kindKey: string): Array<{ label: string; value: string; mono?: boolean }> {
  if (!view || view.mode !== 'structured') return [];
  const out: Array<{ label: string; value: string; mono?: boolean }> = [];
  if (kindKey === 'terminal') {
    const command = (view.blocks || []).find((b: any) => b.language === 'bash' || /命令/.test(String(b.label || '')));
    if (command?.content) out.push({ label: '命令', value: String(command.content), mono: true });
    const cwd = (view.tags || []).find((t: any) => t.label === '工作目录');
    if (cwd) out.push({ label: '目录', value: String(cwd.value), mono: true });
  } else {
    for (const row of view.rows || []) if (row.primary) out.push({ label: String(row.label), value: String(row.value), mono: Boolean(row.mono) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 参数

function ArgsView({ theme, view, raw }: { theme: Theme; view: any; raw: unknown }) {
  if (!view || view.mode === 'empty') return <Text style={[styles.empty, { color: theme.muted }]}>没有参数</Text>;
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    ...(view.tags || []).map((t: any) => ({ label: String(t.label), value: String(t.value), mono: Boolean(t.mono) })),
    ...(view.rows || []).map((r: any) => ({ label: String(r.label), value: String(r.value), mono: Boolean(r.mono) })),
  ];
  const blocks: any[] = view.blocks || [];
  if (view.mode === 'raw' && !rows.length) {
    const parsed = parseMaybeJson(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      return <KeyValues theme={theme} rows={entries.map(([key, value]) => ({ label: key, value: asText(value), mono: true }))} />;
    }
  }
  return (
    <View style={{ gap: 12 }} testID="detail-args">
      {rows.length ? <KeyValues theme={theme} rows={rows} /> : null}
      {blocks.map((block, i) => (
        <View key={`${block.label}-${i}`} style={{ gap: 6 }}>
          <Text style={[styles.blockLabel, { color: theme.muted }]}>{String(block.label || '内容')}</Text>
          <MonoBlock theme={theme} text={String(block.content || '')} wrapDefault />
        </View>
      ))}
    </View>
  );
}

/** 键值列表（方向稿 .kv）：左标签 64 宽次要色，右值（等宽可选）；超过 4 行的长值折叠，点按展开。 */
function KeyValues({ theme, rows, compact }: { theme: Theme; rows: Array<{ label: string; value: string; mono?: boolean }>; compact?: boolean }) {
  return (
    <View style={[styles.kv, { backgroundColor: theme.surfaceSoft }, compact && { marginBottom: 12 }]} testID="detail-kv">
      {rows.map((row, i) => (
        <KvRow key={`${row.label}-${i}`} theme={theme} row={row} last={i === rows.length - 1} />
      ))}
    </View>
  );
}

function KvRow({ theme, row, last }: { theme: Theme; row: { label: string; value: string; mono?: boolean }; last: boolean }) {
  const long = row.value.length > 160 || row.value.split('\n').length > 4;
  const [open, setOpen] = useState(false);
  const valueStyle = row.mono ? [MONO, { color: theme.text }] : [styles.kvText, { color: theme.text }];
  return (
    <Pressable onPress={long ? () => setOpen((v) => !v) : undefined} style={[styles.kvRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line }]}>
      <Text style={[styles.kvLabel, { color: theme.muted }]} numberOfLines={2}>
        {row.label}
      </Text>
      <View style={styles.flex}>
        <Text selectable style={valueStyle} numberOfLines={long && !open ? 4 : undefined}>
          {row.value}
        </Text>
        {long ? (
          <View style={styles.expandRow}>
            <Icon as={open ? ChevronUp : ChevronDown} size={13} color={theme.muted} strokeWidth={2} />
            <Text style={[styles.expandText, { color: theme.muted }]}>{open ? '收起' : '展开'}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------------------------
// 输出块

/** 终端风格等宽块：codeBg 底、圆角 12；默认不折行可横向滚动，右上角切换折行；失败行红色。 */
function MonoBlock({ theme, text, wrapDefault, highlightFailures, testID }: { theme: Theme; text: string; wrapDefault: boolean; highlightFailures?: boolean; testID?: string }) {
  const [wrap, setWrap] = useState(wrapDefault);
  const [shown, cut] = useMemo(() => clip(text, OUTPUT_LIMIT, OUTPUT_LINES), [text]);
  const content = useMemo(() => {
    if (!highlightFailures) return shown;
    return shown.split('\n').map((line, i, all) => (
      <Text key={i} style={isFailureLine(line) ? { color: theme.danger } : undefined}>
        {line}
        {i < all.length - 1 ? '\n' : ''}
      </Text>
    ));
  }, [shown, highlightFailures, theme.danger]);
  const body = (
    <Text selectable style={[MONO, { color: theme.text }]}>
      {content}
    </Text>
  );
  return (
    <View style={[styles.mono, { backgroundColor: theme.codeBg }]} testID={testID}>
      <View style={styles.monoTools}>
        <Press onPress={() => setWrap((v) => !v)} accessibilityRole="button" accessibilityLabel={wrap ? '不折行' : '折行'} accessibilityState={{ selected: wrap }} hitSlop={8} style={[styles.monoToggle, wrap && { backgroundColor: theme.selected }]} testID="detail-wrap">
          <Icon as={WrapText} size={15} color={wrap ? theme.textStrong : theme.muted} strokeWidth={2} />
        </Press>
      </View>
      {wrap ? (
        <View style={styles.monoInner}>{body}</View>
      ) : (
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} contentContainerStyle={styles.monoInner}>
          {body}
        </ScrollView>
      )}
      {cut ? <Text style={[styles.cutNote, { color: theme.muted }]}>内容较长，仅显示前 {OUTPUT_LINES} 行 / {OUTPUT_LIMIT.toLocaleString()} 字符；“复制输出”可得到完整内容</Text> : null}
    </View>
  );
}

function FileBlock({ theme, file }: { theme: Theme; file: NonNullable<ReturnType<typeof parseFileResult>> }) {
  const lines = file.lines.slice(0, OUTPUT_LINES);
  const width = Math.max(2, ...lines.map((l) => l.no.length));
  return (
    <View style={{ gap: 8 }} testID="detail-file">
      {file.path ? (
        <Text selectable numberOfLines={2} style={[MONO, styles.filePath, { color: theme.subtle }]}>
          {file.path}
          {file.note ? <Text style={{ color: theme.muted }}>{`  ·  ${file.note}`}</Text> : null}
        </Text>
      ) : null}
      <View style={[styles.mono, { backgroundColor: theme.codeBg }]}>
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} contentContainerStyle={styles.monoInner}>
          <View style={{ flexDirection: 'row' }}>
            <Text style={[MONO, { color: theme.muted, textAlign: 'right', marginRight: 12, minWidth: width * 8 }]}>{lines.map((l) => l.no).join('\n')}</Text>
            <Text selectable style={[MONO, { color: theme.text }]}>
              {lines.map((l) => l.text).join('\n')}
            </Text>
          </View>
        </ScrollView>
        {file.lines.length > lines.length ? <Text style={[styles.cutNote, { color: theme.muted }]}>仅显示前 {OUTPUT_LINES} 行</Text> : null}
      </View>
    </View>
  );
}

function SearchList({ theme, hits }: { theme: Theme; hits: ReturnType<typeof parseSearchResult> }) {
  return (
    <View style={[styles.kv, { backgroundColor: theme.surfaceSoft, paddingVertical: 2 }]} testID="detail-search">
      {hits.map((hit, i) => (
        <View key={`${hit.url}-${i}`} style={[styles.hit, i < hits.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line }]}>
          <Text selectable numberOfLines={2} style={[styles.hitTitle, { color: theme.textStrong }]}>
            {hit.title}
          </Text>
          {hit.url ? (
            <Text selectable numberOfLines={1} style={[styles.hitUrl, { color: theme.muted }]}>
              {hit.url.replace(/^https?:\/\//, '')}
            </Text>
          ) : null}
          {hit.snippet ? (
            <Text selectable numberOfLines={3} style={[styles.hitSnippet, { color: theme.subtle }]}>
              {hit.snippet}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function MarkdownBody({ theme, markdown, muted }: { theme: Theme; markdown: string; muted?: boolean }) {
  const Body = enrichedRenderer.Component;
  const t = useMemo(() => (muted ? { ...theme, text: theme.subtle, textStrong: theme.text } : theme), [theme, muted]);
  return <Body markdown={markdown || '（无内容）'} blockKind="paragraph" streaming={false} theme={t} selectable />;
}

function ActionButton({ theme, icon, label, onPress, testID }: { theme: Theme; icon: LucideIcon; label: string; onPress(): void; testID?: string }) {
  return (
    <Press onPress={onPress} accessibilityRole="button" style={[styles.actionBtn, { backgroundColor: theme.hover }]} testID={testID}>
      <Icon as={icon} size={16} color={theme.text} />
      <Text style={[styles.actionText, { color: theme.text }]}>{label}</Text>
    </Press>
  );
}

// ---------------------------------------------------------------------------------------------
// 思考 / 助手 / 交互问答

function ReasoningDetail({ theme, op, bottom, detailFailed }: { theme: Theme; op: Operation; bottom: number; detailFailed?: boolean }) {
  const text = opText(op) || (detailFailed ? '思考内容读取失败：网络或服务器暂时不可用，可下拉关闭后重新打开。' : '');
  const active = !op.payload?.complete && op.lifecycle !== 'terminal';
  const tint = tintFor(theme, 'reasoning');
  return (
    <>
      <Header theme={theme} icon={REASONING_KIND.icon} tint={tint} title={REASONING_KIND.label} meta={[active ? '思考中' : formatDuration(durationOf(op)) ? `用时 ${formatDuration(durationOf(op))}` : '', formatClock(Number(op.createdAtMs || 0))]} />
      <ScrollView style={styles.flex} contentContainerStyle={[styles.body, { paddingBottom: 32 + bottom }]} testID="detail-reasoning">
        <MarkdownBody theme={theme} markdown={clip(text, OUTPUT_LIMIT * 2)[0]} muted />
      </ScrollView>
    </>
  );
}

function AgentDetail({ theme, op, bottom, toast }: { theme: Theme; op: Operation; bottom: number; toast(m: string): void }) {
  const p = op.payload || {};
  const task = parseMaybeJson(p.task) || {};
  const result = parseMaybeJson(p.result);
  const args = parseMaybeJson(p.rootArguments ?? p.arguments ?? p.args);
  const title = String(task.title || args?.description || args?.title || task.displayName || 'Agent');
  const status = String(op.status || task.status || p.status || '');
  const statusLabel = String(task.currentStatus || AGENT_STATUS[status] || status || '');
  const summary = typeof result === 'object' && result ? String(result.summary || result.message || '') : String(p.resultText || result || '');
  const events = Array.isArray(parseMaybeJson(p.recentEvents)) ? (parseMaybeJson(p.recentEvents) as any[]) : [];
  const model = String(task.model || (result as any)?.model || '').replace(/^[^/]+\//, '');
  const tools = Number(task.toolCalls || 0);
  const tint = status === 'failed' ? { fg: theme.danger, bg: theme.dangerSoft } : tintFor(theme, 'agent');
  const running = ['running', 'queued', 'resuming', 'pausing', 'stopping'].includes(status);
  const facts = [model && { label: '模型', value: model }, tools && { label: '工具调用', value: `${tools} 次` }, task.costUsd && { label: '花费', value: `$${Number(task.costUsd).toFixed(2)}` }].filter(Boolean) as Array<{ label: string; value: string }>;
  return (
    <>
      <Header theme={theme} icon={toolKind('Agent').icon} tint={tint} title={title} outcome={running ? { tone: 'run', label: statusLabel || '运行中' } : undefined} meta={[running ? '' : `助手 · ${statusLabel || '已结束'}`, formatDuration(Number(task.durationMs || 0) || durationOf(op))]} />
      <ScrollView style={styles.flex} contentContainerStyle={[styles.body, { paddingBottom: 96 + bottom, gap: 14 }]} testID="detail-agent">
        {summary ? <MarkdownBody theme={theme} markdown={clip(summary, OUTPUT_LIMIT)[0]} /> : <Text style={[styles.empty, { color: theme.muted }]}>{running ? '助手还在工作，完成后这里显示结果摘要' : '没有结果摘要'}</Text>}
        {facts.length ? <KeyValues theme={theme} rows={facts} /> : null}
        {events.length ? (
          <View style={{ gap: 6 }}>
            <Text style={[styles.blockLabel, { color: theme.muted }]}>最近进展</Text>
            <View style={[styles.kv, { backgroundColor: theme.surfaceSoft }]}>
              {events.slice(-8).map((ev, i, all) => (
                <View key={`${ev.seq || i}`} style={[styles.eventRow, i < all.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line }]}>
                  <View style={[styles.eventDot, { backgroundColor: i === all.length - 1 && running ? theme.blue : theme.muted }]} />
                  <Text numberOfLines={2} style={[styles.kvText, styles.flex, { color: theme.text }]}>
                    {String(ev.summary || ev.kind || '')}
                  </Text>
                  {ev.ts ? <Text style={[styles.eventTime, { color: theme.muted }]}>{formatClock(Number(ev.ts) * (Number(ev.ts) < 1e12 ? 1000 : 1))}</Text> : null}
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.actions, { paddingBottom: Math.max(bottom, 12), backgroundColor: theme.panel, borderTopColor: theme.line }]}>
        <ActionButton
          theme={theme}
          icon={Copy}
          label="复制结果"
          onPress={() => {
            tap('light');
            void Clipboard.setStringAsync(summary || asText(result)).then(() => toast('已复制结果'));
          }}
          testID="detail-copy"
        />
      </View>
    </>
  );
}

const AGENT_STATUS: Record<string, string> = { completed: '已完成', failed: '失败', cancelled: '已停止', running: '运行中', queued: '排队中', interrupted: '已中断' };

function InteractionDetail({ theme, op, bottom, event }: { theme: Theme; op: Operation; bottom: number; event?: any }) {
  // b2：优先用 web buildUserInteractionView 的只读视图（状态、选中项、附言、每题答案、当时建议、敏感打码）
  let view: any = null;
  try {
    view = buildUserInteractionView(userInteractionEventInput(event || { operation: op }, op));
  } catch {
    view = null;
  }
  if (view && !view.malformed) {
    return (
      <>
        <Header theme={theme} icon={INTERACTION_KIND.icon} tint={tintFor(theme, 'interaction')} title={view.title} meta={[view.statusLabel, formatClock(Number(op.createdAtMs || 0))]} />
        <ScrollView style={styles.flex} contentContainerStyle={[styles.body, { paddingBottom: 32 + bottom }]} testID="detail-interaction">
          <InteractionRecord theme={theme} view={view} />
        </ScrollView>
      </>
    );
  }
  const p = op.payload || {};
  const args = parseMaybeJson(p.arguments ?? p.args) || {};
  const result = parseMaybeJson(p.result) || {};
  const title = String(args.title || p.title || '交互问答');
  const options: Array<{ label: string; value: string }> = (Array.isArray(args.options) ? args.options : []).map((o: any) => (typeof o === 'string' ? { label: o, value: o } : { label: String(o.label || o.value || ''), value: String(o.value || o.label || '') }));
  if (args.action === 'confirm' && !options.length) {
    options.push({ label: String(args.confirmText || '确认'), value: 'confirm' }, { label: String(args.cancelText || '取消'), value: 'cancel' });
  }
  const selectedValues = new Set<string>([...(result.selectedValues || []), ...(result.selectedLabels || [])].map(String));
  if (args.action === 'confirm' && result.decision === 'confirm') selectedValues.add('confirm');
  if (args.action === 'confirm' && result.decision === 'cancel') selectedValues.add('cancel');
  const answerText = String(result.value || result.text || '');
  const status = String(result.status || p.interactionStatus || '');
  const statusLabel = status === 'answered' ? '已回答' : status === 'timeout' ? '已超时' : status === 'cancelled' ? '已取消' : status ? status : '等待回答';
  const tint = tintFor(theme, 'interaction');
  return (
    <>
      <Header theme={theme} icon={INTERACTION_KIND.icon} tint={tint} title={title} meta={[statusLabel, formatClock(Number(op.createdAtMs || 0))]} />
      <ScrollView style={styles.flex} contentContainerStyle={[styles.body, { paddingBottom: 32 + bottom, gap: 12 }]} testID="detail-interaction">
        {args.body ? <MarkdownBody theme={theme} markdown={String(args.body)} /> : null}
        {options.length ? (
          <View style={{ gap: 8 }}>
            {options.map((o, i) => {
              const on = selectedValues.has(o.value) || selectedValues.has(o.label);
              return (
                <View key={`${o.value}-${i}`} style={[styles.opt, { borderColor: on ? theme.textStrong : theme.border, backgroundColor: theme.panel }]}>
                  <View style={[styles.radio, { borderColor: on ? theme.textStrong : theme.border, borderWidth: on ? 5 : 1.5 }]} />
                  <Text style={[styles.kvText, styles.flex, { color: theme.text }]}>{o.label}</Text>
                </View>
              );
            })}
          </View>
        ) : null}
        {answerText ? (
          <View style={{ gap: 6 }}>
            <Text style={[styles.blockLabel, { color: theme.muted }]}>你的回答</Text>
            <View style={[styles.answer, { backgroundColor: theme.bubble }]}>
              <Text selectable style={[styles.answerText, { color: theme.text }]}>
                {answerText}
              </Text>
            </View>
          </View>
        ) : status && status !== 'answered' ? null : !options.length ? <Text style={[styles.empty, { color: theme.muted }]}>还没有回答</Text> : null}
        {result.label && !answerText ? <Text style={[styles.footNote, { color: theme.muted }]}>{String(result.label)}</Text> : null}
      </ScrollView>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function Skeleton({ theme }: { theme: Theme }) {
  const bar = (w: number | `${number}%`, h = 12) => <View style={{ width: w, height: h, borderRadius: 6, backgroundColor: theme.hover }} />;
  return (
    <View style={{ padding: 20, gap: 16 }} testID="detail-loading">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: theme.hover }} />
        <View style={{ gap: 8, flex: 1 }}>
          {bar('36%', 14)}
          {bar('58%', 10)}
        </View>
        <ActivityIndicator color={theme.muted} size="small" />
      </View>
      <View style={{ height: 34, borderRadius: 10, backgroundColor: theme.hover }} />
      <View style={{ height: 160, borderRadius: radius.md, backgroundColor: theme.hover }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12 },
  headIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  headText: { flex: 1, minWidth: 0 },
  headTitle: { fontSize: 17, fontWeight: '600' },
  headMeta: { fontSize: 12.5, marginTop: 2 },
  more: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  segWrap: { paddingHorizontal: 20, paddingBottom: 12 },
  body: { paddingHorizontal: 20, paddingTop: 2 },
  kv: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 2 },
  kvRow: { flexDirection: 'row', gap: 12, paddingVertical: 9 },
  kvLabel: { width: 64, fontSize: typeScale.small, lineHeight: typeScale.monoLine },
  kvText: { fontSize: typeScale.small, lineHeight: typeScale.smallLine },
  expandRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 4 },
  expandText: { fontSize: 12 },
  mono: { borderRadius: radius.md, overflow: 'hidden' },
  monoInner: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12, paddingRight: 44 },
  monoTools: { position: 'absolute', top: 4, right: 4, zIndex: 2 },
  monoToggle: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  cutNote: { fontSize: 12, paddingHorizontal: 14, paddingBottom: 10 },
  filePath: { fontSize: 12.5 },
  blockLabel: { fontSize: 12.5, fontWeight: '500' },
  footNote: { fontSize: 12, marginTop: 8 },
  empty: { fontSize: typeScale.small, paddingVertical: 24, textAlign: 'center' },
  hit: { paddingVertical: 10, gap: 2 },
  hitTitle: { fontSize: typeScale.small, fontWeight: '600', lineHeight: typeScale.smallLine },
  hitUrl: { fontSize: 12 },
  hitSnippet: { fontSize: 13, lineHeight: 19, marginTop: 2 },
  actions: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  actionBtn: { flex: 1, height: 42, borderRadius: 21, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, overflow: 'hidden' },
  actionText: { fontSize: 14, fontWeight: '600' },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  eventDot: { width: 7, height: 7, borderRadius: 4 },
  eventTime: { fontSize: 12, fontVariant: ['tabular-nums'] },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 11 },
  radio: { width: 18, height: 18, borderRadius: 9 },
  answer: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  answerText: { fontSize: typeScale.body, lineHeight: typeScale.bubbleLine },
  errorBox: { padding: 32, alignItems: 'center', gap: 14 },
  errorText: { fontSize: typeScale.small },
  retry: { height: 38, paddingHorizontal: 22, borderRadius: 19, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  retryText: { fontSize: 14, fontWeight: '600' },
});
