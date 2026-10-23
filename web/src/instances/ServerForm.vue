<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { Api } from '../api.js';
import { ok, safeError } from './instanceHelpers.js';

const props = defineProps({server: {type: Object, default: null}});
const emit = defineEmits(['saved', 'cancel']);
const editing = props.server;
const form = reactive({name: editing?.name || '', host: editing?.host || '', port: editing?.port || 22, username: editing?.username || 'root',
  auth: editing ? (editing.auth === 'upload' ? 'upload' : editing.auth) : 'key', password: '', privateKey: '', saveKey: true});
const keys = ref([]), keyChoice = ref(''), passField = ref(''), fileName = ref('');
const busy = ref(false), testing = ref(false), error = ref(''), testResult = ref(null);
defineExpose({busy});

const usable = computed(() => keys.value.filter(k => k.usable && !k.likelyTls));
const tls = computed(() => keys.value.filter(k => k.usable && k.likelyTls));
const unusable = computed(() => keys.value.filter(k => !k.usable));
const groups = computed(() => {
  const out = {};
  for (const key of usable.value) (out[key.secret] ||= []).push(key);
  return out;
});
const selected = computed(() => keys.value.find(k => keyId(k) === keyChoice.value));
const keyId = key => `${key.secret}\u0000${key.field}`;
const keyLabel = key => [key.field, key.type, key.encrypted ? '有密码' : ''].filter(Boolean).join(' · ');
const reason = key => ({putty_format: 'PuTTY 格式，需先转成 OpenSSH 格式', unsupported_key: '无法解析'})[key.reason] || '无法使用';

