import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parse} from '@vue/compiler-sfc';
import {markRaw, nextTick, reactive, ref, toRaw, watch} from 'vue';
import {mergeOperationSnapshots, findTurnIndexByIdentity, stableTurnIdentity} from './timelinePagination.js';
import {applyOperationFrame, isRootRunTerminalFrame, isTerminalOperationFrame, normalizeOperations} from '../../timelineProjection.js';

const source = fs.readFileSync(new URL('./ConsoleView.vue', import.meta.url), 'utf8');
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const deferred = () => { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; };
const operation = (opId, displaySeq, revision = 1) => ({opId, displaySeq, revision, opType:opId.startsWith('user')?'user_message':'assistant_message', payload:{text:opId}, turnUuid:`turn-${displaySeq}`});
function navigationHarness() {
  const ops = [operation('user-new', 200), operation('assistant-new', 210)];
  const props = {conversationUuid:'A'};
  const current = ref('A'), autoScrollLocked = ref(true), searchWindowActive = ref(false), searchReturnPosition = ref(null);
  const searchLocating = ref(false), messages = ref([]), chatState = ref({operations:ops});
  const hasMoreBefore = ref(true), nextBeforeDisplaySeq = ref(190), present = new Map();
  const searchBaseOperationIds = new Set(), searchAddedOperationIds = new Set();
  const el = {scrollTop:900, scrollHeight:2000, clientHeight:300,
    querySelectorAll: () => [...present.values()], querySelector: () => null};
  const scroller = ref(el), calls = [], scrolls = [], errors = [], restores = [], requests = [];
  let operationList = [...ops], expectedAnchor = {index:0, scrollTop:900};
  function node(id, top) {
    const classes = new Set();
    return {dataset:{searchOpId:id},classList:{add:value=>classes.add(value),remove:value=>classes.delete(value)},
      scrollIntoView:()=>{el.scrollTop=top;scrolls.push(id);}, classes};
  }
  present.set('user-new', node('user-new',900));
  const context = vm.createContext({
    ref, nextTick, props, activeConversationUuid:current, autoScrollLocked, searchWindowActive,
    searchReturnPosition, searchLocating, messages, chatState, hasMoreBefore, nextBeforeDisplaySeq,
    searchBaseOperationIds,searchAddedOperationIds,
    scroller, messageVisibility:{hiddenIds:ref(new Set())},
    turns:ref([{turnUuid:'turn-200'}]),
    Api:{conversationOperationWindow:(uuid,id)=>{const request=deferred();requests.push({uuid,id,...request});return request.promise;}},
    ElMessage:{error:e=>errors.push(e)}, apiError:String,
    normalizeOperations, mergeOperationSnapshots, stableTurnIdentity,findTurnIndexByIdentity,
    captureScrollAnchor:()=>({...expectedAnchor}),
    orderedOperationsList:()=>operationList,
    replaceOperationSnapshots:incoming=>{operationList=incoming;
      for(const id of present.keys())if(!incoming.some(op=>op.opId===id))present.delete(id);
      for(const op of incoming)if(!present.has(op.opId))present.set(op.opId,node(op.opId,100));},
    projectOperationMessages:incoming=>incoming,
    unlockAutoScroll:()=>{autoScrollLocked.value=false;},
    lockAutoScroll:()=>{autoScrollLocked.value=true;el.scrollTop=el.scrollHeight;},
    runProgrammaticScroll:fn=>fn(),
    updateScrollerOverflow:()=>{}, scheduleActiveTurnFromScroll:()=>{},
    restoreScrollAnchor:async (anchor,options)=>{await nextTick();if(options.isCurrent()){restores.push(anchor);el.scrollTop=anchor.scrollTop;}},
    window:{clearTimeout:()=>{},setTimeout:()=>1,cancelAnimationFrame:()=>{}},
  });
  vm.runInContext(`let componentMounted = true, searchNavigationGeneration=0, searchHighlightTimer=0, scrollFrame=0,
    pinnedActiveTurnIndex=null, timelinePageInitialized=true, streamFlushPending=false, pendingProjectionOps=null;
    ${between('function searchResultNode(', 'async function loadEarlierOperations()')}`, context);
  const run = code => vm.runInContext(code, context);
  return {run, current, autoScrollLocked, searchWindowActive, searchReturnPosition, searchLocating, messages, chatState,
    hasMoreBefore,nextBeforeDisplaySeq,requests,scrolls,errors,restores,el,present,
    searchBaseOperationIds,searchAddedOperationIds,operationList:()=>operationList,
    anchor:value=>{expectedAnchor=value;}, nodes:node, props};
}

