"""Isolated product acceptance assertions; external systems use aiohttp simulators."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from aiohttp.test_utils import TestClient, TestServer
from app.webhooks.contracts import WebhookError
from app.webhooks.repository import one, many, insert, uid
from app.llm.events import StreamEvent, ToolCall, Usage
from tests.test_web_admin import FakeRunFactory, FakeStreamBackend, _login_cookie
from tests.test_webhooks_backend import env, create, accept, drain_scripts


async def test_F20_C06_C17_C19_actual_early_callback_and_post(env):
    from aiohttp import web, ClientSession
    post_log=env.tmp/'post.json'
    code='import json,sys\nx=json.load(sys.stdin)\nopen('+repr(str(post_log))+',"w").write(json.dumps(x))\nprint("{}")'
    conversation=await env.server._create_web_conversation(123,folder_uuid='folder',title='Fixed callback')
    c=await create(env,target={'mode':'fixedConversation','conversationId':conversation['conversation_uuid']},batching={'enabled':False},post={'enabled':True,'code':code})
    first=await accept(env,c,'{"order":123,"kind":"start"}','start')
    actions=[]; callback=[]
    async def order(request):
        body=await request.json(); actions.append(body['actionKey'])
        response=await env.client.post('/webhook/'+c['endpoint']['id'],json={'order':123,'kind':'reply'},headers={'Authorization':'Bearer '+c['credential']['key'],'Idempotency-Key':'reply'})
        assert response.status==202; callback.append((await response.json())['eventId'])
        from app.webhooks.routing import tick
        await tick(env.s)
        return web.json_response({'orderId':123})
    app=web.Application(); app.router.add_post('/order',order)
    simulator=TestServer(app); await simulator.start_server()
    async def send(args):
        async with ClientSession() as session:
            async with session.post(simulator.make_url('/order'),json={'actionKey':'order-123'}) as response:
                return await response.text()
    env.server.tools.add('SendOrder','Authorized isolated simulator order',{'type':'object'},send)
    class Backend(FakeStreamBackend):
        wait_id=None
        async def stream(self,messages,**kwargs):
            self.calls+=1; self.seen_convos.append(messages)
            if self.calls==1:
                args={'action':'wait','params':{'op':'register','requestId':'register','endpointId':c['endpoint']['id'],'match':{'all':[{'path':'body.kind','op':'eq','value':'reply'}]},'timeoutSeconds':10}}
            elif self.calls==2:
                result=json.loads([m['content'] for m in messages if m['role']=='tool'][-1]); self.wait_id=result['waitId']
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('send','SendOrder','{}')]); yield StreamEvent(kind='finish',finish_reason='tool_calls'); return
            elif self.calls==3:
                assert len(callback)==1
                claimed=await one(env.db.conn,'SELECT assignment_id,delivered_at_ms FROM webhook_assignment_events WHERE event_id=?',(callback[0],))
                assert claimed and claimed['delivered_at_ms'] is None
                args={'action':'wait','params':{'op':'await','waitId':self.wait_id}}
            elif self.calls==4:
                args={'action':'report','params':{'receiptId':'initial','results':[{'eventId':first['eventId'],'outcome':'completed'}]}}
            elif self.calls==6:
                assert 'Read-only receipt repair' in str(messages[-1]['content'])
                args={'action':'report','params':{'receiptId':'callback','results':[{'eventId':callback[0],'outcome':'completed'}]}}
            else:
                yield StreamEvent(kind='content',text='Finished'); yield StreamEvent(kind='finish',finish_reason='stop'); return
            yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('c'+str(self.calls),'Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    try:
        await env.worker.tick(); tasks=env.server.runs.scheduler.tasks(kind='controller'); assert tasks
        await asyncio.wait_for(asyncio.gather(*tasks),10)
        await drain_scripts(env)
        a=await one(env.db.conn,'SELECT * FROM webhook_assignments')
        assert a['state']=='finalized' and a['terminal_reason']=='normal' and a['repair_count']==1
        assert actions==['order-123']
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM web_conversations'))['n']==1
        assert (await one(env.db.conn,"SELECT COUNT(*) n FROM webhook_stage_jobs WHERE stage='post'"))['n']==1
        data=json.loads(post_log.read_text()); assert {x['event_id'] for x in data['assignment']['events']}=={first['eventId'],callback[0]}
        w=await one(env.db.conn,'SELECT * FROM webhook_waits'); assert w['state']=='delivered'
        from app.webhooks.waits import delivery
        repeated=await delivery(env.s,a['assignment_id'],w['wait_id']); assert repeated['events'][0]['eventId']==callback[0]
        n=await one(env.db.conn,"SELECT kind,state FROM web_task_notifications WHERE kind='webhook-result'"); assert n['state']=='delivered'
    finally: await simulator.close()


async def test_B03_B04_unknown_effect_not_replayed(env):
    from aiohttp import web
    external=[]
    async def effect(request): external.append(await request.text()); return web.Response(text='done')
    app=web.Application(); app.router.add_post('/effect',effect); simulator=TestServer(app); await simulator.start_server()
    code='import urllib.request,json,sys,time\nx=json.load(sys.stdin)\nurllib.request.urlopen(urllib.request.Request('+repr(str(simulator.make_url('/effect')))+',data=x["actionKey"].encode())).read()\ntime.sleep(10)'
    try:
        c=await create(env,pre={'enabled':True,'code':code,'timeoutSeconds':.2})
        event=await accept(env,c)
        await drain_scripts(env)
        assert len(external)==1
        a=await one(env.db.conn,'SELECT * FROM webhook_stage_attempts'); assert a['state']=='unknown' and a['error_class']=='timeout'
        await env.worker.recover(); await env.worker.tick()
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_stage_attempts'))['n']==1
        from app.webhooks.recovery import retry,verify
        e=await one(env.db.conn,'SELECT * FROM webhook_events')
        with pytest.raises(WebhookError,match='verify_unknown_effect_first'):
            await retry(env.s,123,event['eventId'],{'requestId':'retry','stage':'pre','expectedVersion':e['route_version']})
        result=await verify(env.s,123,event['eventId'],{'requestId':'verified','stage':'pre','expectedVersion':e['route_version'],'outcome':'completed','reason':'Simulator ledger confirms action','evidenceRefs':['simulator:operation-1']})
        assert result['effectState']=='confirmed' and len(external)==1
        assert (await one(env.db.conn,'SELECT source,outcome FROM webhook_receipts'))=={'source':'administrator','outcome':'completed'}
    finally: await simulator.close()


async def test_B07_B08_batch_deadlines_versions_without_field_groups(env):
    from app.webhooks.routing import tick
    env.s.bridge=None
    clock=[100000]; env.s.clock=lambda:clock[0]
    c=await create(env,batching={'idleSeconds':3,'maxWaitSeconds':30,'maxEvents':100})
    await accept(env,c,'{}','a'); await tick(env.s)
    clock[0]=101000; await accept(env,c,'{}','b'); await tick(env.s)
    clock[0]=103999; await tick(env.s); assert (await one(env.db.conn,'SELECT state FROM webhook_batches'))['state']=='collecting'
    clock[0]=104000; await tick(env.s); batch=await one(env.db.conn,'SELECT * FROM webhook_batches'); assert batch['state']=='sealed' and batch['snapshot_event_count']==2
    await accept(env,c,'{"group":"null"}','c'); await tick(env.s)
    rows=await many(env.db.conn,'SELECT aggregation_key FROM webhook_batches'); assert len(rows)==2 and len({r['aggregation_key'] for r in rows})==1
    old_rev=c['endpoint']['config']; old_rev['processing']['instructions']='new version'
    await env.s.update(123,c['endpoint']['id'],{'requestId':'edit','expectedRevision':1,'expectedControlRevision':0,'enabled':True,'config':old_rev})
    await accept(env,c,'{}','d'); await tick(env.s)
    assert len(await many(env.db.conn,'SELECT * FROM webhook_batches'))==3


async def test_E06_E07_E08_E09_metrics(env):
    from app.webhooks.telemetry import observe,metric_query
    clock=[1_000_000]; env.s.clock=lambda:clock[0]
    c=await create(env,statistics={'metricDefinitions':[{'name':'custom_counter','type':'counter'},{'name':'custom_gauge','type':'gauge','gaugeStaleSeconds':30},{'name':'custom_hist','type':'histogram','histogramBuckets':[.1,.5,1.]}]})
    eid=c['endpoint']['id']
    for _ in range(3): await observe(env.s,eid,{'operationId':'once','metrics':[{'name':'custom_counter','value':1}]},source='script')
    for at,value in [(0,8),(10,3),(5,5)]:
        await observe(env.s,eid,{'operationId':'g'+str(at),'metrics':[{'name':'custom_gauge','value':value,'observedAtMs':clock[0]+at*1000}]},source='script')
    for i,value in enumerate([.05,.1,.4,1.]): await observe(env.s,eid,{'operationId':'h'+str(i),'metrics':[{'name':'custom_hist','value':value}]},source='script')
    clock[0]+=41000
    metrics={m['name']:m for m in await metric_query(env.s,eid,0,clock[0])}
    assert metrics['custom_counter']['sum']==1
    assert metrics['custom_gauge']['lastValue']==3 and metrics['custom_gauge']['stale']
    h=metrics['custom_hist']; assert h['count']==4 and h['sum']==pytest.approx(1.55) and h['buckets']['counts']==[2,1,1,0] and h['buckets']['cumulative']==[2,3,4,4]
    with pytest.raises(WebhookError): await observe(env.s,eid,{'operationId':'bad','metrics':[{'name':'custom_counter','value':-1}]},source='script')


async def test_A01_A02_A10_A15_A16_authenticated_management(env):
    cookies={'openbear_web_session':await _login_cookie(env)}
    r=await env.client.get('/api/webhooks?scopeType=folder&scopeId=folder',cookies=cookies)
    assert r.status==200 and (await r.json())['items']==[]
    r=await env.client.post('/api/webhooks/preview',cookies=cookies,json={'scope':{'type':'folder','id':'folder'},'config':{'processing':{'eventTemplate':'@each e in events\n[[e.body.appname]]\n@endeach'}},'sample':{'body':{}}})
    assert r.status in (404,405)
    assert not await many(env.db.conn,'SELECT * FROM webhook_endpoints')
    body={'scope':{'type':'folder','id':'folder'},'config':{},'requestId':'draft','enabled':False}
    r=await env.client.post('/api/webhooks',cookies=cookies,json=body); assert r.status==201
    created=await r.json(); eid=created['endpoint']['id']; url=created['endpoint']['url']
    r=await env.client.post('/api/webhooks',cookies=cookies,json=body); assert (await r.json())['endpoint']['id']==eid
    r=await env.client.post('/api/webhooks',cookies=cookies,json={**body,'name':'different'}); assert r.status==409
    r=await env.client.post('/api/webhooks/'+eid+'/control',cookies=cookies,json={'action':'set_enabled','enabled':True,'expectedControlRevision':0,'requestId':'invalid-enable'}); assert r.status==422
    req={'config':{'processing':{'instructions':'authorized scope'}},'expectedRevision':1,'expectedControlRevision':0,'enabled':True}
    results=await asyncio.gather(*(env.client.patch('/api/webhooks/'+eid,cookies=cookies,json={**req,'name':str(i),'requestId':'save'+str(i)}) for i in range(2)))
    assert sorted(r.status for r in results)==[200,409]
    conflict=await next(r for r in results if r.status==409).json(); assert conflict['currentRevision']==2 and conflict['details']['current']['revision']==2
    await env.db.conn.execute("UPDATE web_conversation_folders SET name='Renamed' WHERE folder_uuid='folder'"); await env.db.conn.commit()
    r=await env.client.get('/api/webhooks/'+eid,cookies=cookies); ordinary=await r.json()
    assert ordinary['endpoint']['url']==url and created['credential']['key'] not in json.dumps(ordinary)
    assert not await many(env.db.conn,'SELECT * FROM web_conversations')
    from app.tools.base import ToolRuntimeContext
    from app.tools.webhook import dispatch
    with pytest.raises(WebhookError,match='automatic_configuration_forbidden'):
        await dispatch(env.s,'update',req,ToolRuntimeContext(webhook_automatic=True))


@pytest.mark.parametrize('kind,data,status',[('application/json','{"中文":true}',202),('text/plain','中文 /tmp/not-read',202),('application/json','{',422),('text/plain',b'\xff',422),('image/png',b'png',415),('multipart/form-data',b'abc',415)])
async def test_A04_http_types(env,kind,data,status):
    c=await create(env)
    r=await env.client.post('/webhook/'+c['endpoint']['id']+'?x=1&x=2',data=data.encode() if isinstance(data,str) else data,headers={'Content-Type':kind,'Authorization':'Bearer '+c['credential']['key']})
    assert r.status==status
    p=await one(env.db.conn,'SELECT * FROM webhook_event_payloads')
    if status==202:
        assert json.loads(p['query_pairs_json'])==[['x','1'],['x','2']]
        assert bytes(p['body_bytes'])==data.encode()
    else: assert p is None


async def test_A07_A08_A09_http_identity_capacity_commit_failure(env,monkeypatch):
    c=await create(env,idempotency={'bodyIdPath':'body.id'},limits={'pendingEvents':1})
    async def send(data,identity=None):
        return await env.client.post('/webhook/'+c['endpoint']['id'],data=data,headers={'Content-Type':'application/json','Authorization':'Bearer '+c['credential']['key'],**({'Idempotency-Key':identity} if identity else {})})
    assert (await send('{}')).status==422
    writer=env.db.conn._writer; commit=writer.commit
    async def fail():
        import sqlite3
        raise sqlite3.OperationalError('isolated injected disk error')
    monkeypatch.setattr(writer,'commit',fail)
    assert (await send('{"id":"1"}','header')).status==503
    monkeypatch.setattr(writer,'commit',commit)
    assert not await many(env.db.conn,'SELECT * FROM webhook_events')
    r=await send('{"id":"1"}','header'); first=await r.json(); assert r.status==202
    assert (await send('{"id":"2"}','other')).status==429
    r=await send('{"id":"1"}','header'); assert (await r.json())['eventId']==first['eventId']
    assert (await one(env.db.conn,'SELECT idempotency_key FROM webhook_events'))['idempotency_key']=='header'
    env.s.config.ingress.max_body_bytes=1024
    async def chunks():
        yield b'"'; yield b'a'*1024; yield b'"'
    r=await send(chunks(),'large'); assert r.status==413
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_events'))['n']==1


@pytest.mark.parametrize('code,error', [('print("bad")','invalid_protocol'),('print("{}\\n{}")','invalid_protocol'),('raise SystemExit(3)','nonzero_exit'),('print("x"*400)','stdout_limit')])
async def test_B03_protocol_errors_finite_logs(env,code,error):
    env.s.config.scripts.max_stdout_bytes=100; env.s.config.scripts.max_stderr_bytes=20
    c=await create(env,pre={'enabled':True,'code':'import sys\nsys.stderr.write("e"*100000)\n'+code})
    await accept(env,c); await drain_scripts(env)
    a=await one(env.db.conn,'SELECT * FROM webhook_stage_attempts')
    assert a['error_class']==error and a['state']=='unknown' and len(a['stderr_text'])==20 and a['stderr_truncated']
    assert (await one(env.db.conn,'SELECT route_state FROM webhook_events'))['route_state']=='hold'
    assert not await many(env.db.conn,'SELECT * FROM webhook_assignments')


async def test_B05_B06_idempotent_attempts_and_error_material(env):
    env.s.bridge=None
    count=env.tmp/'count'
    code='import pathlib,json,sys\nx=json.load(sys.stdin)\np=pathlib.Path('+repr(str(count))+')\na=json.loads(p.read_text()) if p.exists() else []\na.append([x["actionKey"],x["attempt_id"]]);p.write_text(json.dumps(a))\nif len(a)<3: raise SystemExit(1)\nprint(json.dumps({"decision":"continue","model_data":{"safe":True}}))'
    c=await create(env,pre={'enabled':True,'code':code,'retry':{'maxAttempts':3,'backoffSeconds':[0],'idempotencyDeclaration':'Simulator deduplicates actionKey'}})
    await accept(env,c)
    for _ in range(4): await drain_scripts(env)
    attempts=json.loads(count.read_text()); assert len(attempts)==3 and len({x[0] for x in attempts})==1 and len({x[1] for x in attempts})==3
    p=await one(env.db.conn,'SELECT * FROM webhook_event_payloads'); assert bytes(p['body_bytes'])==b'{}' and json.loads(p['model_data_json'])=={'safe':True}
    assert (await one(env.db.conn,'SELECT state FROM webhook_stage_jobs'))['state']=='succeeded'


async def test_B13_B14_B18_expiry_echo_and_tombstones(env):
    from app.webhooks.routing import tick
    clock=[1000000]; env.s.clock=lambda:clock[0]; env.s.bridge=None
    c=await create(env,expiry={'ttlSeconds':10},correlation={'originPath':'body.origin','ignoreOwnEcho':True,'ownOriginValues':['self']})
    e=await accept(env,c,'{}','ttl'); echo=await accept(env,c,'{"origin":"self"}','echo')
    clock[0]+=9000; await accept(env,c,'{}','ttl')
    row=await one(env.db.conn,'SELECT * FROM webhook_events WHERE event_id=?',(e['eventId'],)); assert row['expires_at_ms']==1010000
    clock[0]+=1000; await tick(env.s)
    assert (await one(env.db.conn,'SELECT terminal_reason FROM webhook_events WHERE event_id=?',(e['eventId'],)))['terminal_reason']=='expired'
    assert (await one(env.db.conn,'SELECT terminal_reason FROM webhook_events WHERE event_id=?',(echo['eventId'],)))['terminal_reason']=='own_echo'
    from app.webhooks.retention import prune
    clock[0]+=10*86400000; await prune(env.s)
    assert not await many(env.db.conn,'SELECT * FROM webhook_event_payloads')
    assert (await accept(env,c,'{}','ttl'))['eventId']==e['eventId']
    from app.webhooks.queries import detail
    assert (await detail(env.s,123,e['eventId']))['event']['payloadStatus']=='purged'


async def test_C19_readonly_repair_bounded_actual_runtime(env):
    c=await create(env,batching={'enabled':False}); await accept(env,c)
    side_effects=[]
    async def business(args): side_effects.append(1); return 'changed'
    env.server.tools.add('Business','effect',{'type':'object'},business)
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if self.calls==1:
                yield StreamEvent(kind='content',text='Done without report'); yield StreamEvent(kind='finish',finish_reason='stop')
            else:
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('effect'+str(self.calls),'Business','{}')]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    b=Backend(); env.server.llm_factory=FakeRunFactory(b,context_window=128000)
    await env.worker.tick(); await asyncio.wait_for(asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller')),10)
    a=await one(env.db.conn,'SELECT * FROM webhook_assignments')
    assert a['terminal_reason']=='protocol_incomplete' and a['repair_count']==1 and b.calls==3 and not side_effects
    assert (await one(env.db.conn,'SELECT disposition FROM webhook_receipts'))['disposition']=='protocol_incomplete'
    assert (await one(env.db.conn,'SELECT review_required FROM webhook_events'))['review_required']==1


async def test_D01_D09_D15_controls_real_effects_and_target_loss(env):
    c=await create(env,pre={'enabled':True,'code':'print(\'{"decision":"continue"}\')'})
    eid=c['endpoint']['id']; await accept(env,c)
    req={'requestId':'pause','action':'pause','expectedControlRevision':0}
    paused=await env.s.control(123,eid,req); assert paused['endpoint']['dispatchPaused']
    assert await env.s.control(123,eid,req)==paused
    await accept(env,c,'{}','whilepaused'); await env.worker.tick()
    assert not await many(env.db.conn,'SELECT * FROM webhook_stage_attempts')
    env.s.config.enabled=False
    with pytest.raises(WebhookError): await accept(env,c,'{}','globaloff')
    assert (await env.s.get(123,eid))['endpoint']['effectiveStatus']=='globalDisabled'
    env.s.config.enabled=True
    await env.s.control(123,eid,{'action':'resume','expectedControlRevision':1,'requestId':'resume'})
    await env.db.conn.execute("DELETE FROM web_conversation_folders WHERE folder_uuid='folder'"); await env.db.conn.commit()
    await env.worker.tick()
    assert not await many(env.db.conn,'SELECT * FROM webhook_stage_attempts')
    assert 'bindingDeleted' in (await env.s.get(123,eid))['endpoint']['pauseReasons']
    with pytest.raises(WebhookError): await accept(env,c,'{}','deletedtarget')
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_events'))['n']==2


async def test_D03_D14_reserved_recovery_and_late_fence(env):
    c=await create(env,pre={'enabled':True,'code':'print(\'{"decision":"continue"}\')'})
    await accept(env,c); job=await one(env.db.conn,'SELECT * FROM webhook_stage_jobs')
    async with env.db.webhook_transaction() as conn:
        await conn.execute("UPDATE webhook_stage_jobs SET state='running',execution_fence=1 WHERE job_id=?",(job['job_id'],))
        await insert(conn,'webhook_stage_attempts',attempt_id='reserved',job_id=job['job_id'],attempt_no=1,execution_fence=1,state='reserved',worker_token='r',lease_until_ms=1,reserved_at_ms=1)
    await env.worker.recover()
    assert (await one(env.db.conn,'SELECT state,side_effect_state FROM webhook_stage_attempts'))=={'state':'cancelled','side_effect_state':'none'}
    assert (await one(env.db.conn,'SELECT state FROM webhook_stage_jobs'))['state']=='pending'
    await drain_scripts(env)
    await env.worker.complete(job,'reserved',1,None,{'errorClass':'old','effectState':'unknown'})
    assert (await one(env.db.conn,'SELECT state,execution_fence FROM webhook_stage_jobs'))=={'state':'succeeded','execution_fence':2}
    old=await one(env.db.conn,"SELECT state,execution_json FROM webhook_stage_attempts WHERE attempt_id='reserved'")
    assert old['state']=='cancelled' and json.loads(old['execution_json'])['lateCompletion']['applied'] is False
