"""Simplified product contract through real local HTTP, SQLite, host and scripts."""
import asyncio
import json

import pytest
from pydantic import ValidationError
from app.tools.base import ToolRuntimeContext
from app.tools.webhook import dispatch
from app.webhooks import routing
from app.webhooks.contracts import WebhookError, WebhooksConfig
from app.webhooks.repository import one, many
from tests.test_webhooks_backend import env, create, accept, drain_scripts
from tests.test_webhooks_controls_matrix import reporting_backend
from tests.test_web_admin import FakeRunFactory, _login_cookie


def evidence(label, **facts):
    print('SIMPLIFICATION_EVIDENCE', label, json.dumps(facts,ensure_ascii=False))


@pytest.mark.parametrize('removed',[
    {'budget':{}}, {'batching':{'groupBy':[]}}, {'batching':{'missingGroupValue':'separate'}},
    {'limits':{'burst':1}}, {'pre':{'sourceMode':'inline'}}, {'post':{'entryFile':'/tmp/script.py'}},
    {'pre':{'cwd':'/tmp'}}, {'pre':{'env':[]}}, {'post':{'env':[{'name':'X','secretRef':'@secret/x#y'}]}},
    {'pre':{'interpreter':'/usr/bin/python3'}},
])
async def test_removed_endpoint_capabilities_rejected_by_real_api(env,removed):
    cookies={'openbear_web_session':await _login_cookie(env)}
    response=await env.client.post('/api/webhooks',cookies=cookies,json={'scope':{'type':'folder','id':'folder'},'requestId':'removed','config':removed})
    assert response.status==422 and (await response.json())['code']=='invalid_config'
    assert not await one(env.db.conn,'SELECT endpoint_id FROM webhook_endpoints')


@pytest.mark.parametrize('removed',[
    {'ingress':{'burst':1}}, {'ingress':{'endpointDefaultPerMinute':1}}, {'ingress':{'endpointDefaultBurst':1}},
    {'queue':{'endpointDefaultEvents':1}}, {'queue':{'endpointDefaultBytes':1024}},
])
def test_removed_system_fields_are_not_silent_defaults(removed):
    with pytest.raises(ValidationError): WebhooksConfig.model_validate(removed)


async def test_preview_and_test_are_not_product_entrypoints(env):
    c=await create(env); eid=c['endpoint']['id']; cookies={'openbear_web_session':await _login_cookie(env)}
    for path in ('/api/webhooks/preview',f'/api/webhooks/{eid}/preview',f'/api/webhooks/{eid}/tests'):
        response=await env.client.post(path,cookies=cookies,json={'prepare':True,'stage':'full','sample':{'body':{}}})
        assert response.status in (404,405)
    response=await env.client.post(f'/api/webhooks/{eid}/control',cookies=cookies,json={'action':'test','requestId':'removed','expectedControlRevision':0})
    assert response.status==422 and (await response.json())['code']=='invalid_control'
    with pytest.raises(WebhookError,match='invalid_confirmation_action'):
        await env.s.prepare(123,eid,'test',{'stage':'pre','sample':{}})
    with pytest.raises(WebhookError,match='invalid_action'):
        await dispatch(env.s,'test',{},ToolRuntimeContext())
    assert not env.s.confirmations and not await one(env.db.conn,'SELECT event_id FROM webhook_events')
    # Actual producer path still authenticates and commits; there is no owner/test bypass.
    response=await env.client.post('/webhook/'+eid,json={}); assert response.status==401
    response=await env.client.post('/webhook/'+eid,json={},headers={'Authorization':'Bearer '+c['credential']['key']})
    assert response.status==202
    evidence('product_test_removed',routes='404/405',control='invalid_control',producerStatus=202)


async def test_null_limits_use_system_values_without_endpoint_defaults(env):
    clock=[600000]; env.s.clock=lambda:clock[0]
    env.s.config.ingress.requests_per_minute=3
    env.s.config.queue.max_events=3
    c=await create(env,limits={'requestsPerMinute':None,'pendingEvents':None,'pendingBytes':None})
    for i in range(3): await accept(env,c,key=str(i))
    with pytest.raises(WebhookError,match='rate_limited'): await accept(env,c,key='four')
    assert (await accept(env,c,key='0'))['duplicate']
    clock[0]+=60000
    with pytest.raises(WebhookError,match='queue_full'): await accept(env,c,key='four')
    assert (await env.s.get(123,c['endpoint']['id']))['endpoint']['pendingEvents']==3
    evidence('inherited_limits',systemPerMinute=3,accepted=3,duplicateReplayed=True,queueCap=3)


