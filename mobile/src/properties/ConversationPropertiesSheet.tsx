/**
 * 会话属性（上下文配置、模型配置、触发器标签）与“更新系统提示词”。
 * 会话树工作包 B1 实现；会话面板工作包 B4 从对话页“更多”菜单打开它们。
 * 接口保持不变：B4 只按这里的 props 调用。
 *
 * 会话属性（Web ConversationPropertiesDialog）：
 * - 上下文配置（B1-61）：局部上下文与提示词策略（继承上级），保存前做影响确认；读取失败可重新读取；
 *   有未保存内容时关闭会问“保存后离开 / 放弃更改”；
 * - 模型配置（B1-62）：用 B3 的 RunConfigEditor，逐项即时保存（串行队列，下一次运行生效）；
 * - 触发器（B1-63，部分完成）：显示已有触发器 + “在自动化中管理”；
 * - 草稿（local:）会话（B1-64）：提示“先保存为真实会话”，并提供保存按钮（POST /api/conversations，不运行模型）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../data/session';
import { RunConfigEditor } from '../runconfig/RunConfigEditor';
import { createOpenBearApi } from '../transport/apiAdapter';
import { clearDraft, getDraft, LOCAL_DRAFT_UUID } from '../tree/draft';
import { apiErrorText, tree } from '../tree/treeStore';
import { conversationPolicyPayload, conversationPromptPolicy, normalizePromptPolicy, type PromptPolicy, promptPolicyFlags } from '../tree/webTree';
import { Press, Segmented } from '../ui/primitives';
import { Sheet, SheetScroll } from '../ui/Sheet';
import { radius, useTheme } from '../ui/theme';
import { showToast } from '../ui/Toast';
import { ChoiceSheet } from '../ui/conversations/treeKit';
import { useImpactChooser } from './impact';
import { PromptPolicyEditor } from './PromptPolicyEditor';
import { runConfigValue, saveRunConfigPatch } from './runConfigQueue';
import { TriggerTags } from './TriggerTags';

export type ConversationPropertiesProps = { uuid: string; visible: boolean; onClose(): void };

type Tab = 'context' | 'model' | 'trigger';

export function ConversationPropertiesSheet({ uuid, visible, onClose }: ConversationPropertiesProps) {
  const theme = useTheme();
  const session = useSession();
  const api = useMemo(() => (session.http ? createOpenBearApi(session.http) : null), [session.http]);
  const [currentUuid, setCurrentUuid] = useState(uuid);
  const local = !currentUuid || currentUuid.startsWith('local:');
  const [tab, setTab] = useState<Tab>('context');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [props, setProps] = useState<any>(null);
  const [policy, setPolicy] = useState<PromptPolicy>(normalizePromptPolicy());
  const [baseline, setBaseline] = useState('');
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState<any>(null);
  const [modelError, setModelError] = useState('');
  const [modelSaving, setModelSaving] = useState(false);
  const [persisting, setPersisting] = useState(false);
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [impactElement, chooseImpact] = useImpactChooser();
  const generation = useRef(0);

  const dirty = Boolean(props) && JSON.stringify(conversationPolicyPayload({ ...policy, contextText: policy.text })) !== baseline;

  const load = useCallback(
    async (target: string) => {
      const run = ++generation.current;
      if (!api || !target || target.startsWith('local:')) return;
      setLoading(true);
      setError('');
      setModelError('');
      try {
        const response: any = await api.conversationProperties(target);
        if (run !== generation.current) return;
        const properties = response.properties;
        if (!properties || typeof properties.contextText !== 'string') setError('未取得完整上下文，未开放编辑');
        else {
          const p = conversationPromptPolicy(properties);
          setProps(properties);
          setPolicy(p);
          setBaseline(JSON.stringify(conversationPolicyPayload({ ...p, contextText: p.text })));
        }
        const snapshot = response.runConfig && response.runConfig.conversationUuid === target ? response.runConfig : null;
        if (snapshot) setModel(snapshot);
        else setModelError('未取得完整模型配置，未开放编辑');
      } catch (e) {
        if (run === generation.current) {
          setError(apiErrorText(e));
          setModelError(apiErrorText(e));
        }
      } finally {
        if (run === generation.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!visible) {
      generation.current += 1;
      return;
    }
    setCurrentUuid(uuid);
    setTab('context');
    setProps(null);
    setModel(null);
    setError('');
    const known = [...Object.values(tree.state.branches).flatMap((b) => b.items)].find((r) => r.conversationUuid === uuid);
    setTitle(String(known?.title || ''));
    void load(uuid);
  }, [visible, uuid]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveContext = async (): Promise<boolean> => {
    if (!api || !props || !dirty || saving) return false;
    const submitted = conversationPolicyPayload({ ...policy, contextText: policy.text });
    setSaving(true);
    setError('');
    try {
      const affected: any = await api.conversationPropertiesImpact(currentUuid, submitted);
      setSaving(false);
      const choice = await chooseImpact('保存', affected);
      if (choice === null) return false;
      setSaving(true);
      const response: any = await api.updateConversationProperties(currentUuid, { ...submitted, updateSnapshots: choice === true });
      if (!response.properties || typeof response.properties.contextText !== 'string') throw new Error('保存响应缺少完整上下文，请保留草稿并重新读取');
      const saved = conversationPromptPolicy(response.properties);
      setProps(response.properties);
      setPolicy(saved);
      setBaseline(JSON.stringify(conversationPolicyPayload({ ...saved, contextText: saved.text })));
      showToast(choice === true ? `局部上下文已保存，更新 ${response.updatedCount || 0} 个快照；运行中跳过 ${response.skippedRunningCount || 0} 个` : '局部上下文已保存；已有快照保持不变');
      return true;
    } catch (e) {
      setError(apiErrorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const changeModel = async (patch: Record<string, any>) => {
    if (!api || modelSaving || !model) return;
    setModelSaving(true);
    setModelError('');
    try {
      const snapshot = await saveRunConfigPatch(api, currentUuid, patch);
      setModel(snapshot);
      showToast('contextStrategy' in patch ? '压缩策略已保存，在下一安全边界生效' : '已保存，下一次运行生效；当前运行不切换');
    } catch (e) {
      setModelError(apiErrorText(e));
    } finally {
      setModelSaving(false);
    }
  };

  const persistDraft = async () => {
    if (!api) return;
    setPersisting(true);
    try {
      const folderId = getDraft()?.folderId || '';
      const data: any = await api.createConversation({ title: '新会话', ...(folderId ? { folderId } : {}) });
      const created = String(data?.conversation?.conversationUuid || data?.conversationUuid || data?.state?.conversationUuid || '');
      if (!created) throw new Error('服务器没有返回会话');
      clearDraft();
      setCurrentUuid(created);
      void tree.afterMutation([folderId || '__temporary']);
      void session.refresh().catch(() => undefined);
      showToast('已保存为真实会话');
      void load(created);
    } catch (e) {
      showToast(apiErrorText(e));
    } finally {
      setPersisting(false);
    }
  };

  const busy = saving || modelSaving || persisting;
  const requestClose = () => {
    if (busy) return;
    if (dirty) setLeaveAsk(true);
    else onClose();
  };

  const footer =
    !local && tab === 'context' ? (
      <View style={styles.footer}>
        <Text numberOfLines={1} style={[styles.footNote, { color: theme.muted }]}>{dirty ? '有未保存的上下文' : ''}</Text>
        <Press onPress={() => void saveContext()} disabled={!dirty || saving || !props} style={[styles.primary, { backgroundColor: theme.button, opacity: !dirty || saving || !props ? 0.5 : 1 }]} testID="conv-props-save">
          {saving ? <ActivityIndicator color={theme.buttonText} /> : <Text style={[styles.primaryText, { color: theme.buttonText }]}>保存上下文配置</Text>}
        </Press>
      </View>
    ) : undefined;

  return (
    <>
      <Sheet visible={visible} title={title || '会话属性'} subtitle="会话属性" onClose={requestClose} full footer={footer} testID="conversation-properties">
        {local ? (
          <View style={styles.draft} testID="conv-props-draft">
            <Text style={[styles.draftTitle, { color: theme.textStrong }]}>这是尚未持久保存的草稿</Text>
            <Text style={[styles.note, { color: theme.muted }]}>没有有效触发地址。创建为真实会话后才能配置上下文、模型和触发入口；保存不会自动运行模型、启用入口或发送消息。</Text>
            <Press onPress={() => void persistDraft()} disabled={persisting} style={[styles.primary, { backgroundColor: theme.button, opacity: persisting ? 0.6 : 1 }]} testID="conv-props-persist">
              {persisting ? <ActivityIndicator color={theme.buttonText} /> : <Text style={[styles.primaryText, { color: theme.buttonText }]}>保存为真实会话后继续</Text>}
            </Press>
          </View>
        ) : (
          <>
            <View style={styles.tabs}>
              <Segmented
                theme={theme}
                value={tab}
                onChange={(key) => setTab(key as Tab)}
                items={[
                  { key: 'context', label: '上下文配置' },
                  { key: 'model', label: '模型配置' },
                  { key: 'trigger', label: '触发器' },
                ]}
              />
            </View>
            <SheetScroll contentContainerStyle={styles.body}>
              {tab === 'context' ? (
                <View style={{ gap: 12 }}>
                  {error ? (
                    <View style={[styles.alert, { backgroundColor: theme.dangerSoft }]}>
                      <Text style={{ color: theme.danger, flex: 1 }}>{error}</Text>
                      <Press onPress={() => void load(currentUuid)} disabled={loading || dirty} style={styles.alertBtn} testID="conv-props-reload">
                        <Text style={{ color: theme.text }}>重新读取</Text>
                      </Press>
                    </View>
                  ) : null}
                  {loading && !props ? <ActivityIndicator color={theme.muted} style={{ marginTop: 24 }} /> : null}
                  {props ? (
                    <PromptPolicyEditor
                      value={policy}
                      inherited={normalizePromptPolicy(props.promptPolicy?.inherited || { text: props.inheritedContext })}
                      inheritedSourcePath={props.promptPolicy?.inheritedSourcePath || ''}
                      conversationId={currentUuid}
                      disabled={saving}
                      onChange={(next) => setPolicy({ ...normalizePromptPolicy(next), ...promptPolicyFlags(next), text: next.text })}
                    />
                  ) : null}
                </View>
              ) : null}
              {tab === 'model' ? (
                <View style={{ gap: 10 }}>
                  {modelError ? (
                    <View style={[styles.alert, { backgroundColor: theme.dangerSoft }]}>
                      <Text style={{ color: theme.danger, flex: 1 }}>{modelError}</Text>
                      <Press onPress={() => void load(currentUuid)} disabled={busy || loading} style={styles.alertBtn} testID="conv-props-model-reload">
                        <Text style={{ color: theme.text }}>重新读取模型配置</Text>
                      </Press>
                    </View>
                  ) : null}
                  <RunConfigEditor value={runConfigValue(model)} disabled={!model || modelSaving || loading} onChange={(patch) => void changeModel(patch)} testID="conv-props-runconfig" />
                  <Text style={[styles.note, { color: theme.muted }]}>{modelSaving ? '正在保存…' : '逐项保存，下一次运行生效；不会改变当前运行。'}</Text>
                </View>
              ) : null}
              {tab === 'trigger' ? <TriggerTags scopeType="conversation" scopeId={currentUuid} onLeave={onClose} /> : null}
            </SheetScroll>
          </>
        )}
      </Sheet>
      <ChoiceSheet
        visible={leaveAsk}
        title="离开会话属性？"
        message="局部上下文尚未保存。"
        choices={[
          { key: 'save', label: '保存后离开', tone: 'primary', testID: 'leave-save' },
          { key: 'discard', label: '放弃更改', tone: 'danger', testID: 'leave-discard' },
          { key: 'stay', label: '继续编辑', tone: 'plain', testID: 'leave-stay' },
        ]}
        onChoose={(key) => {
          setLeaveAsk(false);
          if (key === 'discard') onClose();
          else if (key === 'save') void saveContext().then((ok) => ok && onClose());
        }}
      />
      {impactElement}
    </>
  );
}

/** 更新系统提示词（Web ConversationPromptDialog）：先预览差异，再只更新这个会话。 */
export function SystemPromptUpdateSheet({ uuid, visible, onClose }: ConversationPropertiesProps) {
  const theme = useTheme();
  const session = useSession();
  const api = useMemo(() => (session.http ? createOpenBearApi(session.http) : null), [session.http]);
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const generation = useRef(0);
  const local = !uuid || uuid.startsWith('local:') || uuid === LOCAL_DRAFT_UUID;

  const promptError = (error: any) =>
    ({
      busy: '会话正在运行或处理其他操作，本次未更新，也不会延后自动更新。请在空闲后再试。',
      prompt_preview_changed: '模板、记忆或会话快照已变化。请重新预览，核对新的差异后再更新。',
      prompt_render_failed: '当前配置无法生成有效提示词，原快照已保留。请检查模板后再试。',
      session_not_found: '这个会话尚无可更新的会话状态。',
    })[String(error?.body?.error || '')] || apiErrorText(error);

  const loadPreview = useCallback(async () => {
    if (!api || local) return;
    const token = ++generation.current;
    setPreview(null);
    setErrorText('');
    setShowDiff(false);
    setLoading(true);
    try {
      const data = await api.conversationSystemPromptPreview(uuid);
      if (token === generation.current) setPreview(data);
    } catch (e) {
      if (token === generation.current) setErrorText(promptError(e));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [api, uuid, local]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    generation.current += 1;
    setPreview(null);
    setErrorText('');
    setSaving(false);
    if (visible) void loadPreview();
  }, [visible, uuid]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!api || saving || loading || !preview?.changed) return;
    const reviewed = preview;
    setSaving(true);
    setErrorText('');
    try {
      const result: any = await api.updateConversationSystemPrompt(reviewed.conversationUuid || uuid, { confirmed: true, beforeHash: reviewed.beforeHash, afterHash: reviewed.afterHash });
      showToast(result?.updated ? '系统提示词已更新，下次发送生效；聊天历史保持不变。' : '系统提示词已是当前版本，无需重复更新。');
      setSaving(false);
      onClose();
    } catch (e) {
      setPreview(null);
      setErrorText(promptError(e));
      setSaving(false);
    }
  };

  const footer = (
    <View style={styles.footerCol}>
      {errorText ? (
        <Press onPress={() => void loadPreview()} disabled={saving || loading} style={[styles.secondary, { borderColor: theme.border }]} testID="prompt-repreview">
          <Text style={{ color: theme.text, fontSize: 15 }}>重新预览</Text>
        </Press>
      ) : null}
      <Press onPress={() => void save()} disabled={loading || saving || !preview?.changed} style={[styles.primary, { backgroundColor: theme.button, opacity: loading || saving || !preview?.changed ? 0.5 : 1 }]} testID="prompt-update-submit">
        {saving ? <ActivityIndicator color={theme.buttonText} /> : <Text style={[styles.primaryText, { color: theme.buttonText }]}>更新此会话</Text>}
      </Press>
    </View>
  );

  return (
    <Sheet visible={visible} title="更新会话系统提示词" onClose={() => !saving && onClose()} footer={footer} maxHeight={0.9} testID="system-prompt-update">
      <SheetScroll contentContainerStyle={styles.body}>
        <Text style={[styles.note, { color: theme.text }]}>只更新这个会话：使用当前主模板、记忆和目录属性重新组装完整系统提示词。提示词与 Provider continuation 缓存将失效，下一轮可能增加输入开销和延迟。</Text>
        <Text style={[styles.note, { color: theme.muted }]}>聊天历史、摘要、任务记忆和文件不会删除，Agent 快照不受影响。运行中的会话不能更新，也不会自动延后更新。</Text>
        {local ? <Text style={[styles.note, { color: theme.warning }]}>草稿会话还没有系统提示词，先发送第一条消息。</Text> : null}
        {loading ? (
          <View style={styles.row}>
            <ActivityIndicator color={theme.muted} />
            <Text style={{ color: theme.muted }}>正在生成预览…</Text>
          </View>
        ) : null}
        {errorText ? <Text style={[styles.note, { color: theme.danger }]} testID="prompt-update-error">{errorText}</Text> : null}
        {preview ? (
          !preview.changed ? (
            <Text style={[styles.note, { color: theme.text }]} testID="prompt-update-same">当前快照与重新组装的提示词完全一致，无需更新。</Text>
          ) : (
            <View style={{ gap: 8 }}>
              <Text style={[styles.note, { color: theme.text }]} testID="prompt-update-chars">
                字符数：{Number(preview.beforeChars || 0).toLocaleString()} → {Number(preview.afterChars || 0).toLocaleString()}
              </Text>
              <Press onPress={() => setShowDiff((v) => !v)} style={[styles.secondary, { borderColor: theme.border }]} testID="prompt-diff-toggle">
                <Text style={{ color: theme.text, fontSize: 15 }}>{showDiff ? '收起提示词差异' : '查看提示词差异'}</Text>
              </Press>
              {showDiff ? <DiffText theme={theme} diff={String(preview.diff || '')} /> : null}
            </View>
          )
        ) : null}
      </SheetScroll>
    </Sheet>
  );
}

