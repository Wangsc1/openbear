/**
 * 共享界面基础件：图标、玻璃导航栏、按压反馈、胶囊标签、状态点。
 * 各页面只用这里的件和 theme.ts 的令牌拼装，保持统一的视觉语言。
 */
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import type { LucideIcon } from 'lucide-react-native';
import React from 'react';
import { Platform, Pressable, type PressableProps, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type Theme, type as typeScale } from './theme';

export { BlurView };

export function Icon({ as: Glyph, size = 22, color, strokeWidth = 1.75 }: { as: LucideIcon; size?: number; color: string; strokeWidth?: number }) {
  return <Glyph size={size} color={color} strokeWidth={strokeWidth} absoluteStrokeWidth={false} />;
}

/** 轻触觉反馈；Android 无对应语义时静默。 */
export function tap(kind: 'light' | 'medium' | 'select' = 'light') {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  if (kind === 'select') void Haptics.selectionAsync();
  else void Haptics.impactAsync(kind === 'medium' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
}

type PressProps = PressableProps & { style?: StyleProp<ViewStyle>; pressedStyle?: StyleProp<ViewStyle> };

/** 统一的按压反馈：降低不透明度；Android 额外使用系统涟漪。 */
export function Press({ style, pressedStyle, android_ripple, ...rest }: PressProps) {
  return (
    <Pressable
      android_ripple={android_ripple ?? (Platform.OS === 'android' ? { color: 'rgba(128,128,128,0.18)', borderless: false } : undefined)}
      style={({ pressed }) => [style, pressed && (pressedStyle ?? { opacity: Platform.OS === 'ios' ? 0.55 : 1 })]}
      {...rest}
    />
  );
}

/** 40×40 圆形图标按钮（导航栏、工具区）。 */
export function IconButton({ icon, theme, onPress, label, active, size = 22, color, testID }: { icon: LucideIcon; theme: Theme; onPress?: () => void; label: string; active?: boolean; size?: number; color?: string; testID?: string }) {
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} testID={testID} style={[styles.iconBtn, active && { backgroundColor: theme.selected }]}>
      <Icon as={icon} size={size} color={color ?? theme.text} />
    </Press>
  );
}

/**
 * 玻璃导航栏：iOS 用系统模糊材质，Android 用半透明画布色（Android 的实时模糊开销大且不是平台习惯）。
 * 绝对定位在页面顶部，内容从下面滑过；返回其总高度供列表设置顶部留白。
 */
export function GlassBar({ theme, children, edge = 'top', style, withInset = true }: { theme: Theme; children: React.ReactNode; edge?: 'top' | 'bottom'; style?: StyleProp<ViewStyle>; withInset?: boolean }) {
  const insets = useSafeAreaInsets();
  const pad = withInset ? (edge === 'top' ? { paddingTop: insets.top } : { paddingBottom: insets.bottom }) : null;
  const rule = edge === 'top' ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line } : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line };
  if (Platform.OS === 'ios') {
    return (
      <BlurView tint={theme.dark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'} intensity={80} style={[styles.glass, edge === 'top' ? styles.top : styles.bottom, pad, rule, style]}>
        {children}
      </BlurView>
    );
  }
  return <View style={[styles.glass, edge === 'top' ? styles.top : styles.bottom, pad, rule, { backgroundColor: theme.glass }, style]}>{children}</View>;
}

/** 导航栏内容行：左按钮 / 居中标题+副标题 / 右按钮。高度 48。 */
export function NavRow({ theme, left, right, title, subtitle, subtitleColor, accessory }: { theme: Theme; left?: React.ReactNode; right?: React.ReactNode; title: string; subtitle?: React.ReactNode; subtitleColor?: string; accessory?: React.ReactNode }) {
  return (
    <View style={styles.navRow}>
      <View style={styles.navSide}>{left}</View>
      <View style={styles.navTitle}>
        <Text numberOfLines={1} style={[styles.navTitleText, { color: theme.textStrong }]}>{title}</Text>
        {subtitle ? (
          <View style={styles.navSubRow}>
            {accessory}
            <Text numberOfLines={1} style={[styles.navSubText, { color: subtitleColor ?? theme.muted }]}>{subtitle}</Text>
          </View>
        ) : null}
      </View>
      <View style={[styles.navSide, { justifyContent: 'flex-end' }]}>{right}</View>
    </View>
  );
}

