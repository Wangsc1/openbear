<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft, CircleCheckFilled, CircleCloseFilled, Clock, CopyDocument, Monitor, MoreFilled, Refresh, Remove, TopRight } from '@element-plus/icons-vue';
import { Api } from '../api.js';
import AdminPageHeader from '../components/AdminPageHeader.vue';
import InstanceForm from '../instances/InstanceForm.vue';
import GatewaySetup from '../instances/GatewaySetup.vue';
import GatewaySettings from '../instances/GatewaySettings.vue';
import ServerForm from '../instances/ServerForm.vue';
import ChildBusinessPanel from '../instances/ChildBusinessPanel.vue';
import { displayStatus, errorText, eventTypes, generatePassword, ok, operationStatuses, publicLink, relativeTime, safeError, statusLabel, statusTone, timeLabel } from '../instances/instanceHelpers.js';
import '../instances/instances.css';

const emit = defineEmits(['open-conversation', 'open-folder', 'mobile-header-ready']);
const page = ref('instances');
const items = ref([]), servers = ref([]), gateway = ref(null), selected = ref(null);
const loading = ref(false), error = ref(''), detailError = ref(''), busy = ref(false);
const tab = ref('overview'), operations = ref([]), events = ref([]), now = ref(Date.now());
const dialog = ref(''), dialogRef = ref(null), created = ref(null), editingServer = ref(null);
const maintain = reactive({instructions: '', model: ''}), modelOptions = ref([]);
const notifications = reactive({loginSuccess: false, loginFailure: true, health: true});
const listFilter = ref('all');
let alive = true, poll, clock, detailGeneration = 0;
const healthText = {unreachable: '无法连接', degraded: '运行异常', unhealthy: '运行异常', healthy: '恢复正常'};
const eventTone = {login_success: 'ok', recovery: 'ok', login_failure: 'bad', health: 'bad'};
const operationTone = {completed: 'ok', running: 'warn', pending: 'warn', needs_verification: 'warn'};
const issueTexts = {
  child_unreachable: '实例没有响应',
  identity_readiness_or_persistence_unverified: '实例身份、就绪状态或数据持久化未通过校验',
  gateway_route_unverified: '经访问网关到达实例的路由未通过校验',
  gateway_sync_required: '账号尚未同步到访问网关',
};
const detailTabs = [['overview', '概况'], ['events', '登录与通知'], ['sessions', '部署记录'], ['business', '实例配置']];
const notifyKeys = [['loginFailure', '登录失败', '有人输错密码时提醒'], ['loginSuccess', '登录成功', '每次登录都提醒'], ['health', '运行异常与恢复', '自动检查发现异常或恢复时提醒']];
const attentionStates = ['unreachable', 'failed', 'needs_verification'];
function closeCreatedDialog(done) { closeCreated(); done(); }

