/**
 * 会话产物列表（B4-44，App 新增；Web 没有界面）：GET /api/conversations/{cid}/artifacts。
 * 每行：类型图标（图片显示缩略图）、文件名、类型 · 大小 · 时间；点击打开 b2 提供的预览（openArtifactPreview），
 * 本分支里预览组件不存在时 toast 说明。
 */
import { Image as ExpoImage } from 'expo-image';
import { FileArchive, FileCode, FileText, Image as ImageIcon, Package } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../data/session';
import { authHeaders, joinUrl } from '../transport/http';
import { Icon, Press, Sheet, SheetScroll, showToast, useTheme } from '../ui';
import { openArtifactPreview } from './artifactPreviewBridge';
import { type ArtifactItem, useArtifacts } from './hooks';
import { artifactKind, formatBytes, formatTimestamp } from './format';

const KIND_ICON: Record<string, LucideIcon> = { image: ImageIcon, text: FileText, code: FileCode, archive: FileArchive, other: Package };

export function openArtifact(item: ArtifactItem) {
  if (openArtifactPreview) openArtifactPreview({ conversationUuid: item.conversationUuid, artifactUuid: item.artifactUuid, label: item.fileName || '' });
  else showToast('预览由对话包提供（合并后生效）');
}

export function ArtifactsSheet({ uuid, visible, onClose }: { uuid: string; visible: boolean; onClose(): void }) {
  const theme = useTheme();
  const session = useSession();
  const { items, error, loading, refresh } = useArtifacts(uuid, visible);
  const headers = session.http ? authHeaders(session.http.connection) : {};
  return (
    <Sheet visible={visible} onClose={onClose} title="产物" subtitle={items ? `${items.length} 个文件` : undefined} testID="artifacts-sheet">
      <SheetScroll contentContainerStyle={styles.body}>
        {items === null && loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.muted} />
          </View>
        ) : error && !items?.length ? (
          <View style={styles.center}>
            <Text style={[styles.empty, { color: theme.danger }]}>读取产物失败：{error}</Text>
            <Press onPress={() => void refresh()} style={[styles.retry, { borderColor: theme.border }]} testID="artifacts-retry">
              <Text style={{ color: theme.text, fontSize: 14.5 }}>重试</Text>
            </Press>
          </View>
        ) : !items?.length ? (
          <View style={styles.center}>
            <Icon as={Package} size={26} strokeWidth={1.5} color={theme.disabled} />
            <Text style={[styles.empty, { color: theme.muted }]}>这个会话还没有产物</Text>
            <Text style={[styles.hint, { color: theme.muted }]}>模型生成的图片、文档等文件会出现在这里。</Text>
          </View>
        ) : (
          items.map((item) => {
            const kind = artifactKind(item.fileName, item.mimeType);
            const thumb = kind === 'image' && item.inlinePreview && session.http ? { uri: joinUrl(session.http.baseUrl, `${item.contentUrl}?preview=1`), headers } : null;
            return (
              <Press
                key={item.artifactUuid}
                onPress={() => openArtifact(item)}
                style={styles.row}
                pressedStyle={{ backgroundColor: theme.hover }}
                accessibilityRole="button"
                accessibilityLabel={`打开 ${item.fileName}`}
                testID={`artifact-${item.artifactUuid}`}
              >
                <View style={[styles.thumb, { backgroundColor: theme.surfaceSoft }]}>
                  {thumb ? <ExpoImage source={thumb} style={styles.thumbImg} contentFit="cover" /> : <Icon as={KIND_ICON[kind] || Package} size={20} strokeWidth={1.7} color={theme.subtle} />}
                </View>
                <View style={styles.main}>
                  <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.name, { color: theme.text }]}>
                    {item.fileName}
                  </Text>
                  <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                    {[item.mimeType.split(';')[0], formatBytes(item.sizeBytes), formatTimestamp(item.createdAt)].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </Press>
            );
          })
        )}
      </SheetScroll>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: 8 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 36, paddingHorizontal: 24, gap: 8 },
  empty: { fontSize: 15, textAlign: 'center' },
  hint: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  retry: { height: 40, paddingHorizontal: 20, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 10, minHeight: 60 },
  thumb: { width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  thumbImg: { width: 42, height: 42 },
  main: { flex: 1, minWidth: 0 },
  name: { fontSize: 15 },
  meta: { fontSize: 12.5, marginTop: 2 },
});
