/**
 * 对话流的可复用视觉件（行视图与开发演示页共用）：时间线步骤、助手卡片、交互问答卡片、回复尾部。
 * 只用 theme.ts 的令牌与 primitives 的基础件；尺寸取自方向稿 ui-direction-source.html（.step/.agent/.ask/.ans-foot）。
 */
import * as Clipboard from 'expo-clipboard';
import { Bot, Check, ChevronRight, Copy, FilePen, FileText, Globe, Plus, RotateCcw, Share, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon, Press, tap } from '../ui/primitives';
import type { Theme } from '../ui/theme';
import { elevation, fonts } from '../ui/theme';
import { shortDuration, shortTokens, type ToolCategoryKey } from './timeline';

export const CATEGORY_ICON: Record<ToolCategoryKey, LucideIcon> = {
  read: FileText,
  terminal: SquareTerminal,
  search: Globe,
  edit: FilePen,
  agent: Bot,
  tool: Wrench,
};

/** '#rrggbb' + alpha -> rgba()；非 hex 原样返回。 */
export function withAlpha(color: string, alpha: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function clockLabel(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function useNow(active: boolean, interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [active, interval]);
  return now;
}

// ---------------------------------------------------------------- 时间线

export type StepState = 'ok' | 'error' | 'running';

/** 时间线的竖线 + 节点（每行自己画一段竖线，相邻行拼成一条贯穿的线）。 */
export function TimelineRail({ theme, node }: { theme: Theme; node?: StepState | null }) {
  return (
    <>
      <View pointerEvents="none" style={[styles.rail, { backgroundColor: theme.border }]} />
      {node ? (
        <View
          pointerEvents="none"
          style={[
            styles.node,
            node === 'ok' && { borderColor: theme.muted, backgroundColor: theme.bg },
            node === 'error' && { borderColor: theme.danger, backgroundColor: theme.danger },
            node === 'running' && { borderColor: theme.blue, backgroundColor: theme.blue },
          ]}
        >
          {node === 'running' ? <View style={[styles.nodeRing, { borderColor: theme.blueSoft }]} /> : null}
        </View>
      ) : null}
    </>
  );
}

export function TimelineStep({
  theme, state, category, label, object, duration, onPress, testID, group,
}: {
  theme: Theme;
  state: StepState;
  category: ToolCategoryKey;
  label: string;
  object: string;
  duration: string;
  onPress?: () => void;
  testID?: string;
  /** 合并显示的连续同类步骤（“读取 5 个文件”）：类别名用次要色常规字重 */
  group?: boolean;
}) {
  const tint = state === 'error' ? theme.danger : state === 'running' ? theme.blue : theme.muted;
  return (
    <Press onPress={onPress} style={styles.step} pressedStyle={{ backgroundColor: theme.hover }} accessibilityRole="button" accessibilityLabel={`${label} ${object}`} testID={testID}>
      <TimelineRail theme={theme} node={state} />
      <Icon as={CATEGORY_ICON[category]} size={13} color={tint} strokeWidth={2} />
      <Text
        numberOfLines={1}
        style={[
          styles.stepKey,
          { color: state === 'error' ? theme.danger : group ? theme.subtle : theme.textStrong, fontWeight: group ? '500' : '600' },
        ]}
      >
        {label}
      </Text>
      <Text numberOfLines={1} style={[styles.stepValue, { color: theme.subtle }]}>
        {object}
      </Text>
      {duration ? <Text style={[styles.stepDur, { color: theme.muted }]}>{duration}</Text> : null}
    </Press>
  );
}

/** 思考：两行灰色斜体穿插在时间线里，点按打开详情。 */
export function TimelineThought({ theme, text, active, onPress, testID }: { theme: Theme; text: string; active?: boolean; onPress?: () => void; testID?: string }) {
  return (
    <Press onPress={onPress} style={styles.thought} pressedStyle={{ backgroundColor: theme.hover }} accessibilityRole="button" accessibilityLabel="思考详情" testID={testID}>
      <TimelineRail theme={theme} node={null} />
      <Text numberOfLines={2} style={[styles.thoughtText, { color: active ? theme.text : theme.subtle }]}>
        {text}
      </Text>
    </Press>
  );
}

// ---------------------------------------------------------------- 助手卡片

/** 不确定进度的循环进度条（原生驱动，不占 JS 线程）。 */
function IndeterminateBar({ theme }: { theme: Theme }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(progress, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [progress]);
  const segment = Math.max(40, width * 0.38);
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-segment, width] });
  return (
    <View style={[styles.agentBar, { backgroundColor: theme.line }]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width ? <Animated.View style={{ width: segment, height: '100%', borderRadius: 2, backgroundColor: theme.violet, transform: [{ translateX }] }} /> : null}
    </View>
  );
}

