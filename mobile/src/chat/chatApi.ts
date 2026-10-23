/**
 * b2 共用：当前服务器的生成接口表（与 Web Api.* 同名同参）、错误文案、复制/提示小工具。
 */
import * as Clipboard from 'expo-clipboard';
import { useMemo } from 'react';

import { useSession } from '../data/session';
import { apiError, createOpenBearApi, type OpenBearApi } from '../transport/apiAdapter';
import { HttpError } from '../transport/http';
import { showToast } from '../ui/Toast';

export function useChatApi(): OpenBearApi | null {
  const session = useSession();
  return useMemo(() => (session.http ? createOpenBearApi(session.http) : null), [session.http]);
}

export { apiError };

/** HttpError -> axios 风格 {response:{status,data}}（web userInteractionState 的错误判断按 axios 形状读取）。 */
export function axiosLikeError(error: unknown): any {
  if (error instanceof HttpError) return { response: { status: error.status, data: error.body }, message: error.message };
  return error;
}

export async function copyText(text: string, label = '内容'): Promise<boolean> {
  const value = String(text || '');
  if (!value) return false;
  try {
    await Clipboard.setStringAsync(value);
    showToast(`${label}已复制`);
    return true;
  } catch {
    showToast('复制失败，请手动选择文本');
    return false;
  }
}

/** 绝对地址（服务器相对路径 -> 当前服务器完整 URL）。 */
export function useAbsoluteUrl() {
  const session = useSession();
  return (path: string) => {
    const value = String(path || '');
    if (!value || /^https?:\/\//i.test(value) || value.startsWith('data:')) return value;
    return session.http ? session.http.url(value) : value;
  };
}

/** 图片/下载请求用的认证头（App 令牌，不依赖系统 Cookie）。 */
export function useAuthHeaders(): Record<string, string> {
  const session = useSession();
  return useMemo(() => (session.http ? session.http.headers() : {}), [session.http]);
}

/** 时间：HH:MM:SS（与 Web formatHoverTime 一致）与完整时间。 */
export function clockTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fullTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 秒或毫秒时间戳 -> 毫秒。 */
export function toMs(value: unknown): number {
  const n = Number(value || 0);
  if (!n) return 0;
  return n < 10_000_000_000 ? n * 1000 : n;
}
