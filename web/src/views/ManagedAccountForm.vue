<script setup>
import { onBeforeUnmount, reactive, ref } from 'vue';
import { Api } from '../api.js';
import { authMode } from '../authMode.js';
import { endPageSession } from '../sessionBoundary.js';
import { retireGatewayPush } from '../pwa/pushClient.js';
import { passwordHint } from '../instances/instanceHelpers.js';
const fields = reactive({username: '', currentPassword: '', password: '', confirmation: ''});
const busy = ref(false), error = ref('');
let alive = true;
function clearPasswords() { fields.currentPassword = ''; fields.password = ''; fields.confirmation = ''; }
onBeforeUnmount(() => { alive = false; clearPasswords(); });
async function save() {
  if (!['managed', 'gateway'].includes(authMode.value) || busy.value) return;
  error.value = '';
  // The gateway accepts any non-empty password; local accounts keep their rule.
  const minimum = authMode.value === 'gateway' ? 1 : 12;
  if (fields.password.length < minimum || fields.password.length > 1024) { error.value = minimum > 1 ? `新密码需要 ${minimum}–1024 个字符。` : '请输入新密码。'; return; }
  if (fields.password !== fields.confirmation) { error.value = '两次输入的新密码不一致。'; return; }
  if (!fields.currentPassword) { error.value = '请填写当前密码。'; return; }
  busy.value = true;
  try {
    await retireGatewayPush();
    const result = await Api.changePassword({currentPassword: fields.currentPassword, password: fields.password, ...(fields.username.trim() ? {username: fields.username.trim()} : {})});
    if (result?.ok !== true) throw new Error('change_failed');
    if (alive) { endPageSession({broadcast: true}); window.location.replace('/login'); }
  } catch (e) {
    if (alive) error.value = e?.response?.status === 429 ? '尝试过于频繁，请稍后重试。' : e?.response?.status === 403 ? '当前密码未通过验证，请重新输入。' : '账号密码未确认修改成功，请检查连接后重新登录核实。';
  } finally { clearPasswords(); busy.value = false; }
}
</script>
<template>
  <details v-if="authMode === 'managed' || authMode === 'gateway'" class="managed-account">
    <summary>修改账号与密码</summary>
    <form autocomplete="off" @submit.prevent="save">
      <p>{{ authMode === 'gateway' ? '修改登录账号；账号在所有实例间唯一。' : '仅管理此实例的本地账号。' }}保存成功将撤销所有浏览器登录（包括本机），需用新密码重新登录；不会删除聊天或业务数据。</p>
      <div class="managed-account-fields">
        <label>新用户名（留空保持原值）<input v-model="fields.username" maxlength="128" autocomplete="off" :disabled="busy" aria-label="新用户名" /></label>
        <label>当前密码<input v-model="fields.currentPassword" type="password" maxlength="1024" autocomplete="current-password" required :disabled="busy" aria-label="当前密码" /></label>
        <label>新密码<input v-model="fields.password" type="password" :minlength="authMode === 'gateway' ? 1 : 12" maxlength="1024" autocomplete="new-password" required :disabled="busy" aria-label="新密码" :placeholder="authMode === 'gateway' ? '' : '至少 12 个字符'" /><small v-if="authMode === 'gateway' && passwordHint(fields.password)" class="managed-account-hint">{{ passwordHint(fields.password) }}</small></label>
        <label>再次输入新密码<input v-model="fields.confirmation" type="password" :minlength="authMode === 'gateway' ? 1 : 12" maxlength="1024" autocomplete="new-password" required :disabled="busy" aria-label="确认新密码" /></label>
      </div>
      <p v-if="error" role="alert" class="managed-account-error">{{ error }}</p>
      <el-button native-type="submit" :loading="busy" :disabled="busy || !fields.currentPassword || !fields.password || !fields.confirmation">修改并退出所有设备</el-button>
    </form>
  </details>
</template>
<style scoped>
.managed-account { margin-bottom: 16px; border-bottom: 1px solid var(--ob-chat-line); color: var(--ob-chat-text); padding: 0 0 12px; }
.managed-account summary { font-size: 13px; font-weight: 500; min-height: 38px; padding: 6px 0; cursor: pointer; }
.managed-account form { display: grid; gap: 12px; }
.managed-account p { color: var(--ob-chat-subtle); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.managed-account-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.managed-account label { display: grid; min-width: 0; gap: 5px; font-size: 12px; }
.managed-account input { width: 100%; min-width: 0; border: 1px solid var(--ob-chat-line); border-radius: 6px; padding: 7px 9px; background: var(--ob-chat-panel); color: inherit; }
.managed-account input:focus-visible { outline: 2px solid var(--ob-focus); outline-offset: 1px; }
.managed-account .managed-account-error { color: var(--ob-danger); }
.managed-account .managed-account-hint { color: #b45309; font-size: 12px; font-weight: 400; }
.managed-account .el-button { justify-self: start; font-size: 12px; }
@media (max-width: 760px) { .managed-account-fields { grid-template-columns: minmax(0, 1fr); } .managed-account input { font-size: 16px; } }
</style>
