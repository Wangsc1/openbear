/**
 * 产物卡片（B2-79～B2-81），对应 Web artifacts/ArtifactCard.vue：
 * 图片缩略图或类型图标、标题（Markdown 首个标题 > 链接文字 > 文件名）、文件名、摘要、类型 · 大小 · 动作；
 * 右侧：复制工作区路径（仅共享路径存在时）、下载/保存（系统分享面板“存储到文件”）。
 * 进入视口才读取元数据：卡片挂载在虚拟化列表行里，挂载即接近可见（列表 drawDistance 内），因此挂载后读取。
 */
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { ArrowUpRight, Braces, Copy, Download, File, FileArchive, FileAudio, FileCode, FileSpreadsheet, FileText, FileVideo, Globe, Image as ImageIcon, Maximize2, Presentation, Type } from 'lucide-react-native';
import React, { useEffect, useReducer, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../data/session';
import { artifactPresentation, artifactSharedPath, formatFileSize } from '../data/webLogic';
import { showToast } from '../ui/Toast';
import { Icon, Press, tap } from '../ui/primitives';
import type { Theme } from '../ui/theme';
import { copyText } from '../chat/chatApi';
import type { ArtifactIdentity } from './artifactLinks';
import { artifactErrorMessage, artifactRecord, loadArtifactCard, shareArtifactFile } from './artifactStore';

const ICONS: Record<string, any> = {
  html: Globe, image: ImageIcon, markdown: FileText, pdf: FileText, document: FileText, spreadsheet: FileSpreadsheet, presentation: Presentation,
  archive: FileArchive, audio: FileAudio, video: FileVideo, font: Type, code: FileCode, data: Braces, text: FileText, file: File,
};

export function accentFor(theme: Theme, category: string): { fg: string; bg: string } {
  switch (category) {
    case 'html':
    case 'document':
      return { fg: theme.blue, bg: theme.blueSoft };
    case 'pdf':
      return { fg: theme.danger, bg: theme.dangerSoft };
    case 'spreadsheet':
    case 'data':
      return { fg: theme.success, bg: theme.successSoft };
    case 'archive':
    case 'presentation':
      return { fg: theme.warning, bg: theme.warningSoft };
    case 'audio':
    case 'video':
      return { fg: theme.violet, bg: theme.violetSoft };
    default:
      return { fg: theme.subtle, bg: theme.surfaceSoft };
  }
}

export function useArtifactRecord(identity: ArtifactIdentity, autoload = true) {
  const session = useSession();
  const record = artifactRecord(identity);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    record.listeners.add(bump);
    return () => {
      record.listeners.delete(bump);
    };
  }, [record]);
  useEffect(() => {
    if (autoload && session.http) void loadArtifactCard(session.http, record).catch(() => undefined);
  }, [autoload, session.http, record]);
  return { record, http: session.http };
}

