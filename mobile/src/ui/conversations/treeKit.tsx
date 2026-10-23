/**
 * 会话树的界面件（手机目录页、最近/搜索列表、平板缩进树、选择器共用）：
 * - FolderRow：目录 / 系统节点（临时会话、已归档）行：会话数、待处理数、同级置顶星标、推荐管理标识、运行中蓝点；
 * - TreeConversationRow：会话行：来源图标、运行中蓝点、待处理/命名中/待查看胶囊、未读蓝点、置顶星标、路径；
 * - InlineRow：分支内“加载更多 / 加载失败，点击重试 / 此目录为空”；
 * - ChoiceSheet：多按钮确认（影响确认、草稿归属）；PromptSheet：输入名称（新建目录、重命名）。
 * 手机行 ≥ 56 高，平板树行固定 TREE_ROW_H（拖拽按行高换算落点）。
 */
import type { LucideIcon } from 'lucide-react-native';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Folder,
  FolderOpen,
  MessageCircle,
  MessagesSquare,
  Rocket,
  Star,
  Webhook,
  Wrench,
} from 'lucide-react-native';
import React, { memo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, type TextInput, View } from 'react-native';

import { TextField } from '../Form';
import { Icon, Pill, Press } from '../primitives';
import { Sheet } from '../Sheet';
import { type Theme, radius, type as typeScale, useTheme } from '../theme';
import { ARCHIVE, ORIGIN_LABEL, type Row, TEMP, isRunningRow, originOf, rowBadge } from '../../tree/treeModel';

export const TREE_ROW_H = 44;
export const TREE_INDENT = 16;

const ORIGIN_ICON: Record<string, LucideIcon> = { deployment: Rocket, maintenance: Wrench, cron: Clock, webhook: Webhook, user: MessageCircle };

export type PressAt = { x: number; y: number };

function Check({ theme, on }: { theme: Theme; on: boolean }) {
  return <Icon as={on ? CheckCircle2 : Circle} size={22} strokeWidth={on ? 2.2 : 1.6} color={on ? theme.textStrong : theme.disabled} />;
}

type FolderRowProps = {
  row: Row;
  theme: Theme;
  waiting: number;
  selecting?: boolean;
  checked?: boolean;
  disabled?: boolean;
  /** 平板缩进树 */
  compact?: boolean;
  depth?: number;
  expanded?: boolean;
  highlighted?: boolean;
  dropInside?: boolean;
  busy?: boolean;
  onPress?(row: Row): void;
  onToggle?(row: Row): void;
  onLongPress?(row: Row, at: PressAt): void;
};