test('actual ConsoleView locator fetches one bounded window, preserves live tail, returns to original anchor and does not follow new frames', async () => {
  const h=navigationHarness();
  const location=h.run("locateSearchResult({opId:'user-old',type:'user_message'})");
  assert.equal(h.requests.length,1);
  assert.deepEqual([h.requests[0].uuid,h.requests[0].id],['A','user-old']);
  assert.equal(h.autoScrollLocked.value,false,'unlock before asynchronous seek so incoming frames cannot follow tail');
  h.requests[0].resolve({operations:[operation('user-old',10),operation('assistant-old',20)],nextBeforeDisplaySeq:10});
  assert.equal(await location,true);
  assert.deepEqual(h.operationList().map(x=>x.opId),['user-old','assistant-old','user-new','assistant-new']);
  assert.equal(h.el.scrollTop,100);
  assert.equal(h.nextBeforeDisplaySeq.value,10);
  assert.equal(h.searchWindowActive.value,true);
  assert.equal(h.searchReturnPosition.value.follow,true);
  assert.equal(h.searchLocating.value,false);
  assert.equal(h.run('searchResultNode("user-old").classes.has("search-hit-highlight")'),true);
  // A new frame is stored at the tail, but a reader who unlocked before the seek
  // remains anchored; the component's real scheduleScrollBottom guard is used.
  const scheduling = vm.createContext({autoScrollLocked:h.autoScrollLocked,window:{requestAnimationFrame:()=>{throw Error('unexpected tail scroll');}},
    scrollFrame:0,scroller:ref(h.el),nextTick,runProgrammaticScroll:fn=>fn(),updateScrollerOverflow:()=>{},scheduleActiveTurnFromScroll:()=>{}});
  vm.runInContext(between('function scheduleScrollBottom(options = {})', 'function cancelScheduledUiWork()'), scheduling);
  vm.runInContext('scheduleScrollBottom({cause:"tail"})',scheduling);
  assert.equal(h.el.scrollTop,100);
  await h.run('returnFromSearch()');
  assert.equal(h.el.scrollTop,h.el.scrollHeight);
  assert.equal(h.autoScrollLocked.value,true);
  assert.equal(h.searchWindowActive.value,false);
  assert.deepEqual(h.operationList().map(op=>op.opId),['user-new','assistant-new']);
  assert.equal(h.nextBeforeDisplaySeq.value,190);
});

test('actual locator discards stale requests on newer selection/return/switch, and restores reading turn after prepending', async () => {
  const h=navigationHarness();
  h.autoScrollLocked.value=false;
  h.anchor({index:0,scrollTop:850});
  const stale=h.run("locateSearchResult({opId:'user-old',type:'user_message'})");
  const newer=h.run("locateSearchResult({opId:'user-other',type:'user_message'})");
  h.requests[1].resolve({operations:[operation('user-other',30)],nextBeforeDisplaySeq:30});
  assert.equal(await newer,true);
  h.requests[0].resolve({operations:[operation('user-old',10)],nextBeforeDisplaySeq:10});
  assert.equal(await stale,false);
  assert.equal(h.present.has('user-old'),false);
  assert.equal(h.searchReturnPosition.value.anchor.scrollTop,850);
  assert.equal(h.autoScrollLocked.value,false);
  await h.run('returnFromSearch()');
  assert.equal(h.restores.length,1);
  assert.equal(h.el.scrollTop,850);
  assert.deepEqual(h.operationList().map(op=>op.opId),['user-new','assistant-new']);
  const switched=h.run("locateSearchResult({opId:'user-ancient',type:'user_message'})");
  h.current.value='B';h.props.conversationUuid='B';h.run('searchNavigationGeneration++');
  h.requests[2].resolve({operations:[operation('user-ancient',1)]});
  assert.equal(await switched,false);
  assert.equal(h.present.has('user-ancient'),false);
  assert.deepEqual(h.errors,[]);
});

test('sequential distant hits replace the last window, keep manually loaded base and live additions, and release them on return',async()=>{
  const h=navigationHarness();
  // The base includes user-paged rows already loaded before opening search.
  h.operationList().push(operation('user-manual',170));
  const first=h.run("locateSearchResult({opId:'user-old-1'})");
  h.requests[0].resolve({operations:[operation('user-old-1',10),operation('assistant-old-1',20)],nextBeforeDisplaySeq:10});
  assert.equal(await first,true);
  assert.equal(h.operationList().length,5);
  // Simulate an active frame published while reading the old window. This id is
  // inserted into the component baseline by its actual frame handling hook.
  h.operationList().push(operation('assistant-live',220));
  h.searchBaseOperationIds.add('assistant-live');
  for(let i=2;i<=25;i++){
    const locate=h.run(`locateSearchResult({opId:'user-old-${i}'})`);
    h.requests[i-1].resolve({operations:[operation(`user-old-${i}`,i*10),operation(`assistant-old-${i}`,i*10+1)],nextBeforeDisplaySeq:i*10});
    assert.equal(await locate,true);
    assert.ok(h.operationList().length<=6,'each new hit replaces rather than accumulates the old window');
    assert.ok(h.operationList().some(op=>op.opId==='user-manual'));
    assert.ok(h.operationList().some(op=>op.opId==='assistant-live'));
    assert.equal(h.operationList().some(op=>op.opId===`user-old-${i-1}`),false);
  }
  assert.equal(h.searchAddedOperationIds.size,2);
  await h.run('returnFromSearch()');
  assert.deepEqual(h.operationList().map(op=>op.opId),['user-manual','user-new','assistant-new','assistant-live']);
  assert.equal(h.searchAddedOperationIds.size,0);
});