const gatewayOn = computed(() => Boolean(gateway.value?.enabled));
const active = computed(() => items.value.filter(i => i.status !== 'archived'));
const counts = computed(() => {
  const result = {total: active.value.length, ready: 0, attention: 0, deploying: 0};
  for (const item of active.value) {
    const status = displayStatus(item);
    if (status === 'ready') result.ready++;
    else if (attentionStates.includes(status)) result.attention++;
    else if (status === 'deploying') result.deploying++;
  }
  return result;
});
const filters = computed(() => [['all', '全部', counts.value.total], ['attention', '需处理', counts.value.attention], ['deploying', '部署中', counts.value.deploying]].filter(([key, , n]) => key === 'all' || n));
const visible = computed(() => {
  if (listFilter.value === 'attention') return active.value.filter(i => attentionStates.includes(displayStatus(i)));
  if (listFilter.value === 'deploying') return active.value.filter(i => displayStatus(i) === 'deploying');
  return active.value;
});
const serverOf = id => servers.value.find(x => x.id === id);
const serverName = id => { const s = serverOf(id); return s ? (s.local ? '本机' : s.name) : ''; };
const selectedServer = computed(() => serverOf(selected.value?.serverId));
const selectedStatus = computed(() => selected.value ? displayStatus(selected.value) : '');
const syncProblem = computed(() => selected.value?.gateway?.status === 'pending_sync' ? selected.value.gateway.error : '');
const version = computed(() => selected.value?.verification?.gateway?.status?.version || selected.value?.verification?.status?.version || '');
const checkedAt = computed(() => selected.value?.monitor?.checkedAtMs || selected.value?.lastHealthAtMs || 0);
const runningOperation = computed(() => operations.value.find(o => ['pending', 'running'].includes(o.status)));
const checks = computed(() => {
  const v = selected.value?.verification;
  if (!v) return [];
  return [['实例身份', v.identity], ['服务就绪', v.ready], ['数据持久化', v.persistence], ['网关路由', v.publicRoute], ['健康状态', v.health ? v.health.status === 'healthy' : undefined]];
});
const issueText = code => issueTexts[code] || code;
const notice = computed(() => {
  const item = selected.value, status = selectedStatus.value;
  if (!item) return null;
  if (status === 'unreachable') return {tone: 'bad', title: '无法连接', text: [item.lastSeenAtMs ? `${relativeTime(item.lastSeenAtMs, now.value)}失去连接` : '尚未连接上', item.lastError && issueText(item.lastError)].filter(Boolean).join('：')};
  if (status === 'failed') return {tone: 'bad', title: '部署失败', text: item.lastError ? issueText(item.lastError) : '请打开部署会话查看原因，修正后重新部署。'};
  if (status === 'needs_verification') return {tone: 'warn', title: '检查发现问题', text: item.lastError ? issueText(item.lastError) : '部分检查项未通过，点「立即检查」重新确认。'};
  if (status === 'draft') return {tone: 'off', title: '尚未部署', text: '在「更多」中选择「重新部署」开始部署。'};
  return null;
});
const serverAddress = server => !server ? '' : server.local ? '主控所在服务器' : `${server.username}@${server.host}:${server.port}`;
const rowMeta = item => {
  const status = displayStatus(item);
  if (status === 'deploying') return item.updatedAtMs ? `部署开始于 ${timeLabel(item.updatedAtMs).slice(-8, -3)}` : '部署中';
  if (status === 'unreachable') return item.lastSeenAtMs ? `${relativeTime(item.lastSeenAtMs, now.value)}失去连接` : '尚未连接上';
  if (item.lastLoginSuccessAtMs) return `最近登录 ${relativeTime(item.lastLoginSuccessAtMs, now.value)}`;
  return status === 'draft' ? '尚未部署' : '尚无登录记录';
};
const initial = name => Array.from(String(name || '?').trim())[0]?.toUpperCase() || '?';

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const [list, serverList, gw] = await Promise.all([Api.instances(), Api.instanceServers(), Api.instanceGateway()]);
    if (!alive) return;
    items.value = ok(list).items || [];
    servers.value = ok(serverList).items || [];
    gateway.value = ok(gw);
    error.value = '';
    if (selected.value) selected.value = items.value.find(i => i.id === selected.value.id) || null;
  } catch (e) { if (alive) error.value = safeError(e); }
  finally { if (alive) loading.value = false; }
}
async function loadServers() { try { servers.value = ok(await Api.instanceServers()).items || []; } catch (e) { error.value = safeError(e); } }
async function loadDetail(id) {
  const generation = ++detailGeneration;
  const current = () => alive && generation === detailGeneration && selected.value?.id === id;
  try {
    const [item, ops, evs] = await Promise.all([Api.instance(id), Api.instanceOperations(id), Api.instanceEvents(id)]);
    if (!current()) return;
    selected.value = ok(item).item;
    operations.value = ok(ops).items || [];
    events.value = ok(evs).items || [];
    Object.assign(notifications, selected.value.notifications || {});
    detailError.value = '';
  } catch (e) { if (current()) detailError.value = safeError(e); }
}
function select(item) { selected.value = item; tab.value = 'overview'; operations.value = []; events.value = []; detailError.value = ''; void loadDetail(item.id); }
function back() { selected.value = null; detailGeneration++; }

function open(name) { dialog.value = name; }
// A closing dialog reports after its leave animation; by then another may be open.
function dismiss(name) { if (dialog.value === name) dialog.value = ''; }
function closeDialog(done) { if (!dialogRef.value?.busy) done(); }
function gatewayDone(value) { gateway.value = value; dialog.value = gatewayOn.value ? '' : dialog.value; ElMessage.success('访问网关已启用'); void load(true); }
function gatewayChanged(value) { gateway.value = value; if (!value.enabled) dialog.value = ''; }
function instanceCreated(result) {
  created.value = {...result, url: gateway.value?.publicUrl};
  dialog.value = 'created';
  void load(true).then(() => { const item = items.value.find(i => i.id === result.item.id); if (item) select(item); });
  window.dispatchEvent(new CustomEvent('openbear:conversations-refresh'));
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); ElMessage.success(`已复制${label}`); }
  catch { ElMessage.warning('浏览器不允许复制，请手动选择文字'); }
}
const credentialText = computed(() => created.value ? `访问地址：${created.value.url}\n账号：${created.value.item.account.username}\n密码：${created.value.password}` : '');
function closeCreated() { if (created.value) created.value.password = ''; created.value = null; dialog.value = ''; }

