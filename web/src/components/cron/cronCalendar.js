import {defaultConfig, label} from './cronConfig.js';

export const CALENDAR_VIEWS = [['month','月'],['week','周'],['day','日']];
export const WEEKDAYS = ['周一','周二','周三','周四','周五','周六','周日'];
export const REPEATS = [{value:'once',label:'不重复'}, {value:'minutely',label:'每分钟'}, {value:'hourly',label:'每小时'}, {value:'daily',label:'每天'}, {value:'weekly',label:'每周'}, {value:'monthly',label:'每月'}];
export function repeatOptions(at, endDate) {
  if(!at || !endDate || !Number.isFinite(Date.parse(at)) || dateKey(at)>endDate)return [];
  const d=new Date(at),span=dateSpan(at,endDate),remaining=addDays(endDate,1)-d;
  const nextMonth=new Date(d);nextMonth.setMonth(d.getMonth()+1);
  // A missing monthly date (e.g. Feb 31) is skipped, never clamped or shifted.
  if(nextMonth.getDate()!==d.getDate())nextMonth.setDate(d.getDate());
  return REPEATS.filter(({value})=>({once:span.count===1,minutely:remaining>60000,hourly:remaining>3600000,daily:span.count>=2,weekly:span.count>=14,monthly:dateKey(nextMonth)<=endDate})[value]);
}
const pad = n => String(n).padStart(2,'0');
export function dateKey(value) {
  if(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value))return value;
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
export function localDay(value) {
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  d.setHours(0,0,0,0);return d;
}
export function addDays(value, amount) {const d=localDay(value);d.setDate(d.getDate()+amount);return d;}
export function dateSpan(first, last=first) {
  const [start,end]=[dateKey(first),dateKey(last)].sort();
  return {start,end,count:Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000)+1};
}
export function calendarRange(value, view) {
  const focus=localDay(value);let start=localDay(focus), count=1;
  if(view==='month') {start.setDate(1);const days=new Date(start.getFullYear(),start.getMonth()+1,0).getDate();const lead=(start.getDay()+6)%7;start=addDays(start,-lead);count=Math.ceil((lead+days)/7)*7;}
  if(view==='week') {start=addDays(start,-((start.getDay()+6)%7));count=7;}
  const days=Array.from({length:count},(_,i)=>addDays(start,i));
  return {start:start.toISOString(),end:addDays(start,count).toISOString(),days};
}
export function moveDate(value, view, direction) {
  const d=localDay(value);
  if(view==='month'){d.setDate(1);d.setMonth(d.getMonth()+direction);return d;}
  return addDays(d,direction*(view==='week'?7:1));
}
export function calendarTitle(value, view, days) {
  const d=new Date(value);
  if(view==='month')return `${d.getFullYear()}年 ${d.getMonth()+1}月`;
  if(view==='day')return `${d.getFullYear()}年 ${d.getMonth()+1}月${d.getDate()}日`;
  const a=days[0],b=days.at(-1);
  return a.getFullYear()===b.getFullYear() ? `${a.getFullYear()}年 ${a.getMonth()+1}月${a.getDate()}日 — ${b.getMonth()+1}月${b.getDate()}日` : `${dateKey(a)} — ${dateKey(b)}`;
}
export function clockText(value) {return new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});}
export function dayLabel(value) {return new Date(value).toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});}
export function minuteOfDay(value) {const d=new Date(value);return d.getHours()*60+d.getMinutes();}
export function selectedTime(day, minutes=540) {const d=localDay(day);d.setMinutes(minutes);return d.toISOString();}
export function nextCreationTime(day, now=new Date()) {
  if(dateKey(day)!==dateKey(now))return selectedTime(day);
  const next=new Date(now);next.setMinutes(Math.ceil((next.getMinutes()+1)/15)*15,0,0);return next.toISOString();
}
export function scheduleFor(at, repeat='once', timezone=Intl.DateTimeFormat().resolvedOptions().timeZone, endDate='', skipHolidays=false) {
  const d=new Date(at);
  if(!Number.isFinite(d.getTime()))return {kind:'at',timezone,at:null};
  const extras=skipHolidays?{skipHolidays:true}:{};
  if(repeat==='once')return {kind:'at',timezone,at:d.toISOString(),...extras};
  const bounds=endDate ? {startAt:d.toISOString(),endAt:addDays(endDate,1).toISOString()} : {};
  if(['minutely','hourly'].includes(repeat))return {kind:'every',timezone,everySeconds:repeat==='minutely'?60:3600,anchorAt:d.toISOString(),...bounds,...extras};
  const tail={daily:'* * *',weekly:`* * ${d.getDay()}`,monthly:`${d.getDate()} * *`}[repeat];
  return {kind:'cron',timezone,expression:`${d.getMinutes()} ${d.getHours()} ${tail || '* * *'}`,second:d.getSeconds(),...bounds,...extras};
}
export function calendarDraft(at, folderId='', endDate='') {
  const config=defaultConfig();config.schedule=scheduleFor(at,endDate?'daily':'once',undefined,endDate);
  return {folderId,name:'',description:'',enabled:false,config};
}
export function statusInfo(status) {
  if(['starting','running'].includes(status))return {label:status==='starting'?'启动中':'正在运行',tone:'running',icon:'LoaderCircle'};
  if(status==='completed')return {label:'成功',tone:'success',icon:'CircleCheck'};
  if(['failed','post_failed','timed_out','tokens_exceeded','cost_exceeded','target_missing'].includes(status))return {label:label(status),tone:'danger',icon:'CircleAlert'};
  if(['disabled','paused'].includes(status))return {label:'已暂停',tone:'muted',icon:'CirclePause'};
  if(status==='waiting')return {label:'待运行',tone:'waiting',icon:'Clock3'};
  if(status==='mixed')return {label:'多种运行结果',tone:'mixed',icon:'ChartNoAxesColumnIncreasing'};
  return {label:label(status),tone:'muted',icon:'CircleMinus'};
}
export function eventSummary(item) {
  const state=statusInfo(item.status).label;
  return `${clockText(item.at)} ${item.name} · ${state}${item.count>1?` · ${item.count} 次`:''}`;
}
export function eventsByDate(items=[]) {
  const result=new Map();
  for(const item of items){const key=item.date || dateKey(item.at);if(!result.has(key))result.set(key,[]);result.get(key).push(item);}
  for(const events of result.values())events.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id));
  return result;
}
// A trigger is a point in time, not an appointment with an invented duration.
// Close triggers share lanes so every hit target remains reachable.
export function timeLayout(items=[]) {
  const sorted=items.filter(e=>e.count<=1).map(item=>({item,minute:minuteOfDay(item.at)})).sort((a,b)=>a.minute-b.minute);
  const groups=[];let group=[],end=-1;
  for(const event of sorted){if(event.minute>=end && group.length){groups.push(group);group=[];}group.push(event);end=Math.max(end,event.minute+32);}
  if(group.length)groups.push(group);
  return groups.flatMap(events=>events.map((event,i)=>({...event,lane:i,lanes:events.length})));
}
