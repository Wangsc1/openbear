import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import * as Vue from 'vue';
import {renderToString} from '@vue/server-renderer';
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc';
import * as calendar from './cronCalendar.js';
import * as config from './cronConfig.js';
import * as cron from './useCron.js';
const read=file=>fs.readFileSync(new URL(file,import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<30;i++)await Vue.nextTick();};
function harness(file,{props={},...extra}={}){
  const scope=Vue.effectScope(),events=[],cleanups=[],mounts=[];
  const ctx={...Vue,...calendar,...config,...cron,useAdminPhone:()=>Vue.ref(false),defineProps:()=>props,defineEmits:()=> (...args)=>events.push(args),defineExpose(){},onBeforeUnmount:fn=>cleanups.push(fn),onMounted:fn=>mounts.push(fn),
    ElMessage:{success(){}},ElMessageBox:{confirm:async()=>{}},window:{addEventListener(){},removeEventListener(){},setInterval(){return 1;},clearInterval(){}},document:{hidden:false,addEventListener(){},removeEventListener(){}},...extra};
  vm.createContext(ctx);scope.run(()=>vm.runInContext(parse(read(file)).descriptor.scriptSetup.content.replace(/^import .*;\n/gm,''),ctx));
  return {ctx,events,mounts,run:code=>vm.runInContext(code,ctx),close(){cleanups.forEach(fn=>fn());scope.stop();}};
}
function fixture(){
  const calls=[];return {calls,api:{cronPreview:async()=>({times:['2099-10-05T12:00:00Z']}),cronEnvironment:async()=>({runtimes:[]}),rathOptions:async()=>({models:[{key:'m',thinkingLevels:['off']}]}),cronFolders:async()=>({items:[{id:'F',name:'Folder'}]}),conversationFolderProperties:async()=>({runDefaults:{fallback:{mainModel:'m',mainThinkingLevel:'off'}}}),createCronJob:async body=>{calls.push(config.clone(body));return {job:{...config.clone(body),id:'J',revision:1}};}}};
}
const data=()=>({items:[],jobs:[],totalJobs:0,warnings:[],now:new Date().toISOString()});
const calendarProps=()=>({folderId:'F',search:'',enabled:'',refreshKey:0,busy:false});

test('calendar deletion forwards the whole plan to the existing confirmation, and never deletes history by itself',async()=>{
  const job={id:'J',name:'Daily',revision:4,enabled:false},item={id:'projection:J',jobId:'J',name:'Daily',status:'disabled',at:'2099-10-05T12:00:00Z',count:1};
  const h=harness('./CronCalendar.vue',{props:calendarProps(),Api:{cronCalendar:async()=>({...data(),items:[item],jobs:[job]})}});await flush();
  h.ctx.item=item;h.run("detail.value={item};detailAction('delete')");
  assert.equal(h.run('detail.value'),null);assert.equal(h.events.length,1);assert.equal(h.events[0][0],'delete');assert.deepEqual(config.clone(h.events[0][1]),job);
  h.run("data.value.jobs=[];detail.value={item};detailAction('delete')");assert.equal(h.events.length,1,'retained history without a plan cannot request deletion');
  assert.match(read('CronCalendar.vue'),/v-if="detailJob" type="danger" :disabled="busy" @click="detailAction\('delete'\)"/);
  assert.match(read('../../views/CronView.vue'),/@delete="prepareDelete"/);h.close();
});
test('calendar stays open while shared delete confirmation supports cancel and refreshes only after confirmed deletion',async()=>{
  const calls=[],io=fixture();
  const h=harness('../../views/CronView.vue',{props:{folderId:'F'},Api:{...io.api,cronJobs:async()=>({items:[],total:0}),
    cronDeleteImpact:async(id,body)=>{calls.push(['impact',id,body]);return {impact:{activeRuns:1,retainedRuns:3},confirmationToken:'grant'};},
    deleteCronJob:async(id,body)=>{calls.push(['delete',id,body]);return {job:{id,scheduleState:'deleted'}};}}});await flush();
  h.ctx.target={id:'J',name:'Daily',revision:4};await h.run('prepareDelete(target)');
  assert.equal(h.run('deleteOpen.value'),true);assert.equal(calls.filter(c=>c[0]==='delete').length,0);
  h.run('closeDelete()');await h.run('remove()');assert.equal(calls.filter(c=>c[0]==='delete').length,0);assert.equal(h.run('refreshKey.value'),0);
  await h.run('prepareDelete(target)');await h.run('remove()');assert.equal(calls.filter(c=>c[0]==='delete').length,1);assert.equal(calls.at(-1)[2].confirmationToken,'grant');
  assert.equal(h.run('deleteOpen.value'),false);assert.equal(h.run('refreshKey.value'),1);assert.equal(h.run('activeTab.value'),'calendar');h.close();
});

