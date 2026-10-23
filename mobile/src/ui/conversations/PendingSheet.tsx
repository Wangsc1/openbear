/**
 * 待处理会话面板（B1-65）：每个会话的标题、“当前”标记、路径，以及它的每个待处理事项（多项时编号）。
 * 点事项：重新核对该事项仍在（已处理或过期时提示“该事项已处理或已过期”），然后带 focus 参数打开会话，
 * focus = interactionId（与 Web PendingConversations 传给 focusPendingInteraction 的标识相同），由对话页定位。
 */
import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Icon, Press } from '../primitives';
import { Sheet, SheetScroll } from '../Sheet';
import { radius, useTheme } from '../theme';
import { showToast } from '../Toast';
import { pendingRequestLabel, type Row } from '../../tree/treeModel';
import { useTreeIndex } from '../../tree/treeStore';

export function openPending(rows: Row[], row: Row, interactionId: string, open?: (row: Row, focus: string) => void) {
  const current = rows.find((item) => item.conversationUuid === row.conversationUuid);
  if (!current || (interactionId && !current.activityPending?.some((item: Row) => item.interactionId === interactionId))) {
    showToast('该事项已处理或已过期');
    return;
  }
  if (open) open(current, interactionId);
  else router.push({ pathname: '/conversation/[uuid]', params: { uuid: current.conversationUuid, ...(interactionId ? { focus: interactionId } : {}) } });
}

export function PendingSheet({ visible, activeUuid, onClose, onOpen }: { visible: boolean; activeUuid?: string; onClose(): void; onOpen?(row: Row, focus: string): void }) {
  const theme = useTheme();
  const index = useTreeIndex();
  const items = index.pending;
  const choose = (row: Row, interactionId: string) => {
    onClose();
    // 等面板收起再跳转，避免与关闭动画抢手势
    setTimeout(() => openPending(index.pending, row, interactionId, onOpen), 240);
  };
  return (
    <Sheet visible={visible} title="待处理会话" subtitle={items.length ? `${items.length} 个会话` : undefined} onClose={onClose} testID="pending-sheet">
      <SheetScroll contentContainerStyle={styles.body}>
        {!items.length ? <Text style={[styles.empty, { color: theme.muted }]}>当前没有待处理会话</Text> : null}
        {items.map((row, i) => (
          <View key={row.conversationUuid} style={[styles.conv, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]}>
            <View style={styles.titleRow}>
              <Text numberOfLines={2} style={[styles.title, { color: theme.textStrong }]}>
                {row.title || '新会话'}
              </Text>
              {row.conversationUuid === activeUuid ? <Text style={[styles.current, { color: theme.muted }]}>当前</Text> : null}
            </View>
            <Text numberOfLines={2} style={[styles.path, { color: theme.muted }]}>
              {row.path || '临时会话'}
            </Text>
            <View style={styles.requests}>
              {(row.activityPending?.length ? row.activityPending : [null]).map((request: Row | null, n: number) => (
                <Press
                  key={request?.interactionId || 'any'}
                  testID={`pending-${String(row.conversationUuid).slice(0, 8)}-${n}`}
                  onPress={() => choose(row, request?.interactionId || '')}
                  style={[styles.request, { backgroundColor: theme.warningSoft }]}
                  pressedStyle={{ opacity: 0.7 }}
                  accessibilityRole="button"
                >
                  <Text numberOfLines={1} style={[styles.requestText, { color: theme.warning }]}>
                    {request ? pendingRequestLabel(row, request) : '查看待处理事项'}
                    {request && row.activityPending.length > 1 ? ` · 第 ${n + 1} 项` : ''}
                  </Text>
                  <Icon as={ChevronRight} size={15} color={theme.warning} />
                </Press>
              ))}
            </View>
          </View>
        ))}
      </SheetScroll>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingBottom: 12 },
  empty: { textAlign: 'center', paddingVertical: 28, fontSize: 14 },
  conv: { paddingVertical: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flexShrink: 1, fontSize: 15.5, fontWeight: '600' },
  current: { fontSize: 12 },
  path: { fontSize: 12.5, marginTop: 2, marginBottom: 8 },
  requests: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  request: { flexGrow: 1, flexBasis: 140, minHeight: 44, borderRadius: radius.sm + 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12 },
  requestText: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
});
