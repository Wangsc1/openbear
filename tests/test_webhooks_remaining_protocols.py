"""A/B/C remaining protocol predicates, using real HTTP/scripts/host-owned runs."""
import asyncio
import json
from aiohttp import web
from aiohttp.test_utils import TestServer
import pytest
from app.webhooks import routing,waits,receipts
from app.webhooks.contracts import WebhookError
from app.webhooks.repository import one,many
from tests.test_webhooks_backend import env,create,accept,drain_scripts
from tests.test_webhooks_wait_acceptance import held,match
from tests.test_webhooks_query_business import endpoint


async def test_A02_copy_scope_identity_target_and_A06_A07_intake_ids(env):
    c=await create(env,idempotency={'bodyIdPath':'body.id'})
    clone=await endpoint(env,'clone')
    copied=await env.s.update(123,clone['endpoint']['id'],{'requestId':'copy','expectedRevision':1,'expectedControlRevision':0,'enabled':False,'config':c['endpoint']['config']})
    assert copied['endpoint']['enabled'] is False and clone['endpoint']['id']!=c['endpoint']['id'] and clone['credential']['key']!=c['credential']['key']
    conv=await env.server._create_web_conversation(123,folder_uuid='folder',title='Bound')
    with pytest.raises(WebhookError,match='会话入口必须固定当前会话'):
        await env.s.create(123,{'requestId':'badtarget','scope':{'type':'conversation','id':conv['conversation_uuid']},'config':{'target':{'mode':'newConversation'}}})
    x=await accept(env,c,'{"id":"body"}',None)
    assert (await one(env.db.conn,'SELECT idempotency_key,identity_source FROM webhook_events'))=={'idempotency_key':'body','identity_source':'body'}
    with pytest.raises(WebhookError): await accept(env,c,' {"id":"body"}',None)
    # No body ID configured means identical bytes are still independent events.
    await env.s.update(123,clone['endpoint']['id'],{'requestId':'enable','expectedRevision':2,'expectedControlRevision':1,'enabled':True,'config':{'processing':{'instructions':'none'}}})
    x=await accept(env,clone,'{}',None); y=await accept(env,clone,'{}',None); assert x['eventId']!=y['eventId']


async def test_A09_commit_survives_failed_response(env,monkeypatch):
    c=await create(env); receive=env.s.receive; accepted=[]
    async def dropped(*args,**kwargs):
        result=await receive(*args,**kwargs); accepted.append(result['eventId']); raise ConnectionResetError('isolated response loss after commit')
    monkeypatch.setattr(env.s,'receive',dropped)
    r=await env.client.post('/webhook/'+c['endpoint']['id'],json={},headers={'Authorization':'Bearer '+c['credential']['key'],'Idempotency-Key':'lost'})
    assert r.status!=202
    monkeypatch.setattr(env.s,'receive',receive)
    r=await env.client.post('/webhook/'+c['endpoint']['id'],json={},headers={'Authorization':'Bearer '+c['credential']['key'],'Idempotency-Key':'lost'})
    body=await r.json(); assert r.status==202 and body['eventId']==accepted[0] and body['duplicate']
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_events'))['n']==1


@pytest.mark.parametrize('retry',[False,True])
async def test_B05_B06_real_downstream_dedup_and_unknown_material(env,retry):
    calls=[]; business=set()
    async def action(request):
        key=await request.text(); calls.append(key); business.add(key)
        return web.Response(status=500 if len(calls)<3 else 200)
    app=web.Application(); app.router.add_post('/',action); external=TestServer(app); await external.start_server()
    code='import urllib.request,json,sys\nx=json.load(sys.stdin)\nurllib.request.urlopen(urllib.request.Request('+repr(str(external.make_url('/')))+',data=x["actionKey"].encode())).read()\nprint(\'{"decision":"skip_model","outcome":"handled"}\')'
    conf={'enabled':True,'code':code,'onError':'hold' if retry else 'continueModel'}
    if retry: conf['retry']={'maxAttempts':3,'backoffSeconds':[0],'idempotencyDeclaration':'HTTP simulator applies stable actionKey only once'}
    env.s.bridge=None; c=await create(env,pre=conf,batching={'enabled':False}); e=await accept(env,c)
    try:
        for _ in range(4): await drain_scripts(env)
        assert len(business)==1 and len(calls)==(3 if retry else 1)
        attempts=await many(env.db.conn,'SELECT * FROM webhook_stage_attempts'); assert len(attempts)==len(calls) and len({a['attempt_id'] for a in attempts})==len(calls)
        if retry: assert (await one(env.db.conn,'SELECT state FROM webhook_stage_jobs'))['state']=='succeeded'
        else:
            material=await env.s.event_material(env.db.conn,e['eventId']); assert material['preResult']['sideEffectState']=='unknown' and material['derived']['errorClass']=='nonzero_exit'
            assert (await one(env.db.conn,'SELECT route_state FROM webhook_events'))['route_state']=='batch'
    finally: await external.close()


