<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { Api } from '../api.js';
import ServerSelect from './ServerSelect.vue';
import { generatePassword, ok, passwordHint, safeError } from './instanceHelpers.js';

const props = defineProps({servers: {type: Array, required: true}});
const emit = defineEmits(['created', 'cancel', 'servers-changed']);
const form = reactive({name: '', username: '', password: generatePassword(), serverId: 'local',
  modelMode: 'copy', primary: '', port: '', workspacePath: '', image: '', managementUrl: ''});
const models = ref({primary: '', providers: []}), busy = ref(false), error = ref('');
defineExpose({busy});
const choices = computed(() => models.value.providers.flatMap(p => p.models.map(m => `${p.name}/${m}`)));
const slug = computed(() => form.username.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || '账号');

onMounted(async () => {
  try {
    models.value = ok(await Api.instanceModelOptions());
    form.primary = models.value.primary || choices.value[0] || '';
    if (!choices.value.length) form.modelMode = 'later';
  } catch { form.modelMode = 'later'; }
});
onBeforeUnmount(() => { form.password = ''; });

async function submit() {
  if (busy.value) return;
  error.value = '';
  const body = {name: form.name.trim(), serverId: form.serverId,
    account: {username: form.username.trim(), password: form.password},
    models: form.modelMode === 'copy' ? {mode: 'copy', primary: form.primary} : {mode: 'later'}};
  if (form.port) body.port = Number(form.port);
  if (form.workspacePath.trim()) body.workspacePath = form.workspacePath.trim();
  if (form.image.trim()) body.image = form.image.trim();
  if (form.managementUrl.trim()) body.managementUrl = form.managementUrl.trim();
  busy.value = true;
  try {
    const result = ok(await Api.createInstance(body));
    emit('created', {...result, password: form.password});
  } catch (e) { error.value = safeError(e); }
  finally { busy.value = false; }
}
</script>
<template>
  <form class="instance-form" autocomplete="off" @submit.prevent="submit">
    <div class="ob-fields">
      <label class="ob-field"><span>名称</span><input v-model="form.name" required maxlength="120" placeholder="例如：家里的电脑" aria-label="实例名称" /></label>
      <label class="ob-field"><span>登录账号</span><input v-model="form.username" required maxlength="128" autocapitalize="off" aria-label="登录账号" /></label>
      <div class="ob-field"><span>密码</span>
        <div class="ob-ctl">
          <div class="ob-inline"><input v-model="form.password" required maxlength="1024" class="mono" aria-label="登录密码" /><el-button @click="form.password = generatePassword()">重新生成</el-button></div>
          <small v-if="passwordHint(form.password)" class="ob-warn">{{ passwordHint(form.password) }}</small>
          <small>已自动生成，也可以改成自己的；创建后会再显示一次方便复制。</small>
        </div>
      </div>
      <div class="ob-field"><span>运行位置</span>
        <div class="ob-ctl"><ServerSelect v-model="form.serverId" :servers="servers" @added="emit('servers-changed')" /></div>
      </div>
      <div class="ob-field"><span>模型</span>
        <div class="ob-ctl">
          <div class="ob-radios" role="radiogroup" aria-label="模型">
            <label><input v-model="form.modelMode" type="radio" value="copy" :disabled="!choices.length" />使用主控的模型</label>
            <label><input v-model="form.modelMode" type="radio" value="later" />稍后在实例里设置</label>
          </div>
          <div v-if="form.modelMode === 'copy'" class="ob-sub">
            <select v-model="form.primary" aria-label="默认模型"><option v-for="choice in choices" :key="choice" :value="choice">{{ choice === models.primary ? '默认：' + choice : choice }}</option></select>
            <small>复制主控已启用的 {{ models.providers.length }} 个渠道（含 API Key）到这个实例。</small>
          </div>
        </div>
      </div>
      <details class="ob-adv">
        <summary>高级（端口、数据目录、镜像、实例地址）</summary>
        <label class="ob-field"><span>端口</span><input v-model="form.port" class="mono" type="number" inputmode="numeric" min="1" max="65535" placeholder="自动：从 18970 起选一个可用端口" aria-label="实例端口" /></label>
        <label class="ob-field"><span>数据目录</span><input v-model="form.workspacePath" class="mono" :placeholder="`自动：/opt/openbear/instances/${slug}`" aria-label="数据目录" /></label>
        <label class="ob-field"><span>镜像</span><input v-model="form.image" class="mono" placeholder="自动：与主控同版本（在目标上构建）" aria-label="镜像" /></label>
        <div class="ob-field"><span>实例地址</span>
          <div class="ob-ctl"><input v-model="form.managementUrl" class="mono" placeholder="自动：服务器地址 + 端口" aria-label="实例地址" /><small>主控和网关访问这个实例用的地址。只有需要走特定网络（例如 WG 地址）时才填写。</small></div>
        </div>
      </details>
    </div>
    <p v-if="error" role="alert" class="instance-error">{{ error }}</p>
    <div class="instance-form-footer">
      <span class="ob-hint">将在「实例部署」目录新建部署会话，由主控默认模型执行。</span>
      <el-button :disabled="busy" @click="emit('cancel')">取消</el-button>
      <el-button type="primary" native-type="submit" :loading="busy">创建并部署</el-button>
    </div>
  </form>
</template>
