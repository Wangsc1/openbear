/**
 * 服务器列表（多服务器）：App 里添加的每一个 OpenBear 地址。
 *
 * - 列表元数据（地址、名称、类型、版本、最近使用）存 expo-sqlite 的 kv 存储；
 * - 登录令牌只存 SecureStore（iOS Keychain / Android Keystore），键按服务器 id 隔离；
 * - 与“多实例”（主控的实例管理）无关：一个主控服务器下的子实例由实例管理页面单独处理。
 */
import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';

import type { AppSession, LoginMethod, ServerKind } from '../transport/auth';

export type SavedServer = {
  id: string;
  baseUrl: string;
  name: string;
  kind: ServerKind;
  login: LoginMethod;
  version: string;
  instancesFeature: boolean;
  /** 网关或子实例登录后的账号名，仅展示 */
  username?: string;
  addedAt: number;
  lastUsedAt: number;
};

const LIST_KEY = 'openbear.servers.v1';
const ACTIVE_KEY = 'openbear.servers.active.v1';
const tokenKey = (id: string) => `openbear.session.${id}`;

export function serverId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultServerName(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export async function loadServers(): Promise<{ servers: SavedServer[]; activeId: string }> {
  const raw = await Storage.getItem(LIST_KEY);
  let servers: SavedServer[] = [];
  try {
    servers = raw ? JSON.parse(raw) : [];
  } catch {
    servers = [];
  }
  const activeId = (await Storage.getItem(ACTIVE_KEY)) || '';
  return { servers: Array.isArray(servers) ? servers : [], activeId };
}

export async function saveServers(servers: SavedServer[], activeId: string): Promise<void> {
  await Storage.setItem(LIST_KEY, JSON.stringify(servers));
  await Storage.setItem(ACTIVE_KEY, activeId);
}

export async function loadSession(id: string): Promise<AppSession | null> {
  const raw = await SecureStore.getItemAsync(tokenKey(id));
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as AppSession;
    if (session.expiresAt && session.expiresAt * 1000 < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export async function saveSession(id: string, session: AppSession): Promise<void> {
  await SecureStore.setItemAsync(tokenKey(id), JSON.stringify(session));
}

export async function clearSession(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(tokenKey(id));
}
