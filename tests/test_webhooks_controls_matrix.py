"""D01/D15 controls against real isolated processes/controller and committed queues."""
import asyncio
import json
from contextlib import asynccontextmanager

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from app.webhooks import waits,routing,receipts
from app.webhooks.contracts import WebhookError
from app.webhooks.repository import one,many
from app.llm.events import StreamEvent,ToolCall,Usage
from tests.test_webhooks_backend import env,create,accept
from tests.test_webhooks_wait_acceptance import held,match
from tests.test_web_admin import FakeRunFactory,FakeStreamBackend,_login_cookie


async def change(env,c,action):
    eid=c['endpoint']['id']; e=(await env.s.get(123,eid))['endpoint']
    if action=='global': env.s.config.enabled=False; return {}
    body={'requestId':action,'expectedControlRevision':e['controlRevision']}
    if action.startswith('delete'):
        grant=await env.s.prepare(123,eid,'delete',{**body,'stopRunning':action=='delete_stop'})
        return await env.s.control(123,eid,{'requestId':action,'confirmationToken':grant['confirmationToken']},action='delete')
    return await env.s.control(123,eid,{**body,'action':'set_enabled' if action=='disable' else 'pause' if action=='pause' else 'stop',**({'enabled':False} if action=='disable' else {'scope':'current' if action=='current' else 'all'} if action in ('current','all') else {})})


async def undo(env,c,action):
    env.s.config.enabled=True
    if action in ('disable','pause'):
        e=(await env.s.get(123,c['endpoint']['id']))['endpoint']
        await env.s.control(123,e['id'],{'requestId':'undo','expectedControlRevision':e['controlRevision'],'action':'set_enabled' if action=='disable' else 'resume',**({'enabled':True} if action=='disable' else {})})


def reporting_backend(env):
    from app.runtime.lifecycle import current_session
    class Backend(FakeStreamBackend):
        seen=set()
        async def stream(self,messages,**kwargs):
            self.calls+=1; run=current_session().run_id
            yield StreamEvent(kind='usage',usage=Usage(input_tokens=10,output_tokens=2),details={'providerCostUsd':0.0})
            if run not in self.seen:
                self.seen.add(run)
                members=await many(env.db.conn,'SELECT m.event_id FROM webhook_assignment_events m JOIN webhook_runtime_links l USING(assignment_id) WHERE l.run_id=?',(run,))
                args={'action':'report','params':{'receiptId':'all','results':[{'eventId':e['event_id'],'outcome':'completed'} for e in members]}}
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('r','Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
            else: yield StreamEvent(kind='content',text='Done'); yield StreamEvent(kind='finish',finish_reason='stop')
    return Backend()


@pytest.mark.parametrize('action',['global','disable','pause','current','all','delete_keep','delete_stop'])
@pytest.mark.parametrize('stage',['pre','post'])
async def test_D01_active_and_queued_script_matrix(env,action,stage):
    arrived=asyncio.Event(); release=asyncio.Event(); executed=[]
    async def effect(request):
        executed.append(await request.text()); arrived.set(); await release.wait(); return web.Response(text='ok')
    app=web.Application(); app.router.add_post('/',effect); external=TestServer(app); await external.start_server()
    code='import urllib.request,json,sys\nx=json.load(sys.stdin)\nurllib.request.urlopen(urllib.request.Request('+repr(str(external.make_url('/')))+',data=x["actionKey"].encode())).read()\nprint('+repr('{"decision":"continue"}' if stage=='pre' else '{}')+')'
    c=await create(env,**{stage:{'enabled':True,'code':code,'timeoutSeconds':30}},batching={'enabled':False})
    setattr(env.s.config.concurrency,stage+'_scripts',1)
    env.server.llm_factory=FakeRunFactory(reporting_backend(env),context_window=128000)
    async def enqueue(identity):
        e=await accept(env,c,key=identity)
        if stage=='post':
            await routing.tick(env.s); await env.bridge.dispatch(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller'))
        return e
    try:
        first=await enqueue('active'); await env.worker.tick(); await asyncio.wait_for(arrived.wait(),5)
        second=await enqueue('queued')
        # Do not launch queued stage before control, and model does not run for pre.
        active=await one(env.db.conn,"SELECT * FROM webhook_stage_jobs WHERE state='running'")
        pending=await one(env.db.conn,"SELECT * FROM webhook_stage_jobs WHERE state='pending'")
        assert active and pending
        result=await change(env,c,action)
        async def receive_status():
            r=await env.client.post('/webhook/'+c['endpoint']['id'],json={},headers={'Authorization':'Bearer '+c['credential']['key'],'Idempotency-Key':'after'}); return r.status
        assert await receive_status()==(403 if action in ('global','disable','delete_keep','delete_stop') else 202)
        await env.worker.tick()
        cancelled=action in ('all','delete_stop')
        current=await one(env.db.conn,'SELECT state FROM webhook_stage_jobs WHERE job_id=?',(active['job_id'],))
        assert current['state']==('unknown' if cancelled else 'running')
        if cancelled: assert active['job_id'] in result['impact']['stopped']
        else:
            release.set(); await asyncio.gather(*list(env.worker.tasks.values()))
            assert (await one(env.db.conn,'SELECT state FROM webhook_stage_jobs WHERE job_id=?',(active['job_id'],)))['state']=='succeeded'
        if action.startswith('delete'):
            assert (await one(env.db.conn,'SELECT state FROM webhook_stage_jobs WHERE job_id=?',(pending['job_id'],)))['state']=='cancelled'
            if stage=='pre': assert (await one(env.db.conn,'SELECT route_state FROM webhook_events WHERE event_id=?',(first['eventId'],)))['route_state']=='terminal'
        elif action!='current':
            await env.worker.tick()
            assert (await one(env.db.conn,'SELECT state FROM webhook_stage_jobs WHERE job_id=?',(pending['job_id'],)))['state']=='pending'
        assert len(executed)==1
    finally:
        release.set(); await external.close()


@pytest.mark.parametrize('action',['global','disable','pause','current','all','delete_keep','delete_stop'])
async def test_D01_active_model_wait_and_queued_model(env,action):
    async with held(env) as (c,a,first,release):
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'wait','match':match()})
        callback=await accept(env,c,'{"kind":"reply"}','reply'); queued=await accept(env,c,'{"kind":"other"}','other'); await routing.tick(env.s)
        result=await change(env,c,action)
        delivery=await waits.delivery(env.s,a['assignment_id'],w['waitId'])
        if action in ('global','disable','pause'): assert delivery is None
        else: assert delivery['state'] in ('cancelled','closed')
        await env.bridge.dispatch(); assert len(await many(env.db.conn,'SELECT * FROM webhook_assignments'))==1
        if action in ('current','all','delete_stop'):
            assert a['assignment_id'] in result['impact']['stoppedAssignments']
            assert (await one(env.db.conn,'SELECT state FROM webhook_assignments'))['state']=='finalized'
        else:
            assert (await one(env.db.conn,'SELECT state FROM webhook_assignments'))['state']=='open'
            # Legitimate completed in-flight work can still report while intake is off.
            run=await one(env.db.conn,'SELECT run_id FROM webhook_runtime_links')
            await receipts.report(env.s,a['assignment_id'],run['run_id'],{'receiptId':'inflight','results':[{'eventId':first['eventId'],'outcome':'completed'}]})
        if action in ('global','disable','pause'):
            await undo(env,c,action)
            d=await waits.delivery(env.s,a['assignment_id'],w['waitId']); assert d['events'][0]['eventId']==callback['eventId']


