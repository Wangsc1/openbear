"""C01: real owned child and AgentWait adapter cannot be woken by ordinary intake."""
import asyncio
import json
from types import SimpleNamespace
from app.agents.dao import AgentDAO
from app.agents.profiles import ensure_builtin_workflows
from app.agents.schemas import AgentDefinition
from app.agents.execution import AgentExecutor
from app.tools.agents import AgentTools
from app.tools.base import ToolRegistry,current_tool_context
from app.llm.base import AgentResult
from app.llm.events import StreamEvent,ToolCall,Usage
from app.webhooks.repository import one,many
from tests.test_webhooks_backend import env,create,accept
from tests.test_web_admin import FakeRunFactory,FakeStreamBackend


async def test_C01_ordinary_batches_do_not_steer_tool_child_or_agentwait(env):
    dao=AgentDAO(env.db); env.server.agent_dao=dao; workflow=await ensure_builtin_workflows(dao)
    agent=AgentDefinition(workflow_uuid=workflow,agent_key='gate',name='Gate',description='isolated',system_prompt='No external calls',model='openai/gpt',enabled=True,id=7)
    child_entered=asyncio.Event(); child_release=asyncio.Event(); spawn_release=asyncio.Event(); wait_entered=asyncio.Event(); wait_returned=asyncio.Event(); children=[]
    conv=await env.server._create_web_conversation(123,folder_uuid='folder',title='Owned work')
    c=await create(env,batching={'enabled':False},target={'mode':'fixedConversation','conversationId':conv['conversation_uuid']}); initial=await accept(env,c)
    class Child:
        protocol='chat'
        async def complete(self,messages,**kwargs):
            child_entered.set(); await child_release.wait()
            return AgentResult(text='Finished child',usage=Usage(input_tokens=1),provider_cost_usd=0.0,finish_reason='stop')
    async def spawn(args):
        ctx=current_tool_context(); tid=await dao.create_task(chat_id=ctx.chat_id,workflow_uuid=workflow,title='Child',input_data={'instruction':'isolated'},parent_session_uuid=ctx.conversation_uuid,run_root_turn_uuid=ctx.run_root_turn_uuid)
        async def account(detail): await AgentTools._persist_agent_model_call(SimpleNamespace(dao=dao),chat_id=ctx.chat_id,session_uuid=ctx.session_uuid,model_label='openai/gpt',protocol='chat',detail=detail)
        runner=AgentExecutor(dao,tid,agent=agent,backend=Child(),model='gpt',model_label='openai/gpt',max_tokens=1024,tools=ToolRegistry(),on_model_call=account)
        t=asyncio.create_task(runner.run()); children.append(t); t.add_done_callback(lambda _:env.server._web_controller_wake_events[ctx.conversation_uuid].set())
        await child_entered.wait(); await spawn_release.wait(); return 'Spawned owned child'
    async def wait(args):
        ctx=current_tool_context(); wait_entered.set()
        result=await ctx.agent_wait({'mode':'event_only','reviewAfterSeconds':0,'reason':'Wait for actual child'})
        wait_returned.set(); return result
    env.server.tools.add('SpawnGate','Isolated child',{'type':'object'},spawn); env.server.tools.add('WaitGate','Existing host AgentWait',{'type':'object'},wait)
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1; yield StreamEvent(kind='usage',usage=Usage(input_tokens=1),details={'providerCostUsd':0.0})
            if self.calls in (1,2):
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall(str(self.calls),'SpawnGate' if self.calls==1 else 'WaitGate','{}')]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
            elif self.calls==3:
                args={'action':'report','params':{'receiptId':'initial','results':[{'eventId':initial['eventId'],'outcome':'completed'}]}}
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('r','Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
            else: yield StreamEvent(kind='finish',finish_reason='stop')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    try:
        await env.worker.tick(); main=env.server.runs.scheduler.tasks(kind='controller')
        await asyncio.wait_for(child_entered.wait(),5)
        await accept(env,c,key='during-tool-agent'); await env.worker.tick()
        assert backend.calls==1 and len(await many(env.db.conn,'SELECT * FROM webhook_assignments'))==1 and not children[0].done()
        spawn_release.set(); await asyncio.wait_for(wait_entered.wait(),5)
        await accept(env,c,key='during-agentwait'); await env.worker.tick()
        assert backend.calls==2 and not wait_returned.is_set() and len(await many(env.db.conn,'SELECT * FROM webhook_assignments'))==1
        child_release.set(); await asyncio.wait_for(asyncio.gather(*children,*main),15)
        assert wait_returned.is_set() and (await one(env.db.conn,'SELECT terminal_reason FROM webhook_assignments'))['terminal_reason']=='normal'
        assert (await one(env.db.conn,"SELECT COUNT(*) n FROM webhook_events WHERE route_state='batch'"))['n']==2
    finally:
        spawn_release.set(); child_release.set(); await asyncio.gather(*children,return_exceptions=True)


async def test_A13_C05_F19_endpoint_not_chained_and_next_round_current_model(env):
    from tests.test_webhooks_wait_acceptance import held
    from tests.test_web_admin import _login_cookie
    selected=[]
    env.server.model_selection.family_of=lambda label:label.split('/',1)[0]
    original=FakeRunFactory.backend_for
    class TrackingFactory(FakeRunFactory):
        def backend_for(self,fullname): selected.append(fullname); return original(self,fullname)
    # held() uses the real controller with an old frozen system template.
    async with held(env) as (c,a,first,release):
        active=(await one(env.db.conn,'SELECT effective_config_json FROM webhook_runtime_links'))['effective_config_json']
        target=a['conversation_uuid']; ec=await env.s.create(123,{'scope':{'type':'conversation','id':target},'enabled':True,'requestId':'self','config':{'processing':{'instructions':'SELF-ENDPOINT-MUST-NOT-EXECUTE'},'pre':{'enabled':True,'code':'raise AssertionError("self endpoint pre ran")'},'post':{'enabled':True,'code':'raise AssertionError("self endpoint post ran")'}}})
        cookies={'openbear_web_session':await _login_cookie(env)}
        r=await env.client.post('/api/conversations/'+target+'/model',json={'model':'openai/cheap'},cookies=cookies); assert r.status==200
        assert (await one(env.db.conn,'SELECT effective_config_json FROM webhook_runtime_links'))['effective_config_json']==active
        pending=await accept(env,c,key='next-round'); await env.worker.tick()
        assert len(await many(env.db.conn,'SELECT * FROM webhook_assignments'))==1
        release.set()
    # The queued event was received during the prior model, but starts with cheap.
    snapshot=await one(env.db.conn,'SELECT system_snapshot FROM sessions WHERE chat_id=?',(a['internal_chat_id'],))
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            assert 'SELF-ENDPOINT-MUST-NOT-EXECUTE' not in str(messages)
            assert 'trusted runtime provenance' in str(messages)
            if self.calls==1:
                args={'action':'report','params':{'receiptId':'second','results':[{'eventId':pending['eventId'],'outcome':'completed'}]}}
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('r','Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
            else: yield StreamEvent(kind='finish',finish_reason='stop')
    env.server.llm_factory=TrackingFactory(Backend(),context_window=128000)
    await env.worker.tick(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller')); await env.worker.tick()
    assert selected and all(x=='openai/cheap' for x in selected)
    assert not await one(env.db.conn,'SELECT * FROM webhook_stage_jobs WHERE endpoint_id=?',(ec['endpoint']['id'],))
    assert not await one(env.db.conn,'SELECT * FROM webhook_assignments WHERE origin_endpoint_id=?',(ec['endpoint']['id'],))
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_assignments'))['n']==2
    assert await one(env.db.conn,'SELECT system_snapshot FROM sessions WHERE chat_id=?',(a['internal_chat_id'],))==snapshot
