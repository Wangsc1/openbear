import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {nextTick, ref} from 'vue';
import {parse, compileScript, compileTemplate} from '@vue/compiler-sfc';
import {pendingConversationRows, pendingFolderCounts, activityState, applyActivityReadVersions} from './conversationActivity.js';
const waiting = (id, folderId='child') => ({conversationUuid:id,folderId,title:id,running:true,activityState:'waiting',activityVersion:1,activityReadVersion:1,activityPending:[{interactionId:`${id}-1`,action:'confirm'},{interactionId:`${id}-2`,action:'select'}]});

test('all live waiting conversations are included once, independently of recency and read receipts', () => {
  const row=waiting('old');
  const status={items:[row],activityItems:[row],recentItems:Array.from({length:15},(_,i)=>({conversationUuid:`recent-${i}`,activityState:'completed'}))};
  assert.deepEqual(pendingConversationRows(status).map(row=>row.conversationUuid),['old']);
  assert.equal(pendingConversationRows(applyActivityReadVersions(status,new Map([['old',99]]))).length,1);
  assert.equal(activityState({...row,running:false,readWhileSelected:true}), 'waiting');
  const answered={...row,activityPending:[],activityState:'running'};
  assert.deepEqual(pendingConversationRows({...status,items:[answered],activityItems:[answered]}),[]);
  assert.deepEqual(pendingConversationRows({items:[{...row,archived:true},{...waiting('draft'),local:true}]}),[]);
  const notRunning={...row,running:false,activityUnread:false};
  assert.equal(applyActivityReadVersions({activityItems:[notRunning]}).activityItems.length,1);
});
test('folder aggregation follows IDs through unloaded ancestors, counts conversations not forms and handles temporary/moved rows', () => {
  const folders=[{folderId:'root',parentId:''},{folderId:'child',parentId:'root'},{folderId:'other',parentId:'root'}];
  const rows=[waiting('one'),waiting('two'),waiting('three','other'),waiting('tmp',''),waiting('one')];
  assert.deepEqual(Object.fromEntries(pendingFolderCounts(rows,folders)),{child:2,root:3,other:1,__temporary:1});
  assert.deepEqual(Object.fromEntries(pendingFolderCounts([waiting('one','other')],folders)),{other:1,root:1});
  assert.deepEqual(Object.fromEntries(pendingFolderCounts([],folders)),{});
  assert.equal(pendingFolderCounts([waiting('one')],[{folderId:'child',parentId:'root'},{folderId:'root',parentId:'child'}]).get('root'),1);
});
test('global list navigation selects the exact live request without sending, and respects expired targets and navigation guards', async () => {
  const source=fs.readFileSync(new URL('./App.vue',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function openPendingConversation('),source.indexOf('const showArchivedConversations'));
  const row=waiting('background'),events=[];
  const ctx=vm.createContext({pendingConversations:ref([row]),active:ref('console'),activeConversationUuid:ref('current'),nextTick,
    ElMessage:{info:message=>events.push(['info',message])},consoleViewRef:ref({focusPendingInteraction:target=>events.push(['focus',target.interactionId])}),
    openConversation:async row=>{ctx.activeConversationUuid.value=row.conversationUuid;events.push(['open',row.conversationUuid]);},
  });
  vm.runInContext(code,ctx);ctx.selection={row,interactionId:'background-2'};
  await vm.runInContext('openPendingConversation(selection)',ctx);
  assert.deepEqual(events,[['open','background'],['focus','background-2']]);
  events.length=0;ctx.activeConversationUuid.value='current';ctx.openConversation=async()=>{};
  await vm.runInContext('openPendingConversation(selection)',ctx);assert.deepEqual(events,[]);
  ctx.pendingConversations.value=[];
  await vm.runInContext('openPendingConversation(selection)',ctx);assert.equal(events[0][0],'info');
  assert.match(source, /@show-pending="pendingConversationsOpen = true"/);
  assert.match(source, /@activity-status="treeActivityStatus = \$event"/);
  assert.match(source, /<PendingConversations[^>]*@open-conversation="openPendingConversation"/);
});
test('pending list compiles with its actual bindings and keeps phone dismissal separate from scroll and navigation', () => {
  const source=fs.readFileSync(new URL('./components/PendingConversations.vue',import.meta.url),'utf8');
  const {descriptor}=parse(source);
  const script=compileScript(descriptor,{id:'pending'});
  const result=compileTemplate({source:descriptor.template.content,filename:'PendingConversations.vue',id:'pending',compilerOptions:{bindingMetadata:script.bindings}});
  assert.deepEqual(result.errors,[]);
  assert.match(source, /@closed="closed"/);
  assert.match(source, /if \(selected\) emit\('open-conversation', selected\)/);
  assert.match(source, /\.pending-header \{ touch-action:none/);
  assert.match(source, /leave-from \.pending-conversations \{ transform:translateY\(var\(--pending-drag-y,0px\)\)/);
  assert.doesNotMatch(source, /@touchmove.*pending-content|answerConversationConfirmation/);
});
