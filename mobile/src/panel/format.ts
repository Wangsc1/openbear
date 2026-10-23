/** 面板通用的格式化（纯函数，有单测）。 */

/** 字节数：与 Web TaskMemoryDrawer.formatBytes 一致（< 1 KiB 显示 B，< 10 KiB 保留一位小数）。 */
export function formatBytes(value: number): string {
  const size = Math.max(0, Number(value || 0));
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

/** 秒级时间戳 -> “10-13 09:12”；同一年省略年份，否则“2025-10-13 09:12”。 */
export function formatTimestamp(seconds: number, now: Date = new Date()): string {
  const value = Number(seconds || 0);
  if (!value) return '—';
  const d = new Date(value * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

export type ArtifactKind = 'image' | 'text' | 'code' | 'archive' | 'other';

export function artifactKind(fileName: string, mimeType: string): ArtifactKind {
  const mime = String(mimeType || '').toLowerCase();
  const ext = String(fileName || '').toLowerCase().split('.').pop() || '';
  if (mime.startsWith('image/')) return 'image';
  if (['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'xz', 'bz2'].includes(ext) || /zip|tar|compressed|x-7z/.test(mime)) return 'archive';
  if (['js', 'ts', 'tsx', 'py', 'json', 'html', 'css', 'sh', 'go', 'rs', 'java', 'c', 'cpp', 'yaml', 'yml', 'xml', 'sql'].includes(ext)) return 'code';
  if (mime.startsWith('text/') || ['md', 'txt', 'csv', 'log', 'pdf', 'doc', 'docx'].includes(ext) || mime === 'application/pdf') return 'text';
  return 'other';
}

/** UTF-8 字节数（任务记忆正文上限按 UTF-8 计，与 Web TextEncoder 一致）。 */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