export const FolderRow = memo(function FolderRow({ row, theme, waiting, selecting, checked, disabled, compact, depth = 0, expanded, highlighted, dropInside, busy, onPress, onToggle, onLongPress }: FolderRowProps) {
  const system = row.kind === 'system';
  const glyph = system ? (row.id === ARCHIVE ? Archive : MessagesSquare) : expanded ? FolderOpen : Folder;
  const count = system ? Number(row.count || 0) : Number(row.conversationCount || 0);
  const running = Number(row.runningDescendantCount || 0) > 0;
  const name = String(row.name || '目录');
  const label = `${name}，${count} 个会话${waiting ? `，${waiting} 个待处理` : ''}${row.pinned ? '，置顶' : ''}`;
  if (compact) {
    return (
      <Press
        testID={`tree-${system ? row.id : `folder-${String(row.folderId).slice(0, 8)}`}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: Boolean(expanded), selected: Boolean(highlighted) }}
        onPress={() => onPress?.(row)}
        onLongPress={onLongPress ? (e) => onLongPress(row, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }) : undefined}
        delayLongPress={380}
        style={[styles.compact, { paddingLeft: 6 + Math.min(7, depth) * TREE_INDENT }, highlighted && { backgroundColor: theme.selected }, dropInside && { backgroundColor: theme.blueSoft, borderColor: theme.blue, borderWidth: 1 }]}
        pressedStyle={{ backgroundColor: theme.hover }}
      >
        <Press hitSlop={8} onPress={() => onToggle?.(row)} accessibilityLabel={expanded ? '折叠' : '展开'} style={styles.chevron} testID={`tree-toggle-${system ? row.id : String(row.folderId).slice(0, 8)}`}>
          {busy ? <ActivityIndicator size="small" color={theme.muted} /> : <Icon as={expanded ? ChevronDown : ChevronRight} size={15} strokeWidth={2} color={theme.muted} />}
        </Press>
        <Icon as={glyph} size={16} strokeWidth={1.8} color={theme.subtle} />
        <Text numberOfLines={1} style={[styles.compactName, { color: theme.text }]}>
          {name}
        </Text>
        {row.pinned ? <Icon as={Star} size={12} strokeWidth={2.2} color={theme.warning} /> : null}
        {waiting ? <Text style={[styles.compactWait, { color: theme.warning }]}>待处理 {waiting}</Text> : null}
        {running ? <View style={[styles.runDot, { backgroundColor: theme.blue }]} /> : null}
        <Text style={[styles.count, { color: theme.muted }]}>{count}</Text>
      </Press>
    );
  }
  return (
    <Press
      testID={`row-${system ? row.id : `folder-${String(row.folderId).slice(0, 8)}`}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(checked), disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => onPress?.(row)}
      onLongPress={onLongPress ? (e) => onLongPress(row, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }) : undefined}
      delayLongPress={380}
      style={[styles.row, highlighted && { backgroundColor: theme.selected }, disabled && { opacity: 0.45 }]}
      pressedStyle={{ backgroundColor: theme.hover }}
    >
      {selecting ? <Check theme={theme} on={Boolean(checked)} /> : null}
      <View style={[styles.tile, { backgroundColor: theme.surfaceSoft }]}>
        <Icon as={glyph} size={18} strokeWidth={1.7} color={theme.subtle} />
        {running ? <View style={[styles.tileDot, { backgroundColor: theme.blue, borderColor: theme.bg }]} /> : null}
      </View>
      <View style={styles.main}>
        <View style={styles.top}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.textStrong }]}>
            {name}
          </Text>
          {row.pinned ? <Icon as={Star} size={13} strokeWidth={2.2} color={theme.warning} /> : null}
        </View>
        <View style={styles.meta}>
          <Text numberOfLines={1} style={[styles.metaText, { color: theme.muted }]}>
            {count} 个会话
            {row.search && row.path && row.path !== name ? ` · ${row.path}` : ''}
          </Text>
          {waiting ? <Pill theme={theme} tone="wait" label={`待处理 ${waiting}`} /> : null}
        </View>
      </View>
      {selecting ? null : <Icon as={ChevronRight} size={17} strokeWidth={1.8} color={theme.disabled} />}
    </Press>
  );
});

type ConvRowProps = {
  row: Row;
  theme: Theme;
  /** 右上角时间/状态文字 */
  time?: string;
  /** 第二行左侧路径（最近 / 搜索） */
  path?: string;
  generating?: boolean;
  selecting?: boolean;
  checked?: boolean;
  disabled?: boolean;
  highlighted?: boolean;
  compact?: boolean;
  depth?: number;
  dropLine?: 'before' | 'after' | null;
  onPress?(row: Row): void;
  onLongPress?(row: Row, at: PressAt): void;
};

