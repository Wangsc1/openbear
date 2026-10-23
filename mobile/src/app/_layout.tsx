/**
 * 根布局：原生 Stack（react-native-screens）+ 安全区 + 手势 + 键盘控制器 + 会话上下文。
 * - 第一层是 (tabs)：原生底部 Tab（会话 / 自动化 / 记忆 / 设置，见 (tabs)/_layout.tsx）；
 * - 对话页、新会话、详情 Sheet、全文页、Markdown 对比页都是根 Stack 上的页面，盖在 Tab 之上（进入对话时 Tab 栏隐藏）；
 * - (tabs) 外面包了 ConnectionGate：没有服务器、需要登录、连不上时显示添加服务器/登录/重试页面；
 *   “服务器”管理页（多服务器）是根 Stack 上的页面，不受连接状态影响。
 * - Android edge-to-edge（SDK 57 强制）：状态栏/手势条区域由页面背景接管；
 *   NavigationBar 按深浅色切换按钮样式（enforceContrast=false，见 app.config.ts）；
 * - 预测性返回：AndroidManifest enableOnBackInvokedCallback=true（app.config.ts），
 *   原生 Stack 的返回与 formSheet 关闭都走系统返回分发；
 * - detail 用系统 Sheet（presentation: 'formSheet'），fulltext 用普通原生页面。
 */
import { NavigationBar } from 'expo-navigation-bar';
import { Stack, router, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SessionProvider, useSession } from '../data/session';
import { ToastHost } from '../ui/Toast';
import { radius, useTheme } from '../ui/theme';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

/**
 * 当前服务器不再可用（退出、令牌失效、切换服务器）时，关掉依赖登录的页面回到 Tab，
 * 由 ConnectionGate 显示登录/重试。“服务器”页不依赖登录，保留。
 */
function SessionBoundary() {
  const session = useSession();
  const pathname = usePathname();
  useEffect(() => {
    if (session.state === 'ready' || session.state === 'loading') return;
    if (pathname === '/servers' || !router.canDismiss()) return;
    router.dismissAll();
  }, [session.state, session.active?.id, pathname]);
  return null;
}

function ThemedStack() {
  const theme = useTheme();
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.bg);
  }, [theme.bg]);
  return (
    <>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <NavigationBar style={theme.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.bg },
          animation: 'default',
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="conversation/[uuid]" />
        <Stack.Screen name="conversation/new" />
        <Stack.Screen name="folder/[id]" />
        <Stack.Screen
          name="detail"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.5, 0.92],
            sheetInitialDetentIndex: 0,
            sheetGrabberVisible: true,
            sheetCornerRadius: radius.sheet,
            contentStyle: { backgroundColor: theme.panel },
          }}
        />
        <Stack.Screen name="fulltext" />
        <Stack.Screen name="agent" />
        <Stack.Screen name="artifact" />
        <Stack.Screen name="mdlab" />
        <Stack.Screen name="servers" />
        <Stack.Screen name="sessions" />
        <Stack.Screen name="editorlab" />
        <Stack.Screen name="uilab" />
        <Stack.Screen name="task-memory/[uuid]" />
        <Stack.Screen name="context-editor/[uuid]" />
      </Stack>
      <SessionBoundary />
      <ToastHost />
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <SessionProvider>
            <ThemedStack />
          </SessionProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
