/**
 * 全屏看图（用户附件、回复里的图片、产物图片共用）：左右滑动切换、双指缩放（Android/iOS 均用 ScrollView 缩放不可靠，
 * 这里用 Reanimated + GestureHandler 的 pinch/pan/双击）、缩小/适应/放大按钮、加载失败可重新读取。
 */
import { Image } from 'expo-image';
import { ChevronLeft, ChevronRight, Maximize, RefreshCw, X, ZoomIn, ZoomOut } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, Press } from '../ui/primitives';

export type ViewerImage = { uri: string; headers?: Record<string, string>; title?: string };

export function ZoomableImage({ image, onSwipe, onFailed, testID }: { image: ViewerImage; onSwipe?: (dir: -1 | 1) => void; onFailed?: (failed: boolean) => void; testID?: string }) {
  const { width, height } = useWindowDimensions();
  const scale = useSharedValue(1);
  const saved = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const sx = useSharedValue(0);
  const sy = useSharedValue(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    scale.value = 1; saved.value = 1; tx.value = 0; ty.value = 0;
    setState('loading');
  }, [image.uri]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onFailed?.(state === 'error'), [state, onFailed]);

  const setScale = (value: number) => {
    const v = Math.max(1, Math.min(5, value));
    scale.value = withTiming(v);
    saved.value = v;
    if (v === 1) {
      tx.value = withTiming(0);
      ty.value = withTiming(0);
    }
  };
  (ZoomableImage as any).last = { zoomIn: () => setScale(saved.value * 1.5), zoomOut: () => setScale(saved.value / 1.5), fit: () => setScale(1) };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, Math.min(5, saved.value * e.scale));
    })
    .onEnd(() => {
      saved.value = scale.value;
      if (scale.value <= 1.01) {
        tx.value = withTiming(0);
        ty.value = withTiming(0);
      }
    });
  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      sx.value = tx.value;
      sy.value = ty.value;
    })
    .onUpdate((e) => {
      if (saved.value > 1) {
        tx.value = sx.value + e.translationX;
        ty.value = sy.value + e.translationY;
      } else tx.value = e.translationX * 0.4;
    })
    .onEnd((e) => {
      if (saved.value <= 1) {
        if (Math.abs(e.translationX) > 70 && onSwipe) runOnJS(onSwipe)(e.translationX < 0 ? 1 : -1);
        tx.value = withTiming(0);
      }
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = saved.value > 1 ? 1 : 2.5;
      scale.value = withTiming(next);
      saved.value = next;
      if (next === 1) {
        tx.value = withTiming(0);
        ty.value = withTiming(0);
      }
    });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }] }));

  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
      <Animated.View style={[styles.stage, { width, height }]} testID={testID}>
        <Animated.View style={[{ width, height }, style]}>
          <Image
            key={`${image.uri}#${attempt}`}
            source={{ uri: image.uri, headers: image.headers }}
            style={{ width, height }}
            contentFit="contain"
            onLoad={() => setState('ready')}
            onError={() => setState('error')}
          />
        </Animated.View>
        {state === 'loading' ? <ActivityIndicator style={StyleSheet.absoluteFill} color="#fff" /> : null}
        {state === 'error' ? (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <Text style={styles.errText}>图片加载失败</Text>
            <Press onPress={() => { setAttempt((n) => n + 1); setState('loading'); }} style={styles.retry} accessibilityRole="button" testID="image-retry">
              <Icon as={RefreshCw} size={15} color="#fff" />
              <Text style={styles.retryText}>重新读取</Text>
            </Press>
          </View>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}

export function ImageViewer({ visible, images, index, onClose }: { visible: boolean; images: ViewerImage[]; index: number; onClose(): void }) {
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState(index);
  useEffect(() => {
    if (visible) setCurrent(index);
  }, [visible, index]);
  if (!visible || !images.length) return null;
  const image = images[Math.max(0, Math.min(images.length - 1, current))];
  const go = (dir: -1 | 1) => setCurrent((i) => Math.max(0, Math.min(images.length - 1, i + dir)));
  const ctl = () => (ZoomableImage as any).last || {};
  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <GestureHandlerRootView style={styles.root}>
        <ZoomableImage image={image} onSwipe={go} testID="image-viewer" />
        <View style={[styles.top, { paddingTop: insets.top + 6 }]}>
          <Text numberOfLines={1} style={styles.counter}>{images.length > 1 ? `${current + 1} / ${images.length}` : image.title || ''}</Text>
          <Press onPress={onClose} style={styles.btn} accessibilityRole="button" accessibilityLabel="关闭" testID="image-close">
            <Icon as={X} size={22} color="#fff" />
          </Press>
        </View>
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 10 }]}>
          {images.length > 1 ? (
            <Press onPress={() => go(-1)} disabled={current === 0} style={[styles.btn, current === 0 && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel="上一张" testID="image-prev">
              <Icon as={ChevronLeft} size={22} color="#fff" />
            </Press>
          ) : null}
          <Press onPress={() => ctl().zoomOut?.()} style={styles.btn} accessibilityRole="button" accessibilityLabel="缩小"><Icon as={ZoomOut} size={20} color="#fff" /></Press>
          <Press onPress={() => ctl().fit?.()} style={styles.btn} accessibilityRole="button" accessibilityLabel="适应"><Icon as={Maximize} size={19} color="#fff" /></Press>
          <Press onPress={() => ctl().zoomIn?.()} style={styles.btn} accessibilityRole="button" accessibilityLabel="放大"><Icon as={ZoomIn} size={20} color="#fff" /></Press>
          {images.length > 1 ? (
            <Press onPress={() => go(1)} disabled={current >= images.length - 1} style={[styles.btn, current >= images.length - 1 && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel="下一张" testID="image-next">
              <Icon as={ChevronRight} size={22} color="#fff" />
            </Press>
          ) : null}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  stage: { overflow: 'hidden', backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  errText: { color: '#ddd', fontSize: 14 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 16, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.16)' },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, backgroundColor: 'rgba(0,0,0,0.35)' },
  counter: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '600', paddingLeft: 6 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'center', gap: 14, paddingTop: 10, backgroundColor: 'rgba(0,0,0,0.35)' },
  btn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