async function run(fn, success) {
  if (busy.value) return;
  busy.value = true; detailError.value = '';
  try { const value = await fn(); if (success) ElMessage.success(success); return value; }
  catch (e) { detailError.value = safeError(e); }
  finally { busy.value = false; }
}
function check() {
  const id = selected.value.id;
  return run(async () => {
    const result = ok(await Api.verifyInstance(id));
    selected.value = result.item;
    ElMessage[result.verification.ok ? 'success' : 'warning'](result.verification.ok ? '检查完成：运行正常' : '检查完成：存在问题，请查看概况');
    await load(true);
  });
}
async function openMaintain() {
  maintain.instructions = ''; maintain.model = '';
  dialog.value = 'maintain';
  try {
    const options = ok(await Api.instanceModelOptions());
    modelOptions.value = options.providers.flatMap(p => p.models.map(m => `${p.name}/${m}`));
    maintain.model = options.primary || '';
  } catch { modelOptions.value = []; }
}
function startMaintain() {
  if (!maintain.instructions.trim()) return;
  const id = selected.value.id;
  return run(async () => {
    const result = ok(await Api.maintainInstance(id, {instructions: maintain.instructions.trim(), ...(maintain.model ? {model: maintain.model} : {})}));
    dialog.value = '';
    window.dispatchEvent(new CustomEvent('openbear:conversations-refresh'));
    await loadDetail(id);
    if (result.conversationUuid) emit('open-conversation', result.conversationUuid);
  });
}
async function redeploy() {
  try { await ElMessageBox.confirm(`将在「实例部署」目录新建部署会话，重新部署「${selected.value.name}」。数据目录会保留。`, '重新部署', {confirmButtonText: '开始部署', cancelButtonText: '取消'}); } catch { return; }
  const id = selected.value.id;
  await run(async () => {
    const result = ok(await Api.deployInstance(id, {}));
    window.dispatchEvent(new CustomEvent('openbear:conversations-refresh'));
    if (result.conversationUuid) emit('open-conversation', result.conversationUuid);
    await loadDetail(id);
  });
}
async function resetPassword() {
  const password = generatePassword();
  try { await ElMessageBox.confirm(`新密码：${password}\n\n确认后立即生效，使用者需要用新密码重新登录。`, `重置「${selected.value.name}」的密码`, {confirmButtonText: '确认并复制', cancelButtonText: '取消'}); } catch { return; }
  const id = selected.value.id;
  await run(async () => {
    const result = ok(await Api.updateInstance(id, {account: {password}}));
    selected.value = result.item;
    await copy(password, '新密码');
    if (result.item.gateway?.status !== 'synced') detailError.value = '新密码尚未同步到访问网关，系统会自动重试。';
  });
}
async function archive() {
  try { await ElMessageBox.confirm(`归档「${selected.value.name}」后，使用者将无法登录。容器和数据目录不会被删除。`, '归档实例', {confirmButtonText: '归档', cancelButtonText: '取消', type: 'warning'}); } catch { return; }
  const id = selected.value.id;
  await run(async () => { ok(await Api.archiveInstance(id)); await load(true); back(); }, '已归档');
}
async function retrySync() {
  const id = selected.value.id;
  await run(async () => { const result = ok(await Api.syncInstanceGateway(id)); selected.value = result.item; }, null);
}
async function saveNotification(key) {
  const id = selected.value.id;
  try { ok(await Api.updateInstance(id, {notifications: {...notifications}})); }
  catch (e) { notifications[key] = !notifications[key]; detailError.value = safeError(e); }
}
async function openFolder() {
  try { emit('open-folder', ok(await Api.instanceDeploymentFolder()).folderUuid); } catch (e) { detailError.value = safeError(e); }
}
function moreCommand(command) {
  if (command === 'password') void resetPassword();
  else if (command === 'redeploy') void redeploy();
  else if (command === 'archive') void archive();
}

