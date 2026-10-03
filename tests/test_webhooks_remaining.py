"""Remaining A/B functional checks; existing stable acceptance is not replayed."""
import asyncio
import hashlib
import json
import sys

import pytest
from app.webhooks import routing
from app.webhooks.contracts import WebhookError,dumps
from app.webhooks.repository import one,many
from app.llm.events import StreamEvent,ToolCall
from tests.test_web_admin import FakeRunFactory,FakeStreamBackend,_login_cookie
from tests.test_webhooks_backend import env,create,accept,drain_scripts


async def test_management_search_and_actual_state_before_pagination(env):
    endpoints=[]
    for i in range(7):
        folder='folder'+str(i)
        await env.db.conn.execute('INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name) VALUES(?,123,?)',(folder,folder)); await env.db.conn.commit()
        endpoints.append(await env.s.create(123,{'scope':{'type':'folder','id':folder},'enabled':False,'requestId':folder,'name':'Noise','config':{}}))
    endpoints.sort(key=lambda x:x['endpoint']['id'])
    for i,c in enumerate(endpoints):
        eid=c['endpoint']['id']
        await env.s.update(123,eid,{'requestId':'edit'+str(i),'expectedRevision':1,'name':'Needle' if i in (3,5,6) else 'Noise','description':'Search target','config':{'processing':{'instructions':'task'}}})
        if i in (3,5,6): await env.s.control(123,eid,{'action':'set_enabled','enabled':True,'expectedControlRevision':0,'requestId':'enable'+str(i)})
    cookies={'openbear_web_session':await _login_cookie(env)}
    async def query(params):
        r=await env.client.get('/api/webhooks',params=params,cookies=cookies); assert r.status==200; return await r.json()
    first=await query({'search':'nEeDlE','effectiveStatus':'receiving','limit':'1'})
    second=await query({'search':'nEeDlE','effectiveStatus':'receiving','limit':'1','cursor':first['nextCursor']})
    third=await query({'search':'nEeDlE','effectiveStatus':'receiving','limit':'1','cursor':second['nextCursor']})
    assert [x['items'][0]['id'] for x in (first,second,third)]==[endpoints[i]['endpoint']['id'] for i in (3,5,6)] and third['nextCursor'] is None
    eid=endpoints[3]['endpoint']['id']
    await env.s.control(123,eid,{'action':'pause','expectedControlRevision':1,'requestId':'pause'})
    assert [x['id'] for x in (await query({'effectiveStatus':'paused'}))['items']]==[eid]
    async with env.db.webhook_transaction() as conn:
        await conn.execute('UPDATE webhook_endpoints SET model_blockers_json=? WHERE endpoint_id=?',(dumps({'review:fixture':{'source':'review'}}),eid))
    assert [x['id'] for x in (await query({'effectiveStatus':'needs_review'}))['items']]==[eid]
    env.s.config.enabled=False
    assert len((await query({'effectiveStatus':'globalDisabled'}))['items'])==7
    assert not (await query({'effectiveStatus':'receiving'}))['items']


async def test_rotations_never_extend_or_resurrect_older_grace(env):
    now=[1000000]; env.s.clock=lambda:now[0]
    c=await create(env); eid=c['endpoint']['id']; key0=c['credential']['key']
    async def rotate(revision,seconds):
        p=await env.s.prepare(123,eid,'rotate_key',{'expectedControlRevision':revision,'graceSeconds':seconds})
        return (await env.s.control(123,eid,{'requestId':'rotate'+str(revision),'confirmationToken':p['confirmationToken']},action='rotate_key'))['credential']['key']
    async def status(key):
        return (await env.client.post('/webhook/'+eid,json={},headers={'Authorization':'Bearer '+key})).status
    key1=await rotate(0,60)
    now[0]+=30000; key2=await rotate(1,60)
    assert [await status(k) for k in (key0,key1,key2)]==[202,202,202]
    now[0]+=30000
    assert [await status(k) for k in (key0,key1,key2)]==[403,202,202]
    key3=await rotate(2,60)
    assert await status(key0)==403
    now[0]+=30000
    assert [await status(k) for k in (key1,key2,key3)]==[403,202,202]
    await rotate(3,0)
    assert all([await status(k)==403 for k in (key0,key1,key2,key3)])


