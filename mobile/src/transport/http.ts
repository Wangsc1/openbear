/**
 * REST 传输层。每个 HttpClient 绑定一个服务器连接（ServerConnection），同一 App 可同时持有多个。
 *
 * 认证：App 不依赖系统 Cookie 存储，登录后拿到 App 令牌，每个请求通过 X-OpenBear-App-Token 携带
 * （网关还需要 X-OpenBear-Context）。credentials: 'omit' 保证不同服务器、不同账号互不串号。
 * 401 与网关的 409 session_context_changed 统一交给 onUnauthorized，由会话层把该服务器标记为需要重新登录。
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export type ServerConnection = {
  /** 例如 https://bear.example.com；不内置任何默认地址 */
  baseUrl: string;
  /** App 会话令牌（登录后获得），未登录为空 */
  token?: string;
  tokenHeader?: string;
  /** 网关会话的上下文令牌 */
  contextToken?: string;
  contextHeader?: string;
};

/** 登录设备列表里用来识别 App（Web 的 sessionPresentation 识别 OpenBear-App/x.y）。 */
export const APP_USER_AGENT = `OpenBear-App/${String(Constants.expoConfig?.version || '0')} (${Platform.OS === 'ios' ? (Platform.isPad ? 'iPad' : 'iPhone') : 'Android'})`;

export class HttpError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(`HTTP ${status}${body?.error ? ` ${body.error}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

export function normalizeBaseUrl(input: string): string {
  let value = input.trim();
  if (!value) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, '');
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

export function toWsUrl(baseUrl: string, path: string): string {
  return joinUrl(baseUrl, path).replace(/^http(s?):\/\//, (_m, s) => `ws${s}://`);
}

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export function authHeaders(connection: ServerConnection): Record<string, string> {
  const headers: Record<string, string> = {};
  if (connection.token) headers[connection.tokenHeader || 'X-OpenBear-App-Token'] = connection.token;
  if (connection.contextToken) headers[connection.contextHeader || 'X-OpenBear-Context'] = connection.contextToken;
  return headers;
}

type RequestOptions = { params?: Record<string, any>; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal };

export class HttpClient {
  readonly connection: ServerConnection;
  timeoutMs: number;
  onUnauthorized?: () => void;

  constructor(connection: ServerConnection, timeoutMs = 30000) {
    this.connection = connection;
    this.timeoutMs = timeoutMs;
  }

  get baseUrl() {
    return this.connection.baseUrl;
  }

  url(path: string, params: Record<string, any> = {}) {
    return joinUrl(this.connection.baseUrl, path) + query(params);
  }

  headers(extra: Record<string, string> = {}) {
    return { ...authHeaders(this.connection), ...extra };
  }

  async request<T = any>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort);
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
      const response = await fetch(this.url(path, options.params), {
        method,
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          'User-Agent': APP_USER_AGENT,
          ...(body === undefined || isForm ? {} : { 'Content-Type': 'application/json' }),
          ...this.headers(options.headers),
        },
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { error: 'bad_json', raw: text.slice(0, 200) };
      }
      if (this.connection.token && (response.status === 401 || (response.status === 409 && data?.error === 'session_context_changed'))) {
        this.onUnauthorized?.();
      }
      if (response.status === 429 && data && typeof data === 'object' && !data.retryAfter) {
        // 主控 Secret Key 登录在 body 里给 retryAfter，子实例与网关只在 Retry-After 头里给
        const header = Number(response.headers.get('Retry-After'));
        if (header > 0) data.retryAfter = header;
      }
      if (!response.ok) throw new HttpError(response.status, data);
      return data as T;
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new HttpError(0, { error: options.signal?.aborted ? 'aborted' : 'timeout' });
      if (error instanceof HttpError) throw error;
      throw new HttpError(0, { error: 'network', message: String(error?.message || error) });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  get<T = any>(path: string, params?: Record<string, any>, options: Omit<RequestOptions, 'params'> = {}) {
    return this.request<T>('GET', path, undefined, { ...options, params });
  }
  post<T = any>(path: string, body: unknown = {}, options?: RequestOptions) {
    return this.request<T>('POST', path, body, options);
  }
  put<T = any>(path: string, body: unknown = {}, options?: RequestOptions) {
    return this.request<T>('PUT', path, body, options);
  }
  patch<T = any>(path: string, body: unknown = {}, options?: RequestOptions) {
    return this.request<T>('PATCH', path, body, options);
  }
  delete<T = any>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>('DELETE', path, body, options);
  }
}

/** 对话相关 REST（路径与 web/src/api.js 一致）。 */
export function conversationApi(http: HttpClient) {
  const enc = encodeURIComponent;
  return {
    list: () => http.get('/api/conversations'),
    state: (uuid: string, params: { timelineLimit: number; beforeDisplaySeq?: number }) =>
      http.get(`/api/conversations/${enc(uuid)}/state`, params),
    operations: (uuid: string, params: { timelineLimit: number; beforeDisplaySeq: number }) =>
      http.get(`/api/conversations/${enc(uuid)}/operations`, params),
    frames: (uuid: string, afterFrameSeq: number, limit = 1000) =>
      http.get(`/api/conversations/${enc(uuid)}/frames`, { afterFrameSeq, limit }),
    operationDetail: (uuid: string, opId: string) =>
      http.get(`/api/conversations/${enc(uuid)}/operations/${enc(opId)}/detail`),
  };
}
