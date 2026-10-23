/**
 * 轻提示：Android 用系统 Toast；iOS（及其他）用底部居中的小胶囊，2 秒后淡出。
 * 用法：在根布局挂一次 <ToastHost />，任意处调用 showToast('文字')。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { elevation, type as typeScale, useTheme } from './theme';

type Listener = (text: string) => void;
const listeners = new Set<Listener>();

export function showToast(text: string) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(text, ToastAndroid.SHORT);
    return;
  }
  for (const fn of listeners) fn(text);
}

export function ToastHost() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const fn: Listener = (value) => {
      setText(value);
      if (timer.current) clearTimeout(timer.current);
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => setText(''));
      }, 2000);
    };
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [opacity]);

  if (!text || Platform.OS === 'android') return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.wrap, { paddingBottom: insets.bottom + 96 }]}>
      <Animated.View style={[styles.toast, { opacity, backgroundColor: theme.button }, elevation(theme, 'pop')]}>
        <Text style={[styles.text, { color: theme.buttonText }]}>{text}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { justifyContent: 'flex-end', alignItems: 'center', zIndex: 100 },
  toast: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, maxWidth: 320 },
  text: { fontSize: typeScale.small, fontWeight: '500' },
});
