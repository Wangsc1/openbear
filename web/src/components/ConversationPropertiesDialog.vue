<script setup>
import {computed, inject, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {ElMessage, ElMessageBox} from 'element-plus';
import {Api, apiError} from '../api.js';
import AdaptiveMdEditor from './AdaptiveMdEditor.vue';
import ModelSettings from './ModelSettings.vue';
import {updateRunDefault} from './folderRunDefaults.js';
import WebhookEditor from './webhooks/WebhookEditor.vue';
import WebhookField from './webhooks/WebhookField.vue';
import {tabKey} from './webhooks/webhookConfig.js';
import {runConfigFromResponse} from '../views/consoleView/runConfigState.js';
import './conversationTreeProperties.css';
const props = defineProps({modelValue: Boolean, conversation: Object, initialTab: {type: String, default:'context'}});
const emit = defineEmits(['update:modelValue','persist']);
const saveRunConfig = inject('openbear:property-run-config', (_uuid, request) => request());
const tab = ref('context'), loading = ref(false), saving = ref(false), error = ref('');
const contextReady = ref(false), modelReady = ref(false), modelsReady = ref(false), modelsLoading = ref(false);
const modelError = ref(''), modelsError = ref('');
const context = ref({contextMode:'inherit',contextText:''}), baseline = ref(''), model = ref({}), models = ref([]), modelSaving = ref(false);
const trigger = ref(null), triggerVisited = ref(false);
const uuid = computed(() => props.conversation?.conversationUuid || '');
const local = computed(() => !uuid.value || uuid.value.startsWith('local:'));
const dirtyContext = computed(() => contextReady.value && JSON.stringify({contextMode:context.value.contextMode,contextText:context.value.contextText}) !== baseline.value);
const busy = computed(() => saving.value || modelSaving.value || trigger.value?.saving);
const canSaveContext = computed(() => props.modelValue && !local.value && contextReady.value && !busy.value && dirtyContext.value);
const canEditModel = computed(() => props.modelValue && !local.value && modelReady.value && modelsReady.value && !loading.value && !modelsLoading.value && !busy.value);
const contextEditorText = computed({
  get: () => context.value.contextMode === 'inherit' ? context.value.inheritedContext || '' : context.value.contextText || '',
  set: value => { if (contextReady.value && context.value.contextMode === 'override') context.value.contextText = value; },
});
const modelSettings = computed(() => ({mainModel:model.value.model,mainThinkingLevel:model.value.thinkingLevel || model.value.effectiveThinkingLevel || model.value.defaultThinkingLevel || 'off',mainFastMode:model.value.fastRequested ?? model.value.fastMode,
  agentModel:model.value.agentRunConfig?.model || '',agentThinkLevel:model.value.agentRunConfig?.thinkLevel || '',agentFastMode:model.value.agentRunConfig?.fastMode ?? null,contextStrategy:model.value.contextStrategy || 'sliding_window'}));
function changeModelSetting(field,selection) {
  const value = updateRunDefault({},field,selection)[field];
  const main = {mainModel:'model',mainThinkingLevel:'thinking',mainFastMode:'fast',contextStrategy:'strategy'};
  return main[field] ? mutate(main[field],value) : mutate('agent',{[({agentModel:'model',agentThinkLevel:'thinkLevel',agentFastMode:'fastMode'})[field]]:value});
}
const tabs = [['context','上下文配置'],['model','模型配置'],['trigger','触发器']];
let generation = 0;
async function load() {
  const run = ++generation;
  error.value = ''; modelError.value = ''; modelsError.value = '';
  loading.value = false; modelsLoading.value = false; saving.value = false; modelSaving.value = false;
  contextReady.value = false; modelReady.value = false; modelsReady.value = false;
  context.value = {contextMode:'inherit',contextText:''}; baseline.value = JSON.stringify(context.value); model.value = {}; models.value = [];
  if (!props.modelValue || local.value) return;
  // Each reader publishes its own result; a slow/failed model catalog must not
  // hold the context editor (or the trigger tab) behind a shared loading mask.
  await Promise.all([loadProperties(run),loadModels(run)]);
}
async function loadProperties(run = generation, refreshContext = true) {
  if (!props.modelValue || local.value || loading.value || busy.value || (refreshContext && dirtyContext.value)) return;
  const id = uuid.value;
  loading.value = true; modelError.value = ''; modelReady.value = false;
  if (refreshContext) { contextReady.value = false; error.value = ''; }
  try {
    const response = await Api.conversationProperties(id);
    if (run !== generation || !props.modelValue) return;
    if (refreshContext) {
      const properties = response.properties;
      if (!properties || !['inherit','override'].includes(properties.contextMode) || typeof properties.contextText !== 'string') {
        error.value = '未取得完整上下文，未开放编辑';
      } else {
        context.value = properties; baseline.value = JSON.stringify({contextMode:properties.contextMode,contextText:properties.contextText});
        contextReady.value = true;
      }
    }
    const snapshot = runConfigFromResponse(response,id);
    if (snapshot) { model.value = snapshot; modelReady.value = true; }
    else modelError.value = '未取得完整模型配置，未开放编辑';
  } catch (exception) {
    if (run === generation) { if (refreshContext) error.value = apiError(exception); modelError.value = apiError(exception); }
  } finally { if (run === generation) loading.value = false; }
}
async function loadModels(run = generation) {
  if (!props.modelValue || local.value || modelsLoading.value) return;
  modelsLoading.value = true; modelsReady.value = false; modelsError.value = '';
  try {
    const options = await Api.rathOptions();
    if (run !== generation || !props.modelValue) return;
    if (!Array.isArray(options.models)) throw new Error('未取得模型列表');
    models.value = options.models; modelsReady.value = true;
  } catch (exception) { if (run === generation) modelsError.value = apiError(exception); }
  finally { if (run === generation) modelsLoading.value = false; }
}
async function retryModel() {
  if (busy.value) return;
  // Refreshing model settings never replaces an already loaded context draft.
  await Promise.all([loadProperties(generation,false),loadModels()]);
}
watch(() => [props.modelValue,uuid.value], () => { tab.value = props.initialTab; triggerVisited.value = tab.value === 'trigger'; load(); }, {immediate:true});
watch(tab, value => { if (value === 'trigger') triggerVisited.value = true; });
onBeforeUnmount(() => generation++);
async function saveContext() {
  if (!canSaveContext.value) return false;
  const id = uuid.value, run = generation;
  const submitted = {contextMode:context.value.contextMode,contextText:context.value.contextText};
  saving.value = true; error.value = '';
  try {
    const response = await Api.updateConversationProperties(id,submitted);
    if (run !== generation || !props.modelValue) return false;
    const current = {contextMode:context.value.contextMode,contextText:context.value.contextText};
    const later = JSON.stringify(current) !== JSON.stringify(submitted);
    baseline.value = JSON.stringify({contextMode:response.properties.contextMode,contextText:response.properties.contextText});
    context.value = {...response.properties,...(later ? current : {})};
    ElMessage.success(later ? '提交的上下文已保存；后续输入仍未保存，已保留草稿' : '局部上下文已保存');
    return !dirtyContext.value; // Save-and-leave must not discard input typed during the request.
  } catch (exception) { if (run === generation) error.value = apiError(exception); return false; }
  finally { if (run === generation) saving.value = false; }
}
async function mutate(field,value) {
  if (!canEditModel.value) return;
  const id = uuid.value, run = generation;
  const requests = {model:()=>Api.conversationSetModel(id,value),thinking:()=>Api.conversationSetThinking(id,value),fast:()=>Api.conversationSetFast(id,value),agent:()=>Api.conversationSetAgentRunConfig(id,value),strategy:()=>Api.conversationSetContextStrategy(id,value)};
  modelSaving.value = true; modelError.value = '';
  try {
    const response = await saveRunConfig(id,requests[field]);
    if (run !== generation) return;
    const snapshot = runConfigFromResponse(response,id); if (!snapshot) throw new Error('未取得完整模型配置，未更新界面');
    model.value = snapshot; ElMessage.success(field === 'strategy' ? '压缩策略已保存，在下一安全边界生效' : '已保存，下一次运行生效；当前运行不切换');
  } catch (exception) { if (run === generation) modelError.value = apiError(exception); }
  finally { if (run === generation) modelSaving.value = false; }
}
async function canLeave() {
  if (busy.value) return false;
  if (trigger.value && !await trigger.value.canLeave()) return false;
  if (!local.value && dirtyContext.value) {
    try { await ElMessageBox.confirm('局部上下文尚未保存。', '离开会话属性？', {confirmButtonText:'保存后离开',cancelButtonText:'放弃更改',distinguishCancelAndClose:true,closeOnClickModal:false}); if (!await saveContext()) return false; }
    catch (action) { if (action !== 'cancel') return false; }
  }
  return true;
}
async function close(done) { if (!await canLeave()) return; emit('update:modelValue',false); if (typeof done === 'function') done(); }
async function navigate(event) { const element = event.currentTarget; tab.value = tabKey(event,tab.value,tabs); await nextTick(); element.querySelector(`[data-tab="${tab.value}"]`)?.focus(); }
defineExpose({canLeave});
</script>
<template>
  <el-dialog :model-value="modelValue" title="会话属性" width="min(820px, calc(100vw - 24px))" append-to-body class="folder-properties-dialog mobile-viewport-dialog" :class="{'is-trigger':tab === 'trigger' && !local}" :before-close="close" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="value => { if (value) emit('update:modelValue',true); }">
    <template #header><div class="folder-properties-heading"><h2 :title="conversation?.title">{{ conversation?.title || '会话属性' }}</h2></div><nav class="property-segmented" role="tablist" aria-label="会话属性分类" @keydown="navigate"><button v-for="[id,label] in tabs" :key="id" :id="`conversation-property-tab-${id}`" type="button" role="tab" :data-tab="id" :aria-selected="tab === id" :aria-controls="`conversation-property-panel-${id}`" :tabindex="tab === id ? 0 : -1" @click="tab = id">{{ label }}</button></nav></template>
    <div v-if="local" class="property-section"><h3>这是尚未持久保存的草稿</h3><p>没有有效触发地址。创建为真实会话后才能配置入口，不会自动运行模型、启用入口或发送消息。</p><el-button type="primary" @click="emit('persist')">保存为真实会话后继续</el-button></div>
    <div v-else class="property-form"><div class="property-panels" style="width:100%">
      <section v-show="tab === 'context'" v-loading="loading && !contextReady" id="conversation-property-panel-context" role="tabpanel" aria-labelledby="conversation-property-tab-context" class="property-tab-panel" style="width:100%">
        <p v-if="error" class="wh-alert" role="alert">{{ error }}<el-button :disabled="busy || loading || dirtyContext" @click="loadProperties()">重新读取</el-button><span v-if="dirtyContext">未保存的上下文仍保留，请先保存或放弃更改。</span></p><div class="property-section"><WebhookField v-model="context.contextMode" :disabled="!contextReady" label="会话局部上下文" :options="[{value:'inherit',label:'继承目录上下文'}, {value:'override',label:'自定义覆盖（不追加）'}]" /><div class="folder-prompt-editor"><AdaptiveMdEditor v-model="contextEditorText" :read-only="!contextReady || context.contextMode === 'inherit'" language="markdown" completion-mode="none" /></div></div>
      </section>
      <section v-show="tab === 'model'" v-loading="loading || modelsLoading" id="conversation-property-panel-model" role="tabpanel" aria-labelledby="conversation-property-tab-model" class="property-tab-panel" style="width:100%"><p v-if="modelError || modelsError" class="wh-alert" role="alert">{{ [modelError,modelsError].filter(Boolean).join('；') }}<el-button :disabled="busy || loading || modelsLoading" @click="retryModel">重新读取模型配置</el-button></p><ModelSettings :model-value="modelSettings" :models="models" :disabled="!canEditModel" @change="changeModelSetting" /><p class="property-note">逐项保存，下一次运行生效；不会改变当前运行。</p></section>
      <section v-if="triggerVisited && modelValue" v-show="tab === 'trigger'" id="conversation-property-panel-trigger" role="tabpanel" aria-labelledby="conversation-property-tab-trigger" class="wh-fill"><WebhookEditor ref="trigger" :scope="{type:'conversation',id:uuid}" :title="conversation?.title" :active="tab === 'trigger'" @cancel="close" /></section>
    </div></div>
    <template #footer><div class="property-footer"><span class="property-footer-note">{{ tab === 'model' && modelReady && modelsReady ? '模型设置已逐项保存' : dirtyContext ? '有未保存的上下文' : '' }}</span><div class="property-footer-buttons"><el-button :disabled="busy" @click="close">关闭</el-button><el-button v-if="tab === 'context' && !local" type="primary" :loading="saving" :disabled="!canSaveContext" @click="saveContext">保存上下文配置</el-button></div></div></template>
  </el-dialog>
</template>