const AGENT_STATUS: Record<string, string> = {
  running: '运行中', resuming: '续跑中', queued: '排队中', completed: '已完成', partial: '部分完成',
  failed: '失败', cancelled: '已取消', interrupted: '已中断', needs_openbear_control: '等待裁决',
};

export function AgentCard({
  theme, title, statusKey, statusLabel, toolName, startedAtMs, durationMs, current, onPress, testID,
}: {
  theme: Theme;
  title: string;
  statusKey: string;
  /** b2：web agentStatusMeta 的状态文案（随工具变化：执行中/指派中/续跑中/停止中…）；不传时用内置映射 */
  statusLabel?: string;
  toolName?: string;
  startedAtMs: number;
  durationMs: number;
  current: string;
  onPress?: () => void;
  testID?: string;
}) {
  const running = statusKey === 'running' || statusKey === 'resuming' || statusKey === 'queued';
  const now = useNow(running);
  const elapsed = running ? (startedAtMs ? now - startedAtMs : 0) : durationMs;
  const failed = statusKey === 'failed';
  const waiting = statusKey === 'needs_openbear_control';
  const role = toolName && toolName !== 'Agent' ? toolName : '助手';
  const sub = [role, statusLabel || AGENT_STATUS[statusKey] || statusKey || '', elapsed > 0 ? (running ? clockLabel(elapsed) : shortDuration(elapsed)) : ''].filter(Boolean).join(' · ');
  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`助手 ${title}`}
      testID={testID}
      style={[styles.agent, { backgroundColor: theme.panel, borderColor: theme.border }, elevation(theme, 'card')]}
      pressedStyle={{ opacity: 0.7 }}
    >
      <View style={styles.agentTop}>
        <View style={[styles.agentAvatar, { backgroundColor: theme.violetSoft }]}>
          <Icon as={Bot} size={17} color={theme.violet} strokeWidth={1.9} />
        </View>
        <View style={styles.agentTitleWrap}>
          <Text numberOfLines={1} style={[styles.agentTitle, { color: theme.textStrong }]}>
            {title}
          </Text>
          <Text numberOfLines={1} style={[styles.agentSub, { color: failed ? theme.danger : running ? theme.blue : waiting ? theme.warning : theme.muted }]}>
            {sub}
          </Text>
        </View>
        {failed ? <Text style={[styles.agentFail, { color: theme.danger, backgroundColor: theme.dangerSoft }]}>未成功</Text> : null}
        <Icon as={ChevronRight} size={16} color={theme.muted} />
      </View>
      {current ? (
        <View style={styles.agentNow}>
          <Icon as={SquareTerminal} size={13} color={theme.subtle} strokeWidth={2} />
          <Text numberOfLines={1} style={[styles.agentNowText, { color: theme.subtle }]}>
            {current}
          </Text>
        </View>
      ) : null}
      {running ? <IndeterminateBar theme={theme} /> : null}
    </Press>
  );
}

// ---------------------------------------------------------------- 交互问答卡片

export type AskOption = { label: string; description?: string; recommended?: boolean; selected?: boolean };

