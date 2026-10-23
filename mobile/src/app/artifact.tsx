/**
 * 产物预览（B2-83～B2-88）：全屏页面（手机上即 Web 的“最大化”）。
 * - 头部：标题、文件名 · 类型 · 大小；右侧下载/保存（系统分享面板）；返回/系统返回关闭；
 * - Markdown：文档 / 源码切换，记住每个文件的模式与阅读位置（进程内，同 Web readingState）；
 * - HTML：首次打开必须是源码；切到“页面预览”才在沙箱 WebView 中执行（CSP 包装同 Web htmlPreviewDocument，
 *   禁止网络、只允许内联脚本；originWhitelist 仅 about:，不注入原生桥）；
 * - 代码/文本：轻量高亮、自动换行开关、复制全文；
 * - 图片：缩小 / 适应 / 放大，失败可重新读取；
 * - 不支持的类型：显示类型与大小，提供下载；读取失败可“重新读取”。
 */
import { router, useLocalSearchParams } from 'expo-router';
import { AlertTriangle, ChevronLeft, Copy, Download, FileQuestion, RefreshCw, WrapText } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { artifactFromUrl } from '../artifacts/artifactLinks';
import { useArtifactRecord } from '../artifacts/ArtifactCard';
import { artifactErrorMessage, loadArtifactMetadata, loadArtifactText, readingState, shareArtifactFile } from '../artifacts/artifactStore';
import { chunkLines, highlightLine, type Token } from '../artifacts/codeHighlight';
import { ZoomableImage } from '../artifacts/ImageViewer';
import { copyText } from '../chat/chatApi';
import { enrichedRenderer } from '../chat/markdown/EnrichedBody';
import { artifactFormat, artifactPresentation, formatFileSize, htmlPreviewDocument } from '../data/webLogic';
import { showToast } from '../ui/Toast';
import { GlassBar, Icon, IconButton, NAV_ROW_HEIGHT, NavRow, Press, Segmented } from '../ui/primitives';
import { fonts, readingWidth, useTheme, type Theme } from '../ui/theme';

