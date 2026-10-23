<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { childClient, parseObject, safeError } from './instanceHelpers.js';
import { withMcpExposureConfirmation } from '../mcpExposure.js';
const props = defineProps({instance: {type: Object, required: true}});
// This component is keyed by instance ID. All requests capture that immutable ID.
const request = childClient(props.instance.id);
const mcpRequest = (method, path, body = {}) => withMcpExposureConfirmation(confirmations => request(method, path, {
  ...body, [path === '/api/managed/v1/config' ? 'mcpExposureConfirmations' : 'exposureConfirmations']: confirmations,
}));
const section = ref('memory'), loading = ref(false), busy = ref(false), error = ref('');
const sections = [['memory', '记忆'], ['channels', '模型渠道'], ['skills', 'Skills'], ['mcp', 'MCP'], ['settings', '业务设置'], ['environment', '环境与依赖']];
const mcpStatusText = {connected: '已连接', failed: '连接失败', disabled: '已停用', pending: '连接中', awaiting_confirmation: '待确认', stopped: '已停止'};
const mcpTone = {connected: 'ok', failed: 'bad', pending: 'warn', awaiting_confirmation: 'warn'};
const protocolText = {chat: 'OpenAI Chat', responses: 'OpenAI Responses', anthropic: 'Anthropic'};
const jobStatusText = {queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已停止', timeout: '已超时'};
const jobTone = {completed: 'ok', running: 'warn', queued: 'warn', failed: 'bad', timeout: 'bad'};
const skillEnabled = skill => skill.configuredEnabled ?? skill.userEnabled ?? skill.status !== 'disabled';
const skillTone = skill => skill.status === 'enabled' ? 'ok' : ['dependency_missing', 'unavailable'].includes(skill.status) ? 'warn' : 'off';
const mcpQueries = reactive({});
function childTools(row) { return (mcp.value.tools || []).filter(t => t.serverKey === row.key && `${t.originalToolName} ${t.description}`.toLowerCase().includes((mcpQueries[row.key] || '').toLowerCase())); }
function setChildTools(row, names) { return perform(() => mcpRequest('PATCH', `/api/mcp/servers/${encodeURIComponent(row.key)}/tools`, {disabledTools: names})); }
const entries = ref([]), providers = ref([]), primary = ref(''), skills = ref([]), skillsDir = ref(''), mcp = ref({servers: []});
const specs = ref({}), values = ref({}), settingsQuery = ref(''), settingPath = ref(''), settingValue = ref(''), advanced = ref('');
const editor = ref(''), editId = ref(''), dialogOpen = ref(false), skillDetail = ref(null);
const memory = reactive({title: '', ref: '', note: '', grp: '', body: '', category: 'memory', enabled: true, expanded: false});
const channel = reactive({name: '', baseUrl: '', apiKey: '', protocol: 'chat', modelIds: '', enabled: true});
const model = reactive({provider: '', id: '', name: '', contextWindow: 128000, maxTokens: 8192, reasoning: false, image: false});
const server = reactive({name: '', transport: 'stdio', command: '', args: '', url: '', cwd: '', approval: 'ask', envName: '', envValue: '', headerName: '', headerValue: ''});
const environment = reactive({command: '', timeoutSeconds: 120, confirmed: false});
const fileInstall = reactive({kind: 'skills', path: '', content: '', executable: false, confirmed: false});
const job = ref(null), jobId = ref(''), jobPolling = ref(false), advancedConfirmed = ref(false);
let alive = true, generation = 0, timer;
const currentSpec = computed(() => specs.value[settingPath.value]);
const visibleSpecs = computed(() => Object.values(specs.value).filter(s => !['tools.skillsDir', 'mcp.installDir'].includes(s.path) && /^(agent|tools|memory|models|mcp|contextManagement)(\.|$)/.test(s.path) && `${s.title} ${s.path}`.toLowerCase().includes(settingsQuery.value.toLowerCase())));
function clearSecrets() { fileInstall.content = ''; channel.apiKey = ''; server.envValue = ''; server.headerValue = ''; advanced.value = ''; environment.command = ''; if (currentSpec.value?.sensitive) settingValue.value = ''; }
onBeforeUnmount(() => { alive = false; generation++; clearTimeout(timer); clearSecrets(); });
async function perform(fn, reload = true) {
  if (busy.value) return false;
  busy.value = true; error.value = '';
  try { await fn(); if (!alive) return false; if (reload) await load(); return true; }
  catch (e) { if (alive && !e.mcpCancelled) error.value = safeError(e); return false; }
  finally { if (alive) busy.value = false; }
}
async function load() {
  const ticket = ++generation, selected = section.value;
  loading.value = true; error.value = '';
  try {
    const paths = {memory: '/api/memory/entries', channels: '/api/channels', skills: '/api/skills', mcp: '/api/mcp/status', settings: '/api/settings'};
    if (!paths[selected]) return;
    const data = await request('GET', paths[selected]);
    if (!alive || ticket !== generation) return;
    if (selected === 'memory') entries.value = data.items || [];
    if (selected === 'channels') { providers.value = data.providers || []; primary.value = data.primaryModel || ''; }
    if (selected === 'skills') { skills.value = data.items || []; skillsDir.value = data.skillsDir || data.stats?.directory || ''; }
    if (selected === 'mcp') mcp.value = data;
    if (selected === 'settings') {
      values.value = data.values || {};
      const result = await request('GET', '/api/settings/specs');
      if (alive && ticket === generation) specs.value = result.specs || {};
    }
  } catch (e) { if (alive && ticket === generation) error.value = safeError(e); }
  finally { if (alive && ticket === generation) loading.value = false; }
}
watch(section, () => { dialogOpen.value = false; clearSecrets(); settingPath.value = ''; void load(); });
onMounted(load);
async function editMemory(row) {
  if (busy.value) return;
  await perform(async () => {
    const item = row ? (await request('GET', `/api/memory/entries/${encodeURIComponent(row.id)}`)).item : {};
    Object.assign(memory, {title: item.title || '', ref: item.ref || '', note: item.note || '', grp: item.grp || '', body: item.body || '', category: item.category || 'memory', enabled: item.enabled !== 0, expanded: Boolean(item.expanded)});
    editId.value = row?.id || ''; editor.value = 'memory'; dialogOpen.value = true;
  }, false);
}
function editChannel(row) {
  Object.assign(channel, {name: row?.name || '', baseUrl: row?.baseUrl || '', apiKey: '', protocol: row?.protocol || 'chat', enabled: row?.enabled !== false, modelIds: ''});
  editId.value = row?.name || ''; editor.value = 'channel'; dialogOpen.value = true;
}
function editModel(provider, row) {
  Object.assign(model, {provider, id: row?.id || '', name: row?.name || '', contextWindow: row?.contextWindow || 128000, maxTokens: row?.maxTokens || 8192, reasoning: Boolean(row?.reasoning), image: row?.input?.includes('image') || false});
  editId.value = row?.id || ''; editor.value = 'model'; dialogOpen.value = true;
}
function editServer(row) {
  Object.assign(server, {name: row?.key || '', transport: row?.transport || 'stdio', command: '', args: '', url: '', cwd: '', approval: row?.approval || 'ask', envName: '', envValue: '', headerName: '', headerValue: ''});
  editId.value = row?.key || ''; editor.value = 'server'; dialogOpen.value = true;
}
async function saveEditor() {
  const success = await perform(async () => {
    if (editor.value === 'memory') await request(editId.value ? 'PUT' : 'POST', `/api/memory/entries${editId.value ? '/' + encodeURIComponent(editId.value) : ''}`, {...memory, enabled: Number(memory.enabled), expanded: Number(memory.expanded)});
    if (editor.value === 'channel') {
      const body = {name: channel.name.trim(), baseUrl: channel.baseUrl.trim(), protocol: channel.protocol, enabled: channel.enabled};
      if (channel.apiKey || !editId.value) body.apiKey = channel.apiKey;
      if (!editId.value) body.models = channel.modelIds.split(/[,\n]+/).map(x => x.trim()).filter(Boolean).map(id => ({id}));
      await request(editId.value ? 'PATCH' : 'POST', `/api/channels${editId.value ? '/' + encodeURIComponent(editId.value) : ''}`, body);
      channel.apiKey = '';
    }
    if (editor.value === 'model') {
      const body = {id: model.id, name: model.name || model.id, contextWindow: Number(model.contextWindow), maxTokens: Number(model.maxTokens), reasoning: model.reasoning, input: model.image ? ['text', 'image'] : ['text']};
      await request(editId.value ? 'PATCH' : 'POST', `/api/channels/${encodeURIComponent(model.provider)}/models${editId.value ? '/' + encodeURIComponent(editId.value) : ''}`, body);
    }
    if (editor.value === 'server') {
      const config = {transport: server.transport, approval: server.approval};
      if (server.transport === 'stdio') {
        if (server.command) config.command = server.command;
        if (server.args || !editId.value) config.args = server.args.split('\n').filter(Boolean);
        if (server.cwd) config.cwd = server.cwd;
        if (server.envName && server.envValue) config.env = {[server.envName]: server.envValue};
      } else {
        if (server.url) config.url = server.url;
        if (server.headerName && server.headerValue) config.headers = {[server.headerName]: server.headerValue};
      }
      await mcpRequest('PATCH', '/api/managed/v1/config', {mcp: {servers: {[server.name.trim()]: config}}});
      server.envValue = ''; server.headerValue = '';
      // Config changes retain existing apply hooks; explicit reload exposes failures.
      await mcpRequest('POST', '/api/mcp/reload', {});
    }
  });
  if (success) { dialogOpen.value = false; ElMessage.success('子实例配置已保存'); }
}
async function viewSkill(row) {
  await perform(async () => { skillDetail.value = (await request('GET', `/api/skills/${encodeURIComponent(row.name)}`)).item; editor.value = 'skill'; dialogOpen.value = true; }, false);
}
function setSetting(path) {
  settingPath.value = path;
  const spec = specs.value[path], value = values.value[path];
  settingValue.value = spec.sensitive ? '' : ['multi', 'json'].includes(spec.kind) || (value && typeof value === 'object') ? JSON.stringify(value ?? [], null, 2) : value ?? '';
}
async function saveSetting() {
  const spec = currentSpec.value;
  if (!spec) return;
  const success = await perform(async () => {
    let value = settingValue.value;
    if (spec.sensitive && !value) return;
    if (['int', 'float'].includes(spec.kind)) value = value === '' && spec.nullable ? null : Number(value);
    else if (['multi', 'json'].includes(spec.kind) || (values.value[spec.path] && typeof values.value[spec.path] === 'object')) value = JSON.parse(value);
    await request('PATCH', `/api/settings/${encodeURIComponent(spec.path)}`, {value});
    if (spec.sensitive) settingValue.value = '';
  });
  if (success) ElMessage.success('设置已保存');
}
async function saveAdvanced() {
  if (!advancedConfirmed.value) return;
  const success = await perform(async () => { const patch = parseObject(advanced.value); await (patch.mcp ? mcpRequest : request)('PATCH', '/api/managed/v1/config', patch); advanced.value = ''; }, false);
  advancedConfirmed.value = false;
  if (success) ElMessage.success('业务配置补丁已保存');
}
function pollJob() {
  clearTimeout(timer);
  if (alive && ['queued', 'running'].includes(job.value?.status)) timer = setTimeout(() => void refreshJob(), 2500);
}
async function refreshJob() {
  if (jobPolling.value || !jobId.value.trim()) return;
  jobPolling.value = true;
  try { const data = await request('GET', `/api/managed/v1/jobs/${encodeURIComponent(jobId.value.trim())}`); if (alive) { job.value = data.job; error.value = ''; pollJob(); } }
  catch (e) { if (alive) error.value = safeError(e); }
  finally { if (alive) jobPolling.value = false; }
}
async function startJob() {
  if (!environment.confirmed || !environment.command.trim() || ['queued', 'running'].includes(job.value?.status)) return;
  await perform(async () => {
    const data = await request('POST', '/api/managed/v1/jobs', {command: environment.command, timeoutSeconds: Number(environment.timeoutSeconds)});
    job.value = data.job; jobId.value = data.job.id; environment.command = ''; pollJob();
  }, false);
  environment.confirmed = false;
}
async function cancelJob() {
  await perform(async () => { const data = await request('POST', `/api/managed/v1/jobs/${encodeURIComponent(jobId.value)}/cancel`, {}); job.value = data.job; clearTimeout(timer); }, false);
}
function openInstall(kind) {
  Object.assign(fileInstall, {kind, path: '', content: '', executable: false, confirmed: false});
  editor.value = 'file'; dialogOpen.value = true;
}
async function saveFile() {
  if (!fileInstall.confirmed) return;
  const parts = fileInstall.path.trim().split('/');
  if (parts.some(p => !p || p.startsWith('.') || /[\\\\\u0000-\u001f]/.test(p))) { error.value = '请填写配置目录内的相对路径，不可包含隐藏路径或上级目录。'; return; }
  if (new TextEncoder().encode(fileInstall.content).length > 180000) { error.value = '文件内容过大，请分拆为较小文件。'; return; }
  const success = await perform(async () => {
    await request('PUT', `/api/managed/v1/files/${fileInstall.kind}/${parts.map(encodeURIComponent).join('/')}`, {content: fileInstall.content, executable: fileInstall.executable});
    fileInstall.content = '';
    if (fileInstall.kind === 'skills') await request('POST', '/api/skills/reload', {});
  });
  fileInstall.confirmed = false;
  if (success) { dialogOpen.value = false; ElMessage.success('文件已写入子实例配置目录'); }
}
function closeEditor(done) { if (!busy.value) { channel.apiKey = ''; server.envValue = ''; server.headerValue = ''; done(); } }
</script>
<template>
  <section class="child-business">
    <div class="cb-head">
      <nav class="cb-sections" role="tablist" aria-label="子实例管理分区">
        <button v-for="[key, label] in sections" :key="key" type="button" role="tab" :aria-selected="section === key" :disabled="busy" @click="section = key">{{ label }}</button>
      </nav>
      <button v-if="section !== 'environment'" type="button" class="ix-text-button cb-refresh" :disabled="busy || loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>
    <p class="cb-target">管理目标 <b>{{ instance.name }}</b> <span class="mono">{{ instance.managementUrl }}</span> · 经主控中继，不向浏览器暴露管理密钥</p>
    <p v-if="error" role="alert" class="ix-notice cb-error" data-tone="bad"><span>{{ error }}</span></p>

    <template v-if="section === 'memory'">
      <div class="cb-toolbar"><span class="cb-meta">{{ entries.length }} 条长期记忆</span><el-button :disabled="busy" @click="editMemory()">新增记忆</el-button></div>
      <p v-if="!loading && !entries.length" class="cb-empty">暂无长期记忆</p>
      <ul v-else class="cb-list">
        <li v-for="entry in entries" :key="entry.id" class="cb-item">
          <div class="cb-item-main">
            <div class="cb-item-title"><strong>{{ entry.title }}</strong><span class="ix-pill" :data-tone="entry.enabled ? 'ok' : 'off'">{{ entry.enabled ? '已启用' : '已停用' }}</span><span class="cb-tag">{{ entry.expanded ? '展开' : '索引' }}</span></div>
            <p v-if="entry.note || entry.ref" class="cb-desc">{{ entry.note || entry.ref }}</p>
          </div>
          <el-button size="small" :disabled="busy" @click="editMemory(entry)">编辑</el-button>
        </li>
      </ul>
    </template>

    <template v-else-if="section === 'channels'">
      <div class="cb-toolbar"><span class="cb-meta">默认模型 <b class="mono">{{ primary || '未设置' }}</b></span><el-button :disabled="busy" @click="editChannel()">新增渠道</el-button></div>
      <p v-if="!loading && !providers.length" class="cb-empty">暂无模型渠道</p>
      <article v-for="provider in providers" :key="provider.name" class="cb-card">
        <header class="cb-card-head">
          <div class="cb-item-main">
            <div class="cb-item-title"><strong>{{ provider.name }}</strong><span class="ix-pill" :data-tone="provider.enabled === false ? 'off' : 'ok'">{{ provider.enabled === false ? '停用' : '启用' }}</span><span class="cb-tag">{{ protocolText[provider.protocol] || provider.protocol }}</span></div>
            <p class="cb-desc mono">{{ provider.baseUrl }}</p>
          </div>
          <div class="cb-actions"><el-button size="small" :disabled="busy" @click="editChannel(provider)">编辑渠道</el-button><el-button size="small" :disabled="busy" @click="editModel(provider.name)">新增模型</el-button></div>
        </header>
        <ul class="cb-rows">
          <li v-for="row in provider.models || []" :key="row.id" class="instance-model-row">
            <span class="cb-model"><span>{{ row.name || row.id }}</span><small v-if="row.name && row.name !== row.id" class="mono">{{ row.id }}</small></span>
            <span v-if="primary === provider.name + '/' + row.id" class="ix-pill" data-tone="ok">当前默认</span>
            <div class="cb-actions">
              <button type="button" class="ix-text-button" :disabled="busy" @click="editModel(provider.name, row)">编辑</button>
              <button v-if="primary !== provider.name + '/' + row.id" type="button" class="ix-text-button" :disabled="busy || provider.enabled === false" @click="perform(() => request('POST', '/api/channels/primary', {model: provider.name + '/' + row.id}))">设为默认</button>
            </div>
          </li>
          <li v-if="!(provider.models || []).length" class="cb-row-empty">这个渠道还没有模型</li>
        </ul>
      </article>
    </template>

    <template v-else-if="section === 'skills'">
      <div class="cb-toolbar">
        <span class="cb-meta">目录 <span class="mono">{{ skillsDir || '未返回' }}</span></span>
        <div class="cb-actions"><el-button :disabled="busy" @click="perform(() => request('POST', '/api/skills/reload', {}))">重新加载</el-button><el-button :disabled="busy" @click="openInstall('skills')">写入 Skill 文件…</el-button><el-button :disabled="busy" @click="section = 'environment'">安装依赖…</el-button></div>
      </div>
      <p class="cb-hint">可直接写入 Skill 文件；额外软件包请到「环境与依赖」中安装，只在子实例内生效。</p>
      <p v-if="!loading && !skills.length" class="cb-empty">尚未安装 Skills</p>
      <ul v-else class="cb-list">
        <li v-for="skill in skills" :key="skill.name" class="cb-item">
          <div class="cb-item-main">
            <div class="cb-item-title"><strong class="mono">{{ skill.name }}</strong><span class="ix-pill" :data-tone="skillTone(skill)">{{ skill.statusLabel || skill.status }}</span></div>
            <p v-if="skill.description" class="cb-desc">{{ skill.description }}</p>
            <p v-if="skill.reason" class="cb-desc" data-tone="warn">{{ skill.reason }}</p>
          </div>
          <div class="cb-actions"><el-button size="small" :disabled="busy" @click="viewSkill(skill)">查看文档</el-button><el-button size="small" :disabled="busy" @click="perform(() => request('PATCH', '/api/skills/' + encodeURIComponent(skill.name) + '/enabled', {enabled: !skillEnabled(skill)}))">{{ skillEnabled(skill) ? '停用' : '启用' }}</el-button></div>
        </li>
      </ul>
    </template>

    <template v-else-if="section === 'mcp'">
      <div class="cb-toolbar">
        <span class="cb-meta">全局 MCP <span class="ix-pill" :data-tone="mcp.enabled ? 'ok' : 'off'">{{ mcp.enabled ? '已启用' : '已停用' }}</span></span>
        <div class="cb-actions"><el-button :disabled="busy" @click="perform(() => mcpRequest('PATCH', '/api/mcp/enabled', {enabled: !mcp.enabled}))">{{ mcp.enabled ? '停用全局 MCP' : '启用全局 MCP' }}</el-button><el-button :disabled="busy" @click="editServer()">添加 MCP</el-button><el-button :disabled="busy" @click="openInstall('mcp')">写入 MCP 文件…</el-button><el-button :disabled="busy" @click="perform(() => mcpRequest('POST', '/api/mcp/reload', {}))">重新连接</el-button></div>
      </div>
      <p class="cb-hint">添加或更新连接会在子实例启动 MCP 进程或连接远程服务。工具默认需确认，不自动开放给 Agent。</p>
      <p v-if="!loading && !(mcp.servers || []).length" class="cb-empty">暂无 MCP 连接</p>
      <article v-for="row in mcp.servers || []" :key="row.key" class="cb-card">
        <header class="cb-card-head">
          <div class="cb-item-main">
            <div class="cb-item-title"><strong>{{ row.name || row.key }}</strong><span class="ix-pill" :data-tone="row.enabled === false ? 'off' : mcpTone[row.status] || 'off'">{{ mcpStatusText[row.status] || row.status }}</span><span class="cb-tag">{{ row.enabledTools ?? row.toolCount ?? 0 }} / {{ row.totalTools || 0 }} 工具</span><span v-if="mcp.toolSelectionAvailable" class="cb-tag">{{ ((row.definitionBytes || 0) / 1024).toFixed(1) }} KB</span></div>
            <p v-if="row.description" class="cb-desc">{{ row.description }}</p>
          </div>
        </header>
        <div class="cb-card-foot">
          <label class="cb-select">调用审批<select :value="row.approval" :disabled="busy" :aria-label="row.key + ' 调用审批'" @change="perform(() => request('PATCH', '/api/mcp/servers/' + encodeURIComponent(row.key) + '/approval', {approval: $event.target.value}))"><option value="ask">询问</option><option value="deny">拒绝</option><option value="allow">允许</option></select></label>
          <div class="cb-actions"><el-button size="small" :disabled="busy" @click="editServer(row)">更新连接…</el-button><el-button size="small" :disabled="busy" @click="perform(() => mcpRequest('PATCH', '/api/mcp/servers/' + encodeURIComponent(row.key) + '/enabled', {enabled: !row.enabled}))">{{ row.enabled ? '停用' : '启用' }}</el-button></div>
        </div>
        <details class="cb-tools">
          <summary>工具清单</summary>
          <template v-if="mcp.toolSelectionAvailable">
            <div class="cb-tools-bar"><input v-model="mcpQueries[row.key]" type="search" placeholder="搜索工具名称或说明" :aria-label="row.key + ' 搜索工具'" /><el-button size="small" :disabled="busy" @click="setChildTools(row, [])">全选</el-button><el-button size="small" :disabled="busy" @click="setChildTools(row, [...new Set([...(row.disabledTools || []), ...(mcp.tools || []).filter(t => t.serverKey === row.key).map(t => t.originalToolName)])])">全不选</el-button><el-button v-if="row.status === 'awaiting_confirmation'" size="small" :disabled="busy" @click="perform(() => mcpRequest('POST', '/api/mcp/servers/' + encodeURIComponent(row.key) + '/confirm-exposure', {}))">确认当前工具集</el-button></div>
          </template>
          <div class="child-mcp-tools"><div v-for="tool in childTools(row)" :key="tool.publicName" class="child-mcp-tool"><div><code>{{ tool.originalToolName }}</code><p>{{ tool.description }}</p><small v-if="mcp.toolSelectionAvailable">{{ ((tool.definitionBytes || 0) / 1024).toFixed(1) }} KB</small></div><el-switch v-if="mcp.toolSelectionAvailable" :model-value="!(row.disabledTools || []).includes(tool.originalToolName)" :disabled="busy" :aria-label="'启用 ' + tool.originalToolName" @change="v => setChildTools(row, v ? (row.disabledTools || []).filter(n => n !== tool.originalToolName) : [...(row.disabledTools || []), tool.originalToolName])" /></div></div>
        </details>
      </article>
    </template>

    <template v-else-if="section === 'settings'">
      <form class="cb-card cb-form" @submit.prevent="saveSetting">
        <div class="cb-form-row">
          <label>搜索业务设置<input v-model="settingsQuery" type="search" aria-label="搜索业务设置" placeholder="名称或路径" /></label>
          <label>设置项<select :value="settingPath" aria-label="业务设置项" @change="setSetting($event.target.value)"><option value="">选择设置项</option><option v-for="spec in visibleSpecs" :key="spec.path" :value="spec.path">{{ spec.title }} · {{ spec.path }}</option></select></label>
        </div>
        <template v-if="currentSpec">
          <div class="cb-spec"><strong>{{ currentSpec.title }}</strong><span class="mono">{{ currentSpec.path }}</span><p v-if="currentSpec.desc || currentSpec.effect">{{ currentSpec.desc }} {{ currentSpec.effect }}</p></div>
          <label v-if="currentSpec.kind === 'bool'" class="instance-check"><input v-model="settingValue" type="checkbox" />{{ currentSpec.title }}</label>
          <label v-else>{{ currentSpec.title }}<input v-if="currentSpec.sensitive" v-model="settingValue" type="password" autocomplete="new-password" placeholder="留空不改原值" /><select v-else-if="currentSpec.choices?.length && currentSpec.kind !== 'multi'" v-model="settingValue"><option v-for="choice in currentSpec.choices" :key="String(choice.value)" :value="choice.value">{{ choice.label }}</option></select><input v-else-if="['int','float'].includes(currentSpec.kind)" v-model="settingValue" type="number" :step="currentSpec.kind === 'int' ? 1 : 'any'" :min="currentSpec.min" :max="currentSpec.max" /><textarea v-else v-model="settingValue" rows="5" /></label>
          <div class="cb-form-foot"><el-button type="primary" native-type="submit" :disabled="busy || (currentSpec.sensitive && !settingValue)" :loading="busy">保存此设置</el-button></div>
        </template>
        <p v-else class="cb-hint">从上方选择一个设置项查看说明并修改；修改只作用于 {{ instance.name }}。</p>
      </form>
      <details class="cb-card cb-advanced instance-advanced">
        <summary>高级业务配置补丁</summary>
        <form class="cb-form" @submit.prevent="saveAdvanced">
          <p class="cb-hint">仅填写要修改的字段，未填写字段保留；不会读取或显示现有密码。角色、管理密钥及持久化路径不可修改。JSON 只用于补充上方表单，可能影响运行中业务。</p>
          <label>JSON 对象<textarea v-model="advanced" class="mono" rows="7" spellcheck="false" aria-label="业务配置补丁" /></label>
          <label class="instance-check"><input v-model="advancedConfirmed" type="checkbox" />确认将此补丁应用到 {{ instance.name }}</label>
          <div class="cb-form-foot"><el-button native-type="submit" :disabled="busy || !advancedConfirmed">应用配置补丁</el-button></div>
        </form>
      </details>
    </template>

    <template v-else-if="section === 'environment'">
      <form class="cb-card cb-form" @submit.prevent="startJob">
        <p class="cb-hint">仅在 {{ instance.name }} 的容器内执行，不能访问主控宿主机或 Docker socket。用于安装依赖、写入 Skills/MCP 文件与诊断；/workspace 外的软件在重建后可能丢失。命令和输出会保留在子实例，请勿填入密码、私钥或令牌。</p>
        <label>环境命令<textarea v-model="environment.command" class="mono" rows="5" spellcheck="false" aria-label="环境命令" placeholder="例如：python --version" :disabled="busy" required /></label>
        <div class="cb-form-row is-compact">
          <label>超时（秒）<input v-model.number="environment.timeoutSeconds" type="number" min="1" max="3600" required aria-label="命令超时" /></label>
        </div>
        <label class="instance-check"><input v-model="environment.confirmed" type="checkbox" :disabled="busy" aria-label="确认环境命令副作用" />确认仅在此子实例执行所填命令，已核对文件与软件变更，不删除业务数据。</label>
        <div class="cb-form-foot"><el-button type="primary" native-type="submit" :disabled="busy || !environment.confirmed || !environment.command.trim() || ['queued','running'].includes(job?.status)" :loading="busy">启动环境任务</el-button></div>
      </form>
      <form class="cb-card cb-form" @submit.prevent="refreshJob">
        <div class="cb-form-row is-inline">
          <label>任务 ID（可重新查询）<input v-model="jobId" class="mono" aria-label="环境任务 ID" :readonly="['queued','running'].includes(job?.status)" /></label>
          <div class="cb-actions"><el-button native-type="submit" :disabled="!jobId || jobPolling" :loading="jobPolling">查询任务</el-button><el-button v-if="['queued','running'].includes(job?.status)" :disabled="busy" @click="cancelJob">停止此任务</el-button></div>
        </div>
        <template v-if="job">
          <div class="cb-job-meta"><span class="ix-pill" :data-tone="jobTone[job.status] || 'off'">{{ jobStatusText[job.status] || job.status }}</span><span>退出码 {{ job.exitCode ?? '—' }}</span><span v-if="job.truncated">输出已截断</span></div>
          <pre class="instance-job-output">{{ job.output || '暂无输出' }}</pre>
          <p class="cb-hint">任务结束不代表实例可用，请回到「概况」重新检查。断线后先按任务 ID 查询，不要直接重跑。</p>
        </template>
      </form>
    </template>
    <el-dialog v-model="dialogOpen" :title="({memory:'编辑子实例记忆',channel:'模型渠道',model:'模型参数',server:'MCP 连接',skill:'Skill 文档',file:'写入子实例文件'})[editor]" width="610px" class="admin-dialog instance-dialog instance-ui" append-to-body destroy-on-close :close-on-click-modal="false" :before-close="closeEditor">
      <p class="instance-note">目标：{{ instance.name }}</p><p v-if="error" role="alert" class="instance-error">{{ error }}</p>
      <pre v-if="editor === 'skill'" class="instance-route">{{ skillDetail?.content || skillDetail?.body || skillDetail?.description || '未提供文档正文' }}</pre>
      <form v-else-if="editor === 'file'" class="instance-form" @submit.prevent="saveFile"><p class="instance-note">仅写入 {{ fileInstall.kind === 'skills' ? 'Skills' : 'MCP' }} 的配置根目录；同名文件将被覆盖，不会删除其他文件。请勿把密码、私钥写入公开文档。Skill 写入后将重新加载。</p><label>相对路径<input v-model="fileInstall.path" :placeholder="fileInstall.kind === 'skills' ? 'my-skill/SKILL.md' : 'my-server/server.py'" required aria-label="安装文件相对路径" /></label><label>文件正文<textarea v-model="fileInstall.content" rows="10" required spellcheck="false" aria-label="安装文件正文" /></label><label class="instance-check"><input v-model="fileInstall.executable" type="checkbox" />可执行文件</label><label class="instance-check"><input v-model="fileInstall.confirmed" type="checkbox" />确认目标与路径，允许覆盖同名文件</label><div class="instance-form-footer"><el-button :disabled="busy" @click="dialogOpen = false; fileInstall.content = ''">取消</el-button><el-button type="primary" native-type="submit" :loading="busy" :disabled="busy || !fileInstall.confirmed">确认写入文件</el-button></div></form>
      <form v-else class="instance-form" autocomplete="off" @submit.prevent="saveEditor"><fieldset :disabled="busy">
        <div v-if="editor === 'memory'" class="instance-form-grid"><label class="span-all">标题<input v-model="memory.title" required aria-label="记忆标题" /></label><label>引用名<input v-model="memory.ref" aria-label="记忆引用" /></label><label>分组<input v-model="memory.grp" /></label><label class="span-all">备注<input v-model="memory.note" /></label><label class="span-all">正文<textarea v-model="memory.body" rows="8" aria-label="记忆正文" /></label><label class="instance-check"><input v-model="memory.enabled" type="checkbox" />启用注入</label><label class="instance-check"><input v-model="memory.expanded" type="checkbox" />提示词展开</label></div>
        <div v-else-if="editor === 'channel'" class="instance-form-grid"><label>渠道名<input v-model="channel.name" required aria-label="渠道名" /></label><label>协议<select v-model="channel.protocol" aria-label="渠道协议"><option value="chat">OpenAI Chat</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic</option></select></label><label class="span-all">API Base URL<input v-model="channel.baseUrl" required type="url" aria-label="渠道 API URL" /></label><label class="span-all">API Key<input v-model="channel.apiKey" type="password" autocomplete="new-password" :placeholder="editId ? '留空保留原 Key' : '请输入 Key'" aria-label="渠道 API Key" /></label><label v-if="!editId" class="span-all">模型 ID（每行一个）<textarea v-model="channel.modelIds" required rows="3" aria-label="渠道模型 ID" /></label><label class="instance-check"><input v-model="channel.enabled" type="checkbox" />启用渠道</label></div>
        <div v-else-if="editor === 'model'" class="instance-form-grid"><label class="span-all">模型 ID<input v-model="model.id" required aria-label="模型 ID" /></label><label class="span-all">显示名<input v-model="model.name" aria-label="模型显示名" /></label><label>上下文窗口<input v-model.number="model.contextWindow" type="number" min="1" required /></label><label>最大输出<input v-model.number="model.maxTokens" type="number" min="1" required /></label><label class="instance-check"><input v-model="model.reasoning" type="checkbox" />推理模型</label><label class="instance-check"><input v-model="model.image" type="checkbox" />支持图像</label></div>
        <div v-else-if="editor === 'server'" class="instance-form-grid"><p class="instance-note span-all">现有命令、环境值和请求头不回显。编辑时留空保留，其他服务器不受影响。保存会重新连接 MCP。</p><label>名称<input v-model="server.name" required :readonly="!!editId" aria-label="MCP 名称" /></label><label>传输<select v-model="server.transport" aria-label="MCP 传输"><option value="stdio">本地进程 stdio</option><option value="streamable_http">Streamable HTTP</option></select></label><template v-if="server.transport === 'stdio'"><label class="span-all">可执行命令<input v-model="server.command" :required="!editId" aria-label="MCP 命令" /></label><label class="span-all">参数（每行一个）<textarea v-model="server.args" rows="3" aria-label="MCP 参数" /></label><label class="span-all">工作目录<input v-model="server.cwd" /></label><label>环境变量名<input v-model="server.envName" aria-label="MCP 环境变量名" /></label><label>环境变量值<input v-model="server.envValue" type="password" autocomplete="new-password" aria-label="MCP 环境变量值" /></label></template><template v-else><label class="span-all">服务 URL<input v-model="server.url" type="url" :required="!editId" aria-label="MCP URL" /></label><label>请求头名<input v-model="server.headerName" aria-label="MCP 请求头名" /></label><label>请求头值<input v-model="server.headerValue" type="password" autocomplete="new-password" aria-label="MCP 请求头值" /></label></template><label>调用审批<select v-model="server.approval"><option value="ask">询问</option><option value="deny">拒绝</option><option value="allow">允许</option></select></label></div>
      </fieldset><div class="instance-form-footer"><el-button :disabled="busy" @click="dialogOpen = false; channel.apiKey = ''; server.envValue = ''; server.headerValue = ''">取消</el-button><el-button type="primary" native-type="submit" :loading="busy">保存到子实例{{ editor === 'server' ? '并连接' : '' }}</el-button></div></form>
    </el-dialog>
  </section>
</template>

<style scoped>
.child-mcp-tools { max-height: 420px; overflow-y: auto; overflow-x: hidden; }
.child-mcp-tool { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 8px 0; }
.child-mcp-tool > div { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.child-mcp-tool p { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; }
.child-mcp-tool :deep(.el-switch) { flex: none; min-height: 44px; }
@media (max-width: 767px) { .child-mcp-tools { max-height: 45vh; } }
</style>
