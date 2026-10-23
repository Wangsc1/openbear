"""Kill only a test-owned child after committed barriers; recover the same DB."""
import asyncio
import json
import os
import select
import signal
import subprocess
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


ROOT=Path(__file__).resolve().parents[1]


class ForkServer:
    """Pre-imported parent (no loop/DB/threads) that forks one child per stage.

    The parent reaps its children and reports ``PID``/``EXIT`` lines; children
    print their own ``READY`` line on the same pipe.
    """
    def __init__(self,stderr_path):
        self.stderr_path=stderr_path; self.stderr=open(stderr_path,'wb')
        self.proc=subprocess.Popen([sys.executable,'-m','tests.webhook_crash_fixture','--fork-server'],cwd=str(ROOT),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.stderr)
        self.fd=self.proc.stdout.fileno(); self.buffer=b''; self.lines=[]; self.spawned=set(); self.exits={}
        # Nothing else is written before the first request, so one buffered
        # readline cannot swallow later lines.
        try:
            if not select.select([self.fd],[],[],60)[0]: raise AssertionError('fork server did not start')
            hello=self.proc.stdout.readline()
            if not hello.startswith(b'HELLO '): raise AssertionError(stderr_path.read_text())
            self.hello=json.loads(hello[6:])
            os.set_blocking(self.fd,False)
        except BaseException:
            self.proc.kill(); self.proc.wait(); self.proc.stdout.close(); self.proc.stdin.close(); self.stderr.close()
            raise

    async def _line(self,match):
        """Return (and consume) the first buffered line satisfying ``match``."""
        loop=asyncio.get_running_loop()
        while True:
            for line in self.lines:
                if match(line): self.lines.remove(line); return line
            readable=loop.create_future()
            loop.add_reader(self.fd,lambda:readable.done() or readable.set_result(None))
            try: await readable
            finally: loop.remove_reader(self.fd)
            try: chunk=os.read(self.fd,65536)
            except BlockingIOError: continue
            if not chunk: raise AssertionError('fork server exited: '+self.stderr_path.read_text())
            self.buffer+=chunk
            *complete,self.buffer=self.buffer.split(b'\n')
            for line in complete:
                if line.startswith(b'EXIT '):
                    _,pid,code=line.split(); self.exits[int(pid)]=int(code)
                self.lines.append(line)

    async def spawn(self,**request):
        self.proc.stdin.write((json.dumps(request)+'\n').encode()); self.proc.stdin.flush()
        pid=int((await self._line(lambda l:l.startswith(b'PID '))).split()[1])
        self.spawned.add(pid); return pid

    async def ready(self,pid):
        line=await self._line(lambda l:(l.startswith(b'READY ') and json.loads(l[6:])['pid']==pid) or l.startswith(f'EXIT {pid} '.encode()))
        return json.loads(line[6:]) if line.startswith(b'READY ') else None

    async def exited(self,pid):
        if pid not in self.exits: await self._line(lambda l:l.startswith(f'EXIT {pid} '.encode()))
        return self.exits[pid]

    def kill(self,pid):
        try: os.killpg(pid,signal.SIGKILL)
        except ProcessLookupError:
            try: os.kill(pid,signal.SIGKILL)  # not yet a session leader
            except ProcessLookupError: pass

    def close(self):
        try:
            try: self.proc.stdin.close()  # EOF: parent SIGKILLs and reaps remaining children
            except OSError: pass
            try: self.proc.wait(10)
            except subprocess.TimeoutExpired: self.proc.kill(); self.proc.wait()
        finally:
            for pid in self.spawned-set(self.exits):
                try: os.killpg(pid,signal.SIGKILL)
                except (ProcessLookupError,PermissionError): pass
            self.proc.stdout.close(); self.stderr.close()


@pytest.fixture(scope='module')
def fork_server(tmp_path_factory):
    server=ForkServer(tmp_path_factory.mktemp('crash-fork')/'fork-server-stderr.txt')
    try:
        # Fork-safety precondition: the pre-imported parent has no extra threads.
        assert server.hello=={'threads':1}
        yield server
    finally: server.close()


@pytest.mark.parametrize('stage',['ingress','pre_reserved','pre_effect','batch_open','batch_sealed','assignment','runtime_bound','model_effect','wait_registered','wait_claimed','wait_delivered','report','closing','post_queued','post_effect','notification_ack'])
async def test_committed_crash_boundaries(env,fork_server,stage):
    actions=[]
    async def effect(request):
        actions.append(await request.text()); return web.Response(text='committed')
    app=web.Application(); app.router.add_post('/effect',effect)
    external=TestServer(app); await external.start_server()
    errors=env.tmp/'child-stderr.txt'
    pid=await fork_server.spawn(path=env.db.path,stage=stage,url=str(external.make_url('/effect')),stderr=str(errors),env=dict(os.environ),cwd=str(ROOT))
    try:
        async with asyncio.timeout(15):
            metadata=await fork_server.ready(pid)
        if metadata is None: raise AssertionError(errors.read_text())
        # The child (own session) is held after the selected COMMIT, with no
        # script left running at these barriers. Kill its owned process group
        # only; the fork parent reaps it and reports the wait status.
        os.killpg(pid,signal.SIGKILL)
        async with asyncio.timeout(5): assert (await fork_server.exited(pid))==-signal.SIGKILL
    finally:
        if pid not in fork_server.exits:
            fork_server.kill(pid)
            async with asyncio.timeout(5): await fork_server.exited(pid)
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
