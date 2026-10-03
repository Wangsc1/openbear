"""Focused runtime business boundaries with real hosts, HTTP and subprocesses."""
import asyncio
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from app.llm.events import StreamEvent, ToolCall
from app.webhooks.repository import many, one
from app.webhooks import routing
from tests.test_web_admin import FakeRunFactory, FakeStreamBackend
from tests.test_webhooks_backend import env, create, accept


async def eventually(predicate):
    async with asyncio.timeout(5):
        while not predicate(): await asyncio.sleep(.005)


@pytest.mark.parametrize('callback_needs_pre',[True,False])
async def test_serial_pre_wait_release_and_resume_exclusion(env,callback_needs_pre):
    entered=asyncio.Event(); release=asyncio.Event(); actions=[]
    async def barrier(request):
        actions.append(await request.text()); entered.set(); await release.wait()
        return web.Response(text='done')
    app=web.Application(); app.router.add_post('/pre',barrier)
    simulator=TestServer(app); await simulator.start_server()
    conversation=await env.server._create_web_conversation(123,folder_uuid='folder',title='Serial wait')
    cid=conversation['conversation_uuid']
    c=await create(env,target={'mode':'fixedConversation','conversationId':cid},batching={'enabled':False})
    code='import json,sys,urllib.request\nx=json.load(sys.stdin)\nurllib.request.urlopen(urllib.request.Request('+repr(str(simulator.make_url('/pre')))+',data=x["actionKey"].encode())).read()\nprint(json.dumps({"decision":"continue"}))'
    serial=await env.s.create(123,{'scope':{'type':'conversation','id':cid},'enabled':True,'requestId':'serial','config':{'processing':{'instructions':'Serial callback','scriptScheduling':'serial'},'pre':{'enabled':True,'code':code},'batching':{'enabled':False}}})
    initial=await accept(env,c,'{"kind":"start"}','initial')
    endpoint=serial if callback_needs_pre else c
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if self.calls==1:
                params={'op':'register','requestId':'w','endpointId':endpoint['endpoint']['id'],'match':{'all':[{'path':'body.kind','op':'eq','value':'reply'}]},'timeoutSeconds':20}
                args={'action':'wait','params':params}
            elif self.calls==2:
                registered=json.loads([m['content'] for m in messages if m['role']=='tool'][-1])
                args={'action':'wait','params':{'op':'await','waitId':registered['waitId']}}
            elif self.calls==3:
                assert release.is_set(), 'model resumed while serial pre still running'
                delivered=json.loads([m['content'] for m in messages if m['role']=='tool'][-1])
                args={'action':'report','params':{'receiptId':'all','results':[{'eventId':initial['eventId'],'outcome':'completed'}]+[{'eventId':e['eventId'],'outcome':'completed'} for e in delivered['events']]}}
            else:
                yield StreamEvent(kind='content',text='Complete'); yield StreamEvent(kind='finish',finish_reason='stop'); return
            yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('t'+str(self.calls),'Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    try:
        await env.worker.tick(); tasks=env.server.runs.scheduler.tasks(kind='controller')
        await eventually(lambda:bool(env.bridge.waiting_assignments))
        running=await accept(env,serial,'{"kind":"reply"}' if callback_needs_pre else '{"kind":"other"}','pre')
        await env.worker.tick(); await asyncio.wait_for(entered.wait(),5)
        second=await accept(env,serial,'{"kind":"other"}','queued')
        await env.worker.tick()
        assert len(actions)==1 and len(env.worker.tasks)==1
        if not callback_needs_pre:
            callback=await accept(env,c,'{"kind":"reply"}','reply'); await routing.tick(env.s)
            from app.webhooks.waits import delivery
            w=await one(env.db.conn,'SELECT * FROM webhook_waits')
            assert await delivery(env.s,w['assignment_id'],w['wait_id'],reserve_execution=True) is None
            assert (await one(env.db.conn,'SELECT delivered_at_ms FROM webhook_assignment_events WHERE event_id=?',(callback['eventId'],)))['delivered_at_ms'] is None
            assert backend.calls==2
        release.set(); await asyncio.wait_for(asyncio.gather(*list(env.worker.tasks.values())),5)
        await routing.tick(env.s); env.s.wake.set()
        await asyncio.wait_for(asyncio.gather(*tasks),10)
        assert backend.calls==4
        a=await one(env.db.conn,'SELECT * FROM webhook_assignments'); assert a['state']=='finalized' and a['terminal_reason']=='normal'
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_assignments'))['n']==1
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_stage_attempts'))['n']==1
    finally:
        release.set(); await simulator.close()


async def test_human_wait_preserves_goal_and_has_no_webhook_bill_or_post(env):
    from app.webhooks.queries import usage
    conversation=await env.server._create_web_conversation(123,folder_uuid='folder',title='Human wait')
    c=await create(env,processing={'instructions':'DO NOT APPLY ENDPOINT GOAL'},post={'enabled':True,'code':'print("{}")'})
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            assert 'DO NOT APPLY ENDPOINT GOAL' not in str(messages)
            if self.calls==1: args={'action':'wait','params':{'op':'register','requestId':'human','endpointId':c['endpoint']['id'],'match':{'all':[{'path':'body.kind','op':'eq','value':'reply'}]}}}
            elif self.calls==2:
                w=json.loads([m['content'] for m in messages if m['role']=='tool'][-1]); args={'action':'wait','params':{'op':'await','waitId':w['waitId']}}
            elif self.calls==3:
                d=json.loads([m['content'] for m in messages if m['role']=='tool'][-1]); args={'action':'report','params':{'receiptId':'human','results':[{'eventId':d['events'][0]['eventId'],'outcome':'completed'}]}}
            else:
                yield StreamEvent(kind='content',text='Human goal remains'); yield StreamEvent(kind='finish',finish_reason='stop'); return
            yield StreamEvent(kind='tool_call',tool_calls=[ToolCall(str(self.calls),'Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    await env.server._start_or_steer_web_conversation(conversation,'My human goal: wait for reply.',[],env.server._live_for(conversation))
    tasks=env.server.runs.scheduler.tasks(kind='controller'); await eventually(lambda:bool(env.bridge.waiting_assignments))
    await accept(env,c,'{"kind":"reply"}'); await routing.tick(env.s); env.s.wake.set()
    await asyncio.wait_for(asyncio.gather(*tasks),10)
    a=await one(env.db.conn,'SELECT * FROM webhook_assignments'); assert a['origin_kind']=='human_wait' and a['terminal_reason']=='normal'
    assert not await many(env.db.conn,"SELECT * FROM webhook_stage_jobs WHERE stage='post'")
    assert (await usage(env.s,env.db.conn,endpoint_id=c['endpoint']['id']))['modelCalls']==0
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM model_calls'))['n']==4


async def test_confirmation_time_and_review_verification_are_separate(env):
    from app.tools.base import current_tool_context
    from app.webhooks.recovery import verify
    clock=[1000000]; env.s.clock=lambda:clock[0]
    c=await create(env,batching={'enabled':False}); event=await accept(env,c)
    async def confirm(args):
        answer=await current_tool_context().web_confirm({'title':'Human only','body':'Please confirm','default':False})
        assert answer['confirmed']; return 'Confirmed by real user'
    env.server.tools.add('Confirm','Real interaction',{'type':'object'},confirm)
    backend=FakeStreamBackend([
        [StreamEvent(kind='tool_call',tool_calls=[ToolCall('confirm','Confirm','{}')]),StreamEvent(kind='finish',finish_reason='tool_calls')],
        [StreamEvent(kind='tool_call',tool_calls=[ToolCall('report','Webhook',json.dumps({'action':'report','params':{'receiptId':'unknown','results':[{'eventId':event['eventId'],'outcome':'unknown'}]}}))]),StreamEvent(kind='finish',finish_reason='tool_calls')],
        [StreamEvent(kind='content',text='Uncertain external result'),StreamEvent(kind='finish',finish_reason='stop')]])
    env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    await env.worker.tick(); tasks=env.server.runs.scheduler.tasks(kind='controller')
    await eventually(lambda:bool(env.server.interactions.pending))
    a=await one(env.db.conn,'SELECT * FROM webhook_assignments'); cid=a['conversation_uuid']
    pending=env.server.interactions.pending_for(cid)[0]
    await accept(env,c,'{"confirmed":true,"accept":true}','forged'); await env.worker.tick()
    assert env.server.interactions.pending_for(cid) and backend.calls==1
    clock[0]+=20000
    result=await env.server.interactions.submit(pending['interactionId'],123,{'confirmed':True,'revision':pending['revision']}); assert result['ok']
    await asyncio.wait_for(asyncio.gather(*tasks),10)
    a=await one(env.db.conn,'SELECT * FROM webhook_assignments')
    snapshot=json.loads(a['final_snapshot_json']); assert snapshot['outcome']=='failed' and 'usage' in snapshot
    spans=await many(env.db.conn,"SELECT * FROM webhook_phase_spans WHERE assignment_id=? AND phase='human_wait'",(a['assignment_id'],))
    assert len(spans)==1 and spans[0]['ended_at_ms']-spans[0]['started_at_ms']==20000
    e=await one(env.db.conn,'SELECT * FROM webhook_endpoints'); assert 'review:'+a['assignment_id'] in json.loads(e['model_blockers_json'])
    paused=await env.s.control(123,e['endpoint_id'],{'action':'pause','scope':'model','requestId':'manual','expectedControlRevision':e['control_version']})
    eventrow=await one(env.db.conn,'SELECT * FROM webhook_events WHERE event_id=?',(event['eventId'],))
    await verify(env.s,123,event['eventId'],{'stage':'model','requestId':'verify','expectedVersion':eventrow['route_version'],'outcome':'completed','reason':'External ledger inspected','evidenceRefs':['simulator:ledger']})
    blockers=json.loads((await one(env.db.conn,'SELECT * FROM webhook_endpoints'))['model_blockers_json'])
    assert 'review:'+a['assignment_id'] not in blockers and blockers


async def test_real_child_agent_blocks_finalization_and_is_billed_once(env):
    from types import SimpleNamespace
    from app.agents.dao import AgentDAO
    from app.agents.profiles import ensure_builtin_workflows
    from app.agents.schemas import AgentDefinition
    from app.agents.execution import AgentExecutor
    from app.tools.agents import AgentTools
    from app.tools.base import ToolRegistry,current_tool_context
    from app.llm.base import AgentResult
    from app.llm.events import Usage
    from app.webhooks.queries import usage
    dao=AgentDAO(env.db); env.server.agent_dao=dao
    workflow=await ensure_builtin_workflows(dao)
    agent=AgentDefinition(workflow_uuid=workflow,agent_key='fixture',name='Fixture',description='isolated',system_prompt='No external calls',model='openai/gpt',enabled=True,id=7)
    entered=asyncio.Event(); release=asyncio.Event(); child_tasks=[]
    c=await create(env,batching={'enabled':False}); event=await accept(env,c)
    class Child:
        protocol='chat'
        async def complete(self,messages,**kwargs):
            entered.set(); await release.wait()
            return AgentResult(text='Child complete',usage=Usage(input_tokens=300,cache_read_tokens=100,output_tokens=40),provider_cost_usd=.004,finish_reason='stop')
    async def spawn(args):
        ctx=current_tool_context()
        tid=await dao.create_task(chat_id=ctx.chat_id,workflow_uuid=workflow,title='Child',input_data={'instruction':'Isolated child'},parent_session_uuid=ctx.conversation_uuid,run_root_turn_uuid=ctx.run_root_turn_uuid)
        async def account(detail):
            await AgentTools._persist_agent_model_call(SimpleNamespace(dao=dao),chat_id=ctx.chat_id,session_uuid=ctx.session_uuid,model_label='openai/gpt',protocol='chat',detail=detail)
        runner=AgentExecutor(dao,tid,agent=agent,backend=Child(),model='gpt',model_label='openai/gpt',max_tokens=1024,tools=ToolRegistry(),on_model_call=account)
        task=asyncio.create_task(runner.run()); child_tasks.append(task)
        task.add_done_callback(lambda t:env.server._web_controller_wake_events[ctx.conversation_uuid].set())
        await entered.wait(); return 'Child started'
    env.server.tools.add('SpawnOwned','Start isolated owned work',{'type':'object'},spawn)
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if self.calls==1:
                yield StreamEvent(kind='usage',usage=Usage(input_tokens=100,cache_read_tokens=200,cache_write_tokens=50,output_tokens=20),details={'providerCostUsd':.003})
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('spawn','SpawnOwned','{}'),ToolCall('report','Webhook',json.dumps({'action':'report','params':{'receiptId':'one','results':[{'eventId':event['eventId'],'outcome':'completed'}]}}))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
            else:
                yield StreamEvent(kind='usage',usage=Usage(),details={'providerCostUsd':0.0})
                yield StreamEvent(kind='content',text='Final candidate'); yield StreamEvent(kind='finish',finish_reason='stop')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    try:
        await env.worker.tick(); tasks=env.server.runs.scheduler.tasks(kind='controller')
        await asyncio.wait_for(entered.wait(),5); await eventually(lambda:backend.calls==2)
        a=await one(env.db.conn,'SELECT * FROM webhook_assignments'); assert a['state']=='open'
        await env.worker.tick(); assert len(await many(env.db.conn,'SELECT * FROM webhook_assignments'))==1
        release.set(); await asyncio.wait_for(asyncio.gather(*child_tasks,*tasks),10)
        a=await one(env.db.conn,'SELECT * FROM webhook_assignments'); assert a['terminal_reason']=='normal'
        links=await many(env.db.conn,'SELECT * FROM webhook_runtime_links'); assert {r['relation_kind'] for r in links}=={'agent','controller'}
        u=await usage(env.s,env.db.conn,endpoint_id=c['endpoint']['id'])
        assert (u['inputTokens'],u['cacheReadTokens'],u['cacheWriteTokens'],u['outputTokens'],u['cacheHitRate'])==(400,300,50,60,.4)
        assert u['costUsd']==pytest.approx(.007) and u['modelCalls']==backend.calls+1
        assert await usage(env.s,env.db.conn,endpoint_id=c['endpoint']['id'])==u
        assert json.loads(a['final_snapshot_json'])['usage']==u
    finally:
        release.set(); await asyncio.gather(*child_tasks,return_exceptions=True)


async def test_human_correction_interrupts_external_wait_without_faking_delivery(env):
    c=await create(env,batching={'enabled':False}); event=await accept(env,c)
    class Backend(FakeStreamBackend):
        wait_id=None
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if self.calls==1: args={'action':'wait','params':{'op':'register','requestId':'w','endpointId':c['endpoint']['id'],'match':{'all':[{'path':'body.kind','op':'eq','value':'reply'}]}}}
            elif self.calls==2:
                self.wait_id=json.loads([m['content'] for m in messages if m['role']=='tool'][-1])['waitId']; args={'action':'wait','params':{'op':'await','waitId':self.wait_id}}
            elif self.calls==3:
                assert 'Human correction: do not await callback' in str(messages)
                response=json.loads([m['content'] for m in messages if m['role']=='tool'][-1]); assert response['state']=='human_interruption' and response['events']==[]
                args={'action':'wait','params':{'op':'cancel','waitId':self.wait_id}}
            elif self.calls==4: args={'action':'report','params':{'receiptId':'r','results':[{'eventId':event['eventId'],'outcome':'skipped'}]}}
            else:
                yield StreamEvent(kind='content',text='Following human correction'); yield StreamEvent(kind='finish',finish_reason='stop'); return
            yield StreamEvent(kind='tool_call',tool_calls=[ToolCall(str(self.calls),'Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    await env.worker.tick(); tasks=env.server.runs.scheduler.tasks(kind='controller'); await eventually(lambda:bool(env.bridge.waiting_assignments))
    row=await one(env.db.conn,'SELECT * FROM web_conversations')
    await env.server._start_or_steer_web_conversation(row,'Human correction: do not await callback',[],env.server._live_for(row))
    await asyncio.wait_for(asyncio.gather(*tasks),10)
    assert (await one(env.db.conn,'SELECT terminal_reason FROM webhook_assignments'))['terminal_reason']=='normal'
    assert (await one(env.db.conn,'SELECT state FROM webhook_waits'))['state']=='cancelled'
    assert len(await many(env.db.conn,'SELECT * FROM webhook_assignment_events'))==1 and backend.calls==5


async def test_queued_human_acceptance_wins_over_automatic_batch(env):
    conv=await env.server._create_web_conversation(123,folder_uuid='folder',title='Human priority')
    c=await create(env,target={'mode':'fixedConversation','conversationId':conv['conversation_uuid']},batching={'enabled':False})
    await accept(env,c); await routing.tick(env.s)
    entered=asyncio.Event(); release=asyncio.Event()
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1; entered.set(); await release.wait()
            yield StreamEvent(kind='content',text='Ordinary human reply needs no report'); yield StreamEvent(kind='finish',finish_reason='stop')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    try:
        async with env.server.operation_locks.chat(conv['internal_chat_id'],'fixture-barrier'):
            human=asyncio.create_task(env.server._start_or_steer_web_conversation(conv,'Human goal',[],env.server._live_for(conv)))
            await eventually(lambda:bool(env.server.operation_locks._waiting.get(conv['internal_chat_id'])))
            await env.bridge.dispatch()
            assert not await many(env.db.conn,'SELECT * FROM webhook_assignments')
        await human; await entered.wait()
        tasks=env.server.runs.scheduler.tasks(kind='controller')
        await env.bridge.dispatch(); assert not await many(env.db.conn,'SELECT * FROM webhook_assignments')
        release.set(); await asyncio.wait_for(asyncio.gather(*tasks),10)
        assert backend.calls==1 and not await many(env.db.conn,'SELECT * FROM webhook_receipts')
    finally: release.set()


async def test_receipt_evidence_requires_owned_finished_action_and_active_run(env):
    from tests.test_webhooks_wait_acceptance import held
    from app.webhooks.receipts import report
    from app.webhooks.contracts import WebhookError
    from app.runtime.store import RuntimeStore
    async with held(env) as (c,a,first,release):
        link=await one(env.db.conn,'SELECT * FROM webhook_runtime_links')
        store=RuntimeStore(env.db)
        foreign=await store.begin_run('fixture:foreign')
        foreign_action=await store.begin_action(foreign,'tool',name='Foreign')
        await store.finish_action(foreign_action,status='completed')
        active_action=(await one(env.db.conn,'SELECT action_id FROM runtime_actions WHERE run_id=?',(link['run_id'],)))['action_id']
        for ref in ['tool-action:missing','tool-action:'+foreign_action,'tool-action:'+active_action]:
            with pytest.raises(WebhookError,match='invalid_evidence_reference'):
                await report(env.s,a['assignment_id'],link['run_id'],{'receiptId':ref,'results':[{'eventId':first['eventId'],'outcome':'completed','evidenceRefs':[ref]}]})
        action=await store.begin_action(link['run_id'],'tool',name='Owned')
        await store.finish_action(action,status='completed')
        result=await report(env.s,a['assignment_id'],link['run_id'],{'receiptId':'owned','results':[{'eventId':first['eventId'],'outcome':'completed','evidenceRefs':['tool-action:'+action]}]})
        assert result['businessDeclarationSource']=='model' and not result['chainFinalized']
        old_run=await store.begin_run('fixture:old')
        from app.tools.base import ToolRuntimeContext
        async with env.db.webhook_transaction() as conn:
            await env.bridge.link(conn,ToolRuntimeContext(run_id=old_run,webhook_assignment_id=a['assignment_id'],webhook_automatic=True))
        await store.transition(old_run,'interrupted')
        with pytest.raises(WebhookError,match='report_not_owned'):
            await report(env.s,a['assignment_id'],old_run,{'receiptId':'stale','results':[{'eventId':first['eventId'],'outcome':'unknown'}]})
