/**
 * 共享底部面板（全 App 统一的详情/操作面板）。
 * - 从底部滑入，遮罩同步淡入；点遮罩、系统返回、右上关闭按钮或下拉都能关闭；
 * - 下拉跟手：只在抓手/标题区域或内容已滚到顶时接管手势，不抢正文滚动和输入；
 *   松手超过阈值或速度够快时从当前位置连续滑出，遮罩同步淡出，否则回弹；
 * - 内容可以是普通视图，也可以用 SheetScroll（内部滚动，顶部下拉时交给面板关闭）；
 * - 键盘：面板随键盘上移（react-native-keyboard-controller），输入框不被遮挡；
 * - 高度：默认按内容自适应，最大 maxHeight（默认屏高 88%）；full 时固定为最大高度。
 * 设计约束见“OpenBear 手机端设计与验收”：沿用现有底部面板模式、下拉关闭跟手、保留明确关闭入口。
 */
import { X } from 'lucide-react-native';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, type ScrollViewProps, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { Easing, type SharedValue, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from './primitives';
import { type Theme, radius, useTheme } from './theme';

type SheetProps = {
  visible: boolean;
  onClose(): void;
  title?: string;
  subtitle?: string;
  /** 标题行右侧（关闭按钮左边）的操作 */
  right?: React.ReactNode;
  /** 底部固定操作区（不随内容滚动） */
  footer?: React.ReactNode;
  children: React.ReactNode;
  /** 固定为最大高度（长内容、编辑器） */
  full?: boolean;
  /** 最大高度占屏高比例，默认 0.88 */
  maxHeight?: number;
  /** 隐藏右上角关闭按钮（简单菜单只靠下拉/遮罩关闭时） */
  hideClose?: boolean;
  /** 入场动画结束后聚焦的输入框（Modal 里的 autoFocus 在 Android 上不会弹出键盘） */
  initialFocus?: React.RefObject<{ focus(): void } | null>;
  testID?: string;
};

type SheetContextValue = { scrollAtTop: SharedValue<boolean>; scrollGesture: ReturnType<typeof Gesture.Native> };
const SheetContext = createContext<SheetContextValue | null>(null);

const CLOSE_DISTANCE = 120;
const CLOSE_VELOCITY = 900;

export function Sheet({ visible, onClose, title, subtitle, right, footer, children, full, maxHeight = 0.88, hideClose, initialFocus, testID }: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const [panelHeight, setPanelHeight] = useState(screenHeight);
  const translate = useSharedValue(screenHeight);
  const fade = useSharedValue(0);
  const scrollAtTop = useSharedValue(true);
  // 拖动开始时决定这次手势是否移动面板：从抓手/标题区开始总是可以，从内容区开始只有内容在顶部时才可以
  const headerHeight = useSharedValue(64);
  const dragAllowed = useSharedValue(false);
  const keyboard = useReanimatedKeyboardAnimation();
  const scrollGesture = useMemo(() => Gesture.Native(), []);

  const finishClose = useCallback(() => {
    setMounted(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translate.value = screenHeight;
      fade.value = 0;
      translate.value = withTiming(0, { duration: 260, easing: Easing.out(Easing.cubic) });
      fade.value = withTiming(1, { duration: 220 });
      if (initialFocus) {
        const timer = setTimeout(() => initialFocus.current?.focus(), 300);
        return () => clearTimeout(timer);
      }
    } else if (mounted) {
      translate.value = withTiming(panelHeight + 40, { duration: 220, easing: Easing.in(Easing.cubic) }, (done) => {
        if (done) runOnJS(setMounted)(false);
      });
      fade.value = withTiming(0, { duration: 220 });
    }
    return undefined;
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // 下拉：从当前位置继续滑出，遮罩跟随位置淡出
  const animateOut = useCallback(
    (velocity = 0) => {
      'worklet';
      const distance = panelHeight + 40;
      const duration = Math.max(140, Math.min(260, ((distance - translate.value) / Math.max(velocity, 900)) * 1000));
      translate.value = withTiming(distance, { duration, easing: Easing.out(Easing.quad) }, (done) => {
        if (done) runOnJS(finishClose)();
      });
      fade.value = withTiming(0, { duration });
    },
    [panelHeight, finishClose, translate, fade],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(8)
        .failOffsetX([-20, 20])
        .simultaneousWithExternalGesture(scrollGesture)
        .onBegin((event) => {
          dragAllowed.value = event.y <= headerHeight.value || scrollAtTop.value;
        })
        .onUpdate((event) => {
          if (!dragAllowed.value) return;
          translate.value = Math.max(0, event.translationY);
          fade.value = 1 - Math.min(1, translate.value / Math.max(1, panelHeight));
        })
        .onEnd((event) => {
          if (!dragAllowed.value) return;
          if (translate.value > CLOSE_DISTANCE || event.velocityY > CLOSE_VELOCITY) animateOut(event.velocityY);
          else {
            translate.value = withSpring(0, { damping: 22, stiffness: 260 });
            fade.value = withTiming(1, { duration: 160 });
          }
        }),
    [scrollGesture, scrollAtTop, headerHeight, dragAllowed, translate, fade, panelHeight, animateOut],
  );

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translate.value + keyboard.height.value }],
  }));
  const maskStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  const context = useMemo(() => ({ scrollAtTop, scrollGesture }), [scrollAtTop, scrollGesture]);
  if (!mounted) return null;
  const limit = Math.round(screenHeight * maxHeight);

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={() => animateOut(0)}>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: theme.mask }, maskStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => animateOut(0)} accessibilityLabel="关闭" testID={testID ? `${testID}-mask` : undefined} />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              styles.panel,
              { backgroundColor: theme.panel, maxHeight: limit, paddingBottom: footer ? 0 : Math.max(insets.bottom, 12) + 6 },
              full ? { height: limit } : null,
              panelStyle,
            ]}
            onLayout={(e) => setPanelHeight(e.nativeEvent.layout.height)}
            testID={testID}
          >
            <View onLayout={(e) => (headerHeight.value = e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
            <View style={styles.grabZone}>
              <View style={[styles.grab, { backgroundColor: theme.border }]} />
            </View>
            {title || !hideClose ? (
              <View style={styles.head}>
                <View style={styles.headText}>
                  {title ? (
                    <Text numberOfLines={1} style={[styles.title, { color: theme.textStrong }]}>
                      {title}
                    </Text>
                  ) : null}
                  {subtitle ? (
                    <Text numberOfLines={1} style={[styles.subtitle, { color: theme.muted }]}>
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
                {right}
                {hideClose ? null : <IconButton icon={X} theme={theme} size={20} color={theme.subtle} label="关闭" onPress={() => animateOut(0)} testID={testID ? `${testID}-close` : undefined} />}
              </View>
            ) : null}
            </View>
            <SheetContext.Provider value={context}>
              <View style={full ? styles.bodyFull : styles.body}>{children}</View>
            </SheetContext.Provider>
            {footer ? <View style={[styles.footer, { borderTopColor: theme.line, paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>{footer}</View> : null}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** 面板内滚动区：滚到顶部时继续下拉会交给面板关闭；否则正常滚动。 */
export function SheetScroll({ children, contentContainerStyle, ...rest }: ScrollViewProps & { children: React.ReactNode }) {
  const context = useContext(SheetContext);
  const body = (
    <ScrollView
      {...rest}
      bounces={false}
      overScrollMode="never"
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16}
      onScroll={(event) => {
        if (context) context.scrollAtTop.value = event.nativeEvent.contentOffset.y <= 0;
        rest.onScroll?.(event);
      }}
      contentContainerStyle={contentContainerStyle}
    >
      {children}
    </ScrollView>
  );
  return context ? <GestureDetector gesture={context.scrollGesture}>{body}</GestureDetector> : body;
}

/** 面板里的分组标题（与设置页分组一致的轻量样式）。 */
export function SheetSection({ theme, title, children }: { theme: Theme; title?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      {title ? <Text style={[styles.sectionTitle, { color: theme.muted }]}>{title}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  /** 绝对定位贴屏幕底（Android edge-to-edge 的 Modal 根节点会带系统栏 padding，flex-end 会离底悬空） */
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    overflow: 'hidden',
  },
  grabZone: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
  grab: { width: 38, height: 5, borderRadius: 3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 20, paddingRight: 8, minHeight: 48 },
  headText: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 12.5, marginTop: 1 },
  body: { flexShrink: 1 },
  bodyFull: { flex: 1 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, paddingHorizontal: 16 },
  section: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10 },
  sectionTitle: { fontSize: 12.5, fontWeight: '500', marginBottom: 6, marginLeft: 4 },
});
