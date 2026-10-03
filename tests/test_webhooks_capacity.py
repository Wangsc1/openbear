"""Actual 500-event burst through bounded pre/model/post queues, no live providers."""
import asyncio
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from app.webhooks.repository import one,many
from app.llm.events import StreamEvent,ToolCall,Usage
from app.runtime.lifecycle import current_session
from tests.test_web_admin import FakeRunFactory,FakeStreamBackend
from tests.test_webhooks_backend import env,create,accept


@pytest.mark.parametrize('local',[False,True])
async def test_bounded_actual_processes_models_and_post(env,local):
    env.s.config.concurrency.pre_scripts=4; env.s.config.concurrency.post_scripts=2; env.s.config.concurrency.auto_model_runs=2
    active={'pre':0,'post':0,'model':0}; peaks=dict(active); totals=dict(active)
    release={k:asyncio.Event() for k in active}; full={k:asyncio.Event() for k in active}
    limits={'pre':2 if local else 4,'post':1 if local else 2,'model':1 if local else 2}
    async def effect(request):
        phase=request.match_info['phase']; active[phase]+=1; totals[phase]+=1; peaks[phase]=max(peaks[phase],active[phase])
        if active[phase]>=limits[phase]: full[phase].set()
        try: await release[phase].wait(); return web.Response(text='done')
        finally: active[phase]-=1
    app=web.Application(); app.router.add_post('/{phase}',effect); external=TestServer(app); await external.start_server()
    pre='import urllib.request,json,sys\nx=json.load(sys.stdin)\nurllib.request.urlopen(urllib.request.Request('+repr(str(external.make_url('/pre')))+',data=x["actionKey"].encode())).read()\nprint(json.dumps({"decision":"continue"}))'
    post=pre.replace(str(external.make_url('/pre')),str(external.make_url('/post'))).replace('print(json.dumps({"decision":"continue"}))','print("{}")')
    # Disable time triggers: this scenario verifies count/capacity, not elapsed
    # wall-time. 500 logical jobs still spawn 500 bounded real child processes.
    c=await create(env,pre={'enabled':True,'code':pre,'timeoutSeconds':300},post={'enabled':True,'code':post,'timeoutSeconds':300},batching={'idleSeconds':None,'maxWaitSeconds':None,'maxEvents':100},limits={'preConcurrency':limits['pre'],'postConcurrency':limits['post'],'autoModelConcurrency':limits['model']})
    n=120 if local else 500
    if local:
        await env.s.update(123,c['endpoint']['id'],{'expectedRevision':1,'requestId':'local-batches','config':{**c['endpoint']['config'],'batching':{'idleSeconds':None,'maxWaitSeconds':None,'maxEvents':20}}})
    class Backend(FakeStreamBackend):
        seen=set()
        async def stream(self,messages,**kwargs):
            self.calls+=1; run=current_session().run_id
            yield StreamEvent(kind='usage',usage=Usage(input_tokens=10,output_tokens=1),details={'providerCostUsd':0.0})
            if run not in self.seen:
                self.seen.add(run); active['model']+=1; totals['model']+=1; peaks['model']=max(peaks['model'],active['model'])
                if active['model']>=limits['model']: full['model'].set()
                try: await release['model'].wait()
                finally: active['model']-=1
                events=await many(env.db.conn,'SELECT m.event_id FROM webhook_assignment_events m JOIN webhook_runtime_links l USING(assignment_id) WHERE l.run_id=?',(run,))
                args={'action':'report','params':{'receiptId':'all','results':[{'eventId':e['event_id'],'outcome':'completed'} for e in events]}}
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('report','Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
            else:
                yield StreamEvent(kind='content',text='Batch complete'); yield StreamEvent(kind='finish',finish_reason='stop')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    async def pump():
        # Each wake is actual completion/discovery, never a timed fault race.
        while True:
            env.s.wake.clear(); await env.worker.tick()
            unfinished=await one(env.db.conn,"SELECT COUNT(*) n FROM webhook_events WHERE terminal_at_ms IS NULL")
            jobs=await one(env.db.conn,"SELECT COUNT(*) n FROM webhook_stage_jobs WHERE state IN ('pending','running')")
            if unfinished['n']==0 and jobs['n']==0: return
            await env.s.wake.wait()
    task=None
    try:
        for i in range(n): await accept(env,c,'{}',str(i))
        assert not await many(env.db.conn,'SELECT * FROM web_conversations')
        task=asyncio.create_task(pump())
        await asyncio.wait_for(full['pre'].wait(),15)
        assert (await one(env.db.conn,"SELECT COUNT(*) n FROM webhook_stage_jobs WHERE state='running' AND stage='pre'"))['n']==limits['pre']
        release['pre'].set()
        await asyncio.wait_for(full['model'].wait(),120)
        assert len(env.bridge.active)==limits['model']
        release['model'].set()
        await asyncio.wait_for(full['post'].wait(),120); release['post'].set()
        await asyncio.wait_for(task,180)
        assert peaks==limits and totals=={'pre':n,'model':6 if local else 5,'post':6 if local else 5}
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_receipts'))['n']==n
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_stage_attempts'))['n']==n+totals['post']
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM web_conversations'))['n']==totals['model']
        assert not await many(env.db.conn,"SELECT * FROM webhook_stage_jobs WHERE state!='succeeded'")
    finally:
        for e in release.values(): e.set()
        if task and not task.done(): task.cancel(); await asyncio.gather(task,return_exceptions=True)
        await external.close()
