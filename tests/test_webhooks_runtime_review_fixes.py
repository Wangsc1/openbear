"""Repair acceptance converted from independent directed reproductions; all state uses pytest tmp_path/isolated fixture."""
import asyncio
import json
from pathlib import Path
import pytest
from app.webhooks import routing, waits, receipts, recovery
from app.webhooks.repository import one, many
from app.webhooks.contracts import WebhookError
from app.llm.events import StreamEvent, ToolCall, Usage
from app.runtime.lifecycle import current_session
from tests.test_webhooks_backend import env, create, accept
from tests.test_webhooks_wait_acceptance import held, match
from tests.test_web_admin import FakeRunFactory, FakeStreamBackend


def evidence(label, **facts):
    print('\nFIX_EVIDENCE', label, json.dumps(facts, ensure_ascii=False, default=str))

async def eventually(fn):
    async with asyncio.timeout(5):
        while not fn(): await asyncio.sleep(.005)

async def other_endpoint(env, **config):
    await env.db.conn.execute("INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name) VALUES('other',123,'Other')")
    await env.db.conn.commit()
    return await env.s.create(123, {'scope':{'type':'folder','id':'other'},'enabled':True,'requestId':'other','config':{'processing':{'instructions':'Only fixture work'},**config}})

async def pause(env, c):
    e=(await env.s.get(123,c['endpoint']['id']))['endpoint']
    return await env.s.control(123,e['id'],{'action':'pause','expectedControlRevision':e['controlRevision'],'requestId':'pause'})

async def test_fixed_late_arrival_extends_expired_bucket(env):
    clock=[1000000]; env.s.clock=lambda:clock[0]
    c=await create(env,batching={'idleSeconds':3,'maxWaitSeconds':30})
    a=await accept(env,c,key='a'); await routing.tick(env.s)
    clock[0]+=4000
    b=await accept(env,c,key='b'); await routing.tick(env.s)
    batches=await many(env.db.conn,'SELECT state,first_entered_at_ms,idle_deadline_ms FROM webhook_batches')
    members=await many(env.db.conn,'SELECT batch_id,event_id FROM webhook_batch_members')
    evidence('late_batch',batches=batches,members=members)
    assert len(batches)==2 and {b['state'] for b in batches}=={'sealed','collecting'}
    assert len({m['batch_id'] for m in members})==2

async def test_fixed_late_arrival_extends_expired_collection(env):
    clock=[1000000]; env.s.clock=lambda:clock[0]
    async with held(env) as (c,a,first,release):
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'w','match':match(),'collection':{'idleSeconds':3,'maxWaitSeconds':30},'timeoutSeconds':100})
        x=await accept(env,c,'{"kind":"reply"}','x'); await routing.tick(env.s)
        clock[0]+=4000
        y=await accept(env,c,'{"kind":"reply"}','y'); await routing.tick(env.s)
        row=await one(env.db.conn,'SELECT state,first_claimed_at_ms,last_claimed_at_ms FROM webhook_waits WHERE wait_id=?',(w['waitId'],))
        members=await many(env.db.conn,'SELECT event_id FROM webhook_assignment_events WHERE wait_id=?',(w['waitId'],))
        evidence('late_collection',wait=row,members=members)
        assert row['state']=='sealed' and len(members)==1 and members[0]['event_id']==x['eventId']

