<script setup>
import { computed, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { Api } from '../api.js';
import { errorText, ok, relativeTime, safeError } from './instanceHelpers.js';

const props = defineProps({gateway: {type: Object, required: true}, servers: {type: Array, required: true}, instanceCount: {type: Number, default: 0}});
const emit = defineEmits(['changed', 'edit', 'cancel']);
const busy = ref(false), error = ref(''), proxies = ref((props.gateway.clientIp?.trustedProxies || []).join('\n'));
defineExpose({busy});
const server = computed(() => props.servers.find(s => s.id === props.gateway.serverId));
const observed = computed(() => props.gateway.observed);
const manual = computed(() => props.gateway.clientIp?.source === 'header');
const detection = computed(() => {
  if (props.gateway.clientIp?.source === 'socket') return ['只使用连接地址', '不读取任何代理请求头。'];
  if (manual.value) return ['手动指定的代理', `来自 ${props.gateway.clientIp.trustedProxies.join('、')} 的请求会读取代理请求头中的真实 IP。`];
  if (observed.value) return [`自动识别 · 经${observed.value.peer.startsWith('127.') || observed.value.peer === '::1' ? '本机' : '内网或 Cloudflare'}反向代理访问`,
    `最近一次请求来自 ${observed.value.peer}，已从 ${observed.value.header} 读取真实 IP（${relativeTime(observed.value.atMs)}），登录限制按真实 IP 计算。`];
  return ['自动识别 · 直接访问', '没有发现反向代理，登录限制按连接地址计算。经本机、内网或 Cloudflare 代理访问时会自动读取真实 IP。'];
});

async function run(fn) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { emit('changed', ok(await fn())); }
  catch (e) { error.value = safeError(e); }
  finally { busy.value = false; }
}
function saveProxies() {
  return run(() => Api.setInstanceGatewayProxies(proxies.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean)));
}
async function disable() {
  try {
    await ElMessageBox.confirm('停用后所有使用者都无法登录，直到重新启用。账号、实例和数据都会保留。', '停用访问网关', {confirmButtonText: '停用', cancelButtonText: '取消', type: 'warning'});
  } catch { return; }
  await run(() => Api.disableInstanceGateway());
}
</script>
<template>
  <div class="instance-form">
    <dl class="instance-facts ob-facts">
      <div><dt>状态</dt><dd><span class="ob-dot" :data-tone="gateway.connected ? 'ok' : 'bad'">{{ gateway.connected ? '运行中' : '无法连接' }}</span><span class="instance-muted">{{ instanceCount }} 个实例</span><span v-if="!gateway.connected && gateway.error" class="instance-muted">{{ errorText(gateway.error) }}</span></dd></div>
      <div><dt>访问地址</dt><dd class="mono">{{ gateway.publicUrl }} <button type="button" class="instance-link" :disabled="busy" @click="emit('edit')">修改</button></dd></div>
      <div><dt>运行位置</dt><dd>{{ server?.local ? '本机' : server?.name || '未知服务器' }} · 端口 {{ gateway.port }}</dd></div>
      <div><dt>客户端 IP</dt><dd class="ob-stack"><span>{{ detection[0] }}</span><span class="instance-muted">{{ detection[1] }}</span></dd></div>
    </dl>
    <details class="ob-adv" :open="manual">
      <summary>识别不对？手动指定代理</summary>
      <div class="ob-field"><span>代理地址</span>
        <div class="ob-ctl">
          <textarea v-model="proxies" rows="2" class="mono" placeholder="每行一个 IP 或网段，例如 10.0.0.1" aria-label="代理地址" spellcheck="false" />
          <small>只在代理位于其他公网服务器、无法自动识别时填写；留空恢复自动识别。来自这些地址的请求会依次读取 CF-Connecting-IP、True-Client-IP、X-Real-IP、X-Forwarded-For、Forwarded。</small>
          <div><el-button :loading="busy" @click="saveProxies">保存</el-button></div>
        </div>
      </div>
    </details>
    <p v-if="error" role="alert" class="instance-error">{{ error }}</p>
    <div class="instance-form-footer">
      <el-button class="ob-danger" :disabled="busy" @click="disable">停用网关…</el-button>
      <span class="ob-grow"></span>
      <el-button type="primary" :disabled="busy" @click="emit('cancel')">关闭</el-button>
    </div>
  </div>
</template>