async def test_B08_continuous_flow_max_wait_and_101st_member(env):
    env.s.bridge=None; now=[1000000]; env.s.clock=lambda:now[0]
    c=await create(env,batching={'maxEvents':100,'idleSeconds':3,'maxWaitSeconds':30})
    for i in range(31):
        now[0]=1000000+i*1000; await accept(env,c,key=str(i)); await routing.tick(env.s)
    b=await one(env.db.conn,"SELECT * FROM webhook_batches WHERE state='sealed'"); assert b['seal_reason']=='maxWait' and b['max_deadline_ms']==1030000
    # New endpoint keeps identities/groups isolated; threshold 100 is OR with time.
    d=await endpoint(env,'count'); cfg=d['endpoint']['config']; cfg['batching']={'maxEvents':100,'idleSeconds':3,'maxWaitSeconds':30}
    await env.s.update(123,d['endpoint']['id'],{'requestId':'count-config','expectedRevision':1,'config':cfg})
    for i in range(101): await accept(env,d,key=str(i))
    await routing.tick(env.s)
    batches=await many(env.db.conn,'SELECT state,snapshot_event_count FROM webhook_batches WHERE endpoint_id=?',(d['endpoint']['id'],))
    assert {'state':'sealed','snapshot_event_count':100} in batches and len(batches)==2


@pytest.mark.parametrize('trigger',['count','idle','maxWait'])
async def test_C11_collection_or_limits_and_immutable_delivery(env,trigger):
    now=[1000000]; env.s.clock=lambda:now[0]
    async with held(env) as (c,a,first,release):
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'collection','match':match(),'collection':{'maxEvents':3,'idleSeconds':60 if trigger=='maxWait' else 3,'maxWaitSeconds':30},'timeoutSeconds':100})
        events=[]
        for i in range(3 if trigger=='count' else 1):
            events.append(await accept(env,c,'{"kind":"reply"}',str(i))); await routing.tick(env.s)
        if trigger!='count':
            now[0]+=3000 if trigger=='idle' else 30000
            await routing.tick(env.s)
        assert (await one(env.db.conn,'SELECT state FROM webhook_waits'))['state']=='sealed'
        extra=await accept(env,c,'{"kind":"reply"}','extra'); await routing.tick(env.s)
        assert not await one(env.db.conn,'SELECT * FROM webhook_assignment_events WHERE event_id=?',(extra['eventId'],))
        delivered=await waits.delivery(env.s,a['assignment_id'],w['waitId'])
        assert {e['eventId'] for e in delivered['events']}=={e['eventId'] for e in events}
        assert await waits.delivery(env.s,a['assignment_id'],w['waitId'])==delivered


@pytest.mark.parametrize('winner',['wait','dispatch'])
async def test_C09_real_wait_vs_dispatch_writer_race(env,winner):
    async with held(env) as (c,a,first,release):
        b=await endpoint(env,'race'); cfg=b['endpoint']['config']; cfg['batching']={'enabled':False}
        await env.s.update(123,b['endpoint']['id'],{'requestId':'no-aggregate','expectedRevision':1,'config':cfg})
        event=await accept(env,b,'{"kind":"reply"}','reply'); await routing.tick(env.s)
        batch=await one(env.db.conn,'SELECT * FROM webhook_batches WHERE endpoint_id=?',(b['endpoint']['id'],))
        gate=asyncio.Event(); proceed=asyncio.Event()
        async def claimant():
            async with env.db.webhook_transaction():
                if winner=='wait': gate.set(); await proceed.wait()
                return await waits.register(env.s,a['assignment_id'],123,{'endpointId':b['endpoint']['id'],'requestId':'r','match':match()})
        async def dispatcher():
            async with env.db.webhook_transaction():
                if winner=='dispatch': gate.set(); await proceed.wait()
                await env.bridge.dispatch_batch(batch)
        t=asyncio.create_task(claimant() if winner=='wait' else dispatcher()); await gate.wait()
        other=asyncio.create_task(dispatcher() if winner=='wait' else claimant()); proceed.set(); await asyncio.gather(t,other)
        members=await many(env.db.conn,'SELECT assignment_id,source_kind FROM webhook_assignment_events WHERE event_id=?',(event['eventId'],))
        assert len(members)==1 and members[0]['source_kind']==('wait' if winner=='wait' else 'initial')
        assert (members[0]['assignment_id']==a['assignment_id'])==(winner=='wait')
        if winner=='wait': assert (await one(env.db.conn,'SELECT state FROM webhook_batches WHERE batch_id=?',(batch['batch_id'],)))['state']=='empty'
        # Own and finish any extra controller before held() releases the original.
        for task in env.server.runs.scheduler.tasks(kind='controller'):
            if task.get_name()!='webhook-controller:'+a['assignment_id']: await asyncio.wait_for(task,10)


