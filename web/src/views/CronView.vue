<script setup>
import {computed,nextTick,onBeforeUnmount,ref,watch} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {Api} from '../api.js';
import AdminPageHeader from '../components/AdminPageHeader.vue';
import CronEditor from '../components/cron/CronEditor.vue';
import CronHistory from '../components/cron/CronHistory.vue';
import CronRunDialog from '../components/cron/CronRunDialog.vue';
import {createQuery,createCronActions} from '../components/cron/useCron.js';
import {PAGE_TABS,tabKey,label,time,number,scheduleText} from '../components/cron/cronConfig.js';
import '../components/cron/cron.css';
const props=defineProps({folderId:{type:String,default:''}});
const emit=defineEmits(['mobile-header-ready','folder-changed','open-conversation','cron-leave-guard']);
const search=ref(''),enabled=ref(''),offset=ref(0),editorOpen=ref(false),editorId=ref(''),editorRef=ref(null),historyJob=ref(null),refreshKey=ref(0),runId=ref('');
const jobs=createQuery(params=>Api.cronJobs(params)),dirs=createQuery(()=>Api.cronFolders()),actions=createCronActions(Api);
const {data,loading,error}=jobs;
const {data:folderData,error:folderError}=dirs;
const {busy,error:actionError,preparation}=actions;
const folders=computed(()=>folderData.value?.items || []);
const deleteOpen=ref(false),confirming=ref(false);
const activeTab=ref('jobs'),historyVisited=ref(false),pageTabs=ref(null);
function selectTab(value){activeTab.value=value;if(value==='history')historyVisited.value=true;}
function openHistory(job){historyJob.value={id:job.id,name:job.name};selectTab('history');}
async function navigatePageTabs(event){
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  selectTab(tabKey(event,activeTab.value,PAGE_TABS));await nextTick();
  pageTabs.value?.querySelector(`[data-page-tab="${activeTab.value}"]`)?.focus();
}
let disposed=false;
async function load(){
  const requestedOffset=offset.value;
  const ok=await jobs.load({folderId:props.folderId || undefined,search:search.value || undefined,enabled:enabled.value===''?undefined:enabled.value,limit:30,offset:requestedOffset});
  if(!ok || disposed || !data.value || offset.value!==requestedOffset)return false;
  const lastOffset=Math.max(0,Math.floor((data.value.total-1)/30)*30);
  if(offset.value>lastOffset){offset.value=lastOffset;return load();}
  return true;
}
function filter(){offset.value=0;load();}
function refresh(){load();refreshKey.value++;}
function page(next){offset.value=next;load();}
function selectFolder(value){emit('folder-changed',value || '');}
async function canLeave(){return !editorOpen.value || Boolean(await editorRef.value?.canLeave());}
async function edit(id=''){if(!await canLeave())return;editorId.value=id;editorOpen.value=true;}
function saved(){refresh();}
async function run(job){
  if(busy.value || confirming.value)return;
  confirming.value=true;
  try{await ElMessageBox.confirm(`立即执行“${job.name}”？这会真实创建新会话并运行；不改变正常下次时间，即使计划已停用也会执行。`,'立即执行一次',{type:'warning',confirmButtonText:'立即执行',cancelButtonText:'取消',closeOnClickModal:false});}
  catch{return;}
  finally{confirming.value=false;}
  if(disposed)return;
  const result=await actions.perform('run',job);if(result){runId.value=result.run.id;refresh();}
}
async function control(job){const result=await actions.perform('control',job,{enabled:!job.enabled});if(result){ElMessage.success(result.job.enabled?'未来计划已启用':'未来计划已停用；当前运行继续');refresh();}}
async function prepareDelete(job){if(await actions.prepareDelete(job))deleteOpen.value=true;}
async function remove(){if(await actions.deletePrepared()){deleteOpen.value=false;ElMessage.success('任务已删除，运行记录及会话保留');refresh();}}
function closeDelete(done){if(busy.value)return;deleteOpen.value=false;preparation.value=null;if(typeof done==='function')done();}
function openConversation(id){emit('open-conversation',id);}
watch(()=>props.folderId,()=>{historyJob.value=null;filter();},{immediate:true});
watch(enabled,filter);
dirs.load();
// Register through an event: the lazy view wrapper forwards listeners, not child refs.
emit('cron-leave-guard',canLeave);
onBeforeUnmount(()=>{disposed=true;emit('cron-leave-guard',null);jobs.dispose();dirs.dispose();actions.dispose();});
</script>
<template>
  <div class="cron-view cron-root">
    <AdminPageHeader title="定时任务" subtitle="目录计划 · 每次独立新会话" description="到点开始，不排队；停机错过不补跑。" @mobile-header-ready="emit('mobile-header-ready',$event)"><template #mobile-navigation><slot name="mobile-navigation" /></template><template #actions><el-button :loading="loading" @click="refresh">刷新</el-button></template><template #primary><el-button type="primary" @click="edit()">新建任务</el-button></template></AdminPageHeader>
    <nav ref="pageTabs" class="cron-tabs cron-page-tabs" role="tablist" aria-label="定时任务页面" @keydown="navigatePageTabs"><button v-for="[key,title] in PAGE_TABS" :id="`cron-page-tab-${key}`" :key="key" type="button" role="tab" :data-page-tab="key" :aria-selected="activeTab===key" :aria-controls="`cron-page-panel-${key}`" :tabindex="activeTab===key?0:-1" @click="selectTab(key)">{{ title }}</button></nav>
    <div class="cron-view-scroll">
      <div class="cron-filters"><el-select :model-value="folderId" clearable filterable placeholder="全部目录" aria-label="所属目录筛选" @update:model-value="selectFolder"><el-option v-for="folder in folders" :key="folder.id" :value="folder.id" :label="folder.path || folder.name" /></el-select><template v-if="activeTab==='jobs'"><el-input v-model="search" clearable placeholder="搜索定时任务" aria-label="搜索定时任务" @keyup.enter="filter" @clear="filter" /><el-select v-model="enabled" clearable placeholder="全部启用状态" aria-label="计划启用筛选"><el-option :value="true" label="已启用" /><el-option :value="false" label="已停用" /></el-select><el-button @click="filter">搜索</el-button></template></div>
      <p v-if="folderError" class="cron-alert" role="alert">目录加载失败：{{ folderError }} <el-button link @click="dirs.load()">重试</el-button></p>
      <p v-if="folderId" class="cron-note">当前目录：{{ folders.find(item=>item.id===folderId)?.path || folderId }}</p>
      <div v-if="actionError" class="cron-alert" role="alert">{{ actionError }} <span>操作失败未自动重试；版本冲突请刷新列表，确认最新配置后再操作。</span></div>
      <section v-show="activeTab==='jobs'" id="cron-page-panel-jobs" role="tabpanel" aria-labelledby="cron-page-tab-jobs" class="cron-panel">
        <div class="cron-panel-head"><div><h2>任务列表</h2><p class="cron-note">启停仅控制未来计划；当前运行可打开对应会话，使用会话现有停止操作。</p></div><span class="cron-note">{{ number(data?.total) }} 个任务</span></div>
        <div v-if="error" class="cron-alert" role="alert">{{ error }} <el-button link @click="load">重试</el-button></div>
        <div class="cron-table-scroll" v-loading="loading"><table class="cron-table"><thead><tr><th>任务 / 目录</th><th>时间规则 / 下次执行</th><th>计划状态</th><th>当前 / 最近执行</th><th>管理</th></tr></thead><tbody><tr v-for="job in data?.items || []" :key="job.id"><td><strong>{{ job.name }}</strong><small>{{ job.folderPath || job.folderName || job.folderId }}</small><small v-if="job.description">{{ job.description }}</small></td><td>{{ scheduleText(job.config?.schedule) }}<small>{{ time(job.nextRunAt) }}</small></td><td><span class="cron-status" :data-status="job.scheduleState">{{ label(job.scheduleState) }}</span><small>{{ job.enabled?'已启用':'已停用' }} · v{{ job.revision }}</small></td><td>{{ number(job.activeRuns) }} 个执行中<small>{{ job.lastRun ? label(job.lastRun.status) : '尚无执行' }}</small></td><td><div class="cron-row-actions"><el-button link @click="edit(job.id)">编辑</el-button><el-button link :disabled="busy || confirming" @click="control(job)">{{ job.enabled?'停用':'启用' }}</el-button><el-button link :disabled="busy || confirming" @click="run(job)">立即执行</el-button><el-button link @click="openHistory(job)">记录</el-button><el-button link type="danger" :disabled="busy || confirming" @click="prepareDelete(job)">删除</el-button></div></td></tr></tbody></table><div v-if="!loading && !error && !data?.items?.length" class="cron-empty"><h3>{{ search || folderId || enabled!=='' ? '没有符合筛选的任务' : '让例行工作按时开始' }}</h3><p>选择一个目录，设置时间与指令；每次执行都拥有独立会话与记录。</p><el-button type="primary" @click="edit()">新建定时任务</el-button></div></div>
        <div class="cron-pagination"><el-button :disabled="loading || offset===0" @click="page(Math.max(0,offset-30))">上一页</el-button><el-button :disabled="loading || !data || offset+30>=data.total" @click="page(offset+30)">下一页</el-button></div>
      </section>
      <div v-show="activeTab==='history'" id="cron-page-panel-history" role="tabpanel" aria-labelledby="cron-page-tab-history">
        <CronHistory v-if="historyVisited" :folder-id="folderId" :job-id="historyJob?.id" :job-name="historyJob?.name" :refresh-key="refreshKey" @clear-job="historyJob=null" @open-conversation="openConversation" />
      </div>
    </div>
    <CronEditor v-if="editorOpen" ref="editorRef" :key="editorId || 'new'" :job-id="editorId" :folder-id="folderId" @close="editorOpen=false" @saved="saved" />
    <CronRunDialog v-if="runId" :run-id="runId" @close="runId=''" @open-conversation="openConversation" />
    <el-dialog v-model="deleteOpen" title="删除定时任务" width="min(520px, calc(100vw - 24px))" append-to-body class="cron-root mobile-viewport-dialog" :before-close="closeDelete" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy">
      <template v-if="preparation"><h3>{{ preparation.job.name }}</h3><p>删除后停用未来计划并保留定义的删除记录。</p><p><strong>{{ number(preparation.impact.activeRuns) }}</strong> 个当前执行继续，不会被停止；保留 <strong>{{ number(preparation.impact.retainedRuns) }}</strong> 条运行记录及对应会话。</p></template><p v-if="actionError" class="cron-alert" role="alert">{{ actionError }}</p>
      <template #footer><el-button :disabled="busy" @click="closeDelete">取消</el-button><el-button type="danger" :loading="busy" :disabled="!preparation?.confirmationToken" @click="remove">确认删除</el-button></template>
    </el-dialog>
  </div>
</template>
