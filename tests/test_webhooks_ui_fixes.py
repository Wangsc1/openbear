"""Retained UI wait controls and routes: real isolated HTTP + SQLite, no worker."""
from types import SimpleNamespace
from pathlib import Path
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from app.db.engine import DB
from app.webhooks.service import WebhookService
from app.webhooks.http import install
from app.webhooks.contracts import WebhooksConfig
from app.webhooks.repository import insert, one
from app.web_console.core import _WEB_SESSION_KEY


@pytest.fixture
async def ui_http(tmp_path, monkeypatch):
    monkeypatch.setenv('OPENBEAR_WEB_ARTIFACT_DIR', str(tmp_path))
    db = DB(str(tmp_path/'isolated.sqlite')); await db.connect()
    # Parallel v2 registry is owned by the controller. Only this temporary DB
    # uses pending DDL when it has not yet been registered; never production.
    for table, filename in [('webhook_call_projections','webhooks_data_v2.sql')]:
        if not await one(db.conn,"SELECT name FROM sqlite_master WHERE name=?",(table,)):
            await db.conn.executescript((Path(__file__).parents[1]/'app/db'/filename).read_text())
    cfg=WebhooksConfig(); cfg.scripts.default_cwd=str(tmp_path)
    host=SimpleNamespace(config=SimpleNamespace(web=SimpleNamespace(custom_url=None)))
    s=WebhookService(db,config=cfg,pepper=b'isolated-ui-fixes',host=host); host.webhooks=s
    @web.middleware
    async def auth(request, handler):
        request[_WEB_SESSION_KEY]=SimpleNamespace(chat_id=123)
        return await handler(request)
    app=web.Application(middlewares=[auth]); install(app,host)
    client=TestClient(TestServer(app)); await client.start_server()
    await db.conn.execute("INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name) VALUES('F1',123,'Orders'),('F2',123,'Other')")
    await db.conn.execute("INSERT INTO web_conversations(conversation_uuid,owner_chat_id,internal_chat_id,title,folder_uuid) VALUES('C1',123,-991,'Processor','F1')")
    await db.conn.commit()
    async def call(method,path,body=None):
        r=await client.request(method,path,json=body)
        return r.status, await r.json()
    keys = {}
    async def create(fid='F1'):
        status,value=await call('POST','/api/webhooks',{'scope':{'type':'folder','id':fid},'name':fid,'enabled':True,'requestId':'create-'+fid,'config':{'processing':{'instructions':'isolated only'}}})
        assert status==201,value
        keys[value['endpoint']['id']] = value['credential']['key']
        return value['endpoint']
    try: yield SimpleNamespace(db=db,s=s,call=call,create=create,auth=auth,host=host,keys=keys,client=client)
    finally: await client.close(); await db.close()


async def test_ui01_wait_control_uses_wait_version_and_claims_once(ui_http):
    h=ui_http; e=await h.create()
    response=await h.client.post('/webhook/'+e['id'],json={'x':1},headers={'Authorization':'Bearer '+h.keys[e['id']],'Idempotency-Key':'wait-event'})
    assert response.status==202
    accepted=await response.json()
    eid=accepted['eventId']
    async with h.db.webhook_transaction() as conn:
        await insert(conn,'webhook_assignments',assignment_id='A',origin_kind='human_wait',conversation_uuid='C1',internal_chat_id=-991,root_turn_uuid='root',task_start_cursor=0,authorization_snapshot_json='{}',created_at_ms=h.s.clock())
        for wid in ['W1','W2']:
            await insert(conn,'webhook_waits',wait_id=wid,assignment_id='A',endpoint_id=e['id'],register_request_id=wid,predicate_json='{"all":[{"path":"body.x","op":"eq","value":1}]}',predicate_sha256=wid,scope_snapshot_json='{}',after_receive_seq=0,scan_through_seq=0,mode='single',registered_at_ms=h.s.clock(),row_version=7)
            await insert(conn,'webhook_wait_candidates',event_id=eid,wait_id=wid,detected_at_ms=h.s.clock())
        await conn.execute("UPDATE webhook_events SET route_state='match_conflict',route_version=22 WHERE event_id=?",(eid,))
    status, data=await h.call('GET','/api/webhooks/waits?eventId='+eid)
    assert status==200 and {x['version'] for x in data['items']}=={7}
    body={'action':'resolve_match','eventId':eid,'expectedVersion':7,'requestId':'resolve-same'}
    status, result=await h.call('POST','/api/webhooks/waits/W1/control',body)
    assert status==200,result
    _, listed=await h.call('GET','/api/webhooks/waits?eventId='+eid)
    assert next(w for w in listed['items'] if w['waitId']=='W1')['claimed']==[eid]
    assert (await h.call('POST','/api/webhooks/waits/W1/control',body))[1]==result
    assert (await one(h.db.conn,'SELECT COUNT(*) n FROM webhook_assignment_events WHERE event_id=?',(eid,)))['n']==1


async def test_ui05_active_scope_search_before_pagination(ui_http):
    h=ui_http; e=await h.create(); other=await h.create('F2')
    async with h.db.webhook_transaction() as conn:
        await insert(conn,'webhook_assignments',assignment_id='A',origin_kind='human_wait',conversation_uuid='C1',internal_chat_id=-991,root_turn_uuid='root',task_start_cursor=0,authorization_snapshot_json='{}',created_at_ms=h.s.clock())
        for i in range(65):
            await insert(conn,'webhook_waits',wait_id=f'W{i:03}',assignment_id='A',endpoint_id=other['id'] if i==0 else e['id'],register_request_id=str(i),predicate_json='{}',predicate_sha256=str(i),scope_snapshot_json='{}',after_receive_seq=0,scan_through_seq=0,mode='single',registered_at_ms=h.s.clock(),state='cancelled' if i<32 else 'registered')
    url='/api/webhooks/waits?active=true&scopeType=folder&scopeId=F1&search=F1&effectiveStatus=receiving&limit=30'
    status,page=await h.call('GET',url)
    assert status==200 and len(page['items'])==30 and all(x['state']=='registered' and x['endpointId']==e['id'] for x in page['items'])
    _, last=await h.call('GET',url+'&cursor='+page['nextCursor'])
    assert len(last['items'])==3 and not last['nextCursor']


async def test_ui08_registered_spa_route(ui_http):
    from app.web_console.routing import WebAdminAppMixin
    h=ui_http
    class RouteHost:
        def __getattr__(self,name):
            if name=='_auth_middleware': return h.auth
            if name in ('_realtime_context','_web_push_context'):
                async def context(app): yield
                return context
            async def inert(*args): return web.json_response({'route':'existing-page'})
            return inert
    host=RouteHost(); host.webhooks=h.s
    client=TestClient(TestServer(WebAdminAppMixin.make_app(host))); await client.start_server()
    try:
        for url in ['/webhooks','/settings','/statistics']:
            response=await client.get(url); assert response.status==200
    finally: await client.close()