export const NAV_ROW_HEIGHT = 48;

/** 运行中蓝点（带外圈）。 */
export function RunDot({ theme, size = 6, ring = true }: { theme: Theme; size?: number; ring?: boolean }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: theme.blue, ...(ring ? { borderWidth: 2.5, borderColor: theme.blueSoft, width: size + 5, height: size + 5, borderRadius: (size + 5) / 2 } : null) }} />;
}

export type PillTone = 'run' | 'wait' | 'error' | 'neutral' | 'success';

/** 状态胶囊：运行中 / 等待回答 / 失败 / 中性。 */
export function Pill({ theme, tone, label, dot }: { theme: Theme; tone: PillTone; label: string; dot?: boolean }) {
  const map = {
    run: [theme.blue, theme.blueSoft],
    wait: [theme.warning, theme.warningSoft],
    error: [theme.danger, theme.dangerSoft],
    success: [theme.success, theme.successSoft],
    neutral: [theme.subtle, theme.hover],
  } as const;
  const [fg, bg] = map[tone];
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {dot ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: fg }} /> : null}
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </View>
  );
}

/** 筛选标签（选中为实色反白，未选为细描边）。 */
export function Chip({ theme, label, selected, onPress, leading, testID }: { theme: Theme; label: string; selected?: boolean; onPress?: () => void; leading?: React.ReactNode; testID?: string }) {
  return (
    <Press
      onPress={() => {
        tap('select');
        onPress?.();
      }}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      style={[styles.chip, selected ? { backgroundColor: theme.button, borderColor: 'transparent' } : { borderColor: theme.border }]}
    >
      {leading}
      <Text style={[styles.chipText, { color: selected ? theme.buttonText : theme.subtle, fontWeight: selected ? '600' : '400' }]}>{label}</Text>
    </Press>
  );
}

/** 分段控件（Sheet 内的 输出/参数/原始 等）。 */
export function Segmented({ theme, items, value, onChange }: { theme: Theme; items: { key: string; label: string }[]; value: string; onChange(key: string): void }) {
  return (
    <View style={[styles.seg, { backgroundColor: theme.hover }]}>
      {items.map((item) => {
        const on = item.key === value;
        return (
          <Pressable
            key={item.key}
            onPress={() => {
              tap('select');
              onChange(item.key);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[styles.segItem, on && { backgroundColor: theme.dark ? theme.raised : theme.panel, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 }]}
          >
            <Text style={[styles.segText, { color: on ? theme.textStrong : theme.subtle, fontWeight: on ? '600' : '400' }]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  glass: { position: 'absolute', left: 0, right: 0, zIndex: 10 },
  top: { top: 0 },
  bottom: { bottom: 0 },
  navRow: { height: NAV_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 },
  navSide: { width: 92, flexDirection: 'row', alignItems: 'center' },
  navTitle: { flex: 1, minWidth: 0, alignItems: 'center' },
  navTitleText: { fontSize: typeScale.title, fontWeight: '600' },
  navSubRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
  navSubText: { fontSize: 11.5 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 20, paddingHorizontal: 8, borderRadius: 10, alignSelf: 'flex-start' },
  pillText: { fontSize: 11.5, fontWeight: '600' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  chipText: { fontSize: 13 },
  seg: { flexDirection: 'row', borderRadius: 10, padding: 2 },
  segItem: { flex: 1, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  segText: { fontSize: typeScale.small },
});
