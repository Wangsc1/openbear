/**
 * Agent 过程记录行（对应 Web AgentActivityList.vue 的手机布局：时间在上、内容在下；工具行点按展开参数与结果；
 * 上下文压缩行展开看事实与摘要）。只负责渲染，数据整理在 agentModel.presentActivityLines。
 */
import { ChevronRight } from 'lucide-react-native';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Icon, Press } from '../../ui/primitives';
import { fonts, type Theme } from '../../ui/theme';
import { enrichedRenderer } from '../markdown/EnrichedBody';
import { presentActivityLines, toneKey } from './agentModel';

export function ActivityList({ theme, lines, emptyText = '暂无过程记录。', compact }: { theme: Theme; lines: any[]; emptyText?: string; compact?: boolean }) {
  const presented = React.useMemo(() => presentActivityLines(lines), [lines]);
  if (!presented.length) {
    return <Text style={[styles.empty, { color: theme.muted, borderColor: theme.border }]}>{emptyText}</Text>;
  }
  return (
    <View style={[styles.list, compact && { gap: 0 }]}>
      <View style={[styles.rail, { backgroundColor: theme.line }]} />
      {presented.map((line) => <ActivityRow key={line.key} theme={theme} line={line} />)}
    </View>
  );
}

function ActivityRow({ theme, line }: { theme: Theme; line: any }) {
  const [open, setOpen] = useState(false);
  const toneColor = (tone: string) => {
    const key = toneKey(tone);
    return key === 'muted' ? theme.muted : theme[key];
  };
  const dot = line.kind === 'agent_control' ? theme.warning : line.processTool ? toneColor(line.processTool.statusTone) : line.processModel ? toneColor(line.processModel.statusTone) : line.tone ? toneColor(line.tone) : theme.muted;
  let body: React.ReactNode;
  if (line.kind === 'context_compaction_compact') {
    const c = line.compaction || {};
    body = (
      <View>
        <Press onPress={() => setOpen((v) => !v)} style={styles.summary} accessibilityRole="button" accessibilityState={{ expanded: open }}>
          <Text numberOfLines={open ? undefined : 2} style={[styles.text, styles.flex, { color: c.failed ? theme.danger : theme.success }]}>{line.message}</Text>
          <Chevron theme={theme} open={open} />
        </Press>
        {open ? (
          <View style={[styles.detail, { borderColor: theme.line }]}>
            {c.summaryId || c.compactionId ? <Text selectable style={[styles.mono, { color: theme.muted }]}>{c.summaryId || c.compactionId}</Text> : null}
            {(c.detailFacts || []).map((fact: string) => <Text key={fact} style={[styles.small, { color: theme.subtle }]}>{fact}</Text>)}
            {c.strategy !== 'sliding_window' ? (
              line.compactedOutput ? <Md theme={theme} text={line.compactedOutput} /> : <Text style={[styles.small, { color: theme.muted }]}>{c.failed ? c.reason || '未生成可用压缩摘要' : line.emptyOutputText || '旧记录未持久化压缩摘要'}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  } else if (line.processModel) {
    const m = line.processModel;
    body = (
      <View>
        <Text style={[styles.text, { color: theme.subtle }]}>
          <Text style={{ color: theme.text, fontWeight: '600' }}>{m.label}</Text>
          {m.thinkLevel ? ` · ${m.thinkLevel}` : ''}
          {m.fastMode ? ' · Fast' : ''}
          {m.description ? <Text style={{ color: theme.muted }}>{` · ${m.description}`}</Text> : null}
          {' · '}
          <Text style={{ color: toneColor(m.statusTone), fontWeight: '600' }}>{m.status}</Text>
        </Text>
        {m.failure ? <Text style={[styles.small, { color: theme.danger }]}>{m.failure}</Text> : null}
      </View>
    );
  } else if (line.processTool) {
    const t = line.processTool;
    body = (
      <View>
        <Press onPress={() => setOpen((v) => !v)} style={styles.summary} accessibilityRole="button" accessibilityState={{ expanded: open }} testID="activity-tool">
          <View style={styles.flex}>
            <Text style={[styles.text, { color: theme.subtle }]}>
              <Text style={{ color: theme.text, fontWeight: '600' }}>{t.label}</Text>
              {'  '}
              <Text style={{ color: toneColor(t.statusTone), fontWeight: '600', fontSize: 12 }}>{t.status}</Text>
            </Text>
            {t.description ? <Text numberOfLines={open ? undefined : 2} style={[styles.small, { color: theme.text }]}>{t.description}</Text> : null}
          </View>
          <Chevron theme={theme} open={open} />
        </Press>
        {open ? (
          <View style={[styles.detail, { borderColor: theme.line }]}>
            {t.fullDescription && t.fullDescription !== t.description ? <Text selectable style={[styles.small, { color: theme.subtle }]}>{t.fullDescription}</Text> : null}
            {t.failure ? <Text selectable style={[styles.small, { color: theme.danger }]}>{t.failure}</Text> : null}
            {t.rawArguments ? (
              <>
                <Text style={[styles.label, { color: theme.muted }]}>参数</Text>
                <Text selectable style={[styles.pre, { color: theme.text, backgroundColor: theme.codeBg }]}>{prettyArgs(t.rawArguments)}</Text>
              </>
            ) : null}
            {t.result ? (
              <>
                <Text style={[styles.label, { color: theme.muted }]}>{t.resultIsPreview ? '结果（已有预览）' : '结果'}</Text>
                <Text selectable numberOfLines={40} style={[styles.pre, { color: theme.text, backgroundColor: theme.codeBg }]}>{t.result}</Text>
              </>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  } else {
    body = (
      <View>
        <Text selectable style={[styles.text, { color: line.tone === 'success' ? theme.success : line.tone === 'danger' ? theme.danger : theme.text }]}>{line.message}</Text>
        {line.kind === 'agent_control' && (line.detail?.text || line.detail?.message) ? (
          <Text selectable style={[styles.small, { color: theme.subtle }]}>{line.detail.text || line.detail.message}</Text>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <View style={styles.flex}>
        <Text style={[styles.time, { color: theme.muted }]}>{line.timeLabel}</Text>
        {body}
      </View>
    </View>
  );
}

function prettyArgs(raw: unknown): string {
  if (typeof raw !== 'string') return JSON.stringify(raw, null, 2);
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Chevron({ theme, open }: { theme: Theme; open: boolean }) {
  return (
    <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
      <Icon as={ChevronRight} size={14} color={theme.muted} />
    </View>
  );
}

function Md({ theme, text }: { theme: Theme; text: string }) {
  const Body = enrichedRenderer.Component;
  return <Body markdown={text} blockKind="paragraph" streaming={false} theme={theme} selectable />;
}

const styles = StyleSheet.create({
  list: { position: 'relative', gap: 2 },
  rail: { position: 'absolute', left: 3, top: 8, bottom: 8, width: StyleSheet.hairlineWidth * 2 },
  row: { flexDirection: 'row', gap: 10, paddingVertical: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  flex: { flex: 1, minWidth: 0 },
  time: { fontSize: 11.5, fontFamily: fonts.mono, marginBottom: 1 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
  text: { fontSize: 13.5, lineHeight: 20 },
  small: { fontSize: 12.5, lineHeight: 18 },
  label: { fontSize: 12, fontWeight: '600', marginTop: 4 },
  mono: { fontSize: 12, fontFamily: fonts.mono },
  pre: { fontSize: 12, lineHeight: 18, fontFamily: fonts.mono, padding: 8, borderRadius: 8, overflow: 'hidden' },
  detail: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 8, gap: 4, marginTop: 4 },
  empty: { fontSize: 12.5, textAlign: 'center', padding: 14, borderWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed', borderRadius: 10 },
});
