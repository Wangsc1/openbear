/**
 * iOS 设置风格的分组列表：圆角卡片 + 组标题 + 组脚注；行：图标块 / 标题 / 右侧值或控件 / 箭头。
 * 设置页与自动化、记忆的占位页共用。Tab 页骨架 TabPage：大标题 + 滚动折叠导航栏。
 */
import { ChevronRight } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import React from 'react';
import { Animated, Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CollapsingNavBar, LargeTitleText, useCollapsingTitle, useTabBottomInset } from './LargeTitle';
import { Icon, NAV_ROW_HEIGHT, Press } from './primitives';
import { type Theme, type as typeScale, useTheme } from './theme';

export function TabPage({ title, subtitle, right, children, testID }: { title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode; testID?: string }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const bottomInset = useTabBottomInset();
  const { width } = useWindowDimensions();
  const { scrollY, onScroll } = useCollapsingTitle();
  const navHeight = insets.top + NAV_ROW_HEIGHT;
  // 宽屏下内容限制在可读宽度内居中（与对话中栏一致的克制做法）
  const maxWidth = width >= 900 ? 720 : undefined;
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]} testID={testID}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        contentContainerStyle={{ paddingTop: navHeight, paddingBottom: bottomInset + 32, paddingLeft: insets.left, paddingRight: insets.right }}
        scrollIndicatorInsets={{ top: navHeight, bottom: bottomInset }}
      >
        <View style={[styles.column, maxWidth ? { maxWidth, alignSelf: 'center', width: '100%' } : null]}>
          <LargeTitleText theme={theme} title={title} scrollY={scrollY} />
          {subtitle ? <Text style={[styles.subtitle, { color: theme.subtle }]}>{subtitle}</Text> : null}
          {children}
        </View>
      </Animated.ScrollView>
      <CollapsingNavBar theme={theme} title={title} scrollY={scrollY} right={right} />
    </View>
  );
}

export function Group({ theme, title, footer, children }: { theme: Theme; title?: string; footer?: string; children: React.ReactNode }) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.group}>
      {title ? <Text style={[styles.groupTitle, { color: theme.muted }]}>{title}</Text> : null}
      <View style={[styles.card, { backgroundColor: theme.panel, borderColor: theme.line }]}>
        {rows.map((row, index) => (
          <View key={index}>
            {index > 0 ? <View style={[styles.sep, { backgroundColor: theme.line }]} /> : null}
            {row}
          </View>
        ))}
      </View>
      {footer ? <Text style={[styles.footer, { color: theme.muted }]}>{footer}</Text> : null}
    </View>
  );
}

export function Row({ theme, icon, iconTint, title, subtitle, value, accessory, onPress, chevron, testID, disabled }: { theme: Theme; icon?: LucideIcon; iconTint?: string; title: string; subtitle?: string; value?: string; accessory?: React.ReactNode; onPress?: () => void; chevron?: boolean; testID?: string; disabled?: boolean }) {
  const content = (
    <>
      {icon ? (
        <View style={[styles.iconTile, { backgroundColor: theme.surfaceSoft }]}>
          <Icon as={icon} size={17} strokeWidth={1.8} color={iconTint ?? theme.text} />
        </View>
      ) : null}
      <View style={styles.rowMain}>
        <Text numberOfLines={1} style={[styles.rowTitle, { color: disabled ? theme.muted : theme.text }]}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={2} style={[styles.rowSub, { color: theme.muted }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text numberOfLines={1} style={[styles.value, { color: theme.muted }]}>
          {value}
        </Text>
      ) : null}
      {accessory}
      {chevron ?? Boolean(onPress) ? <Icon as={ChevronRight} size={17} strokeWidth={1.8} color={theme.disabled} /> : null}
    </>
  );
  if (!onPress) return <View style={styles.row} testID={testID}>{content}</View>;
  return (
    <Press onPress={onPress} testID={testID} accessibilityRole="button" accessibilityLabel={title} style={styles.row} pressedStyle={{ backgroundColor: theme.hover }}>
      {content}
    </Press>
  );
}

/** 骨架行：灰色条，用于“即将推出”的占位分组。 */
export function SkeletonRow({ theme, icon, widths = [0.55, 0.8] }: { theme: Theme; icon?: LucideIcon; widths?: [number, number] }) {
  return (
    <View style={styles.row}>
      <View style={[styles.iconTile, { backgroundColor: theme.surfaceSoft }]}>{icon ? <Icon as={icon} size={17} strokeWidth={1.8} color={theme.disabled} /> : null}</View>
      <View style={[styles.rowMain, { gap: 7 }]}>
        <View style={[styles.bar, { width: `${widths[0] * 100}%`, backgroundColor: theme.surfaceSoft }]} />
        <View style={[styles.bar, styles.barThin, { width: `${widths[1] * 100}%`, backgroundColor: theme.hover }]} />
      </View>
    </View>
  );
}

export function SoonBadge({ theme, label = '即将推出' }: { theme: Theme; label?: string }) {
  return (
    <View style={[styles.soon, { backgroundColor: theme.hover }]}>
      <Text style={[styles.soonText, { color: theme.subtle }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  column: { flex: 1 },
  subtitle: { fontSize: typeScale.small, lineHeight: 20, paddingHorizontal: 20, marginTop: -4, marginBottom: 6 },
  group: { marginTop: 18, paddingHorizontal: 16 },
  groupTitle: { fontSize: 12.5, fontWeight: '600', paddingHorizontal: 4, marginBottom: 7 },
  card: { borderRadius: 14, borderWidth: Platform.OS === 'ios' ? 0 : StyleSheet.hairlineWidth, overflow: 'hidden' },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 56 },
  footer: { fontSize: 12, lineHeight: 17, paddingHorizontal: 4, marginTop: 7 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 9 },
  iconTile: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 15.5 },
  rowSub: { fontSize: typeScale.tiny, lineHeight: 16, marginTop: 2 },
  value: { fontSize: 14, maxWidth: '50%' },
  bar: { height: 11, borderRadius: 6 },
  barThin: { height: 9 },
  soon: { height: 22, paddingHorizontal: 9, borderRadius: 11, justifyContent: 'center' },
  soonText: { fontSize: 11.5, fontWeight: '600' },
});
