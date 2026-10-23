import { Api } from '../api.js';

export const instanceStatuses = Object.freeze({draft: '待部署', deploying: '部署中', needs_verification: '待检查', ready: '正常', unreachable: '无法连接', failed: '部署失败', archived: '已归档'});
export const eventTypes = Object.freeze({login_success: '登录成功', login_failure: '登录失败', health: '运行异常', recovery: '运行恢复'});
export const operationStatuses = Object.freeze({pending: '等待开始', running: '进行中', completed: '已完成', failed: '失败', needs_verification: '待检查', interrupted: '已中断'});
export function statusLabel(value) { return instanceStatuses[value] || value || '未知'; }
// Do not present a contradictory backend snapshot as healthy/usable. This is a
// display guard, not a replacement for the controller's authoritative verifier.
export function displayStatus(item) {
  if (item?.status === 'ready' && ['degraded', 'unhealthy', 'unreachable'].includes(item.healthStatus)) return item.healthStatus === 'unreachable' ? 'unreachable' : 'needs_verification';
  return item?.status;
}
export function statusTone(value) {
  return {ready: 'ok', deploying: 'warn', needs_verification: 'warn', draft: 'off', archived: 'off'}[value] || 'bad';
}
export function timeLabel(value) { return value ? new Date(Number(value)).toLocaleString('zh-CN', {hour12: false}) : '尚无记录'; }
export function relativeTime(value, now = Date.now()) {
  if (!value) return '';
  const seconds = Math.max(0, Math.round((now - Number(value)) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return timeLabel(value);
}
export function ok(data) { if (!data || data.ok === false) throw new Error('request_failed'); return data; }

const ERRORS = {
  gateway_not_enabled: '请先启用访问网关。',
  gateway_port_in_use: '这个端口已被占用，请换一个。',
  gateway_move_with_instances: '已有实例在使用访问网关，不能更换它的运行位置或端口。',
  gateway_install_failed: '网关安装失败，请检查服务器后重试。',
  gateway_start_failed: '网关已安装但服务启动失败，请查看服务器上 openbear-gateway 服务的日志。',
  gateway_needs_systemd: '这台服务器没有 systemd（例如主控运行在 Docker 容器中），无法安装网关服务。请选择一台使用 systemd 的服务器。',
  gateway_needs_useradd: '这台服务器缺少 useradd，无法创建网关的系统用户。',
  gateway_install_needs_root: '安装网关需要 root 权限：请使用 root 登录，或为该用户配置免密 sudo。',
  gateway_binary_missing: '缺少网关程序，请先构建网关或使用发行版安装包。',
  gateway_architecture_unsupported: '这台服务器的系统架构不受支持。',
  gateway_unreachable: '网关已安装，但主控连不上它，请检查端口与防火墙。',
  server_connection_failed: '连接失败：请检查地址、端口、用户和认证信息。',
  server_connection_timeout: '连接超时：请检查地址和端口是否可达。',
  server_in_use: '这台服务器正在被网关或实例使用，不能删除。',
  server_not_found: '服务器不存在，请刷新。',
  local_server_fixed: '本机不能修改或删除。',
  server_name_required: '请填写服务器名称。',
  invalid_server_host: '服务器地址格式不正确。',
  invalid_server_user: '用户名格式不正确。',
  ssh_password_required: '请填写 SSH 密码。',
  ssh_key_reference_required: '请选择密钥库中的私钥。',
  ssh_key_missing: '所选私钥在密钥库中已不存在，请重新选择。',
  ssh_key_passphrase_incorrect: '私钥密码不正确，请选择正确的密码字段。',
  ssh_key_passphrase_missing: '找不到私钥密码所在的字段。',
  ssh_key_unsupported: '无法使用这把私钥。',
  ssh_private_key_invalid: '上传的文件不是可用的 SSH 私钥（或设有密码）。',
  ssh_key_vault_save_failed: '私钥保存到密钥库失败。',
  server_credential_required: '请提供登录凭证。',
  instance_port_in_use: '这个端口已被占用，请换一个或留空自动选择。',
  instance_primary_model_not_copied: '所选默认模型不在复制的渠道中。',
  no_free_port: '没有可用端口，请在“高级”中手动指定。',
  instance_address_required: '无法确定实例地址，请在“高级”中填写。',
  instance_server_immutable: '实例创建后不能更换运行位置。',
  initial_gateway_password_required: '请填写登录密码。',
  operation_running: '正在部署或维护中，请等待完成。',
  maintenance_scope_required: '请写明要做什么。',
  invalid_gateway_client_ip: '代理地址格式不正确，每行一个 IP 或网段。',
};
export function errorText(code) { return safeError({response: {data: {error: code}}}); }
// Do not echo raw backend text: it may include submitted passwords or keys.
export function safeError(error) {
  const code = error?.response?.data?.error;
  if (code && ERRORS[code]) return ERRORS[code];
  const status = error?.response?.status;
  if (status === 401) return '登录已过期，请重新登录。';
  if (status === 403) return '此操作未获授权。';
  if (status === 404) return '资源不存在，请刷新。';
  if (status === 409) return '当前状态有冲突，请刷新后再试。';
  if ([400, 422].includes(status)) return '填写的内容未通过校验，请检查后重试。';
  if (status === 429) return '操作过于频繁，请稍后再试。';
  if (status === 502 || status === 503) return '无法连接目标，请稍后重试。';
  return '操作未确认成功，请刷新查看实际状态。';
}
export function publicLink(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
export function parseObject(value) {
  const result = JSON.parse(value || '{}');
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('object_required');
  return result;
}
// Readable, unambiguous and long enough; the user can still type their own.
export function generatePassword(random = globalThis.crypto) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(12);
  random.getRandomValues(bytes);
  const text = Array.from(bytes, n => chars[n % chars.length]).join('');
  return `${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8)}`;
}
// Advice only: any non-empty password is accepted.
export function passwordHint(value) {
  if (!value) return '';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter(re => re.test(value)).length;
  if (value.length < 8) return '密码较短，容易被猜到；建议至少 8 位。';
  if (value.length < 12 && kinds < 3) return '建议 12 位以上，或混合大小写字母、数字和符号。';
  return '';
}
export function serverLabel(server) {
  if (!server) return '';
  if (server.local) return '本机（主控所在服务器）';
  return `${server.name} · ${server.host}${server.status === 'unreachable' ? '（无法连接）' : ''}`;
}
export function defaultAccessUrl(ip, port) { return ip && port ? `http://${ip}:${port}` : ''; }
// The address the user typed differs from server-IP:port, so they must map it.
export function needsMapping(url, ip, port) {
  try {
    const parsed = new URL(url);
    const effective = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return Boolean(ip && port) && (parsed.hostname !== ip || effective !== String(port));
  } catch { return false; }
}
// The target is captured at construction. No caller can switch host, send headers,
// or use a child path to call a parent endpoint. Backend applies the authoritative
// method/path allowlist as well; this guard is not a replacement for authorization.
export function childClient(instanceId, api = Api) {
  const id = String(instanceId);
  return async (method, path, body) => {
    if (!/^\/api\/(?:memory\/entries(?:[/?]|$)|channels(?:[/?]|$)|skills(?:[/?]|$)|mcp(?:[/?]|$)|settings(?:[/?]|$)|managed\/v1\/(?:config|status|jobs|files)(?:[/?]|$))/.test(path) || /(?:\.\.|\\|#|%2e|%5c)/i.test(path)) throw new Error('invalid_child_path');
    const response = ok(await api.instanceRequest(id, {method, path, ...(body === undefined ? {} : {body})}));
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300 || response.data?.ok === false) {
      const error = new Error('child_request_failed');
      error.response = {status: response.status};
      if (response.data?.error === 'mcp_exposure_confirmation_required') error.mcpChallenge = response.data;
      throw error;
    }
    return response.data;
  };
}
export function initialModelConfig(form) {
  const ids = form.modelIds.split(/[,\n]+/).map(x => x.trim()).filter(Boolean);
  if (!form.providerName.trim() || !form.baseUrl.trim() || !ids.length) throw new Error('model_required');
  return {models: {primary: `${form.providerName.trim()}/${ids[0]}`, providers: {[form.providerName.trim()]: {
    baseUrl: form.baseUrl.trim(), apiKey: form.apiKey, protocol: form.protocol, models: ids.map(id => ({id, name: id})),
  }}}};
}
