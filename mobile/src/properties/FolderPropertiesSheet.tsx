/**
 * 目录属性 / 临时会话属性（Web ConversationTree 属性对话框，B1-55～B1-60）：
 * - 目录上下文：本节点工作目录（清空即继承，显示当前生效值与来源）+ 提示词策略；临时会话叫“注入上下文”、没有工作目录；
 * - 默认模型：B3 的 RunConfigEditor（allowInherit；每项可“继承目录 / 使用系统默认”），“全部恢复继承”；只影响以后新建的会话；
 *   模型列表不可用时只读；保存前用 Web 同一套校验（runDefaultsValidationError 的等价逻辑）；
 * - 触发器（B1-58，部分完成）：已有触发器 + “在自动化中管理”；临时会话没有；
 * - 保存：先 POST …/properties/impact，再按影响确认 PUT …/properties {updateSnapshots}；保存中禁止关闭；
 *   有未保存修改时关闭会问“保存后离开 / 放弃更改”。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../data/session';
import { RunConfigEditor } from '../runconfig/RunConfigEditor';
import { createOpenBearApi } from '../transport/apiAdapter';
import { TEMP } from '../tree/treeModel';
import { apiErrorText, tree } from '../tree/treeStore';
import { normalizePromptPolicy, normalizedRunDefaults, type PromptPolicy, promptPolicyFlags, sparseRunDefaults } from '../tree/webTree';
import { TextField } from '../ui/Form';
import { Press, Segmented } from '../ui/primitives';
import { Sheet, SheetScroll } from '../ui/Sheet';
import { radius, useTheme } from '../ui/theme';
import { showToast } from '../ui/Toast';
import { ChoiceSheet } from '../ui/conversations/treeKit';
import { useImpactChooser } from './impact';
import { PromptPolicyEditor } from './PromptPolicyEditor';
import { applyFolderPatch, folderDefaultsToRunConfig } from './runConfigQueue';
import { folderRunDefaultsError } from './propertiesModel';
import { TriggerTags } from './TriggerTags';

type Tab = 'context' | 'defaults' | 'trigger';

export function FolderPropertiesSheet({ folderId, name, visible, onClose }: { folderId: string; name: string; visible: boolean; onClose(): void }) {
  const theme = useTheme();
  const session = useSession();
  const api = useMemo(() => (session.http ? createOpenBearApi(session.http) : null), [session.http]);
  const temporary = folderId === TEMP;
  const [tab, setTab] = useState<Tab>('context');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [data, setData] = useState<any>(null);
  const [workspace, setWorkspace] = useState('');
  const [policy, setPolicy] = useState<PromptPolicy>(normalizePromptPolicy());
  const [runLocal, setRunLocal] = useState<Record<string, any>>({});
  const [baseline, setBaseline] = useState('');
  const [models, setModels] = useState<any[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [impactElement, chooseImpact] = useImpactChooser();

  const snapshot = (w: string, p: PromptPolicy, r: Record<string, any>) => JSON.stringify({ w, p: { ...promptPolicyFlags(p), text: p.text }, r: sparseRunDefaults(r) });
  const dirty = Boolean(data) && snapshot(workspace, policy, runLocal) !== baseline;
  const runChanged = Boolean(data) && JSON.stringify(sparseRunDefaults(runLocal)) !== JSON.stringify(sparseRunDefaults(data?.runDefaults?.local || {}));

  const load = useCallback(async () => {
    if (!api || !folderId) return;
    setLoading(true);
    setLoadError('');
    setData(null);
    setModels(null);
    const [props, options] = await Promise.allSettled([api.conversationFolderProperties(folderId), api.rathOptions()]);
    if (options.status === 'fulfilled' && Array.isArray((options.value as any)?.models)) setModels((options.value as any).models);
    else setModels(null);
    if (props.status === 'rejected') {
      setLoadError(apiErrorText(props.reason));
      setLoading(false);
      return;
    }
    const value: any = props.value;
    const p = normalizePromptPolicy({ ...(value.promptPolicy?.local || {}), text: value.promptPolicy?.local?.text ?? value.prompt?.local ?? '' });
    const w = String(value.workspace?.local || '');
    const r = sparseRunDefaults(value.runDefaults?.local || {});
    setData(value);
    setWorkspace(w);
    setPolicy(p);
    setRunLocal(r);
    setBaseline(snapshot(w, p, r));
    setLoading(false);
  }, [api, folderId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible) return;
    setTab('context');
    setSaveError('');
    void load();
  }, [visible, folderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const layers = useMemo(
    () => ({ local: runLocal, inherited: sparseRunDefaults(data?.runDefaults?.inherited || {}), fallback: sparseRunDefaults(data?.runDefaults?.fallback || {}), resolved: sparseRunDefaults(data?.runDefaults?.resolved || {}) }),
    [runLocal, data],
  );
  // 每项“继承时”的值：去掉本地这一项后的生效值（与 Web inheritedRunDefaults 相同）
  const inheritedValues = useMemo(() => {
    const out: Record<string, any> = {};
    for (const field of Object.keys(normalizedRunDefaults(layers, models || []))) {
      const local = { ...runLocal };
      delete local[field];
      out[field] = normalizedRunDefaults({ ...layers, local }, models || [])[field];
    }
    return out;
  }, [layers, runLocal, models]);

  const save = async (): Promise<boolean> => {
    if (!api || !data || saving) return false;
    const saveRun = Boolean(models) && runChanged;
    const invalid = saveRun ? folderRunDefaultsError(runLocal, layers, models || []) : '';
    if (invalid) {
      setSaveError(invalid);
      setTab('defaults');
      return false;
    }
    const payload = {
      ...(!temporary ? { workspaceDir: workspace } : {}),
      promptMarkdown: policy.text,
      promptPolicy: promptPolicyFlags(policy),
      ...(saveRun ? { runDefaults: sparseRunDefaults(runLocal) } : {}),
    };
    setSaving(true);
    setSaveError('');
    try {
      const impact: any = await api.conversationFolderPropertiesImpact(folderId, payload);
      setSaving(false);
      const choice = await chooseImpact('保存', impact);
      if (choice === null) return false;
      setSaving(true);
      const result: any = await api.updateConversationFolderProperties(folderId, { ...payload, updateSnapshots: choice === true });
      setBaseline(snapshot(workspace, policy, runLocal));
      setData((d: any) => ({ ...d, runDefaults: { ...(d?.runDefaults || {}), local: sparseRunDefaults(runLocal) } }));
      if (!temporary) void tree.afterMutation([String(data.parentId || '')]);
      const skipped = Number(result.skippedRunningCount || 0);
      showToast(choice === true ? `属性已保存，更新 ${result.updatedCount || 0} 个快照${skipped ? `；运行中跳过 ${skipped} 个` : ''}` : '属性已保存；已有快照保持不变');
      return true;
    } catch (e) {
      setSaveError(apiErrorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (saving) return;
    if (dirty) setLeaveAsk(true);
    else onClose();
  };

  const title = name || data?.name || (temporary ? '临时会话属性' : '目录属性');
  const footer = (
    <View style={styles.footer}>
      {tab === 'defaults' ? (
        <Press onPress={() => setRunLocal({})} disabled={!Object.keys(sparseRunDefaults(runLocal)).length || !models || saving} style={styles.link} testID="folder-props-reset">
          <Text style={{ color: !Object.keys(sparseRunDefaults(runLocal)).length || !models ? theme.disabled : theme.text, fontSize: 14 }}>{temporary ? '全部使用原有默认' : '全部恢复继承'}</Text>
        </Press>
      ) : (
        <Text numberOfLines={2} style={[styles.footNote, { color: saveError ? theme.danger : theme.muted }]}>
          {saveError || (dirty ? '有未保存的修改' : '')}
        </Text>
      )}
      <Press onPress={() => void save().then((ok) => ok && onClose())} disabled={!data || saving || !dirty} style={[styles.primary, { backgroundColor: theme.button, opacity: !data || saving || !dirty ? 0.5 : 1 }]} testID="folder-props-save">
        {saving ? <ActivityIndicator color={theme.buttonText} /> : <Text style={[styles.primaryText, { color: theme.buttonText }]}>保存</Text>}
      </Press>
    </View>
  );

  return (
    <>
      <Sheet visible={visible} title={title} subtitle={temporary ? '临时会话属性' : data?.path ? `目录属性 · ${data.path}` : '目录属性'} onClose={requestClose} full footer={footer} testID="folder-properties">
        <View style={styles.tabs}>
          <Segmented
            theme={theme}
            value={tab}
            onChange={(key) => setTab(key as Tab)}
            items={[{ key: 'context', label: temporary ? '注入上下文' : '目录上下文' }, { key: 'defaults', label: '默认模型' }, ...(temporary ? [] : [{ key: 'trigger', label: '触发器' }])]}
          />
        </View>
        <SheetScroll contentContainerStyle={styles.body}>
          {loading ? <ActivityIndicator color={theme.muted} style={{ marginTop: 32 }} /> : null}
          {loadError ? (
            <View style={[styles.alert, { backgroundColor: theme.dangerSoft }]}>
              <Text style={{ color: theme.danger, flex: 1 }}>{loadError}</Text>
              <Press onPress={() => void load()} style={styles.alertBtn} testID="folder-props-reload">
                <Text style={{ color: theme.text }}>重试</Text>
              </Press>
            </View>
          ) : null}
          {data && tab === 'context' ? (
            <View style={{ gap: 12 }}>
              {!temporary ? (
                <View style={[styles.card, { borderColor: theme.line }]}>
                  <TextField
                    label="本节点工作目录（清空即继承）"
                    value={workspace}
                    onChangeText={setWorkspace}
                    placeholder="例如 /home/user/projects/my-project"
                    hint={`当前生效：${data.workspace?.effective || '默认 workspace'}${data.workspace?.sourcePath ? `（来自 ${data.workspace.sourcePath}）` : ''}`}
                    editable={!saving}
                    testID="folder-workspace"
                  />
                </View>
              ) : (
                <Text style={[styles.note, { color: theme.muted }]}>注入到以后新建的临时会话；只影响以后新建的临时会话，不影响项目目录。</Text>
              )}
              <PromptPolicyEditor
                value={policy}
                inherited={normalizePromptPolicy(data.promptPolicy?.inherited || { text: data.prompt?.inherited })}
                inheritedSourcePath={data.promptPolicy?.inheritedSourcePath || ''}
                folderId={folderId}
                disabled={saving}
                onChange={(next) => setPolicy(normalizePromptPolicy(next))}
              />
            </View>
          ) : null}
          {data && tab === 'defaults' ? (
            <View style={{ gap: 10 }}>
              {!models ? <Text style={[styles.note, { color: theme.warning }]}>模型选项暂不可用，运行默认保持只读。</Text> : null}
              <RunConfigEditor
                value={folderDefaultsToRunConfig(runLocal)}
                inherited={folderDefaultsToRunConfig(inheritedValues)}
                allowInherit
                disabled={!models || saving}
                onChange={(patch) => {
                  setSaveError('');
                  setRunLocal((current) => applyFolderPatch(current, patch));
                }}
                testID="folder-props-runconfig"
              />
              <Text style={[styles.note, { color: theme.muted }]}>
                {temporary ? '每项独立设置，未设置时使用原有默认；只影响以后新建的临时会话。' : '每项独立向上继承；只影响以后新建的会话，不会批量更改已有会话。'}
              </Text>
            </View>
          ) : null}
          {data && tab === 'trigger' && !temporary ? <TriggerTags scopeType="folder" scopeId={folderId} onLeave={onClose} /> : null}
        </SheetScroll>
      </Sheet>
      <ChoiceSheet
        visible={leaveAsk}
        title={`离开${temporary ? '临时会话属性' : '目录属性'}？`}
        message="有尚未保存的修改。"
        choices={[
          { key: 'save', label: '保存后离开', tone: 'primary', testID: 'leave-save' },
          { key: 'discard', label: '放弃更改', tone: 'danger', testID: 'leave-discard' },
          { key: 'stay', label: '继续编辑', tone: 'plain', testID: 'leave-stay' },
        ]}
        onChoose={(key) => {
          setLeaveAsk(false);
          if (key === 'discard') onClose();
          else if (key === 'save') void save().then((ok) => ok && onClose());
        }}
      />
      {impactElement}
    </>
  );
}

const styles = StyleSheet.create({
  tabs: { paddingHorizontal: 16, paddingBottom: 8 },
  body: { paddingHorizontal: 16, paddingBottom: 20, gap: 12 },
  card: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  note: { fontSize: 13, lineHeight: 19 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  footNote: { flex: 1, fontSize: 12.5 },
  link: { flex: 1, minHeight: 40, justifyContent: 'center' },
  primary: { minHeight: 46, minWidth: 96, paddingHorizontal: 20, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 16, fontWeight: '600' },
  alert: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: radius.md },
  alertBtn: { paddingHorizontal: 10, minHeight: 36, justifyContent: 'center' },
});
