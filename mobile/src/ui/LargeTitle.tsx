/**
 * iOS 风格大标题页面骨架（Tab 页共用：会话 / 自动化 / 记忆 / 设置）。
 * - 顶部导航栏绝对定位：在顶部时透明、无标题；内容上滑越过大标题后，淡入小标题、玻璃底和分隔线（滚动驱动，原生驱动动画）；
 * - 大标题随内容滚动（32 / 700），下拉过度时轻微放大（iOS 习惯）；
 * - 底部留白：Android 的原生 Tab 已把内容区抬到 Tab 栏之上；iOS 的 Tab 栏覆盖在内容上，安全区底部已包含 Tab 栏高度。
 */
import React, { useMemo, useRef } from 'react';
import { Animated, Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BlurView, NAV_ROW_HEIGHT } from './primitives';
import { type Theme, type as typeScale } from './theme';

export const LARGE_TITLE_COLLAPSE = 40;

export function useCollapsingTitle() {
  const scrollY = useRef(new Animated.Value(0)).current;
  const onScroll = useMemo(() => Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true }), [scrollY]);
  return { scrollY, onScroll };
}

/** 页面底部需要额外让出的距离（见文件头说明）。 */
export function useTabBottomInset(): number {
  const insets = useSafeAreaInsets();
  return Platform.OS === 'ios' ? insets.bottom : 0;
}

/** 导航栏总高度（状态栏 + 48）。 */
export function useNavHeight(): number {
  const insets = useSafeAreaInsets();
  return insets.top + NAV_ROW_HEIGHT;
}

export function CollapsingNavBar({ theme, title, scrollY, right, left, testID }: { theme: Theme; title: string; scrollY: Animated.Value; right?: React.ReactNode; left?: React.ReactNode; testID?: string }) {
  const insets = useSafeAreaInsets();
  const shown = scrollY.interpolate({ inputRange: [LARGE_TITLE_COLLAPSE - 12, LARGE_TITLE_COLLAPSE + 6], outputRange: [0, 1], extrapolate: 'clamp' });
  return (
    <View style={[styles.bar, { paddingTop: insets.top }]} testID={testID} pointerEvents="box-none">
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: shown }]}>
        {Platform.OS === 'ios' ? (
          <BlurView tint={theme.dark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'} intensity={80} style={StyleSheet.absoluteFill} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.glass }]} />
        )}
        <View style={[styles.rule, { backgroundColor: theme.line }]} />
      </Animated.View>
      <View style={styles.row}>
        <View style={styles.side}>{left}</View>
        <Animated.Text numberOfLines={1} style={[styles.title, { color: theme.textStrong, opacity: shown }]}>
          {title}
        </Animated.Text>
        <View style={[styles.side, styles.right]}>{right}</View>
      </View>
    </View>
  );
}

export function LargeTitleText({ theme, title, scrollY, style }: { theme: Theme; title: string; scrollY: Animated.Value; style?: StyleProp<ViewStyle> }) {
  const scale = scrollY.interpolate({ inputRange: [-120, 0], outputRange: [1.08, 1], extrapolate: 'clamp' });
  const fade = scrollY.interpolate({ inputRange: [0, LARGE_TITLE_COLLAPSE], outputRange: [1, 0], extrapolate: 'clamp' });
  return (
    <Animated.View style={[styles.largeWrap, style, { opacity: fade, transform: [{ scale }] }]}>
      <Text accessibilityRole="header" style={[styles.large, { color: theme.textStrong }]} numberOfLines={1}>
        {title}
      </Text>
    </Animated.View>
  );
}

/** 组标题（会话分组、设置分组共用）：12.5 / 550 / muted。 */
export function SectionLabel({ theme, title, right, icon, style }: { theme: Theme; title: string; right?: React.ReactNode; icon?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.sec, style]}>
      {icon}
      <Text style={[styles.secText, { color: theme.muted }]} numberOfLines={1}>
        {title}
      </Text>
      {right ? <View style={styles.secRight}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  rule: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  row: { height: NAV_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10 },
  side: { width: 96, flexDirection: 'row', alignItems: 'center', gap: 2 },
  right: { justifyContent: 'flex-end' },
  title: { flex: 1, textAlign: 'center', fontSize: typeScale.title, fontWeight: '600' },
  largeWrap: { paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10, transformOrigin: 'left' },
  large: { fontSize: typeScale.largeTitle, fontWeight: '700', letterSpacing: -0.6 },
  sec: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 14, paddingBottom: 6, paddingHorizontal: 20 },
  secText: { fontSize: 12.5, fontWeight: '600', flexShrink: 1 },
  secRight: { marginLeft: 'auto' },
});