export const TreeConversationRow = memo(function TreeConversationRow({ row, theme, time, path, generating, selecting, checked, disabled, highlighted, compact, depth = 0, dropLine, onPress, onLongPress }: ConvRowProps) {
  const origin = originOf(row);
  const running = isRunningRow(row);
  const badge = rowBadge(row, generating);
  const waiting = badge?.tone === 'wait';
  const title = String(row.title || '新会话');
  const a11y = `${title}${ORIGIN_LABEL[origin] ? `，${ORIGIN_LABEL[origin]}` : ''}${badge ? `，${badge.label}` : ''}${row.activityUnread ? '，未读' : ''}${row.pinned ? '，置顶' : ''}`;
  const tone = badge?.tone === 'neutral' ? 'neutral' : badge?.tone;
  if (compact) {
    return (
      <Press
        testID={`tree-conv-${String(row.conversationUuid).slice(0, 8)}`}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityState={{ selected: Boolean(highlighted) }}
        onPress={() => onPress?.(row)}
        onLongPress={onLongPress ? (e) => onLongPress(row, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }) : undefined}
        delayLongPress={380}
        style={[styles.compact, { paddingLeft: 6 + Math.min(7, depth) * TREE_INDENT + 22 }, highlighted && { backgroundColor: theme.selected }]}
        pressedStyle={{ backgroundColor: theme.hover }}
      >
        {dropLine ? <View style={[styles.dropLine, dropLine === 'before' ? { top: 0 } : { bottom: 0 }, { backgroundColor: theme.blue }]} /> : null}
        <View>
          <Icon as={ORIGIN_ICON[origin]} size={15} strokeWidth={1.8} color={waiting ? theme.warning : theme.subtle} />
          {running && !waiting ? <View style={[styles.miniDot, { backgroundColor: theme.blue, borderColor: theme.sidebar }]} /> : null}
        </View>
        <Text numberOfLines={1} style={[styles.compactName, { color: theme.text, fontWeight: highlighted ? '600' : '400' }]}>
          {title}
        </Text>
        {row.pinned ? <Icon as={Star} size={12} strokeWidth={2.2} color={theme.warning} /> : null}
        {badge && badge.tone !== 'run' ? <Text numberOfLines={1} style={[styles.compactWait, { color: badge.tone === 'wait' ? theme.warning : badge.tone === 'error' ? theme.danger : theme.muted }]}>{badge.label}</Text> : null}
        {row.activityUnread && !running ? <View style={[styles.unread, { backgroundColor: theme.blue }]} /> : null}
      </Press>
    );
  }
  return (
    <Press
      testID={`row-conv-${String(row.conversationUuid).slice(0, 8)}`}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ selected: Boolean(checked), disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => onPress?.(row)}
      onLongPress={onLongPress ? (e) => onLongPress(row, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }) : undefined}
      delayLongPress={380}
      style={[styles.row, highlighted && { backgroundColor: theme.selected }, disabled && { opacity: 0.45 }]}
      pressedStyle={{ backgroundColor: theme.hover }}
    >
      {selecting ? <Check theme={theme} on={Boolean(checked)} /> : null}
      <View style={[styles.tile, { backgroundColor: waiting ? theme.warningSoft : theme.surfaceSoft }]}>
        {generating ? <ActivityIndicator size="small" color={theme.muted} /> : <Icon as={ORIGIN_ICON[origin]} size={17} strokeWidth={1.8} color={waiting ? theme.warning : theme.subtle} />}
        {running && !waiting ? <View style={[styles.tileDot, { backgroundColor: theme.blue, borderColor: theme.bg }]} /> : null}
      </View>
      <View style={styles.main}>
        <View style={styles.top}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.textStrong }]}>
            {title}
          </Text>
          {row.pinned ? <Icon as={Star} size={13} strokeWidth={2.2} color={theme.warning} /> : null}
          {time ? <Text style={[styles.time, { color: theme.muted }]}>{time}</Text> : null}
        </View>
        {badge || path || row.archived ? (
          <View style={styles.meta}>
            {badge ? <Pill theme={theme} tone={tone as any} dot={badge.tone === 'run'} label={badge.label} /> : null}
            {row.archived ? <Pill theme={theme} tone="neutral" label="已归档" /> : null}
            {path ? (
              <Text numberOfLines={1} style={[styles.metaText, { color: theme.muted }]}>
                {path}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      {row.activityUnread && !running ? <View style={[styles.unreadBig, { backgroundColor: theme.blue }]} accessibilityElementsHidden /> : <View style={{ width: 8 }} />}
    </Press>
  );
});

export function InlineRow({ theme, kind, message, busy, depth, compact, onPress }: { theme: Theme; kind: 'more' | 'error' | 'empty'; message?: string; busy?: boolean; depth?: number; compact?: boolean; onPress?(): void }) {
  const text = kind === 'more' ? (busy ? '加载中…' : '加载更多') : kind === 'error' ? '加载失败，点击重试' : '此目录为空';
  const pad = compact ? 6 + Math.min(7, depth || 0) * TREE_INDENT + 22 : 20;
  if (kind === 'empty') {
    return (
      <View style={[compact ? styles.inlineCompact : styles.inline, { paddingLeft: pad }]} testID="tree-empty">
        <Text style={[styles.inlineText, { color: theme.muted }]}>{text}</Text>
      </View>
    );
  }
  return (
    <Press onPress={onPress} disabled={busy} style={[compact ? styles.inlineCompact : styles.inline, { paddingLeft: pad }]} pressedStyle={{ backgroundColor: theme.hover }} testID={kind === 'more' ? 'tree-more' : 'tree-retry'} accessibilityRole="button">
      {busy ? <ActivityIndicator size="small" color={theme.muted} /> : null}
      <Text numberOfLines={2} style={[styles.inlineText, { color: kind === 'error' ? theme.danger : theme.text }]}>
        {text}
        {kind === 'error' && message ? `（${message}）` : ''}
      </Text>
    </Press>
  );
}

export type Choice = { key: string; label: string; tone?: 'primary' | 'danger' | 'plain'; testID?: string };

/** 多选一确认面板。onChoose(null) 表示取消（遮罩、下拉、关闭按钮）。 */
export function ChoiceSheet({ visible, title, message, children, choices, busy, onChoose, testID }: { visible: boolean; title: string; message?: string; children?: React.ReactNode; choices: Choice[]; busy?: string; onChoose(key: string | null): void; testID?: string }) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} title={title} onClose={() => onChoose(null)} testID={testID}>
      <View style={styles.choiceBody}>
        {message ? <Text style={[styles.choiceText, { color: theme.text }]}>{message}</Text> : null}
        {children}
        <View style={styles.choiceButtons}>
          {choices.map((choice) => {
            const primary = choice.tone === 'primary';
            const danger = choice.tone === 'danger';
            const bg = primary ? theme.button : danger ? theme.danger : 'transparent';
            const fg = primary ? theme.buttonText : danger ? '#fff' : theme.text;
            return (
              <Press
                key={choice.key}
                testID={choice.testID || `choice-${choice.key}`}
                disabled={Boolean(busy)}
                onPress={() => onChoose(choice.key)}
                style={[styles.choiceButton, { backgroundColor: bg, borderColor: primary || danger ? 'transparent' : theme.border, opacity: busy && busy !== choice.key ? 0.5 : 1 }]}
                accessibilityRole="button"
              >
                {busy === choice.key ? <ActivityIndicator color={fg} /> : <Text style={[styles.choiceLabel, { color: fg }]}>{choice.label}</Text>}
              </Press>
            );
          })}
        </View>
      </View>
    </Sheet>
  );
}

