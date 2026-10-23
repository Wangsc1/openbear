/**
 * 服务器识别与登录。
 *
 * 1. probeServer：GET /api/app/capabilities（主控、子实例）或 /api/auth/app-capabilities（访问网关），
 *    得到服务器类型与登录方式；都不支持时退回 /api/auth/mode（旧版本服务器）。
 * 2. 登录方式：
 *    - telegram_approval（主控）：POST /api/auth/login/start {secret, client:'app'} -> {requestUuid, loginNonce}
 *      轮询 status 直到 approved，再 POST consume（带 nonce 请求头）换取 App 令牌；
 *    - password（子实例本地账号）/ gateway_password（访问网关）：POST /api/auth/password/login {username, password, client:'app'}。
 * 3. 返回的令牌只交给调用方保存（SecureStore），这里不持久化。
 */
import { HttpClient, HttpError, normalizeBaseUrl, type ServerConnection } from './http';

export type ServerKind = 'controller' | 'managed' | 'gateway';
export type LoginMethod = 'telegram_approval' | 'password' | 'gateway_password' | 'none';

export type ServerProbe = {
  baseUrl: string;
  kind: ServerKind;
  login: LoginMethod;
  version: string;
  /** 旧版本服务器没有 App 令牌接口，无法登录 */
  appAuth: boolean;
  instancesFeature: boolean;
  instanceId?: string;
};

export type LoginStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed' | 'missing' | string;

export type AppSession = Required<Pick<ServerConnection, 'token' | 'tokenHeader'>> &
  Pick<ServerConnection, 'contextToken' | 'contextHeader'> & { expiresAt: number; instanceId?: string };

const POLL_MS = 1800;

export async function probeServer(input: string): Promise<ServerProbe> {
  const baseUrl = normalizeBaseUrl(input);
  if (!baseUrl) throw new HttpError(0, { error: 'invalid_url' });
  const http = new HttpClient({ baseUrl }, 12000);
  const attempt = async (path: string) => {
    try {
      return await http.get(path);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 401 || error.status === 403)) return null;
      throw error;
    }
  };
  const node = await attempt('/api/app/capabilities');
  if (node?.product === 'openbear') {
    return {
      baseUrl,
      kind: node.mode,
      login: node.login,
      version: String(node.version || ''),
      appAuth: Boolean(node.appAuth),
      instancesFeature: Boolean(node.features?.instances),
    };
  }
  const gateway = await attempt('/api/auth/app-capabilities');
  if (gateway?.product === 'openbear-gateway') {
    return { baseUrl, kind: 'gateway', login: 'gateway_password', version: '', appAuth: Boolean(gateway.appAuth), instancesFeature: false };
  }
  const legacy = await attempt('/api/auth/mode');
  if (legacy?.mode) {
    const kind: ServerKind = legacy.mode === 'gateway' ? 'gateway' : legacy.mode === 'managed' ? 'managed' : 'controller';
    return { baseUrl, kind, login: kind === 'controller' ? 'telegram_approval' : 'password', version: '', appAuth: false, instancesFeature: false };
  }
  throw new HttpError(0, { error: 'not_openbear' });
}

function sessionFrom(data: any): AppSession {
  const token = String(data?.appToken || '');
  if (!token) throw new HttpError(0, { error: 'app_token_missing' });
  const expiresAt = Number(data.expiresAt) || Math.floor(Date.now() / 1000) + Number(data.expiresIn || 0);
  return {
    token,
    tokenHeader: String(data.tokenHeader || 'X-OpenBear-App-Token'),
    contextToken: data.contextToken ? String(data.contextToken) : undefined,
    contextHeader: data.contextHeader ? String(data.contextHeader) : undefined,
    expiresAt,
    instanceId: data.instanceId ? String(data.instanceId) : undefined,
  };
}

export type ApprovalHandle = { requestUuid: string; expiresIn: number; cancel(): void; done: Promise<AppSession> };

/** 主控：Secret Key + Telegram 审批。onStatus 用于界面展示“等待 Telegram 确认…”。 */
export async function startApprovalLogin(baseUrl: string, secret: string, onStatus: (status: LoginStatus) => void): Promise<ApprovalHandle> {
  const http = new HttpClient({ baseUrl });
  const started = await http.post('/api/auth/login/start', { secret, client: 'app' });
  const requestUuid = String(started?.requestUuid || '');
  const nonce = String(started?.loginNonce || '');
  if (!requestUuid || !nonce) throw new HttpError(0, { error: 'login_start_failed' });
  let cancelled = false;
  const deadline = Date.now() + Number(started.expiresIn || 300) * 1000;
  const done = (async () => {
    onStatus('pending');
    while (!cancelled) {
      if (Date.now() > deadline) throw new HttpError(0, { error: 'login_expired' });
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (cancelled) break;
      const status = String((await http.get(`/api/auth/login/status/${encodeURIComponent(requestUuid)}`))?.status || '');
      onStatus(status);
      if (status === 'approved') {
        const consumed = await http.post(`/api/auth/login/consume/${encodeURIComponent(requestUuid)}`, { client: 'app' }, {
          headers: { 'X-OpenBear-App-Login-Nonce': nonce },
        });
        return sessionFrom(consumed);
      }
      if (status && status !== 'pending') throw new HttpError(0, { error: `login_${status}` });
    }
    throw new HttpError(0, { error: 'aborted' });
  })();
  return { requestUuid, expiresIn: Number(started.expiresIn || 300), cancel: () => (cancelled = true), done };
}

/** 子实例本地账号或访问网关账号。 */
export async function passwordLogin(baseUrl: string, username: string, password: string): Promise<AppSession> {
  const http = new HttpClient({ baseUrl });
  return sessionFrom(await http.post('/api/auth/password/login', { username, password, client: 'app' }));
}

export async function currentSession(http: HttpClient): Promise<{ ok: boolean; chatId?: number; mode?: string; instanceId?: string; username?: string; expiresAt?: number }> {
  try {
    return await http.get('/api/auth/session');
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return { ok: false };
    throw error;
  }
}

export async function logout(http: HttpClient): Promise<void> {
  try {
    await http.post('/api/auth/logout', {});
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 401)) throw error;
  }
}

export function loginErrorText(error: unknown): string {
  const code = String((error as any)?.body?.error || (error as any)?.message || '');
  const map: Record<string, string> = {
    invalid_url: '地址格式不对',
    not_openbear: '这个地址不是 OpenBear 服务',
    network: '连接不上服务器，检查地址和网络',
    timeout: '连接超时',
    bad_secret: 'Secret Key 不正确',
    rate_limited: '尝试次数太多，请稍后再试',
    try_later: '尝试次数太多，请稍后再试',
    invalid_credentials: '用户名或密码不正确',
    local_auth_disabled: '这个实例不能直接登录，请通过访问网关登录',
    login_expired: '审批已过期，请重新登录',
    login_rejected: '登录请求被拒绝',
    https_required: '服务器要求使用 HTTPS 地址',
    app_token_missing: '服务器版本太旧，不支持 App 登录',
    logout_required: '请先退出当前登录',
  };
  return map[code] || (code ? `登录失败（${code}）` : '登录失败');
}