export function InteractionCard({
  theme, question, body, options, multiple, statusLabel, onLater, onSubmit, testID,
}: {
  theme: Theme;
  question: string;
  body?: string;
  options: AskOption[];
  multiple?: boolean;
  /** 已结束的问答：显示结果标签，不再可选 */
  statusLabel?: string;
  onLater?: () => void;
  onSubmit?: (selected: number[], note: string) => void;
  testID?: string;
}) {
  const [selected, setSelected] = useState<number[]>(() => options.map((o, i) => (o.selected ? i : -1)).filter((i) => i >= 0));
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const closed = Boolean(statusLabel);
  const toggle = (index: number) => {
    if (closed) return;
    tap('select');
    setSelected((prev) => (multiple ? (prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]) : [index]));
  };
  return (
    <View
      testID={testID}
      style={[styles.ask, { backgroundColor: theme.panel, borderColor: withAlpha(theme.warning, 0.3) }]}
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(theme.warning, 0.07), borderRadius: 16 }]} />
      <Text style={[styles.askQ, { color: theme.textStrong }]}>{question}</Text>
      {body ? (
        <Text numberOfLines={4} style={[styles.askBody, { color: theme.subtle }]}>
          {body}
        </Text>
      ) : null}
      {options.map((option, index) => {
        const on = selected.includes(index);
        return (
          <Press
            key={`${index}:${option.label}`}
            onPress={() => toggle(index)}
            accessibilityRole={multiple ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: on, disabled: closed }}
            style={[styles.opt, { backgroundColor: theme.panel, borderColor: on ? theme.textStrong : theme.border }]}
            testID={`ask-option-${index}`}
          >
            {multiple ? (
              <View style={[styles.box, on ? { backgroundColor: theme.button, borderColor: theme.button } : { borderColor: theme.border }]}>
                {on ? <Icon as={Check} size={13} color={theme.buttonText} strokeWidth={3} /> : null}
              </View>
            ) : (
              <View style={[styles.radio, on ? { borderColor: theme.textStrong, borderWidth: 5 } : { borderColor: theme.border }]} />
            )}
            <View style={styles.optMain}>
              <Text style={[styles.optText, { color: theme.text }]}>{option.label}</Text>
              {option.description ? <Text style={[styles.optDesc, { color: theme.muted }]}>{option.description}</Text> : null}
            </View>
            {option.recommended ? <Text style={[styles.optRec, { color: theme.success }]}>推荐</Text> : null}
          </Press>
        );
      })}
      {closed ? null : noteOpen ? (
        <TextInput
          value={note}
          onChangeText={setNote}
          autoFocus
          multiline
          placeholder="补充说明…"
          placeholderTextColor={theme.muted}
          style={[styles.opt, styles.noteInput, { backgroundColor: theme.panel, borderColor: theme.border, color: theme.text }]}
          testID="ask-note-input"
        />
      ) : (
        <Press onPress={() => setNoteOpen(true)} style={[styles.opt, { backgroundColor: theme.panel, borderColor: theme.border }]} accessibilityRole="button" testID="ask-note">
          <Icon as={Plus} size={16} color={theme.muted} />
          <Text style={[styles.optText, { color: theme.muted }]}>补充说明…</Text>
        </Press>
      )}
      {closed ? (
        <Text style={[styles.askStatus, { color: theme.muted }]}>{statusLabel}</Text>
      ) : (
        <View style={styles.askActions}>
          <Press onPress={onLater} style={[styles.btn, { backgroundColor: theme.hover }]} accessibilityRole="button" testID="ask-later">
            <Text style={[styles.btnText, { color: theme.text }]}>稍后</Text>
          </Press>
          <Press
            onPress={() => {
              tap('medium');
              onSubmit?.(selected, note);
            }}
            style={[styles.btn, styles.btnPrimary, { backgroundColor: theme.button }]}
            accessibilityRole="button"
            testID="ask-submit"
          >
            <Text style={[styles.btnText, { color: theme.buttonText }]}>提交</Text>
          </Press>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------- 回复尾部

export function AnswerFooter({
  theme, durationMs, inputTokens, outputTokens, getText, testID,
}: {
  theme: Theme;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  getText: () => string;
  testID?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const meta = [shortDuration(durationMs), inputTokens || outputTokens ? `↑${shortTokens(inputTokens)} ↓${shortTokens(outputTokens)}` : ''].filter(Boolean).join(' · ');
  const button = (icon: LucideIcon, label: string, onPress?: () => void, id?: string) => (
    <Press onPress={onPress} hitSlop={3} style={styles.footBtn} accessibilityRole="button" accessibilityLabel={label} testID={id}>
      <Icon as={icon} size={16} color={theme.muted} strokeWidth={1.9} />
    </Press>
  );
  return (
    <View style={styles.foot} testID={testID}>
      {button(copied ? Check : Copy, copied ? '已复制' : '复制', () => {
        tap();
        void Clipboard.setStringAsync(getText()).then(() => setCopied(true));
      }, 'answer-copy')}
      {button(Share, '分享')}
      {button(RotateCcw, '重新生成')}
      {meta ? <Text style={[styles.footMeta, { color: theme.muted }]}>{meta}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // 时间线：内容左缩进 22；竖线在 x=7；节点 9×9 圆心对齐竖线
  rail: { position: 'absolute', left: 7, top: 0, bottom: 0, width: StyleSheet.hairlineWidth * 2 },
  node: { position: 'absolute', left: 3, top: '50%', marginTop: -4.5, width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  nodeRing: { position: 'absolute', width: 15, height: 15, borderRadius: 8, borderWidth: 3 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 36, paddingLeft: 22, overflow: 'hidden' },
  stepKey: { fontSize: 13.5, flexShrink: 0, maxWidth: '45%' },
  stepValue: { fontSize: 13.5, flex: 1, minWidth: 0 },
  stepDur: { fontSize: 12, fontVariant: ['tabular-nums'], flexShrink: 0 },
  thought: { paddingLeft: 22, paddingTop: 4, paddingBottom: 6, overflow: 'hidden' },
  thoughtText: { fontSize: 13.5, lineHeight: 20, fontStyle: 'italic' },
  agent: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12, overflow: 'hidden' },
  agentTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  agentAvatar: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  agentTitleWrap: { flex: 1, minWidth: 0 },
  agentTitle: { fontSize: 14.5, fontWeight: '600' },
  agentSub: { fontSize: 12, marginTop: 1, fontVariant: ['tabular-nums'] },
  agentNow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  agentNowText: { fontSize: 13, flex: 1 },
  agentBar: { height: 2, borderRadius: 1, marginTop: 10, overflow: 'hidden' },
  agentFail: { fontSize: 11, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, overflow: 'hidden' },
  ask: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14, overflow: 'hidden' },
  askQ: { fontSize: 15, fontWeight: '600', lineHeight: 22 },
  askBody: { fontSize: 13, lineHeight: 19.5, marginTop: 4 },
  opt: { marginTop: 8, paddingHorizontal: 12, paddingVertical: 10, minHeight: 42, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 10, overflow: 'hidden' },
  optMain: { flex: 1, minWidth: 0 },
  optText: { fontSize: 14, lineHeight: 20 },
  optDesc: { fontSize: 12, lineHeight: 17, marginTop: 1 },
  optRec: { fontSize: 11, fontWeight: '600' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5 },
  box: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  noteInput: { fontSize: 14, lineHeight: 20, minHeight: 42, textAlignVertical: 'top' },
  askActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  askStatus: { fontSize: 12.5, marginTop: 10 },
  btn: { height: 40, borderRadius: 20, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  btnPrimary: { flex: 1 },
  btnText: { fontSize: 14.5, fontWeight: '600' },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: -9, marginTop: 0, marginBottom: 6 },
  footBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  footMeta: { fontSize: 12, marginLeft: 8, fontVariant: ['tabular-nums'], fontFamily: undefined },
});

export const monoFont = fonts.mono;
