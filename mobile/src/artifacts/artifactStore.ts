/**
 * 产物元数据与文本缓存（对应 Web artifactFiles.js 的 artifactRecord / loadArtifactMetadata / loadArtifactText）。
 * - 元数据 60 秒内复用；文本按 sha256 缓存，总量上限 8MB；文本预览上限 2MB（与 Web 相同）；
 * - 下载/分享：expo-file-system 把原文件下载到缓存目录（带 App 令牌头），再交给系统分享面板（含“存储到文件”）。
 */
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { HttpClient } from '../transport/http';
import { HttpError } from '../transport/http';
import { ARTIFACT_SUMMARY_LIMIT, ARTIFACT_TEXT_PREVIEW_LIMIT, artifactFormat, extractArtifactSummary } from '../data/webLogic';
import type { ArtifactIdentity } from './artifactLinks';

export type ArtifactMeta = {
  artifactUuid: string;
  conversationUuid: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  workspacePath?: string;
  contentUrl?: string;
  previewUrl?: string;
  downloadUrl?: string;
  [key: string]: any;
};

export type ArtifactRecord = {
  identity: ArtifactIdentity;
  metadata: ArtifactMeta | null;
  summary: { title: string; excerpt: string } | null;
  error: string;
  checkedAt: number;
  metaRequest: Promise<ArtifactMeta> | null;
  textRequest: Promise<string> | null;
  listeners: Set<() => void>;
};

const records = new Map<string, ArtifactRecord>();
const texts = new Map<string, { text: string; bytes: number }>();
let cachedBytes = 0;

export function artifactRecord(identity: ArtifactIdentity): ArtifactRecord {
  let record = records.get(identity.key);
  if (!record) {
    record = { identity, metadata: null, summary: null, error: '', checkedAt: 0, metaRequest: null, textRequest: null, listeners: new Set() };
    records.set(identity.key, record);
    while (records.size > 256) records.delete(records.keys().next().value as string);
  }
  return record;
}

function notify(record: ArtifactRecord) {
  for (const l of record.listeners) l();
}

export function artifactErrorMessage(error: any): string {
  if (error instanceof HttpError) {
    if (error.status === 401) return '登录已失效，请重新登录后重试。';
    if (error.status === 403 || error.status === 404) return '附件不存在、已删除，或当前无权访问。';
    if (error.status === 0) return error.body?.error === 'timeout' ? '读取超时，请重试或下载原文件。' : '网络不可用，请稍后重试。';
    return `读取附件失败（HTTP ${error.status}），请重试。`;
  }
  return String(error?.message || '附件暂时无法读取，请重试。');
}

export async function loadArtifactMetadata(http: HttpClient, record: ArtifactRecord, force = false): Promise<ArtifactMeta> {
  if (record.metaRequest) return record.metaRequest;
  if (!force && record.metadata && Date.now() - record.checkedAt < 60000) return record.metadata;
  record.error = '';
  notify(record);
  const promise = http
    .get(record.identity.metadataUrl)
    .then((result: any) => {
      const meta = result?.artifact;
      if (!meta || meta.artifactUuid !== record.identity.artifactUuid || !Number.isSafeInteger(meta.sizeBytes) || meta.sizeBytes < 0) {
        throw new Error('附件信息不完整，暂时无法预览。');
      }
      if (record.metadata?.sha256 !== meta.sha256) record.summary = null;
      record.metadata = meta;
      record.checkedAt = Date.now();
      return meta as ArtifactMeta;
    })
    .catch((error) => {
      record.metadata = null;
      record.checkedAt = 0;
      record.error = artifactErrorMessage(error);
      throw error;
    })
    .finally(() => {
      record.metaRequest = null;
      notify(record);
    });
  record.metaRequest = promise;
  notify(record);
  return promise;
}

/** 与 Web decodeArtifactText 相同的“像不像文本”判断（RN 用 UTF-8 解码）。 */
export function looksBinary(text: string): boolean {
  return /\x00/.test(text) || (text.match(/[\x01-\x08\x0b\x0e-\x1f]/g)?.length || 0) > Math.max(2, text.length / 100);
}

