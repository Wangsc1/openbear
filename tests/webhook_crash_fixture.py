"""Isolated child only: READY is a committed crash barrier, never a sleep race."""
import asyncio
import json
import sys
from types import SimpleNamespace
from aiohttp import ClientSession
from aiohttp.test_utils import TestClient,TestServer
from app.db.engine import DB
from app.web_admin import WebAdminServer
from app.webhooks.service import WebhookService
from app.webhooks.worker import Worker
from app.webhooks.runtime_bridge import RuntimeBridge
from app.webhooks import routing,waits,receipts
from app.webhooks.repository import one
from app.tools.base import ToolRegistry
from app.tools.webhook import register_webhook_tool
from app.llm.events import StreamEvent,ToolCall
from tests.test_web_admin import _cfg,FakeBot,FakeRunFactory,FakeStreamBackend


async def main(path,stage,url):
    db=DB(path); await db.connect()
    host=WebAdminServer(_cfg(),db,FakeBot()); host.tools=ToolRegistry()
    s=WebhookService(db,config=host.config.webhooks,pepper=b'isolated-only',host=host); host.webhooks=s
    bridge=RuntimeBridge(s,host); worker=Worker(s); register_webhook_tool(host.tools,s)
    host.model_selection=SimpleNamespace(current='openai/gpt')
    async def system(): return 'Frozen isolated system'
    host._build_system_prompt_for_chat=system
    client=TestClient(TestServer(host.make_app())); await client.start_server()
    async def barrier():
        event=await one(db.conn,'SELECT event_id FROM webhook_events ORDER BY receive_seq LIMIT 1')
        assignment=await one(db.conn,'SELECT assignment_id,conversation_uuid,root_turn_uuid FROM webhook_assignments LIMIT 1')
        print('READY '+json.dumps({'event':event,'assignment':assignment}),flush=True)
        await asyncio.Event().wait()
    if stage=='notification_ack':
        async def enqueue(owner,conversation,key,status,**metadata):
            async with ClientSession() as session:
                async with session.post(url,data=key) as response: await response.read()
            await barrier()  # channel accepted stable ID; local outbox ACK absent
        host.browser_push=SimpleNamespace(enqueue=enqueue)
    pre='import sys,json,urllib.request\nx=json.load(sys.stdin)\nurllib.request.urlopen(urllib.request.Request('+repr(url)+',data=x["actionKey"].encode())).read()\nprint(json.dumps({"decision":"continue"}))'
    config={'processing':{'instructions':'Isolated recovery task'},'batching':{'enabled':stage=='batch_open'}}
    if stage in ('ingress','pre_reserved','pre_effect'): config['pre']={'enabled':True,'code':pre}
    if stage in ('post_queued','post_effect'): config['post']={'enabled':True,'code':pre.replace('print(json.dumps({"decision":"continue"}))','print("{}")')}
    created=await s.create(123,{'scope':{'type':'folder','id':'folder'},'enabled':True,'requestId':'crash','config':config})
    eid=created['endpoint']['id']; key=created['credential']['key']
    async def send(body,identity):
        r=await client.post('/webhook/'+eid,json=body,headers={'Authorization':'Bearer '+key,'Idempotency-Key':identity}); assert r.status==202
        return await r.json()
    first=await send({'kind':'start'},'initial')
    if stage=='ingress': await barrier()
    if stage=='pre_reserved':
        async def reserved(*args): await barrier()
        worker.perform=reserved
    if stage in ('pre_effect','post_effect'):
        original_complete=worker.complete
        async def complete(job,*args):
            if job['stage']==('pre' if stage=='pre_effect' else 'post'): await barrier()
            await original_complete(job,*args)
        worker.complete=complete
    if stage in ('batch_open','batch_sealed'):
        await routing.tick(s); await barrier()
    if stage=='assignment': bridge.start_assignment=lambda *args:barrier()
    if stage=='runtime_bound':
        bind=bridge.bind_context
        async def bind_barrier(ctx,**kwargs):
            await bind(ctx,**kwargs); started=ctx.execution_started
            async def started_barrier(session):
                result=await started(session)
                await barrier()
                return result
            ctx.execution_started=started_barrier
        bridge.bind_context=bind_barrier
    original_register=waits.register
    async def register(*args,**kwargs):
        result=await original_register(*args,**kwargs)
        if stage=='wait_registered': await barrier()
        return result
    waits.register=register
    original_delivery=waits.delivery
    async def delivery(*args,**kwargs):
        result=await original_delivery(*args,**kwargs)
        if stage=='wait_delivered' and result and result.get('events'): await barrier()
        return result
    waits.delivery=delivery
    original_report=receipts.report
    async def report(*args,**kwargs):
        result=await original_report(*args,**kwargs)
        if stage=='report': await barrier()
        return result
    receipts.report=report
    original_candidate=receipts.candidate
    async def candidate(*args,**kwargs):
        result=await original_candidate(*args,**kwargs)
        if stage=='closing' and result['action']=='repair': await barrier()
        if stage=='post_queued' and result['action']=='close' and kwargs.get('finalize',True):
            # Candidate close is no longer a completed controller. Kill only
            # after the actual terminal transaction has committed the post job.
            assert await one(db.conn,"SELECT job_id FROM webhook_stage_jobs WHERE stage='post' AND state='pending'")
            assert await one(db.conn,"SELECT assignment_id FROM webhook_assignments WHERE state='finalized'")
            await barrier()
        return result
    receipts.candidate=candidate
    callback=[]
    async def action(args):
        async with ClientSession() as session:
            async with session.post(url,data='model-action') as r: await r.read()
        if stage.startswith('wait_'):
            callback.append((await send({'kind':'reply'},'callback'))['eventId'])
            await routing.tick(s)
            if stage=='wait_claimed': await barrier()
        return 'Externally committed'
    host.tools.add('Action','Isolated action',{'type':'object'},action)
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if stage.startswith('wait_'):
                if self.calls==1: args={'action':'wait','params':{'op':'register','endpointId':eid,'requestId':'w','match':{'all':[{'path':'body.kind','op':'eq','value':'reply'}]}}}
                elif self.calls==2:
                    yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('effect','Action','{}')]); yield StreamEvent(kind='finish',finish_reason='tool_calls'); return
                elif self.calls==3:
                    w=await one(db.conn,'SELECT wait_id FROM webhook_waits'); args={'action':'wait','params':{'op':'await','waitId':w['wait_id']}}
                else: args={'action':'report','params':{'receiptId':'all','results':[{'eventId':e,'outcome':'completed'} for e in [first['eventId'],*callback]]}}
            elif stage=='model_effect':
                if self.calls>1: await barrier()
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('effect','Action','{}')]); yield StreamEvent(kind='finish',finish_reason='tool_calls'); return
            elif stage=='closing' or self.calls>1:
                yield StreamEvent(kind='content',text='Final candidate'); yield StreamEvent(kind='finish',finish_reason='stop'); return
            else: args={'action':'report','params':{'receiptId':'r','results':[{'eventId':first['eventId'],'outcome':'completed'}]}}
            yield StreamEvent(kind='tool_call',tool_calls=[ToolCall(str(self.calls),'Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
    host.llm_factory=FakeRunFactory(Backend(),context_window=128000)
    await worker.tick()
    if worker.tasks: await asyncio.gather(*list(worker.tasks.values()))
    tasks=host.runs.scheduler.tasks(kind='controller')
    if tasks: await asyncio.gather(*tasks)
    await worker.tick()
    if worker.tasks: await asyncio.gather(*list(worker.tasks.values()))
    raise RuntimeError('Crash barrier not reached: '+stage)


if __name__=='__main__': asyncio.run(main(*sys.argv[1:]))
