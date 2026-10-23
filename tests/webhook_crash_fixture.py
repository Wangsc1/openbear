"""Isolated child only: READY is a committed crash barrier, never a sleep race.

Run as ``python -m tests.webhook_crash_fixture --fork-server`` to start a
pre-imported parent that never opens a loop, DB or thread; every JSON request
line on stdin forks one fresh session-leader child that runs ``main``.
"""
import asyncio
import json
import os
import select
import signal
import sys
import threading
import traceback
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
        print('READY '+json.dumps({'pid':os.getpid(),'event':event,'assignment':assignment}),flush=True)
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


def _emit(fd,text):
    os.write(fd,(text+'\n').encode())


def _child(request,out):
    """Forked child: own session, request-specific stderr/env, then ``main``."""
    status=1
    try:
        os.setsid()
        err=os.open(request['stderr'],os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o644)
        os.dup2(err,2); os.close(err)
        null=os.open(os.devnull,os.O_RDONLY); os.dup2(null,0); os.close(null)
        os.dup2(out,1)
        os.environ.clear(); os.environ.update(request['env']); os.chdir(request['cwd'])
        asyncio.run(main(request['path'],request['stage'],request['url']))
        status=0
    except BaseException:
        traceback.print_exc(); sys.stderr.flush()
    finally:
        os._exit(status)


def serve():
    """Fork server loop: requests on stdin, PID/EXIT lines and child READY on stdout."""
    out=os.dup(1); children=set()
    _emit(out,'HELLO '+json.dumps({'threads':threading.active_count()}))
    def reap():
        while children:
            try: pid,status=os.waitpid(-1,os.WNOHANG)
            except ChildProcessError: children.clear(); return
            if not pid: return
            children.discard(pid)
            code=-os.WTERMSIG(status) if os.WIFSIGNALED(status) else os.WEXITSTATUS(status)
            _emit(out,f'EXIT {pid} {code}')
    buffer=b''
    try:
        while True:
            readable,_,_=select.select([0],[],[],.02)
            reap()
            if not readable: continue
            chunk=os.read(0,65536)
            if not chunk: return
            buffer+=chunk
            while b'\n' in buffer:
                line,buffer=buffer.split(b'\n',1)
                request=json.loads(line)
                pid=os.fork()
                if pid==0: _child(request,out)
                children.add(pid); _emit(out,f'PID {pid}')
    finally:
        for pid in list(children):
            for kill in (os.killpg,os.kill):
                try: kill(pid,signal.SIGKILL); break
                except ProcessLookupError: pass
        for pid in list(children):
            try: os.waitpid(pid,0)
            except ChildProcessError: pass


if __name__=='__main__':
    if sys.argv[1:]==['--fork-server']: serve()
    else: asyncio.run(main(*sys.argv[1:]))
