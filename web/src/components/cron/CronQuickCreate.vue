<script setup>
import {computed,nextTick,onBeforeUnmount,ref,watch} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {Api} from '../../api.js';
import Field from '../webhooks/WebhookField.vue';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import CronCalendarPopover from './CronCalendarPopover.vue';
import {createCronEditor} from './useCron.js';
import {clone,message,schedulePayload} from './cronConfig.js';
import {calendarDraft,repeatOptions,scheduleFor,dateKey,dateSpan,localDay} from './cronCalendar.js';
const props=defineProps({at:String,endDate:String,folderId:String,anchor:Object});
const emit=defineEmits(['close','saved','advanced']);
const editor=createCronEditor(Api);
const {draft,loading,loaded,saving,dirty,error,errors,folders,inheritanceLoading,inheritanceError}=editor;
const dates=ref([dateKey(props.at),props.endDate || dateKey(props.at)]);
const timeOfDay=ref(new Date(props.at).toTimeString().slice(0,8));
const at=computed(()=>dates.value?.[0] && timeOfDay.value ? new Date(`${dates.value[0]}T${timeOfDay.value}`).toISOString():null);
const endDate=computed(()=>dates.value?.[1] || '');
const repeat=ref(props.endDate?'daily':'once'),skipHolidays=ref(false),checking=ref(false),localError=ref(''),form=ref(null);
const options=computed(()=>repeatOptions(at.value,endDate.value));
const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
const disabled=computed(()=>loading.value || saving.value || checking.value);
const errorFor=path=>errors.value.find(item=>item.path===path)?.message;
const initial={draft:calendarDraft(props.at,props.folderId,props.endDate)};
const span=computed(()=>at.value && endDate.value && endDate.value>=dateKey(at.value)?dateSpan(at.value,endDate.value):null);
function syncSchedule(){
  if(!options.value.some(item=>item.value===repeat.value))repeat.value=options.value.find(item=>item.value==='daily')?.value || options.value[0]?.value || 'once';
  draft.config.schedule=scheduleFor(at.value,repeat.value,timezone,endDate.value,skipHolidays.value);localError.value='';
}
watch([at,endDate,repeat,skipHolidays],syncSchedule);
const disabledDate=day=>localDay(day)<localDay(new Date());
async function load(){if(await editor.load('',props.folderId,initial)){await nextTick();form.value?.querySelector('input')?.focus();}}
async function save(){
  if(disabled.value)return false;
  if(!at.value || !endDate.value || dateKey(at.value)>endDate.value || dateKey(at.value)<dateKey(new Date())){localError.value='请选择从今天或之后开始的有效日期范围。';return false;}
  if(Date.parse(at.value)<=Date.now()){localError.value='开始时间已过去，请选择未来的开始时间。';return false;}
  syncSchedule();checking.value=true;
  try {
    const preview=await Api.cronPreview({schedule:schedulePayload(draft.config.schedule),count:1});
    if(!preview.times?.length && preview.scheduleState!=='waiting_calendar'){localError.value='所选范围内没有可执行时间，请调整日期、时间或跳过节假日开关。';return false;}
    if(await editor.save()){ElMessage.success(draft.enabled?(preview.scheduleState==='waiting_calendar'?'任务已保存，等待日历数据补齐后自动排程':'任务已创建并启用'):'任务已保存，计划暂未启用');emit('saved');return true;}
    return false;
  } catch(exc){localError.value=message(exc);return false;} finally{checking.value=false;}
}
let leaveCheck=null;
async function canLeave(){
  if(saving.value || checking.value)return false;
  if(!dirty.value)return true;
  if(!leaveCheck)leaveCheck=ElMessageBox.confirm('尚有未保存的任务，确认放弃？','关闭新建任务',{type:'warning',confirmButtonText:'放弃修改',cancelButtonText:'继续编辑',closeOnClickModal:false}).then(()=>!saving.value,()=>false).finally(()=>{leaveCheck=null;});
  return leaveCheck;
}
async function close(){if(await canLeave())emit('close');}
function advanced(){if(!loaded.value || disabled.value)return;emit('advanced',{draft:clone(draft),dirty:dirty.value});}
function beforeUnload(event){if(dirty.value || saving.value || checking.value){event.preventDefault();event.returnValue='';}}
load();window.addEventListener('beforeunload',beforeUnload);
onBeforeUnmount(()=>{editor.dispose();window.removeEventListener('beforeunload',beforeUnload);});
defineExpose({canLeave});
</script>
<template>
  <CronCalendarPopover :anchor="anchor" title="新建定时任务" @close="close">
    <div ref="form" class="cron-cal-quick-form">
      <el-skeleton v-if="loading" :rows="5" animated />
      <div v-if="error" class="cron-alert" role="alert">{{ error }} <el-button v-if="!loaded" link @click="load">重试</el-button></div>
      <template v-if="loaded && !loading">
        <Field v-model="draft.name" label="任务名称" placeholder="例如：每日新闻汇总" :disabled="disabled" :error="errorFor('name')" data-autofocus />
        <Field v-model="draft.folderId" label="所属目录" filterable :options="folders.map(f=>({value:f.id,label:f.path || f.name}))" :disabled="disabled" :error="errorFor('folderId')" @update:model-value="editor.loadInheritance($event)" />
        <el-config-provider :locale="zhCn">
          <Field label="日期范围" v-slot="{id}">
            <el-date-picker :id="id" v-model="dates" type="daterange" format="YYYY-MM-DD" value-format="YYYY-MM-DD" range-separator="-" popper-class="cron-cal-range-panel" start-placeholder="开始日期" end-placeholder="结束日期" :editable="false" :clearable="false" :disabled="disabled" :disabled-date="disabledDate" class="cron-cal-range-picker" />
          </Field>
          <div class="cron-cal-time-repeat">
            <Field label="时间" v-slot="{id}"><el-time-picker :id="id" v-model="timeOfDay" format="HH:mm:ss" value-format="HH:mm:ss" :clearable="false" :editable="false" :disabled="disabled" /></Field>
            <Field v-model="repeat" label="重复方式" :options="options" :disabled="disabled || !options.length" />
          </div>
        </el-config-provider>
        <div class="cron-cal-holiday-switch"><span>跳过节假日<small>含周末，调休工作日照常执行</small></span><el-switch v-model="skipHolidays" :disabled="disabled" aria-label="跳过节假日" /></div>
        <p v-if="span" class="cron-cal-range-summary"><strong>{{ span.count }} 天 · {{ options.find(item=>item.value===repeat)?.label }}</strong><br />{{ span.start }} {{ timeOfDay }} 开始，{{ span.end }} 当日结束。<br /><span>{{ timezone }} · {{ repeat==='monthly'?'不存在的日期跳过；':'' }}不补跑错过的时间。</span></p>
        <label class="cron-cal-instructions">处理指令<textarea v-model="draft.config.instructions" rows="4" placeholder="到时需要做什么？写清目标、范围和授权。" :disabled="disabled" /></label>
        <p v-if="inheritanceError" class="cron-error" role="alert">{{ inheritanceError }} <el-button link @click="editor.loadInheritance()">重试</el-button></p>
        <p v-if="localError" class="cron-error" role="alert">{{ localError }}</p>
        <ul v-if="errors.length" class="cron-cal-errors" role="alert"><li v-for="item in errors" :key="item.path">{{ item.message }}</li></ul>
        <div class="cron-cal-enable"><span>启用计划<small>到点自动创建独立会话执行</small></span><el-switch v-model="draft.enabled" :disabled="disabled" aria-label="启用计划" /></div>
      </template>
    </div>
    <template #footer><el-button :disabled="!loaded || disabled" @click="advanced">完整配置…</el-button><el-button type="primary" :loading="saving || checking" :disabled="!loaded || disabled || inheritanceLoading || Boolean(inheritanceError)" @click="save">{{ draft.enabled?'创建并启用':'保存任务' }}</el-button></template>
  </CronCalendarPopover>
</template>
