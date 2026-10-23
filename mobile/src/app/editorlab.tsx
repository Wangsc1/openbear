/**
 * 开发者页：内嵌代码编辑器的验收页。
 * - 记忆正文：@mem/@secret/@doc 引用补全，候选来自当前服务器的真实记忆、凭证名、文档；
 * - 提示词模板：[[变量]] 与 @if/@each 指令补全；
 * - JSON：行号、折叠、格式化（与上下文编辑器相同的 code 模式）。
 */
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '../data/session';
import { CodeEditor, type CodeEditorHandle, type RefData } from '../editor/CodeEditor';
import { createOpenBearApi } from '../transport/apiAdapter';
import { IconButton, NavRow, Press, Segmented } from '../ui/primitives';
import { useTheme } from '../ui/theme';

const SAMPLES = {
  memory: '记忆正文示例：输入 @ 试试引用补全，例如 @mem/ 或 @doc/\n\n',
  template: '## 系统提示词模板\n\n当前时间：[[ time.now ]]\n\n@if toolNames.length\n可用工具：[[ helpers.join(toolNames, \', \') ]]\n@endif\n\n',
  json: '{"role":"user","content":[{"type":"text","text":"hello"}],"meta":{"tokens":12,"cached":false}}',
};

export default function EditorLab() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const editor = useRef<CodeEditorHandle>(null);
  const [kind, setKind] = useState<'memory' | 'template' | 'json'>('memory');
  const [values, setValues] = useState(SAMPLES);
  const [refData, setRefData] = useState<RefData>({ mem: [], secret: [], doc: [] });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!session.http) return;
    const api = createOpenBearApi(session.http);
    // 与 Web MemoryView.loadRefData 相同：凭证只取名字和备注，不取值
    void Promise.all([api.entries('', true), api.secrets(false, true), api.docs(true)])
      .then(([entries, secrets, docs]: any[]) =>
        setRefData({
          mem: (entries.items || []).filter((e: any) => e.ref).map((e: any) => ({ key: e.ref, name: e.title, note: e.note || '' })),
          secret: (secrets.items || []).filter((s: any) => !s.archived && (s.enabled ?? 1)).map((s: any) => ({ key: s.name, note: s.note || '' })),
          doc: (docs.items || []).filter((d: any) => !d.archived && (d.enabled ?? 1)).map((d: any) => ({ key: d.name, title: d.title || '' })),
        }),
      )
      .catch((err) => setError(String(err?.body?.error || err?.message || err)));
  }, [session.http]);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top }} testID="editorlab">
      <NavRow theme={theme} title="代码编辑器" left={<IconButton icon={ChevronLeft} theme={theme} label="返回" onPress={() => router.back()} />} />
      <View style={styles.bar}>
        <Segmented
          theme={theme}
          value={kind}
          onChange={(key) => setKind(key as typeof kind)}
          items={[
            { key: 'memory', label: '记忆' },
            { key: 'template', label: '模板' },
            { key: 'json', label: 'JSON' },
          ]}
        />
        {kind === 'json' ? (
          <Press onPress={() => editor.current?.format()} style={[styles.button, { borderColor: theme.border }]} testID="editorlab-format">
            <Text style={{ color: theme.text }}>格式化</Text>
          </Press>
        ) : null}
      </View>
      <Text style={[styles.meta, { color: theme.muted }]} testID="editorlab-meta">
        {`引用候选：记忆 ${refData.mem.length} · 凭证 ${refData.secret.length} · 文档 ${refData.doc.length}${error ? ` · 读取失败 ${error}` : ''}`}
      </Text>
      <CodeEditor
        key={kind}
        ref={editor}
        value={values[kind]}
        onChange={(value) => setValues((v) => ({ ...v, [kind]: value }))}
        onFormatError={(message) => setError(`JSON 格式错误：${message}`)}
        mode={kind === 'json' ? 'code' : 'markdown'}
        language={kind === 'json' ? 'json' : 'markdown'}
        completionMode={kind === 'memory' ? 'memory' : kind === 'template' ? 'template' : 'none'}
        refData={refData}
        style={[styles.editor, { marginBottom: insets.bottom + 12 }]}
        testID="editorlab-editor"
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  button: { height: 32, paddingHorizontal: 14, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  meta: { fontSize: 12, paddingHorizontal: 16, paddingBottom: 8 },
  editor: { flex: 1, marginHorizontal: 12 },
});
