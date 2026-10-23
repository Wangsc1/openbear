/**
 * 输入区的小件：待发送条（引用胶囊 + 附件块）、大图查看、上下文用量环与用量面板、待处理插话列表。
 */
import { Image } from 'expo-image';
import { Clock3, Coins, FileText, Layers, X } from 'lucide-react-native';
import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, Press } from '../ui/primitives';
import type { Theme } from '../ui/theme';
import { KIND_ICONS } from '../references/ReferencePanel';
import { refDisplay, refTitle, type Ref } from '../references/draftModel';
import { fmtBytes, type contextUsageView, type usageTotals } from '../runconfig/logic';
import { uploadBadge, type SteeringItem, type UploadState } from './sendLogic';
import type { DraftAttachment } from '../drafts/attachmentDrafts';

export type Att = DraftAttachment & { memoryOnly?: boolean };
export const isImage = (a: Att) => String(a.file.type || '').startsWith('image/');

export function PendingStrip({ theme, refs, invalidKeys, attachments, progress, locked, onOpenRef, onRemoveRef, onOpenImage, onRemoveAttachment }: {
  theme: Theme;
  refs: { ref: Ref; uid: string; key: string }[];
  invalidKeys: Set<string>;
  attachments: Att[];
  progress: Record<string, UploadState>;
  locked: Set<string>;
  onOpenRef(uid: string): void;
  onRemoveRef(uid: string): void;
  onOpenImage(a: Att): void;
  onRemoveAttachment(a: Att): void;
}) {
  if (!refs.length && !attachments.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.strip} style={styles.stripScroll} testID="pending-strip">
      {refs.map(({ ref, uid, key }) => {
        const invalid = invalidKeys.has(key);
        const KindIcon = KIND_ICONS[ref.kind] || FileText;
        return (
          <Pressable
            key={uid}
            onPress={() => onOpenRef(uid)}
            style={[styles.refChip, { backgroundColor: invalid ? theme.dangerSoft : theme.hover }]}
            accessibilityRole="button"
            accessibilityLabel={`引用 ${ref.label}，${refTitle(ref)}${invalid ? '，无效' : ''}，点按查看详情`}
            testID="ref-chip"
          >
            <Icon as={KindIcon} size={13} color={invalid ? theme.danger : theme.subtle} strokeWidth={2} />
            <Text numberOfLines={1} style={[styles.chipText, { color: invalid ? theme.danger : theme.text }]}>
              {refDisplay(ref).slice(1)}
            </Text>
            {ref.mode === 'mention' ? <Text style={[styles.scope, { color: theme.muted }]}>仅提及</Text> : ref.kind === 'chat' && ref.scope === 'recent' ? <Text style={[styles.scope, { color: theme.muted }]}>{`最近${ref.turns || 20}轮`}</Text> : null}
            <Pressable onPress={() => onRemoveRef(uid)} hitSlop={{ top: 10, bottom: 10, left: 6, right: 8 }} accessibilityRole="button" accessibilityLabel={`移除引用 ${ref.label}`} style={styles.chipX} testID="ref-chip-remove">
              <Icon as={X} size={13} color={theme.muted} strokeWidth={2.2} />
            </Pressable>
          </Pressable>
        );
      })}
      {attachments.map((a) => {
        const state = progress[a.id];
        const badge = uploadBadge(state);
        const busy = locked.has(a.id);
        return (
          <View key={a.id} style={[styles.att, { backgroundColor: theme.hover, borderColor: state?.phase === 'failed' ? theme.danger : 'transparent' }]} testID="attachment-tile">
            {isImage(a) ? (
              <Pressable onPress={() => onOpenImage(a)} accessibilityRole="imagebutton" accessibilityLabel={`查看图片 ${a.file.name}`} testID="attachment-image">
                <Image source={{ uri: a.file.uri }} style={styles.thumb} contentFit="cover" />
              </Pressable>
            ) : (
              <View style={styles.fileTile}>
                <Icon as={FileText} size={16} color={theme.subtle} />
                <View style={styles.fileText}>
                  <Text numberOfLines={1} style={[styles.fileName, { color: theme.text }]}>
                    {a.file.name}
                  </Text>
                  <Text style={[styles.fileSize, { color: theme.muted }]}>{fmtBytes(a.file.size)}{a.memoryOnly ? ' · 未存草稿' : ''}</Text>
                </View>
              </View>
            )}
            {badge ? (
              <View style={[styles.badge, { backgroundColor: state?.phase === 'failed' ? theme.danger : 'rgba(0,0,0,0.62)' }]} testID="attachment-progress">
                <Text style={styles.badgeText}>{badge}</Text>
                {state && state.phase !== 'failed' ? <View style={[styles.track]}><View style={[styles.fill, { width: `${state.percent}%` }]} /></View> : null}
              </View>
            ) : null}
            {!busy ? (
              <Pressable onPress={() => onRemoveAttachment(a)} hitSlop={8} style={[styles.attX, { backgroundColor: theme.dark ? theme.raised : theme.panel }]} accessibilityRole="button" accessibilityLabel={`移除附件 ${a.file.name}`} testID="attachment-remove">
                <Icon as={X} size={12} color={theme.text} strokeWidth={2.4} />
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

export function ImageViewer({ uri, name, onClose }: { uri: string; name: string; onClose(): void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={Boolean(uri)} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.viewer} testID="image-viewer">
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="contain" />
        <View style={[styles.viewerBar, { paddingTop: insets.top + 6 }]}>
          <Text numberOfLines={1} style={styles.viewerName}>
            {name}
          </Text>
          <Pressable onPress={onClose} hitSlop={10} style={styles.viewerClose} accessibilityRole="button" accessibilityLabel="关闭图片" testID="image-viewer-close">
            <Icon as={X} size={22} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** 上下文用量环（尚无实测时为虚线、不显示 0%） */
export function UsageRing({ theme, view, size = 16 }: { theme: Theme; view: ReturnType<typeof contextUsageView>; size?: number }) {
  const r = 9;
  const color = view.tone === 'danger' ? theme.danger : view.tone === 'warning' ? theme.warning : theme.subtle;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: [{ rotate: '-90deg' }] }}>
      <Circle cx={12} cy={12} r={r} stroke={color} strokeOpacity={0.25} strokeWidth={3} fill="none" strokeDasharray={view.known ? undefined : '3 3'} />
      {view.percent !== null ? <Circle cx={12} cy={12} r={r} stroke={color} strokeWidth={3} fill="none" strokeLinecap="round" strokeDasharray={`${(view.fill / 100) * 2 * Math.PI * r} ${2 * Math.PI * r}`} /> : null}
    </Svg>
  );
}

export function UsageDetails({ theme, view, totals, strategy }: { theme: Theme; view: ReturnType<typeof contextUsageView>; totals: ReturnType<typeof usageTotals>; strategy: string }) {
  const rows: [string, string, string?][] = [
    ['已用上下文', view.known ? `${view.used.toLocaleString()} tokens` : '待下次调用实测'],
    ['模型窗口', view.windowLabel],
    [strategy === 'model_summary' ? '摘要压缩阈值' : '滑动窗口阈值', view.thresholdLabel],
  ];
  if (view.percent !== null) rows.push(['阈值占用', view.percentLabel, view.tone]);
  const toneColor = (tone?: string) => (tone === 'danger' ? theme.danger : tone === 'warning' ? theme.warning : theme.text);
  return (
    <View style={styles.usage} testID="usage-details">
      <View style={styles.usageHead}>
        <Text style={[styles.usageTitle, { color: theme.textStrong }]}>上下文用量</Text>
        <Text style={[styles.usageSmall, { color: theme.muted }]}>
          {view.usedLabel} / {view.thresholdLabel}（{view.percentLabel}）
        </Text>
      </View>
      <View style={[styles.bar, { backgroundColor: theme.hover }]}>
        <View style={[styles.barFill, { width: `${view.fill}%`, backgroundColor: toneColor(view.tone) }]} />
      </View>
      {rows.map(([k, v, tone]) => (
        <View key={k} style={styles.usageRow}>
          <Text style={[styles.usageKey, { color: theme.muted }]}>{k}</Text>
          <Text style={[styles.usageValue, { color: toneColor(tone) }]}>{v}</Text>
        </View>
      ))}
      <Text style={[styles.usageSmall, { color: theme.muted, marginTop: 4 }]}>{view.known ? '最近一次模型调用的上下文用量，非累计 Tokens。' : '当前用量尚无有效实测值，不以 0% 代替。'}</Text>
      <View style={[styles.totals, { borderTopColor: theme.line }]} testID="usage-totals">
        <Total theme={theme} icon={Layers} label="总 Tokens" value={`${totals.tokens}（缓存 ${totals.cache}）`} />
        <Total theme={theme} icon={Coins} label="总花费" value={totals.cost} />
        <Total theme={theme} icon={Clock3} label="总耗时" value={totals.duration} />
        <Text style={[styles.usageSmall, { color: theme.muted }]}>{totals.detail}</Text>
      </View>
    </View>
  );
}

function Total({ theme, icon, label, value }: { theme: Theme; icon: typeof Layers; label: string; value: string }) {
  return (
    <View style={styles.usageRow}>
      <View style={styles.totalLabel}>
        <Icon as={icon} size={14} color={theme.muted} />
        <Text style={[styles.usageKey, { color: theme.muted }]}>{label}</Text>
      </View>
      <Text style={[styles.usageValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

export function SteeringList({ theme, items }: { theme: Theme; items: SteeringItem[] }) {
  if (!items.length) return null;
  return (
    <View style={[styles.steer, { backgroundColor: theme.dark ? theme.raised : theme.panel, borderColor: theme.border }]} testID="pending-steering">
      <Text style={[styles.usageSmall, { color: theme.blue }]}>待处理插话 · 等待当前运行处理</Text>
      {items.slice(-3).map((item) => (
        <Text key={item.id} numberOfLines={2} style={[styles.steerText, { color: theme.text }]}>
          {item.text}
        </Text>
      ))}
      {items.length > 3 ? <Text style={[styles.usageSmall, { color: theme.muted }]}>另有 {items.length - 3} 条</Text> : null}
    </View>
  );
}

export function StatusRow({ theme, text, busy, tone }: { theme: Theme; text: string; busy?: boolean; tone?: 'danger' | 'normal' }) {
  if (!text) return null;
  return (
    <View style={styles.status} testID="send-status">
      {busy ? <ActivityIndicator size="small" color={theme.muted} style={styles.spinner} /> : null}
      <Text numberOfLines={2} style={[styles.statusText, { color: tone === 'danger' ? theme.danger : theme.muted }]}>
        {text}
      </Text>
    </View>
  );
}

export function MenuRow({ theme, icon, label, detail, disabled, onPress, testID }: { theme: Theme; icon: typeof Layers; label: string; detail?: string; disabled?: boolean; onPress(): void; testID?: string }) {
  return (
    <Press onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} style={[styles.menuRow, disabled && { opacity: 0.45 }]} testID={testID}>
      <View style={[styles.menuIcon, { backgroundColor: theme.surfaceSoft }]}>
        <Icon as={icon} size={18} color={theme.text} />
      </View>
      <View style={styles.fileText}>
        <Text style={[styles.menuLabel, { color: theme.textStrong }]}>{label}</Text>
        {detail ? <Text style={[styles.usageSmall, { color: theme.muted }]}>{detail}</Text> : null}
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  stripScroll: { marginLeft: -6, marginBottom: 6, flexGrow: 0 },
  strip: { gap: 8, paddingRight: 6, alignItems: 'center' },
  refChip: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingLeft: 10, paddingRight: 6, borderRadius: 15, maxWidth: 240 },
  chipText: { fontSize: 12.5, flexShrink: 1 },
  scope: { fontSize: 11 },
  chipX: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  att: { borderRadius: 12, overflow: 'hidden', borderWidth: 1 },
  thumb: { width: 56, height: 56 },
  fileTile: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 56, paddingLeft: 10, paddingRight: 26, width: 168 },
  fileText: { flex: 1, minWidth: 0 },
  fileName: { fontSize: 12.5 },
  fileSize: { fontSize: 11, marginTop: 2 },
  badge: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 4, paddingVertical: 2 },
  badgeText: { color: '#fff', fontSize: 10.5, fontWeight: '600', textAlign: 'center' },
  track: { height: 2, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 1, marginTop: 1 },
  fill: { height: 2, backgroundColor: '#fff', borderRadius: 1 },
  attX: { position: 'absolute', top: 3, right: 3, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  viewer: { flex: 1, backgroundColor: '#000' },
  viewerBar: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, backgroundColor: 'rgba(0,0,0,0.45)' },
  viewerName: { flex: 1, color: '#fff', fontSize: 15 },
  viewerClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  usage: { paddingHorizontal: 20, paddingTop: 4, gap: 6 },
  usageHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 },
  usageTitle: { fontSize: 15, fontWeight: '600' },
  usageSmall: { fontSize: 12.5, lineHeight: 17 },
  bar: { height: 5, borderRadius: 3, overflow: 'hidden', marginVertical: 6 },
  barFill: { height: 5, borderRadius: 3 },
  usageRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 24 },
  usageKey: { fontSize: 13.5 },
  usageValue: { fontSize: 13.5, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right' },
  totals: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 8, paddingTop: 8, gap: 4 },
  totalLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  steer: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6, gap: 3 },
  steerText: { fontSize: 13.5, lineHeight: 19 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 4 },
  spinner: { transform: [{ scale: 0.75 }] },
  statusText: { fontSize: 12.5, flexShrink: 1 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingHorizontal: 20, paddingVertical: 8 },
  menuIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  menuLabel: { fontSize: 15.5 },
});
