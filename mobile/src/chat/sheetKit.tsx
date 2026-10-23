/**
 * 输入区与详情面板共用的小件（只在 sheet 工作包的文件里使用，不属于共享 primitives）：
 * - BottomPanel：共享底部面板 Sheet 的简写（下拉跟手关闭、遮罩同步淡出、键盘跟随）；
 * - PanelRow：面板里的一行（左图标、标题、右侧勾选），Android 涟漪；
 * - useToast：轻提示。Android 用系统 Toast；iOS 用一个淡入淡出的小胶囊；
 * - withAlpha：把 #rrggbb 主题色转成带透明度的 rgba（渐变遮罩的起点需要“同色透明”）。
 */
import type { LucideIcon } from 'lucide-react-native';
import { Check } from 'lucide-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { Icon, Press, tap } from '../ui/primitives';
import { Sheet } from '../ui/Sheet';
import { type Theme, type as typeScale } from '../ui/theme';

export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return color;
  const n = parseInt(hex[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

type PanelProps = {
  theme: Theme;
  visible: boolean;
  title?: string;
  right?: React.ReactNode;
  onClose(): void;
  children: React.ReactNode;
  testID?: string;
};

/** 底部面板：共享 Sheet（ui/Sheet.tsx）的简写，菜单类面板只靠下拉、遮罩、系统返回关闭。 */
export function BottomPanel({ visible, title, right, onClose, children, testID }: PanelProps) {
  return (
    <Sheet visible={visible} title={title} right={right} onClose={onClose} hideClose={Boolean(right)} testID={testID}>
      {children}
    </Sheet>
  );
}

/** 面板中的一行：图标块 + 标题（+ 副标题），选中时右侧打勾。高度 ≥ 52。 */
export function PanelRow({ theme, icon, label, detail, selected, onPress, testID }: { theme: Theme; icon?: LucideIcon; label: string; detail?: string; selected?: boolean; onPress(): void; testID?: string }) {
  return (
    <Press
      onPress={() => {
        tap('select');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      testID={testID}
      style={styles.row}
    >
      {icon ? (
        <View style={[styles.rowIcon, { backgroundColor: theme.surfaceSoft }]}>
          <Icon as={icon} size={18} color={theme.text} />
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: theme.textStrong, fontWeight: selected ? '600' : '400' }]}>{label}</Text>
        {detail ? <Text style={[styles.rowDetail, { color: theme.muted }]}>{detail}</Text> : null}
      </View>
      {selected ? <Icon as={Check} size={18} color={theme.textStrong} strokeWidth={2.2} /> : null}
    </Press>
  );
}

/** 轻提示：返回 [挂载节点, show]。Android 直接用系统 Toast，节点为空。 */
export function useToast(theme: Theme, bottom = 24): [React.ReactNode, (message: string) => void] {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const show = useCallback((text: string) => {
    if (Platform.OS === 'android') {
      ToastAndroid.show(text, ToastAndroid.SHORT);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setMessage(text);
    timer.current = setTimeout(() => setMessage(''), 1600);
  }, []);
  const node = message ? (
    <Animated.View entering={FadeIn.duration(140)} exiting={FadeOut.duration(200)} pointerEvents="none" style={[styles.toast, { bottom, backgroundColor: theme.button }]}>
      <Text style={[styles.toastText, { color: theme.buttonText }]}>{message}</Text>
    </Animated.View>
  ) : null;
  return [node, show];
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 20, paddingVertical: 8 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: typeScale.body },
  rowDetail: { fontSize: typeScale.tiny, marginTop: 1 },
  toast: { position: 'absolute', alignSelf: 'center', borderRadius: 18, paddingHorizontal: 16, height: 36, justifyContent: 'center' },
  toastText: { fontSize: typeScale.small, fontWeight: '500' },
});