async def test_frozen_revision_pre_script_target_group_ttl_and_pause(env):
    env.s.bridge=None; clock=[1000000]; env.s.clock=lambda:clock[0]
    c=await create(env,pre={'enabled':True,'code':'print(\'{"decision":"continue","model_data":{"version":1}}\')'},batching={},expiry={'ttlSeconds':10})
    a=await accept(env,c,'{"old":"a","new":"b"}','rev1')
    target=await env.server._create_web_conversation(123,folder_uuid='folder',title='Revision two')
    await env.s.update(123,c['endpoint']['id'],{'expectedRevision':1,'requestId':'v2','config':{'processing':{'instructions':'version two'},'pre':{'enabled':True,'code':'print(\'{"decision":"continue","model_data":{"version":2}}\')'},'target':{'mode':'fixedConversation','conversationId':target['conversation_uuid']},'batching':{},'expiry':{'ttlSeconds':20}}})
    b=await accept(env,c,'{"old":"a","new":"b"}','rev2')
    await env.s.control(123,c['endpoint']['id'],{'action':'pause','expectedControlRevision':0,'requestId':'p'})
    await env.worker.tick(); assert not env.worker.tasks
    await env.s.control(123,c['endpoint']['id'],{'action':'resume','expectedControlRevision':1,'requestId':'r'})
    await drain_scripts(env)
    events=await many(env.db.conn,'SELECT * FROM webhook_events ORDER BY receive_seq'); assert [x['received_revision'] for x in events]==[1,2] and [x['expires_at_ms'] for x in events]==[1010000,1020000]
    assert [(await env.s.event_material(env.db.conn,x['eventId']))['derived']['version'] for x in (a,b)]==[1,2]
    batches=await many(env.db.conn,'SELECT * FROM webhook_batches'); assert {x['revision'] for x in batches}=={1,2} and len({x['aggregation_key'] for x in batches})==1
    revisions=await many(env.db.conn,'SELECT target_mode,target_conversation_uuid FROM webhook_revisions ORDER BY revision')
    assert revisions==[{'target_mode':'newConversation','target_conversation_uuid':None},{'target_mode':'fixedConversation','target_conversation_uuid':target['conversation_uuid']}]


