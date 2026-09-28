"""2026-09-26 live incident: real Agent/Plan/Web paths, deterministic local models."""
import asyncio
import hashlib
import json
import time
from types import SimpleNamespace

import pytest

from app.agents.control import AgentControlService
from app.agents.dao import AgentDAO
from app.agents.execution import AgentExecutor
from app.agents.plan import AgentPlanCoordinator, register_agent_plan_tools
from app.agents.profiles import ensure_builtin_workflows
from app.agents.schemas import AgentDefinition
from app.db.dao import MessageDAO
from app.db.engine import DB
from app.llm.base import AgentResult
from app.llm.events import ToolCall, Usage
from app.tools.agents import AgentTools, register_agent_tools
from app.tools.base import ToolRegistry, ToolRuntimeContext
from app.web_console.auth_api import WebAdminAuthMixin
from app.web_console.live_stream import _WebLiveStream
from tests.test_rath_plan import sample_plan
from tests.test_tools_agent_orchestration import _FakeConfig, _FakeFactory, _FakeSelection


@pytest.fixture
async def incident(tmp_path):
    db = DB(str(tmp_path / 'incident.db'))
    await db.connect()
    dao = AgentDAO(db)
    workflow = await ensure_builtin_workflows(dao)
    manager = AgentControlService(dao)
    try:
        yield db, dao, workflow, manager
    finally:
        tasks = manager.scheduler.tasks(kind='agent')
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await db.close()


async def test_agent_accounting_cannot_deadlock_live_publish_and_authenticated_requests(incident, monkeypatch):
    db, dao, _, manager = incident
    release = asyncio.Event()
    sink_entered = asyncio.Event()
    published = asyncio.Event()
    model_entered = asyncio.Event()
    accounting_entered = asyncio.Event()
    competitors = []

    class Backend:
        protocol = 'chat'
        async def complete(self, *args, **kwargs):
            model_entered.set()
            await release.wait()
            return AgentResult(text='done', usage=Usage(input_tokens=12, output_tokens=4))

    async def sink(event):
        if event.get('competing'):
            sink_entered.set()
            await accounting_entered.wait()
        async with db.write_transaction(label='live-event-persistence') as conn:
            await conn.execute("INSERT OR REPLACE INTO app_state(key,value,updated_at) VALUES('incident-published','yes',0)")
        if event.get('competing'):
            published.set()
        return event

    live = _WebLiveStream('incident', 322, event_sink=sink)
    original = AgentTools._persist_agent_model_call

    async def accounting(self, **kwargs):
        result = await original(self, **kwargs)
        # Force the real inverse interleaving: accounting owns the global writer;
        # a concurrent publisher owns _publish_lock and queues for that writer.
        assert db.conn._owner is asyncio.current_task()
        accounting_entered.set()
        return result

    monkeypatch.setattr(AgentTools, '_persist_agent_model_call', accounting)
    registry = ToolRegistry()
    config = _FakeConfig()
    config.agents = _FakeConfig._Rath()
    config.agents.agent_tool_foreground_wait_s = 0
    register_agent_tools(registry, config=config, dao=dao, manager=manager,
                         llm_factory=_FakeFactory(Backend()), model_selection=_FakeSelection())
    messages = MessageDAO(db)
    await messages.ensure_session(322)
    sid = await messages.get_or_create_session_uuid(322)
    token = 'incident-cookie'
    await db.conn.execute("INSERT INTO web_sessions(session_token_hash,chat_id,created_at,expires_at,last_seen_at,ip,user_agent) VALUES(?,322,0,?,0,'','')",
                          (hashlib.sha256(token.encode()).hexdigest(), int(time.time())+3600))
    await db.conn.commit()

    async def progress(payload):
        await live.publish({'type': 'tool_progress', 'payload': payload})

    launched = json.loads(await registry.dispatch('Agent', json.dumps({'prompt': 'one local request', 'tools': []}),
        context=ToolRuntimeContext(chat_id=322, session_uuid=sid, source='web', progress_update_payload=progress)))
    tid = launched['taskUuid']
    child = manager.task(tid)
    await asyncio.wait_for(model_entered.wait(), 2)
    competitors.append(asyncio.create_task(live.publish({'type': 'status', 'competing': True})))
    await asyncio.wait_for(sink_entered.wait(), 2)
    release.set()
    await asyncio.wait_for(accounting_entered.wait(), 2)
    auth = asyncio.create_task(WebAdminAuthMixin.session_from_request(SimpleNamespace(db=db),
                                 SimpleNamespace(cookies={'openbear_web_session': token})))
    try:
        done, pending = await asyncio.wait({child, auth, *competitors}, timeout=2)
        owner = db.conn._owner
        assert not pending, f'writer owner={owner.get_name() if owner else None}; publishLocked={live._publish_lock.locked()}; authDone={auth.done()}'
        assert (await auth).chat_id == 322
        assert (await dao.get_task(tid)).status == 'completed'
        assert published.is_set()
        calls = await messages.recent_model_calls(322)
        assert len(calls) == 1 and calls[0].status == 'ok'
    finally:
        for task in [child, auth, *competitors]:
            if not task.done():
                task.cancel()
        await asyncio.gather(child, auth, *competitors, return_exceptions=True)


