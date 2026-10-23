/**
 * “会话” Tab：按窗口宽度（不是设备类型）切换布局。
 * - < breakpoints.split（900）：手机会话列表（方向稿 ①），点按进入根 Stack 的对话页（盖住 Tab 栏）；
 * - ≥ 900：平板双栏/三栏（方向稿 ⑦，见 ui/SplitLayout.tsx）。
 * 未连接服务器、需要登录时由根布局的 ConnectionGate 处理。
 */
import React from 'react';
import { useWindowDimensions } from 'react-native';

import { PhoneConversationList } from '../../ui/conversations/PhoneConversationList';
import { SplitLayout } from '../../ui/SplitLayout';
import { breakpoints } from '../../ui/theme';

export default function ConversationsTab() {
  const { width } = useWindowDimensions();
  return width >= breakpoints.split ? <SplitLayout /> : <PhoneConversationList />;
}