test('loaded base hit and explicit latest both release the temporary search window',async()=>{
  const h=navigationHarness();
  const first=h.run("locateSearchResult({opId:'user-old'})");
  h.requests[0].resolve({operations:[operation('user-old',10)],nextBeforeDisplaySeq:10});
  assert.equal(await first,true);
  assert.equal(await h.run("locateSearchResult({opId:'user-new'})"),true);
  assert.deepEqual(h.operationList().map(op=>op.opId),['user-new','assistant-new']);
  const second=h.run("locateSearchResult({opId:'user-older'})");
  h.requests[1].resolve({operations:[operation('user-older',5)],nextBeforeDisplaySeq:5});
  assert.equal(await second,true);
  h.run('returnToLatestFromSearch()');
  assert.equal(h.searchAddedOperationIds.size,0);
  assert.deepEqual(h.operationList().map(op=>op.opId),['user-new','assistant-new']);
  assert.equal(h.el.scrollTop,h.el.scrollHeight);
  assert.equal(h.autoScrollLocked.value,true);
});

test('actual operation-frame projection keeps an unlocked search reader at the old scroll position and retains the live row',()=>{
  const scroller=ref({scrollTop:100,scrollHeight:2000,clientHeight:300});
  const searchBaseOperationIds=new Set(['user-current']),searchAddedOperationIds=new Set(['user-old']);
  const operationsById=ref(new Map([['user-old',operation('user-old',10)],['user-current',operation('user-current',200)]]));
  const orderedOpIds=ref(['user-old','user-current']);
  const revisionByOpId=ref(new Map([['user-old',1],['user-current',1]]));
  const context=vm.createContext({ref,nextTick,applyOperationFrame,isRootRunTerminalFrame,isTerminalOperationFrame,
    operationsById,orderedOpIds,revisionByOpId,lastFrameSeq:ref(2),scroller,searchWindowActive:ref(true),
    searchBaseOperationIds,searchAddedOperationIds,autoScrollLocked:ref(false),
    messages:ref([]),chatState:ref({}),window:{requestAnimationFrame:()=>{throw Error('background frame forced tail scroll');}},
    operationFrameBuffer:{block:()=>{}},stateStatsByOpId:new Map(),
    debugFrames:()=>{},mergeLedgerUsageIntoState:()=>{},operationScrollImpact:()=> 'tail',
    mergeScrollImpact:(_old,next)=>next,operationDebugRow:x=>x,
    scheduleOperationStateResync:()=>{throw Error('unexpected revision gap');},
    visibleEventSignatureForMessages:items=>JSON.stringify(items.map(op=>op.opId)),
    projectOperationMessages:ops=>ops,hasOptimisticLocalTurn:()=>false,
    syncRunStateFromOperations:()=>{},noteVisibleOutput:()=>{},captureScrollAnchor:()=>({scrollTop:100}),
    restoreScrollAnchor:()=>{throw Error('tail frame should not re-anchor')},
    scheduleTerminalStateRefresh:()=>{},runProgrammaticScroll:fn=>fn(),
    updateScrollerOverflow:()=>{},scheduleActiveTurnFromScroll:()=>{}});
  vm.runInContext(`let pendingProjectionOps=null,pendingScrollImpact='none',pendingPreserveAnchor=null,
      pendingTerminalFrame=null,streamFlushPending=false,streamFlushFrame=0,scrollFrame=0;
    function orderedOperationsList(){return orderedOpIds.value.map(id=>operationsById.value.get(id)).filter(Boolean);}
    function shouldScrollForImpact(impact){return impact==='tail';}
    function scheduleProjectedMessagesFlush(){flushProjectedMessages();}
    ${between('function flushProjectedMessages()', 'function scheduleProjectedMessagesFlush(options = {})')}
    ${between('function applyOperationFrameMessage(', 'function textSignal(')}
    ${between('function scheduleScrollBottom(options = {})', 'function cancelScheduledUiWork()')}`,context);
  const result=vm.runInContext(`applyOperationFrameMessage({opId:'assistant-live',opType:'assistant_message',action:'append',revision:1,
    frameSeq:3,displaySeq:210,turnUuid:'turn-200',payload:{text:'new output'}})`,context);
  assert.equal(result.applied,true);
  assert.equal(scroller.value.scrollTop,100);
  assert.equal(context.autoScrollLocked.value,false);
  assert.equal(searchBaseOperationIds.has('assistant-live'),true);
  assert.equal(context.messages.value.some(op=>op.opId==='assistant-live'),true);
});