export function ArtifactCard({ theme, identity, label, testID }: { theme: Theme; identity: ArtifactIdentity; label: string; testID?: string }) {
  const { record, http } = useArtifactRecord(identity);
  const meta = record.metadata;
  const p = artifactPresentation(meta);
  const accent = accentFor(theme, p.category);
  const sharedPath = artifactSharedPath(meta);
  const title = record.summary?.title || label || meta?.fileName || '附件';
  const excerpt = record.error ? '暂时无法读取附件信息，点击查看详情。' : meta?.sizeBytes === 0 ? '空文件' : record.summary?.excerpt || '';
  const [imageFailed, setImageFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = Boolean(record.metaRequest);
  const open = () => {
    tap();
    router.push({ pathname: '/artifact', params: { uuid: identity.conversationUuid, aid: identity.artifactUuid, label: title } });
  };
  const save = async () => {
    if (!http || saving) return;
    setSaving(true);
    try {
      await shareArtifactFile(http, identity, meta);
    } catch (error) {
      showToast(artifactErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.panel }]} testID={testID || 'artifact-card'}>
      <Press onPress={open} style={styles.open} accessibilityRole="button" accessibilityLabel={`${meta && !p.previewable ? '查看附件详情' : '预览附件'}：${title}`} testID="artifact-open">
        {p.category === 'image' && http ? (
          <View style={[styles.thumb, { backgroundColor: theme.surfaceSoft }]}>
            {!imageFailed ? (
              <Image source={{ uri: http.url(identity.contentUrl), headers: http.headers() }} style={StyleSheet.absoluteFill} contentFit="cover" onError={() => setImageFailed(true)} transition={120} />
            ) : (
              <Icon as={ImageIcon} size={22} color={theme.muted} />
            )}
            {!imageFailed ? (
              <View style={styles.thumbHint}><Icon as={Maximize2} size={11} color="#fff" /></View>
            ) : null}
          </View>
        ) : (
          <View style={[styles.icon, { backgroundColor: accent.bg }]}>
            <Icon as={ICONS[p.category] || File} size={21} color={accent.fg} strokeWidth={1.7} />
            <Text numberOfLines={1} style={[styles.badge, { color: accent.fg }]}>{p.badge}</Text>
          </View>
        )}
        <View style={styles.copy}>
          <Text numberOfLines={2} style={[styles.title, { color: theme.textStrong }]}>{title}</Text>
          {meta?.fileName && meta.fileName !== title ? <Text numberOfLines={1} style={[styles.file, { color: theme.muted }]}>{meta.fileName}</Text> : null}
          {excerpt ? <Text numberOfLines={2} style={[styles.excerpt, { color: record.error ? theme.danger : theme.subtle }]}>{imageFailed ? '缩略图未能加载 · 点击重试查看' : excerpt}</Text> : null}
          <View style={styles.meta}>
            <Text style={[styles.metaText, { color: theme.muted }]}>{p.label} · {meta ? formatFileSize(meta.sizeBytes) : busy ? '读取信息中…' : '等待读取'}</Text>
            {meta ? (
              <View style={styles.intent}>
                <Text style={[styles.metaText, { color: theme.subtle, fontWeight: '600' }]}>{p.action}</Text>
                {p.previewable ? <Icon as={ArrowUpRight} size={12} color={theme.subtle} /> : null}
              </View>
            ) : null}
          </View>
        </View>
      </Press>
      <View style={[styles.side, { borderLeftColor: theme.line }]}>
        {sharedPath ? (
          <Press onPress={() => void copyText(sharedPath, '工作区路径')} style={styles.sideBtn} accessibilityRole="button" accessibilityLabel={`复制工作区路径：${sharedPath}`} testID="artifact-copy-path">
            <Icon as={Copy} size={17} color={theme.subtle} />
          </Press>
        ) : null}
        <Press onPress={() => void save()} disabled={saving} style={styles.sideBtn} accessibilityRole="button" accessibilityLabel={`下载原文件：${meta?.fileName || title}`} testID="artifact-download">
          {saving ? <ActivityIndicator size="small" color={theme.subtle} /> : <Icon as={Download} size={18} color={theme.subtle} />}
        </Press>
      </View>
    </View>
  );
}

/** 内联图片下方的小入口：复制工作区路径（B2-80，只有共享路径存在时出现）+ 保存。 */
export function ArtifactImagePath({ theme, identity }: { theme: Theme; identity: ArtifactIdentity }) {
  const { record, http } = useArtifactRecord(identity);
  const path = artifactSharedPath(record.metadata);
  const [saving, setSaving] = useState(false);
  if (!record.metadata) return null;
  return (
    <View style={styles.imagePath} testID="artifact-image-path">
      {path ? (
        <Press onPress={() => void copyText(path, '工作区路径')} style={[styles.pathChip, { backgroundColor: theme.hover }]} accessibilityRole="button" accessibilityLabel={`复制工作区路径：${path}`}>
          <Icon as={Copy} size={13} color={theme.subtle} />
          <Text numberOfLines={1} style={[styles.pathText, { color: theme.subtle }]}>{path}</Text>
        </Press>
      ) : null}
      <Press
        onPress={async () => {
          if (!http) return;
          setSaving(true);
          try {
            await shareArtifactFile(http, identity, record.metadata);
          } catch (error) {
            showToast(artifactErrorMessage(error));
          } finally {
            setSaving(false);
          }
        }}
        style={[styles.pathChip, { backgroundColor: theme.hover }]}
        accessibilityRole="button"
        accessibilityLabel="保存图片"
      >
        {saving ? <ActivityIndicator size="small" color={theme.subtle} /> : <Icon as={Download} size={13} color={theme.subtle} />}
        <Text style={[styles.pathText, { color: theme.subtle }]}>保存</Text>
      </Press>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden', marginVertical: 6 },
  open: { flex: 1, flexDirection: 'row', gap: 12, padding: 12, minWidth: 0 },
  icon: { width: 46, minHeight: 56, borderRadius: 9, alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 2 },
  badge: { fontSize: 9, fontWeight: '700', fontFamily: 'monospace', maxWidth: 44 },
  thumb: { width: 64, height: 64, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  thumbHint: { position: 'absolute', right: 4, bottom: 4, width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 14.5, fontWeight: '600', lineHeight: 20 },
  file: { fontSize: 12, fontFamily: 'monospace' },
  excerpt: { fontSize: 12.5, lineHeight: 18 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 },
  metaText: { fontSize: 12 },
  intent: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  side: { borderLeftWidth: StyleSheet.hairlineWidth, justifyContent: 'center' },
  sideBtn: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  imagePath: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: -4, marginBottom: 8 },
  pathChip: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 32, borderRadius: 16, paddingHorizontal: 10, maxWidth: '100%' },
  pathText: { fontSize: 12, flexShrink: 1 },
});
