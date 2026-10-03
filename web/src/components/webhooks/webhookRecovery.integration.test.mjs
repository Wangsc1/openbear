import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parse,compileScript} from '@vue/compiler-sfc';
import {computed,ref,nextTick,compile,createSSRApp,h,proxyRefs} from 'vue';
import {renderToString} from 'vue/server-renderer';
import {statusLabel,tabKey,parseLines} from './webhookConfig.js';
function harness({confirm=true,failVerify=false}={}) {
  const source=parse(fs.readFileSync(new URL('./WebhookEventDialog.vue',import.meta.url),'utf8')).descriptor.scriptSetup.content.replace(/^import .*;\n/gm,'');
  const calls=[];let seq=0;
  const record={eventId:'E1',endpointId:'H1',version:4,canRebind:true,verifyStages:['post'],effectState:'unknown',retryStages:['post']};
  const capture=name=>async(...args)=>{calls.push([name,...args]);if(name==='verify'&&failVerify)throw new Error('uncertain response');return {eventId:'E1'};};
  const ctx={computed,ref,nextTick,statusLabel,tabKey,parseLines,AbortController,crypto:{randomUUID:()=>`R${++seq}`},
    watch:()=>{},onBeforeUnmount:()=>{},defineProps:()=>({modelValue:true,eventId:'E1'}),defineEmits:()=>()=>{},
    ElMessageBox:{confirm:async()=>{if(!confirm)throw 'cancel';}},
    Api:{webhookEvent:async()=>({event:{...record}}),webhookWaits:async()=>({items:[]}),webhook:async()=>({endpoint:{id:'H1',revision:7}}),
      verifyWebhookEvent:capture('verify'),retryWebhookEvent:capture('retry'),retryWebhookNotification:capture('notification'),
      rebindWebhookEvents:async(...args)=>{calls.push(['rebind',...args]);return args[1].prepare?{confirmationToken:'scoped-rebind-token',impact:{events:1}}:{eventIds:['E1']};},
      recoverWebhookAssignment:async(...args)=>{calls.push(['recover',...args]);return args[1].prepare?{confirmationToken:'scoped-recovery-token',impact:{runs:1}}:{assignmentId:args[0]};},
    },console,
  };vm.createContext(ctx);vm.runInContext(source,ctx);const run=code=>vm.runInContext(code,ctx);ctx.record=record;run('event.value=record');return {run,calls};
}
test('F22 recording verified external success does not invoke business retry and preserves the exact evidence',async()=>{
  const {run,calls}=harness();run("verifyStage.value='post';verifyOutcome.value='completed';verification.value='queried external operation';evidence.value='order:1\nreceipt:2';verifyResult.value='{\"saved\":true}'".replace('order:1\nreceipt:2','order:1\\nreceipt:2'));
  await run('verify()');assert.equal(calls.length,1);assert.equal(calls[0][0],'verify');assert.equal(calls[0][2].expectedVersion,4);assert.deepEqual(Array.from(calls[0][2].evidenceRefs),['order:1','receipt:2']);assert.equal(calls[0][2].outcome,'completed');assert.equal(calls[0][2].result.saved,true);
});
test('F22 verification requires evidence, cancellation has no write, and uncertain retries reuse the action ID',async()=>{
  const setup="verifyStage.value='post';verifyOutcome.value='completed';verification.value='confirmed';evidence.value='operation:1'";
  const missing=harness();missing.run("verifyStage.value='post';verification.value='no evidence'");await missing.run('verify()');assert.equal(missing.calls.length,0);
  const cancelled=harness({confirm:false});cancelled.run(setup);await cancelled.run('verify()');assert.equal(cancelled.calls.length,0);
  const failed=harness({failVerify:true});failed.run(setup);await failed.run('verify()');await failed.run('verify()');assert.equal(failed.calls[0][2].requestId,failed.calls[1][2].requestId);assert.equal(failed.run('verification.value'),'confirmed');
});
test('F04 backlog rebind prepares exactly the selected event; cancellation never commits',async()=>{
  const cancelled=harness({confirm:false});await cancelled.run('rebind()');assert.equal(cancelled.calls.length,1);assert.equal(cancelled.calls[0][2].prepare,true);
  const accepted=harness();await accepted.run('rebind()');assert.equal(accepted.calls.length,2);assert.deepEqual(Array.from(accepted.calls[0][2].eventIds),['E1']);assert.equal(accepted.calls[0][2].toRevision,7);assert.equal(accepted.calls[1][2].confirmationToken,'scoped-rebind-token');
});
test('F22 notification retry only calls notification API and refuses unverified ambiguous sends',async()=>{
  const {run,calls}=harness();await run("retryNotification({assignmentId:'A1',version:3,canRetryNotification:true,notificationEffectState:'unknown'})");assert.equal(calls.length,0);
  run("verification.value='external notification was not delivered'");await run("retryNotification({assignmentId:'A1',version:3,canRetryNotification:true,notificationEffectState:'unknown'})");assert.equal(calls.length,1);assert.equal(calls[0][0],'notification');assert.equal(calls[0][1],'A1');assert.equal(calls[0][2].expectedVersion,3);
});
test('F10 abandoned runs require verified recovery and use prepared scope rather than replay',async()=>{
  const {run,calls}=harness();await run("recoverAssignment({assignmentId:'A1',version:2,canRecover:true})");assert.equal(calls.length,0);
  run("verification.value='original process stopped';evidence.value='runtime:stopped'");await run("recoverAssignment({assignmentId:'A1',version:2,canRecover:true})");assert.equal(calls.length,2);assert.equal(calls[0][2].decision,'finalizeInterrupted');assert.equal(calls[1][2].confirmationToken,'scoped-recovery-token');
});
test('E14 phase durations retain zero and unknown separately; observation status never claims business success',()=>{
  const {run}=harness();assert.equal(run('phaseDuration(0)'),'0 秒');assert.equal(run('phaseDuration(null)'),'尚无结束记录');assert.equal(run('phaseDuration(10)'),'10 秒');
  assert.equal(run("measurementLabels.assignment"),'整轮任务');assert.equal(run("phaseLabels.human_wait"),'人工确认等待');
  assert.equal(run("observationLabel('applied')"),'已写入统计');assert.equal(run("observationLabel('pending')"),'等待补交');assert.equal(run("observationLabel('rejected')"),'观测被拒绝');
});
test('D12/F10 actual detail template distinguishes purged logs and processing snapshots from empty output',async()=>{
  const {run}=harness();
  run("event.value={eventId:'E1',stages:[{stage:'pre',state:'succeeded',attempts:[{attemptId:'P1',attemptNo:1,state:'succeeded',logStatus:'purged',stderrTruncated:true,resultStatus:'purged'}]}],assignments:[{assignmentId:'A1',state:'finalized',processingStatus:'purged'}]}");
  const descriptor=parse(fs.readFileSync(new URL('./WebhookEventDialog.vue',import.meta.url),'utf8')).descriptor;
  const names=Object.keys(compileScript(descriptor,{id:'retention-detail'}).bindings).filter(name=>!['modelValue','eventId'].includes(name));
  const bindings=proxyRefs({...run(`({${names.join(',')}})`),modelValue:true,eventId:'E1'}),draw=compile(descriptor.template.content);
  async function html(){
    const app=createSSRApp({render(){return draw.call(this,bindings,[]);}});
    const shell={inheritAttrs:false,setup(_,{slots}){return ()=>h('div',[slots.default?.(),slots.footer?.()]);}};
    for(const name of ['ElDialog','ElButton','ElInput','ElSelect','ElOption','ElSkeleton'])app.component(name,shell);
    app.config.warnHandler=message=>assert.fail(message);return renderToString(app);
  }
  const purged=await html();assert.match(purged,/脚本日志已按保留策略清理/);assert.match(purged,/脚本结果快照已按保留策略清理/);assert.match(purged,/轮次处理快照已按保留策略清理/);
  assert.doesNotMatch(purged,/没有可用日志|日志已截断/);
  run("event.value.stages[0].attempts[0].logStatus='retained';event.value.stages[0].attempts[0].resultStatus='notReported';event.value.assignments[0].processingStatus='retained'");
  const retained=await html();assert.match(retained,/没有可用日志/);assert.match(retained,/日志已截断/);assert.doesNotMatch(retained,/已按保留策略清理/);
  assert.equal(statusLabel('conversationStopped'),'当前会话已手动停止，自动模型派发暂停');
});
test('F11 claimed and delivered counts use event arrays, not business completion',()=>{
  const {run}=harness();assert.equal(run("count(['E1','E2'])"),2);assert.equal(run('count([])'),0);assert.equal(run('count(undefined)'),'—');
});

