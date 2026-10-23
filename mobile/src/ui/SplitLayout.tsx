/**
 * 平板/宽窗口布局（方向稿 ⑦）：按窗口宽度（不是设备类型）切换。
 * - ≥ breakpoints.split（900）：左侧会话侧栏 + 中间对话（双栏）；
 * - ≥ breakpoints.inspector（1180）：再加右侧“本次运行”检查器（三栏，默认打开）；
 * - 侧栏、检查器都可收起：开关由中栏 ConversationView 的 embedded 导航栏按钮触发（onToggleSidebar / onToggleInspector，
 *   按钮由 flow 工作包实现）。900–1180 之间放不下三栏：打开检查器时自动收起侧栏，反之亦然。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConversationView } from '../chat/ConversationView';
import { useSession } from '../data/session';
import { useTree } from '../tree/treeStore';
import { SidebarTree } from './conversations/SidebarTree';
import { sidebarSections } from './conversations/listModel';
import { RunInspector } from './RunInspector';
import { useTabBottomInset } from './LargeTitle';
import { breakpoints, useTheme } from './theme';

export function SplitLayout() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const bottomInset = useTabBottomInset();
  const { width } = useWindowDimensions();
  const session = useSession();
  const [selected, setSelected] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(() => width >= breakpoints.inspector);
  const roomy = width >= breakpoints.inspector;

  // 跨过三栏断点时（旋转、分屏）按默认值重置检查器
  useEffect(() => {
    setInspectorOpen(roomy);
    if (roomy) setSidebarOpen(true);
  }, [roomy]);

  // 首次进入自动打开上次选中的会话（B1-24：bootstrap 的 selected，只取用户自己发起的会话），没有时取列表第一项
  const treeState = useTree();
  const fallback = useMemo(
    () => treeState.selectedUuid || sidebarSections(session.conversations)[0]?.items[0]?.conversationUuid || '',
    [treeState.selectedUuid, session.conversations],
  );
  const active = selected && session.conversations.some((c) => c.conversationUuid === selected) ? selected : fallback;

  const toggleSidebar = () => {
    setSidebarOpen((open) => {
      if (!open && !roomy) setInspectorOpen(false);
      return !open;
    });
  };
  const toggleInspector = () => {
    setInspectorOpen((open) => {
      if (!open && !roomy) setSidebarOpen(false);
      return !open;
    });
  };

  const sidebarWidth = Math.round(Math.min(320, Math.max(280, width * 0.25)));
  return (
    <View style={[styles.root, { backgroundColor: theme.bg, paddingLeft: insets.left, paddingRight: insets.right }]} testID="split-layout">
      {sidebarOpen ? (
        <View style={[styles.sidebar, { width: sidebarWidth, borderRightColor: theme.line, backgroundColor: theme.sidebar }]}>
          <SidebarTree selected={active} onSelect={setSelected} topInset={insets.top} bottomInset={bottomInset} />
        </View>
      ) : null}
      <View style={[styles.main, { paddingTop: insets.top, paddingBottom: bottomInset }]}>
        {active ? (
          <ConversationView
            key={active}
            uuid={active}
            embedded
            onToggleSidebar={toggleSidebar}
            onToggleInspector={toggleInspector}
          />
        ) : null}
      </View>
      {inspectorOpen && active ? <RunInspector uuid={active} topInset={insets.top} bottomInset={bottomInset} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  sidebar: { borderRightWidth: StyleSheet.hairlineWidth },
  main: { flex: 1, minWidth: 0 },
});