async def test_C18_partial_receipt_versions_are_independent(env):
    async with held(env) as (c,a,first,release):
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'r','match':match(),'collection':{'maxEvents':2}})
        b=await accept(env,c,'{"kind":"reply"}','b'); d=await accept(env,c,'{"kind":"reply"}','d'); await routing.tick(env.s); await waits.delivery(env.s,a['assignment_id'],w['waitId'])
        run=(await one(env.db.conn,'SELECT run_id FROM webhook_runtime_links'))['run_id']
        params={'receiptId':'first','results':[{'eventId':first['eventId'],'outcome':'completed'},{'eventId':b['eventId'],'outcome':'skipped'}]}
        receipt=await receipts.report(env.s,a['assignment_id'],run,params)
        assert await receipts.report(env.s,a['assignment_id'],run,params)==receipt
        with pytest.raises(WebhookError): await receipts.report(env.s,a['assignment_id'],run,{**params,'results':[{'eventId':first['eventId'],'outcome':'failed'}]})
        await receipts.report(env.s,a['assignment_id'],run,{'receiptId':'last','results':[{'eventId':d['eventId'],'outcome':'unknown'}]})
        assert (await receipts.candidate(env.s,a['assignment_id']))['outcome']=='partialFailure'
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_receipts'))['n']==3


@pytest.mark.parametrize('policy',['hold','useReceivedAt'])
@pytest.mark.parametrize('body',['{}','{"ts":"bad"}','{"ts":"2030-01-01T00:00:00Z"}'])
async def test_B14_source_time_invalid_policy(env,policy,body):
    now=1_800_000_000_000; env.s.clock=lambda:now; env.s.bridge=None
    c=await create(env,expiry={'basis':'sourceField','timestampPath':'body.ts','ttlSeconds':10,'missingTimestamp':policy})
    e=await accept(env,c,body)
    row=await one(env.db.conn,'SELECT * FROM webhook_events WHERE event_id=?',(e['eventId'],))
    assert row['terminal_reason']=='invalid_source_time' and row['expires_at_ms']==now+10000
    assert row['route_state']==('hold' if policy=='hold' else 'eligible')


async def test_A08_rate_retry_after_and_B17_missing_interpreter(env):
    original=env.s.config.scripts.python_path
    env.s.config.scripts.python_path='/nonexistent/isolated-python'
    with pytest.raises(WebhookError,match='interpreter_unavailable'):
        await create(env,pre={'enabled':True,'code':'print("{}")'})
    assert not await many(env.db.conn,'SELECT * FROM webhook_endpoints')
    env.s.config.scripts.python_path=original
    env.s.clock=lambda:1000000
    c=await create(env,limits={'requestsPerMinute':1})
    async def send(key): return await env.client.post('/webhook/'+c['endpoint']['id'],json={},headers={'Authorization':'Bearer '+c['credential']['key'],'Idempotency-Key':key})
    a=await send('one'); assert a.status==202
    b=await send('two'); assert b.status==429 and int(b.headers['Retry-After'])>=1 and (await b.json())['code']=='rate_limited'
    repeat=await send('one'); assert repeat.status==202 and (await repeat.json())['duplicate']
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_events'))['n']==1


