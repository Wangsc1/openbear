"""Real controller physical-call ledger, cross-entry callback, unknown usage."""
import asyncio
import json

import pytest
from app.webhooks.repository import one,many
from app.llm.events import StreamEvent,ToolCall,Usage
from tests.test_web_admin import FakeRunFactory,FakeStreamBackend
from tests.test_webhooks_backend import env,create,accept,drain_scripts


async def test_cross_endpoint_callback_charges_origin_once_and_missing_usage_is_unknown(env):
    row=await env.server._create_web_conversation(123,folder_uuid='folder',title='Shared target')
    marker=env.tmp/'receiver-pre'
    b=await env.s.create(123,{'scope':{'type':'conversation','id':row['conversation_uuid']},'enabled':True,'requestId':'receiver','config':{'processing':{'instructions':'Receiver instructions must not start another model'},'pre':{'enabled':True,'code':'open('+repr(str(marker))+',"a").write("pre\\n")\nprint(\'{"decision":"continue"}\')'},'batching':{'enabled':False}}})
    a=await create(env,target={'mode':'fixedConversation','conversationId':row['conversation_uuid']},batching={'enabled':False})
    initial=await accept(env,a); callbacks=[]
    async def send(args):
        assert not marker.exists()  # A did not run the target's B pre-script.
        r=await env.client.post('/webhook/'+b['endpoint']['id'],json={'kind':'reply'},headers={'Authorization':'Bearer '+b['credential']['key'],'Idempotency-Key':'reply'})
        assert r.status==202; callbacks.append((await r.json())['eventId']); await drain_scripts(env)
        return 'Callback committed'
    env.server.tools.add('Send','Isolated cross-entry callback',{'type':'object'},send)
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if self.calls!=3:
                yield StreamEvent(kind='usage',usage=Usage(input_tokens=10,output_tokens=2,cache_read_tokens=4,cache_write_tokens=1),details={'providerCostUsd':.125})
            if self.calls==1:
                args={'action':'wait','params':{'op':'register','endpointId':b['endpoint']['id'],'requestId':'w','match':{'all':[{'path':'body.kind','op':'eq','value':'reply'}]}}}
            elif self.calls==2:
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('send','Send','{}')]); yield StreamEvent(kind='finish',finish_reason='tool_calls'); return
            elif self.calls==3:
                w=await one(env.db.conn,'SELECT wait_id FROM webhook_waits'); args={'action':'wait','params':{'op':'await','waitId':w['wait_id']}}
            elif self.calls==4:
                args={'action':'report','params':{'receiptId':'all','results':[{'eventId':e,'outcome':'completed'} for e in [initial['eventId'],*callbacks]]}}
            else:
                yield StreamEvent(kind='content',text='Cross-entry complete'); yield StreamEvent(kind='finish',finish_reason='stop'); return
            yield StreamEvent(kind='tool_call',tool_calls=[ToolCall(str(self.calls),'Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    await env.worker.tick(); await asyncio.wait_for(asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller')),10)
    assignment=await one(env.db.conn,'SELECT * FROM webhook_assignments'); assert assignment['origin_endpoint_id']==a['endpoint']['id'] and assignment['terminal_reason']=='normal'
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_assignments'))['n']==1 and marker.read_text()=='pre\n'
    ledger=await many(env.db.conn,"SELECT m.*,a.origin_endpoint_id FROM model_calls m JOIN runtime_actions r ON r.action_id=m.attempt_id JOIN webhook_runtime_links l USING(run_id) JOIN webhook_assignments a USING(assignment_id)")
    assert len(ledger)==backend.calls==5 and len({r['attempt_id'] for r in ledger})==5
    assert {r['origin_endpoint_id'] for r in ledger}=={a['endpoint']['id']}
    unknown=[r for r in ledger if not r['usage_known']]; assert len(unknown)==1 and unknown[0]['cost_usd'] is None
    assert sum(r['cost_usd'] or 0 for r in ledger)==pytest.approx(.5)
    from app.webhooks.queries import usage
    assert (await usage(env.s,env.db.conn,endpoint_id=a['endpoint']['id']))['unknownCostCalls']==1
    assert (await usage(env.s,env.db.conn,endpoint_id=b['endpoint']['id']))['modelCalls']==0
    assert len(await many(env.db.conn,'SELECT * FROM webhook_receipts'))==2