function DiffText({ theme, diff }: { theme: any; diff: string }) {
  const lines = diff.split('\n').slice(0, 1500);
  return (
    <View style={[styles.diff, { backgroundColor: theme.surfaceSoft }]} testID="prompt-diff">
      {lines.map((line, i) => {
        const add = line.startsWith('+') && !line.startsWith('+++');
        const del = line.startsWith('-') && !line.startsWith('---');
        return (
          <Text key={i} selectable style={[styles.diffLine, { color: add ? theme.success : del ? theme.danger : line.startsWith('@@') ? theme.blue : theme.text, backgroundColor: add ? theme.successSoft : del ? theme.dangerSoft : 'transparent' }]}>
            {line || ' '}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { paddingHorizontal: 16, paddingBottom: 8 },
  body: { paddingHorizontal: 16, paddingBottom: 20, gap: 10 },
  note: { fontSize: 13.5, lineHeight: 20 },
  draft: { padding: 20, gap: 12 },
  draftTitle: { fontSize: 16, fontWeight: '600' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  footerCol: { gap: 8 },
  footNote: { flex: 1, fontSize: 12.5 },
  primary: { minHeight: 46, paddingHorizontal: 20, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 16, fontWeight: '600' },
  secondary: { minHeight: 44, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  alert: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: radius.md },
  alertBtn: { paddingHorizontal: 10, minHeight: 36, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  diff: { borderRadius: radius.md, padding: 10 },
  diffLine: { fontFamily: 'monospace', fontSize: 11.5, lineHeight: 17 },
});