@pytest.mark.parametrize('winner',['claim','cancel','timeout'])
async def test_C13_claim_control_writer_order(env,winner):
    now=[1000000]; env.s.clock=lambda:now[0]
    async with held(env) as (c,a,first,release):
        w=await waits.register(env.s,a['assignment_id'],123,{'endpointId':c['endpoint']['id'],'requestId':'r','match':match(),'timeoutSeconds':10})
        b=await accept(env,c,'{"kind":"reply"}','reply')
        gate=asyncio.Event(); proceed=asyncio.Event()
        async def claim():
            async with env.db.webhook_transaction() as conn:
                if winner=='claim': gate.set(); await proceed.wait()
                await routing.route(env.s,conn,await one(conn,'SELECT * FROM webhook_events WHERE event_id=?',(b['eventId'],)))
        async def control():
            async with env.db.webhook_transaction() as conn:
                if winner!='claim': gate.set(); await proceed.wait()
                if winner=='timeout': now[0]+=10000
                row=await one(conn,'SELECT * FROM webhook_waits WHERE wait_id=?',(w['waitId'],))
                await waits.close_wait(env.s,conn,row,'timeout' if winner=='timeout' else 'cancelled')
        t=asyncio.create_task(claim() if winner=='claim' else control()); await gate.wait()
        other=asyncio.create_task(control() if winner=='claim' else claim()); proceed.set(); await asyncio.gather(t,other)
        d=await waits.delivery(env.s,a['assignment_id'],w['waitId']); assert not d['events']
        member=await one(env.db.conn,'SELECT * FROM webhook_assignment_events WHERE event_id=?',(b['eventId'],))
        if winner=='claim':
            assert member and member['delivered_at_ms'] is None
            assert (await one(env.db.conn,'SELECT disposition FROM webhook_receipts WHERE assignment_event_id=?',(member['assignment_event_id'],)))['disposition']=='cancelled'
        else: assert member is None and (await one(env.db.conn,'SELECT route_state FROM webhook_events WHERE event_id=?',(b['eventId'],)))['route_state']=='batch'


async def test_D09_D11_target_loss_and_real_composite_constraints(env):
    import sqlite3
    conv=await env.server._create_web_conversation(123,folder_uuid='folder',title='Stable target')
    c=await create(env,target={'mode':'fixedConversation','conversationId':conv['conversation_uuid']},batching={'enabled':False}); e=await accept(env,c)
    await env.db.conn.execute("UPDATE web_conversations SET title='renamed',folder_uuid='',archived_at=1 WHERE conversation_uuid=?",(conv['conversation_uuid'],)); await env.db.conn.commit()
    await env.worker.tick(); assert not env.bridge.active and 'targetArchived' in (await env.s.get(123,c['endpoint']['id']))['endpoint']['pauseReasons']
    await env.db.conn.execute('DELETE FROM web_conversations WHERE conversation_uuid=?',(conv['conversation_uuid'],)); await env.db.conn.commit()
    await env.worker.tick(); ordinary=(await env.s.get(123,c['endpoint']['id']))['endpoint']; assert ordinary['url']==c['endpoint']['url'] and 'targetDeleted' in ordinary['pauseReasons']
    from app.webhooks.queries import detail
    assert (await detail(env.s,123,e['eventId']))['event']['payloadStatus']=='retained'
    from app.webhooks.repository import insert
    async with env.db.webhook_transaction() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            await insert(conn,'webhook_stage_jobs',job_id='invalid-revision',stage='pre',event_id=e['eventId'],endpoint_id=c['endpoint']['id'],revision=999,action_key='invalid',queued_at_ms=env.s.clock())
        await insert(conn,'webhook_assignments',assignment_id='first',origin_kind='human_wait',conversation_uuid='fixture-a',internal_chat_id=-3,root_turn_uuid='r-a',task_start_cursor=0,authorization_snapshot_json='{}',created_at_ms=env.s.clock())
        await insert(conn,'webhook_assignments',assignment_id='second',origin_kind='human_wait',conversation_uuid='fixture-b',internal_chat_id=-4,root_turn_uuid='r-b',task_start_cursor=0,authorization_snapshot_json='{}',created_at_ms=env.s.clock())
        await conn.execute("UPDATE webhook_batch_members SET invalidated_at_ms=?,invalidated_reason='constraint_fixture' WHERE event_id=?",(env.s.clock(),e['eventId']))
        await conn.execute("UPDATE webhook_events SET route_state='eligible' WHERE event_id=?",(e['eventId'],))
        await insert(conn,'webhook_assignment_events',assignment_event_id='a',assignment_id='first',event_id=e['eventId'],source_kind='initial',claimed_at_ms=env.s.clock())
        with pytest.raises(sqlite3.IntegrityError): await insert(conn,'webhook_assignment_events',assignment_event_id='b',assignment_id='second',event_id=e['eventId'],source_kind='initial',claimed_at_ms=env.s.clock())


