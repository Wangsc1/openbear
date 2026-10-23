/**
 * 弹出菜单：长按会话的上下文菜单、导航栏按钮的下拉菜单共用。
 * - 自绘（不新增原生依赖）：iOS 外观接近系统上下文菜单（圆角 14、背景轻遮罩），Android 接近 Material 3 菜单（圆角 12、涟漪、无遮罩）；
 * - 菜单贴着触点/按钮出现，空间不够时向上翻；点菜单外或系统返回关闭；
 * - 每项高度 44（触摸区 ≥ 40）。
 */
import type { LucideIcon } from 'lucide-react-native';
import { Check } from 'lucide-react-native';
import React, { useEffect, useRef } from 'react';
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Icon, Press, tap } from './primitives';
import { elevation, type as typeScale, useTheme } from './theme';

export type MenuItem = {
  key: string;
  label: string;
  icon?: LucideIcon;
  destructive?: boolean;
  checked?: boolean;
  /** 在该项之前画一条分组线 */
  separatorBefore?: boolean;
  /** 不可用（灰显、不可点），例如运行中的会话不能删除 */
  disabled?: boolean;
  onPress?: () => void;
};

export type MenuAnchor = { x: number; y: number; /** 锚点高度（按钮），菜单出现在其下方 */ height?: number; align?: 'left' | 'right' };

const ITEM_H = 44;
const WIDTH = 232;

export function ActionMenu({ visible, anchor, items, title, dim = false, onClose }: { visible: boolean; anchor: MenuAnchor | null; items: MenuItem[]; title?: string; dim?: boolean; onClose(): void }) {
  const theme = useTheme();
  const { width, height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      progress.setValue(0);
      Animated.spring(progress, { toValue: 1, useNativeDriver: true, damping: 22, stiffness: 320, mass: 0.7 }).start();
    }
  }, [visible, progress]);

  if (!visible || !anchor) return null;
  const separators = items.filter((i) => i.separatorBefore).length;
  const menuH = items.length * ITEM_H + (title ? 34 : 0) + separators * 9 + 12;
  const below = anchor.y + (anchor.height ?? 0) + 6;
  const top = below + menuH > height - 24 ? Math.max(24, anchor.y - menuH - 6) : below;
  const rawLeft = anchor.align === 'right' ? anchor.x - WIDTH : anchor.x - 24;
  const left = Math.min(Math.max(12, rawLeft), width - WIDTH - 12);
  const ios = Platform.OS === 'ios';

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, dim && { backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.12)' }]} onPress={onClose} accessibilityLabel="关闭菜单" />
      <Animated.View
        testID="action-menu"
        style={[
          styles.menu,
          { top, left, width: WIDTH, backgroundColor: theme.dark ? theme.raised : theme.panel, borderColor: theme.line, borderRadius: ios ? 14 : 12 },
          elevation(theme, 'pop'),
          { opacity: progress, transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] },
        ]}
      >
        {title ? (
          <Text numberOfLines={1} style={[styles.title, { color: theme.muted, borderBottomColor: theme.line }]}>
            {title}
          </Text>
        ) : null}
        {items.map((item) => {
          const color = item.disabled ? theme.disabled : item.destructive ? theme.danger : theme.text;
          return (
            <View key={item.key}>
              {item.separatorBefore ? <View style={[styles.sep, { backgroundColor: theme.line }]} /> : null}
              <Press
                testID={`menu-${item.key}`}
                accessibilityRole="menuitem"
                accessibilityState={{ disabled: Boolean(item.disabled) }}
                disabled={item.disabled}
                onPress={() => {
                  tap('select');
                  onClose();
                  item.onPress?.();
                }}
                style={styles.item}
                pressedStyle={{ backgroundColor: theme.hover }}
              >
                {item.icon ? <Icon as={item.icon} size={18} color={item.disabled ? theme.disabled : item.destructive ? theme.danger : theme.subtle} /> : null}
                <Text numberOfLines={1} style={[styles.label, { color }]}>
                  {item.label}
                </Text>
                {item.checked ? <Icon as={Check} size={17} color={theme.textStrong} /> : null}
              </Press>
            </View>
          );
        })}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  menu: { position: 'absolute', paddingVertical: 6, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  title: { fontSize: typeScale.tiny, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10, marginBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  item: { height: ITEM_H, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  label: { flex: 1, fontSize: 15 },
  sep: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
});
