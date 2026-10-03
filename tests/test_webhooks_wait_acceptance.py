"""Runtime-owned wait routing and control ordering, deterministic barriers."""
import asyncio
import json
from contextlib import asynccontextmanager

import pytest
from app.llm.events import StreamEvent, ToolCall
from app.webhooks import waits, routing, receipts
from app.webhooks.contracts import WebhookError
from app.webhooks.repository import one, many
from tests.test_web_admin import FakeRunFactory, FakeStreamBackend
from tests.test_webhooks_backend import env, create, accept


@asynccontextmanager
async def held(env,**config):
    conv=await env.server._create_web_conversation(123,folder_uuid='folder',title='Held real controller')
    c=await create(env,target={'mode':'fixedConversation','conversationId':conv['conversation_uuid']},batching={'enabled':False},**config)
    entered=asyncio.Event(); release=asyncio.Event()
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if self.calls==1:
                entered.set(); await release.wait()
                rows=await many(env.db.conn,'SELECT m.event_id FROM webhook_assignment_events m WHERE m.delivered_at_ms IS NOT NULL AND NOT EXISTS(SELECT 1 FROM webhook_receipts r WHERE r.assignment_event_id=m.assignment_event_id)')
                args={'action':'report','params':{'receiptId':'all','results':[{'eventId':r['event_id'],'outcome':'completed'} for r in rows]}}
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('all','Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
            else:
                yield StreamEvent(kind='content',text='Done'); yield StreamEvent(kind='finish',finish_reason='stop')
    env.server.llm_factory=FakeRunFactory(Backend(),context_window=128000)
    first=await accept(env,c,'{"kind":"start"}','first'); await env.worker.tick()
    await asyncio.wait_for(entered.wait(),5)
    a=await one(env.db.conn,'SELECT * FROM webhook_assignments'); tasks=env.server.runs.scheduler.tasks(kind='controller')
    try: yield c,a,first,release
    finally:
        for w in await many(env.db.conn,"SELECT * FROM webhook_waits WHERE state IN ('registered','collecting','sealed')"):
            await waits.cancel(env.s,a['assignment_id'],w['wait_id'])
        release.set()
        results=await asyncio.wait_for(asyncio.gather(*tasks,return_exceptions=True),10)
        assert all(not isinstance(r,BaseException) or isinstance(r,asyncio.CancelledError) for r in results),results


def match(value='reply'):
    return {'all':[{'path':'body.kind','op':'eq','value':value}]}


@pytest.mark.parametrize('sealed',[False,True])
async def test_C01_C07_C08_C11_actual_runtime_backclaim(env,sealed):
    async with held(env) as (c,a,first,release):
        # New ordinary events cannot preempt the live model or create a second run.
        config=c['endpoint']['config']; config['batching']={'enabled':True,'maxEvents':1 if sealed else 10}
        await env.s.update(123,c['endpoint']['id'],{'expectedRevision':1,'requestId':'collect','config':config})
        callback=await accept(env,c,'{"kind":"reply"}','reply'); unrelated=await accept(env,c,'{"kind":"other"}','other')
        await routing.tick(env.s); await env.bridge.dispatch()
        assert len(await many(env.db.conn,'SELECT * FROM webhook_assignments'))==1
        batch=await one(env.db.conn,'SELECT * FROM webhook_batches WHERE revision=2 ORDER BY first_entered_at_ms')
        assert batch['state']==('sealed' if sealed else 'collecting')
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'register','match':match(),'afterSeq':a['task_start_cursor'],'timeoutSeconds':10})
        m=await one(env.db.conn,'SELECT * FROM webhook_assignment_events WHERE event_id=?',(callback['eventId'],))
        assert m['assignment_id']==a['assignment_id'] and m['delivered_at_ms'] is None
        assert (await one(env.db.conn,'SELECT invalidated_reason FROM webhook_batch_members WHERE event_id=?',(callback['eventId'],)))['invalidated_reason']=='wait_claim'
        assert not await one(env.db.conn,'SELECT * FROM webhook_assignment_events WHERE event_id=?',(unrelated['eventId'],))
        d=await waits.delivery(env.s,a['assignment_id'],w['waitId']); assert [e['eventId'] for e in d['events']]==[callback['eventId']]
        assert await waits.delivery(env.s,a['assignment_id'],w['waitId'])==d
        with pytest.raises(WebhookError): await waits.register(env.s,a['assignment_id'],999,{'endpointId':c['endpoint']['id'],'requestId':'denied','match':match()})


