/**
 * 主导航：原生底部 Tab（expo-router/unstable-native-tabs）。
 * - iOS：系统 UITabBarController（iOS 26 为 Liquid Glass），图标用 SF Symbol；
 * - Android：Material 3 底部导航（react-native-screens Tabs），图标用 Material Symbols（expo-symbols 渲染）；
 *   选中态沿用 OpenBear 中性选中：指示器为中性浅底，图标/文字为强调文字色，不用品牌色。
 * - 外面包 ConnectionGate：没有服务器/需要登录/连不上时，整个 Tab 区域换成添加服务器、登录或重试页面。
 * - 对话页、详情等是根 Stack 上的页面，盖在 Tab 之上，因此进入对话时 Tab 栏自然隐藏。
 * - 宽屏（≥ breakpoints.split）时会话页是三栏布局，左侧已有会话侧栏；Tab 栏仍保留（设置等入口），
 *   iOS 上由系统按尺寸类自动呈现为顶部/侧边栏样式。
 */
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import React from 'react';

import { ConnectionGate } from '../../ui/server/ConnectionGate';
import { useTheme } from '../../ui/theme';

export default function TabLayout() {
  const theme = useTheme();
  return (
    <ConnectionGate>
    <NativeTabs
      backgroundColor={theme.dark ? '#1b1b1b' : theme.bg}
      tintColor={theme.textStrong}
      iconColor={{ default: theme.subtle, selected: theme.textStrong }}
      labelStyle={{ default: { color: theme.subtle, fontSize: 11 }, selected: { color: theme.textStrong, fontSize: 11, fontWeight: '600' } }}
      indicatorColor={theme.selected}
      rippleColor={theme.hover}
      labelVisibilityMode="labeled"
    >
      <NativeTabs.Trigger name="index" contentStyle={{ backgroundColor: theme.bg }}>
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} md="forum" />
        <NativeTabs.Trigger.Label>会话</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="automation" contentStyle={{ backgroundColor: theme.bg }}>
        <NativeTabs.Trigger.Icon sf={{ default: 'bolt', selected: 'bolt.fill' }} md="bolt" />
        <NativeTabs.Trigger.Label>自动化</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="memory" contentStyle={{ backgroundColor: theme.bg }}>
        <NativeTabs.Trigger.Icon sf={{ default: 'bookmark', selected: 'bookmark.fill' }} md="bookmark" />
        <NativeTabs.Trigger.Label>记忆</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" contentStyle={{ backgroundColor: theme.bg }}>
        <NativeTabs.Trigger.Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} md="settings" />
        <NativeTabs.Trigger.Label>设置</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
    </ConnectionGate>
  );
}
