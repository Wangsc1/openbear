"""D13 limits change while two real stages are active; no in-flight kill."""
import asyncio
import json
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from app.webhooks import routing
from app.webhooks.repository import one,many
from app.runtime.lifecycle import current_session
from app.llm.events import StreamEvent,ToolCall,Usage
from tests.test_webhooks_backend import env,create,accept
from tests.test_webhooks_controls_matrix import reporting_backend
from tests.test_web_admin import FakeRunFactory,FakeStreamBackend


@pytest.mark.parametrize('stage',['pre','post','model'])
async def test_D13_reduce_active_capacity_without_kill_or_loss(env,stage):
    entered=asyncio.Queue(); releases={}
    async def barrier(key):
        e=releases.setdefault(key,asyncio.Event()); await entered.put(key); await e.wait()
    async def effect(request):
        await barrier(await request.text()); return web.Response(text='done')
    app=web.Application(); app.router.add_post('/',effect); external=TestServer(app); await external.start_server()
    code='import urllib.request,sys,json\nx=json.load(sys.stdin)\nurllib.request.urlopen(urllib.request.Request('+repr(str(external.make_url('/')))+',data=x["actionKey"].encode())).read()\nprint('+repr('{"decision":"skip_model","outcome":"handled"}' if stage=='pre' else '{}')+')'
    conf={'batching':{'enabled':False}}
    if stage!='model': conf[stage]={'enabled':True,'code':code,'timeoutSeconds':30}
    c=await create(env,**conf)
    if stage=='model':
        class Backend(FakeStreamBackend):
            seen=set()
            async def stream(self,messages,**kwargs):
                self.calls+=1; run=current_session().run_id
                yield StreamEvent(kind='usage',usage=Usage(input_tokens=1),details={'providerCostUsd':0.0})
                if run not in self.seen:
                    self.seen.add(run); await barrier(run)
                    events=await many(env.db.conn,'SELECT m.event_id FROM webhook_assignment_events m JOIN webhook_runtime_links l USING(assignment_id) WHERE l.run_id=?',(run,))
                    args={'action':'report','params':{'receiptId':run,'results':[{'eventId':e['event_id'],'outcome':'completed'} for e in events]}}
                    yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('r','Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
                else: yield StreamEvent(kind='finish',finish_reason='stop')
        env.server.llm_factory=FakeRunFactory(Backend(),context_window=128000)
    else: env.server.llm_factory=FakeRunFactory(reporting_backend(env),context_window=128000)
    attr='auto_model_runs' if stage=='model' else stage+'_scripts'; setattr(env.s.config.concurrency,attr,2)
    try:
        for i in range(3):
            await accept(env,c,key=str(i))
            if stage=='post':
                await routing.tick(env.s); await env.bridge.dispatch(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller'))
        await env.worker.tick()
        keys=[await asyncio.wait_for(entered.get(),10) for _ in range(2)]
        async def owned_task(key):
            if stage!='model':
                j=await one(env.db.conn,'SELECT job_id FROM webhook_stage_jobs WHERE action_key=?',(key,)); return env.worker.tasks[j['job_id']]
            a=await one(env.db.conn,'SELECT a.assignment_id FROM webhook_runtime_links l JOIN webhook_assignments a USING(assignment_id) WHERE l.run_id=?',(key,))
            return next(t for t in env.server.runs.scheduler.tasks(kind='controller') if t.get_name()=='webhook-controller:'+a['assignment_id'])
        tasks=[await owned_task(k) for k in keys]
        setattr(env.s.config.concurrency,attr,1); await env.worker.tick()
        assert all(not t.done() for t in tasks) and entered.empty()
        releases[keys[0]].set(); await asyncio.wait_for(tasks[0],10)
        await env.worker.tick(); assert entered.empty() and not tasks[1].done()
        releases[keys[1]].set(); await asyncio.wait_for(tasks[1],10)
        await env.worker.tick(); third=await asyncio.wait_for(entered.get(),10)
        t=await owned_task(third); releases[third].set(); await asyncio.wait_for(t,10)
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_events'))['n']==3
        assert (await one(env.db.conn,"SELECT COUNT(*) n FROM webhook_events WHERE terminal_at_ms IS NOT NULL"))['n']==3
    finally:
        for e in releases.values(): e.set()
        await external.close()