async function checkServer(server) {
  await run(async () => { const result = ok(await Api.checkInstanceServer(server.id)); await loadServers(); ElMessage[result.item.status === 'unreachable' ? 'warning' : 'success'](result.item.status === 'unreachable' ? '连接失败' : `连接正常${result.item.docker ? ' · Docker ' + result.item.docker : ''}`); });
}
function editServer(server) { editingServer.value = server; dialog.value = 'server'; }
async function deleteServer(server) {
  try { await ElMessageBox.confirm(`删除服务器「${server.name}」的连接信息？不会影响服务器本身。`, '删除服务器', {confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning'}); } catch { return; }
  await run(async () => { ok(await Api.deleteInstanceServer(server.id)); await loadServers(); });
}
function serverSaved() { dialog.value = ''; editingServer.value = null; void loadServers(); }
const serverFacts = server => server.local
  ? [['连接', '直接执行，不使用 SSH'], ['外网 IP', server.publicIp || '未获取']]
  : [['连接', `${server.username}@${server.host}:${server.port}`, true], ['认证', server.keyLabel || (server.auth === 'password' ? '密码' : '密钥')], ['外网 IP', server.publicIp || '未获取'], ['Docker', server.docker || '未检测']];

function schedule() {
  poll = setTimeout(async () => {
    if (!alive) return;
    if (!document.hidden && !busy.value && !dialog.value) { await load(true); if (selected.value) await loadDetail(selected.value.id); }
    if (alive) schedule();
  }, 15000);
}
onMounted(() => { void load(); schedule(); clock = setInterval(() => { now.value = Date.now(); }, 30000); });
onBeforeUnmount(() => { alive = false; clearTimeout(poll); clearInterval(clock); emit('mobile-header-ready', false); });
</script>
<template>
  <section class="instances-page instance-ui h-full min-h-0" :class="{'has-selection': page === 'instances' && selected}">
    <AdminPageHeader title="实例" subtitle="子实例部署、访问网关与运行服务器" @mobile-header-ready="emit('mobile-header-ready', $event)">
      <template #mobile-navigation><slot name="mobile-navigation" /></template>
      <template #primary>
        <el-button v-if="page === 'instances'" type="primary" :disabled="!gatewayOn || busy" @click="open('create')">创建实例</el-button>
        <el-button v-else type="primary" :disabled="busy" @click="editServer(null)">添加服务器</el-button>
      </template>
    </AdminPageHeader>

    <div class="ix-bar">
      <nav class="ob-pages" aria-label="实例分区">
        <button type="button" :aria-current="page === 'instances' ? 'page' : undefined" @click="page = 'instances'">实例<span class="ix-count" aria-hidden="true">{{ counts.total }}</span></button>
        <button type="button" :aria-current="page === 'servers' ? 'page' : undefined" @click="page = 'servers'">服务器<span class="ix-count" aria-hidden="true">{{ servers.length }}</span></button>
      </nav>
      <div v-if="gatewayOn" class="ob-strip" role="group" aria-label="访问网关">
        <span class="ix-strip-label">访问网关</span>
        <span class="ix-pill" :data-tone="gateway.connected ? 'ok' : 'bad'">{{ gateway.connected ? '运行中' : '无法连接' }}</span>
        <a v-if="publicLink(gateway.publicUrl)" :href="publicLink(gateway.publicUrl)" target="_blank" rel="noopener noreferrer" class="ob-addr" :title="gateway.publicUrl">{{ gateway.publicUrl }}</a>
        <button type="button" class="ix-icon-button" aria-label="复制访问地址" title="复制访问地址" @click="copy(gateway.publicUrl, '访问地址')"><el-icon><CopyDocument /></el-icon></button>
        <button type="button" class="ix-text-button" @click="open('gateway')">设置</button>
      </div>
    </div>
    <p v-if="error" role="alert" class="instance-error instance-banner">{{ error }} <button type="button" class="instance-link" @click="load()">重试</button></p>

    <template v-if="page === 'instances'">
      <div v-if="gateway && !gatewayOn" class="ob-empty">
        <div class="ix-empty-mark" aria-hidden="true"><el-icon><Monitor /></el-icon></div>
        <h2>还没有启用访问网关</h2>
        <p>实例的使用者通过访问网关登录，登录后自动进入各自的实例。启用网关后才能创建实例。</p>
        <el-button type="primary" @click="open('gateway-setup')">启用访问网关</el-button>
      </div>
      <div v-else-if="gateway" class="instances-workspace" :class="{'has-selection': selected}">
        <aside class="instance-list" aria-label="实例列表">
          <div v-if="active.length" class="ix-list-head">
            <div class="ix-summary" aria-label="实例状态汇总">
              <span><b>{{ counts.ready }}</b> 正常</span>
              <span v-if="counts.attention" data-tone="bad"><b>{{ counts.attention }}</b> 需处理</span>
              <span v-if="counts.deploying" data-tone="warn"><b>{{ counts.deploying }}</b> 部署中</span>
            </div>
            <div v-if="filters.length > 1" class="ix-filters" role="tablist" aria-label="按状态筛选">
              <button v-for="[key, label, n] in filters" :key="key" type="button" role="tab" :aria-selected="listFilter === key" @click="listFilter = key">{{ label }} {{ n }}</button>
            </div>
          </div>
          <div class="instance-list-scroll">
            <p v-if="loading && !active.length" class="instance-empty" role="status">正在加载…</p>
            <div v-else-if="!active.length" class="instance-empty ix-list-empty">
              <p>还没有实例</p>
              <el-button size="small" :disabled="busy" @click="open('create')">创建第一个实例</el-button>
            </div>
            <p v-else-if="!visible.length" class="instance-empty">没有符合条件的实例</p>
            <button v-for="item in visible" :key="item.id" type="button" class="instance-row" :class="{'is-active': selected?.id === item.id}" :aria-current="selected?.id === item.id ? 'true' : undefined" @click="select(item)">
              <span class="ix-avatar" :data-tone="statusTone(displayStatus(item))" aria-hidden="true">{{ initial(item.name) }}</span>
              <span class="ix-row-body">
                <span class="instance-row-heading"><strong>{{ item.name }}</strong><span class="ob-dot" :data-tone="statusTone(displayStatus(item))">{{ statusLabel(displayStatus(item)) }}</span></span>
                <span class="instance-muted ix-row-line">{{ item.account?.username }} · {{ serverName(item.serverId) }}</span>
                <span class="instance-muted ix-row-line">{{ rowMeta(item) }}</span>
              </span>
            </button>
          </div>
        </aside>

        <article v-if="selected" class="instance-detail" :aria-label="selected.name + '详情'">
          <header class="instance-detail-header">
            <button type="button" class="instance-back" @click="back"><el-icon><ArrowLeft /></el-icon>实例</button>
            <div class="ix-hero">
              <span class="ix-avatar is-large" :data-tone="statusTone(selectedStatus)" aria-hidden="true">{{ initial(selected.name) }}</span>
              <div class="ix-hero-text">
                <div class="instance-row-heading"><h2>{{ selected.name }}</h2><span class="ob-dot" :data-tone="statusTone(selectedStatus)">{{ statusLabel(selectedStatus) }}</span></div>
                <p>账号 {{ selected.account?.username }} · {{ serverName(selected.serverId) }}<template v-if="version"> · {{ version }}</template></p>
              </div>
              <div class="instance-actions">
                <a v-if="publicLink(gateway.publicUrl)" :href="publicLink(gateway.publicUrl)" target="_blank" rel="noopener noreferrer" class="el-button ob-link-button">打开<el-icon class="el-icon--right"><TopRight /></el-icon></a>
                <el-button :disabled="busy || selected.status === 'deploying'" @click="openMaintain">维护…</el-button>
                <el-button :loading="busy" :disabled="busy" @click="check">立即检查</el-button>
                <el-dropdown trigger="click" :disabled="busy" @command="moreCommand">
                  <el-button class="ix-more" aria-label="更多操作"><el-icon><MoreFilled /></el-icon></el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="password">重置密码…</el-dropdown-item>
                      <el-dropdown-item command="redeploy" :disabled="selected.status === 'deploying'">重新部署…</el-dropdown-item>
                      <el-dropdown-item command="archive" class="ob-danger" divided>归档…</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </div>
          </header>
          <nav class="instance-tabs" aria-label="实例详情">
            <button v-for="[key, label] in detailTabs" :key="key" type="button" :aria-current="tab === key ? 'page' : undefined" @click="tab = key">{{ label }}</button>
          </nav>
          <p v-if="detailError" role="alert" class="instance-error instance-banner">{{ detailError }}</p>
          <div class="instance-detail-scroll">
            <template v-if="tab === 'overview'">
              <p v-if="syncProblem" class="ob-notice ob-row">账号变更尚未同步到访问网关（{{ errorText(syncProblem) }}），系统会自动重试。<el-button size="small" :disabled="busy" @click="retrySync">立即重试</el-button></p>
              <div v-if="runningOperation" class="ix-notice" data-tone="warn">
                <div><strong>{{ runningOperation.kind === 'maintenance' ? '正在维护' : '正在部署' }}</strong><span>{{ relativeTime(runningOperation.createdAtMs, now) || timeLabel(runningOperation.createdAtMs) }}开始，完成后会自动检查</span></div>
                <button type="button" class="ix-text-button" @click="emit('open-conversation', runningOperation.conversationUuid)">查看会话</button>
              </div>
              <div v-else-if="notice" class="ix-notice" :data-tone="notice.tone">
                <div><strong>{{ notice.title }}</strong><span>{{ notice.text }}</span></div>
                <button v-if="notice.tone !== 'off'" type="button" class="ix-text-button" :disabled="busy" @click="check">重新检查</button>
              </div>

              <div class="ix-grid">
                <section class="ix-card ix-span">
                  <header class="ix-card-head">
                    <h3>健康检查</h3>
                    <span class="instance-muted"><template v-if="checkedAt">{{ relativeTime(checkedAt, now) }}自动检查</template><template v-else>尚未自动检查</template><template v-if="selected.monitor?.failures"> · 连续失败 {{ selected.monitor.failures }} 次</template></span>
                  </header>
                  <ul v-if="checks.length" class="ix-checks">
                    <li v-for="[label, passed] in checks" :key="label" :data-state="passed === undefined ? 'unknown' : passed ? 'ok' : 'bad'">
                      <el-icon><CircleCheckFilled v-if="passed === true" /><CircleCloseFilled v-else-if="passed === false" /><Remove v-else /></el-icon>{{ label }}
                    </li>
                  </ul>
                  <p v-else class="instance-muted">还没有检查记录，点「立即检查」确认实例身份、就绪状态、数据持久化和网关路由。</p>
                </section>

                <section class="ix-card">
                  <header class="ix-card-head"><h3>访问与账号</h3></header>
                  <dl class="ix-facts">
                    <div><dt>访问地址</dt><dd><span class="mono ix-ellipsis" :title="gateway.publicUrl">{{ gateway.publicUrl }}</span><button type="button" class="ix-icon-button" aria-label="复制实例访问地址" title="复制" @click="copy(gateway.publicUrl, '访问地址')"><el-icon><CopyDocument /></el-icon></button></dd></div>
                    <div><dt>登录账号</dt><dd><span>{{ selected.account?.username }}</span><button type="button" class="ix-text-button" :disabled="busy" @click="resetPassword">重置密码</button></dd></div>
                    <div><dt>最近登录</dt><dd>{{ selected.lastLoginSuccessAtMs ? timeLabel(selected.lastLoginSuccessAtMs) : '尚无记录' }}</dd></div>
                  </dl>
                  <p class="ix-card-note">访问地址由所有实例共用，使用者登录后自动进入自己的实例。</p>
                </section>

                <section class="ix-card">
                  <header class="ix-card-head"><h3>运行环境</h3></header>
                  <dl class="ix-facts">
                    <div><dt>运行位置</dt><dd>{{ selectedServer?.local ? '本机' : selectedServer?.name || '未知服务器' }} · 端口 {{ selected.port }}</dd></div>
                    <div><dt>默认模型</dt><dd class="ix-ellipsis" :title="selected.models?.primary">{{ selected.models?.primary || '未设置' }}</dd></div>
                    <div><dt>数据目录</dt><dd><span class="mono ix-ellipsis" :title="selected.workspacePath">{{ selected.workspacePath }}</span><button type="button" class="ix-icon-button" aria-label="复制数据目录" title="复制" @click="copy(selected.workspacePath, '数据目录')"><el-icon><CopyDocument /></el-icon></button></dd></div>
                    <div v-if="selected.image"><dt>镜像</dt><dd>{{ selected.image }}</dd></div>
                    <div v-if="selected.createdAtMs"><dt>创建于</dt><dd>{{ timeLabel(selected.createdAtMs) }}</dd></div>
                  </dl>
                </section>

                <section class="ix-card ix-span">
                  <header class="ix-card-head"><h3>最近动态</h3><button v-if="events.length" type="button" class="ix-text-button" @click="tab = 'events'">全部记录</button></header>
                  <ol v-if="events.length" class="ix-timeline">
                    <li v-for="event in events.slice(0, 4)" :key="event.id" :data-tone="eventTone[event.type] || 'off'">
                      <span>{{ eventTypes[event.type] || event.type }}</span>
                      <span class="instance-muted">{{ event.data?.ip || healthText[event.data?.status] || event.data?.status || '' }}</span>
                      <time>{{ relativeTime(event.atMs, now) }}</time>
                    </li>
                  </ol>
                  <p v-else class="instance-muted">暂无登录或运行事件。</p>
                </section>
              </div>
            </template>

            <template v-else-if="tab === 'events'">
              <section class="ix-card">
                <header class="ix-card-head"><h3>通知</h3><span class="instance-muted">即时生效，通过主控的通知渠道发送</span></header>
                <div class="ob-toggles">
                  <label v-for="[key, label, hint] in notifyKeys" :key="key" class="ob-switch"><input v-model="notifications[key]" type="checkbox" @change="saveNotification(key)" /><span>{{ label }}<small>{{ hint }}</small></span></label>
                </div>
              </section>
              <section class="ix-card">
                <header class="ix-card-head"><h3>登录与运行记录</h3></header>
                <p v-if="!events.length" class="instance-muted">暂无记录</p>
                <ol v-else class="ix-timeline">
                  <li v-for="event in events" :key="event.id" class="ob-event" :data-tone="eventTone[event.type] || 'off'">
                    <span>{{ eventTypes[event.type] || event.type }}</span>
                    <span class="instance-muted">{{ event.data?.ip || healthText[event.data?.status] || event.data?.status || '' }}</span>
                    <time :title="timeLabel(event.atMs)">{{ timeLabel(event.atMs) }}</time>
                  </li>
                </ol>
              </section>
            </template>

            <template v-else-if="tab === 'sessions'">
              <div class="ob-folder"><span>部署和维护会话统一放在会话目录「实例部署」中</span><button type="button" class="instance-link" @click="openFolder">打开目录 →</button></div>
              <p v-if="!operations.length" class="instance-empty">暂无部署记录</p>
              <ol v-else class="ix-ops">
                <li v-for="operation in operations" :key="operation.id" class="ob-event">
                  <span class="ix-op-kind">{{ operation.kind === 'maintenance' ? '维护' : '部署' }}</span>
                  <span class="ob-dot" :data-tone="operationTone[operation.status] || 'bad'">{{ operationStatuses[operation.status] || operation.status }}</span>
                  <time class="instance-muted"><el-icon><Clock /></el-icon>{{ timeLabel(operation.createdAtMs) }}</time>
                  <button type="button" class="instance-link" @click="emit('open-conversation', operation.conversationUuid)">打开会话 →</button>
                </li>
              </ol>
            </template>
            <ChildBusinessPanel v-else :key="selected.id" :instance="selected" />
          </div>
        </article>
        <div v-else class="instance-detail-placeholder">
          <div class="ix-empty-mark" aria-hidden="true"><el-icon><Monitor /></el-icon></div>
          <p>{{ active.length ? '选择一个实例查看详情' : '创建实例后，这里显示它的运行状态和管理操作' }}</p>
        </div>
      </div>
    </template>

    <div v-else class="ob-servers">
      <article v-for="server in servers" :key="server.id" class="ob-server">
        <header class="ix-server-head">
          <span class="ix-server-icon" aria-hidden="true"><el-icon><Monitor /></el-icon></span>
          <div class="ob-server-main">
            <strong>{{ server.local ? '本机' : server.name }}</strong>
            <span class="instance-muted">{{ serverAddress(server) }}</span>
          </div>
          <span class="ix-pill" :data-tone="server.status === 'unreachable' ? 'bad' : 'ok'">{{ server.status === 'unreachable' ? '无法连接' : server.local ? '正常' : '连接正常' }}</span>
        </header>
        <dl class="ix-facts is-compact">
          <div v-for="[label, value, mono] in serverFacts(server)" :key="label"><dt>{{ label }}</dt><dd :class="{mono}">{{ value }}</dd></div>
        </dl>
        <div class="ix-usage">
          <span class="instance-muted">用于</span>
          <template v-if="server.usedBy?.length"><span v-for="name in server.usedBy" :key="name" class="ix-chip">{{ name }}</span></template>
          <span v-else class="instance-muted">未使用</span>
        </div>
        <footer class="instance-actions">
          <el-button :disabled="busy" @click="checkServer(server)"><el-icon class="el-icon--left"><Refresh /></el-icon>{{ server.local ? '检查' : '测试连接' }}</el-button>
          <template v-if="!server.local">
            <el-button :disabled="busy" @click="editServer(server)">编辑</el-button>
            <el-button :disabled="busy || server.usedBy?.length > 0" :title="server.usedBy?.length ? '正在被使用' : ''" @click="deleteServer(server)">删除</el-button>
          </template>
        </footer>
      </article>
      <button type="button" class="ix-add-server" :disabled="busy" @click="editServer(null)"><span>+</span>添加服务器</button>
    </div>

    <el-dialog :model-value="dialog === 'gateway-setup'" @update:model-value="dismiss('gateway-setup')" :title="gatewayOn ? '修改访问网关' : '启用访问网关'" width="540px" class="admin-dialog instance-dialog instance-ui" append-to-body destroy-on-close :close-on-click-modal="false" :before-close="closeDialog">
      <GatewaySetup v-if="dialog === 'gateway-setup'" ref="dialogRef" :servers="servers" :gateway="gateway" @done="gatewayDone" @cancel="dialog = ''" @servers-changed="loadServers" />
    </el-dialog>
    <el-dialog :model-value="dialog === 'gateway'" @update:model-value="dismiss('gateway')" title="访问网关" width="540px" class="admin-dialog instance-dialog instance-ui" append-to-body destroy-on-close :before-close="closeDialog">
      <GatewaySettings v-if="dialog === 'gateway' && gateway" ref="dialogRef" :gateway="gateway" :servers="servers" :instance-count="active.length" @changed="gatewayChanged" @edit="dialog = 'gateway-setup'" @cancel="dialog = ''" />
    </el-dialog>
    <el-dialog :model-value="dialog === 'create'" @update:model-value="dismiss('create')" title="创建实例" width="540px" class="admin-dialog instance-dialog instance-ui" append-to-body destroy-on-close :close-on-click-modal="false" :before-close="closeDialog">
      <InstanceForm v-if="dialog === 'create'" ref="dialogRef" :servers="servers" @created="instanceCreated" @cancel="dialog = ''" @servers-changed="loadServers" />
    </el-dialog>
    <el-dialog :model-value="dialog === 'created'" :title="created ? `已创建「${created.item.name}」，正在部署` : ''" width="520px" class="admin-dialog instance-dialog instance-ui" append-to-body :close-on-click-modal="false" :before-close="closeCreatedDialog">
      <div v-if="created" class="instance-form">
        <p class="instance-muted">登录信息（密码只显示这一次）</p>
        <dl class="ob-cred">
          <div><dt>访问地址</dt><dd class="mono">{{ created.url }}</dd><span></span></div>
          <div><dt>账号</dt><dd class="mono">{{ created.item.account.username }}</dd><span></span></div>
          <div><dt>密码</dt><dd class="mono">{{ created.password }}</dd><button type="button" class="instance-link" @click="copy(created.password, '密码')">复制</button></div>
        </dl>
        <div><el-button @click="copy(credentialText, '登录信息')">复制全部登录信息</el-button></div>
        <ul class="ob-checks">
          <li><span :class="created.item.gateway?.status === 'synced' ? 'ob-ok' : 'instance-muted'">{{ created.item.gateway?.status === 'synced' ? '✓' : '…' }}</span>{{ created.item.gateway?.status === 'synced' ? '账号已写入访问网关' : '正在把账号写入访问网关' }}</li>
          <li v-if="created.deployment?.ok === false"><span class="ob-bad">✗</span>部署会话没有启动：{{ errorText(created.deployment.error) }}</li>
          <li v-else><span class="instance-muted">…</span>正在部署到{{ serverName(created.item.serverId) }}，通常需要几分钟</li>
          <li><span class="instance-muted">·</span>完成后自动检查，并通知你结果</li>
        </ul>
        <div class="instance-form-footer">
          <el-button v-if="created.conversationUuid" @click="emit('open-conversation', created.conversationUuid); closeCreated()">查看部署会话</el-button>
          <el-button type="primary" @click="closeCreated">完成</el-button>
        </div>
      </div>
    </el-dialog>
    <el-dialog :model-value="dialog === 'maintain'" @update:model-value="dismiss('maintain')" :title="selected ? `维护「${selected.name}」` : ''" width="520px" class="admin-dialog instance-dialog instance-ui" append-to-body destroy-on-close :close-on-click-modal="false">
      <form v-if="selected" class="instance-form" @submit.prevent="startMaintain">
        <div class="ob-fields">
          <div class="ob-field"><span>要做什么</span><div class="ob-ctl"><textarea v-model="maintain.instructions" rows="4" required aria-label="维护内容" placeholder="例如：安装 LibreOffice；排查最近两次无法连接的原因。" /><small>不会删除数据目录，除非你在这里明确要求。</small></div></div>
          <label class="ob-field"><span>执行模型</span><select v-model="maintain.model" aria-label="执行模型"><option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option><option v-if="!modelOptions.length" value="">主控默认模型</option></select></label>
        </div>
        <div class="instance-form-footer">
          <span class="ob-hint">将在「实例部署」目录新建会话「维护 · {{ selected.name }}」。</span>
          <el-button :disabled="busy" @click="dialog = ''">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="busy" :disabled="!maintain.instructions.trim()">开始维护</el-button>
        </div>
      </form>
    </el-dialog>
    <el-dialog :model-value="dialog === 'server'" @update:model-value="dismiss('server')" :title="editingServer ? '编辑服务器' : '添加服务器'" width="500px" class="admin-dialog instance-dialog instance-ui" append-to-body destroy-on-close :close-on-click-modal="false" :before-close="closeDialog">
      <ServerForm v-if="dialog === 'server'" ref="dialogRef" :server="editingServer" @saved="serverSaved" @cancel="dialog = ''" />
    </el-dialog>
  </section>
</template>
