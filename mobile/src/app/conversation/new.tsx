/**
 * 新会话草稿（B3-35，B1-01 的发送部分）。
 * - 打开时读目录/全局默认运行配置（GET /api/conversations/defaults?folderId），模型列表就绪后解析成实际配置；
 *   读不到时显示原因与重试，并阻止发送（草稿保留）。
 * - 修改运行配置：普通草稿写全局默认（PATCH /api/conversations/defaults，按点击顺序串行）；
 *   项目目录（有目录级默认）或压缩策略只在本次草稿里临时覆盖（与 Web 相同）。
 * - 首次发送：POST /api/conversations {title, runConfig, folderId} 建会话，迁移文字/附件草稿，进入对话页，
 *   由那里的输入区按正常链路上传附件并发送（见 composer/handoff.ts）。
 * - 打开方式（b1）：router.push({ pathname: '/conversation/new', params: { folderId } })；临时会话不带 folderId 或带 temporary: '1'。
 */
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, MessageCircle, RefreshCw } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Composer, type NewConversationContext } from '../../chat/Composer';
import { useSession } from '../../data/session';
import { newDraftKey } from '../../drafts/textDrafts';
import { clearDraft } from '../../tree/draft';
import { createPayloadFromRunConfig, defaultsPatchFromRunConfig, resolveDraftRunConfig, type ConversationDefaults, type RunConfig } from '../../runconfig/logic';
import { useModelOptions, useOpenBearApi } from '../../runconfig/options';
import { apiError } from '../../transport/apiAdapter';
import { Icon, IconButton, NavRow } from '../../ui/primitives';
import { showToast } from '../../ui/Toast';
import { type as typeScale, useTheme } from '../../ui/theme';

export default function NewConversation() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const api = useOpenBearApi();
  const models = useModelOptions();
  const params = useLocalSearchParams<{ folderId?: string; temporary?: string }>();
  const temporary = params.temporary === '1' || !params.folderId;
  const folderId = temporary ? '' : String(params.folderId || '');

  const [defaults, setDefaults] = useState<ConversationDefaults | null>(null);
  const [folderDefaults, setFolderDefaults] = useState<Record<string, unknown>>({});
  const [overrides, setOverrides] = useState<Partial<ConversationDefaults>>({});
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const tail = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    if (!api) return;
    setLoadError('');
    setDefaults(null);
    try {
      const data: any = await api.conversationDefaults(folderId ? { folderId } : {});
      setDefaults(data?.defaults || {});
      setFolderDefaults(data?.folderDefaults && typeof data.folderDefaults === 'object' ? data.folderDefaults : {});
    } catch (error) {
      setLoadError(`无法读取会话默认配置：${apiError(error)}。草稿已保留，请检查连接后重试`);
    }
  }, [api, folderId]);
  useEffect(() => {
    void load();
  }, [load]);

  const runConfig: RunConfig | null = useMemo(
    () => (defaults && models.loaded ? resolveDraftRunConfig({ ...defaults, ...overrides }, models.models, models.primaryModel) : null),
    [defaults, overrides, models.loaded, models.models, models.primaryModel],
  );
  const defaultsError = loadError || (models.error ? `无法读取模型列表：${models.error}` : '');

  const onRunConfigChange = useCallback(
    (patch: Partial<RunConfig>) => {
      const dp = defaultsPatchFromRunConfig(patch);
      const localOnly = Object.keys(folderDefaults || {}).length > 0 || 'contextStrategy' in dp;
      tail.current = tail.current.then(async () => {
        if (localOnly) {
          setOverrides((o) => ({ ...o, ...dp }));
          showToast(folderDefaults && Object.keys(folderDefaults).length ? '仅本次新会话生效（项目目录默认不变）' : '已为本次新会话设置');
          return;
        }
        if (!api) return;
        setSaving(true);
        try {
          const data: any = await api.updateConversationDefaults(dp);
          setDefaults(data?.defaults || {});
          setOverrides((o) => ('contextStrategy' in o ? { contextStrategy: o.contextStrategy } : {}));
          showToast('已更新默认运行配置');
        } catch (error) {
          showToast(`保存失败：${apiError(error)}`);
        } finally {
          setSaving(false);
        }
      });
    },
    [api, folderDefaults],
  );

  const create = useCallback(
    async (title: string) => {
      if (!api || !runConfig) throw new Error('会话默认配置尚未读取完成');
      const created: any = await api.createConversation({ title, runConfig: createPayloadFromRunConfig(runConfig), folderId });
      const uuid = String(created?.conversation?.conversationUuid || created?.state?.conversationUuid || '');
      if (!uuid) throw new Error('conversation_create_failed');
      clearDraft();
      void session.refresh().catch(() => undefined);
      return uuid;
    },
    [api, runConfig, folderId, session],
  );

  const context: NewConversationContext = {
    draftKey: newDraftKey(folderId, temporary),
    runConfig,
    defaultsError,
    saving,
    onRunConfigChange,
    create,
  };

  const folderPath = folderId ? session.conversations.find((c) => c.folderId === folderId)?.path || '项目目录' : '临时会话';

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]} testID="new-conversation-page">
      <View style={{ paddingTop: insets.top, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line }}>
        <NavRow theme={theme} title="新会话" subtitle={folderPath} left={<IconButton theme={theme} icon={ChevronLeft} size={26} label="返回" testID="back" onPress={() => router.back()} />} />
      </View>
      <KeyboardAvoidingView behavior="padding" style={styles.root}>
        <View style={styles.center}>
          <View style={[styles.tile, { backgroundColor: theme.surfaceSoft }]}>
            <Icon as={MessageCircle} size={24} strokeWidth={1.6} color={theme.subtle} />
          </View>
          <Text style={[styles.title, { color: theme.textStrong }]}>开始一个新会话</Text>
          <Text style={[styles.hint, { color: theme.muted }]}>描述你要做的事，OpenBear 会规划并执行。</Text>
          {defaultsError ? (
            <Pressable
              onPress={() => {
                void load();
                models.reload();
              }}
              style={[styles.error, { backgroundColor: theme.dangerSoft }]}
              accessibilityRole="button"
              testID="defaults-retry"
            >
              <Text style={[styles.errorText, { color: theme.danger }]}>{defaultsError}</Text>
              <View style={styles.retry}>
                <Icon as={RefreshCw} size={15} color={theme.danger} />
                <Text style={[styles.errorText, { color: theme.danger, fontWeight: '600' }]}>重试</Text>
              </View>
            </Pressable>
          ) : !runConfig ? (
            <View style={styles.retry} testID="defaults-loading">
              <ActivityIndicator size="small" color={theme.muted} />
              <Text style={[styles.hint, { color: theme.muted }]}>正在读取默认运行配置…</Text>
            </View>
          ) : null}
        </View>
        <Composer theme={theme} disabled={false} running={false} bottomInset={insets.bottom} padH={16} onSend={() => false} newConversation={context} />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 8 },
  tile: { width: 52, height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  title: { fontSize: 18, fontWeight: '700' },
  hint: { fontSize: typeScale.small, textAlign: 'center', lineHeight: 20 },
  error: { marginTop: 12, borderRadius: 14, padding: 14, gap: 8, alignItems: 'center' },
  errorText: { fontSize: 13.5, lineHeight: 19, textAlign: 'center' },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
});
