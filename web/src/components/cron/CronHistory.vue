<script setup>
import {onBeforeUnmount,ref,watch} from 'vue';
import {Api} from '../../api.js';
import {createQuery} from './useCron.js';
import {STATUSES,label,time,number,money} from './cronConfig.js';
import CronRunDialog from './CronRunDialog.vue';
const props=defineProps({folderId:String,jobId:String,jobName:String,refreshKey:Number});
const emit=defineEmits(['open-conversation','clear-job']);
const status=ref(''),start=ref(''),end=ref(''),offset=ref(0),runId=ref(''),rangeError=ref('');
const appliedRange=ref({start:'',end:''});
const runs=createQuery(params=>Api.cronRuns(params)),stats=createQuery(params=>Api.cronStatistics(params));
const {data:runData,loading,error}=runs;
const {data:summary,loading:statsLoading,error:statsError}=stats;
function range(){
  const {start,end}=appliedRange.value;
  return {folderId:props.folderId || undefined,jobId:props.jobId || undefined,start:start?new Date(start).toISOString():undefined,end:end?new Date(end).toISOString():undefined};
}
function loadRuns(){runs.load({...range(),status:status.value || undefined,limit:30,offset:offset.value});}
function refresh(){loadRuns();stats.load(range());}
function filter(){
  rangeError.value='';
  if([start.value,end.value].some(value=>value && !Number.isFinite(Date.parse(value)))){rangeError.value='请选择有效的日期和时间';return;}
  if(start.value && end.value && Date.parse(start.value)>Date.parse(end.value)){rangeError.value='开始时间不能晚于结束时间';return;}
  appliedRange.value={start:start.value,end:end.value};offset.value=0;refresh();
}
function page(value){offset.value=value;loadRuns();}
watch(()=>[props.folderId,props.jobId,props.refreshKey],()=>{offset.value=0;refresh();},{immediate:true});
watch(status,()=>{offset.value=0;loadRuns();});
onBeforeUnmount(()=>{runs.dispose();stats.dispose();});
</script>
<template>
  <section class="cron-panel" aria-label="运行历史与统计">
    <div class="cron-panel-head"><div><h2>{{ jobId ? jobName || '当前任务' : '全部任务' }} · 运行历史</h2><p class="cron-note">{{ folderId ? '当前目录' : '所有目录' }} · 按开始时间筛选，包含保留的历史记录</p></div><el-button v-if="jobId" link @click="emit('clear-job')">全部任务</el-button></div>
    <div class="cron-filters"><label class="cron-date">从（本地时间）<input v-model="start" type="datetime-local" aria-label="开始时间" /></label><label class="cron-date">至（本地时间）<input v-model="end" type="datetime-local" aria-label="结束时间" /></label><el-button :loading="loading || statsLoading" @click="filter">应用 / 刷新</el-button></div>
    <p v-if="rangeError" class="cron-error" role="alert">{{ rangeError }}</p>
    <p v-if="start!==appliedRange.start || end!==appliedRange.end" class="cron-note">日期修改尚未应用，列表与统计仍使用上次应用的时间范围。</p>
    <div v-if="statsError" class="cron-alert" role="alert">统计加载失败：{{ statsError }}</div>
    <div class="cron-stats" aria-label="简单统计"><article v-for="[title,value] in [['执行次数',number(summary?.runs)],['完成',number(summary?.completed)],['失败',number(summary?.failed)],['取消',number(summary?.cancelled)],['中断',number(summary?.interrupted)],['超限',number(summary?.limited)],['正在执行',number(summary?.active)],['总 Tokens',number(summary?.totalTokens)],['金额 USD',money(summary?.costUsd)],['平均耗时（秒）',number(summary?.averageDurationSeconds)]]" :key="title"><span>{{ title }}</span><strong>{{ value }}</strong></article></div>
    <p class="cron-note">统计不随下方状态筛选变化；平均耗时仅含终态，— 表示缺失，0 表示已知零值。</p>
    <div class="cron-filters"><el-select v-model="status" clearable placeholder="全部执行状态" aria-label="运行状态筛选"><el-option v-for="value in STATUSES" :key="value" :value="value" :label="label(value)" /></el-select></div>
    <div v-if="error" class="cron-alert" role="alert">{{ error }} <el-button link @click="loadRuns">重试</el-button></div>
    <div class="cron-table-scroll" v-loading="loading"><table class="cron-table"><thead><tr><th>任务 / 触发</th><th>开始 / 耗时</th><th>状态 / 阶段</th><th>Tokens / USD</th><th>操作</th></tr></thead><tbody><tr v-for="run in runData?.items || []" :key="run.id"><td><strong>{{ run.jobName }}</strong><small>{{ label(run.trigger) }}</small></td><td>{{ time(run.startedAt) }}<small>{{ number(run.durationSeconds) }} 秒</small></td><td><span class="cron-status" :data-status="run.status">{{ label(run.status) }}</span><small>{{ label(run.phase) }}</small></td><td>{{ number(run.totalTokens) }}<small>{{ money(run.costUsd) }}</small></td><td><div class="cron-row-actions"><el-button link @click="runId=run.id">详情</el-button><el-button v-if="run.conversationId" link @click="emit('open-conversation',run.conversationId)">打开会话</el-button></div></td></tr></tbody></table><p v-if="!loading && !error && !runData?.items?.length" class="cron-empty">暂无符合条件的运行记录。</p></div>
    <div class="cron-pagination"><span>{{ number(runData?.total) }} 条</span><el-button :disabled="loading || offset===0" @click="page(Math.max(0,offset-30))">上一页</el-button><el-button :disabled="loading || !runData || offset+30>=runData.total" @click="page(offset+30)">下一页</el-button></div>
    <CronRunDialog v-if="runId" :run-id="runId" @close="runId=''" @open-conversation="emit('open-conversation',$event)" />
  </section>
</template>
