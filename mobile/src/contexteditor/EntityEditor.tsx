/**
 * 字段 / 工具定义 / 工具调用 / 内容块的编辑页（对应 Web 的 entityEditor 对话框）：全屏编辑页，
 * 工具与调用有“字段编辑 / 完整 JSON”两种视图；参数、调用参数、内容块都用 CodeEditor（json / markdown）。
 * 保存前不会改动编辑稿；JSON 无效时报错并留在当前视图。
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { EditorPage } from '../panel/EditorPage';
import { CodeEditor, Segmented, TextField, useTheme } from '../ui';
import * as M from './model';
import { Banner } from './parts';

export function EntityEditor({ draft, onCancel, onSave }: { draft: M.EntityDraft | null; onCancel(): void; onSave(draft: M.EntityDraft): string | null }) {
  const theme = useTheme();
  const [d, setD] = useState<M.EntityDraft | null>(draft);
  const [error, setError] = useState('');
  useEffect(() => {
    setD(draft);
    setError('');
  }, [draft]);
  const title = !d ? '' : d.kind === 'tool' ? (d.index < 0 ? '添加工具定义' : `编辑工具 · ${d.data?.name || '未命名'}`) : d.kind === 'call' ? (d.index < 0 ? '添加工具调用' : '编辑工具调用') : `编辑 ${d.field}`;
  const switchView = (view: 'fields' | 'raw') => {
    if (!d) return;
    try {
      setD(M.entityView(d, view));
      setError('');
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  };
  const language = !d ? 'json' : d.json ? 'json' : d.field === 'reasoning' ? 'markdown' : 'plaintext';
  const showHelp = d?.kind === 'field' && (d.block || ['signature', 'reasoning', 'native_output_items'].includes(d.field));
  return (
    <EditorPage
      visible={Boolean(draft)}
      title={title}
      subtitle="保存前不会改动编辑稿"
      onCancel={onCancel}
      onSave={() => {
        if (!d) return;
        const message = onSave(d);
        if (message) setError(message);
      }}
      saveLabel="保存修改"
      testID="ce-entity"
    >
      {d ? (
        <View style={styles.root}>
          {d.kind !== 'field' ? (
            <View style={styles.seg}>
              <Segmented
                theme={theme}
                items={[
                  { key: 'fields', label: '字段编辑' },
                  { key: 'raw', label: '完整 JSON' },
                ]}
                value={d.view}
                onChange={(key) => switchView(key as 'fields' | 'raw')}
              />
            </View>
          ) : null}
          {error ? <Banner theme={theme} tone="error" text={error} testID="ce-entity-error" /> : null}
          {d.view === 'raw' ? (
            <CodeEditor key="entity-raw" mode="code" language="json" value={d.raw} onChange={(raw) => setD({ ...d, raw })} style={styles.editor} testID="ce-entity-raw" />
          ) : d.kind === 'field' ? (
            <>
              <CodeEditor
                key={`entity-field-${language}`}
                mode={language === 'json' ? 'code' : 'markdown'}
                language={language}
                value={d.text}
                onChange={(text) => setD({ ...d, text })}
                style={styles.editor}
                testID="ce-entity-text"
              />
              {showHelp ? <Text style={[styles.help, { color: theme.muted }]}>原有字段原样保留。手动修改不会重新签名，是否可续接仍需服务端校验。</Text> : null}
            </>
          ) : (
            <ScrollView contentContainerStyle={{ paddingBottom: 12 }} keyboardShouldPersistTaps="handled">
              <TextField
                label={d.kind === 'tool' ? '工具名称' : '调用工具'}
                value={String(d.data?.name ?? '')}
                onChangeText={(name) => setD({ ...d, data: { ...d.data, name } })}
                testID="ce-entity-name"
              />
              {d.kind === 'call' ? (
                <TextField label="调用 ID" value={String(d.data?.id ?? '')} onChangeText={(id) => setD({ ...d, data: { ...d.data, id } })} mono testID="ce-entity-id" />
              ) : (
                <TextField
                  label="说明"
                  multiline
                  value={String(d.data?.description ?? '')}
                  placeholder="工具用途及使用说明"
                  onChangeText={(description) => setD({ ...d, data: { ...d.data, description } })}
                  style={{ minHeight: 72 }}
                  testID="ce-entity-description"
                />
              )}
              <Text style={[styles.label, { color: theme.subtle }]}>{d.kind === 'tool' ? '参数定义 · JSON' : '调用参数 · JSON'}</Text>
              <CodeEditor key="entity-json" mode="code" language="json" value={d.text} onChange={(text) => setD({ ...d, text })} style={styles.jsonEditor} testID="ce-entity-json" />
            </ScrollView>
          )}
        </View>
      ) : null}
    </EditorPage>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingBottom: 8 },
  seg: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
  editor: { flex: 1, marginHorizontal: 12, marginTop: 8 },
  jsonEditor: { marginHorizontal: 14, height: 340 },
  label: { fontSize: 12.5, fontWeight: '500', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 6 },
  help: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingTop: 8 },
});
