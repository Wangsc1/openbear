<script setup>
import {computed,nextTick,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {ChevronLeft,ChevronRight,Plus,CalendarDays,RefreshCw,ArrowUpRight} from '@lucide/vue';
import {Api} from '../../api.js';
import {useAdminPhone} from '../../adminViewport.js';
import {createQuery} from './useCron.js';
import {time,number,scheduleText} from './cronConfig.js';
import {CALENDAR_VIEWS,WEEKDAYS,dateKey,localDay,addDays,dateSpan,calendarRange,moveDate,calendarTitle,clockText,dayLabel,minuteOfDay,selectedTime,nextCreationTime,statusInfo,eventSummary,eventsByDate,timeLayout} from './cronCalendar.js';
import CronStatusIcon from './CronStatusIcon.vue';
import CronQuickCreate from './CronQuickCreate.vue';
import CronCalendarPopover from './CronCalendarPopover.vue';
import './cronCalendar.css';
const props=defineProps({folderId:String,search:String,enabled:{type:[String,Boolean],default:''},refreshKey:Number,busy:Boolean});
const emit=defineEmits(['edit','advanced','saved','control','run','delete','history','run-detail','open-conversation']);
const isPhone=useAdminPhone();
const query=createQuery(params=>Api.cronCalendar(params));
const {data,loading,error}=query;
const now=ref(new Date()),focus=ref(localDay(new Date())),view=ref('month'),selectedDay=ref(dateKey(new Date())),selectedMinute=ref(540);
const viewport=ref(null),quickRef=ref(null),quick=ref(null),detail=ref(null),agenda=ref(null),drag=ref(null);
const pickedSpan=ref(null);
const selectedSpan=computed(()=>drag.value?dateSpan(drag.value.day,drag.value.endDay):pickedSpan.value);
const inSelection=key=>selectedSpan.value && key>=selectedSpan.value.start && key<=selectedSpan.value.end;
const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
const range=computed(()=>calendarRange(focus.value,view.value));
const title=computed(()=>calendarTitle(focus.value,view.value,range.value.days));
const byDate=computed(()=>eventsByDate(data.value?.items));
const today=computed(()=>dateKey(now.value));
const annotations=computed(()=>new Map((data.value?.annotations || []).map(item=>[item.date,item])));
const days=computed(()=>range.value.days.map(date=>({date,key:dateKey(date),past:dateKey(date)<today.value,outside:date.getMonth()!==focus.value.getMonth(),weekend:annotations.value.get(dateKey(date))?.isDayOff ?? [0,6].includes(date.getDay()),tags:annotations.value.get(dateKey(date))?.tags || []})));
const detailJob=computed(()=>data.value?.jobs?.find(job=>job.id===detail.value?.item.jobId));
const agendaItems=computed(()=>byDate.value.get(agenda.value?.date) || []);
const selectedItems=computed(()=>byDate.value.get(selectedDay.value) || []);
const selectedTags=computed(()=>annotations.value.get(selectedDay.value)?.tags || []);
const dayStates=key=>[...new Set((byDate.value.get(key) || []).map(item=>item.status))].slice(0,2);
const compactTag=tags=>{const tag=tags.find(item=>item.kind!=='weekend') || tags[0];return tag?{...tag,short:({holiday:'休',workday:'班',weekend:'休'})[tag.kind] || tag.label.replace('节','')}:null;};
const monthStyle=computed(()=>({'--calendar-rows':range.value.days.length/7}));
const timelineStyle=computed(()=>({'--calendar-columns':view.value==='day'?1:7}));
const eventsFor=key=>byDate.value.get(key) || [];
const timeEvents=key=>timeLayout(eventsFor(key));
const aggregateEvents=key=>eventsFor(key).filter(item=>item.count>1);
let timer=null,disposed=false,scrollFrame=null,suppressDayClickUntil=0;
function params(){return {start:range.value.start,end:range.value.end,timezone,folderId:props.folderId || undefined,search:props.search || undefined,enabled:props.enabled===''?undefined:props.enabled};}
async function load(quiet=false){
  const ok=await query.load(params(),{keepData:quiet});
  if(ok && detail.value){const item=data.value.items.find(item=>item.id===detail.value.item.id);if(item)detail.value={...detail.value,item};else detail.value=null;}
  return ok;
}
async function canLeave(){return !quick.value || Boolean(await quickRef.value?.canLeave());}
async function closeOverlays(){if(!await canLeave())return false;quick.value=null;detail.value=null;agenda.value=null;return true;}
async function move(direction){if(!await closeOverlays())return;pickedSpan.value=null;focus.value=moveDate(focus.value,view.value,direction);selectedDay.value=dateKey(focus.value);}
async function goToday(){if(!await closeOverlays())return;pickedSpan.value=null;now.value=new Date();focus.value=localDay(now.value);selectedDay.value=today.value;}
async function setView(value){if(value===view.value || !await closeOverlays())return;focus.value=localDay(selectedDay.value);view.value=value;await scrollToTime();}
async function scrollToTime(){await nextTick();if(view.value!=='month' && viewport.value)viewport.value.scrollTop=Math.max(0,(selectedMinute.value/60-1)*56);}
function anchorFor(element){
  if(!element?.getBoundingClientRect)return null;
  const rect=element.getBoundingClientRect();
  return {contextElement:element.contextElement || element,getBoundingClientRect:()=>element.isConnected===false?rect:element.getBoundingClientRect()};
}
async function createAt(day,event,minutes=null,endDate=''){
  if(dateKey(day)<dateKey(new Date()))return;
  const anchor=anchorFor(event?.currentTarget);
  if(!await closeOverlays())return;
  const key=dateKey(day);selectedDay.value=key;pickedSpan.value=endDate?dateSpan(day,endDate):null;
  if(minutes!=null)selectedMinute.value=minutes;
  quick.value={at:minutes==null?nextCreationTime(localDay(day)):selectedTime(day,minutes),endDate,anchor};
}
function createSelected(event){const span=pickedSpan.value;return createAt(span?.start || selectedDay.value,event,span?selectedMinute.value:null,span?.end || '');}
function selectDay(key){if(Date.now()<suppressDayClickUntil)return;pickedSpan.value=null;selectedDay.value=key;}
function keyboardCreate(event,day,minute){if(event.detail===0)createAt(day,event,minute);}
function advanced(initial){quick.value=null;emit('advanced',initial);}
function saved(){quick.value=null;emit('saved');}
function selectEvent(item,event){detail.value={item,anchor:anchorFor(event.currentTarget)};agenda.value=null;}
function openAgenda(day,event){selectedDay.value=dateKey(day);agenda.value={date:dateKey(day),anchor:event.currentTarget};}
function detailAction(action){const item=detail.value?.item,job=detailJob.value;if(!item)return;detail.value=null;
  if(action==='run-detail')emit(action,item.runId);
  else if(action==='open-conversation')emit(action,item.conversationId);
  else if(action==='history')emit(action,{id:item.jobId,name:item.name});
  else if(job)emit(action,action==='edit'?job.id:job);
}
async function dayKeydown(event,day){
  if(event.target!==event.currentTarget)return;
  if(event.key==='Enter'){event.preventDefault();await createAt(day,event);return;}
  const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];
  if(delta==null)return;event.preventDefault();const next=addDays(day,delta);selectedDay.value=dateKey(next);
  if(!days.value.some(d=>d.key===selectedDay.value))focus.value=next;
  await nextTick();viewport.value?.querySelector(`[data-date="${selectedDay.value}"]`)?.focus();
}
function slotMinute(event){const rect=event.currentTarget.getBoundingClientRect();return Math.max(0,Math.min(1425,Math.floor((event.clientY-rect.top)/56*4)*15));}
function beginSelection(event,day,kind){
  if(dateKey(day)<dateKey(new Date()))return;
  event.preventDefault();pickedSpan.value=null;selectedDay.value=dateKey(day);
  const minute=kind==='dates'?720:slotMinute(event);selectedMinute.value=minute;
  const capture=kind==='dates'?event.target.closest('[data-date]'):event.currentTarget;
  drag.value={kind,day:dateKey(day),endDay:dateKey(day),minute,firstMinute:minute,pointerId:event.pointerId,source:event.currentTarget,capture,point:{x:event.clientX,y:event.clientY}};
  capture.setPointerCapture(event.pointerId);
}
function startDaySelection(event){
  if(isPhone.value)return; // Phone taps select a day; the range picker handles multi-day creation.
  if(event.button!==0 || event.target.closest('[data-event],.cron-cal-day-add,.cron-cal-more'))return;
  const cell=event.target.closest('[data-date]');if(!cell)return;
  beginSelection(event,cell.dataset.date,'dates');
}
function startSelection(event,day){
  if(event.button!==0 || event.target.closest('[data-event]'))return;
  beginSelection(event,day,'time');
}
function updateSelectionPoint(event){
  const selection=drag.value;if(!selection)return;
  const selector=selection.kind==='dates'?'[data-date]':'[data-time-date]';
  const hit=document.elementFromPoint?.(event.clientX,event.clientY)?.closest(selector);
  if(hit && viewport.value?.contains(hit)){
    const key=selection.kind==='dates'?hit.dataset.date:hit.dataset.timeDate;
    selection.endDay=key<today.value?today.value:key;
  }
  if(selection.kind==='time')selection.minute=selection.endDay===selection.day?slotMinute(event):selection.firstMinute;
  selectedMinute.value=selection.minute;selection.point={x:event.clientX,y:event.clientY};
}
function scrollSelection(){
  scrollFrame=null;const selection=drag.value,el=viewport.value;if(!selection || !el)return;
  const rect=el.getBoundingClientRect(),y=selection.point.y;
  const amount=y<rect.top+28?-9:y>rect.bottom-28?9:0;
  if(!amount)return;const previous=el.scrollTop;el.scrollTop+=amount;
  if(previous===el.scrollTop)return;
  updateSelectionPoint({clientX:selection.point.x,clientY:y,currentTarget:selection.source});
  scrollFrame=window.requestAnimationFrame(scrollSelection);
}
function cancelSelection(){drag.value=null;if(scrollFrame!=null)window.cancelAnimationFrame(scrollFrame);scrollFrame=null;}
function moveSelection(event){
  if(drag.value?.pointerId!==event.pointerId)return;updateSelectionPoint(event);
  if(scrollFrame==null && window.requestAnimationFrame)scrollFrame=window.requestAnimationFrame(scrollSelection);
}
async function finishSelection(event){
  if(drag.value?.pointerId!==event.pointerId)return;
  const {day,endDay,minute,kind,capture}=drag.value,span=dateSpan(day,endDay);cancelSelection();capture.releasePointerCapture(event.pointerId);
  if(kind==='dates' && span.count===1)return;
  if(span.count>1)suppressDayClickUntil=Date.now()+300;
  const element=event.currentTarget,x=event.clientX,y=event.clientY;
  const anchor={contextElement:element,getBoundingClientRect:()=>({x,y,left:x,right:x,top:y,bottom:y,width:0,height:0})};
  await createAt(span.start,{currentTarget:anchor},minute,span.count>1?span.end:'');
}
async function slotKeydown(event,day,minute){
  const delta={ArrowUp:-30,ArrowDown:30}[event.key];
  if(delta==null)return;event.preventDefault();selectedDay.value=dateKey(day);selectedMinute.value=Math.max(0,Math.min(1410,minute+delta));
  await nextTick();viewport.value?.querySelector(`[data-slot="${dateKey(day)}-${selectedMinute.value}"]`)?.focus();
}
function tick(){now.value=new Date();if(!document.hidden && !loading.value && !disposed && !drag.value)load(true);}
watch(()=>[range.value.start,range.value.end,props.folderId,props.search,props.enabled],()=>load(),{immediate:true});
watch(()=>props.refreshKey,()=>load(true));
onMounted(()=>{timer=window.setInterval(tick,30000);document.addEventListener('visibilitychange',tick);});
onBeforeUnmount(()=>{disposed=true;cancelSelection();query.dispose();window.clearInterval(timer);document.removeEventListener('visibilitychange',tick);});
defineExpose({canLeave,createAt,createSelected,selectedDay,load});
</script>
<template>
  <section class="cron-calendar" :class="{'is-month-view':view==='month'}" aria-label="任务日历">
    <header class="cron-cal-toolbar">
      <div class="cron-cal-heading"><CalendarDays :size="19" :stroke-width="1.5" /><h2>{{ title }}</h2><span v-if="data" class="cron-cal-count">{{ number(data.totalJobs) }} 个任务</span></div>
      <div class="cron-cal-navigation"><button class="cron-cal-icon-button" type="button" aria-label="上一个日期范围" @click="move(-1)"><ChevronLeft :size="17" /></button><button class="cron-cal-today-button" type="button" @click="goToday">今天</button><button class="cron-cal-icon-button" type="button" aria-label="下一个日期范围" @click="move(1)"><ChevronRight :size="17" /></button></div>
      <div class="cron-cal-segments" role="group" aria-label="日历视图"><button v-for="[key,text] in CALENDAR_VIEWS" :key="key" type="button" :aria-pressed="view===key" @click="setView(key)">{{ text }}</button></div>
    </header>
    <div v-if="error" class="cron-alert" role="alert">日历加载失败：{{ error }} <el-button link @click="load()">重试</el-button></div>
    <div v-for="warning in data?.warnings || []" :key="warning" class="cron-alert" role="alert">{{ warning }}</div>
    <div class="cron-cal-board" :class="{'is-selecting':Boolean(drag)}" :aria-busy="loading" @selectstart.prevent>
      <div v-if="loading && !data" class="cron-cal-loading" role="status"><RefreshCw :size="17" class="is-spinning" />正在读取日历…</div>
      <div ref="viewport" class="cron-cal-viewport" :class="{'is-timeline':view!=='month'}">
        <template v-if="view==='month'">
          <div class="cron-cal-weekdays"><span v-for="day in WEEKDAYS" :key="day">{{ day }}</span></div>
          <div class="cron-cal-month" :style="monthStyle" role="grid" :aria-label="title" aria-multiselectable="true" @pointerdown="startDaySelection" @pointermove="moveSelection" @pointerup="finishSelection" @pointercancel="cancelSelection" @lostpointercapture="cancelSelection">
            <div v-for="day in days" :key="day.key" class="cron-cal-day" :class="{'is-outside':day.outside,'is-past':day.past,'is-weekend':day.weekend,'is-today':day.key===today,'is-selected':day.key===selectedDay,'is-range':inSelection(day.key),'is-range-start':selectedSpan?.start===day.key,'is-range-end':selectedSpan?.end===day.key}" role="gridcell" :aria-label="`${dayLabel(day.date)}，${eventsFor(day.key).length} 项`" :aria-selected="Boolean(inSelection(day.key) || day.key===selectedDay)" :tabindex="day.key===selectedDay?0:-1" :data-date="day.key" @click.self="selectDay(day.key)" @dblclick.self="createAt(day.date,$event)" @keydown="dayKeydown($event,day.date)">
              <button v-if="isPhone" type="button" class="cron-cal-mobile-day" :aria-label="`${dayLabel(day.date)}，${day.tags.map(tag=>tag.label).join('、')}，${eventsFor(day.key).length} 项任务`" :aria-pressed="day.key===selectedDay" @click.stop="selectDay(day.key)" @dblclick.stop>
                <span class="cron-cal-mobile-date"><strong>{{ day.date.getDate() }}</strong><small v-if="compactTag(day.tags)" :data-kind="compactTag(day.tags).kind" :title="compactTag(day.tags).label">{{ compactTag(day.tags).short }}</small></span>
                <span class="cron-cal-mobile-count"><template v-if="eventsFor(day.key).length"><CronStatusIcon v-for="status in dayStates(day.key)" :key="status" :status="status" /><span>{{ number(eventsFor(day.key).length) }}</span></template></span>
              </button>
              <div v-if="!isPhone" class="cron-cal-day-head" @click.self="selectDay(day.key)" @dblclick.self="createAt(day.date,$event)"><button type="button" class="cron-cal-day-number" :aria-current="day.key===today?'date':undefined" :aria-label="`选择 ${dayLabel(day.date)}`" @click="selectDay(day.key)" @dblclick.stop="createAt(day.date,$event)">{{ day.date.getDate() }}</button><span class="cron-cal-day-tags"><span v-for="tag in day.tags" :key="tag.label" class="cron-cal-date-tag" :data-kind="tag.kind" :title="tag.label">{{ tag.label }}</span></span><button v-if="!day.past" type="button" class="cron-cal-day-add" :aria-label="`在 ${dayLabel(day.date)} 新建任务`" @click.stop="createAt(day.date,$event)"><Plus :size="13" /></button></div>
              <button v-for="item in isPhone?[]:eventsFor(day.key).slice(0,3)" :key="item.id" data-event type="button" class="cron-cal-event" :data-tone="statusInfo(item.status).tone" :title="eventSummary(item)" @click.stop="selectEvent(item,$event)" @dblclick.stop><CronStatusIcon :status="item.status" /><span class="cron-cal-event-name">{{ item.name }}</span><span class="cron-cal-event-time">{{ item.count>1?`${number(item.count)}次`:clockText(item.at) }}</span></button>
              <button v-if="!isPhone && eventsFor(day.key).length>3" type="button" class="cron-cal-more" @click.stop="openAgenda(day.date,$event)">还有 {{ eventsFor(day.key).length-3 }} 项…</button>
            </div>
          </div>
        </template>
        <div v-else class="cron-cal-timeline" :class="{'is-day-view':view==='day'}" :style="timelineStyle">
          <div class="cron-cal-time-header"><span class="cron-cal-zone" :title="timezone">本地<br />时间</span><button v-for="day in days" :key="day.key" type="button" :class="{'is-today':day.key===today,'is-selected':day.key===selectedDay}" @click="selectDay(day.key)"><strong>{{ day.date.getDate() }}</strong><span><small>{{ WEEKDAYS[(day.date.getDay()+6)%7] }}</small><span class="cron-cal-day-tags"><span v-for="tag in day.tags" :key="tag.label" class="cron-cal-date-tag" :data-kind="tag.kind">{{ tag.label }}</span></span></span></button></div>
          <div v-if="days.some(day=>aggregateEvents(day.key).length)" class="cron-cal-frequent"><span>频繁任务</span><div v-for="day in days" :key="day.key"><button v-for="item in aggregateEvents(day.key)" :key="item.id" type="button" class="cron-cal-event" :data-tone="statusInfo(item.status).tone" :title="eventSummary(item)" @click="selectEvent(item,$event)"><CronStatusIcon :status="item.status" /><span class="cron-cal-event-name">{{ item.name }}</span><span>{{ number(item.count) }}次</span></button></div></div>
          <div class="cron-cal-hours"><div class="cron-cal-ruler"><span v-for="hour in 24" :key="hour" :style="{top:`${(hour-1)*56}px`}">{{ String(hour-1).padStart(2,'0') }}:00</span></div>
            <div v-for="day in days" :key="day.key" class="cron-cal-time-column" :data-time-date="day.key" :class="{'is-weekend':day.weekend,'is-range':inSelection(day.key)}" @pointerdown="startSelection($event,day.date)" @pointermove="moveSelection" @pointerup="finishSelection" @pointercancel="cancelSelection" @lostpointercapture="cancelSelection">
              <button v-for="slot in 48" :key="slot" type="button" class="cron-cal-slot" :disabled="day.past" :data-slot="`${day.key}-${(slot-1)*30}`" :aria-label="`${dayLabel(day.date)} ${String(Math.floor((slot-1)/2)).padStart(2,'0')}:${slot%2?'00':'30'} 新建任务`" :tabindex="day.key===selectedDay && (slot-1)*30===Math.floor(selectedMinute/30)*30?0:-1" @click="keyboardCreate($event,day.date,(slot-1)*30)" @keydown="slotKeydown($event,day.date,(slot-1)*30)" />
              <button v-for="entry in timeEvents(day.key)" :key="entry.item.id" data-event type="button" class="cron-cal-event cron-cal-time-event" :data-tone="statusInfo(entry.item.status).tone" :style="{top:`${Math.min(entry.minute,1410)*56/60}px`,left:`calc(${entry.lane/entry.lanes*100}% + 3px)`,width:`calc(${100/entry.lanes}% - 6px)`}" :title="eventSummary(entry.item)" @click.stop="selectEvent(entry.item,$event)"><CronStatusIcon :status="entry.item.status" /><span class="cron-cal-event-name">{{ entry.item.name }}</span><span class="cron-cal-event-time">{{ clockText(entry.item.at) }}</span></button>
              <div v-if="day.key===today" class="cron-cal-now" :style="{top:`${minuteOfDay(now)*56/60}px`}" aria-label="当前时间" />
              <div v-if="drag?.kind==='time' && inSelection(day.key)" class="cron-cal-time-selection" :style="{top:`${drag.minute*56/60}px`}">{{ clockText(selectedTime(day.date,drag.minute)) }}<template v-if="selectedSpan.count>1"> · 每天</template><template v-else> 新建任务</template></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <section v-if="isPhone && view==='month'" class="cron-cal-mobile-agenda" aria-label="所选日期任务">
      <header><h3>{{ dayLabel(localDay(selectedDay)) }}</h3><span>{{ selectedItems.length }} 项</span><span v-for="tag in selectedTags" :key="tag.label" class="cron-cal-date-tag" :data-kind="tag.kind">{{ tag.label }}</span></header>
      <div class="cron-cal-mobile-agenda-scroll">
        <button v-for="item in selectedItems" :key="item.id" type="button" class="cron-cal-mobile-task" :data-tone="statusInfo(item.status).tone" @click="selectEvent(item,$event)">
          <CronStatusIcon :status="item.status" /><span><strong>{{ item.name }}</strong><small>{{ clockText(item.at) }}<template v-if="item.count>1"> — {{ clockText(item.lastAt) }} · {{ number(item.count) }} 次</template> · {{ statusInfo(item.status).label }}</small></span><ChevronRight :size="15" />
        </button>
        <p v-if="!selectedItems.length" class="cron-cal-mobile-empty">{{ selectedDay<today?'当天没有运行记录':'当天暂无任务，可用顶部“新建任务”安排。' }}</p>
      </div>
    </section>
    <footer class="cron-cal-footer"><div class="cron-cal-selection"><span v-if="selectedSpan?.count>1">{{ selectedSpan.start }} — {{ selectedSpan.end }} · {{ selectedSpan.count }} 天</span><span v-else>{{ dayLabel(localDay(selectedDay)) }}</span><button type="button" :disabled="selectedDay<today" @click="createSelected($event)"><Plus :size="13" />新建任务</button></div><span class="cron-cal-hint">{{ view==='month'?'双击新建 · 按住拖选连续多天':'点击选时间 · 横向拖选多天，每天同一时间' }} · {{ timezone }}</span><div class="cron-cal-legend"><span v-for="status in ['waiting','disabled','running','completed','failed']" :key="status"><CronStatusIcon :status="status" />{{ statusInfo(status).label }}</span></div></footer>
    <p class="cron-cal-caption">过去显示真实执行，未来显示规则预期；暂停不改写历史，到点不补跑。<span v-if="data && !data.items.length"> 当前范围没有安排，点击日期即可开始。</span></p>
    <CronQuickCreate v-if="quick" ref="quickRef" :at="quick.at" :end-date="quick.endDate" :anchor="quick.anchor" :folder-id="folderId" @close="quick=null" @saved="saved" @advanced="advanced" />
    <CronCalendarPopover v-if="agenda" :anchor="agenda.anchor" :title="dayLabel(localDay(agenda.date))" @close="agenda=null"><div class="cron-cal-agenda"><button v-for="item in agendaItems" :key="item.id" type="button" class="cron-cal-agenda-item" @click="selectEvent(item,$event)"><CronStatusIcon :status="item.status" /><span><strong>{{ item.name }}</strong><small>{{ clockText(item.at) }} · {{ statusInfo(item.status).label }}<template v-if="item.count>1"> · {{ number(item.count) }} 次</template></small></span><ArrowUpRight :size="14" /></button></div><template #footer><span /><el-button type="primary" @click="createAt(localDay(agenda.date),$event)">在这一天新建</el-button></template></CronCalendarPopover>
    <CronCalendarPopover v-if="detail" :anchor="detail.anchor" title="任务详情" @close="detail=null">
      <div class="cron-cal-detail-title"><CronStatusIcon :status="detail.item.status" /><h3>{{ detail.item.name }}</h3></div>
      <p class="cron-cal-detail-status" :data-tone="statusInfo(detail.item.status).tone">{{ statusInfo(detail.item.status).label }}<template v-if="detail.item.count>1"> · 共 {{ number(detail.item.count) }} 次</template></p>
      <dl class="cron-cal-detail-facts"><dt>{{ detail.item.projected?'预计时间':'执行时间' }}</dt><dd>{{ time(detail.item.at) }}<template v-if="detail.item.count>1"><br />至 {{ time(detail.item.lastAt) }}</template></dd><dt>所属目录</dt><dd>{{ detail.item.folderPath || detail.item.folderId }}</dd><template v-if="detailJob"><dt>时间规则</dt><dd>{{ scheduleText(detailJob.config?.schedule) }}</dd></template><dt>记录类型</dt><dd>{{ detail.item.projected?'当前规则的未来预期':detail.item.trigger==='manual'?'手动执行记录':'真实运行记录' }}</dd></dl>
      <div v-if="detail.item.count>1" class="cron-cal-result-counts"><span v-for="(count,status) in detail.item.statusCounts" :key="status"><CronStatusIcon :status="status" />{{ statusInfo(status).label }} {{ number(count) }}</span></div>
      <p v-if="detail.item.projected" class="cron-note">{{ detail.item.status==='disabled'?'计划已暂停；这里显示按规则原本安排的时间，不会自动执行。':'实际执行状态会在启动后更新。' }}</p>
      <p v-if="!detailJob && !loading" class="cron-note">任务定义已不可用，运行记录仍保留。</p>
      <p v-if="detailJob?.config?.schedule?.kind!=='at' && detailJob" class="cron-note">编辑、启停与删除作用于整个重复计划，历史记录保留。</p>
      <div class="cron-cal-detail-actions"><el-button v-if="detail.item.runId" @click="detailAction('run-detail')">本次运行详情</el-button><el-button v-if="detail.item.conversationId" @click="detailAction('open-conversation')">打开会话 <ArrowUpRight :size="12" /></el-button><el-button @click="detailAction('history')">全部记录</el-button></div>
      <template #footer><div class="cron-cal-detail-controls"><el-button v-if="detailJob" type="danger" :disabled="busy" @click="detailAction('delete')">删除计划</el-button><el-button v-if="detailJob" :disabled="busy" @click="detailAction('control')">{{ detailJob.enabled?'暂停计划':'启用计划' }}</el-button><el-button v-if="detailJob" :disabled="busy" @click="detailAction('run')">立即执行…</el-button><el-button v-if="detailJob" type="primary" @click="detailAction('edit')">编辑任务</el-button></div></template>
    </CronCalendarPopover>
  </section>
</template>