async def test_C10_conflict_resolve_with_cas(env):
    from app.webhooks.recovery import wait_control
    async with held(env) as (c,a,first,release):
        w1=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'one','match':match()})
        w2=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'two','match':{'all':[{'path':'body.kind','op':'exists','value':True}]}})
        same=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'same','match':match()}); assert same['waitId']==w1['waitId']
        b=await accept(env,c,'{"kind":"reply"}','b'); await routing.tick(env.s)
        e=await one(env.db.conn,'SELECT * FROM webhook_events WHERE event_id=?',(b['eventId'],)); assert e['route_state']=='match_conflict'
        assert len(await many(env.db.conn,'SELECT * FROM webhook_wait_candidates'))==2
        await wait_control(env.s,123,w2['waitId'],{'action':'resolve_match','eventId':b['eventId'],'requestId':'choose','expectedVersion':w2['version']})
        d=await waits.delivery(env.s,a['assignment_id'],w2['waitId']); assert d['events'][0]['eventId']==b['eventId']
        assert len(await many(env.db.conn,'SELECT * FROM webhook_assignment_events WHERE event_id=?',(b['eventId'],)))==1


@pytest.mark.parametrize('end',['cancel','timeout','expiry'])
async def test_C12_C13_claim_undelivered_terminal(env,end):
    clock=[1000000]; env.s.clock=lambda:clock[0]
    async with held(env,expiry={'ttlSeconds':10}) as (c,a,first,release):
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'one','match':match(),'timeoutSeconds':10 if end=='timeout' else 100})
        b=await accept(env,c,'{"kind":"reply"}','b'); await routing.tick(env.s)
        if end=='cancel': await waits.cancel(env.s,a['assignment_id'],w['waitId'])
        else: clock[0]+=10000
        d=await waits.delivery(env.s,a['assignment_id'],w['waitId'])
        if end=='expiry': assert d is None
        else: assert d['events']==[] and d['state']==('cancelled' if end=='cancel' else 'timed_out')
        m=await one(env.db.conn,'SELECT * FROM webhook_assignment_events WHERE event_id=?',(b['eventId'],)); assert m['delivered_at_ms'] is None
        r=await one(env.db.conn,'SELECT * FROM webhook_receipts WHERE assignment_event_id=?',(m['assignment_event_id'],)); assert r['disposition']=={'cancel':'cancelled','timeout':'not_delivered','expiry':'expired'}[end]
        await routing.tick(env.s)
        assert not await one(env.db.conn,'SELECT * FROM webhook_batch_members WHERE event_id=?',(b['eventId'],))