export async function loadArtifactText(http: HttpClient, record: ArtifactRecord): Promise<string> {
  const meta = await loadArtifactMetadata(http, record);
  const format = artifactFormat(meta);
  if (!['markdown', 'html', 'text', 'code'].includes(format.kind)) throw new Error('此格式暂不支持文本预览，请下载原文件。');
  if (meta.sizeBytes > ARTIFACT_TEXT_PREVIEW_LIMIT) throw new Error('文件超过 2 MB 的文本预览上限，请下载查看。');
  const key = `${record.identity.key}:${meta.sha256 || ''}`;
  const cached = texts.get(key);
  if (cached) return cached.text;
  if (record.textRequest) return record.textRequest;
  const promise = (async () => {
    const response = await fetch(http.url(record.identity.contentUrl), { headers: http.headers(), credentials: 'omit' });
    if (!response.ok) throw new HttpError(response.status, null);
    const text = await response.text();
    if (looksBinary(text)) throw new Error('文件内容不像可读文本，请下载原文件查看。');
    const bytes = text.length;
    texts.set(key, { text, bytes });
    cachedBytes += bytes;
    while (cachedBytes > 8 * 1024 * 1024 || texts.size > 64) {
      const oldest = texts.keys().next().value as string;
      cachedBytes -= texts.get(oldest)!.bytes;
      texts.delete(oldest);
    }
    if (format.kind !== 'html') record.summary = extractArtifactSummary(text, format.kind);
    return text;
  })().finally(() => {
    record.textRequest = null;
    notify(record);
  });
  record.textRequest = promise;
  return promise;
}

/** 卡片：元数据 + 小文本的摘要（读取失败不影响下载）。 */
export async function loadArtifactCard(http: HttpClient, record: ArtifactRecord): Promise<void> {
  const meta = await loadArtifactMetadata(http, record);
  if (['markdown', 'text', 'code'].includes(artifactFormat(meta).kind) && meta.sizeBytes <= ARTIFACT_SUMMARY_LIMIT && !record.summary) {
    await loadArtifactText(http, record).catch(() => undefined);
  }
}

function safeName(name: string): string {
  return String(name || 'artifact.bin').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'artifact.bin';
}

/** 下载原文件到缓存并打开系统分享面板（含“存储到文件”/“保存到…”）。 */
export async function shareArtifactFile(http: HttpClient, identity: ArtifactIdentity, meta: ArtifactMeta | null, onProgress?: (ratio: number) => void): Promise<void> {
  const name = safeName(meta?.fileName || identity.artifactUuid);
  const dir = new FileSystem.Directory(FileSystem.Paths.cache, 'artifacts', identity.artifactUuid);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const target = new FileSystem.File(dir, name);
  if (!target.exists || (meta && target.size !== meta.sizeBytes)) {
    await FileSystem.File.downloadFileAsync(http.url(identity.downloadUrl), target, {
      headers: http.headers(),
      idempotent: true,
      onProgress: onProgress ? ({ bytesWritten, totalBytes }: any) => totalBytes > 0 && onProgress(bytesWritten / totalBytes) : undefined,
    } as any);
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error('设备不支持系统分享');
  await Sharing.shareAsync(target.uri, { mimeType: meta?.mimeType || 'application/octet-stream', dialogTitle: name });
}

/** 文本写入缓存文件并分享（回复分享 .md 用）。 */
export async function shareTextFile(fileName: string, text: string, mimeType = 'text/markdown'): Promise<void> {
  const dir = new FileSystem.Directory(FileSystem.Paths.cache, 'share');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const file = new FileSystem.File(dir, safeName(fileName));
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: fileName });
}

/** 阅读位置与模式（每个产物一份，进程内记忆；与 Web readingState 相同的字段）。 */
const reading = new Map<string, { mode: string; previewTop: number; sourceTop: number; wrap: boolean }>();
export function readingState(key: string, initialMode = 'preview') {
  let state = reading.get(key);
  if (!state) {
    state = { mode: initialMode, previewTop: 0, sourceTop: 0, wrap: true };
    reading.set(key, state);
    while (reading.size > 128) reading.delete(reading.keys().next().value as string);
  }
  return state;
}
