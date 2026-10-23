/**
 * 会话树的本地偏好（视图选择、平板展开状态、草稿归属）：
 * 用 expo-sqlite kv-store 的异步接口（与 data/servers.ts 相同）。不在模块加载时同步读库——
 * Android 上模块初始化阶段同步打开数据库会让 JS 线程崩溃。读取失败按默认值处理。
 */
import Storage from 'expo-sqlite/kv-store';

export async function readKey(key: string): Promise<string | null> {
  try {
    return await Storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeKey(key: string, value: string | null) {
  void (value === null ? Storage.removeItem(key) : Storage.setItem(key, value)).catch(() => undefined);
}
