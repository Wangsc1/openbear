/**
 * 提示词策略编辑（Web PromptPolicyEditor）：目录属性、临时会话属性、会话属性共用。
 * - 本地提示词：留空即继承（显示继承来源与继承内容预览）；
 * - 覆盖系统提示词：开启时编辑器用模板模式（[[变量]] 补全，与 Web PromptTemplateEditor 相同），否则 Markdown；
 * - 使用工具 + 允许的工具多选（GET /api/prompt-tools，按内置 / MCP / 不可用的已选分组）；
 * - 注入用户消息模板；预览模板正文（POST /api/prompt-template/preview）；
 * - 继承状态下开关只读（与 Web 相同：flags 跟随继承来源）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { CodeEditor } from '../editor/CodeEditor';
import { useSession } from '../data/session';
import { createOpenBearApi } from '../transport/apiAdapter';
import { OptionSheet, SwitchRow } from '../ui/Form';
import { FieldRow } from '../ui/Form';
import { Press } from '../ui/primitives';
import { radius, useTheme } from '../ui/theme';
import { apiErrorText } from '../tree/treeStore';
import { normalizePromptPolicy, type PromptPolicy, promptToolGroups } from '../tree/webTree';

type Props = {
  value: PromptPolicy;
  inherited: PromptPolicy;
  inheritedSourcePath?: string;
  disabled?: boolean;
  folderId?: string;
  conversationId?: string;
  onChange(next: PromptPolicy): void;
};

export function PromptPolicyEditor({ value, inherited, inheritedSourcePath, disabled, folderId, conversationId, onChange }: Props) {
  const theme = useTheme();
  const session = useSession();
  const local = normalizePromptPolicy(value);
  const inh = normalizePromptPolicy(inherited);
  const inherits = !local.text.trim();
  const shown = inherits ? inh : local;
  const flagsDisabled = Boolean(disabled) || inherits;
  const [tools, setTools] = useState<any[]>([]);
  const [toolsError, setToolsError] = useState('');
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolSheet, setToolSheet] = useState(false);
  const [preview, setPreview] = useState<{ text: string; error: string; loading: boolean; ready: boolean }>({ text: '', error: '', loading: false, ready: false });
  const [showInherited, setShowInherited] = useState(false);
  const api = useMemo(() => (session.http ? createOpenBearApi(session.http) : null), [session.http]);

  const patch = (field: keyof PromptPolicy, next: any) => {
    if (disabled || (field !== 'text' && inherits)) return;
    onChange({ ...local, [field]: next });
  };

  const loadTools = async () => {
    if (!api || toolsLoading) return;
    setToolsLoading(true);
    setToolsError('');
    try {
      const data: any = await api.promptTools();
      setTools(data.items || []);
    } catch (error) {
      setToolsError(apiErrorText(error));
    } finally {
      setToolsLoading(false);
    }
  };
  useEffect(() => {
    void loadTools();
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  // 输入变化后预览作废（与 Web previewInput watch 相同）
  const previewKey = JSON.stringify({ folderId, conversationId, ...local });
  useEffect(() => setPreview({ text: '', error: '', loading: false, ready: false }), [previewKey]);
  const runPreview = async () => {
    if (!api || disabled || inherits || !local.overrideSystemPrompt) return;
    setPreview({ text: '', error: '', loading: true, ready: false });
    try {
      const result: any = await api.previewPromptTemplate({ ...(conversationId ? { conversationId } : { folderId }), ...local });
      setPreview({ text: String(result.prompt || ''), error: '', loading: false, ready: true });
    } catch (error: any) {
      setPreview({ text: '', error: String(error?.body?.message || apiErrorText(error)), loading: false, ready: false });
    }
  };

  const groups = promptToolGroups(tools, shown.toolNames);
  const toolOptions = groups.flatMap((group) => group.items.map((tool: any) => ({ value: String(tool.name), label: `${tool.name}${tool.unavailable ? '（不可用）' : ''}`, detail: `${group.label}${tool.description ? ` · ${String(tool.description).slice(0, 80)}` : ''}` })));

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: theme.text }]}>本地提示词</Text>
          <Text style={[styles.hint, { color: theme.muted }]}>{inherits ? `留空继承${inheritedSourcePath ? ` · 当前继承自「${inheritedSourcePath}」` : ''}` : '已设置本节点提示词'}</Text>
        </View>
      </View>
      <CodeEditor
        key={shown.overrideSystemPrompt ? 'template' : 'markdown'}
        value={local.text}
        onChange={(text) => patch('text', text)}
        readOnly={disabled}
        mode="markdown"
        language="markdown"
        completionMode={shown.overrideSystemPrompt ? 'template' : 'none'}
        style={[styles.editor, { borderColor: theme.border }]}
        testID="prompt-editor"
      />
      {inherits && inh.text ? (
        <Press onPress={() => setShowInherited((v) => !v)} style={[styles.inherited, { backgroundColor: theme.surfaceSoft }]} testID="prompt-inherited">
          <Text style={[styles.hint, { color: theme.subtle }]}>{showInherited ? '收起继承内容' : `查看继承内容（${inh.text.length} 字）`}</Text>
          {showInherited ? (
            <Text selectable style={[styles.mono, { color: theme.text }]}>
              {inh.text}
            </Text>
          ) : null}
        </Press>
      ) : null}
      <View style={[styles.group, { borderColor: theme.line }]}>
        <SwitchRow label="覆盖系统提示词" detail={inherits ? '继承状态下跟随上级，填写本地提示词后可修改' : '开启后本地提示词作为完整系统提示词模板'} value={shown.overrideSystemPrompt} disabled={flagsDisabled} onChange={(v) => patch('overrideSystemPrompt', v)} testID="policy-override" />
        {shown.overrideSystemPrompt ? (
          <>
            <SwitchRow label="使用工具" value={shown.toolsEnabled} disabled={flagsDisabled} onChange={(v) => patch('toolsEnabled', v)} testID="policy-tools" />
            <FieldRow label="允许的工具" detail={toolsLoading ? '正在读取工具列表…' : toolsError ? `工具列表读取失败：${toolsError}。已选工具保留。` : shown.toolNames.length ? shown.toolNames.join('、') : '未选择'} onPress={flagsDisabled || !shown.toolsEnabled ? undefined : () => (toolsError ? void loadTools() : setToolSheet(true))} testID="policy-tool-names">
              {toolsError ? <Text style={{ color: theme.text, fontSize: 14 }}>重试</Text> : null}
            </FieldRow>
            <SwitchRow label="注入用户消息模板" value={shown.userMessageTemplateEnabled} disabled={flagsDisabled} onChange={(v) => patch('userMessageTemplateEnabled', v)} testID="policy-user-template" />
          </>
        ) : null}
      </View>
      {shown.overrideSystemPrompt && !inherits ? (
        <View style={{ gap: 8 }}>
          <Press onPress={() => void runPreview()} disabled={disabled || preview.loading} style={[styles.previewBtn, { borderColor: theme.border }]} testID="policy-preview">
            {preview.loading ? <ActivityIndicator color={theme.text} /> : <Text style={{ color: theme.text, fontSize: 15 }}>预览模板正文</Text>}
          </Press>
          {preview.error ? <Text style={[styles.hint, { color: theme.danger }]}>{preview.error}</Text> : null}
          {preview.ready ? (
            <Text selectable style={[styles.mono, styles.previewBox, { color: theme.text, backgroundColor: theme.surfaceSoft }]} testID="policy-preview-text">
              {preview.text || '（渲染结果为空）'}
            </Text>
          ) : null}
        </View>
      ) : null}
      <OptionSheet visible={toolSheet} title="允许使用的工具" multiple options={toolOptions} value={shown.toolNames} onChange={(names: string[]) => patch('toolNames', names)} onClose={() => setToolSheet(false)} testID="policy-tool-sheet" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center' },
  label: { fontSize: 15.5, fontWeight: '600' },
  hint: { fontSize: 12.5, lineHeight: 18 },
  editor: { height: 240, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  inherited: { borderRadius: radius.md, padding: 12, gap: 8 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12.5, lineHeight: 19 },
  group: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  previewBtn: { height: 44, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  previewBox: { padding: 12, borderRadius: radius.md, maxHeight: 320 },
});
