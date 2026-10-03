"""Webhook product paths on isolated SQLite/HTTP and the real controller host."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from aiohttp.test_utils import TestClient, TestServer

from app.web_admin import WebAdminServer
from app.webhooks.service import WebhookService
from app.webhooks.worker import Worker
from app.webhooks.runtime_bridge import RuntimeBridge
from app.webhooks.repository import one, many
from app.webhooks.contracts import WebhookError
from app.tools.base import ToolRegistry
from app.tools.webhook import register_webhook_tool
from app.db.engine import DB
from app.llm.events import StreamEvent, ToolCall, Usage
from tests.test_web_admin import _cfg, FakeBot, FakeRunFactory, FakeStreamBackend


@pytest.fixture
async def env(tmp_path,monkeypatch):
    monkeypatch.setenv('OPENBEAR_WEB_ARTIFACT_DIR',str(tmp_path/'artifacts'))
    db=DB(str(tmp_path/'webhooks.sqlite')); await db.connect()
    server=WebAdminServer(_cfg(),db,FakeBot())
    server.tools=ToolRegistry(); server.workspace_dir=str(tmp_path)
    s=WebhookService(db,config=server.config.webhooks,pepper=b'isolated-only',host=server)
    s.config.scripts.default_cwd=str(tmp_path); server.webhooks=s
    bridge=RuntimeBridge(s,server); worker=Worker(s)
    register_webhook_tool(server.tools,s)
    backend=FakeStreamBackend(); server.llm_factory=FakeRunFactory(backend,context_window=128000)
    server.model_selection=SimpleNamespace(current='openai/gpt')
    async def system(): return 'Existing frozen system prompt.'
    monkeypatch.setattr(server,'_build_system_prompt_for_chat',system)
    await db.conn.execute("INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name) VALUES('folder',123,'Fixture')"); await db.conn.commit()
    client=TestClient(TestServer(server.make_app())); await client.start_server()
    try: yield SimpleNamespace(db=db,s=s,server=server,worker=worker,bridge=bridge,client=client,backend=backend,tmp=tmp_path)
    finally:
        await worker.close(); await server.runs.cancel_all_and_wait(); await client.close(); await db.close()


async def create(env,**config):
    return await env.s.create(123,{'scope':{'type':'folder','id':'folder'},'name':'Fixture','enabled':True,'requestId':'create','config':{'processing':{'instructions':'Handle only assigned fixture events; report outcomes.'},**config}})


async def accept(env,c,body='{}',key='event'):
    return await env.s.receive(c['endpoint']['id'],c['credential']['key'],'application/json',body.encode(),[],key)


async def drain_scripts(env):
    await env.worker.tick()
    await asyncio.gather(*list(env.worker.tasks.values()))
    await env.worker.tick()


async def test_A03_A05_A06_A12_real_http(env):
    c=await create(env); eid=c['endpoint']['id']; secret=c['credential']['key']
    url='/webhook/'+eid
    missing=await env.client.post(url,json={}); assert missing.status==401
    wrong=await env.client.post(url,json={},headers={'Authorization':'Bearer wrong'}); assert wrong.status==403
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_events'))['n']==0
    admin=await env.client.get('/api/webhooks',headers={'Authorization':'Bearer '+secret}); assert admin.status==401
    async def send():
        r=await env.client.post(url+'?a=1&a=2',data='{"中文":1}',headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json','Idempotency-Key':'same'})
        assert r.status==202; return await r.json()
    values=await asyncio.gather(*(send() for _ in range(20)))
    assert len({v['eventId'] for v in values})==1 and sum(v['duplicate'] for v in values)==19
    # Another real SQLite reader sees acceptance before the caller observes 202.
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_events'))['n']==1
    r=await env.client.post(url+'?a=1&a=2',data=' {"中文":1}',headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json','Idempotency-Key':'same'})
    assert r.status==409
    ordinary=await env.s.get(123,eid)
    assert secret not in json.dumps(ordinary) and 'verifier' not in json.dumps(ordinary)
    prepared=await env.s.prepare(123,eid,'rotate_key',{'expectedControlRevision':0,'graceSeconds':0})
    rotated=await env.s.control(123,eid,{'requestId':'rotate','confirmationToken':prepared['confirmationToken']},action='rotate_key')
    r=await env.client.post(url,json={},headers={'Authorization':'Bearer '+secret}); assert r.status==403
    r=await env.client.post(url+'?a=1&a=2',data='{"中文":1}',headers={'Authorization':'Bearer '+rotated['credential']['key'],'Content-Type':'application/json','Idempotency-Key':'same'})
    assert r.status==202 and (await r.json())['eventId']==values[0]['eventId']


async def test_B01_B02_real_subprocess(env):
    code='import json,sys\nx=json.load(sys.stdin)\nassert "Authorization" not in x\nprint("log",file=sys.stderr)\nprint(json.dumps({"decision":"skip_model","outcome":x["body"]["outcome"],"reason":"fixture"}))'
    c=await create(env,pre={'enabled':True,'code':code})
    a=await accept(env,c,'{"outcome":"handled"}','a'); b=await accept(env,c,'{"outcome":"ignored"}','b')
    assert not await many(env.db.conn,'SELECT * FROM webhook_stage_attempts')
    await drain_scripts(env)
    r=await many(env.db.conn,'SELECT event_id,outcome,source FROM webhook_receipts ORDER BY outcome')
    assert {(x['event_id'],x['outcome'],x['source']) for x in r}=={(a['eventId'],'completed','script'),(b['eventId'],'skipped','script')}
    assert not await many(env.db.conn,'SELECT * FROM webhook_assignments')
    assert not await many(env.db.conn,'SELECT * FROM web_conversations')
    attempts=await many(env.db.conn,'SELECT * FROM webhook_stage_attempts'); assert len(attempts)==2 and all('log' in x['stderr_text'] for x in attempts)


async def test_C19_actual_web_runtime_receipt_repair(env):
    c=await create(env,batching={'enabled':False})
    event=await accept(env,c)
    backend=FakeStreamBackend([
        [StreamEvent(kind='content',text='Done, missing receipt'),StreamEvent(kind='finish',finish_reason='stop')],
        [StreamEvent(kind='tool_call',tool_calls=[ToolCall('report','Webhook',json.dumps({'action':'report','params':{'receiptId':'repair','results':[{'eventId':event['eventId'],'outcome':'completed','summary':'Fixture'}]}}))]),StreamEvent(kind='finish',finish_reason='tool_calls')],
        [StreamEvent(kind='content',text='Receipt filed'),StreamEvent(kind='finish',finish_reason='stop')],
    ])
    env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    await env.worker.tick()
    tasks=env.server.runs.scheduler.tasks(kind='controller')
    assert tasks
    await asyncio.gather(*tasks)
    a=await one(env.db.conn,'SELECT * FROM webhook_assignments')
    assert a['state']=='finalized' and a['repair_count']==1 and a['terminal_reason']=='normal'
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_runtime_links'))['n']==1
    assert (await one(env.db.conn,'SELECT source,outcome FROM webhook_receipts'))=={'source':'model','outcome':'completed'}
    assert any('trusted runtime provenance' in str(m.get('content')) for m in backend.seen_convos[0])


async def test_D10_D11_shared_writer_fk_restore(env):
    async with env.db.write_transaction() as conn:
        assert (await (await conn.execute('PRAGMA foreign_keys')).fetchone())[0]==0
        with pytest.raises(RuntimeError,match='FK-disabled'):
            async with env.db.webhook_transaction(): pass
    async with env.db.webhook_transaction() as conn:
        assert (await (await conn.execute('PRAGMA foreign_keys')).fetchone())[0]==1
        with pytest.raises(Exception):
            await conn.execute("INSERT INTO webhook_credentials(credential_id,endpoint_id,key_prefix,verifier,verifier_algorithm,pepper_version,created_at_ms,valid_from_ms) VALUES('bad','absent','x',X'00','test','1',0,0)")
    async with env.db.write_transaction() as conn:
        assert (await (await conn.execute('PRAGMA foreign_keys')).fetchone())[0]==0
    from app.webhooks.schema import migrate
    tables=await many(env.db.conn,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'webhook_%' ORDER BY name")
    await migrate(env.db)
    assert await many(env.db.conn,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'webhook_%' ORDER BY name")==tables
