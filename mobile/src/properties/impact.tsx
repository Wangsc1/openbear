/**
 * 影响确认（Web PromptImpactDialog）：保存目录/临时会话属性、会话上下文、移动、删除目录时，
 * 如果会影响已有会话的系统提示词，问用户“取消 / 仅X，不更新 / X并更新可更新会话”。
 * useImpactChooser() 返回 [element, choose]：choose(action, impact) -> true（并更新）/ false（不更新）/ null（取消）。
 * affectedCount 为 0 时直接返回 false，不打扰用户。
 */
import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../ui/theme';
import { ChoiceSheet } from '../ui/conversations/treeKit';

export type ImpactInfo = { affectedCount?: number; updatableCount?: number; runningCount?: number; archivedCount?: number };

export function impactSummary(action: string, impact: ImpactInfo): string {
  return `此次${action}影响 ${impact.affectedCount || 0} 个已有会话：可更新 ${impact.updatableCount || 0} 个；运行中 ${impact.runningCount || 0} 个，本次将跳过。${impact.archivedCount ? `其中已归档 ${impact.archivedCount} 个。` : ''}`;
}

export function useImpactChooser(): [React.ReactNode, (action: string, impact: ImpactInfo | null | undefined) => Promise<boolean | null>] {
  const theme = useTheme();
  const [state, setState] = useState<{ action: string; impact: ImpactInfo } | null>(null);
  const resolver = useRef<((value: boolean | null) => void) | null>(null);
  const choose = useCallback((action: string, impact: ImpactInfo | null | undefined) => {
    if (!Number(impact?.affectedCount || 0)) return Promise.resolve(false);
    resolver.current?.(null);
    setState({ action, impact: impact as ImpactInfo });
    return new Promise<boolean | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const finish = (value: boolean | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setState(null);
    resolve?.(value);
  };
  const action = state?.action || '保存';
  const element = (
    <ChoiceSheet
      visible={Boolean(state)}
      title="是否同时更新已有会话的系统提示词？"
      testID="impact-sheet"
      choices={[
        { key: 'update', label: `${action}并更新可更新会话`, tone: 'primary', testID: 'impact-update' },
        { key: 'only', label: `仅${action}，不更新`, tone: 'plain', testID: 'impact-only' },
        { key: 'cancel', label: '取消', tone: 'plain', testID: 'impact-cancel' },
      ]}
      onChoose={(key) => finish(key === 'update' ? true : key === 'only' ? false : null)}
    >
      {state ? (
        <View style={styles.copy}>
          <Text style={[styles.lead, { color: theme.text }]}>{impactSummary(action, state.impact)}</Text>
          <Text style={[styles.note, { color: theme.muted }]}>更新会按保存后的配置和各会话自己的当前参数重新组装系统提示词。这会使对应提示词／Provider continuation 缓存失效，可能增加后续输入开销和延迟。</Text>
          <Text style={[styles.note, { color: theme.muted }]}>聊天历史、文件和记忆不会删除。Agent 模板与快照不受影响。运行中目标在提交锁内重查，跳过后不会自动延后更新。</Text>
        </View>
      ) : null}
    </ChoiceSheet>
  );
  return [element, choose];
}

const styles = StyleSheet.create({
  copy: { gap: 8 },
  lead: { fontSize: 15, lineHeight: 22 },
  note: { fontSize: 13, lineHeight: 19 },
});