async def test_plan_cancel_ends_registered_executor_without_another_model_call(incident):
    db, dao, workflow, manager = incident
    plan = AgentPlanCoordinator(dao, manager)
    registry = ToolRegistry()
    register_agent_plan_tools(registry, plan)
    notification = asyncio.Event()
    class Backend:
        protocol = 'chat'
        calls = 0
        async def complete(self, *args, **kwargs):
            self.calls += 1
            if self.calls == 1:
                return AgentResult(tool_calls=[ToolCall(id='submit', name='AgentPlanSubmit', arguments=json.dumps({'plan': sample_plan(second_step=False)}))])
            return AgentResult(text='I acknowledge cancellation.')
    backend = Backend()
    tid = await dao.create_task(chat_id=123, workflow_uuid=workflow, title='cancel', input_data={'instruction': 'cancel test'})
    async def notify(_):
        notification.set()
    runner = AgentExecutor(dao, tid, agent=AgentDefinition(workflow_uuid=workflow, agent_key='test', name='Test', tool_allowlist=[]),
        backend=backend, model='fake', max_tokens=256, tools=registry, task_notification=notify,
        plan_protocol_enabled=True, model_call_limit=3)
    child = manager.start(tid, 123, lambda _: runner.run())
    await asyncio.wait_for(notification.wait(), 2)
    await plan.decide(tid, expected_version=1, action='cancel', request_id='cancel-live', reason='stop now')
    done, _ = await asyncio.wait({child}, timeout=2)
    assert child in done and child.cancelled(), f'executor still running or wrong outcome: calls={backend.calls}'
    assert backend.calls == 1
    assert (await dao.get_task(tid)).status == 'cancelled'
    cur = await db.conn.execute('SELECT status FROM runtime_runs WHERE task_uuid=?', (tid,))
    assert (await cur.fetchone())[0] == 'cancelled'
    assert manager.execution_slots_in_use == 0


async def test_request_replan_preserves_structured_required_changes_in_model_context(incident):
    _, dao, workflow, manager = incident
    coordinator = AgentPlanCoordinator(dao, manager)
    tid = await dao.create_task(chat_id=123, workflow_uuid=workflow, title='guidance', status='running')
    await coordinator.submit_plan(tid, sample_plan(second_step=False), request_id='submit', wait_for_decision=False)
    await coordinator.decide(tid, expected_version=1, action='approve', request_id='approve')
    exact = 'Agent live acceptance — replanned'
    issue = 'keep the requested exact title'
    runner = AgentExecutor(dao, tid, agent=AgentDefinition(workflow_uuid=workflow, agent_key='test', name='Test'),
                           backend=object(), model='fake', max_tokens=256, plan_protocol_enabled=True)
    messages = []
    await runner._append_plan_runtime_update(messages)
    await coordinator.decide(tid, expected_version=1, action='request_replan', request_id='replan',
                             reason='change title', issues=[issue], required_changes=[exact])
    await runner._append_plan_runtime_update(messages)
    assert 'mode="delta"' in messages[-1]['content']
    assert exact in messages[-1]['content'] and issue in messages[-1]['content']
    restored = []
    await runner._append_plan_runtime_update(restored, force_full=True)
    assert exact in str(restored) and issue in str(restored)


