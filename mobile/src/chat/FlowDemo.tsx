/**
 * 开发专用：对话流组件演示（入口：Markdown 对照页 mdlab 顶部“流”开关，在 mdlab 内切换显示，不新增路由）。
 * 模拟数据里没有“等待回答”的交互问答，也没有运行中的助手，这里用演示数据展示：
 *  - 交互问答卡片（单选 + 推荐标记 + 补充说明 + 稍后/提交；多选）；提交这一轮不发请求；
 *  - 运行中的助手卡片（循环进度条）与已完成的助手卡片；
 *  - 运行中的时间线（合并读取、失败步骤、思考、当前步骤蓝点）。
 * 视觉件与对话流共用（src/chat/rowParts.tsx），保证演示与真实行一致。
 */
import { ChevronLeft } from 'lucide-react-native';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AgentCard, InteractionCard, TimelineStep, TimelineThought } from './rowParts';
import { GlassBar, IconButton, NAV_ROW_HEIGHT, NavRow } from '../ui/primitives';
import { useTheme } from '../ui/theme';

export function FlowDemo({ onBack }: { onBack(): void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState('');
  const startedAt = useState(() => Date.now() - 130_000)[0];
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }} testID="flowlab">
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + NAV_ROW_HEIGHT + 12, paddingHorizontal: 18, paddingBottom: insets.bottom + 40 }}>
        <Text style={[styles.p, { color: theme.text }]}>GPT 的收紧意见已并入设计文档 v2。下一步是 P0：做一个只有对话页的真实样板，代码按正式工程来写。</Text>
        <View style={styles.gap}>
          <InteractionCard
            theme={theme}
            question="是否按上述范围启动 P0？"
            body="Android 端和样板工程不依赖 Mac，可以先做。"
            options={[{ label: '启动', recommended: true, selected: true }, { label: '调整范围后启动' }, { label: '暂不启动' }]}
            onLater={() => setResult('稍后再答')}
            onSubmit={(selected, note) => setResult(`已选择 ${selected.map((i) => i + 1).join('、') || '无'}${note ? `，补充：${note}` : ''}（演示，不发请求）`)}
            testID="demo-ask"
          />
          {result ? <Text style={[styles.note, { color: theme.muted }]} testID="demo-ask-result">{result}</Text> : null}
        </View>
        <View style={styles.gap}>
          <InteractionCard
            theme={theme}
            question="这次发布要包含哪些平台？"
            body="可多选。"
            multiple
            options={[{ label: 'iPhone', selected: true }, { label: 'iPad', selected: true }, { label: 'Android 手机' }, { label: 'Android 平板', description: '需要先补平板截图' }]}
          />
        </View>
        <View style={styles.gap}>
          <InteractionCard theme={theme} question="Demo4 Phase 0 调查完成：请选择清理基线方案" options={[]} statusLabel="交互问答 · 已超时" />
        </View>
        <View style={[styles.gap, { marginTop: 18 }]}>
          <TimelineStep theme={theme} state="ok" category="read" group label="读取 5 个文件" object="release.py、CHANGELOG.md、pyproject.toml…" duration="3s" />
          <TimelineStep theme={theme} state="ok" category="terminal" label="终端" object="git tag v0.33.0-rc1" duration="1s" />
          <TimelineThought theme={theme} text="版本号和变更说明都已对齐，下一步跑候选包的升级验收，先看旧数据迁移，确认 0.32 的表结构能平滑升级到 0.33。" />
          <TimelineStep theme={theme} state="ok" category="terminal" label="终端" object="release.py start --version 0.33.0" duration="4m" />
          <TimelineStep theme={theme} state="error" category="terminal" label="终端" object="升级验收 seed_upgrade 失败" duration="22s" />
          <TimelineStep theme={theme} state="running" category="read" label="读取" object="acceptance_helpers/seed_upgrade.py" duration="…" />
        </View>
        <View style={styles.gap}>
          <AgentCard theme={theme} title="复核迁移脚本的兼容性" statusKey="running" startedAtMs={startedAt} durationMs={0} current="正在对比 0.32 与 0.33 的表结构差异" />
        </View>
        <View style={styles.gap}>
          <AgentCard theme={theme} title="全审：请求与非流式协议语义" statusKey="completed" startedAtMs={0} durationMs={754_000} current="" />
        </View>
      </ScrollView>
      <GlassBar theme={theme}>
        <NavRow
          theme={theme}
          title="评估原生客户端方案"
          subtitle="等待你的回答"
          subtitleColor={theme.warning}
          left={<IconButton icon={ChevronLeft} size={26} theme={theme} label="返回" onPress={onBack} testID="flowlab-back" />}
        />
      </GlassBar>
    </View>
  );
}

const styles = StyleSheet.create({
  p: { fontSize: 15.5, lineHeight: 26, marginBottom: 6 },
  gap: { marginTop: 10 },
  note: { fontSize: 12.5, marginTop: 8, textAlign: 'center' },
});