async def test_B07_skip_does_not_extend_pre_completion_window_B05_success_not_retryable(env):
    from app.webhooks.recovery import retry
    env.s.bridge=None; now=[1000000]; env.s.clock=lambda:now[0]
    code='import json,sys\nk=json.load(sys.stdin)["body"]["kind"]\nprint(json.dumps({"decision":"continue"} if k=="continue" else {"decision":"skip_model","outcome":k}))'
    c=await create(env,pre={'enabled':True,'code':code},batching={'idleSeconds':3,'maxWaitSeconds':30})
    await accept(env,c,'{"kind":"continue"}','a'); now[0]+=5000; await drain_scripts(env)
    b=await one(env.db.conn,'SELECT * FROM webhook_batches'); assert b['first_entered_at_ms']==1005000
    now[0]+=1000; await accept(env,c,'{"kind":"continue"}','b'); await drain_scripts(env)
    now[0]+=2000; handled=await accept(env,c,'{"kind":"handled"}','handled'); await accept(env,c,'{"kind":"ignored"}','ignored'); await drain_scripts(env)
    assert (await one(env.db.conn,'SELECT idle_deadline_ms FROM webhook_batches'))['idle_deadline_ms']==1009000
    now[0]=1008999; await routing.tick(env.s); assert (await one(env.db.conn,'SELECT state FROM webhook_batches'))['state']=='collecting'
    now[0]+=1; await routing.tick(env.s); assert (await one(env.db.conn,'SELECT state,snapshot_event_count FROM webhook_batches'))=={'state':'sealed','snapshot_event_count':2}
    row=await one(env.db.conn,'SELECT route_version FROM webhook_events WHERE event_id=?',(handled['eventId'],))
    with pytest.raises(WebhookError,match='stage_not_retryable'): await retry(env.s,123,handled['eventId'],{'stage':'pre','requestId':'again','expectedVersion':row['route_version']})
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_stage_attempts'))['n']==4


async def test_A06_query_identity_and_B18_explicit_echo_only(env):
    env.s.bridge=None
    c=await create(env,correlation={'originPath':'body.origin','ownOriginValues':['self']})
    old=await accept(env,c,'{"origin":"self"}','default')
    assert (await one(env.db.conn,'SELECT route_state FROM webhook_events'))['route_state']=='eligible'
    cfg=c['endpoint']['config']; cfg['correlation']['ignoreOwnEcho']=True
    await env.s.update(123,c['endpoint']['id'],{'expectedRevision':1,'requestId':'echo','config':cfg})
    own=await accept(env,c,'{"origin":"self"}','self'); other=await accept(env,c,'{"origin":"vendor"}','other')
    await routing.tick(env.s)
    rows={r['event_id']:r for r in await many(env.db.conn,'SELECT event_id,terminal_reason,route_state FROM webhook_events')}
    assert rows[old['eventId']]['route_state']=='batch' and rows[other['eventId']]['route_state']=='batch' and rows[own['eventId']]['terminal_reason']=='own_echo'
    async def send(query): return await env.client.post('/webhook/'+c['endpoint']['id']+query,data='{}',headers={'Content-Type':'application/json','Authorization':'Bearer '+c['credential']['key'],'Idempotency-Key':'query'})
    assert (await send('?a=1&a=2')).status==202
    assert (await send('?a=2&a=1')).status==409
    p=await one(env.db.conn,"SELECT p.query_pairs_json FROM webhook_event_payloads p JOIN webhook_events e USING(event_id) WHERE e.idempotency_key='query'")
    assert json.loads(p['query_pairs_json'])==[['a','1'],['a','2']]


async def test_A10_actual_http_vs_tool_cas_and_reread_merge(env):
    from tests.test_web_admin import _login_cookie
    from app.tools.webhook import dispatch
    from app.tools.base import ToolRuntimeContext
    c=await create(env); eid=c['endpoint']['id']; conv=await env.server._create_web_conversation(123,folder_uuid='folder',title='Management')
    cookie=await _login_cookie(env); ctx=ToolRuntimeContext(webhook_owner_id=123,conversation_uuid=conv['conversation_uuid'])
    req={'expectedRevision':1,'config':c['endpoint']['config']}
    async def http():
        r=await env.client.patch('/api/webhooks/'+eid,json={**req,'requestId':'ui','name':'UI name'},cookies={'openbear_web_session':cookie});return r.status,await r.json()
    async def tool():
        try: return 200,await dispatch(env.s,'update',{**req,'endpointId':eid,'requestId':'tool','description':'Tool description'},ctx)
        except WebhookError as e:return e.status,e.payload
    results=await asyncio.gather(http(),tool()); assert sorted(r[0] for r in results)==[200,409]
    reread=await dispatch(env.s,'get',{'endpointId':eid},ctx); assert reread['endpoint']['revision']==2
    merged=await dispatch(env.s,'update',{'endpointId':eid,'requestId':'merge','expectedRevision':2,'name':'UI name','description':'Tool description','config':reread['endpoint']['config']},ctx)
    assert merged['endpoint']['revision']==3 and merged['endpoint']['name']=='UI name' and merged['endpoint']['description']=='Tool description'
