/**
 * 会话附件上传：与 web/src/uploads.js 相同的分片协议。
 *   POST   /api/conversations/{cid}/uploads                      {name,type,size} -> {uploadId}
 *   PUT    /api/conversations/{cid}/uploads/{id}?offset=N         原始字节（512 KiB 一片） -> {offset}
 *   POST   /api/conversations/{cid}/uploads/{id}/complete         -> {uploadId}
 *   DELETE /api/conversations/{cid}/uploads/{id}                  只清理未完成的上传
 * 本地文件用 expo-file-system 的文件句柄逐片读取，大文件也不会整体读进内存。
 * 不确定的响应不重试（同 Web）：失败时尽力删除未完成的上传，然后抛错。
 */
import { File } from 'expo-file-system';

import { HttpClient, HttpError } from './http';

export const UPLOAD_CHUNK_BYTES = 512 * 1024;

export type LocalFile = { uri: string; name: string; type?: string; size?: number };
export type UploadProgress = { loaded: number; total: number; fileIndex: number; fileCount: number; fileLoaded: number; fileSize: number; phase: 'uploading' | 'finalizing' | 'complete' };

// 已完成的上传按（文件 uri, 会话）缓存，重发同一草稿时不重复上传（同 Web 的 completedUploads）。
const completed = new Map<string, string>();

function sizeOf(file: LocalFile): number {
  if (typeof file.size === 'number' && file.size >= 0) return file.size;
  const local = new File(file.uri);
  return Number(local.size) || 0;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new HttpError(0, { error: 'aborted' });
}

export async function uploadConversationFiles(
  http: HttpClient,
  conversationUuid: string,
  files: LocalFile[],
  { signal, onProgress }: { signal?: AbortSignal; onProgress?: (p: UploadProgress) => void } = {},
): Promise<{ uploadId: string }[]> {
  const base = `/api/conversations/${encodeURIComponent(conversationUuid)}/uploads`;
  const sizes = files.map(sizeOf);
  const total = sizes.reduce((sum, n) => sum + n, 0);
  const rows: { uploadId: string }[] = [];
  let loaded = 0;
  for (const [index, file] of files.entries()) {
    throwIfAborted(signal);
    const size = sizes[index];
    const progress = (bytes: number, phase: UploadProgress['phase'] = 'uploading') =>
      onProgress?.({ loaded: loaded + bytes, total, fileIndex: index, fileCount: files.length, fileLoaded: bytes, fileSize: size, phase });
    const cacheKey = `${conversationUuid}\n${file.uri}`;
    const cached = completed.get(cacheKey);
    if (cached) {
      rows.push({ uploadId: cached });
      progress(size, 'complete');
      loaded += size;
      continue;
    }
    let uploadId = '';
    const handle = new File(file.uri).open();
    try {
      const created = await http.post(base, { name: file.name || 'upload.bin', type: file.type || 'application/octet-stream', size }, { signal });
      uploadId = String(created?.uploadId || '');
      if (!uploadId) throw new HttpError(0, { error: 'attachment_upload_invalid_response' });
      const url = `${base}/${encodeURIComponent(uploadId)}`;
      for (let offset = 0; offset < size; ) {
        throwIfAborted(signal);
        const end = Math.min(size, offset + UPLOAD_CHUNK_BYTES);
        handle.offset = offset;
        const bytes = handle.readBytes(end - offset);
        const result = await fetch(http.url(url, { offset }), {
          method: 'PUT',
          credentials: 'omit',
          headers: http.headers({ 'Content-Type': 'application/octet-stream', Accept: 'application/json' }),
          body: bytes,
          signal,
        });
        const data = await result.json().catch(() => null);
        if (!result.ok) throw new HttpError(result.status, data);
        if (data?.offset !== end) throw new HttpError(0, { error: 'attachment_upload_offset_mismatch' });
        offset = end;
        progress(offset);
      }
      throwIfAborted(signal);
      progress(size, 'finalizing');
      const done = await http.post(`${url}/complete`, {}, { signal, timeoutMs: 24 * 3600 * 1000 });
      if (done?.uploadId !== uploadId) throw new HttpError(0, { error: 'attachment_upload_invalid_response' });
      completed.set(cacheKey, uploadId);
      rows.push({ uploadId });
      progress(size, 'complete');
      loaded += size;
    } catch (error) {
      if (uploadId) {
        try {
          await http.delete(`${base}/${encodeURIComponent(uploadId)}`, undefined, { timeoutMs: 10000 });
        } catch {
          /* best effort */
        }
      }
      throw error;
    } finally {
      handle.close();
    }
  }
  throwIfAborted(signal);
  return rows;
}
