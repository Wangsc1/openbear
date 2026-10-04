<script setup>
import {computed,ref} from 'vue';
import AdaptiveMdEditor from '../AdaptiveMdEditor.vue';
import Field from '../webhooks/WebhookField.vue';
import {OUTCOMES,label} from './cronConfig.js';
const props=defineProps({script:{type:Object,required:true},phase:String,environment:Object,errors:{type:Array,default:()=>[]},disabled:Boolean});
const runtime=computed(()=>props.environment?.runtimes?.find(item=>item.runtime===props.script.runtime));
const errorFor=field=>props.errors.find(item=>item.path===`${props.phase}.${field}`)?.message;
const backoffText=ref(props.script.retry.backoffSeconds.join(', '));
function backoff(value){backoffText.value=value;props.script.retry.backoffSeconds=value.trim() ? value.split(/[,，\s]+/).filter(Boolean).map(Number) : [];}
</script>
<template>
  <section class="cron-script">
    <div class="cron-toolbar"><h3>{{ phase==='pre' ? '前置脚本' : '后置脚本' }}</h3><el-switch v-model="script.enabled" :disabled="disabled" :aria-label="`启用${phase==='pre'?'前置':'后置'}脚本`" active-text="启用" /></div>
    <p class="cron-note">{{ phase==='pre' ? '前置 stdin 为空，无业务参数；与模型共同受单次执行超时限制。' : '后置 stdin 为本次结果 JSON；独立限时，重试只执行后置，不重做模型。' }} stdout / stderr 保存为日志，无需输出 Webhook 协议。</p>
    <div class="cron-script-grid">
      <div class="cron-script-source"><div class="cron-code"><AdaptiveMdEditor v-model="script.code" :read-only="disabled" :language="script.runtime==='node'?'javascript':'python'" completion-mode="none" /></div><p v-if="errorFor('code')" class="cron-error" role="alert">{{ errorFor('code') }}</p></div>
      <aside class="cron-fields">
        <Field v-model="script.runtime" label="语言" :disabled="disabled" :options="[{value:'python',label:'Python'},{value:'node',label:'Node.js'}]" :error="errorFor('runtime')" />
        <Field v-model="script.timeoutSeconds" :path="`${phase}.timeoutSeconds`" label="脚本超时" type="number" unit="秒" :min="0" :max="3600" hint="大于 0，最多 3600 秒；停用时也需保留有效值。" :disabled="disabled" :error="errorFor('timeoutSeconds')" />
        <Field v-model="script.onError" label="重试耗尽后" :disabled="disabled" :options="[{value:'fail',label:'标记失败'},{value:'continue',label:'继续执行'}]" :error="errorFor('onError')" />
        <Field v-model="script.retry.maxAttempts" :path="`${phase}.retry.maxAttempts`" label="总尝试次数" type="number" :min="1" :max="5" :step="1" hint="1–5 次，含首次；1 表示不重试。" :disabled="disabled" :error="errorFor('retry.maxAttempts')" />
        <Field :model-value="backoffText" :path="`${phase}.retry.backoffSeconds`" label="重试前等待" unit="秒" hint="每项 0–3600 秒，逗号分隔，例如 2, 10, 30。" :disabled="disabled" :error="errorFor('retry.backoffSeconds')" @update:model-value="backoff" />
      </aside>
    </div>
    <div v-if="phase==='post'" class="cron-outcomes"><h4>哪些业务结果运行后置</h4><el-checkbox-group v-model="script.onOutcomes" :disabled="disabled" aria-label="运行后置的业务结果"><el-checkbox v-for="value in OUTCOMES" :key="value" :value="value">{{ label(value) }}</el-checkbox></el-checkbox-group><p class="cron-note">后置耗尽且选择“标记失败”时，最终状态为后置失败，原业务结果仍保留。</p></div>
    <div class="cron-script-environment">
      <div class="cron-runtime-paths"><span>解释器 <code>{{ runtime?.path || '未发现解释器' }}</code></span><span>工作目录 <code>{{ environment?.defaultCwd || '—' }}</code></span></div>
      <h4>执行环境变量</h4>
      <dl class="cron-env-grid"><div><dt>任务 ID</dt><dd><code>OPENBEAR_CRON_JOB_ID</code></dd></div><div><dt>执行 ID</dt><dd><code>OPENBEAR_CRON_RUN_ID</code></dd></div><div><dt>会话 ID</dt><dd><code>OPENBEAR_CRON_CONVERSATION_ID</code></dd></div><div><dt>计划时间</dt><dd><code>OPENBEAR_CRON_SCHEDULED_AT</code></dd></div></dl>
      <p class="cron-note">脚本自行处理并行执行的资源冲突；重试时注意避免重复副作用。</p>
    </div>
  </section>
</template>
