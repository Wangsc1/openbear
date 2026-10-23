/**
 * “记忆” Tab（本轮占位）：大标题 + 一句说明 + 将来的分组结构（长期记忆 / 会话记忆 / 偏好），内容为灰色骨架。
 */
import { Bookmark, Brain, MessageCircle, UserRound } from 'lucide-react-native';
import React from 'react';

import { Group, Row, SkeletonRow, SoonBadge, TabPage } from '../../ui/GroupedList';
import { useTheme } from '../../ui/theme';

export default function MemoryTab() {
  const theme = useTheme();
  return (
    <TabPage title="记忆" subtitle="OpenBear 在会话中记住的事实与偏好。你可以在这里查看、修正或删除。" testID="memory-page">
      <Group theme={theme} title="长期记忆" footer="跨会话生效，例如常用服务器、项目约定。">
        <Row theme={theme} icon={Brain} title="长期记忆" accessory={<SoonBadge theme={theme} />} />
        <SkeletonRow theme={theme} icon={Bookmark} widths={[0.58, 0.82]} />
        <SkeletonRow theme={theme} icon={Bookmark} widths={[0.46, 0.7]} />
        <SkeletonRow theme={theme} icon={Bookmark} widths={[0.64, 0.55]} />
      </Group>
      <Group theme={theme} title="会话记忆" footer="只在所属会话内生效，随会话归档。">
        <Row theme={theme} icon={MessageCircle} title="按会话查看" accessory={<SoonBadge theme={theme} />} />
        <SkeletonRow theme={theme} widths={[0.5, 0.66]} />
      </Group>
      <Group theme={theme} title="偏好">
        <Row theme={theme} icon={UserRound} title="回答风格与语言" accessory={<SoonBadge theme={theme} />} />
      </Group>
    </TabPage>
  );
}