export default function ArtifactPreviewPage() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ uuid: string; aid: string; label?: string }>();
  const identity = useMemo(() => artifactFromUrl(`/api/conversations/${params.uuid}/artifacts/${params.aid}/content`), [params.uuid, params.aid]);
  const { record, http } = useArtifactRecord(identity!, false);
  const [metaState, setMetaState] = useState<'loading' | 'ready' | 'error'>(record.metadata ? 'ready' : 'loading');
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState('');
  const [textLoading, setTextLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const meta = record.metadata;
  const format = artifactFormat(meta);
  const presentation = artifactPresentation(meta);
  const reading = useMemo(() => (identity ? readingState(identity.key, format.kind === 'html' ? 'source' : 'preview') : null), [identity, format.kind]);
  const [mode, setMode] = useState(() => reading?.mode || 'preview');
  const [wrap, setWrap] = useState(() => reading?.wrap ?? true);

  useEffect(() => {
    if (!http || !identity) return;
    let alive = true;
    setMetaState(record.metadata && attempt === 0 ? 'ready' : 'loading');
    loadArtifactMetadata(http, record, attempt > 0)
      .then(() => alive && setMetaState('ready'))
      .catch(() => alive && setMetaState('error'));
    return () => {
      alive = false;
    };
  }, [http, identity, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // HTML 首次打开总是源码；其他格式沿用记住的模式
  useEffect(() => {
    if (!reading || !meta) return;
    if (format.kind === 'html' && !['source', 'preview'].includes(reading.mode)) reading.mode = 'source';
    setMode(reading.mode);
  }, [meta?.artifactUuid, format.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!http || !meta || !['markdown', 'html', 'text', 'code'].includes(format.kind)) return;
    let alive = true;
    setTextLoading(true);
    setTextError('');
    loadArtifactText(http, record)
      .then((value) => alive && setText(value))
      .catch((error) => alive && setTextError(artifactErrorMessage(error)))
      .finally(() => alive && setTextLoading(false));
    return () => {
      alive = false;
    };
  }, [http, meta?.sha256, format.kind, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!http || !identity || saving) return;
    setSaving(true);
    try {
      await shareArtifactFile(http, identity, meta);
    } catch (error) {
      showToast(artifactErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const changeMode = (next: string) => {
    if (reading) reading.mode = next;
    setMode(next);
  };
  const toggleWrap = () => {
    if (reading) reading.wrap = !wrap;
    setWrap(!wrap);
  };

  const topInset = insets.top + NAV_ROW_HEIGHT;
  const padH = width >= 768 ? Math.max(24, Math.round((width - readingWidth) / 2)) : 16;
  const title = String(params.label || record.summary?.title || meta?.fileName || '附件');
  const subtitle = meta ? [meta.fileName !== title ? meta.fileName : '', presentation.label, formatFileSize(meta.sizeBytes)].filter(Boolean).join(' · ') : metaState === 'loading' ? '正在读取附件信息…' : '';

  const retry = () => setAttempt((n) => n + 1);
  let body: React.ReactNode;
  if (!identity) body = <Notice theme={theme} icon={AlertTriangle} title="附件地址无效" />;
  else if (metaState === 'loading' && !meta) body = <ActivityIndicator style={{ marginTop: 40 }} color={theme.muted} />;
  else if (metaState === 'error' || !meta) body = <Notice theme={theme} icon={AlertTriangle} title="附件读取失败" text={record.error || '附件暂时无法读取，请重试。'} action="重新读取" onAction={retry} />;
  else if (format.kind === 'image') {
    body = http ? (
      <View style={{ flex: 1, marginTop: topInset }}>
        <ZoomableImage image={{ uri: http.url(identity.contentUrl), headers: http.headers() }} testID="artifact-image" />
      </View>
    ) : null;
  } else if (format.kind === 'unsupported') {
    body = <Notice theme={theme} icon={FileQuestion} title={`${presentation.label} · ${format.label}`} text={`${formatFileSize(meta.sizeBytes)} · 此格式暂不支持站内预览，可下载后用其他应用打开。`} action={saving ? '准备中…' : '下载原文件'} onAction={() => void save()} actionIcon={Download} />;
  } else if (textLoading && text == null) body = <ActivityIndicator style={{ marginTop: topInset + 40 }} color={theme.muted} />;
  else if (textError) body = <Notice theme={theme} icon={AlertTriangle} title="无法预览这个文件" text={textError} action="重新读取" onAction={retry} secondary="下载原文件" onSecondary={() => void save()} />;
  else if (text != null) {
    const source = <SourceView theme={theme} text={text} language={format.kind === 'markdown' ? 'markdown' : format.language} wrap={wrap} topInset={topInset + 52} padH={padH} initialTop={reading?.sourceTop || 0} onScrollTop={(y) => reading && (reading.sourceTop = y)} />;
    if (format.kind === 'markdown') {
      body = (
        <>
          {mode === 'preview' ? <MarkdownDoc theme={theme} text={text} topInset={topInset + 52} padH={padH} initialTop={reading?.previewTop || 0} onScrollTop={(y) => reading && (reading.previewTop = y)} /> : source}
          <ModeBar theme={theme} top={topInset} padH={padH} items={[{ key: 'preview', label: '文档' }, { key: 'source', label: '源码' }]} value={mode} onChange={changeMode} wrap={mode === 'source' ? wrap : undefined} onWrap={toggleWrap} onCopy={() => void copyText(text, '内容')} />
        </>
      );
    } else if (format.kind === 'html') {
      body = (
        <>
          {mode === 'preview' ? (
            <View style={{ flex: 1, marginTop: topInset + 52, backgroundColor: '#fff' }} testID="artifact-html-preview">
              <WebView
                source={{ html: htmlPreviewDocument(text), baseUrl: 'about:blank' }}
                originWhitelist={['about:*']}
                javaScriptEnabled
                domStorageEnabled={false}
                allowFileAccess={false}
                allowUniversalAccessFromFileURLs={false}
                setSupportMultipleWindows={false}
                onShouldStartLoadWithRequest={(req) => req.url.startsWith('about:') || req.url.startsWith('data:')}
                style={{ flex: 1 }}
              />
            </View>
          ) : source}
          <ModeBar theme={theme} top={topInset} padH={padH} items={[{ key: 'source', label: '源码' }, { key: 'preview', label: '页面预览' }]} value={mode} onChange={changeMode} wrap={mode === 'source' ? wrap : undefined} onWrap={toggleWrap} onCopy={() => void copyText(text, '源码')} note={mode === 'preview' ? '沙箱执行 · 已禁止网络' : ''} />
        </>
      );
    } else {
      body = (
        <>
          {source}
          <ModeBar theme={theme} top={topInset} padH={padH} label={format.sourceOnly ? 'SVG 源码（不执行）' : format.label} wrap={wrap} onWrap={toggleWrap} onCopy={() => void copyText(text, '内容')} />
        </>
      );
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: format.kind === 'image' ? '#000' : theme.bg }]} testID="artifact-preview">
      {body}
      <GlassBar theme={theme}>
        <NavRow
          theme={theme}
          title={title}
          subtitle={subtitle || undefined}
          left={<IconButton icon={ChevronLeft} size={26} theme={theme} label="返回" onPress={() => router.back()} testID="back" />}
          right={
            <>
              {saving ? <ActivityIndicator color={theme.subtle} style={{ width: 40 }} /> : <IconButton icon={Download} theme={theme} label="下载原文件" onPress={() => void save()} testID="artifact-save" />}
            </>
          }
        />
      </GlassBar>
    </View>
  );
}

function ModeBar({ theme, top, padH, items, value, onChange, label, wrap, onWrap, onCopy, note }: {
  theme: Theme; top: number; padH: number; items?: { key: string; label: string }[]; value?: string; onChange?: (k: string) => void; label?: string;
  wrap?: boolean; onWrap?: () => void; onCopy?: () => void; note?: string;
}) {
  return (
    <View style={[styles.modeBar, { top, paddingHorizontal: padH, backgroundColor: theme.bg, borderBottomColor: theme.line }]}>
      {items && onChange ? (
        <View style={{ width: 180 }}><Segmented theme={theme} items={items} value={value || ''} onChange={onChange} /></View>
      ) : (
        <Text style={[styles.modeLabel, { color: theme.subtle }]}>{label}</Text>
      )}
      <Text numberOfLines={1} style={[styles.note, { color: theme.muted }]}>{note || ''}</Text>
      {wrap !== undefined && onWrap ? (
        <Press onPress={onWrap} style={[styles.tool, wrap && { backgroundColor: theme.selected }]} accessibilityRole="button" accessibilityLabel={wrap ? '不自动换行' : '自动换行'} accessibilityState={{ selected: wrap }} testID="artifact-wrap">
          <Icon as={WrapText} size={17} color={wrap ? theme.textStrong : theme.muted} />
        </Press>
      ) : null}
      {onCopy ? (
        <Press onPress={onCopy} style={styles.tool} accessibilityRole="button" accessibilityLabel="复制全文" testID="artifact-copy">
          <Icon as={Copy} size={16} color={theme.subtle} />
        </Press>
      ) : null}
    </View>
  );
}

function MarkdownDoc({ theme, text, topInset, padH, initialTop, onScrollTop }: { theme: Theme; text: string; topInset: number; padH: number; initialTop: number; onScrollTop(y: number): void }) {
  const Body = enrichedRenderer.Component;
  const ref = useRef<ScrollView>(null);
  const restored = useRef(false);
  return (
    <ScrollView
      ref={ref}
      contentContainerStyle={{ paddingTop: topInset + 12, paddingBottom: 60, paddingHorizontal: padH }}
      onContentSizeChange={() => {
        if (!restored.current && initialTop > 0) ref.current?.scrollTo({ y: initialTop, animated: false });
        restored.current = true;
      }}
      scrollEventThrottle={100}
      onScroll={(e) => onScrollTop(e.nativeEvent.contentOffset.y)}
      testID="artifact-markdown"
    >
      <Body markdown={text} blockKind="paragraph" streaming={false} theme={theme} selectable />
    </ScrollView>
  );
}

const TOKEN_COLOR = (theme: Theme): Record<Token['kind'], string | undefined> => ({
  '': undefined,
  comment: theme.muted,
  string: theme.success,
  number: theme.warning,
  keyword: theme.violet,
  tag: theme.danger,
  attr: theme.blue,
  heading: theme.textStrong,
  punct: theme.subtle,
});

function SourceView({ theme, text, language, wrap, topInset, padH, initialTop, onScrollTop }: {
  theme: Theme; text: string; language: string; wrap: boolean; topInset: number; padH: number; initialTop: number; onScrollTop(y: number): void;
}) {
  const chunks = useMemo(() => chunkLines(text, 80), [text]);
  const colors = TOKEN_COLOR(theme);
  const digits = String(text.split('\n').length).length;
  const renderChunk = useCallback(
    ({ item }: { item: { start: number; lines: string[] } }) => (
      <View style={{ flexDirection: 'row' }}>
        <Text style={[styles.lineNo, { color: theme.muted, width: digits * 8 + 10 }]}>{item.lines.map((_, i) => item.start + i + 1).join('\n')}</Text>
        <Text selectable style={[styles.code, { color: theme.text }, !wrap && { flexShrink: 0 }]}>
          {item.lines.map((line, i) => (
            <Text key={i}>
              {highlightLine(line, language).map((t, j) => <Text key={j} style={colors[t.kind] ? { color: colors[t.kind], fontWeight: t.kind === 'heading' ? '700' : undefined } : undefined}>{t.text}</Text>)}
              {i < item.lines.length - 1 ? '\n' : ''}
            </Text>
          ))}
        </Text>
      </View>
    ),
    [theme, wrap, language, digits, colors],
  );
  const list = (
    <FlatList
      data={chunks}
      keyExtractor={(c) => String(c.start)}
      renderItem={renderChunk}
      initialNumToRender={2}
      windowSize={5}
      contentOffset={{ x: 0, y: initialTop }}
      scrollEventThrottle={100}
      onScroll={(e) => onScrollTop(e.nativeEvent.contentOffset.y)}
      contentContainerStyle={{ paddingTop: topInset + 10, paddingBottom: 60, paddingHorizontal: wrap ? padH : 0 }}
      testID="artifact-source"
    />
  );
  if (wrap) return list;
  return (
    <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: padH }} style={{ flex: 1 }}>
      <View style={{ minWidth: 300 }}>{list}</View>
    </ScrollView>
  );
}

