import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as Vue from 'vue';
import {parse} from '@vue/compiler-sfc';
import {updateRunDefault,runDefaultOption} from './folderRunDefaults.js';
import {tabKey} from './webhooks/webhookConfig.js';
import {runConfigFromResponse} from '../views/consoleView/runConfigState.js';
const source=parse(fs.readFileSync(new URL('./ConversationPropertiesDialog.vue',import.meta.url),'utf8')).descriptor.scriptSetup.content.replace(/^import .*;\n/gm,'');
const runConfig=(id,model)=>({conversationUuid:id,model,thinkingLevel:'high',effectiveThinkingLevel:'high',thinkingLevels:['off','high'],defaultThinkingLevel:'high',supportsThinking:true,fastMode:false,fastRequested:false,fastSupported:true,effectiveFastMode:false,agentRunConfig:{model:'',thinkLevel:'',fastMode:null},contextWindow:128000,rolloverTriggerTokens:96000,windowTriggerRatio:.75});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=async()=>{for(let i=0;i<6;i++) await Promise.resolve();};
function harness(overrides={}) {
  const props=Vue.reactive({modelValue:true,conversation:{conversationUuid:'C1',title:'one'},initialTab:'context'});
  const calls=[],toasts=[];
  const ctx={...Vue,watch:()=>{},onBeforeUnmount:()=>{},defineProps:()=>props,defineEmits:()=>()=>{},defineExpose:()=>{},inject:(_key,fallback)=>async(id,request)=>{calls.push(['queue',id]);return request();},
    modelThinkingLevels:()=>['off','high'],thinkingLabel:x=>x,tabKey,updateRunDefault,runDefaultOption,runConfigFromResponse,apiError:e=>e.message,
    ElMessage:{success:s=>toasts.push(s)},ElMessageBox:{confirm:async()=>{throw 'close';}},
    Api:{conversationProperties:async id=>({properties:{contextMode:'inherit',contextText:'',inheritedContext:id},runConfig:runConfig(id,'M1')}),conversationState:async()=>{throw new Error('Property dialogs must not load conversation history');},rathOptions:async()=>({models:[{key:'M1'}]}),
      conversationSetModel:async(id,model)=>{calls.push(['model',id,model]);return {runConfig:runConfig(id,model)};},
      updateConversationProperties:async(id,data)=>{calls.push(['context',id,data]);return {properties:data};},...overrides},console};
  vm.createContext(ctx);vm.runInContext(source,ctx);return {props,calls,toasts,run:code=>vm.runInContext(code,ctx)};
}
test('opening properties reads only the lightweight properties and model options, never full state',async()=>{
  let stateRequests=0;
  const h=harness({conversationState:()=>{stateRequests++;return new Promise(()=>{});}});
  await h.run('load()');
  assert.equal(stateRequests,0);assert.equal(h.run('loading.value'),false);assert.equal(h.run('error.value'),'');
  assert.equal(h.run('model.value.model'),'M1');assert.equal(h.run('model.value.thinkingLevel'),'high');
  assert.equal(h.run('context.value.inheritedContext'),'C1');assert.equal(h.run('models.value.length'),1);
});
test('a late properties read cannot overwrite the next conversation settings',async()=>{
  const pending=defer();
  const h=harness({conversationProperties:id=>id==='C1'?pending.promise:Promise.resolve({properties:{contextMode:'inherit',contextText:'',inheritedContext:id},runConfig:runConfig(id,'M2')})});
  const old=h.run('load()');h.props.conversation={conversationUuid:'C2'};await h.run('load()');
  pending.resolve({properties:{contextMode:'override',contextText:'old'},runConfig:runConfig('C1','M1')});await old;
  assert.equal(h.run('model.value.model'),'M2');assert.equal(h.run('context.value.inheritedContext'),'C2');assert.equal(h.run('loading.value'),false);
});
test('slow model catalog does not block displaying, editing or saving the loaded context',async()=>{
  const pending=defer();const h=harness({rathOptions:()=>pending.promise});const opening=h.run('load()');await flush();
  assert.equal(h.run('contextReady.value'),true);assert.equal(h.run('context.value.inheritedContext'),'C1');
  assert.equal(h.run('loading.value'),false);assert.equal(h.run('modelsLoading.value'),true);assert.equal(h.run('canEditModel.value'),false);
  h.run("context.value.contextMode='override';contextEditorText.value='available before catalog'");
  assert.equal(h.run('canSaveContext.value'),true);assert.equal(await h.run('saveContext()'),true);
  await h.run("mutate('model','M2')");assert.equal(h.calls.length,1);
  pending.resolve({models:[{key:'M1'}]});await opening;assert.equal(h.run('canEditModel.value'),true);
});
test('property read failure and incomplete context keep editing and both mutation paths closed until retry succeeds',async()=>{
  for(const failure of ['offline','incomplete']) {
    let reads=0;
    const h=harness({conversationProperties:async id=>{
      if(++reads===1) {if(failure==='offline')throw Error('offline');return {properties:{contextMode:'override'}};}
      return {properties:{contextMode:'override',contextText:'saved server text'},runConfig:runConfig(id,'M1')};
    }});
    await h.run('load()');assert.equal(h.run('contextReady.value'),false);assert.equal(h.run('canEditModel.value'),false);
    h.run("context.value.contextMode='override';contextEditorText.value='must not edit'");assert.notEqual(h.run('context.value.contextText'),'must not edit');
    h.run("context.value.contextText='must not submit'");assert.equal(h.run('canSaveContext.value'),false);assert.equal(await h.run('saveContext()'),false);
    await h.run("mutate('model','M2')");assert.equal(h.calls.length,0);
    await h.run('loadProperties()');assert.equal(h.run('context.value.contextText'),'saved server text');assert.equal(h.run('contextReady.value'),true);assert.equal(h.run('dirtyContext.value'),false);assert.equal(h.run('canEditModel.value'),true);
  }
});
test('model catalog failure leaves context usable and model retry preserves its unsaved draft and baseline',async()=>{
  let requests=0;const h=harness({rathOptions:async()=>{if(++requests===1)throw Error('catalog offline');return {models:[{key:'M1'}]};}});
  await h.run('load()');assert.equal(h.run('contextReady.value'),true);assert.equal(h.run('error.value'),'');assert.match(h.run('modelsError.value'),/catalog offline/);assert.equal(h.run('canEditModel.value'),false);
  h.run("context.value.contextMode='override';contextEditorText.value='keep this draft'");const baseline=h.run('baseline.value');
  await h.run('retryModel()');assert.equal(h.run('modelsError.value'),'');assert.equal(h.run('canEditModel.value'),true);
  assert.equal(h.run('context.value.contextText'),'keep this draft');assert.equal(h.run('baseline.value'),baseline);assert.equal(h.run('dirtyContext.value'),true);
  assert.equal(await h.run('saveContext()'),true);assert.equal(h.calls[0][2].contextText,'keep this draft');
});
test('missing run config does not discard valid context, and model-only retry cannot reset its edits',async()=>{
  let reads=0;const h=harness({conversationProperties:async id=>({properties:{contextMode:'override',contextText:'server'},...(++reads>1?{runConfig:runConfig(id,'M1')}:{})})});
  await h.run('load()');assert.equal(h.run('contextReady.value'),true);assert.equal(h.run('canEditModel.value'),false);assert.match(h.run('modelError.value'),/完整模型配置/);
  h.run("contextEditorText.value='edited'");await h.run('retryModel()');assert.equal(h.run('canEditModel.value'),true);assert.equal(h.run('context.value.contextText'),'edited');assert.equal(h.run('dirtyContext.value'),true);
});
test('slow properties keep the editor and save locked even when the model catalog has finished',async()=>{
  const pending=defer();const h=harness({conversationProperties:()=>pending.promise});const opening=h.run('load()');await flush();
  assert.equal(h.run('modelsReady.value'),true);assert.equal(h.run('contextReady.value'),false);assert.equal(h.run('canSaveContext.value'),false);assert.equal(h.run('canEditModel.value'),false);
  pending.resolve({properties:{contextMode:'inherit',contextText:''},runConfig:runConfig('C1','M1')});await opening;
  assert.equal(h.run('contextReady.value'),true);assert.equal(h.run('canEditModel.value'),true);
});
test('late model catalog responses cannot replace a new conversation or reopen a closed dialog',async()=>{
  for(const close of [false,true]) {
    const pending=defer();let requests=0;
    const h=harness({rathOptions:()=>++requests===1?pending.promise:Promise.resolve({models:[{key:'M2'}]})});
    const old=h.run('load()');await flush();
    if(close)h.props.modelValue=false;else h.props.conversation={conversationUuid:'C2'};
    await h.run('load()');pending.resolve({models:[{key:'M1'}]});await old;
    assert.equal(h.run('models.value.length'),close?0:1);
    if(!close)assert.equal(h.run('models.value[0].key'),'M2');
    else {assert.equal(h.run('contextReady.value'),false);assert.equal(h.run('canEditModel.value'),false);}
  }
});
test('unset main thinking displays the effective level without writing a setting or masking explicit unavailable levels',async()=>{
  const h=harness();await h.run('load()');h.run("model.value.thinkingLevel='';model.value.effectiveThinkingLevel='high'");
  assert.equal(h.run('modelSettings.value.mainThinkingLevel'),'high');assert.equal(h.run('model.value.thinkingLevel'),'');assert.equal(h.calls.length,0);
  h.run("model.value.thinkingLevel='removed-level'");assert.equal(h.run('modelSettings.value.mainThinkingLevel'),'removed-level');
});
test('F02 actual conversation model mutation uses the composer injection and adopts the returned state',async()=>{
  const h=harness();await h.run('load()');await h.run("mutate('model','M2')");assert.deepEqual(h.calls.slice(0,2),[['queue','C1'],['model','C1','M2']]);assert.equal(h.run('model.value.model'),'M2');
});
test('F02 local context save never updates a frozen prompt snapshot',async()=>{
  const h=harness();await h.run('load()');h.run("context.value.contextMode='override';context.value.contextText='project only'");assert.equal(await h.run('saveContext()'),true);assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'context');assert.equal(h.calls[0][2].contextText,'project only');assert.equal(h.run('dirtyContext.value'),false);
});
test('F12 a late context save for the previous conversation cannot overwrite the new one',async()=>{
  const pending=defer();const h=harness({updateConversationProperties:()=>pending.promise});await h.run('load()');h.run("context.value.contextText='old draft'");const old=h.run('saveContext()');h.props.conversation={conversationUuid:'C2'};await h.run('load()');pending.resolve({properties:{contextMode:'override',contextText:'old saved'}});assert.equal(await old,false);assert.equal(h.run('context.value.inheritedContext'),'C2');assert.equal(h.run('context.value.contextText'),'');assert.equal(h.toasts.length,0);
});
test('F04 failed saves retain edits and cancelling the close prompt keeps the dialog',async()=>{
  const h=harness({updateConversationProperties:async()=>{throw new Error('offline');}});await h.run('load()');h.run("context.value.contextText='keep this'");assert.equal(await h.run('saveContext()'),false);assert.equal(h.run('context.value.contextText'),'keep this');assert.equal(await h.run('canLeave()'),false);assert.equal(h.run('saving.value'),false);
});

test('shared selectors save conversation Fast=false and compression through the existing serial queue',async()=>{
 const requests=[];const h=harness({conversationSetFast:async(id,value)=>{requests.push(['fast',id,value]);return {runConfig:{...runConfig(id,'M1'),fastRequested:value}};},conversationSetContextStrategy:async(id,value)=>{requests.push(['strategy',id,value]);return {runConfig:{...runConfig(id,'M1'),contextStrategy:value}};}});
 await h.run('load()');await h.run("changeModelSetting('mainFastMode',runDefaultOption(false))");assert.deepEqual(requests[0],['fast','C1',false]);assert.equal(h.run('modelSettings.value.mainFastMode'),false);
 await h.run("changeModelSetting('contextStrategy',runDefaultOption('model_summary'))");assert.deepEqual(requests[1],['strategy','C1','model_summary']);assert.equal(h.run('modelSettings.value.contextStrategy'),'model_summary');assert.match(h.toasts.at(-1),/安全边界/);assert.equal(h.calls.filter(x=>x[0]==='queue').length,2);
});