async def test_D15_same_request_and_revision_races_are_single_commit(env):
    c=await create(env); eid=c['endpoint']['id']; cookies={'openbear_web_session':await _login_cookie(env)}
    pause={'action':'pause','expectedControlRevision':0,'requestId':'same'}
    responses=await asyncio.gather(*(env.client.post('/api/webhooks/'+eid+'/control',json=pause,cookies=cookies) for _ in range(4)))
    bodies=[await r.json() for r in responses]; assert all(r.status==200 for r in responses) and all(b==bodies[0] for b in bodies)
    assert bodies[0]['endpoint']['controlRevision']==1
    grant=await env.s.prepare(123,eid,'delete',{'expectedControlRevision':1})
    # Delete has the writer first; the stale edit cannot resurrect it. Real
    # competing HTTP paths use the same CAS/transaction boundary.
    entered=asyncio.Event(); proceed=asyncio.Event()
    async def delete():
        async with env.db.webhook_transaction():
            entered.set(); await proceed.wait()
            return await env.s.control(123,eid,{'requestId':'delete','confirmationToken':grant['confirmationToken']},action='delete')
    t=asyncio.create_task(delete()); await entered.wait()
    edit=asyncio.create_task(env.client.patch('/api/webhooks/'+eid,cookies=cookies,json={'requestId':'stale','expectedRevision':1,'expectedControlRevision':1,'enabled':True,'config':c['endpoint']['config']})); proceed.set()
    deleted,response=await asyncio.gather(t,edit); assert response.status==404
    replay=await env.s.control(123,eid,{'requestId':'delete','confirmationToken':grant['confirmationToken']},action='delete'); assert replay==deleted
    assert (await one(env.db.conn,'SELECT enabled,deleted_at_ms FROM webhook_endpoints'))['enabled']==0
    assert (await one(env.db.conn,"SELECT COUNT(*) n FROM webhook_control_operations WHERE action='delete'"))['n']==1


