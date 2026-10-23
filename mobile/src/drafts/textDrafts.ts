/**
 * 文字草稿（B3-02）：按服务器隔离、按会话保存（新会话草稿用 local:new|<目录> 作键）。
 * 存 expo-sqlite kv（App 重启后恢复）。只用异步 API（getItemAsync / setItemAsync）：
 * 模块加载或渲染期间同步读本地存储会在 Android 冷启动时触发原生崩溃（b1 已复现），所以这里在挂载后的
 * effect 里 await loadDraft()，写入先改内存缓存，再做 300ms 合并的异步落盘。
 * 保存的是发送编码（引用胶囊为 `[名称](openbear://ref/...)`，与 Web 的 openbear.console.drafts.v1 内容一致）。
 */
import Storage from 'expo-sqlite/kv-store';

const storageKey = (serverId: string) => `openbear.composer.drafts.v1.${serverId || 'default'}`;
const caches = new Map<string, Promise<Record<string, string>>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function cacheFor(serverId: string): Promise<Record<string, string>> {
  let cache = caches.get(serverId);
  if (!cache) {
    cache = Storage.getItemAsync(storageKey(serverId))
      .then((raw) => {
        const parsed = JSON.parse(raw || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
      })
      .catch(() => ({}) as Record<string, string>);
    caches.set(serverId, cache);
  }
  return cache;
}

function scheduleFlush(serverId: string) {
  const timer = timers.get(serverId);
  if (timer) clearTimeout(timer);
  timers.set(
    serverId,
    setTimeout(() => {
      timers.delete(serverId);
      void cacheFor(serverId)
        .then((cache) => Storage.setItemAsync(storageKey(serverId), JSON.stringify(cache)))
        .catch(() => undefined); // 存储不可用时草稿只在内存里
    }, 300),
  );
}

export function newDraftKey(folderId?: string, temporary?: boolean) {
  return `local:new|${folderId || (temporary ? 'temporary' : '')}`;
}

export async function loadDraft(serverId: string, key: string): Promise<string> {
  return String((await cacheFor(serverId))[key] || '');
}

/** 写草稿（立即进内存缓存、异步落盘）；调用顺序即生效顺序。 */
export function setDraft(serverId: string, key: string, text: string): Promise<void> {
  const value = String(text || '');
  return cacheFor(serverId).then((cache) => {
    if (value.trim()) {
      if (cache[key] === value) return;
      cache[key] = value;
    } else {
      if (!(key in cache)) return;
      delete cache[key];
    }
    scheduleFlush(serverId);
  });
}

export async function moveDraft(serverId: string, from: string, to: string) {
  const text = await loadDraft(serverId, from);
  await setDraft(serverId, from, '');
  if (text) await setDraft(serverId, to, text);
}