@pytest.mark.parametrize('phase',['pre','route','model'])
async def test_fixed_blocked_head_starves_unrelated_endpoint(env,phase):
    clock=[1000000]; env.s.clock=lambda:clock[0]
    options={'pre':{'enabled':True,'code':'print(\'{"decision":"skip_model","outcome":"handled"}\')'}} if phase=='pre' else {'batching':{'enabled':False}}
    c=await create(env,**options)
    d=await other_endpoint(env,**options)
    n={'pre':20,'route':500,'model':50}[phase]
    # Rate capacity is unrelated to the deliberately queued workload.
    env.s.config.ingress.requests_per_minute=10000
    for i in range(n):
        await accept(env,c,key=str(i)); clock[0]+=1
    if phase=='model':
        await routing.tick(env.s); clock[0]+=1
    await pause(env,c)
    good=await accept(env,d,key='good')
    for _ in range(3):
        if phase=='route': await routing.tick(env.s)
        else: await env.worker.tick()
    row=await one(env.db.conn,'SELECT route_state FROM webhook_events WHERE event_id=?',(good['eventId'],))
    job=await one(env.db.conn,'SELECT state FROM webhook_stage_jobs WHERE event_id=?',(good['eventId'],))
    assignments=await many(env.db.conn,'SELECT assignment_id FROM webhook_assignments WHERE origin_endpoint_id=?',(d['endpoint']['id'],))
    evidence('head_starvation_'+phase,blocked=n,unrelatedEvent=row,unrelatedJob=job,assignments=assignments,freeScriptTasks=len(env.worker.tasks),freeModelTasks=len(env.bridge.active))
    assert (job['state'] in ('running','succeeded') if phase=='pre' else row['route_state']=='batch' if phase=='route' else len(assignments)==1)

async def test_fixed_deleted_binding_still_dispatches_fixed_target(env):
    conv=await env.server._create_web_conversation(123,folder_uuid='folder',title='Separate fixed target')
    c=await create(env,target={'mode':'fixedConversation','conversationId':conv['conversation_uuid']},batching={'enabled':False})
    await accept(env,c); await routing.tick(env.s)
    await env.db.conn.execute("DELETE FROM web_conversation_folders WHERE folder_uuid='folder'"); await env.db.conn.commit()
    status=(await env.s.get(123,c['endpoint']['id']))['endpoint']
    await env.bridge.dispatch()
    assignments=await many(env.db.conn,'SELECT assignment_id FROM webhook_assignments')
    evidence('deleted_binding',pauseReasons=status['pauseReasons'],assignments=assignments)
    assert 'bindingDeleted' in status['pauseReasons'] and len(assignments)==0
    await env.server.runs.cancel_all_and_wait()

async def test_fixed_pause_before_spawn_does_not_block_process(env,monkeypatch):
    reached=asyncio.Event(); release=asyncio.Event(); path=env.tmp/'pause-effect.txt'
    from app.webhooks import worker
    execute=worker.execute
    async def before_start(*args,**kwargs):
        reached.set(); await release.wait()
        return await execute(*args,**kwargs)
    monkeypatch.setattr(worker,'execute',before_start)
    code='from pathlib import Path\nPath('+repr(str(path))+').write_text("effect")\nprint(\'{"decision":"skip_model","outcome":"handled"}\')'
    c=await create(env,pre={'enabled':True,'code':code})
    await accept(env,c); await env.worker.tick(); await asyncio.wait_for(reached.wait(),5)
    before=await one(env.db.conn,'SELECT state,started_at_ms FROM webhook_stage_attempts')
    await pause(env,c); release.set(); await asyncio.gather(*list(env.worker.tasks.values()))
    after=await one(env.db.conn,'SELECT state,started_at_ms FROM webhook_stage_attempts')
    evidence('pause_before_spawn',before=before,after=after,effectExists=path.exists())
    assert before['state']=='reserved' and before['started_at_ms'] is None and not path.exists()
    assert after['state']=='cancelled' and after['started_at_ms'] is None
    endpoint=(await env.s.get(123,c['endpoint']['id']))['endpoint']
    await env.s.control(123,endpoint['id'],{'action':'resume','scope':'dispatch','expectedControlRevision':endpoint['controlRevision'],'requestId':'resume'})
    await env.worker.tick(); await asyncio.gather(*list(env.worker.tasks.values()))
    assert path.exists()

