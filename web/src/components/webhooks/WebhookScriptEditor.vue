<script setup>
import {computed, ref, watch} from 'vue';
import AdaptiveMdEditor from '../AdaptiveMdEditor.vue';
import WebhookField from './WebhookField.vue';
import {parseLines} from './webhookConfig.js';
const props = defineProps({config:{type:Object,required:true},phase:{type:String,default:'pre'},environment:{type:Object,default:()=>({})},errors:{type:Array,default:()=>[]}});
const emit = defineEmits(['update:phase']);
const parametersOpen = ref(false);
const script = computed(()=>props.config[props.phase]);
const runtime = computed(()=>props.environment.runtimes?.find(item=>item.runtime===script.value.runtime));
const runtimeOptions = computed(()=>['python','node'].map(value=>({value,label:value==='python'?'Python':'Node.js'})));
const errorFor = field => props.errors.find(item=>item.path===`${props.phase}.${field}`)?.message;
watch(()=>[props.errors,props.phase],()=>{if(props.errors.some(item=>item.path.startsWith(`${props.phase}.`) && item.path!==`${props.phase}.code`))parametersOpen.value=true;},{immediate:true});
function toggleRetry(value) { script.value.retry.maxAttempts=value?2:1; }
</script>
<template>
  <section class="wh-script-workspace">
    <div class="wh-editor-toolbar"><el-radio-group :model-value="phase" size="small" aria-label="脚本阶段" @update:model-value="emit('update:phase',$event)"><el-radio-button value="pre">前置脚本</el-radio-button><el-radio-button value="post">后置脚本</el-radio-button></el-radio-group><el-switch v-model="script.enabled" active-text="启用" /><span class="wh-toolbar-spacer" /><el-button class="wh-phone-parameters" link @click="parametersOpen=!parametersOpen">运行设置</el-button></div>
    <div class="wh-script-grid" :class="{'parameters-open':parametersOpen}">
      <div class="wh-code-pane" :data-field="`${phase}.code`"><AdaptiveMdEditor v-model="script.code" :language="script.runtime==='node'?'javascript':'python'" completion-mode="none" /><p v-if="errorFor('code')" class="wh-error-text" role="alert">{{ errorFor('code') }}</p></div>
      <aside class="wh-script-parameters" aria-label="脚本运行参数">
        <WebhookField v-model="script.runtime" :path="`${phase}.runtime`" label="语言" :options="runtimeOptions" :error="errorFor('runtime')" /><small class="wh-muted">服务器解释器</small><code class="wh-runtime-path" :title="runtime?.path">{{ runtime?.path || '服务器未发现可用解释器' }}</code>
        <WebhookField v-model="script.timeoutSeconds" :path="`${phase}.timeoutSeconds`" type="number" nullable label="运行超时" unit="秒" :error="errorFor('timeoutSeconds')" :hint="`留空用系统默认，最长 ${environment.limits?.scripts?.maxTimeoutSeconds ?? '—'} 秒。`" />
        <template v-if="phase==='pre'"><WebhookField v-model="config.processing.scriptScheduling" label="何时运行" :options="[{value:'independent',label:'收到后独立运行'},{value:'serial',label:'跟随会话排队'}]" /><WebhookField v-model="script.onError" :path="`${phase}.onError`" label="失败时" :options="[{value:'hold',label:'暂停此事件，等待处理'},{value:'continueModel',label:'把错误交给模型处理'}]" /></template>
        <div v-else class="wh-field" :data-field="`${phase}.onOutcomes`"><label>哪些结果运行后置</label><el-checkbox-group v-model="script.onOutcomes"><el-checkbox value="normal">正常</el-checkbox><el-checkbox value="partialFailure">部分失败</el-checkbox><el-checkbox value="failed">失败</el-checkbox></el-checkbox-group><small v-if="errorFor('onOutcomes')" class="wh-error-text">{{ errorFor('onOutcomes') }}</small></div>
        <div class="wh-field" :data-field="script.retry.maxAttempts>1?undefined:`${phase}.retry.maxAttempts`"><label>失败后自动重试</label><el-switch :model-value="script.retry.maxAttempts>1" aria-label="失败后自动重试" @update:model-value="toggleRetry" /><small>结果未知时仍需先核实，不会直接重做。</small></div>
        <template v-if="script.retry.maxAttempts>1"><WebhookField :path="`${phase}.retry.maxAttempts`" :error="errorFor('retry.maxAttempts')" :model-value="script.retry.maxAttempts-1" type="number" :min="1" :max="4" :step="1" label="额外重试" unit="次" @update:model-value="script.retry.maxAttempts=$event==null?null:$event+1" /><WebhookField v-model="script.retry.idempotencyDeclaration" :path="`${phase}.retry.idempotencyDeclaration`" label="怎样避免重复操作" :error="errorFor('retry.idempotencyDeclaration')" hint="例如：用同一订单号查询结果，已处理时不重复提交。" /><WebhookField :model-value="script.retry.backoffSeconds.join(', ')" label="重试前等待" unit="秒" hint="多次重试可填 2, 10, 30。" @update:model-value="script.retry.backoffSeconds=parseLines($event).map(Number)" /></template>
      </aside>
    </div>
  </section>
</template>
