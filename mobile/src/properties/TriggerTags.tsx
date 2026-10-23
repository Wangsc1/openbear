/**
 * 触发器标签（B1-58 / B1-63，部分完成）：完整的触发器编辑器属于后续“自动化”工作包。
 * 这里读取并显示当前目录/会话已有的触发器（GET /api/webhooks?scopeType&scopeId，与 Web WebhookEditor.load 相同），
 * 并提供“在自动化中管理”的入口（暂时跳到自动化 Tab 并提示）。
 */
import { router } from 'expo-router';
import { Webhook } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../data/session';
import { createOpenBearApi } from '../transport/apiAdapter';
import { Group, Row } from '../ui/GroupedList';
import { Pill, Press } from '../ui/primitives';
import { useTheme } from '../ui/theme';
import { showToast } from '../ui/Toast';
import { apiErrorText } from '../tree/treeStore';

export function TriggerTags({ scopeType, scopeId, onLeave }: { scopeType: 'folder' | 'conversation'; scopeId: string; onLeave?: () => void }) {
  const theme = useTheme();
  const session = useSession();
  const api = useMemo(() => (session.http ? createOpenBearApi(session.http) : null), [session.http]);
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!api || !scopeId) return;
    setError('');
    setItems(null);
    try {
      const data: any = await api.webhooks({ scopeType, scopeId });
      setItems(data.items || []);
    } catch (e) {
      setError(apiErrorText(e));
    }
  }, [api, scopeType, scopeId]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <View testID="trigger-tags">
      <Group theme={theme} title="触发器" footer="触发器（Webhook 入口）的创建与编辑在“自动化”中进行；新建在此范围内的触发器会把外部事件送到这个目录或会话。">
        {items === null && !error ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.muted} />
          </View>
        ) : null}
        {error ? <Row theme={theme} title="读取失败" subtitle={error} value="重试" onPress={() => void load()} /> : null}
        {items && !items.length ? <Row theme={theme} icon={Webhook} title="还没有触发器" subtitle="这个范围内没有配置外部触发入口" /> : null}
        {(items || []).map((item) => (
          <Row
            key={item.id}
            theme={theme}
            icon={Webhook}
            title={String(item.name || '触发器')}
            subtitle={[item.description, item.revision ? `规则 v${item.revision}` : ''].filter(Boolean).join(' · ') || undefined}
            accessory={<Pill theme={theme} tone={item.enabled ? 'success' : 'neutral'} label={item.enabled ? (item.dispatchPaused ? '已暂停' : '已启用') : '已停用'} />}
          />
        ))}
      </Group>
      <Press
        onPress={() => {
          onLeave?.();
          router.navigate('/automation');
          showToast('触发器管理将在“自动化”中提供（后续版本）');
        }}
        style={[styles.manage, { borderColor: theme.border }]}
        testID="trigger-manage"
      >
        <Text style={{ color: theme.text, fontSize: 15 }}>在自动化中管理</Text>
      </Press>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { paddingVertical: 18, alignItems: 'center' },
  manage: { marginHorizontal: 16, marginTop: 12, height: 44, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
});