/** 输入名称（新建目录 / 重命名）：名称必填，提交中禁用并显示指示，失败时在框下显示原因。 */
export function PromptSheet({ visible, title, hint, label = '名称', initial = '', submitLabel = '保存', placeholder, onSubmit, onClose }: { visible: boolean; title: string; hint?: string; label?: string; initial?: string; submitLabel?: string; placeholder?: string; onSubmit(value: string): Promise<void>; onClose(): void }) {
  const theme = useTheme();
  const input = useRef<TextInput>(null);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (visible) {
      setValue(initial);
      setError('');
      setBusy(false);
    }
  }, [visible, initial]);
  const submit = async () => {
    const text = value.trim();
    if (!text) {
      setError('名称不能为空');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit(text);
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible={visible} title={title} onClose={() => !busy && onClose()} initialFocus={input} testID="prompt-sheet">
      <View style={{ paddingHorizontal: 6, paddingBottom: 6 }}>
        {hint ? <Text style={[styles.promptHint, { color: theme.muted }]}>{hint}</Text> : null}
        <TextField ref={input} label={label} value={value} onChangeText={setValue} placeholder={placeholder} error={error} returnKeyType="done" onSubmitEditing={() => void submit()} maxLength={120} testID="prompt-input" />
        <View style={{ paddingHorizontal: 14, paddingTop: 6 }}>
          <Press onPress={() => void submit()} disabled={busy} style={[styles.choiceButton, { backgroundColor: theme.button, opacity: busy ? 0.6 : 1 }]} testID="prompt-submit">
            {busy ? <ActivityIndicator color={theme.buttonText} /> : <Text style={[styles.choiceLabel, { color: theme.buttonText }]}>{submitLabel}</Text>}
          </Press>
        </View>
      </View>
    </Sheet>
  );
}

