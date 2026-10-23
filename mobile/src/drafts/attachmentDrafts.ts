/**
 * 附件草稿持久化（B3-07）：复用 Web 的 createAttachmentDraftStorage（attachmentDraftStorage.js：
 * 单个 ≤32MB、合计 ≤96MB、保留 30 天、操作串行、失败不影响内存草稿），App 只换掉存储驱动：
 *   - 文件拷到 App 文档目录 composer-attachments/（App 重启后还在）；
 *   - 记录（键、更新时间、文件元数据、跳过的超限文件）存 expo-sqlite kv 的一个索引里；
 *   - 键 = `<服务器 id>|<会话 uuid 或 local:new|目录>`，按服务器隔离。
 * 超限的文件不拷贝，只在内存里（界面提示“未保存到草稿”）。
 * 索引只用 expo-sqlite 的异步 API（冷启动时同步读会触发 Android 原生崩溃）；存储对象懒创建，只在挂载后的 effect 里用到。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Directory, File, Paths } from 'expo-file-system';
import Storage from 'expo-sqlite/kv-store';

// @ts-ignore - JS module without types
import * as web from '@openbear/web/views/consoleView/attachmentDraftStorage.js';

export type DraftFile = { uri: string; name: string; type: string; size: number };
export type DraftAttachment = { id: string; file: DraftFile };

export const MAX_FILE_BYTES: number = web.ATTACHMENT_DRAFT_MAX_FILE_BYTES;
export const MAX_TOTAL_BYTES: number = web.ATTACHMENT_DRAFT_MAX_TOTAL_BYTES;
export const planAttachmentDraftRecord: (key: string, attachments: DraftAttachment[], opts?: any) => { items: any[]; skipped: { id: string }[] } =
  web.planAttachmentDraftRecord;

const INDEX_KEY = 'openbear.composer.attachmentDrafts.v1';

function folder(): Directory {
  const dir = new Directory(Paths.document, 'composer-attachments');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

async function readIndex(): Promise<Record<string, any>> {
  const raw = await Storage.getItemAsync(INDEX_KEY);
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeIndex(index: Record<string, any>) {
  await Storage.setItemAsync(INDEX_KEY, JSON.stringify(index));
}

function safeName(name: string) {
  return String(name || 'attachment').replace(/[\\/:*?"<>|\s]+/g, '_').slice(-120) || 'attachment';
}

/** 不在草稿目录里的文件拷进去（同一个 id 只拷一次）。 */
function persistFile(id: string, file: DraftFile): DraftFile {
  const dir = folder();
  if (file.uri.startsWith(dir.uri)) return file;
  const target = new File(dir, `${safeName(id)}-${safeName(file.name)}`);
  if (!target.exists) new File(file.uri).copy(target);
  return { ...file, uri: target.uri };
}

function referencedUris(index: Record<string, any>): Set<string> {
  const set = new Set<string>();
  for (const record of Object.values(index)) for (const item of record?.items || []) if (item?.file?.uri) set.add(item.file.uri);
  return set;
}

function cleanup(old: any, index: Record<string, any>) {
  if (!old?.items?.length) return;
  const keep = referencedUris(index);
  const dir = folder().uri;
  for (const item of old.items) {
    const uri = item?.file?.uri;
    if (!uri || keep.has(uri) || !uri.startsWith(dir)) continue;
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      /* best effort */
    }
  }
}

const driver = {
  async get(key: string) {
    const record = (await readIndex())[key];
    if (!record) return undefined;
    return { ...record, items: (record.items || []).filter((item: any) => item?.file?.uri && new File(item.file.uri).exists) };
  },
  async list() {
    return Object.values(await readIndex());
  },
  async put(record: any) {
    const index = await readIndex();
    const old = index[record.key];
    const items = (record.items || []).map((item: any) => ({ ...item, file: persistFile(String(item.id), item.file) }));
    index[record.key] = { ...record, items };
    await writeIndex(index);
    cleanup(old, index);
  },
  async delete(key: string) {
    const index = await readIndex();
    const old = index[key];
    if (!old) return;
    delete index[key];
    await writeIndex(index);
    cleanup(old, index);
  },
};

type Storage = {
  load(key: string): Promise<{ items: DraftAttachment[]; skipped: { id: string }[] }>;
  save(key: string, attachments: DraftAttachment[]): Promise<void>;
  remove(key: string): Promise<void>;
  removeItems(key: string, ids: Iterable<string>): Promise<boolean>;
  move(from: string, to: string): Promise<void>;
  prune(): Promise<void>;
};

let storage: Storage | null = null;
export function attachmentDrafts(): Storage {
  if (!storage) storage = (web.createAttachmentDraftStorage as any)({ driver, onError: (error: unknown) => console.warn('[attachment-drafts]', error) }) as Storage;
  return storage;
}

export function attachmentDraftKey(serverId: string, conversationKey: string) {
  return `${serverId || 'default'}|${conversationKey}`;
}

/** 这批附件里哪些因为超限不会写入草稿（只在内存里） */
export function memoryOnlyIds(attachments: DraftAttachment[]): Set<string> {
  return new Set(planAttachmentDraftRecord('probe', attachments).skipped.map((item) => String(item.id)));
}
