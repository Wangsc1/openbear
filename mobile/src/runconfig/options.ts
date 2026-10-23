/**
 * 模型选项（GET /api/rath/options）：按服务器缓存一份，编辑器、输入区胶囊、新会话页共用。
 * 失败时给出错误与重试；切换服务器后自动换成新服务器的列表。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useSession } from '../data/session';
import { apiError, createOpenBearApi, type OpenBearApi } from '../transport/apiAdapter';
import type { ModelInfo } from './logic';

export type ModelOptions = { models: ModelInfo[]; primaryModel: string; currentModel: string };

type Entry = { data: ModelOptions | null; error: string; promise: Promise<ModelOptions> | null; listeners: Set<() => void> };
const cache = new Map<string, Entry>();

function entryFor(key: string): Entry {
  let entry = cache.get(key);
  if (!entry) cache.set(key, (entry = { data: null, error: '', promise: null, listeners: new Set() }));
  return entry;
}

export function loadModelOptions(api: OpenBearApi, key: string, force = false): Promise<ModelOptions> {
  const entry = entryFor(key);
  if (entry.data && !force) return Promise.resolve(entry.data);
  if (entry.promise) return entry.promise;
  entry.error = '';
  entry.promise = (async () => {
    try {
      const data: any = await api.rathOptions();
      entry.data = {
        models: Array.isArray(data?.models) ? data.models : [],
        primaryModel: String(data?.primaryModel || ''),
        currentModel: String(data?.currentModel || data?.primaryModel || ''),
      };
      return entry.data;
    } catch (error) {
      entry.error = apiError(error);
      throw error;
    } finally {
      entry.promise = null;
      for (const fn of [...entry.listeners]) fn();
    }
  })();
  for (const fn of [...entry.listeners]) fn();
  return entry.promise;
}

/** 绑定当前服务器的生成接口（与 Web api.js 同名方法）。 */
export function useOpenBearApi(): OpenBearApi | null {
  const { http } = useSession();
  return useMemo(() => (http ? createOpenBearApi(http) : null), [http]);
}

export function useModelOptions() {
  const api = useOpenBearApi();
  const { baseUrl, active } = useSession();
  const key = `${active?.id || ''}|${baseUrl}`;
  const [, setTick] = useState(0);
  useEffect(() => {
    const entry = entryFor(key);
    const fn = () => setTick((n) => n + 1);
    entry.listeners.add(fn);
    if (api && !entry.data && !entry.promise) void loadModelOptions(api, key).catch(() => undefined);
    return () => {
      entry.listeners.delete(fn);
    };
  }, [api, key]);
  const entry = entryFor(key);
  const reload = useCallback(() => {
    if (api) void loadModelOptions(api, key, true).catch(() => undefined);
  }, [api, key]);
  return {
    models: entry.data?.models || [],
    primaryModel: entry.data?.primaryModel || '',
    loaded: Boolean(entry.data),
    loading: Boolean(entry.promise),
    error: entry.data ? '' : entry.error,
    reload,
  };
}
