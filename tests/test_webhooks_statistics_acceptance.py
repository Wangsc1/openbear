"""End-to-end product statistics and the actual Node editor over real HTTP."""
import asyncio
import json
import os
from pathlib import Path

import pytest

from app.webhooks.repository import one, many
from app.llm.events import StreamEvent, ToolCall
from tests.test_web_admin import FakeRunFactory, FakeStreamBackend, _login_cookie
from tests.test_webhooks_backend import env, create, accept, drain_scripts


async def test_F19_E01_E02_E03_full_directory_chain_and_statistics(env):
    from app.webhooks.queries import statistics
    postlog=env.tmp/'post'
    code='import sys,json\nx=json.load(sys.stdin); k=x["body"]["kind"]\nprint(json.dumps({"decision":"continue"} if k=="continue" else {"decision":"skip_model","outcome":k}))'
    c=await create(env,pre={'enabled':True,'code':code},post={'enabled':True,'code':'import sys,json\nx=json.load(sys.stdin)\nopen('+repr(str(postlog))+',"w").write(json.dumps(x))\nprint("{}")'},batching={'maxEvents':3},limits={'pendingEvents':5})
    eid=c['endpoint']['id']; headers={'Authorization':'Bearer '+c['credential']['key']}
    for _ in range(2): assert (await env.client.post('/webhook/'+eid,json={})).status==401
    accepted=[]
    for i,k in enumerate(['handled','ignored','continue','continue','continue']):
        r=await env.client.post('/webhook/'+eid,json={'kind':k},headers={**headers,'Idempotency-Key':str(i)}); assert r.status==202; accepted.append((await r.json())['eventId'])
    for _ in range(2):
        r=await env.client.post('/webhook/'+eid,json={'kind':'handled'},headers={**headers,'Idempotency-Key':'0'}); assert (await r.json())['duplicate']
    assert (await env.client.post('/webhook/'+eid,json={'kind':'continue'},headers={**headers,'Idempotency-Key':'overflow'})).status==429
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if self.calls==1:
                args={'action':'report','params':{'receiptId':'all','results':[{'eventId':eid,'outcome':'completed'} for eid in accepted[2:]]}}
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('reports','Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
            else:
                yield StreamEvent(kind='content',text='Finished batch'); yield StreamEvent(kind='finish',finish_reason='stop')
    env.server.llm_factory=FakeRunFactory(Backend(),context_window=128000)
    for _ in range(3): await drain_scripts(env)
    await asyncio.wait_for(asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller')),10)
    await drain_scripts(env)
    a=await one(env.db.conn,'SELECT * FROM webhook_assignments'); assert a['terminal_reason']=='normal'
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM web_conversations'))['n']==1
    assert len(json.loads(postlog.read_text())['assignment']['events'])==3
    assert len(await many(env.db.conn,'SELECT * FROM webhook_receipts'))==5
    models=await many(env.db.conn,"SELECT * FROM model_calls WHERE attempt_id!='' ORDER BY id"); assert len(models)==2
    for m,v in zip(models,[(100,200,50,20,.003),(300,100,0,40,.004)]):
        await env.db.conn.execute('UPDATE model_calls SET usage_known=1,input_tokens=?,cache_read_tokens=?,cache_write_tokens=?,output_tokens=?,cost_usd=? WHERE id=?',(*v,m['id']))
    await env.db.conn.commit()
    cookies={'openbear_web_session':await _login_cookie(env)}
    r=await env.client.get('/api/webhooks/statistics?view=overview&endpointId='+eid,cookies=cookies); assert r.status==200
    o=(await r.json())['overview']
    assert {k:o[k] for k in ['requests','rejected','duplicates','accepted','preAttempts','preContinue','preHandled','preIgnored','modelEvents','modelBatches','modelCalls','postAttempts']}==dict(requests=10,rejected=3,duplicates=2,accepted=5,preAttempts=5,preContinue=3,preHandled=1,preIgnored=1,modelEvents=3,modelBatches=1,modelCalls=2,postAttempts=1)
    u=o['usage']; assert (u['inputTokens'],u['cacheReadTokens'],u['cacheWriteTokens'],u['outputTokens'],u['cacheHitRate'])==(400,300,50,60,.4) and u['costUsd']==pytest.approx(.007)
    assert (await statistics(env.s,123,{'view':'overview','scopeType':'folder','scopeId':'folder'}))['overview']['usage']==u
    assert (await statistics(env.s,123,{'view':'overview','scopeType':'folder','scopeId':'missing'}))['overview']['usage']['modelCalls']==0
    n=await one(env.db.conn,"SELECT * FROM web_task_notifications WHERE kind='webhook-result'"); assert n['state']=='delivered'


async def test_E10_E11_E12_retained_metrics_and_business_query(env):
    from app.webhooks.telemetry import observe,metric_query
    from app.webhooks.retention import prune
    from app.webhooks.queries import statistics
    clock=[1200000]; env.s.clock=lambda:clock[0]
    c=await create(env,statistics={'dimensions':[{'name':'sender','path':'body.sender','kind':'category','maxCategories':2}], 'metricDefinitions':[{'name':'custom_by_sender','type':'counter','allowedLabels':['sender']},{'name':'custom_latency','type':'histogram','histogramBuckets':[.1,.5,1]}], 'businessFields':[{'name':'sender','path':'body.sender'},{'name':'sticker','path':'body.sticker'}]})
    eid=c['endpoint']['id']
    for i,value in enumerate([.05,.1,.4,1]):
        payload={'operationId':str(i),'metrics':[{'name':'custom_by_sender','value':1,'labels':{'sender':'s'+str(i)}},{'name':'custom_latency','value':value}],'records':[{'event':'claimed_deleted','fields':{'sender':'s'+str(i),'sticker':'one'}}]}
        await observe(env.s,eid,payload,source='script'); await observe(env.s,eid,payload,source='script')
    assert len(await many(env.db.conn,"SELECT * FROM webhook_metric_series WHERE definition_id IN (SELECT definition_id FROM webhook_metric_definitions WHERE name='custom_by_sender')"))==3
    q=await statistics(env.s,123,{'view':'business','endpointId':eid,'filters':'{"sender":"s2"}'})
    assert len(q['items'])==1 and q['items'][0]['source']=='script' and q['items'][0]['fields']['sender']=='s2'
    first=await statistics(env.s,123,{'view':'business','endpointId':eid,'limit':2})
    second=await statistics(env.s,123,{'view':'business','endpointId':eid,'limit':2,'cursor':first['nextCursor']})
    assert len({r['recordId'] for r in first['items']+second['items']})==4
    clock[0]+=31*86400000; await prune(env.s)
    assert not await many(env.db.conn,'SELECT * FROM webhook_metric_samples')
    histogram=next(r for r in await metric_query(env.s,eid,1200000,1260000) if r['name']=='custom_latency')
    assert histogram['count']==4 and histogram['sum']==pytest.approx(1.55) and histogram['buckets']['counts']==[2,1,1,0] and histogram['precision']=='bucketApproximation'


async def test_C24_script_telemetry_capability_and_separate_retry(env):
    env.server.config.web.port=env.client.server.port
    code='import os,json,urllib.request\np=json.dumps({"operationId":"http-once","metrics":[{"name":"custom_counter","value":1}]}).encode()\nu=os.environ["OPENBEAR_TELEMETRY_URL"]\nr=urllib.request.Request(u,data=p,headers={"Authorization":"Bearer "+os.environ["OPENBEAR_TELEMETRY_TOKEN"],"Content-Type":"application/json"})\nassert json.load(urllib.request.urlopen(r))["state"]=="applied"\nprint(json.dumps({"decision":"skip_model","outcome":"handled","operation_id":"later","metrics":[{"name":"custom_undeclared","value":1}]}))'
    c=await create(env,pre={'enabled':True,'code':code},statistics={'metricDefinitions':[{'name':'custom_counter','type':'counter'}]})
    await accept(env,c); await drain_scripts(env)
    assert (await one(env.db.conn,'SELECT state FROM webhook_stage_jobs'))['state']=='succeeded'
    o=await one(env.db.conn,"SELECT state,error_reason FROM webhook_telemetry_operations WHERE operation_id='later'"); assert o=={'state':'rejected','error_reason':'undeclared_metric'}
    a=await one(env.db.conn,'SELECT * FROM webhook_stage_attempts')
    from app.webhooks.capabilities import issue
    r=await env.client.post('/webhook/attempts/'+a['attempt_id']+'/telemetry',json={},headers={'Authorization':'Bearer '+issue(env.s,a['attempt_id'],env.s.clock()+60000)}); assert r.status==403
    config=c['endpoint']['config']; config['statistics']['metricDefinitions'].append({'name':'custom_undeclared','type':'counter'})
    await env.s.update(123,c['endpoint']['id'],{'requestId':'add-metric','expectedRevision':1,'config':config})
    cookies={'openbear_web_session':await _login_cookie(env)}
    r=await env.client.post('/api/webhooks/telemetry',cookies=cookies,json={'endpointId':c['endpoint']['id'],'operationId':'later'}); assert r.status==200 and (await r.json())['state']=='applied'
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_stage_attempts'))['n']==1
    assert (await one(env.db.conn,'SELECT source,outcome FROM webhook_receipts'))=={'source':'script','outcome':'completed'}


async def test_F_node_actual_editor_api_sqlite(env):
    # Use the production composable AND Api methods; only rewrite axios's origin
    # and transport cookie to this private test server. No HTTP/model response stubs.
    cookie=await _login_cookie(env)
    source=r'''
import assert from 'node:assert/strict';
import axios from './node_modules/axios/index.js';
const create=axios.create;
axios.create=(options)=>{const a=create({...options,baseURL:process.env.TEST_ORIGIN+'/api'});a.defaults.headers.Cookie='openbear_web_session='+process.env.TEST_COOKIE;return a;};
const {Api}=await import('./src/api.js');
const {createWebhookEditor}=await import('./src/components/webhooks/useWebhookEditor.js');
const editor=createWebhookEditor(Api,{requestId:()=>crypto.randomUUID()});
assert.equal(await editor.load({type:'folder',id:'folder'}),true);
assert.equal(editor.endpoint.value,null);
editor.draft.name='Node real editor';editor.draft.config.processing.instructions='Process only assigned isolated events';
assert.equal(await editor.save(true),true,editor.error.value+JSON.stringify(editor.errors.value));
const id=editor.endpoint.value.id;
const key=(await Api.webhookKey(id)).credential.key;
assert.ok(key.startsWith('wh_'));
assert.equal((await Api.webhookKey(id)).credential.key,key);
assert.equal(editor.oneTimeKey,undefined);
assert.ok(!JSON.stringify(editor.draft).includes(key));assert.ok(!JSON.stringify(editor.endpoint.value).includes(key));
const r=await fetch(process.env.TEST_ORIGIN+'/webhook/'+id,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Idempotency-Key':'node-event'},body:'{"source":"node"}'});
assert.equal(r.status,202);const accepted=await r.json();assert.ok(accepted.eventId);
editor.draft.description='Updated by real composable';
assert.equal(await editor.save(),true,editor.error.value);assert.equal(editor.endpoint.value.revision,2);
assert.ok(await editor.control('pause'));assert.equal(editor.endpoint.value.dispatchPaused,true);
const prepared=await Api.rotateWebhookKey(id,{prepare:true,graceSeconds:0,expectedControlRevision:editor.endpoint.value.controlRevision});
const rotated=await Api.rotateWebhookKey(id,{confirmationToken:prepared.confirmationToken,requestId:crypto.randomUUID()});
assert.notEqual(rotated.credential.key,key);assert.equal((await Api.webhookKey(id)).credential.key,rotated.credential.key);
const denied=await fetch(process.env.TEST_ORIGIN+'/webhook/'+id,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
const items=await Api.webhookEvents({endpointId:id});assert.equal(items.items.length,1);
assert.ok(!JSON.stringify(items).includes(key));assert.ok(!JSON.stringify(items).includes(rotated.credential.key));
console.log(JSON.stringify({endpointId:id,eventId:accepted.eventId,revision:editor.endpoint.value.revision,paused:editor.endpoint.value.dispatchPaused}));editor.dispose();
'''
    p=await asyncio.create_subprocess_exec('node','--input-type=module','-e',source,cwd=str(Path(__file__).resolve().parents[1]/'web'),env={**os.environ,'TEST_ORIGIN':str(env.client.make_url('')).rstrip('/'),'TEST_COOKIE':cookie},stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    try: out,err=await asyncio.wait_for(p.communicate(),20)
    except BaseException:
        if p.returncode is None: p.kill()
        await p.communicate(); raise
    assert p.returncode==0,err.decode()
    result=json.loads(out); assert result['revision']==2 and result['paused']
    assert (await one(env.db.conn,'SELECT endpoint_id FROM webhook_events WHERE event_id=?',(result['eventId'],)))['endpoint_id']==result['endpointId']


async def test_F22_C24_post_and_notification_retry_do_not_repeat_business(env):
    from aiohttp import web, ClientSession
    from aiohttp.test_utils import TestServer
    from app.webhooks.recovery import retry,verify
    from app.webhooks.notifications import retry as notification_retry
    business=[]; deliveries=[]; fail_delivery=[True]
    async def effect(request): business.append(await request.text()); return web.Response(text='externally committed')
    async def notify(request):
        key=await request.text()
        if fail_delivery[0]: fail_delivery[0]=False; return web.Response(status=503)
        if key not in deliveries: deliveries.append(key)
        return web.Response(text='ok')
    app=web.Application(); app.router.add_post('/effect',effect); app.router.add_post('/notify',notify)
    simulator=TestServer(app); await simulator.start_server()
    class Push:
        async def enqueue(self,owner,conv,key,status,**metadata):
            async with ClientSession() as session:
                async with session.post(simulator.make_url('/notify'),data=key) as r:
                    if r.status!=200: raise RuntimeError('simulator delivery unavailable')
    env.server.browser_push=Push()
    counter=env.tmp/'post-count'
    pre='import sys,json,urllib.request,time\nx=json.load(sys.stdin)\nurllib.request.urlopen(urllib.request.Request('+repr(str(simulator.make_url('/effect')))+',data=x["actionKey"].encode())).read()\ntime.sleep(10)'
    post='import pathlib,json\np=pathlib.Path('+repr(str(counter))+')\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nif n==1: raise SystemExit(1)\nprint("{}")'
    try:
        c=await create(env,batching={'enabled':False},pre={'enabled':True,'code':pre,'timeoutSeconds':.2,'onError':'continueModel'},post={'enabled':True,'code':post,'retry':{'maxAttempts':1,'idempotencyDeclaration':'Simulator post action is idempotent by actionKey'}})
        event=await accept(env,c)
        backend=FakeStreamBackend([[StreamEvent(kind='tool_call',tool_calls=[ToolCall('r','Webhook',json.dumps({'action':'report','params':{'receiptId':'r','results':[{'eventId':event['eventId'],'outcome':'completed'}]}}))]),StreamEvent(kind='finish',finish_reason='tool_calls')],[StreamEvent(kind='content',text='Model work complete'),StreamEvent(kind='finish',finish_reason='stop')]])
        env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
        await drain_scripts(env); await asyncio.wait_for(asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller')),10); await drain_scripts(env)
        assert len(business)==1 and backend.calls==2
        post_job=await one(env.db.conn,"SELECT * FROM webhook_stage_jobs WHERE stage='post'"); assert post_job['state']=='unknown'
        e=await one(env.db.conn,'SELECT * FROM webhook_events')
        await verify(env.s,123,event['eventId'],{'stage':'pre','requestId':'verified','expectedVersion':e['route_version'],'outcome':'completed','reason':'Simulator confirms the action key is committed','evidenceRefs':['simulator:committed']})
        business_result=await one(env.db.conn,'SELECT r.source,r.outcome FROM webhook_receipts r JOIN webhook_assignment_events m ON m.assignment_event_id=r.assignment_event_id ORDER BY r.result_version DESC LIMIT 1')
        assert business_result=={'source':'model','outcome':'completed'}
        verified=await one(env.db.conn,"SELECT assignment_event_id,stage_attempt_id FROM webhook_receipts WHERE source='administrator'")
        assert verified['assignment_event_id'] is None and verified['stage_attempt_id']
        e=await one(env.db.conn,'SELECT * FROM webhook_events')
        await retry(env.s,123,event['eventId'],{'stage':'post','requestId':'post-only','expectedVersion':e['route_version']})
        await drain_scripts(env)
        n=await one(env.db.conn,"SELECT * FROM web_task_notifications WHERE kind='webhook-result'"); assert n['state']=='paused'
        a=await one(env.db.conn,'SELECT * FROM webhook_assignments')
        await notification_retry(env.s,123,a['assignment_id'],{'requestId':'notification-only','expectedVersion':a['row_version']})
        await env.worker.tick()
        n=await one(env.db.conn,"SELECT * FROM web_task_notifications WHERE kind='webhook-result'")
        assert n['state']=='delivered' and deliveries==[n['notification_key']]
        assert len(business)==1 and backend.calls==2 and counter.read_text()=='2'
        assert (await one(env.db.conn,'SELECT review_required FROM webhook_events'))['review_required']==0
        assert (await one(env.db.conn,"SELECT COUNT(*) n FROM webhook_stage_jobs WHERE stage='post'"))['n']==1
        assert (await one(env.db.conn,"SELECT COUNT(*) n FROM webhook_stage_attempts a JOIN webhook_stage_jobs j USING(job_id) WHERE j.stage='pre'"))['n']==1
    finally: await simulator.close()
