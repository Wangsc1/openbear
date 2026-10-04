<script setup>
import {onBeforeUnmount,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {copyTextToClipboard} from '../../utils/clipboard.js';
import {Api} from '../../api.js';
import {createQuery} from './useCron.js';
import {label,time,number,money} from './cronConfig.js';
import './cron.css';
const props=defineProps({runId:String,modelInput:{type:String,default:null},showConversationLink:{type:Boolean,default:true}});
async function copyInput(){
  try{await copyTextToClipboard(props.modelInput);ElMessage.success('模型输入已复制');}
  catch{ElMessage.warning('复制失败，请选中文本手动复制');}
}
const emit=defineEmits(['close','open-conversation']);
const query=createQuery(id=>Api.cronRun(id));
const {data,loading,error}=query;
watch(()=>props.runId,id=>query.load(id),{immediate:true});
onBeforeUnmount(query.dispose);
</script>
<template>
  <el-dialog :model-value="true" title="执行详情" width="min(860px, calc(100vw - 24px))" append-to-body class="cron-dialog cron-root cron-run-dialog mobile-viewport-dialog" @close="emit('close')">
    <div class="cron-run-scroll">
      <details v-if="modelInput != null" class="cron-model-input"><summary>模型输入 · 原文</summary><p class="cron-note">当时发送的任务指令与前置脚本输出，原文保留。</p><el-button @click="copyInput">复制模型输入</el-button><pre>{{ modelInput }}</pre></details>
      <el-skeleton v-if="loading" :rows="6" animated />
      <div v-if="error" class="cron-alert" role="alert">{{ error }} <el-button link @click="query.load(runId)">重试</el-button></div>
      <template v-if="data?.run">
        <h2>{{ data.run.jobName }}</h2><p class="cron-note cron-wrap">{{ data.run.id }}</p>
        <div class="cron-toolbar"><strong>{{ label(data.run.status) }}</strong><span>{{ label(data.run.phase) }} · {{ label(data.run.trigger) }}</span></div>
        <dl class="cron-facts"><template v-for="[key,value] in [['原业务结果',label(data.run.outcome)],['计划时间',time(data.run.scheduledAt)],['开始',time(data.run.startedAt)],['结束',time(data.run.finishedAt)],['耗时（秒）',number(data.run.durationSeconds)],['总 Tokens',number(data.run.totalTokens)],['费用（USD）',money(data.run.costUsd)],['模型调用',number(data.run.modelCalls)],['会话 ID',data.run.conversationId || '—'],['主轮 ID',data.run.rootTurnId || '—']]" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl>
        <div v-if="data.run.error" class="cron-alert" role="alert"><strong>错误</strong><pre>{{ typeof data.run.error==='string' ? data.run.error : JSON.stringify(data.run.error,null,2) }}</pre></div>
        <details><summary>通知状态</summary><pre>{{ JSON.stringify(data.run.notificationState ?? null,null,2) }}</pre></details>
        <section v-for="phase in ['pre','post']" :key="phase" class="cron-section"><h3>{{ phase==='pre'?'前置':'后置' }}执行记录</h3><p v-if="!data.run[`${phase}Attempts`]?.length" class="cron-note">无脚本尝试记录。</p><details v-for="attempt in data.run[`${phase}Attempts`] || []" :key="attempt.attempt" class="cron-attempt"><summary>第 {{ attempt.attempt }} 次 · 退出码 {{ attempt.exitCode ?? '—' }} · {{ attempt.errorClass || '执行记录' }}</summary><p class="cron-note">{{ time(attempt.startedAt) }} — {{ time(attempt.finishedAt) }}</p><p v-if="attempt.errorSummary" class="cron-error">{{ attempt.errorSummary }}</p><h4>stdout <small v-if="attempt.stdoutTruncated">（已截断）</small></h4><pre>{{ attempt.stdout || '（无输出）' }}</pre><h4>stderr <small v-if="attempt.stderrTruncated">（已截断）</small></h4><pre>{{ attempt.stderr || '（无输出）' }}</pre></details></section>
        <section class="cron-section"><h3>最终输出</h3><pre>{{ data.run.finalText || '（暂无输出）' }}</pre></section>
        <details><summary>本次配置快照</summary><pre>{{ JSON.stringify(data.run.configSnapshot,null,2) }}</pre></details>
      </template>
    </div>
    <template #footer><div class="cron-footer"><el-button :loading="loading" @click="query.load(runId)">刷新</el-button><div><el-button @click="emit('close')">关闭</el-button><el-button v-if="showConversationLink && data?.run?.conversationId" type="primary" @click="emit('open-conversation',data.run.conversationId)">打开会话</el-button></div></div></template>
  </el-dialog>
</template>