@pytest.mark.parametrize('valid',[False,True])
async def test_result_schema_blocks_only_post_preserves_model_declaration(env,valid):
    pytest.importorskip('jsonschema',reason='Declared jsonschema dependency is absent in this environment')
    marker=env.tmp/'post'
    c=await create(env,processing={'instructions':'Schema task','resultSchema':{'type':'object','required':['ok'],'properties':{'ok':{'type':'boolean'}}}},batching={'enabled':False},post={'enabled':True,'code':'open('+repr(str(marker))+',"w").write("post")\nprint("{}")'})
    event=await accept(env,c)
    args={'action':'report','params':{'receiptId':'schema','results':[{'eventId':event['eventId'],'outcome':'completed','result':{'ok':True if valid else 'yes'}}]}}
    backend=FakeStreamBackend([[StreamEvent(kind='tool_call',tool_calls=[ToolCall('r','Webhook',json.dumps(args))]),StreamEvent(kind='finish',finish_reason='tool_calls')],[StreamEvent(kind='content',text='Done'),StreamEvent(kind='finish',finish_reason='stop')]])
    env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    await env.worker.tick(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller')); await drain_scripts(env)
    job=await one(env.db.conn,"SELECT * FROM webhook_stage_jobs WHERE stage='post'")
    assert job['state']==('succeeded' if valid else 'held') and marker.exists()==valid and backend.calls==2
    assert (await one(env.db.conn,'SELECT outcome,source FROM webhook_receipts'))=={'outcome':'completed','source':'model'}
    if not valid: assert (await one(env.db.conn,'SELECT review_required,terminal_reason FROM webhook_events'))=={'review_required':1,'terminal_reason':'invalid_structured_result'}


async def test_schema_remote_refs_rejected_at_save():
    pytest.importorskip('jsonschema',reason='Declared jsonschema dependency is absent in this environment')
    from app.webhooks.templates import validate_result_schema
    for key in ('$ref','$dynamicRef','$recursiveRef'):
        with pytest.raises(WebhookError,match='remote_schema_reference_forbidden'): validate_result_schema({key:'https://invalid.example/schema'})


async def test_schema_missing_dependency_fails_closed(env,monkeypatch):
    monkeypatch.setitem(sys.modules,'jsonschema.validators',None)
    with pytest.raises(WebhookError) as failure:
        await create(env,processing={'instructions':'schema','resultSchema':{'type':'object'}})
    assert failure.value.payload['code']=='schema_validator_unavailable' and failure.value.status==503
    assert not await many(env.db.conn,'SELECT * FROM webhook_endpoints')


async def test_inline_system_environment_is_frozen(env):
    code='import json,sys,os\nx=json.load(sys.stdin)\nassert "FIXTURE" not in os.environ\nassert x["body"]["code"]=="evil"\nassert "OPENBEAR_TELEMETRY_TOKEN" in os.environ\nprint(json.dumps({"decision":"skip_model","outcome":"handled"}))'
    env.s.config.scripts.python_path=sys.executable
    c=await create(env,pre={'enabled':True,'code':code})
    await accept(env,c,'{"code":"evil","interpreter":"/missing","cwd":"/","env":{"FIXTURE":"evil"}}')
    await drain_scripts(env)
    a=await one(env.db.conn,'SELECT * FROM webhook_stage_attempts'); info=json.loads(a['execution_json'])
    assert a['state']=='succeeded' and info['sourceSha256']==hashlib.sha256(code.encode()).hexdigest() and info['cwd']==str(env.tmp) and info['interpreter']==str(__import__('pathlib').Path(sys.executable).resolve())


async def test_batch_utf8_exact_limit_next_byte_and_two_connections(env):
    from app.db.engine import DB
    from app.webhooks.service import WebhookService
    c=await create(env,batching={'maxBytes':65536,'idleSeconds':3,'maxWaitSeconds':30})
    event=await accept(env,c,json.dumps({'value':'中文'*10},ensure_ascii=False),'probe')
    size=len(dumps(await env.s.event_material(env.db.conn,event['eventId'])).encode())
    # IDs/timestamps have fixed width; each ASCII body character occurs twice
    # (body and original content). Use Unicode to demonstrate bytes, not chars.
    await env.s.update(123,c['endpoint']['id'],{'requestId':'exact','expectedRevision':1,'config':{'processing':{'instructions':'batch'},'batching':{'maxBytes':size}}})
    exact=await accept(env,c,json.dumps({'value':'中文'*10},ensure_ascii=False),'exact')
    over=await accept(env,c,json.dumps({'value':'中文'*10},ensure_ascii=False)+' ','over')
    db2=DB(env.db.path); await db2.connect(); s2=WebhookService(db2,config=env.s.config,pepper=b'isolated-only')
    try: await asyncio.gather(routing.tick(env.s),routing.tick(s2))
    finally: await db2.close()
    b=await one(env.db.conn,'SELECT b.* FROM webhook_batches b JOIN webhook_batch_members m USING(batch_id) WHERE m.event_id=?',(exact['eventId'],))
    assert b['state']=='sealed' and b['snapshot_bytes']==size and b['seal_reason']=='bytes'
    assert (await one(env.db.conn,'SELECT route_state,terminal_reason FROM webhook_events WHERE event_id=?',(over['eventId'],)))=={'route_state':'hold','terminal_reason':'oversize_event'}
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_batch_members WHERE event_id=?',(exact['eventId'],)))['n']==1
