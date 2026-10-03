import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parse, compileScript, compileTemplate, compileStyle} from '@vue/compiler-sfc';
import * as Vue from 'vue';
import {renderToString} from 'vue/server-renderer';
import {Message, ArrowRight, CopyDocument, Check} from '@element-plus/icons-vue';
import {eventMessageView, formatEventData, highlightEventData} from './webhookMessage.js';
import {projectOperationMessages} from '../../timelineProjection.js';
const descriptor = parse(fs.readFileSync(new URL('./WebhookMessageCard.vue',import.meta.url),'utf8')).descriptor;
const source = descriptor.scriptSetup.content.replace(/^import .*;\n/gm,'');
const flush = async () => {for(let i=0;i<8;i++) await Vue.nextTick();};
function harness(read) {
  const props=Vue.reactive({message:{opId:'msg:abcdefgh-uuid',source:'webhook',content:'PROMPT NOT IN CARD',eventCard:{name:'订单通知',shortId:'abcdefgh',count:2,receivedAtMs:1791049264000,events:[{eventId:'first-uuid',summary:'入库完成',receivedAtMs:1791049264000},{eventId:'second-uuid',summary:'下一条'}]}}});
  const copied=[],calls=[],cleanup=[],effects=Vue.effectScope();
  const ctx={...Vue,Message,ArrowRight,CopyDocument,Check,AbortController,eventMessageView,formatEventData,highlightEventData,
    defineProps:()=>props,ElMessage:{warning:()=>{}},onBeforeUnmount:fn=>cleanup.push(fn),copyTextToClipboard:async value=>copied.push(value),
    Api:{webhookEvent:async(id,options)=>{calls.push({id,options});return read?read(id):{event:{raw:{body:{text:'<script>alert(1)</script>',n:3},contentType:'application/json'}}};}}};
  vm.createContext(ctx);effects.run(()=>vm.runInContext(source,ctx));
  const run=code=>vm.runInContext(code,ctx);
  async function html(){
    const all=compileScript(descriptor,{id:'event-test'}).bindings;
    const names=Object.keys(all).filter(n=>all[n]!=='props');
    const bindings=Vue.proxyRefs({...run(`({${names.join(',')}})`),...props});
    const draw=Vue.compile(descriptor.template.content);
    const app=Vue.createSSRApp({render(){return draw.call(this,bindings,[]);}});
    app.component('ElDialog',{props:['modelValue'],setup(p,{slots}){return()=>p.modelValue?Vue.h('section',slots.default?.()):null;}});
    for(const name of ['ElIcon','ElButton'])app.component(name,{setup(_,{slots,attrs}){return()=>Vue.h('span',attrs,slots.default?.());}});
    for(const [name,c] of Object.entries({Message,ArrowRight,CopyDocument,Check}))app.component(name,c);
    app.config.warnHandler=()=>{};return renderToString(app);
  }
  return{props,run,html,copied,calls,close(){cleanup.forEach(fn=>fn());effects.stop();}};
}
test('event input stays intact while provenance and card survive timeline projection',()=>{
  const [msg]=projectOperationMessages([{opId:'msg:abcdefgh-full-uuid',opType:'user_message',turnUuid:'turn',displaySeq:1,source:'webhook',payload:{text:'full original input',eventCard:{name:'来信'}}}]);
  assert.equal(msg.content,'full original input');assert.equal(msg.source,'webhook');assert.equal(msg.eventCard.name,'来信');
  const regular=projectOperationMessages([{opId:'user',opType:'user_message',turnUuid:'turn',displaySeq:1,payload:{text:'External event materials'}}])[0];
  assert.equal(regular.source,'user');
});
test('envelope shows summary/time/short ID, never dumps model input or full UUID',async()=>{
  const h=harness();const html=await h.html();assert.match(html,/订单通知/);assert.match(html,/入库完成/);assert.match(html,/#abcdefgh/);assert.match(html,/合并 2 条/);
  assert.doesNotMatch(html,/PROMPT NOT IN CARD|first-uuid|abcdefgh-uuid/);assert.equal(h.calls.length,0);h.close();
});
test('dialog loads selected event, formats and safely highlights JSON; original model input remains accessible',async()=>{
  const h=harness();h.run('show()');await flush();let html=await h.html();
  assert.equal(h.calls[0].id,'first-uuid');assert.match(html,/hljs-attr/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
  await h.run('copy()');assert.equal(h.copied[0],JSON.stringify({text:'<script>alert(1)</script>',n:3},null,2));
  h.run("selected.value='second-uuid'");await flush();assert.equal(h.calls[1].id,'second-uuid');
  h.run("tab.value='input'");await flush();html=await h.html();assert.match(html,/PROMPT NOT IN CARD/);await h.run('copy()');assert.equal(h.copied.at(-1),'PROMPT NOT IN CARD');h.close();
});
test('closing dialog ignores late responses and purged body has an honest fallback',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const h=harness(()=>pending);h.run('show()');await flush();h.run('open.value=false');await flush();
  assert.equal(h.calls[0].options.signal.aborted,true);resolve({event:{raw:{body:'late'}}});await flush();assert.equal(h.run('detail.value'),null);h.close();
  const p=harness(async()=>({event:{payloadStatus:'purged'}}));p.run('show()');await flush();assert.match(await p.html(),/已清理或不可用/);p.close();
});
test('card and TurnList templates/styles compile with an explicit left-side event branch',()=>{
  for(const file of ['WebhookMessageCard.vue','TurnList.vue']){
    const d=parse(fs.readFileSync(new URL(file,import.meta.url),'utf8')).descriptor;
    assert.deepEqual(compileTemplate({source:d.template.content,filename:file,id:file}).errors,[]);
    for(const s of d.styles)assert.deepEqual(compileStyle({source:s.content,filename:file,id:file,scoped:s.scoped}).errors,[]);
  }
  const turn=fs.readFileSync(new URL('TurnList.vue',import.meta.url),'utf8');
  assert.match(turn,/<WebhookMessageCard v-if="turn.user.source === 'webhook'"/);
  assert.match(turn,/\.timed-row-event \.user-row \{ justify-content: flex-start;/);
});