async def test_agent_stop_cancels_terminal_row_with_residual_coroutine(incident):
    _, dao, workflow, manager = incident
    tid = await dao.create_task(chat_id=123, workflow_uuid=workflow, title='residual', status='running', parent_session_uuid='incident')
    entered = asyncio.Event()
    async def residual():
        entered.set()
        await asyncio.Event().wait()
    child = asyncio.create_task(residual())
    manager.register(tid, 123, child, occupies_chat=False)
    await entered.wait()
    await dao.update_task(tid, status='cancelled', finish=True)
    registry = ToolRegistry()
    register_agent_tools(registry, config=_FakeConfig(), dao=dao, manager=manager,
                         llm_factory=_FakeFactory(), model_selection=_FakeSelection())
    result = json.loads(await registry.dispatch('AgentStop', json.dumps({'to': tid, 'reason': 'cleanup residual'}),
        context=ToolRuntimeContext(chat_id=123, session_uuid='incident', source='web')))
    done, _ = await asyncio.wait({child}, timeout=.2)
    assert child in done and child.cancelled(), result
    assert result['stopped'] is True
    assert (await dao.get_task(tid)).status == 'cancelled'


@pytest.mark.parametrize('waiting_on', ['model', 'tool'])
async def test_stop_interrupts_active_work_and_releases_instance(incident, waiting_on):
    db, dao, workflow, manager = incident
    coordinator = AgentPlanCoordinator(dao, manager)
    registry = ToolRegistry()
    register_agent_plan_tools(registry, coordinator)
    submitted = asyncio.Event()
    active_work = asyncio.Event()
    exited = asyncio.Event()
    never = asyncio.Event()

    async def read(_):
        active_work.set()
        try:
            await never.wait()
        finally:
            exited.set()

    registry.add('Read', 'blocked test tool', {'type': 'object'}, read, visibility={'agent'})
    class Backend:
        protocol = 'chat'
        calls = 0
        async def complete(self, *args, **kwargs):
            self.calls += 1
            if self.calls == 1:
                tool, args = 'AgentPlanSubmit', {'plan': sample_plan(second_step=False)}
            elif waiting_on == 'model':
                active_work.set()
                try:
                    await never.wait()
                finally:
                    exited.set()
            elif self.calls == 2:
                tool, args = 'AgentPlanProgress', {'action': 'start', 'stepId': 's1'}
            else:
                tool, args = 'Read', {}
            return AgentResult(tool_calls=[ToolCall(id=f'call-{self.calls}', name=tool, arguments=json.dumps(args))])

    session = await dao.create_agent_instance(openbear_session_uuid='incident', chat_id=123,
        workflow_uuid=workflow, agent_key='test')
    tid = await dao.create_task(chat_id=123, workflow_uuid=workflow, title='cancel active',
        agent_session_uuid=session.session_uuid, parent_session_uuid='incident',
        input_data={'instruction': 'blocked work', 'agentSnapshot': {'toolAllowlist': ['Read']}})
    async def notify(_):
        submitted.set()
    backend = Backend()
    runner = AgentExecutor(dao, tid, agent=AgentDefinition(workflow_uuid=workflow, agent_key='test', name='Test', tool_allowlist=['Read']),
        backend=backend, model='fake', max_tokens=256, tools=registry, task_notification=notify,
        agent_session_uuid=session.session_uuid, openbear_session_uuid='incident', plan_protocol_enabled=True)
    child = manager.start(tid, 123, lambda _: runner.run())
    await asyncio.wait_for(submitted.wait(), 2)
    await coordinator.decide(tid, expected_version=1, action='approve', request_id='approve-active')
    await asyncio.wait_for(active_work.wait(), 2)
    calls_at_cancel = backend.calls
    await manager.stop(tid, message='stop active work')
    await asyncio.wait_for(exited.wait(), 2)
    await asyncio.gather(child, return_exceptions=True)
    assert child.cancelled() and backend.calls == calls_at_cancel
    assert not (await dao.agent_session(session.session_uuid)).active_task_uuid
    assert (await dao.get_task(tid)).status == 'cancelled'
    assert manager.execution_slots_in_use == 0
    run = await (await db.conn.execute('SELECT run_id,status FROM runtime_runs WHERE task_uuid=?', (tid,))).fetchone()
    assert run['status'] == 'cancelled'
    actions = await (await db.conn.execute('SELECT kind,status FROM runtime_actions WHERE run_id=? ORDER BY rowid', (run['run_id'],))).fetchall()
    assert all(r['status'] != 'started' for r in actions)
    # Cancelling a tool with unknown effect must not turn it into a completed tool.
    if waiting_on == 'tool':
        assert actions[-1]['kind'] == 'tool' and actions[-1]['status'] in {'unknown', 'cancelled'}
