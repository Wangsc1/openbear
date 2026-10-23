/**
 * 手机“⋯”会话面板（B4-05～B4-07，对应 Web MobileConversationTools 的“会话工具”抽屉）：
 *  - 头部：所在目录、运行中（计时）、会话统计（Tokens 输入/输出/缓存读写及命中率、总耗时、总花费、上下文用量）；
 *  - 分组列表：会话（属性、更新系统提示词）/ 上下文与记忆（任务记忆计数、编辑上下文、产物计数）/ 阅读（b2 的阅读工具 + 跳到顶部）。
 * 草稿会话禁用需要服务器会话的项（与 Web 一致：隐藏内容、任务记忆、编辑上下文）。
 */
import { ArrowUpToLine, Bookmark, FilePenLine, FolderOpen, Package, ScrollText, SlidersHorizontal } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ConversationMenuItem } from '../chat/conversationTools';
import { Group, Icon, Pill, Row, Sheet, SheetScroll, tap, useTheme } from '../ui';
import { StatsBlock } from './StatsBlock';
import { clockText, type StatsView } from './stats';

export type PanelEntry = { key: string; label: string; icon: any; value?: string; subtitle?: string; disabled?: boolean; onPress?: () => void; testID?: string };

type Props = {
  visible: boolean;
  onClose(): void;
  title: string;
  path: string;
  running: boolean;
  waiting: boolean;
  statusLabel: string;
  runStartedAt: number;
  now: number;
  stats: StatsView;
  statsLoaded: boolean;
  draft: boolean;
  memoryCount: number | null;
  onProperties(): void;
  onSystemPrompt(): void;
  onTaskMemory(): void;
  onContextEditor(): void;
  onArtifacts(): void;
  onTop(): void;
  /** b2 阅读工具（搜索、轮次导航、隐藏内容、跟随最新） */
  readingItems: ConversationMenuItem[];
};

export function ConversationPanelSheet(props: Props) {
  const theme = useTheme();
  const { visible, onClose, running, waiting, draft } = props;
  const pick = (fn: () => void) => () => {
    tap('select');
    onClose();
    fn();
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="会话面板" subtitle={props.title || undefined} testID="conversation-panel">
      <SheetScroll contentContainerStyle={styles.scroll}>
        <View style={styles.head}>
          <View style={styles.locRow}>
            <Icon as={FolderOpen} size={15} strokeWidth={1.8} color={theme.muted} />
            <Text style={[styles.caption, { color: theme.muted }]}>所在目录</Text>
            <View style={styles.flex} />
            {running ? (
              <Pill theme={theme} tone="run" dot label={props.runStartedAt && props.now > props.runStartedAt ? `运行中 · ${clockText(props.now - props.runStartedAt)}` : props.statusLabel || '运行中'} />
            ) : waiting ? (
              <Pill theme={theme} tone="wait" label="等待你的回答" />
            ) : (
              <Text style={[styles.caption, { color: theme.muted }]}>就绪</Text>
            )}
          </View>
          <Text style={[styles.path, { color: theme.text }]} testID="panel-path">
            {props.path || '—'}
          </Text>
          {running && props.statusLabel && props.statusLabel !== '运行中' ? (
            <Text numberOfLines={1} style={[styles.status, { color: theme.subtle }]}>
              {props.statusLabel}
            </Text>
          ) : null}
        </View>
        <View style={styles.stats}>
          <StatsBlock theme={theme} view={props.stats} loaded={props.statsLoaded} />
        </View>

        <Group theme={theme} title="会话">
          <Row theme={theme} icon={SlidersHorizontal} title="会话属性" subtitle="上下文、模型配置、触发器标签" onPress={pick(props.onProperties)} testID="panel-properties" />
          <Row theme={theme} icon={ScrollText} title="更新系统提示词" disabled={draft} onPress={draft ? undefined : pick(props.onSystemPrompt)} testID="panel-system-prompt" />
        </Group>

        <Group theme={theme} title="上下文与记忆" footer={draft ? '发送第一条消息、会话建立后可用。' : running ? '会话运行中无法编辑上下文，结束后再试。' : undefined}>
          <Row
            theme={theme}
            icon={Bookmark}
            iconTint={props.memoryCount ? theme.textStrong : undefined}
            title="任务记忆"
            value={draft ? undefined : props.memoryCount === null ? '…' : String(props.memoryCount)}
            disabled={draft}
            onPress={draft ? undefined : pick(props.onTaskMemory)}
            testID="panel-task-memory"
          />
          <Row theme={theme} icon={FilePenLine} title="编辑上下文" subtitle={running ? '运行中不可编辑' : undefined} disabled={draft || running} onPress={draft || running ? undefined : pick(props.onContextEditor)} testID="panel-context-editor" />
          <Row theme={theme} icon={Package} title="产物" disabled={draft} onPress={draft ? undefined : pick(props.onArtifacts)} testID="panel-artifacts" />
        </Group>

        <Group theme={theme} title="阅读">
          {props.readingItems.map((item) => (
            <Row key={item.key} theme={theme} icon={item.icon} title={item.label} disabled={item.disabled} onPress={item.disabled ? undefined : pick(() => item.onPress?.())} testID={item.testID} chevron={false} />
          ))}
          <Row theme={theme} icon={ArrowUpToLine} title="跳到顶部" onPress={pick(props.onTop)} chevron={false} testID="panel-top" />
        </Group>
      </SheetScroll>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 12 },
  flex: { flex: 1 },
  head: { paddingHorizontal: 20, paddingTop: 2 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 },
  caption: { fontSize: 12.5 },
  path: { fontSize: 14, lineHeight: 20, marginTop: 4 },
  status: { fontSize: 12.5, marginTop: 4 },
  stats: { paddingHorizontal: 16, marginTop: 12 },
});
