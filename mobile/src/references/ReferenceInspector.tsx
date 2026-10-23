/**
 * 引用详情（B3-19，Web ReferenceInspector.vue）：点输入区上方的引用胶囊打开。
 * - POST /api/references/inspect：当前来源、约 N Tokens、内容预览（凭证不展示值，只给敏感提示）；
 * - 可编辑（草稿里）：引用模式（引用内容 / 仅提及）；会话引用的注入范围（全文 / 最近 N 轮，1–50）；
 * - 超长降级的原因（policyReasonTitle）；移除引用。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Minus, Plus, Trash2 } from 'lucide-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Seg } from '../runconfig/RunConfigEditor';
import { useOpenBearApi } from '../runconfig/options';
import { HttpError } from '../transport/http';
import { Icon, Press } from '../ui/primitives';
import { Sheet, SheetScroll } from '../ui/Sheet';
import { useTheme } from '../ui/theme';
import { acceptReferenceSizes } from './catalogStore';
import { KIND_LABELS, normalizeReference, policyReasonTitle, referenceErrorText, referenceToken, refTitle, type Ref } from './draftModel';

type Props = {
  visible: boolean;
  reference: Ref | null;
  currentConversation: string;
  editable: boolean;
  onUpdate(ref: Ref): void;
  onRemove(): void;
  onClose(): void;
};

export function ReferenceInspector({ visible, reference, currentConversation, editable, onUpdate, onRemove, onClose }: Props) {
  const theme = useTheme();
  const api = useOpenBearApi();
  const [details, setDetails] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  const load = useCallback(
    async (ref: Ref) => {
      if (!api) return;
      const current = ++generation.current;
      setBusy(true);
      setError('');
      setDetails(null);
      try {
        const result: any = await api.referenceInspect(referenceToken(ref), currentConversation, '');
        if (current !== generation.current) return;
        acceptReferenceSizes([result.item], result.conversationContentLimit);
        setDetails(result);
      } catch (e) {
        if (current === generation.current) setError(referenceErrorText(e instanceof HttpError ? e.body?.error || '引用暂时无法读取' : '引用暂时无法读取'));
      } finally {
        if (current === generation.current) setBusy(false);
      }
    },
    [api, currentConversation],
  );

  useEffect(() => {
    if (visible && reference) void load(reference);
  }, [visible, reference ? referenceToken(reference) : '']); // eslint-disable-line react-hooks/exhaustive-deps

  if (!reference) return null;
  const mode = reference.mode === 'mention' ? 'mention' : 'content';
  const scope = reference.scope === 'recent' ? 'recent' : 'full';
  const turns = Number(reference.turns || 20);
  const update = (patch: Partial<Ref>) => {
    const next = normalizeReference({ ...reference, ...patch });
    if (next) onUpdate(next);
  };
  const item = details?.item || {};
  const sensitive = Boolean(item.sensitive) && mode !== 'mention';

  return (
    <Sheet visible={visible} onClose={onClose} title={reference.label} subtitle={refTitle(reference)} testID="reference-inspector">
      <SheetScroll contentContainerStyle={styles.body}>
        {editable ? (
          <View style={styles.block}>
            <Text style={[styles.label, { color: theme.muted }]}>引用模式</Text>
            <Seg
              theme={theme}
              items={[{ key: 'content', label: '引用内容' }, { key: 'mention', label: '仅提及' }]}
              value={mode}
              onChange={(k) => update({ mode: k === 'mention' ? 'mention' : '', modeReason: '' })}
              testID="inspector-mode"
            />
          </View>
        ) : null}
        {editable && reference.kind === 'chat' && (mode !== 'mention' || reference.modeReason) ? (
          <View style={styles.block}>
            <Text style={[styles.label, { color: theme.muted }]}>注入范围</Text>
            <Seg
              theme={theme}
              items={[{ key: 'full', label: '全文' }, { key: 'recent', label: '最近若干轮' }]}
              value={scope}
              onChange={(k) => update({ scope: k, turns: k === 'recent' ? turns || 20 : undefined, bodyChars: undefined, ...(reference.modeReason ? { mode: '', modeReason: '' } : {}) })}
              testID="inspector-scope"
            />
            {scope === 'recent' ? (
              <View style={styles.stepper}>
                <Pressable onPress={() => update({ turns: Math.max(1, turns - 1), bodyChars: undefined })} style={[styles.stepBtn, { backgroundColor: theme.hover }]} accessibilityLabel="减少轮数" testID="inspector-turns-minus">
                  <Icon as={Minus} size={16} color={theme.text} />
                </Pressable>
                <Text style={[styles.turns, { color: theme.textStrong }]} testID="inspector-turns">最近 {turns} 轮</Text>
                <Pressable onPress={() => update({ turns: Math.min(50, turns + 1), bodyChars: undefined })} style={[styles.stepBtn, { backgroundColor: theme.hover }]} accessibilityLabel="增加轮数" testID="inspector-turns-plus">
                  <Icon as={Plus} size={16} color={theme.text} />
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
        {reference.modeReason ? <Text style={[styles.meta, { color: theme.warning }]}>{policyReasonTitle(reference).replace('将仅提及', '已仅提及')}</Text> : null}
        {busy ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.muted} />
            <Text style={[styles.meta, { color: theme.muted }]}>正在读取引用信息…</Text>
          </View>
        ) : error ? (
          <Text style={[styles.meta, { color: theme.danger }]}>{error}</Text>
        ) : details ? (
          <>
            <Text style={[styles.meta, { color: theme.subtle }]} testID="inspector-tokens">
              {details.frozen ? '本条消息引用时的版本' : '当前来源'} · {KIND_LABELS[reference.kind] || '引用'} · 约 {Number(item.estimatedTokens || 0).toLocaleString()} Tokens
            </Text>
            {mode === 'mention' ? <Text style={[styles.meta, { color: theme.muted }]}>仅提供名称与定位，不附正文。</Text> : null}
            {sensitive ? (
              <Text style={[styles.sensitive, { color: theme.warning, backgroundColor: theme.warningSoft }]}>凭证会在发送时提供给当前模型。这里不展示或复制凭证值，草稿与胶囊只保存引用。</Text>
            ) : (
              <Text selectable style={[styles.content, { color: theme.text, backgroundColor: theme.surfaceSoft }]} numberOfLines={60}>
                {mode === 'mention' ? JSON.stringify(item.locator || {}, null, 2) : details.content || '内容为空'}
              </Text>
            )}
            {details.previewTruncated ? <Text style={[styles.meta, { color: theme.muted }]}>此处仅展示部分预览，不代表发送内容被截断。</Text> : null}
          </>
        ) : null}
        {editable ? (
          <Press onPress={onRemove} style={[styles.remove, { borderColor: theme.border }]} accessibilityRole="button" testID="inspector-remove">
            <Icon as={Trash2} size={17} color={theme.danger} />
            <Text style={[styles.removeText, { color: theme.danger }]}>移除这个引用</Text>
          </Press>
        ) : null}
      </SheetScroll>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingBottom: 12, gap: 12 },
  block: { gap: 8 },
  label: { fontSize: 12.5, fontWeight: '500' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  turns: { fontSize: 15, minWidth: 90, textAlign: 'center' },
  meta: { fontSize: 13, lineHeight: 19 },
  center: { alignItems: 'center', gap: 8, paddingVertical: 16 },
  sensitive: { fontSize: 13.5, lineHeight: 21, padding: 12, borderRadius: 12 },
  content: { fontSize: 13, lineHeight: 20, padding: 12, borderRadius: 12 },
  remove: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginTop: 4 },
  removeText: { fontSize: 15, fontWeight: '500' },
});
