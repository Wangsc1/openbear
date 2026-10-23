/**
 * “自动化” Tab（本轮占位）：大标题 + 一句说明 + 将来的分组结构（定时任务 / 触发器 / 最近运行），内容为灰色骨架。
 */
import { CalendarClock, Clock, Webhook, Zap } from 'lucide-react-native';
import React from 'react';

import { Group, Row, SkeletonRow, SoonBadge, TabPage } from '../../ui/GroupedList';
import { useTheme } from '../../ui/theme';

export default function AutomationTab() {
  const theme = useTheme();
  return (
    <TabPage title="自动化" subtitle="让 OpenBear 按计划或在事件发生时自动开始会话，结果会出现在会话列表里。" testID="automation-page">
      <Group theme={theme} title="定时任务" footer="例如：每天 9:00 汇总昨夜告警，每周一生成周报。">
        <Row theme={theme} icon={CalendarClock} title="定时任务" accessory={<SoonBadge theme={theme} />} />
        <SkeletonRow theme={theme} icon={Clock} widths={[0.5, 0.75]} />
        <SkeletonRow theme={theme} icon={Clock} widths={[0.62, 0.58]} />
      </Group>
      <Group theme={theme} title="触发器" footer="收到 Webhook、仓库推送或监控告警时自动开始会话。">
        <Row theme={theme} icon={Webhook} title="事件触发" accessory={<SoonBadge theme={theme} />} />
        <SkeletonRow theme={theme} icon={Zap} widths={[0.44, 0.7]} />
      </Group>
      <Group theme={theme} title="最近运行">
        <SkeletonRow theme={theme} widths={[0.66, 0.48]} />
        <SkeletonRow theme={theme} widths={[0.52, 0.64]} />
      </Group>
    </TabPage>
  );
}