async def test_C15_D01_F21_pause_then_resume_preserves_wait_deadline(env):
    async with held(env) as (c,a,first,release):
        eid=c['endpoint']['id']; w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':eid,'requestId':'one','match':match(),'timeoutSeconds':60})
        await env.s.control(123,eid,{'action':'pause','requestId':'pause','expectedControlRevision':0})
        b=await accept(env,c,'{"kind":"reply"}','b'); await routing.tick(env.s)
        assert not await one(env.db.conn,'SELECT * FROM webhook_assignment_events WHERE event_id=?',(b['eventId'],))
        assert await waits.delivery(env.s,a['assignment_id'],w['waitId']) is None
        config=c['endpoint']['config']; config['processing']['instructions']='new rules do not replace the active round'
        await env.s.update(123,eid,{'requestId':'edit','expectedRevision':1,'config':config})
        await env.s.control(123,eid,{'action':'resume','requestId':'resume','expectedControlRevision':1})
        await routing.tick(env.s)
        d=await waits.delivery(env.s,a['assignment_id'],w['waitId']); assert d['events'][0]['eventId']==b['eventId']
        assert (await one(env.db.conn,'SELECT deadline_ms FROM webhook_waits'))['deadline_ms']==w['deadline']
        assert (await one(env.db.conn,'SELECT origin_revision FROM webhook_assignments'))['origin_revision']==1
        # Stop is terminal for this runtime; a late callback stays queued under stop blocker.
        await env.s.control(123,eid,{'action':'stop','scope':'current','requestId':'stop','expectedControlRevision':2})
        late=await accept(env,c,'{"kind":"reply"}','late'); await env.worker.tick()
        assert len(await many(env.db.conn,'SELECT * FROM webhook_assignments'))==1
        assert not await one(env.db.conn,'SELECT * FROM webhook_assignment_events WHERE event_id=?',(late['eventId'],))


async def test_B13_initial_delivery_ttl_rechecked_after_host_preparation(env,monkeypatch):
    clock=[1000000]; env.s.clock=lambda:clock[0]
    c=await create(env,batching={'enabled':False},expiry={'ttlSeconds':1})
    event=await accept(env,c)
    async def prompt():
        clock[0]+=2000
        return 'Frozen system unchanged'
    monkeypatch.setattr(env.server,'_build_system_prompt_for_chat',prompt)
    await env.worker.tick(); await asyncio.wait_for(asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller')),10)
    assert env.backend.calls==0
    m=await one(env.db.conn,'SELECT * FROM webhook_assignment_events'); assert m['delivered_at_ms'] is None
    assert (await one(env.db.conn,'SELECT disposition FROM webhook_receipts'))['disposition']=='expired'
    assert (await one(env.db.conn,'SELECT terminal_reason FROM webhook_events'))['terminal_reason']=='expired'


@pytest.mark.parametrize('winner',['wait','closing'])
async def test_C21_writer_gate_closing_claim_race(env,winner):
    async with held(env) as (c,a,first,release):
        # Both contend for the actual shared writer gate. A barrier chooses the
        # commit order, not a sleep or expected UNIQUE error.
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'reg','match':match()})
        callback=await accept(env,c,'{"kind":"reply"}','callback')
        entered=asyncio.Event(); proceed=asyncio.Event()
        async def claimant():
            async with env.db.webhook_transaction() as conn:
                if winner=='wait': entered.set(); await proceed.wait()
                e=await one(conn,'SELECT * FROM webhook_events WHERE event_id=?',(callback['eventId'],)); await routing.route(env.s,conn,e)
        async def closer():
            async with env.db.webhook_transaction() as conn:
                if winner=='closing': entered.set(); await proceed.wait()
                # A user stop legitimately closes an outstanding wait; ordinary
                # completion would first return the wait gate instead.
                return await receipts.candidate(env.s,a['assignment_id'],abnormal='cancelled')
        first_task=asyncio.create_task(claimant() if winner=='wait' else closer())
        await entered.wait(); second=asyncio.create_task(closer() if winner=='wait' else claimant()); proceed.set()
        await asyncio.gather(first_task,second)
        member=await one(env.db.conn,'SELECT * FROM webhook_assignment_events WHERE event_id=?',(callback['eventId'],))
        snapshot=json.loads((await one(env.db.conn,'SELECT final_snapshot_json FROM webhook_assignments'))['final_snapshot_json'])
        if winner=='wait': assert member and callback['eventId'] in {r['event_id'] for r in snapshot['events']}
        else: assert not member and callback['eventId'] not in {r['event_id'] for r in snapshot['events']}