async def test_explicit_endpoint_rate_does_not_reduce_other_endpoints(env):
    env.s.clock=lambda:600000; env.s.config.ingress.requests_per_minute=3
    c=await create(env,limits={'requestsPerMinute':1})
    await env.db.conn.execute("INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name) VALUES('other',123,'Other')"); await env.db.conn.commit()
    d=await env.s.create(123,{'scope':{'type':'folder','id':'other'},'requestId':'other','enabled':True,'config':{'processing':{'instructions':'task'}}})
    await accept(env,c)
    with pytest.raises(WebhookError,match='rate_limited'): await accept(env,c,key='blocked')
    await accept(env,d,key='one'); await accept(env,d,key='two')
    with pytest.raises(WebhookError,match='rate_limited'): await accept(env,d,key='three')
    assert (await one(env.db.conn,'SELECT count(*) n FROM webhook_events'))['n']==3


@pytest.mark.parametrize('overrides,expected',[
    ({},('openai/gpt','high',1)),
    ({'mainModel':None,'mainThinkingLevel':None,'mainFastMode':False},('openai/gpt','high',0)),
    ({'mainModel':'openai/cheap','mainThinkingLevel':'medium'},('openai/cheap','medium',0)),
    ({'mainThinkingLevel':'low'},('openai/gpt','low',1)),
    ({'mainModel':' openai/cheap ','mainThinkingLevel':'medium'},('openai/cheap','medium',0)),
])
async def test_actual_new_conversation_fieldwise_run_config(env,overrides,expected):
    await env.db.conn.execute("INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name,run_defaults_json) VALUES('parent',123,'Parent',?)",(json.dumps({'mainModel':'openai/gpt','mainFastMode':True}),))
    await env.db.conn.execute("UPDATE web_conversation_folders SET parent_uuid='parent',run_defaults_json=? WHERE folder_uuid='folder'",(json.dumps({'mainThinkingLevel':'high'}),)); await env.db.conn.commit()
    selected=[]
    class Factory(FakeRunFactory):
        def backend_for(self,fullname): selected.append(fullname); return super().backend_for(fullname)
    env.server.llm_factory=Factory(reporting_backend(env),context_window=128000)
    c=await create(env,target={'mode':'newConversation','runConfig':overrides},batching={'enabled':False})
    loaded=(await env.s.get(123,c['endpoint']['id']))['endpoint']['config']['target']['runConfig']
    assert all(loaded[k]==v for k,v in overrides.items())
    await accept(env,c); await env.worker.tick(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller'))
    row=await one(env.db.conn,'SELECT c.model AS main_model,s.thinking_level AS main_thinking_level,s.fast_mode AS main_fast_mode,c.folder_uuid FROM web_conversations c JOIN sessions s ON s.chat_id=c.internal_chat_id')
    assert (row['main_model'],row['main_thinking_level'],row['main_fast_mode'])==expected
    assert row['folder_uuid']=='folder' and selected and set(selected)=={expected[0]}
    assert (await one(env.db.conn,'SELECT terminal_reason FROM webhook_assignments'))['terminal_reason']=='normal'
    evidence('actual_inheritance',overrides=overrides,created=row,executedModels=selected)


async def test_all_null_uses_system_and_revision_keeps_overlay(env):
    _,system=await env.server._web_run_defaults_candidate(123)
    c=await create(env,target={'mode':'newConversation','runConfig':{'mainModel':None,'mainThinkingLevel':None,'mainFastMode':None}},batching={'enabled':False})
    backend=reporting_backend(env); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    await accept(env,c); await env.worker.tick(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller'))
    row=await one(env.db.conn,'SELECT c.model AS main_model,s.thinking_level AS main_thinking_level,s.fast_mode AS main_fast_mode FROM web_conversations c JOIN sessions s ON s.chat_id=c.internal_chat_id')
    assert row=={'main_model':system['mainModel'],'main_thinking_level':system['mainThinkingLevel'],'main_fast_mode':int(system['mainFastMode'])}
    cfg=c['endpoint']['config']; cfg['target']['runConfig']={'mainModel':'openai/cheap','mainFastMode':False}
    await env.s.update(123,c['endpoint']['id'],{'expectedRevision':1,'requestId':'overlay','config':cfg})
    _,old=await env.s.revision(env.db.conn,c['endpoint']['id'],1); _,new=await env.s.revision(env.db.conn,c['endpoint']['id'],2)
    assert old.target.run_config.main_model is None and new.target.run_config.main_model=='openai/cheap' and new.target.run_config.main_fast_mode is False


@pytest.mark.parametrize('overrides,code',[
    ({'mainModel':'openai/cheap','mainThinkingLevel':'high'},'invalid_thinking_level'),
    ({'mainModel':'openai/cheap','mainFastMode':True},'fast_not_supported'),
    ({'mainModel':'missing/model'},'model_not_found'),
    ({'mainFastMode':'false'},'invalid_config'),
])
async def test_run_config_validates_final_model_capabilities(env,overrides,code):
    with pytest.raises(WebhookError) as failure:
        await create(env,target={'runConfig':overrides})
    assert failure.value.payload['code']==code
    assert not await one(env.db.conn,'SELECT endpoint_id FROM webhook_endpoints')


async def test_fixed_target_subtree_archive_and_runtime_move_guard(env):
    await env.db.conn.execute("INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,parent_uuid,name) VALUES('child',123,'folder','Child')"); await env.db.conn.commit()
    inside=await env.server._create_web_conversation(123,folder_uuid='child',title='Child',run_config={'main_model':'openai/cheap','main_thinking_level':'low','main_fast_mode':0})
    outside=await env.server._create_web_conversation(123,title='Outside')
    with pytest.raises(WebhookError,match='target_outside_scope'):
        await create(env,target={'mode':'fixedConversation','conversationId':outside['conversation_uuid']})
    with pytest.raises(WebhookError) as failure:
        await create(env,target={'mode':'fixedConversation','conversationId':inside['conversation_uuid'],'runConfig':{'mainFastMode':False}})
    assert failure.value.payload['code']=='invalid_config'
    await env.db.conn.execute('UPDATE web_conversations SET archived_at=1 WHERE conversation_uuid=?',(inside['conversation_uuid'],)); await env.db.conn.commit()
    with pytest.raises(WebhookError,match='target_unavailable'):
        await create(env,target={'mode':'fixedConversation','conversationId':inside['conversation_uuid']})
    await env.db.conn.execute('UPDATE web_conversations SET archived_at=0 WHERE conversation_uuid=?',(inside['conversation_uuid'],)); await env.db.conn.commit()
    c=await create(env,target={'mode':'fixedConversation','conversationId':inside['conversation_uuid'],'runConfig':{'mainModel':None}},batching={'enabled':False})
    await accept(env,c); await routing.tick(env.s)
    # Moving a whole nested folder out is equivalent to moving the target out.
    await env.db.conn.execute("UPDATE web_conversation_folders SET parent_uuid='' WHERE folder_uuid='child'"); await env.db.conn.commit()
    await env.bridge.dispatch()
    assert not await one(env.db.conn,'SELECT assignment_id FROM webhook_assignments')
    assert 'targetOutsideScope' in (await env.s.get(123,c['endpoint']['id']))['endpoint']['pauseReasons']
    await env.db.conn.execute("UPDATE web_conversation_folders SET parent_uuid='folder' WHERE folder_uuid='child'"); await env.db.conn.commit()
    await env.db.conn.execute('UPDATE web_conversations SET archived_at=1 WHERE conversation_uuid=?',(inside['conversation_uuid'],)); await env.db.conn.commit()
    await env.bridge.dispatch()
    assert not await one(env.db.conn,'SELECT assignment_id FROM webhook_assignments')
    assert 'targetArchived' in (await env.s.get(123,c['endpoint']['id']))['endpoint']['pauseReasons']
    await env.db.conn.execute('UPDATE web_conversations SET archived_at=0 WHERE conversation_uuid=?',(inside['conversation_uuid'],)); await env.db.conn.commit()
    env.server.llm_factory=FakeRunFactory(reporting_backend(env),context_window=128000)
    await env.worker.tick(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller'))
    after=await one(env.db.conn,'SELECT c.model AS main_model,s.thinking_level AS main_thinking_level,s.fast_mode AS main_fast_mode FROM web_conversations c JOIN sessions s ON s.chat_id=c.internal_chat_id WHERE c.conversation_uuid=?',(inside['conversation_uuid'],))
    assert after=={'main_model':'openai/cheap','main_thinking_level':'low','main_fast_mode':0}
    evidence('fixed_target_scope',outsideRejected=True,archivedRejected=True,movedBlocked=True,unchanged=after)


async def test_script_aggregation_key_and_revision_isolation_remain(env):
    code='import json,sys\nx=json.load(sys.stdin)\nprint(json.dumps({"decision":"continue","aggregation_key":x["body"]["group"]}))'
    env.s.bridge=None
    c=await create(env,pre={'enabled':True,'code':code},batching={'idleSeconds':None,'maxWaitSeconds':None})
    await accept(env,c,'{"group":"a"}','a'); await accept(env,c,'{"group":"b"}','b'); await drain_scripts(env)
    rows=await many(env.db.conn,'SELECT revision,aggregation_key FROM webhook_batches')
    assert len(rows)==2 and len({r['aggregation_key'] for r in rows})==2
    cfg=c['endpoint']['config']; cfg['processing']['instructions']='revision two'
    await env.s.update(123,c['endpoint']['id'],{'expectedRevision':1,'requestId':'v2','config':cfg})
    await accept(env,c,'{"group":"a"}','a2'); await drain_scripts(env)
    rows=await many(env.db.conn,'SELECT revision,aggregation_key FROM webhook_batches')
    assert len(rows)==3 and {r['revision'] for r in rows}=={1,2}
    evidence('script_key_preserved',batches=rows)
