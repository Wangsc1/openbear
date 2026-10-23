/**
 * 会话行（方向稿 ① / ⑦）。
 * - 常规（手机）：34×34 圆角头像块 + 标题(16/600) + 时间 + 两行摘要(13.5) + 元信息（状态 Pill / 目录 / 操作数）+ 未读蓝点；
 * - 紧凑（平板侧栏）：小一号；运行中/等待回答只显示状态 Pill，其余显示一行摘要；选中为中性底色圆角块。
 * 头像块按状态着色：等待回答用警示色轻底；运行中在右上角挂蓝点；其余中性。
 */
import { MessageCircle } from 'lucide-react-native';
import React, { memo } from 'react';
import { type GestureResponderEvent, Platform, StyleSheet, Text, View } from 'react-native';

import type { ConversationSummary } from '../../data/session';
import { Icon, Pill, Press } from '../primitives';
import { type Theme, type as typeScale } from '../theme';
import { NO_FOLDER_PATH, activityMs, folderName, formatListTime, operationCountOf, previewOf, rowState, runningLabel } from './listModel';

export type RowPressInfo = { x: number; y: number };

type Props = {
  item: ConversationSummary;
  theme: Theme;
  compact?: boolean;
  selected?: boolean;
  /** 隐藏顶部分隔线（组内第一行、选中行及其下一行） */
  hideSeparator?: boolean;
  now: number;
  onPress(item: ConversationSummary): void;
  onLongPress?(item: ConversationSummary, at: RowPressInfo): void;
};

export const ConversationRow = memo(function ConversationRow({ item, theme, compact, selected, hideSeparator, now, onPress, onLongPress }: Props) {
  const state = rowState(item);
  const preview = previewOf(item);
  const folder = folderName(item);
  const ops = operationCountOf(item);
  const time = formatListTime(activityMs(item), now);
  const tile = compact ? 32 : 34;
  const waiting = state === 'waiting';

  const pill =
    state === 'running' ? (
      <Pill theme={theme} tone="run" dot label={runningLabel(item, now)} />
    ) : state === 'waiting' ? (
      <Pill theme={theme} tone="wait" label="等待回答" />
    ) : state === 'failed' ? (
      <Pill theme={theme} tone="error" label="失败" />
    ) : null;

  const meta: string[] = [];
  if (!compact && folder !== NO_FOLDER_PATH) meta.push(folder);
  if (!compact && ops > 0) meta.push(`${ops} 条`);

  const showPreview = compact ? !pill && Boolean(preview) : Boolean(preview);
  const handleLongPress = (event: GestureResponderEvent) => onLongPress?.(item, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });

  return (
    <Press
      testID={`conv-${item.conversationUuid.slice(0, 8)}`}
      accessibilityRole="button"
      accessibilityLabel={`${item.title || '新会话'}${waiting ? '，等待回答' : state === 'running' ? '，运行中' : ''}${item.activityUnread ? '，未读' : ''}`}
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={() => onPress(item)}
      onLongPress={onLongPress ? handleLongPress : undefined}
      delayLongPress={380}
      style={[compact ? styles.compact : styles.row, selected && { backgroundColor: theme.selected }]}
      pressedStyle={{ backgroundColor: selected ? theme.selected : theme.hover }}
    >
      {!hideSeparator && !selected ? <View style={[compact ? styles.sepCompact : styles.sep, { backgroundColor: theme.line }]} /> : null}
      <View style={[styles.tile, { width: tile, height: tile, backgroundColor: waiting ? theme.warningSoft : theme.surfaceSoft }]}>
        <Icon as={MessageCircle} size={compact ? 16 : 17} strokeWidth={1.8} color={waiting ? theme.warning : theme.subtle} />
        {state === 'running' ? <View style={[styles.tileDot, { backgroundColor: theme.blue, borderColor: compact ? theme.sidebar : theme.bg }]} /> : null}
      </View>
      <View style={styles.main}>
        <View style={styles.top}>
          <Text numberOfLines={1} style={[compact ? styles.titleCompact : styles.title, { color: theme.textStrong }]}>
            {item.title || '新会话'}
          </Text>
          <Text style={[styles.time, { color: theme.muted }]}>{time}</Text>
        </View>
        {showPreview ? (
          <Text numberOfLines={compact ? 1 : 2} style={[styles.preview, { color: theme.subtle }]}>
            {preview}
          </Text>
        ) : null}
        {pill || meta.length ? (
          <View style={[styles.meta, compact && { marginTop: 4 }]}>
            {pill}
            {meta.length ? (
              <Text numberOfLines={1} style={[styles.metaText, { color: theme.muted }]}>
                {meta.join(' · ')}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      {item.activityUnread ? <View style={[styles.unread, { backgroundColor: theme.blue }]} accessibilityElementsHidden /> : <View style={styles.unreadSpace} />}
    </Press>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 11, paddingLeft: 20, paddingRight: 14, overflow: Platform.OS === 'android' ? 'hidden' : 'visible' },
  compact: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, paddingVertical: 10, paddingLeft: 12, paddingRight: 10, marginHorizontal: 8, borderRadius: 12, overflow: 'hidden' },
  sep: { position: 'absolute', top: 0, left: 66, right: 0, height: StyleSheet.hairlineWidth },
  sepCompact: { position: 'absolute', top: 0, left: 55, right: 10, height: StyleSheet.hairlineWidth },
  tile: { borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  tileDot: { position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  main: { flex: 1, minWidth: 0 },
  top: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, fontSize: typeScale.title, fontWeight: '600', letterSpacing: -0.1 },
  titleCompact: { flex: 1, fontSize: 15, fontWeight: '600' },
  time: { fontSize: 12.5, fontVariant: ['tabular-nums'] },
  preview: { fontSize: typeScale.small, lineHeight: 19.5, marginTop: 3 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, minHeight: 20 },
  metaText: { fontSize: typeScale.tiny, flexShrink: 1 },
  unread: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  unreadSpace: { width: 8 },
});
