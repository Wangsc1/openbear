"""Kill only a test-owned child after committed barriers; recover the same DB."""
import asyncio
import json
import os
import signal
import sys
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from app.runtime.store import RuntimeStore
from app.webhooks.repository import one,many
from app.webhooks.recovery import recover_assignment
from app.llm.events import StreamEvent,ToolCall
from tests.test_web_admin import FakeRunFactory,FakeStreamBackend
from tests.test_webhooks_backend import env


@pytest.mark.parametrize('stage',['ingress','pre_reserved','pre_effect','batch_open','batch_sealed','assignment','runtime_bound','model_effect','wait_registered','wait_claimed','wait_delivered','report','closing','post_queued','post_effect','notification_ack'])
async def test_committed_crash_boundaries(env,stage):
    actions=[]
    async def effect(request):
        actions.append(await request.text()); return web.Response(text='committed')
    app=web.Application(); app.router.add_post('/effect',effect)
    external=TestServer(app); await external.start_server()
    errors=env.tmp/'child-stderr.txt'
    with errors.open('wb') as stderr:
        proc=await asyncio.create_subprocess_exec(sys.executable,'-m','tests.webhook_crash_fixture',env.db.path,stage,str(external.make_url('/effect')),cwd=str(Path(__file__).resolve().parents[1]),stdout=asyncio.subprocess.PIPE,stderr=stderr,start_new_session=True)
        try:
            async with asyncio.timeout(15):
                while True:
                    line=await proc.stdout.readline()
                    if not line: raise AssertionError(errors.read_text())
                    if line.startswith(b'READY '): metadata=json.loads(line[6:]); break
            # The child is held after the selected COMMIT, with no script left
            # running at these barriers. Kill/reap its owned process group only.
            os.killpg(proc.pid,signal.SIGKILL); await asyncio.wait_for(proc.wait(),5)
            assert proc.returncode==-signal.SIGKILL
        finally:
            if proc.returncode is None:
                os.killpg(proc.pid,signal.SIGKILL); await proc.wait()
    before=await many(env.db.conn,'SELECT * FROM webhook_batches')
    old_receipts=await many(env.db.conn,'SELECT receipt_id FROM webhook_receipts')
    old_wait=await one(env.db.conn,'SELECT * FROM webhook_waits')
    await RuntimeStore(env.db).interrupt_open_runs()
    from app.services import Services
    from types import SimpleNamespace
    await Services._mark_interrupted_web_runtime_operations(SimpleNamespace(db=env.db,web_admin=env.server))
    await env.worker.recover()
    if stage=='model_effect':
        calls=await many(env.db.conn,'SELECT * FROM model_calls ORDER BY id')
        assert len(calls)==2 and all(not r['usage_known'] and r['cost_usd'] is None for r in calls)
        assert calls[-1]['status']=='unknown' and calls[-1]['input_tokens'] is None
        await env.worker.recover()
        assert (await one(env.db.conn,'SELECT COUNT(*) n FROM model_calls'))['n']==2
    class Backend(FakeStreamBackend):
        async def stream(self,messages,**kwargs):
            self.calls+=1
            if self.calls==1:
                events=await many(env.db.conn,'SELECT event_id FROM webhook_assignment_events WHERE delivered_at_ms IS NOT NULL')
                args={'action':'report','params':{'receiptId':'recovered','results':[{'eventId':e['event_id'],'outcome':'completed'} for e in events]}}
                yield StreamEvent(kind='tool_call',tool_calls=[ToolCall('report','Webhook',json.dumps(args))]); yield StreamEvent(kind='finish',finish_reason='tool_calls')
            else:
                yield StreamEvent(kind='content',text='Recovered unstarted task'); yield StreamEvent(kind='finish',finish_reason='stop')
    backend=Backend(); env.server.llm_factory=FakeRunFactory(backend,context_window=128000)
    if stage=='batch_open':
        assert (await one(env.db.conn,'SELECT idle_deadline_ms FROM webhook_batches'))['idle_deadline_ms']==before[0]['idle_deadline_ms']
        env.s.clock=lambda:before[0]['idle_deadline_ms']
    try:
        for _ in range(3):
            await env.worker.tick()
            if env.worker.tasks: await asyncio.wait_for(asyncio.gather(*list(env.worker.tasks.values())),5)
            tasks=env.server.runs.scheduler.tasks(kind='controller')
            if tasks: await asyncio.wait_for(asyncio.gather(*tasks),5)
        a=await one(env.db.conn,'SELECT * FROM webhook_assignments')
        if stage in ('ingress','pre_reserved','batch_open','batch_sealed','assignment','runtime_bound'):
            assert a['state']=='finalized' and a['terminal_reason']=='normal' and backend.calls==2
            assert len(await many(env.db.conn,'SELECT * FROM web_conversations'))==1
            assert len(await many(env.db.conn,'SELECT * FROM webhook_assignments'))==1
            if metadata['assignment']:
                assert {k:a[k] for k in metadata['assignment']}==metadata['assignment']
            if stage=='runtime_bound':
                assert (await one(env.db.conn,"SELECT COUNT(*) n FROM messages WHERE role='user'"))['n']==1
                runs=await many(env.db.conn,"SELECT lifecycle,status FROM web_operations WHERE op_type='run' ORDER BY id")
                assert len(runs)==2 and runs[0]=={'lifecycle':'terminal','status':'interrupted'} and runs[1]['lifecycle']=='terminal'
            if stage in ('ingress','pre_reserved'): assert len(actions)==1
            if stage=='pre_reserved':
                attempts=await many(env.db.conn,'SELECT state,side_effect_state FROM webhook_stage_attempts ORDER BY attempt_no')
                assert attempts[0]=={'state':'cancelled','side_effect_state':'none'} and len(attempts)==2
        elif stage in ('pre_effect','post_effect'):
            assert backend.calls==0 and len(actions)==1
            job=await one(env.db.conn,'SELECT state FROM webhook_stage_jobs'); assert job['state']=='unknown'
            assert len(await many(env.db.conn,'SELECT * FROM webhook_stage_attempts'))==1
        elif stage=='notification_ack':
            assert backend.calls==0 and a['state']=='finalized'
            notification=await one(env.db.conn,"SELECT * FROM web_task_notifications WHERE kind='webhook-result'")
            assert notification['state']=='paused' and len(actions)==1
            from app.webhooks.notifications import retry as retry_notification
            from aiohttp import ClientSession
            async def enqueue(owner,conversation,key,status,**metadata):
                async with ClientSession() as session:
                    async with session.post(external.make_url('/effect'),data=key) as response: await response.read()
            env.server.browser_push=SimpleNamespace(enqueue=enqueue)
            await retry_notification(env.s,123,a['assignment_id'],{'requestId':'verified-idempotent-channel','expectedVersion':a['row_version']})
            await env.worker.tick()
            assert backend.calls==0 and len(actions)==2 and len(set(actions))==1
            assert (await one(env.db.conn,"SELECT state FROM web_task_notifications WHERE kind='webhook-result'"))['state']=='delivered'
        elif stage=='post_queued':
            assert backend.calls==0 and len(actions)==1
            assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_stage_jobs'))['n']==1
            assert (await one(env.db.conn,'SELECT state FROM webhook_stage_jobs'))['state']=='succeeded'
        else:
            assert backend.calls==0 and a['recovery_state']=='needs_control'
            assert {r['receipt_id'] for r in old_receipts}<={r['receipt_id'] for r in await many(env.db.conn,'SELECT receipt_id FROM webhook_receipts')}
            if old_wait:
                current=await one(env.db.conn,'SELECT * FROM webhook_waits'); assert current['wait_id']==old_wait['wait_id'] and current['delivery_json']==old_wait['delivery_json']
            if stage in ('model_effect','wait_claimed','wait_delivered'): assert actions==['model-action']
            prepared=await recover_assignment(env.s,123,a['assignment_id'],{'prepare':True,'expectedVersion':a['row_version'],'decision':'finalizeInterrupted','reason':'Actual isolated child killed and reaped','evidenceRefs':['test:SIGKILL']})
            result=await recover_assignment(env.s,123,a['assignment_id'],{'confirmationToken':prepared['confirmationToken'],'requestId':'recover'})
            assert result['state']=='finalized'
            await env.worker.tick(); assert backend.calls==0
            assert {r['receipt_id'] for r in old_receipts}<={r['receipt_id'] for r in await many(env.db.conn,'SELECT receipt_id FROM webhook_receipts')}
    finally: await external.close()
