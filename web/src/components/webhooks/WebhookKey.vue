<script setup>
import {nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {Copy, Eye, EyeOff, RefreshCw} from '@lucide/vue';
import {Api} from '../../api.js';

const props = defineProps({endpointId: String, revision: Number, busy: Boolean});
defineEmits(['rotate']);
// Keep plaintext local to the visible connection panel, never in editor drafts,
// parent emissions, persistence or an API cache. Reopening reads it again.
const key = ref(''), hidden = ref(true), loading = ref(false), error = ref('');
const reason = ref(''), notice = ref(''), input = ref(null);
let generation = 0, abort, disposed = false;
async function load() {
  const current = ++generation; abort?.abort(); abort = new AbortController();
  key.value = ''; hidden.value = true; error.value = ''; reason.value = ''; notice.value = '';
  loading.value = Boolean(props.endpointId);
  if (!props.endpointId || disposed) return;
  try {
    const data = await Api.webhookKey(props.endpointId, {signal: abort.signal});
    if (disposed || current !== generation) return;
    if (data.credential?.recoverable && data.credential.key) key.value = data.credential.key;
    else reason.value = data.credential?.unavailableReason || 'no_active_credential';
  } catch (exception) {
    if (disposed || current !== generation) return;
    error.value = exception?.response?.data?.code === 'credential_unavailable'
      ? 'Key 无法解密，请检查本机运行秘密是否变更；不会自动轮换。'
      : 'Key 读取失败，请重试。';
  } finally { if (!disposed && current === generation) loading.value = false; }
}
async function copyKey() {
  if (!key.value || props.busy) return;
  const current = generation;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    // Copy the original even when the eye has temporarily hidden the input.
    await navigator.clipboard.writeText(key.value);
    if (!disposed && current === generation) notice.value = '已复制 Key';
  } catch {
    if (disposed || current !== generation) return;
    notice.value = '复制失败，请选中 Key 手动复制'; hidden.value = false;
    await nextTick(); input.value?.select?.();
  }
}
watch([() => props.endpointId, () => props.revision], load, {immediate: true});
onBeforeUnmount(() => { disposed = true; generation++; abort?.abort(); key.value = ''; });
</script>
<template>
  <div class="wh-field wh-copy-row wh-key">
    <label>Bearer Key:</label>
    <input v-if="key" ref="input" type="text" :value="hidden ? key.slice(0, 8) + '***********' : key" readonly autocomplete="off" spellcheck="false" aria-label="Bearer Key" @focus="$event.target.select()" />
    <span v-else class="wh-key-placeholder" :class="{'wh-error-text': error}" role="status" :title="error || (reason === 'legacy_not_recoverable' ? '旧 Key 无法恢复，现有 Key 仍可使用；点击刷新图标手动轮换。' : '')">{{ loading ? '正在读取…' : !endpointId ? '启用后自动生成密钥' : error ? '读取失败' : reason === 'legacy_not_recoverable' ? '旧密钥，请刷新' : '暂无密钥' }}</span>
    <template v-if="endpointId">
    <button type="button" class="wh-key-icon" :disabled="!key" :title="hidden ? '显示 Key' : '隐藏 Key'" :aria-label="hidden ? '显示 Key' : '隐藏 Key'" :aria-pressed="hidden" @click="hidden = !hidden"><Eye v-if="hidden" :size="16" aria-hidden="true" /><EyeOff v-else :size="16" aria-hidden="true" /></button>
    <button type="button" class="wh-key-icon" :class="{'is-copied': notice === '已复制 Key'}" :disabled="!key || busy" :title="notice || '复制 Key'" aria-label="复制 Key" @click="copyKey"><Copy :size="16" aria-hidden="true" /></button>
    <button type="button" class="wh-key-icon" :disabled="busy || loading" :title="error ? '重新读取密钥' : '刷新密钥'" :aria-label="error ? '重新读取密钥' : '刷新密钥'" @click="error ? load() : $emit('rotate')"><RefreshCw :size="16" aria-hidden="true" /></button>
    </template>
    <span v-if="notice" class="wh-key-feedback" role="status">{{ notice }}</span>
  </div>
</template>
<style scoped>
.wh-field.wh-key {position:relative;flex-direction:row;align-items:center;flex-wrap:nowrap;gap:6px;}
.wh-key>label {flex:none;white-space:nowrap;margin-right:4px;font-size:13px;font-weight:550;}
.wh-key input {flex:1;min-width:0;width:0;border:0;background:transparent;padding:0;box-shadow:none;}
.wh-key-placeholder {flex:1;min-width:0;color:var(--ob-text-subtle);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.wh-key-feedback {position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;}
.wh-key-icon.is-copied {color:var(--ob-success,var(--el-color-success));}
.wh-key-icon {display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:32px;border-radius:6px;color:var(--ob-text-subtle);background:transparent;}
.wh-key-icon:hover:not(:disabled) {background:var(--ob-hover);color:var(--ob-text);}
.wh-key-icon:disabled {opacity:.4;cursor:default;}
@media(max-width:760px) {.wh-field.wh-key {gap:4px;}.wh-key-icon {width:32px;height:40px;}.wh-key>label {font-size:12px;margin-right:0;}}
</style>