@pytest.mark.parametrize('action',['pause','disable','all'])
async def test_D01_cross_entry_wait_obeys_origin_control_without_stopping_other_owner(env,action):
    async with held(env) as (c,a,first,release):
        from tests.test_webhooks_query_business import endpoint
        b=await endpoint(env,'receiver')
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':b['endpoint']['id'],'requestId':'cross','match':match()})
        e=await accept(env,b,'{"kind":"reply"}','reply'); await routing.tick(env.s)
        await change(env,c,action)
        d=await waits.delivery(env.s,a['assignment_id'],w['waitId'])
        if action=='all': assert d['state']=='closed' and not d['events']
        else:
            assert d is None
            await undo(env,c,action)
            assert (await waits.delivery(env.s,a['assignment_id'],w['waitId']))['events'][0]['eventId']==e['eventId']


async def test_D15_update_wins_delete_confirmation_stales(env):
    c=await create(env); eid=c['endpoint']['id']
    grant=await env.s.prepare(123,eid,'delete',{'expectedControlRevision':0})
    async with env.db.webhook_transaction():
        updated=await env.s.update(123,eid,{'requestId':'edit','expectedRevision':1,'config':c['endpoint']['config'],'name':'new'})
    assert updated['endpoint']['revision']==2
    with pytest.raises(WebhookError) as exc:
        await env.s.control(123,eid,{'requestId':'delete','confirmationToken':grant['confirmationToken']},action='delete')
    assert exc.value.payload['code']=='confirmation_stale'
    assert (await env.s.get(123,eid))['endpoint']['effectiveStatus']=='receiving'


async def test_F21_pause_resume_expired_pre_sealed_and_wait_backlog(env):
    async with held(env,expiry={'ttlSeconds':1}) as (c,a,first,release):
        now=[env.s.clock()]; env.s.clock=lambda:now[0]
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'w','match':match(),'timeoutSeconds':10})
        callback=await accept(env,c,'{"kind":"reply"}','reply')
        sealed=await accept(env,c,'{"kind":"ordinary"}','sealed'); await routing.tick(env.s)
        cfg=c['endpoint']['config']; cfg['pre']={'enabled':True,'code':'raise RuntimeError("expired stage must not spawn")'}
        await env.s.update(123,c['endpoint']['id'],{'expectedRevision':1,'requestId':'pre','config':cfg})
        pre=await accept(env,c,'{}','pre')
        await change(env,c,'pause'); now[0]+=2000; await env.worker.tick()
        assert not env.worker.tasks and await waits.delivery(env.s,a['assignment_id'],w['waitId']) is None
        await undo(env,c,'pause'); await env.worker.tick()
        assert await waits.delivery(env.s,a['assignment_id'],w['waitId']) is None
        current=await one(env.db.conn,'SELECT state,deadline_ms FROM webhook_waits WHERE wait_id=?',(w['waitId'],))
        assert current=={'state':'registered','deadline_ms':w['deadline']}
        for e in (callback,sealed,pre):
            assert (await one(env.db.conn,'SELECT terminal_reason FROM webhook_events WHERE event_id=?',(e['eventId'],)))['terminal_reason']=='expired'
        assert not await many(env.db.conn,'SELECT * FROM webhook_stage_attempts')
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_assignments'))['n']==1
        # The original already delivered event may legally finish despite TTL.
        run=await one(env.db.conn,'SELECT run_id FROM webhook_runtime_links')
        await receipts.report(env.s,a['assignment_id'],run['run_id'],{'receiptId':'before-stop','results':[{'eventId':first['eventId'],'outcome':'completed'}]})
        result=await change(env,c,'current')
        late=await accept(env,c,'{"kind":"reply"}','late'); await env.worker.tick()
        assert a['assignment_id'] in result['impact']['stoppedAssignments']
        assert not await one(env.db.conn,'SELECT * FROM webhook_assignment_events WHERE event_id=?',(late['eventId'],))


async def test_D01_stop_current_blocks_alternate_entry_same_conversation(env):
    async with held(env) as (c,a,first,release):
        b=await env.s.create(123,{'scope':{'type':'conversation','id':a['conversation_uuid']},'enabled':True,'requestId':'same-target','config':{'processing':{'instructions':'alternate'},'batching':{'enabled':False}}})
        await change(env,c,'current')
        await accept(env,b,key='other-entry'); await env.worker.tick()
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_assignments'))['n']==1
        e=(await env.s.get(123,c['endpoint']['id']))['endpoint']
        await env.s.control(123,e['id'],{'action':'resume','scope':'model','expectedControlRevision':e['controlRevision'],'requestId':'explicit-resume'})
        await env.worker.tick(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller'))
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_assignments'))['n']==2