test('R9 actual channel ACK unknown is visible and cannot use adapter retry, even with typed verification',async()=>{
  const {run,calls}=harness();
  run("event.value={eventId:'E1',assignments:[{assignmentId:'A1',state:'finalized',version:3,notificationState:'delivered',notificationEffectState:'confirmed',canRetryNotification:true,notificationVerificationRequired:true,notificationChannels:[{channel:'telegram',state:'unknown',error:'ACK_LOST_SENTINEL <remote>',verificationRequired:true}]}]};tab.value='waits';verification.value='typed claim is not a channel recovery API'");
  const descriptor=parse(fs.readFileSync(new URL('./WebhookEventDialog.vue',import.meta.url),'utf8')).descriptor;
  const names=Object.keys(compileScript(descriptor,{id:'notification-channel-detail'}).bindings).filter(name=>!['modelValue','eventId'].includes(name));
  const bindings=proxyRefs({...run(`({${names.join(',')}})`),modelValue:true,eventId:'E1'}),draw=compile(descriptor.template.content);
  async function html(){
    const app=createSSRApp({render(){return draw.call(this,bindings,[]);}});
    const shell={inheritAttrs:false,setup(_,{slots}){return ()=>h('div',[slots.default?.(),slots.footer?.()]);}};
    for(const name of ['ElDialog','ElButton','ElInput','ElSelect','ElOption','ElSkeleton'])app.component(name,shell);
    app.config.warnHandler=message=>assert.fail(message);return renderToString(app);
  }
  const unknown=await html();
  assert.match(unknown,/通知适配入队 delivered/);assert.match(unknown,/适配效果 confirmed/);
  assert.match(unknown,/不代表外部渠道已送达/);assert.match(unknown,/渠道发送记录 · telegram/);
  assert.match(unknown,/实际渠道状态：unknown/);assert.match(unknown,/ACK_LOST_SENTINEL &lt;remote&gt;/);
  assert.match(unknown,/实际发送结果未知，需先核实，未自动重试/);
  assert.doesNotMatch(unknown,/仅补交通知…|恢复操作的核实依据/);
  await run('retryNotification(event.value.assignments[0])');assert.equal(calls.length,0);
  assert.match(run('error.value'),/不能通过补交适配通知重发/);
  // Either the aggregate flag or an individual channel is enough to require verification.
  run('event.value.assignments[0].notificationVerificationRequired=false');
  assert.equal(run('notificationNeedsVerification(event.value.assignments[0])'),true);
  run("event.value.assignments[0].notificationChannels[0]={channel:'telegram',state:'sent',error:null,verificationRequired:false};error.value=''");
  const sent=await html();assert.match(sent,/实际渠道状态：sent/);assert.doesNotMatch(sent,/实际发送结果未知，需先核实，未自动重试/);
  assert.match(sent,/仅补交通知…/); // Existing explicit adapter recovery semantics are preserved.
  run('event.value.assignments[0].notificationVerificationRequired=true;event.value.assignments[0].notificationChannels=[]');
  assert.equal(run('notificationNeedsVerification(event.value.assignments[0])'),true);
});
