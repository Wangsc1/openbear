/**
 * 开发专用：Markdown 还原度对比页（入口：会话列表顶部“MD”按钮）。
 * 读取模拟后端 /api/mock/md-cases（与 Web 参考夹具 <数据目录>/web-ref 同一批内容），
 * 用 App 的正文渲染器（enriched-markdown）一次渲染一例；“流式”开关按 12 字符/40ms 逐步追加，验证流式更新。
 * 注：开发构建中 openbear://mdlab 深链的 host 会被当作路由导致 Unmatched Route，因此用应用内入口。
 */
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EnrichedMarkdownText } from 'react-native-enriched-markdown';

import { FlowDemo } from '../chat/FlowDemo';
import { enrichedRenderer, markdownStyleFor } from '../chat/markdown/EnrichedBody';
import { useSession } from '../data/session';
import { useTheme } from '../ui/theme';

type Case = { id: string; category: string; markdown: string };

export default function MdLab() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const [cases, setCases] = useState<Case[]>([]);
  const [index, setIndex] = useState(0);
  const [streaming, setStreaming] = useState(false);
  // 对照用：“修复前”直接把原文交给 md4c（不经过 preprocessForMd4c），用于截中文强调修复前后对比
  const [raw, setRaw] = useState(false);
  const [progress, setProgress] = useState(0);
  // 对话流组件演示（交互问答/助手卡片/时间线），见 chat/FlowDemo.tsx
  const [flow, setFlow] = useState(false);

  useEffect(() => {
    if (!session.http) return;
    void session.http.get('/api/mock/md-cases').then((data) => setCases(data?.cases || [])).catch(() => setCases([]));
  }, [session.http]);

  const current = cases[index];
  useEffect(() => {
    setProgress(0);
    if (!streaming || !current) return undefined;
    const total = current.markdown.length;
    const timer = setInterval(() => setProgress((p) => (p >= total ? p : Math.min(total, p + 12))), 40);
    return () => clearInterval(timer);
  }, [streaming, current]);

  const Body = enrichedRenderer.Component;
  if (flow) return <FlowDemo onBack={() => setFlow(false)} />;
  const text = current ? (streaming ? current.markdown.slice(0, progress) : current.markdown) : '';
  const btn = (label: string, id: string, onPress: () => void) => (
    <Pressable testID={id} onPress={onPress} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.hover }}>
      <Text style={{ color: theme.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top }} testID="mdlab">
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 }}>
        {btn('‹', 'mdlab-back', () => router.back())}
        {btn('流', 'open-flowlab', () => setFlow(true))}
        {btn('上一例', 'mdlab-prev', () => setIndex((i) => Math.max(0, i - 1)))}
        {btn('下一例', 'mdlab-next', () => setIndex((i) => Math.min(cases.length - 1, i + 1)))}
        {btn(streaming ? '静态' : '流式', 'mdlab-stream', () => setStreaming((s) => !s))}
        {btn(raw ? '修复前' : '修复后', 'mdlab-raw', () => setRaw((s) => !s))}
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}>
        {current ? (
          <View testID={`md-${current.id}`}>
            <Text style={{ fontSize: 11, color: theme.muted, marginBottom: 6 }} testID="mdlab-label">
              {current.category} · {current.id} ({index + 1}/{cases.length}){streaming ? ` · ${text.length}/${current.markdown.length}` : ''}
            </Text>
            {raw ? (
              <EnrichedMarkdownText flavor="github" markdown={text} markdownStyle={markdownStyleFor(theme)} md4cFlags={{ hardSoftBreaks: true, latexMath: true }} />
            ) : (
              <Body markdown={text} blockKind="paragraph" streaming={streaming && text.length < current.markdown.length} theme={theme} />
            )}
          </View>
        ) : (
          <Text style={{ color: theme.muted }}>加载用例…</Text>
        )}
      </ScrollView>
    </View>
  );
}
