<script setup>
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {Api, apiError} from '../api.js';
import {mobileSelectOptions} from '../mobileSelect.js';
import AdaptiveMdEditor from './AdaptiveMdEditor.vue';
import PromptTemplateEditor from './PromptTemplateEditor.vue';
import {normalizePromptPolicy, promptToolGroups} from './promptPolicy.js';

const props = defineProps({
  modelValue: {type: Object, default: () => ({})},
  inheritedPolicy: {type: Object, default: () => ({})},
  inheritedSourcePath: {type: String, default: ''},
  disabled: Boolean,
  folderId: String,
  conversationId: String,
});
const emit = defineEmits(['update:modelValue']);
const local = computed(() => normalizePromptPolicy(props.modelValue));
const inherited = computed(() => normalizePromptPolicy(props.inheritedPolicy));
const inherits = computed(() => !local.value.text.trim());
const displayed = computed(() => inherits.value ? inherited.value : local.value);
const flagsDisabled = computed(() => props.disabled || inherits.value);
function patch(field, value) {
  if (props.disabled || (field !== 'text' && inherits.value)) return;
  emit('update:modelValue', {...local.value, [field]: value});
}
const tools = ref([]), toolsLoading = ref(false), toolsError = ref('');
const groups = computed(() => promptToolGroups(tools.value, displayed.value.toolNames));
let alive = true;
async function loadTools() {
  if (toolsLoading.value) return;
  toolsLoading.value = true; toolsError.value = '';
  try {
    const data = await Api.promptTools();
    if (alive) tools.value = data.items || [];
  } catch (error) { if (alive) toolsError.value = apiError(error); }
  finally { if (alive) toolsLoading.value = false; }
}
onMounted(loadTools);
const preview = ref(''), previewError = ref(''), previewLoading = ref(false), previewReady = ref(false);
let previewGeneration = 0;
const previewInput = computed(() => JSON.stringify({
  ...(props.conversationId ? {conversationId: props.conversationId} : {folderId: props.folderId}),
  ...local.value,
}));
watch(previewInput, () => { previewGeneration++; preview.value = ''; previewError.value = ''; previewReady.value = false; previewLoading.value = false; }, {flush: 'sync'});
async function runPreview() {
  if (props.disabled || inherits.value || !local.value.overrideSystemPrompt || previewLoading.value) return;
  const generation = ++previewGeneration;
  previewLoading.value = true; previewError.value = ''; previewReady.value = false;
  try {
    const result = await Api.previewPromptTemplate(JSON.parse(previewInput.value));
    if (alive && generation === previewGeneration) { preview.value = result.prompt || ''; previewReady.value = true; }
  } catch (error) {
    if (alive && generation === previewGeneration) previewError.value = error?.response?.data?.message || apiError(error);
  } finally { if (alive && generation === previewGeneration) previewLoading.value = false; }
}
onBeforeUnmount(() => { alive = false; previewGeneration++; });
</script>

<template>
  <div class="prompt-policy-editor">
    <div class="prompt-policy-heading">
      <span>本地提示词 <small>留空继承</small></span>
      <el-checkbox :model-value="displayed.overrideSystemPrompt" :disabled="flagsDisabled" @update:model-value="patch('overrideSystemPrompt', $event)">覆盖系统提示词</el-checkbox>
    </div>
    <!-- Do not wrap Monaco in a label: it owns its hidden IME textarea focus. -->
    <div class="folder-prompt-editor">
      <PromptTemplateEditor v-if="displayed.overrideSystemPrompt" :model-value="local.text" :read-only="disabled" @update:model-value="patch('text', $event)" />
      <AdaptiveMdEditor v-else :model-value="local.text" :read-only="disabled" language="markdown" completion-mode="none" @update:model-value="patch('text', $event)" />
    </div>
    <template v-if="displayed.overrideSystemPrompt">
      <div class="prompt-policy-tools">
        <el-checkbox :model-value="displayed.toolsEnabled" :disabled="flagsDisabled" @update:model-value="patch('toolsEnabled', $event)">使用工具</el-checkbox>
        <el-select :model-value="displayed.toolNames" :disabled="flagsDisabled || !displayed.toolsEnabled" :loading="toolsLoading" :popper-options="mobileSelectOptions()" multiple filterable collapse-tags collapse-tags-tooltip placeholder="选择允许使用的工具" aria-label="允许使用的工具" @update:model-value="patch('toolNames', $event)">
          <el-option-group v-for="group in groups" :key="group.label" :label="group.label">
            <el-option v-for="tool in group.items" :key="tool.name" :value="tool.name" :label="tool.name + (tool.unavailable ? '（不可用）' : '')" :title="tool.description" />
          </el-option-group>
        </el-select>
      </div>
      <p v-if="toolsError" class="prompt-policy-error" role="alert">工具列表读取失败：{{ toolsError }}。已选工具保留。<el-button text :loading="toolsLoading" @click="loadTools">重试</el-button></p>
      <el-checkbox :model-value="displayed.userMessageTemplateEnabled" :disabled="flagsDisabled" @update:model-value="patch('userMessageTemplateEnabled', $event)">注入用户消息模板</el-checkbox>
      <div v-if="!inherits" class="prompt-policy-preview-action"><el-button :disabled="disabled" :loading="previewLoading" @click="runPreview">预览模板正文</el-button></div>
      <p v-if="previewError" class="prompt-policy-error" role="alert">{{ previewError }}</p>
      <pre v-if="previewReady" class="prompt-policy-preview" aria-label="模板渲染预览">{{ preview || '（渲染结果为空）' }}</pre>
    </template>
  </div>
</template>

<style scoped>
.prompt-policy-editor { display:flex; flex-direction:column; gap:10px; min-width:0; }
.prompt-policy-heading { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; align-items:center; }
.prompt-policy-heading small { display:block; color:var(--el-text-color-secondary); font-size:12px; }
.prompt-policy-tools { display:flex; align-items:center; gap:12px; }
.prompt-policy-tools .el-select { flex:1; min-width:0; }
.prompt-policy-preview-action { margin:0; font-size:12px; line-height:1.65; color:var(--el-text-color-secondary); }
.prompt-policy-preview-action { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.prompt-policy-preview { margin:8px 0 0; padding:10px; max-height:260px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--el-fill-color-light); border-radius:7px; font:12px/1.65 monospace; }
.prompt-policy-error { margin:0; color:var(--el-color-danger); font-size:12px; white-space:pre-wrap; }
@media (max-width:760px) { .prompt-policy-tools { flex-wrap:wrap; gap:6px; } .prompt-policy-tools .el-select { flex-basis:100%; } }
</style>