async function loadKeys() {
  try {
    keys.value = ok(await Api.instanceSshKeys()).items || [];
    const preferred = usable.value[0] || tls.value[0];
    if (!keyChoice.value && preferred) choose(keyId(preferred));
  } catch (e) { error.value = safeError(e); }
}
function choose(value) {
  keyChoice.value = value;
  passField.value = selected.value?.suggestedPassphraseField || selected.value?.passphraseFields?.[0] || '';
}
async function readKey(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  form.privateKey = ''; fileName.value = '';
  if (!file) return;
  if (file.size > 32768) { error.value = '私钥文件不能超过 32 KiB。'; return; }
  form.privateKey = await file.text();
  fileName.value = file.name;
}
function credentials() {
  if (form.auth === 'key') {
    const key = selected.value;
    if (!key) return {keyRef: null};
    return {keyRef: {secret: key.secret, field: key.field, ...(key.encrypted && passField.value ? {passphraseField: passField.value} : {})}};
  }
  if (form.auth === 'password') return form.password ? {password: form.password} : {};
  return form.privateKey ? {privateKey: form.privateKey, saveKey: form.saveKey} : {};
}
function payload() {
  return {name: form.name.trim(), host: form.host.trim(), port: Number(form.port), username: form.username.trim(), auth: form.auth, ...credentials()};
}
async function test() {
  if (testing.value) return;
  error.value = ''; testResult.value = null; testing.value = true;
  try { testResult.value = ok(await Api.testInstanceServer(payload())); }
  catch (e) { testResult.value = {failed: safeError(e)}; }
  finally { testing.value = false; }
}
async function save() {
  if (busy.value) return;
  error.value = '';
  const body = payload();
  if (editing && form.auth === editing.auth && !Object.keys(credentials()).some(k => body[k])) {
    for (const k of ['password', 'privateKey', 'keyRef', 'saveKey']) delete body[k];
  }
  busy.value = true;
  try {
    const result = ok(await (editing ? Api.updateInstanceServer(editing.id, body) : Api.createInstanceServer(body)));
    form.password = ''; form.privateKey = '';
    emit('saved', result.item);
  } catch (e) { error.value = safeError(e); }
  finally { busy.value = false; }
}
onMounted(loadKeys);
onBeforeUnmount(() => { form.password = ''; form.privateKey = ''; });
</script>
<template>
  <form class="instance-form" autocomplete="off" @submit.prevent="save">
    <div class="ob-fields" :class="{busy}">
      <label class="ob-field"><span>名称</span><input v-model="form.name" required maxlength="60" placeholder="例如：东京服务器" aria-label="服务器名称" /></label>
      <div class="ob-field"><span>地址</span>
        <div class="ob-ctl">
          <div class="ob-inline"><input v-model="form.host" required class="mono" placeholder="IP 或域名" aria-label="服务器地址" /><input v-model.number="form.port" class="mono ob-port" type="number" inputmode="numeric" min="1" max="65535" required aria-label="SSH 端口" /></div>
          <small>主控通过这个地址连接服务器，可以是公网 IP，也可以是 WG 等内网地址。</small>
        </div>
      </div>
      <label class="ob-field"><span>用户</span><input v-model="form.username" required class="mono" aria-label="SSH 用户" /></label>
      <div class="ob-field"><span>认证</span>
        <div class="ob-ctl">
          <div class="ob-radios" role="radiogroup" aria-label="认证方式">
            <label><input v-model="form.auth" type="radio" value="key" />密钥库中的私钥</label>
            <label><input v-model="form.auth" type="radio" value="password" />密码</label>
            <label><input v-model="form.auth" type="radio" value="upload" />上传私钥</label>
          </div>
          <template v-if="form.auth === 'key'">
            <select :value="keyChoice" aria-label="密钥库中的 SSH 私钥" @change="choose($event.target.value)">
              <option v-if="!keys.length" value="" disabled>密钥库中没有找到 SSH 私钥</option>
              <optgroup v-for="(items, secret) in groups" :key="secret" :label="secret">
                <option v-for="key in items" :key="keyId(key)" :value="keyId(key)">{{ keyLabel(key) }}</option>
              </optgroup>
              <optgroup v-if="tls.length" label="可能不是 SSH 私钥">
                <option v-for="key in tls" :key="keyId(key)" :value="keyId(key)">{{ key.secret }} · {{ keyLabel(key) }} · 同一凭证里有证书，像是网站 HTTPS 私钥</option>
              </optgroup>
              <optgroup v-if="unusable.length" label="无法使用">
                <option v-for="key in unusable" :key="keyId(key)" :value="keyId(key)" disabled>{{ key.secret }} · {{ key.field }} · {{ reason(key) }}</option>
              </optgroup>
            </select>
            <small v-if="editing && editing.auth === 'key' && !keyChoice">当前：{{ editing.keyLabel }}</small>
            <small v-if="selected?.fingerprint" class="mono">指纹 {{ selected.type }} · {{ selected.fingerprint }}{{ selected.comment ? ' · ' + selected.comment : '' }}</small>
            <div v-if="selected?.encrypted" class="ob-inline">
              <select v-model="passField" aria-label="私钥密码所在字段">
                <option v-for="name in selected.passphraseFields" :key="name" :value="name">{{ name }}</option>
              </select>
              <small :class="selected.suggestedPassphraseField === passField ? 'ob-ok' : ''">{{ selected.suggestedPassphraseField === passField ? '✓ 这个字段能解开私钥' : '私钥密码所在字段，保存时验证' }}</small>
            </div>
          </template>
          <input v-else-if="form.auth === 'password'" v-model="form.password" type="password" autocomplete="new-password" maxlength="8192" :placeholder="editing?.auth === 'password' ? '已保存，留空保留' : 'SSH 密码'" aria-label="SSH 密码" />
          <template v-else>
            <input type="file" aria-label="私钥文件" @change="readKey" />
            <small v-if="fileName">已选：{{ fileName }}</small>
            <label class="ob-check"><input v-model="form.saveKey" type="checkbox" />同时保存到密钥库，其他服务器可以直接选</label>
          </template>
        </div>
      </div>
      <div class="ob-field"><span></span>
        <div class="ob-inline">
          <el-button :loading="testing" :disabled="busy" @click="test">测试连接</el-button>
          <small v-if="testResult?.failed" class="ob-bad">✗ {{ testResult.failed }}</small>
          <small v-else-if="testResult" class="ob-ok">✓ 连接成功{{ testResult.os ? ' · ' + testResult.os : '' }}{{ testResult.docker ? ' · Docker ' + testResult.docker : ' · 未安装 Docker' }}{{ testResult.publicIp ? ' · 外网 IP ' + testResult.publicIp : '' }}</small>
        </div>
      </div>
    </div>
    <p v-if="error" role="alert" class="instance-error">{{ error }}</p>
    <div class="instance-form-footer">
      <span class="ob-hint">保存前会自动测试一次；没有 Docker 时，部署会先安装。</span>
      <el-button :disabled="busy" @click="emit('cancel')">取消</el-button>
      <el-button type="primary" native-type="submit" :loading="busy">保存</el-button>
    </div>
  </form>
</template>