test('actual state refresh merges the historical search window with authoritative newer operations and preserves its frame cursor', () => {
  const context=vm.createContext({ref,markRaw,toRaw,normalizeOperations,mergeOperationSnapshots,
    stateStatsByOpId:new Map(),operationsById:ref(new Map()),orderedOpIds:ref([]),
    revisionByOpId:ref(new Map()),lastFrameSeq:ref(0),searchWindowActive:ref(true),searchBaseOperationIds:new Set()});
  vm.runInContext(`function orderedOperationsList() { return orderedOpIds.value.map(id=>operationsById.value.get(id)).filter(Boolean); }
    ${between('function replaceOperationSnapshots(', 'function applyTimelinePageMetadata(')}`,context);
  const earlier=[operation('user-old',10),operation('assistant-old',20),operation('assistant-new',200,1)];
  context.oldOps=earlier;
  vm.runInContext('replaceOperationSnapshots(oldOps)',context);
  context.resume={frameSeq:21,operations:[operation('assistant-new',200,2),operation('user-fresh',210)]};
  const result=vm.runInContext('loadOperationsFromState(resume)',context);
  assert.deepEqual(result.map(op=>op.opId),['user-old','assistant-old','assistant-new','user-fresh']);
  assert.equal(result.find(op=>op.opId==='assistant-new').revision,2);
  assert.equal(context.lastFrameSeq.value,21);
  const reset=vm.runInContext('loadOperationsFromState(resume,{replace:true})',context);
  assert.deepEqual(reset.map(op=>op.opId),['assistant-new','user-fresh'],'explicit deletion/reset does not resurrect historical rows');
});

test('real search drawer request generation rejects superseded queries, hides snippets and previews only on explicit action', async () => {
  const descriptor=parse(fs.readFileSync(new URL('./ConversationSearch.vue',import.meta.url),'utf8')).descriptor;
  const script=descriptor.scriptSetup.content.replace(/^import .*;\n/gm,'');
  const props=reactive({conversationUuid:'A',open:true}), searchCalls=[],previewCalls=[],emitted=[];
  const ctx=vm.createContext({ref,watch,nextTick,defineProps:()=>props,defineEmits:()=> (...args)=>emitted.push(args),
    onBeforeUnmount:()=>{},setTimeout:()=>1,clearTimeout:()=>{},
    Api:{conversationSearch:(uuid,params)=>{const d=deferred();searchCalls.push({uuid,params,...d});return d.promise;},
      hiddenMessagePreview:(uuid,id)=>{const d=deferred();previewCalls.push({uuid,id,...d});return d.promise;}},
    apiError:String});
  vm.runInContext(script,ctx);
  const run=code=>vm.runInContext(code,ctx);
  run('query.value="old"');await nextTick();const old=run('search()');
  run('query.value="new"');await nextTick();const newer=run('search()');
  searchCalls[1].resolve({items:[{opId:'hidden',hidden:true,snippet:null}],nextCursor:null});await newer;
  searchCalls[0].resolve({items:[{opId:'stale',hidden:false,snippet:'stale'}],nextCursor:null});await old;
  assert.deepEqual([...run('items.value')].map(item=>item.opId),['hidden']);
  assert.equal(run('searching.value'),false);
  assert.equal(run('items.value[0].snippet'),null);
  assert.equal(run('locate(items.value[0])'),undefined);
  assert.equal(emitted.length,0,'hidden hits never navigate or restore automatically');
  const preview=run('preview(items.value[0])');
  assert.equal(previewCalls.length,1);
  previewCalls[0].resolve({operation:{payload:{text:'explicit preview'}}});await preview;
  assert.equal(run('previewText.value'),'explicit preview');
  run('includeHidden.value=true');await nextTick();
  assert.equal(run('previewId.value'),'','filter changes revoke previous preview');
  const other=run('search()');props.conversationUuid='B';await nextTick();
  searchCalls[2].resolve({items:[{opId:'leaked'}],nextCursor:null});await other;
  assert.equal(run('items.value.length'),0);
});