/** 列表顶部的状态说明（加载失败、空态）。 */
export function ListNotice({ theme, icon, title, hint, action, onAction }: { theme: Theme; icon: LucideIcon; title: string; hint?: string; action?: string; onAction?(): void }) {
  return (
    <View style={styles.notice} testID="tree-notice">
      <Icon as={icon} size={28} strokeWidth={1.5} color={theme.muted} />
      <Text style={[styles.noticeTitle, { color: theme.text }]}>{title}</Text>
      {hint ? <Text style={[styles.noticeHint, { color: theme.muted }]}>{hint}</Text> : null}
      {action ? (
        <Press onPress={onAction} style={[styles.noticeButton, { borderColor: theme.border }]} testID="tree-notice-action">
          <Text style={{ color: theme.text, fontSize: 15 }}>{action}</Text>
        </Press>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingVertical: 9, paddingLeft: 16, paddingRight: 12, overflow: Platform.OS === 'android' ? 'hidden' : 'visible' },
  tile: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  tileDot: { position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  main: { flex: 1, minWidth: 0 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { flexShrink: 1, fontSize: typeScale.title, fontWeight: '600', letterSpacing: -0.1, marginRight: 'auto' },
  time: { fontSize: 12.5, fontVariant: ['tabular-nums'], marginLeft: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, minHeight: 20 },
  metaText: { fontSize: typeScale.tiny, flexShrink: 1 },
  unreadBig: { width: 8, height: 8, borderRadius: 4 },
  compact: { height: TREE_ROW_H, flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 10, marginHorizontal: 6, borderRadius: 10, overflow: 'hidden' },
  chevron: { width: 22, height: 32, alignItems: 'center', justifyContent: 'center', marginRight: -2 },
  compactName: { flex: 1, minWidth: 0, fontSize: 14.5 },
  compactWait: { fontSize: 11.5, fontWeight: '600', maxWidth: 110 },
  count: { fontSize: 12.5, fontVariant: ['tabular-nums'], minWidth: 18, textAlign: 'right' },
  runDot: { width: 6, height: 6, borderRadius: 3 },
  miniDot: { position: 'absolute', top: -3, right: -4, width: 8, height: 8, borderRadius: 4, borderWidth: 1.5 },
  unread: { width: 7, height: 7, borderRadius: 4 },
  dropLine: { position: 'absolute', left: 8, right: 8, height: 2, borderRadius: 1 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingRight: 16 },
  inlineCompact: { flexDirection: 'row', alignItems: 'center', gap: 8, height: TREE_ROW_H, paddingRight: 10, marginHorizontal: 6 },
  inlineText: { fontSize: 14, flexShrink: 1 },
  choiceBody: { paddingHorizontal: 20, paddingBottom: 6, gap: 12 },
  choiceText: { fontSize: 15, lineHeight: 22 },
  choiceButtons: { gap: 10, marginTop: 2 },
  choiceButton: { minHeight: 48, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  choiceLabel: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  promptHint: { fontSize: 13.5, lineHeight: 20, paddingHorizontal: 14, paddingBottom: 4 },
  notice: { alignItems: 'center', paddingTop: 56, paddingHorizontal: 40, gap: 8 },
  noticeTitle: { fontSize: 15, fontWeight: '600', marginTop: 6, textAlign: 'center' },
  noticeHint: { fontSize: 13.5, textAlign: 'center', lineHeight: 20 },
  noticeButton: { marginTop: 8, height: 40, paddingHorizontal: 20, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
});

export { TEMP, ARCHIVE };