function Notice({ theme, icon, title, text, action, onAction, actionIcon, secondary, onSecondary }: {
  theme: Theme; icon: any; title: string; text?: string; action?: string; onAction?: () => void; actionIcon?: any; secondary?: string; onSecondary?: () => void;
}) {
  return (
    <View style={styles.notice} testID="artifact-notice">
      <Icon as={icon} size={30} color={theme.muted} />
      <Text style={[styles.noticeTitle, { color: theme.textStrong }]}>{title}</Text>
      {text ? <Text style={[styles.noticeText, { color: theme.subtle }]}>{text}</Text> : null}
      {action ? (
        <Press onPress={onAction} style={[styles.noticeBtn, { backgroundColor: theme.button }]} accessibilityRole="button" testID="artifact-notice-action">
          <Icon as={actionIcon || RefreshCw} size={15} color={theme.buttonText} />
          <Text style={[styles.noticeBtnText, { color: theme.buttonText }]}>{action}</Text>
        </Press>
      ) : null}
      {secondary ? (
        <Press onPress={onSecondary} style={[styles.noticeBtn, { backgroundColor: theme.hover }]} accessibilityRole="button">
          <Icon as={Download} size={15} color={theme.text} />
          <Text style={[styles.noticeBtnText, { color: theme.text }]}>{secondary}</Text>
        </Press>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  modeBar: { position: 'absolute', left: 0, right: 0, height: 52, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, zIndex: 5 },
  modeLabel: { fontSize: 13.5, fontWeight: '600' },
  note: { flex: 1, fontSize: 12, textAlign: 'right' },
  tool: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  lineNo: { fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 20, textAlign: 'right', paddingRight: 10 },
  code: { flex: 1, fontFamily: fonts.mono, fontSize: 12.8, lineHeight: 20 },
  notice: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
  noticeTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  noticeText: { fontSize: 13.5, lineHeight: 20, textAlign: 'center' },
  noticeBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 42, borderRadius: 21, paddingHorizontal: 20, marginTop: 4 },
  noticeBtnText: { fontSize: 14.5, fontWeight: '600' },
});