async def test_fixed_cancel_unknown_effect_retry_replays_without_verification(env):
    seen=asyncio.Event(); path=env.tmp/'model-effects.txt'; effects=[]
    async def effect(args):
        effects.append('effect'); path.write_text('\n'.join(effects))
        if len(effects)==1:
            seen.set(); await asyncio.Event().wait()
        return 'effect acknowledged'
    env.server.tools.add('FixtureEffect','Local file only',{'type':'object'},effect)
    c=await create(env,batching={'enabled':False})
    first=await accept(env,c)
    class Backend(FakeStreamBackend):
        def __init__(self): super().__init__(); self.steps={}
        async def stream(self,messages,**kwargs):
            run=current_session().run_id; step=self.steps.get(run,0); self.steps[run]=step+1; self.calls+=1
            yield StreamEvent(kind='usage',usage=Usage(input_tokens=1),details={'providerCostUsd':0.0})
            if step==0: call=ToolCall('effect','FixtureEffect','{}')
            elif step==1: call=ToolCall('report','Webhook',json.dumps({'action':'report','params':{'receiptId':run,'expectedReceiptVersion':1,'results':[{'eventId':first['eventId'],'outcome':'completed'}]}}))
            else:
                yield StreamEvent(kind='content',text='Done'); yield StreamEvent(kind='finish',finish_reason='stop'); return
            yield StreamEvent(kind='tool_call',tool_calls=[call]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    env.server.llm_factory=FakeRunFactory(Backend(),context_window=128000)
    await env.worker.tick(); await asyncio.wait_for(seen.wait(),5)
    e=(await env.s.get(123,c['endpoint']['id']))['endpoint']
    await env.s.control(123,e['id'],{'action':'stop','scope':'current','expectedControlRevision':e['controlRevision'],'requestId':'stop'})
    r=await one(env.db.conn,'SELECT source,outcome,disposition,review_required FROM webhook_receipts')
    event=await one(env.db.conn,'SELECT * FROM webhook_events WHERE event_id=?',(first['eventId'],))
    with pytest.raises(WebhookError) as rejected:
        await recovery.retry(env.s,123,first['eventId'],{'stage':'model','expectedVersion':event['route_version'],'requestId':'retry'})
    evidence('cancel_retry_blocked',firstReceipt=r,error=rejected.value.payload,localEffects=len(effects))
    assert r['outcome']=='unknown' and r['review_required']==1 and len(effects)==1
    assert rejected.value.payload['code']=='verify_unknown_effect_first'
    # Even an administrator's 'unknown' is not a finding of no effect.
    await recovery.verify(env.s,123,first['eventId'],{'stage':'model','outcome':'unknown','reason':'Still investigating','evidenceRefs':['local:uncertain'],'expectedVersion':event['route_version'],'requestId':'verify-unknown'})
    event=await one(env.db.conn,'SELECT * FROM webhook_events WHERE event_id=?',(first['eventId'],))
    with pytest.raises(WebhookError):
        await recovery.retry(env.s,123,first['eventId'],{'stage':'model','expectedVersion':event['route_version'],'requestId':'retry-unknown'})

@pytest.mark.parametrize('resume_mode',['control','human'])
async def test_fixed_wait_timeout_wakes_paused_model(env,resume_mode):
    clock=[1000000]; env.s.clock=lambda:clock[0]; reached=asyncio.Event(); effects=[]
    c=await create(env,batching={'enabled':False}); event=await accept(env,c)
    async def effect(args): effects.append('effect after explicit resume'); return 'local fixture effect'
    env.server.tools.add('FixtureEffect','Local list only',{'type':'object'},effect)
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if self.calls==1: args={'action':'wait','params':{'op':'register','endpointId':c['endpoint']['id'],'requestId':'w','match':match(),'timeoutSeconds':1}}; name='Webhook'
            elif self.calls==2:
                w=await one(env.db.conn,'SELECT wait_id FROM webhook_waits'); args={'action':'wait','params':{'op':'await','waitId':w['wait_id']}}; name='Webhook'
            elif self.calls==3: args={}; name='FixtureEffect'; reached.set()
            elif self.calls==4: args={'action':'report','params':{'receiptId':'r','results':[{'eventId':event['eventId'],'outcome':'completed'}]}}; name='Webhook'
            else:
                yield StreamEvent(kind='content',text='Done'); yield StreamEvent(kind='finish',finish_reason='stop'); return
            yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('t'+str(self.calls),name,json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    await env.worker.tick(); await eventually(lambda:bool(env.bridge.waiting_assignments))
    await pause(env,c); clock[0]+=2000; env.s.wake.set()
    await asyncio.sleep(.15)
    assert not reached.is_set() and not effects and backend.calls==2
    evidence('timeout_while_paused',calls=backend.calls,effects=effects,wait=await one(env.db.conn,'SELECT state FROM webhook_waits'))
    endpoint=(await env.s.get(123,c['endpoint']['id']))['endpoint']
    if resume_mode=='control':
        await env.s.control(123,endpoint['id'],{'action':'resume','scope':'dispatch','expectedControlRevision':endpoint['controlRevision'],'requestId':'resume'})
    else:
        row=await one(env.db.conn,'SELECT * FROM web_conversations')
        human=await env.server._start_or_steer_web_conversation(row,'Explicit correction while paused; finish this owned task without waiting again',[],env.server._live_for(row))
        assert human['queued']
    await asyncio.wait_for(asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller')),10)
    evidence('paused_timeout',modelCalls=backend.calls,effects=effects,paused=(await env.s.get(123,c['endpoint']['id']))['endpoint']['dispatchPaused'])
    assert effects and reached.is_set()

async def test_fixed_receipt_id_reused_with_added_event_is_not_conflict(env):
    async with held(env) as (c,a,first,release):
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'w','match':match()})
        b=await accept(env,c,'{"kind":"reply"}','b'); await routing.tick(env.s); await waits.delivery(env.s,a['assignment_id'],w['waitId'])
        run=(await one(env.db.conn,'SELECT run_id FROM webhook_runtime_links'))['run_id']
        initial={'eventId':first['eventId'],'outcome':'completed'}
        await receipts.report(env.s,a['assignment_id'],run,{'receiptId':'same','results':[initial]})
        with pytest.raises(WebhookError) as conflict:
            await receipts.report(env.s,a['assignment_id'],run,{'receiptId':'same','results':[initial,{'eventId':b['eventId'],'outcome':'completed'}]})
        assert conflict.value.payload['code']=='receipt_conflict'
        result=await receipts.report(env.s,a['assignment_id'],run,{'receiptId':'same','results':[initial]})
        evidence('receipt_request_fixed',response=result,receipts=await many(env.db.conn,'SELECT event_id,request_key FROM webhook_receipts'))
        assert len(result['receiptIds'])==1

async def test_fixed_post_runs_before_same_root_human_steering_finishes(env,monkeypatch):
    observations=[]; path=env.tmp/'post.txt'
    code='import json,sys\nfrom pathlib import Path\nx=json.load(sys.stdin)\nPath('+repr(str(path))+').write_text(x["assignment"]["finalText"])\nprint("{}")'
    c=await create(env,batching={'enabled':False},post={'enabled':True,'code':code})
    event=await accept(env,c)
    async def effect(args):
        row=await one(env.db.conn,'SELECT state FROM webhook_assignments')
        observations.append({'assignmentState':row['state'],'postAlreadyExecuted':path.exists()}); return 'human correction applied'
    env.server.tools.add('FixtureEffect','Local fixture observation',{'type':'object'},effect)
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if self.calls==1:
                call=ToolCall('report','Webhook',json.dumps({'action':'report','params':{'receiptId':'r','results':[{'eventId':event['eventId'],'outcome':'completed'}]}}))
            elif self.calls==3: call=ToolCall('human-correction','FixtureEffect','{}')
            else:
                yield StreamEvent(kind='content',text='INITIAL FINAL' if self.calls==2 else 'CORRECTED HUMAN FINAL'); yield StreamEvent(kind='finish',finish_reason='stop'); return
            yield StreamEvent(kind='tool_call',tool_calls=[call]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    original=receipts.candidate; injected=False
    async def candidate(*args,**kwargs):
        nonlocal injected
        decision=await original(*args,**kwargs)
        if not injected and decision.get('outcome')=='ready':
            injected=True
            row=await one(env.db.conn,'SELECT * FROM web_conversations')
            human=await env.server._start_or_steer_web_conversation(row,'Please correct this same task before it ends',[],env.server._live_for(row))
            assert human['queued']
            await env.worker.tick()
            await asyncio.gather(*list(env.worker.tasks.values()))
        return decision
    monkeypatch.setattr(receipts,'candidate',candidate)
    await env.worker.tick(); await asyncio.wait_for(asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller')),10)
    await env.worker.tick(); await asyncio.gather(*list(env.worker.tasks.values()))
    a=await one(env.db.conn,'SELECT final_snapshot_json FROM webhook_assignments')
    evidence('early_finalize',modelCalls=backend.calls,correctionExecution=observations,postText=path.read_text(),snapshotText=json.loads(a['final_snapshot_json'])['finalText'])
    assert backend.calls==4 and observations==[{'assignmentState':'closing','postAlreadyExecuted':False}] and path.read_text()=='CORRECTED HUMAN FINAL'

async def test_fixed_manual_stop_fence_is_lost_in_fresh_host(env):
    from app.web_admin import WebAdminServer
    from tests.test_web_admin import FakeBot
    from types import SimpleNamespace
    async with held(env) as (c,a,first,release):
        row=await one(env.db.conn,'SELECT * FROM web_conversations')
        await env.server._stop_web_conversation(row)
        event=await one(env.db.conn,'SELECT * FROM webhook_events WHERE event_id=?',(first['eventId'],))
        await recovery.verify(env.s,123,first['eventId'],{'stage':'model','outcome':'failed','reason':'Deterministic model barrier: no tool executed','evidenceRefs':['local:no-tools'],'expectedVersion':event['route_version'],'requestId':'stop-verify'})
        assert (await one(env.db.conn,'SELECT model_blockers_json FROM webhook_endpoints'))['model_blockers_json']=='{}'
        second=await accept(env,c,key='second'); await routing.tick(env.s)
        await env.bridge.dispatch()
        before=(await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_assignments'))['n']
        fresh=WebAdminServer(env.server.config,env.db,FakeBot())
        fresh.tools=env.server.tools; fresh.workspace_dir=str(env.tmp)
        fresh.model_selection=SimpleNamespace(current='openai/gpt')
        fresh.llm_factory=FakeRunFactory(FakeStreamBackend(),context_window=128000)
        async def system(): return 'Fixture frozen prompt'
        fresh._build_system_prompt_for_chat=system
        fresh.webhooks=env.s
        env.bridge.host=fresh
        try:
            await env.worker.recover(); await env.bridge.dispatch()
            after=(await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_assignments'))['n']
            evidence('manual_stop_restart',beforeAssignments=before,afterAssignments=after,oldHostStopMarkers=len(env.server._web_stop_markers),newHostStopMarkers=len(fresh._web_stop_markers),modelBlockers=(await one(env.db.conn,'SELECT model_blockers_json FROM webhook_endpoints'))['model_blockers_json'])
            assert before==1 and after==1
            stop=await one(env.db.conn,'SELECT * FROM webhook_conversation_stops WHERE conversation_uuid=?',(row['conversation_uuid'],))
            assert stop and stop['owner_chat_id']==123
            assert await env.s.conversation_stopped(env.db.conn,123,row['conversation_uuid'])
            human=await fresh._start_or_steer_web_conversation(row,'Continue ordinary chat, without replaying the stopped event',[],fresh._live_for(row))
            assert human['ok']
            await asyncio.gather(*fresh.runs.scheduler.tasks(kind='controller'))
            assert not await env.s.conversation_stopped(env.db.conn,123,row['conversation_uuid'])
            await env.bridge.dispatch()
            assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_assignments'))['n']==2
            evidence('manual_stop_human_resume',durableStop=stop,afterHumanAssignments=2)
        finally:
            await fresh.runs.cancel_all_and_wait(); env.bridge.host=env.server

async def test_fixed_error_digest_is_one_delivery_per_failed_assignment(env):
    from types import SimpleNamespace
    from app.webhooks import notifications
    clock=[1791021000000]; env.s.clock=lambda:clock[0]
    deliveries=[]
    async def enqueue(owner,conversation,key,status): deliveries.append({'key':key,'status':status})
    env.server.browser_push=SimpleNamespace(enqueue=enqueue)
    c=await create(env,batching={'enabled':False},notifications={'policy':'errorsDigest','digestSeconds':60})
    class Backend(FakeStreamBackend):
        def __init__(self): super().__init__(); self.seen=set()
        async def stream(self,messages,**kwargs):
            run=current_session().run_id; self.calls+=1
            if run not in self.seen:
                self.seen.add(run)
                e=await one(env.db.conn,'SELECT m.event_id FROM webhook_assignment_events m JOIN webhook_runtime_links l USING(assignment_id) WHERE l.run_id=?',(run,))
                args={'action':'report','params':{'receiptId':run,'results':[{'eventId':e['event_id'],'outcome':'failed'}]}}
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('r','Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
            else: yield StreamEvent(kind='content',text='Failed fixture'); yield StreamEvent(kind='finish',finish_reason='stop')
    env.server.llm_factory=FakeRunFactory(Backend(),context_window=128000)
    for i in range(3):
        await accept(env,c,key=str(i)); await env.worker.tick(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller'))
        await notifications.tick(env.s)
    clock[0]+=61000; await notifications.tick(env.s)
    evidence('not_a_digest',outboxRows=(await one(env.db.conn,"SELECT count(*) n FROM web_task_notifications WHERE kind='webhook-result'"))['n'],deliveries=deliveries)
    assert len(deliveries)==1
    row=await one(env.db.conn,"SELECT payload_json FROM web_task_notifications WHERE kind='webhook-result'")
    assert len(json.loads(row['payload_json'])['assignments'])==3
    assert (await one(env.db.conn,'SELECT count(DISTINCT notification_key) n FROM webhook_assignments'))['n']==1

async def test_fixed_webhook_channel_ack_loss_retries_non_idempotent_send(env,monkeypatch):
    from types import SimpleNamespace
    from app.webhooks import notifications
    from app.web_task_telegram import WebTaskTelegramNotifier
    from tests.test_web_task_telegram import _config
    from tests.test_webhooks_controls_matrix import reporting_backend
    from app import telegram_ui
    path=env.tmp/'telegram-simulator-ledger.txt'; external=[]
    class Bot:
        async def send_message(self,*args,**kwargs):
            external.append('remote accepted'); path.write_text('\n'.join(external))
            if len(external)==1: raise TimeoutError('remote accepted; local ACK lost')
            return SimpleNamespace(message_id=100+len(external))
    clock=[1000000]; env.s.clock=lambda:clock[0]
    monkeypatch.setattr('app.web_task_telegram._now',lambda:clock[0]//1000)
    monkeypatch.setattr(telegram_ui,'USE_RICH_MESSAGES',False)
    notifier=WebTaskTelegramNotifier(_config(),env.db,Bot()); env.server.web_task_telegram=notifier
    c=await create(env,batching={'enabled':False}); await accept(env,c)
    backend=reporting_backend(env); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    await env.worker.tick(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller'))
    clock[0]+=200000; await notifications.tick(env.s)
    item=await notifier._claim_due(); assert item
    await notifier._deliver(item)
    first=await one(env.db.conn,'SELECT state,last_error,telegram_message_ids_json FROM web_tg_notification_outbox')
    clock[0]+=10000
    item2=await notifier._claim_due(); assert item2 is None
    evidence('notification_ack_loss',afterFirst=first,channelAfterRetry=await one(env.db.conn,'SELECT state,attempts FROM web_tg_notification_outbox'),externalSendCount=len(external),modelCalls=backend.calls,webhookDelivery=(await one(env.db.conn,"SELECT state FROM web_task_notifications WHERE kind='webhook-result'"))['state'])
    assert first['state']=='unknown' and len(external)==1
    key=(await one(env.db.conn,"SELECT notification_key FROM web_task_notifications WHERE kind='webhook-result'"))['notification_key']
    channels=await notifications.channel_delivery_states(env.s,key)
    assert channels==[{'channel':'telegram','state':'unknown','error':'TimeoutError:verify_before_retry','verificationRequired':True}]
    assert await notifications.channel_delivery_states(env.s,'not-owned')==[]
    evidence('notification_channel_visible',channels=channels)
    # Legacy v1 had no route marker. Startup reconstructs only known webhook
    # roots before deciding whether an in-flight physical send can be retried.
    await env.db.conn.execute('DELETE FROM webhook_notification_routes')
    await env.db.conn.execute("UPDATE web_tg_notification_outbox SET state='processing'"); await env.db.conn.commit()
    await notifier.start()
    try:
        assert (await notifications.channel_delivery_states(env.s,key))[0]['state']=='unknown'
        assert await notifier._claim_due() is None and len(external)==1
    finally: await notifier.stop()

async def test_fixed_endpoint_local_slot_release_and_reacquire(env):
    c=await create(env,batching={'enabled':False},limits={'autoModelConcurrency':1})
    first=await accept(env,c); second_entered=asyncio.Event(); release=asyncio.Event()
    class Backend(FakeStreamBackend):
        def __init__(self): super().__init__(); self.steps={}; self.first_run=None
        async def stream(self,messages,**kwargs):
            run=current_session().run_id
            if self.first_run is None: self.first_run=run
            step=self.steps.get(run,0)+1; self.steps[run]=step; self.calls+=1
            yield StreamEvent(kind='usage',usage=Usage(input_tokens=1),details={'providerCostUsd':0.0})
            if run==self.first_run and step==1:
                args={'action':'wait','params':{'op':'register','endpointId':c['endpoint']['id'],'requestId':'w','match':match(),'timeoutSeconds':100}}
            elif run==self.first_run and step==2:
                w=await one(env.db.conn,'SELECT wait_id FROM webhook_waits')
                args={'action':'wait','params':{'op':'await','waitId':w['wait_id']}}
            elif (run==self.first_run and step==3) or (run!=self.first_run and step==1):
                if run!=self.first_run:
                    second_entered.set(); await release.wait()
                event=await one(env.db.conn,'SELECT event_id FROM webhook_assignment_events m JOIN webhook_runtime_links l USING(assignment_id) WHERE l.run_id=?',(run,))
                args={'action':'report','params':{'receiptId':'r','results':[{'eventId':event['event_id'],'outcome':'completed'}]}}
            else:
                yield StreamEvent(kind='content',text='Done'); yield StreamEvent(kind='finish',finish_reason='stop'); return
            yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('t'+str(step),'Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    await env.worker.tick(); await eventually(lambda:bool(env.bridge.waiting_assignments))
    second=await accept(env,c,'{"kind":"ordinary"}','second'); await env.worker.tick(); await asyncio.wait_for(second_entered.wait(),5)
    w=await one(env.db.conn,'SELECT * FROM webhook_waits')
    await waits.cancel(env.s,w['assignment_id'],w['wait_id'])
    await asyncio.sleep(.12)
    assert backend.steps[backend.first_run]==2
    assert len(env.bridge.active-env.bridge.waiting_assignments)==1
    evidence('local_wait_capacity',assignments=2,firstModelCallsBeforeRelease=2,executing=1,waiting=1)
    release.set(); await asyncio.wait_for(asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller')),10)
    rows=await many(env.db.conn,'SELECT state,terminal_reason FROM webhook_assignments')
    assert len(rows)==2 and all(r=={'state':'finalized','terminal_reason':'normal'} for r in rows)
    assert backend.steps[backend.first_run]==4
    evidence('local_slot_reacquired',assignments=rows,firstModelCallsAfterRelease=4)

@pytest.mark.parametrize('phase',['route','pre','sealed'])
@pytest.mark.parametrize('raw',[b'{"x":1e999}',b'{"x":"\\ud800"}'])
async def test_persisted_poison_isolated_without_losing_acceptance(env,phase,raw,monkeypatch):
    opts={'pre':{'enabled':True,'code':'print(\'{"decision":"skip_model","outcome":"handled"}\')'}} if phase=='pre' else {'batching':{'enabled':False}}
    c=await create(env,**opts); d=await other_endpoint(env,**opts)
    from app.webhooks import ingress
    # Recreate v1 acceptance in this isolated fixture only; then restore the
    # hardened parser before the consumer sees the original durable bytes.
    with monkeypatch.context() as old_parser:
        old_parser.setattr(ingress,'parse_body',lambda content_type,value: json.loads(value))
        bad=await env.s.receive(c['endpoint']['id'],c['credential']['key'],'application/json',raw,[],'old')
    good=await accept(env,d)
    if phase=='sealed':
        from app.webhooks.repository import insert,uid
        async with env.db.webhook_transaction() as conn:
            bid=uid()
            await insert(conn,'webhook_batches',batch_id=bid,endpoint_id=c['endpoint']['id'],revision=1,aggregation_key='legacy',state='collecting',first_entered_at_ms=env.s.clock(),last_entered_at_ms=env.s.clock())
            seq=(await one(conn,'SELECT receive_seq FROM webhook_events WHERE event_id=?',(bad['eventId'],)))['receive_seq']
            await insert(conn,'webhook_batch_members',batch_id=bid,event_id=bad['eventId'],receive_seq=seq,entered_at_ms=env.s.clock(),snapshot_bytes=len(raw))
            await conn.execute("UPDATE webhook_events SET route_state='batch' WHERE event_id=?",(bad['eventId'],))
            await routing.seal(env.s,conn,bid,'disabled')
    await env.worker.tick(); await asyncio.gather(*list(env.worker.tasks.values()))
    event=await one(env.db.conn,'SELECT route_state,review_required,terminal_reason,terminal_at_ms FROM webhook_events WHERE event_id=?',(bad['eventId'],))
    healthy=await one(env.db.conn,'SELECT route_state FROM webhook_events WHERE event_id=?',(good['eventId'],))
    assert event=={'route_state':'hold','review_required':1,'terminal_reason':'invalid_persisted_material','terminal_at_ms':None}
    assert healthy['route_state'] in ('assigned','terminal')
    assert bytes((await one(env.db.conn,'SELECT body_bytes FROM webhook_event_payloads WHERE event_id=?',(bad['eventId'],)))['body_bytes'])==raw
    assert (await env.s.get(123,c['endpoint']['id']))['endpoint']['pendingEvents']==1
    evidence('persisted_poison_'+phase,event=event,healthy=healthy,originalAcceptance=bad['status'])

async def test_webhook_unknown_restart_and_ordinary_retry_unchanged(env,monkeypatch):
    from types import SimpleNamespace
    from app.web_task_telegram import WebTaskTelegramNotifier
    from tests.test_web_task_telegram import _config
    from app import telegram_ui
    clock=[1000]; monkeypatch.setattr('app.web_task_telegram._now',lambda:clock[0]); monkeypatch.setattr(telegram_ui,'USE_RICH_MESSAGES',False)
    sent=[]
    class Bot:
        async def send_message(self,*args,**kwargs):
            sent.append('ordinary accepted')
            if len(sent)==1: raise TimeoutError('lost')
            return SimpleNamespace(message_id=123)
    notifier=WebTaskTelegramNotifier(_config(),env.db,Bot())
    row=await env.server._create_web_conversation(123,title='Notification fixture')
    event={'conversationUuid':row['conversation_uuid'],'rootTurnUuid':'ordinary','turnUuid':'ordinary','runUuid':'ordinary','ts':1000000}
    await notifier.observe({**event,'type':'accepted'},owner_chat_id=123,internal_chat_id=row['internal_chat_id'])
    clock[0]+=200
    await notifier.observe({**event,'type':'final','text':'Ordinary result'},owner_chat_id=123,internal_chat_id=row['internal_chat_id'])
    await notifier.observe({**event,'type':'done'},owner_chat_id=123,internal_chat_id=row['internal_chat_id'])
    item=await notifier._claim_due(); await notifier._deliver(item)
    assert (await one(env.db.conn,'SELECT state FROM web_tg_notification_outbox'))['state']=='pending'
    clock[0]+=10; item=await notifier._claim_due(); await notifier._deliver(item); assert len(sent)==2
    # Crash after claim is unknown only for the webhook-marked channel root.
    await env.db.conn.execute("INSERT INTO webhook_notification_routes VALUES('ordinary','webhook:test',0)")
    await env.db.conn.execute("UPDATE web_tg_notification_outbox SET state='processing'"); await env.db.conn.commit()
    await notifier.start()
    try:
        assert (await one(env.db.conn,'SELECT state FROM web_tg_notification_outbox'))['state']=='unknown'
        assert await notifier._claim_due() is None
    finally: await notifier.stop()
    evidence('channel_policy_scoped',ordinarySends=len(sent),webhookRecoveredState='unknown')
