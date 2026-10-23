/**
 * 把 HttpClient 包成 axios 风格（get/post/put/patch/delete 的签名与返回 {data}），
 * 让从 web/src/api.js 生成的方法表（api.generated.ts）可以原样使用。
 *
 * 只支持生成代码实际用到的 axios 选项：params、signal、timeout、data（DELETE 请求体）、headers。
 * 路径与 Web 相同（相对 /api），错误统一抛 HttpError（status、body 与 axios 的 response 对应）。
 */
import { createApi, type OpenBearApi } from './api.generated';
import { HttpClient, HttpError } from './http';

type Options = { params?: Record<string, any>; signal?: AbortSignal; timeout?: number; data?: unknown; headers?: Record<string, string> };

export type AxiosLike = {
  get(url: string, options?: Options): Promise<{ data: any }>;
  delete(url: string, options?: Options): Promise<{ data: any }>;
  post(url: string, body?: unknown, options?: Options): Promise<{ data: any }>;
  put(url: string, body?: unknown, options?: Options): Promise<{ data: any }>;
  patch(url: string, body?: unknown, options?: Options): Promise<{ data: any }>;
};

function adapt(http: HttpClient): AxiosLike {
  const send = async (method: string, url: string, body: unknown, options: Options = {}) => {
    const data = await http.request(method, `/api${url}`, body, {
      params: options.params,
      signal: options.signal,
      // axios 的 timeout: 0 表示不限时；HttpClient 用一个足够长的上限代替
      timeoutMs: options.timeout === 0 ? 24 * 3600 * 1000 : options.timeout,
      headers: options.headers,
    });
    return { data };
  };
  return {
    get: (url, options) => send('GET', url, undefined, options),
    delete: (url, options) => send('DELETE', url, options?.data, options),
    post: (url, body, options) => send('POST', url, body ?? {}, options),
    put: (url, body, options) => send('PUT', url, body ?? {}, options),
    patch: (url, body, options) => send('PATCH', url, body ?? {}, options),
  };
}

export function createOpenBearApi(http: HttpClient): OpenBearApi {
  return createApi(adapt(http));
}

/** 与 web/src/api.js apiError 相同的取错误文案规则。 */
export function apiError(error: unknown): string {
  if (error instanceof HttpError) return String(error.body?.error || error.body?.message || error.message);
  return String((error as any)?.message || error);
}

export type { OpenBearApi };