test('phone month selects a date without drag capture and keeps full task names in its daily agenda',async()=>{
  const name='这是一条应当完整显示而不是挤在七列日期里的很长任务名称';
  const item={id:'phone-task',jobId:'J',name,date:'2099-10-06',at:'2099-10-06T12:00:00Z',lastAt:'2099-10-06T12:00:00Z',count:1,status:'disabled'};
  const h=harness('./CronCalendar.vue',{props:calendarProps(),useAdminPhone:()=>Vue.ref(true),Api:{cronCalendar:async()=>({...data(),items:[item],annotations:[{date:'2099-10-06',tags:[{label:'国庆节',kind:'holiday'}]}]})}});await flush();
  h.run('startDaySelection({})');assert.equal(h.run('drag.value'),null,'touch taps must not be captured as range drags');
  h.run("selectDay('2099-10-06')");assert.equal(h.run('selectedItems.value[0].name'),name);assert.equal(h.run('selectedTags.value[0].label'),'国庆节');
  assert.equal(h.run("compactTag(selectedTags.value).short"),'休');
  h.ctx.item=item;h.run('selectEvent(item,{currentTarget:null})');assert.equal(h.run('detail.value.item.id'),item.id);
  h.run('detail.value=null');await h.run('createSelected({})');assert.equal(calendar.dateKey(h.run('quick.value.at')),'2099-10-06');
  h.run("selectDay('2099-10-07')");assert.equal(h.run('selectedItems.value.length'),0);h.close();
});
test('phone layout keeps the month fixed and scrolls only full-name daily tasks; desktop controls remain outside the media override',()=>{
  const css=read('cronCalendar.css'),phone=css.slice(css.indexOf('@media(max-width:760px)'));
  assert.match(phone,/\.cron-view-scroll>\.cron-filters\{display:none\}/);
  assert.match(phone,/\.cron-cal-selection,\.cron-cal-hint,\.cron-cal-caption\{display:none\}/);
  assert.match(phone,/\.cron-calendar.is-month-view \.cron-cal-viewport\{overflow:hidden;/);
  assert.match(phone,/\.cron-cal-mobile-agenda-scroll\{[^}]*overflow-y:auto/);
  assert.match(phone,/\.cron-cal-mobile-task strong\{[^}]*white-space:normal;overflow-wrap:anywhere/);
  assert.match(phone,/\.cron-cal-detail-controls\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css.slice(0,css.indexOf('@media(max-width:760px)')),/cron-cal-mobile|cron-filters\{display:none/);
});

test('month, week and day ranges are complete local calendar ranges, including leap year and year boundary',()=>{
  const october=calendar.calendarRange('2026-10-05','month');assert.equal(calendar.dateKey(october.days[0]),'2026-09-28');assert.equal(calendar.dateKey(october.days.at(-1)),'2026-11-01');assert.equal(october.days.length,35);
  assert.equal(calendar.calendarRange('2024-02-15','month').days.filter(d=>d.getMonth()===1).length,29);
  const week=calendar.calendarRange('2027-01-01','week');assert.equal(calendar.dateKey(week.days[0]),'2026-12-28');assert.equal(calendar.dateKey(week.days.at(-1)),'2027-01-03');assert.match(calendar.calendarTitle('2027-01-01','week',week.days),/2026.*2027/);
  assert.equal(calendar.dateKey(calendar.moveDate('2026-01-31','month',1)),'2026-02-01');
  assert.equal(calendar.dateKey(calendar.moveDate('2026-12-31','day',1)),'2027-01-01');
});
test('date-only values and day lengths remain correct in negative-offset DST timezone',()=>{
  const output=execFileSync(process.execPath,['--input-type=module','-e',`import {calendarRange,dateKey,localDay,selectedTime} from './src/components/cron/cronCalendar.js';
    const a=calendarRange('2026-03-08','day'),b=calendarRange('2026-11-01','day');
    console.log(JSON.stringify([dateKey('2026-03-08'),dateKey(localDay('2026-03-08')),Date.parse(a.end)-Date.parse(a.start),Date.parse(b.end)-Date.parse(b.start),selectedTime('2026-03-08',540)]));`],{cwd:new URL('../../../',import.meta.url),env:{...process.env,TZ:'America/New_York'}}).toString();
  assert.deepEqual(JSON.parse(output),['2026-03-08','2026-03-08',23*3600000,25*3600000,'2026-03-08T13:00:00.000Z']);
});
test('quick scheduling emits real existing at/cron contracts; ordinary defaults stay disabled',()=>{
  const at=new Date(2099,9,5,14,45).toISOString();
  assert.equal(calendar.scheduleFor(at,'once').at,at);
  assert.equal(calendar.scheduleFor(at,'daily','Asia/Shanghai').expression,'45 14 * * *');
  assert.equal(calendar.scheduleFor(at,'weekly').expression,`45 14 * * ${new Date(at).getDay()}`);
  assert.equal(calendar.scheduleFor(at,'monthly').expression,'45 14 5 * *');
  const draft=calendar.calendarDraft(at,'F');assert.equal(draft.enabled,false);assert.equal(draft.config.schedule.kind,'at');assert.equal(draft.folderId,'F');
});
test('each occurrence keeps its own icon, date and status; grouped high-frequency items are excluded from time markers',()=>{
  const items=[{id:'1',jobId:'J',name:'Daily',at:new Date(2026,9,4,9).toISOString(),date:'2026-10-04',status:'failed',count:1},{id:'2',jobId:'J',name:'Daily',at:new Date(2026,9,5,9).toISOString(),date:'2026-10-05',status:'completed',count:1},{id:'3',jobId:'J',name:'Daily',at:new Date(2026,9,6,9).toISOString(),date:'2026-10-06',status:'disabled',count:1}];
  const byDay=calendar.eventsByDate(items);assert.equal(byDay.get('2026-10-04')[0].status,'failed');assert.equal(byDay.get('2026-10-05')[0].status,'completed');
  assert.equal(calendar.statusInfo('running').icon,'LoaderCircle');assert.equal(calendar.statusInfo('disabled').label,'已暂停');assert.equal(calendar.statusInfo('waiting').label,'待运行');
  const timeline=calendar.timeLayout([items[1],{...items[1],id:'4'},{...items[1],id:'group',count:24}]);assert.equal(timeline.length,2);assert.equal(timeline[0].lanes,2);assert.equal(timeline[1].lane,1);
});
test('calendar editor seed is clean, transferred typing stays dirty, and saving retains the selected time',async()=>{
  const io=fixture(),editor=cron.createCronEditor(io.api,{requestId:()=> 'seed'}),draft=calendar.calendarDraft('2099-10-05T09:30:00Z','F');
  assert.equal(await editor.load('','F',{draft}),true);assert.equal(editor.dirty.value,false);editor.draft.name='From calendar';await editor.save();assert.equal(io.calls[0].config.schedule.at,draft.config.schedule.at);
  const second=cron.createCronEditor(io.api);await second.load('','F',{draft:{...draft,name:'Transferred'},dirty:true});assert.equal(second.dirty.value,true);editor.dispose();second.dispose();
});
test('quick create saves configured date, enabled state, instructions and daily repetition through the existing editor',async()=>{
  const io=fixture(),h=harness('./CronQuickCreate.vue',{props:{at:new Date(2099,9,5,14,45).toISOString(),endDate:'2099-10-07',folderId:'F'},Api:io.api});await flush();
  assert.equal(h.run('dirty.value'),false);h.run("draft.name='Daily report';draft.config.instructions='Summarize this project';draft.enabled=true;repeat.value='daily'");await flush();
  assert.equal(await h.run('save()'),true);assert.equal(io.calls.length,1);assert.equal(io.calls[0].config.schedule.expression,'45 14 * * *');assert.equal(io.calls[0].enabled,true);assert.equal(io.calls[0].config.instructions,'Summarize this project');assert.equal(h.events[0][0],'saved');h.close();
});
test('quick-create cancel retains draft, in-flight save prevents closing, and full configuration transfers all typed fields',async()=>{
  const io=fixture(),h=harness('./CronQuickCreate.vue',{props:{at:'2099-10-05T09:00:00Z',folderId:'F'},Api:io.api,ElMessageBox:{confirm:async()=>{throw Error('cancel');}}});await flush();
  h.run("draft.name='Keep';draft.config.instructions='Original instruction'");await h.run('close()');assert.equal(h.events.length,0);assert.equal(h.run('draft.name'),'Keep');
  h.run('saving.value=true');assert.equal(await h.run('canLeave()'),false);h.run('saving.value=false;advanced()');assert.equal(h.events[0][0],'advanced');assert.equal(h.events[0][1].draft.config.instructions,'Original instruction');assert.equal(h.events[0][1].dirty,true);h.close();
});
test('invalid or past quick task is not submitted, and empty enabled instructions remain blocked',async()=>{
  const io=fixture(),h=harness('./CronQuickCreate.vue',{props:{at:'2000-01-01T09:00:00Z',folderId:'F'},Api:io.api});await flush();h.run("draft.name='Past'");assert.equal(await h.run('save()'),false);assert.match(h.run('localError.value'),/今天或之后/);assert.equal(io.calls.length,0);
  h.run("dates.value=['2099-01-01','2099-01-01'];timeOfDay.value='09:00:00';draft.enabled=true");await flush();assert.equal(await h.run('save()'),false);assert.ok(h.run("errors.value.some(e=>e.path==='instructions')"));h.close();
});
test('calendar loads the full visible range and filters, stale requests cannot overwrite a newer month',async()=>{
  const requests=[],replies=[];const props=Vue.reactive(calendarProps());const h=harness('./CronCalendar.vue',{props,Api:{cronCalendar:p=>{requests.push(p);return new Promise(resolve=>replies.push(resolve));}}});
  assert.equal(requests.length,1);assert.equal(requests[0].folderId,'F');assert.equal('limit' in requests[0],false);assert.ok(requests[0].timezone);
  await h.run('move(1)');await flush();assert.equal(requests.length,2);replies[1]({...data(),totalJobs:2});await flush();replies[0]({...data(),totalJobs:1});await flush();assert.equal(h.run('data.value.totalJobs'),2);
  props.enabled=false;props.search='Report';await flush();assert.equal(requests.at(-1).enabled,false);assert.equal(requests.at(-1).search,'Report');h.close();
});
test('calendar anchors creation before event dispatch ends and pointer drag selects an exact quarter-hour',async()=>{
  const h=harness('./CronCalendar.vue',{props:calendarProps(),Api:{cronCalendar:async()=>data()}});await flush();
  const rect={top:0,left:0,right:200,bottom:1344,width:200,height:1344};const target={isConnected:true,getBoundingClientRect:()=>rect,setPointerCapture(){},releasePointerCapture(){}};
  h.ctx.event={currentTarget:target};const pending=h.run("createAt('2099-10-05',event)");h.ctx.event.currentTarget=null;await pending;assert.equal(h.run('quick.value.anchor.getBoundingClientRect().width'),200);
  h.run('quick.value=null');h.ctx.pointer={currentTarget:target,clientY:14*56+14,clientX:100,button:0,pointerId:1,target:{closest:()=>null},preventDefault(){}};
  h.run("startSelection(pointer,new Date(2099,9,5))");assert.equal(h.run('drag.value.minute'),855);h.ctx.pointer.clientY=14*56+28;h.run('moveSelection(pointer)');assert.equal(h.run('drag.value.minute'),870);await h.run('finishSelection(pointer)');assert.equal(h.run('new Date(quick.value.at).getHours()'),14);assert.equal(h.run('new Date(quick.value.at).getMinutes()'),30);h.close();
});
test('calendar guarded navigation keeps an unfinished quick task and its month',async()=>{
  const h=harness('./CronCalendar.vue',{props:calendarProps(),Api:{cronCalendar:async()=>data()}});await flush();const before=h.run('focus.value.getTime()');h.run('quick.value={};quickRef.value={canLeave:async()=>false}');await h.run('move(1)');assert.equal(h.run('focus.value.getTime()'),before);assert.notEqual(h.run('quick.value'),null);h.close();
});
test('live refresh retains the visible grid and updates an open occurrence, without running a job',async()=>{
  const item={id:'R',jobId:'J',name:'Report',status:'running',at:'2026-10-05T09:00:00Z',count:1,runId:'R'};let resolve;
  const h=harness('./CronCalendar.vue',{props:calendarProps(),Api:{cronCalendar:async()=>({...data(),items:[item]})}});await flush();h.ctx.item=item;h.run('detail.value={item};');h.ctx.Api.cronCalendar=()=>new Promise(r=>resolve=r);const pending=h.run('load(true)');assert.equal(h.run('data.value.items.length'),1);resolve({...data(),items:[{...item,status:'completed'}]});await pending;assert.equal(h.run('detail.value.item.status'),'completed');h.run("detailAction('run-detail')");assert.deepEqual(h.events,[['run-detail','R']]);h.close();
});
test('page leave guard includes the quick calendar editor and passing to advanced configuration preserves the draft',async()=>{
  const io=fixture(),h=harness('../../views/CronView.vue',{props:{folderId:'F'},Api:{...io.api,cronJobs:async()=>({items:[],total:0})}});await flush();
  h.run('calendarRef.value={canLeave:async()=>false}');assert.equal(await h.run('canLeave()'),false);await h.run("selectTab('jobs')");assert.equal(h.run('activeTab.value'),'calendar');
  h.run('calendarRef.value={canLeave:async()=>true}');h.ctx.seed={draft:{...calendar.calendarDraft('2099-10-05T09:00:00Z','F'),name:'Keep'},dirty:true};await h.run('advanced(seed)');assert.equal(h.run('editorInitial.value.draft.name'),'Keep');assert.equal(h.run('editorOpen.value'),true);h.close();
});
test('calendar SFC templates compile and all event states use the shared theme',()=>{
  for(const file of ['CronCalendar.vue','CronCalendarPopover.vue','CronQuickCreate.vue','CronStatusIcon.vue']){const {descriptor,errors}=parse(read(file));assert.deepEqual(errors,[]);const script=compileScript(descriptor,{id:file});const result=compileTemplate({source:descriptor.template.content,filename:file,id:file,compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(result.errors,[],file);}
  const css=read('cronCalendar.css');assert.doesNotMatch(css,/#[\da-f]{3,8}\b/i);assert.match(css,/var\(--ob-surface-raised\)/);assert.match(css,/prefers-reduced-motion/);assert.match(read('CronCalendarPopover.vue'),/aria-modal="true"/);
});

for(const count of [3,7,15])test(`drag ${count} dates creates one bounded daily task, including reverse selection`,async()=>{
  const first='2099-10-28',last=calendar.dateKey(calendar.addDays(first,count-1));
  for(const reverse of [false,true]){
    const h=harness('./CronCalendar.vue',{props:calendarProps(),Api:{cronCalendar:async()=>data()}});await flush();
    const begin=reverse?last:first,end=reverse?first:last;
    const captured=[],cell={dataset:{date:begin},setPointerCapture:id=>captured.push(id),releasePointerCapture:id=>captured.push(-id)};
    const grid={getBoundingClientRect:()=>({x:0,y:0,top:0,left:0,width:700,height:600})};
    h.ctx.pointer={button:0,pointerId:8,clientX:10,clientY:10,currentTarget:grid,target:{closest:selector=>selector==='[data-date]'?cell:null},preventDefault(){}};
    h.run('viewport.value={contains:()=>true};startDaySelection(pointer)');assert.deepEqual(captured,[8],'capture the date cell, not the grid, so native double-click keeps its target');
    h.ctx.document.elementFromPoint=()=>({closest:()=>({dataset:{date:end}})});h.run('moveSelection(pointer)');assert.equal(h.run('selectedSpan.value.count'),count);
    await h.run('finishSelection(pointer)');assert.equal(h.run('quick.value.endDate'),last);assert.equal(calendar.dateKey(h.run('quick.value.at')),first);assert.equal(h.run('new Date(quick.value.at).getHours()'),12);assert.deepEqual(captured,[8,-8]);
    h.run(`selectDay('${begin}')`);assert.equal(h.run('pickedSpan.value.count'),count,'trailing native click must not clear the range');
    const io=fixture(),quick=harness('./CronQuickCreate.vue',{props:{at:h.run('quick.value.at'),endDate:last,folderId:'F'},Api:io.api});await flush();assert.equal(quick.run('dirty.value'),false);quick.run("draft.name='Date range';draft.config.instructions='Only the selected dates';draft.enabled=true");assert.equal(await quick.run('save()'),true);
    assert.equal(io.calls.length,1);assert.equal(io.calls[0].config.schedule.expression,'0 12 * * *');assert.equal(io.calls[0].config.schedule.startAt,calendar.selectedTime(first,720));assert.equal(io.calls[0].config.schedule.endAt,calendar.addDays(last,1).toISOString());
    h.close();quick.close();
  }
});
test('weekly horizontal drag keeps the starting time across all selected days',async()=>{
  const h=harness('./CronCalendar.vue',{props:calendarProps(),Api:{cronCalendar:async()=>data()}});await flush();
  const target={getBoundingClientRect:()=>({top:0}),setPointerCapture(){},releasePointerCapture(){}};
  h.ctx.pointer={button:0,pointerId:1,clientX:100,clientY:12*56,currentTarget:target,target:{closest:()=>null},preventDefault(){}};
  h.run("viewport.value={contains:()=>true};startSelection(pointer,new Date(2099,9,5))");
  h.ctx.document.elementFromPoint=()=>({closest:()=>({dataset:{timeDate:'2099-10-07'}})});h.ctx.pointer.clientY=13*56;h.run('moveSelection(pointer)');assert.equal(h.run('drag.value.minute'),720,'diagonal movement must not change daily noon when selecting dates');
  await h.run('finishSelection(pointer)');assert.equal(h.run('quick.value.endDate'),'2099-10-07');assert.equal(h.run('new Date(quick.value.at).getHours()'),12);h.close();
});
test('month single press selects only; double-click creation remains wired and native text selection is disabled only on the board',async()=>{
  const h=harness('./CronCalendar.vue',{props:calendarProps(),Api:{cronCalendar:async()=>data()}});await flush();
  const cell={dataset:{date:'2099-10-05'},setPointerCapture(){},releasePointerCapture(){}};
  h.ctx.pointer={button:0,pointerId:1,clientX:10,clientY:10,currentTarget:{},target:{closest:s=>s==='[data-date]'?cell:null},preventDefault(){}};
  h.run('startDaySelection(pointer)');await h.run('finishSelection(pointer)');assert.equal(h.run('quick.value'),null);assert.equal(h.run('selectedDay.value'),'2099-10-05');
  const source=read('CronCalendar.vue'),css=read('cronCalendar.css');assert.match(source,/@dblclick.self="createAt\(day.date,\$event\)"/);assert.match(source,/@selectstart.prevent/);assert.match(css,/\.cron-cal-board\{[^}]*-webkit-user-select:none;user-select:none/);assert.doesNotMatch(css,/\.cron-cal-popover\{[^}]*user-select:none/);h.close();
});
test('date range, time and dynamic repeats preserve valid choices and advanced transfer',async()=>{
  const io=fixture(),h=harness('./CronQuickCreate.vue',{props:{at:new Date(2099,9,5,12).toISOString(),folderId:'F'},Api:io.api});await flush();
  h.run("dates.value=['2099-10-05','2099-10-07'];timeOfDay.value='12:30:23'");await flush();
  assert.equal(h.run('span.value.count'),3);assert.equal(h.run('repeat.value'),'daily');assert.equal(h.run('draft.config.schedule.second'),23);
  h.run("draft.name='Keep range';advanced()");assert.equal(h.events[0][1].draft.config.schedule.endAt,calendar.addDays('2099-10-07',1).toISOString());
  h.run("dates.value=['2099-10-05','2099-10-04']");await flush();assert.equal(await h.run('save()'),false);assert.match(h.run('localError.value'),/有效日期范围/);assert.equal(io.calls.length,0);h.close();
});
test('bounded rules survive payload and full editor round trip; removing bounds or changing kind is explicit',async()=>{
  const schedule=calendar.scheduleFor(new Date(2099,9,5,12).toISOString(),'daily',undefined,'2099-10-07');
  const payload=config.schedulePayload(schedule);assert.equal(payload.startAt,schedule.startAt);assert.equal(payload.endAt,schedule.endAt);assert.equal(config.scheduleErrors(payload).length,0);
  assert.equal(config.scheduleErrors({...payload,endAt:payload.startAt})[0].path,'schedule.endAt');
  assert.equal('startAt' in config.schedulePayload({...schedule,kind:'at',at:'2099-10-05T12:00:00Z'}),false);
  assert.equal('endAt' in config.schedulePayload({...schedule,startAt:null,endAt:null}),false);
  const io=fixture(),draft=calendar.calendarDraft(new Date(2099,9,5,12).toISOString(),'F','2099-10-07');
  const h=harness('./CronEditor.vue',{props:{jobId:'',folderId:'F',initial:{draft,dirty:true}},Api:io.api});await flush();h.run("draft.name='Full editor'");assert.equal(await h.run('save()'),true);assert.equal(io.calls[0].config.schedule.endAt,schedule.endAt);assert.match(read('CronEditor.vue'),/v-model="draft.config.schedule.endAt"/);h.close();
});

test('repeat choices match the date and time span, not a fixed global list',()=>{
  const choices=(first,end,clock='12:00:00')=>calendar.repeatOptions(new Date(`${first}T${clock}`).toISOString(),end).map(x=>x.value);
  assert.deepEqual(choices('2099-10-05','2099-10-07'),['minutely','hourly','daily']);
  assert.equal(choices('2099-10-05','2099-10-17').includes('weekly'),false);
  assert.equal(choices('2099-10-05','2099-10-18').includes('weekly'),true);
  assert.equal(choices('2099-10-05','2099-11-04').includes('monthly'),false);
  assert.equal(choices('2099-10-05','2099-11-05').includes('monthly'),true);
  assert.equal(choices('2099-01-31','2099-03-02').includes('monthly'),false);
  assert.deepEqual(choices('2099-10-05','2099-10-05','23:59:30'),['once']);
});
test('minute/hour payloads retain seconds, start, end and the independent skip switch',()=>{
  for(const repeat of ['minutely','hourly']){
    const at=new Date(2099,9,5,12,34,56).toISOString();
    const s=config.schedulePayload(calendar.scheduleFor(at,repeat,'Asia/Shanghai','2099-10-07',true));
    assert.equal(s.anchorAt,at);assert.equal(s.startAt,at);assert.equal(s.endAt,calendar.addDays('2099-10-07',1).toISOString());
    assert.equal(s.everySeconds,repeat==='minutely'?60:3600);assert.equal(s.skipHolidays,true);assert.equal(config.scheduleErrors(s).length,0);
  }
});
test('Vue does not cast the all-status empty string to enabled=true',async()=>{
  let definition;
  const h=harness('./CronCalendar.vue',{props:calendarProps(),defineProps:value=>{definition=value;return calendarProps();},Api:{cronCalendar:async()=>data()}});await flush();
  const component={props:definition,setup:props=>()=>Vue.h('span',String(props.enabled))};
  assert.equal(await renderToString(Vue.createSSRApp(component,{enabled:''})),'<span></span>');
  assert.equal(await renderToString(Vue.createSSRApp(component,{enabled:false})),'<span>false</span>');h.close();
});
test('past days cannot create by direct action, keyboard or drag; history remains available',async()=>{
  const h=harness('./CronCalendar.vue',{props:calendarProps(),Api:{cronCalendar:async()=>data()}});await flush();
  await h.run("createAt('2000-01-01',{})");assert.equal(h.run('quick.value'),null);
  h.run("beginSelection({},'2000-01-01','dates')");assert.equal(h.run('drag.value'),null);
  h.run("selectDay('2000-01-01')");assert.equal(h.run('selectedDay.value'),'2000-01-01');h.close();
});
test('holiday skipping permits an unbounded schedule and labels missing data separately',()=>{
  for(const schedule of [{kind:'cron',expression:'0 9 * * *',timezone:'Asia/Shanghai',skipHolidays:true}, {kind:'every',everySeconds:3600,timezone:'Asia/Shanghai',skipHolidays:true}]) {
    assert.deepEqual(config.scheduleErrors(schedule),[]);
    assert.equal(config.schedulePayload(schedule).skipHolidays,true);
    assert.equal(Object.hasOwn(config.schedulePayload(schedule),'endAt'),false);
  }
  assert.equal(config.label('waiting_calendar'),'等待日历数据');
});
test('quick create allows missing-calendar wait but does not claim a date is scheduled',async()=>{
  const io=fixture(),notices=[];io.api.cronPreview=async()=>({times:[],scheduleState:'waiting_calendar',waitingYears:[2099]});
  const h=harness('./CronQuickCreate.vue',{props:{at:new Date(2099,9,5,12).toISOString(),endDate:'2099-10-07',folderId:'F'},Api:io.api,ElMessage:{success:text=>notices.push(text)}});await flush();
  h.run("draft.name='Future';draft.config.instructions='Fixture only';draft.enabled=true;skipHolidays.value=true");await flush();
  assert.equal(await h.run('save()'),true);assert.equal(io.calls.length,1);assert.match(notices[0],/等待日历数据/);h.close();
});
test('shortening a range removes weekly selection; all-skipped preview cannot save',async()=>{
  const io=fixture(),h=harness('./CronQuickCreate.vue',{props:{at:new Date(2099,9,5,12).toISOString(),endDate:'2099-10-20',folderId:'F'},Api:io.api});await flush();
  h.run("repeat.value='weekly'");await flush();assert.equal(h.run('repeat.value'),'weekly');
  h.run("dates.value=['2099-10-05','2099-10-07']");await flush();assert.equal(h.run('repeat.value'),'daily');
  h.ctx.Api.cronPreview=async()=>({times:[]});h.run("skipHolidays.value=true;draft.name='No dates'");await flush();
  assert.equal(await h.run('save()'),false);assert.match(h.run('localError.value'),/没有可执行时间/);assert.equal(io.calls.length,0);h.close();
});
