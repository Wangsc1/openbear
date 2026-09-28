"""Deterministic Agent/Plan launch, cancellation and version-boundary regressions."""
import asyncio
import json
import sqlite3
import uuid

import pytest

from app.agents.control import AgentControlService
from app.agents.dao import AgentDAO
from app.agents.execution import AgentExecutor
from app.llm.base import AgentResult
from app.agents.plan import AgentPlanCoordinator, PlanError
from app.agents.profiles import ensure_builtin_workflows
from app.agents.schemas import AgentDefinition
from app.db.engine import DB
from app.tools.agents import AgentTools
from app.tools.base import ToolRegistry, ToolRuntimeContext
from tests.test_rath_plan import sample_plan
from tests.test_tools_agent_orchestration import _FakeConfig, _FakeFactory, _FakeSelection


@pytest.fixture
async def environment(tmp_path):
    db = DB(str(tmp_path / 'audit.db'))
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


async def test_replan_same_text_as_old_approved_plan_still_requires_new_approval(environment):
    _, dao, workflow, manager = environment
    coordinator = AgentPlanCoordinator(dao, manager)
    tid = await dao.create_task(chat_id=11, workflow_uuid=workflow, title='same content', status='running')
    plan = sample_plan(second_step=False)
    await coordinator.submit_plan(tid, plan, request_id='initial', wait_for_decision=False)
    await coordinator.decide(tid, expected_version=1, action='approve', request_id='approve')
    await coordinator.decide(tid, expected_version=1, action='request_replan',
                             request_id='replan-required', reason='recheck this method')
    result = await coordinator.submit_plan(tid, plan, plan_type='replan',
                                           request_id='new-replan', wait_for_decision=False)
    assert result['status'] == 'pending' and result['planVersion'] == 2
    again = await coordinator.submit_plan(tid, plan, plan_type='replan',
                                          request_id='new-replan', wait_for_decision=False)
    assert again['idempotent'] and again['planVersion'] == 2
    assert (await coordinator.snapshot(tid))['state']['phase'] == 'awaiting_replan_decision'


async def test_agent_message_during_stopping_cannot_leave_unacknowledgeable_receipt(environment):
    _, dao, workflow, manager = environment
    coordinator = AgentPlanCoordinator(dao, manager)
    tid = await dao.create_task(chat_id=11, workflow_uuid=workflow, title='stopping', status='running')
    await dao.update_task(tid, status='stopping', expected_statuses=('running',))
    with pytest.raises(PlanError) as error:
        await coordinator.queue_intervention(tid, message='too late', requested_by='AgentMessage')
    assert error.value.code == 'agent_task_not_messageable'
    assert not await dao.pending_controls(tid)


async def test_reused_plan_decision_request_id_cannot_silently_change_action(environment):
    _, dao, workflow, manager = environment
    coordinator = AgentPlanCoordinator(dao, manager)
    tid = await dao.create_task(chat_id=11, workflow_uuid=workflow, title='request identity', status='running')
    await coordinator.submit_plan(tid, sample_plan(), request_id='submit', wait_for_decision=False)
    await coordinator.decide(tid, expected_version=1, action='approve', request_id='decision')
    assert (await coordinator.decide(tid, expected_version=1, action='approve', request_id='decision'))['idempotent']
    with pytest.raises(PlanError) as error:
        await coordinator.decide(tid, expected_version=1, action='cancel', request_id='decision')
    assert error.value.code == 'request_id_conflict'
    assert (await dao.get_task(tid)).status == 'running'
    assert (await coordinator.snapshot(tid))['state']['phase'] == 'executing'


async def test_registration_exception_cancels_child_and_releases_instance(environment, monkeypatch):
    _, dao, workflow, manager = environment
    instance = await dao.create_agent_instance(openbear_session_uuid='audit', chat_id=11,
                                               workflow_uuid=workflow, agent_key='general-purpose')
    spawned = []
    def reject_registration(tid, chat_id, task, **kwargs):
        spawned.append(task)
        raise RuntimeError('injected registration failure')
    monkeypatch.setattr(manager, 'register', reject_registration)
    registry = ToolRegistry()
    config = _FakeConfig()
    tools = AgentTools(config=config, dao=dao, manager=manager, registry=registry,
                       llm_factory=_FakeFactory(), model_selection=_FakeSelection())
    async def launch(_):
        agent = AgentDefinition(workflow_uuid=workflow, agent_key='general-purpose', name='General')
        return await tools._run_one(agent, instruction='test', title='test', instance=instance)
    registry.add('AuditLaunch', 'test', {'type': 'object'}, launch)
    payload = await registry.dispatch('AuditLaunch', '{}', context=ToolRuntimeContext(chat_id=11, session_uuid='audit'))
    assert payload['status'] == 'failed'
    assert len(spawned) == 1 and spawned[0].done() and spawned[0].cancelled()
    assert (await dao.get_task(payload['task']['taskUuid'])).status == 'failed'
    assert not (await dao.agent_session(instance.session_uuid)).active_task_uuid
    assert manager.execution_slots_in_use == 0


async def test_cancel_during_launch_preparation_closes_queued_instance_and_progress(environment, monkeypatch):
    _, dao, workflow, manager = environment
    instance = await dao.create_agent_instance(openbear_session_uuid='audit', chat_id=11,
                                               workflow_uuid=workflow, agent_key='general-purpose')
    entered, never = asyncio.Event(), asyncio.Event()
    async def blocked_prompt(*args, **kwargs):
        entered.set()
        await never.wait()
    monkeypatch.setattr('app.tools.agents.render_agent_base_system_prompt', blocked_prompt)
    registry = ToolRegistry()
    config = _FakeConfig()
    tools = AgentTools(config=config, dao=dao, manager=manager, registry=registry,
                       llm_factory=_FakeFactory(), model_selection=_FakeSelection())
    async def progress(_):
        pass
    async def launch():
        agent = AgentDefinition(workflow_uuid=workflow, agent_key='general-purpose', name='General')
        return await tools._run_one(agent, instruction='test', title='test', instance=instance)
    registry.add('AuditLaunch', 'test', {'type': 'object'}, lambda _: launch())
    parent = asyncio.create_task(registry.dispatch('AuditLaunch', '{}', context=ToolRuntimeContext(
        chat_id=11, session_uuid='audit', progress_update_payload=progress)))
    await asyncio.wait_for(entered.wait(), 3)
    parent.cancel()
    await asyncio.gather(parent, return_exceptions=True)
    assert parent.cancelled()
    assert not (await dao.agent_session(instance.session_uuid)).active_task_uuid
    tasks = await dao.list_tasks(chat_id=11)
    assert len(tasks) == 1 and tasks[0].status == 'cancelled'
    await asyncio.sleep(0)
    assert not [t for t in asyncio.all_tasks() if not t.done()
                and getattr(t.get_coro(), '__qualname__', '').endswith('._progress_loop')]


@pytest.mark.parametrize('independent', [False, True])
async def test_cancel_between_task_insert_and_creation_receipt_releases_instance(environment, monkeypatch, independent):
    _, dao, workflow, _ = environment
    session = await dao.create_agent_instance(openbear_session_uuid='audit', chat_id=11,
                                              workflow_uuid=workflow, agent_key='general-purpose') if independent else None
    entered = asyncio.Event()
    async def block_created(task_uuid, kind, **kwargs):
        if kind == 'task_created':
            entered.set()
            await asyncio.Event().wait()
        return await original(task_uuid, kind, **kwargs)
    original = dao.append_event
    monkeypatch.setattr(dao, 'append_event', block_created)
    task = asyncio.create_task(dao.create_task(chat_id=11, workflow_uuid=workflow, title='cancel receipt',
                             agent_session_uuid=session.session_uuid if session else ''))
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled()
    rows = await dao.list_tasks(chat_id=11)
    assert len(rows) == 1 and rows[0].status == 'cancelled'
    if session:
        assert not (await dao.agent_session(session.session_uuid)).active_task_uuid


@pytest.mark.parametrize('independent', [False, True])
async def test_cancel_after_real_create_commit_and_again_during_compensation(environment, monkeypatch, independent):
    db, dao, workflow, _ = environment
    session = await dao.create_agent_instance(openbear_session_uuid='audit', chat_id=11,
                                              workflow_uuid=workflow, agent_key='general-purpose') if independent else None
    tid = str(uuid.uuid4())
    committed, cleanup_entered, allow_cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()
    router = db.conn
    if independent:
        target = router._writer
    else:
        target = router
    original_commit = target.commit
    armed = True
    async def committed_then_wait(*args, **kwargs):
        nonlocal armed
        await original_commit(*args, **kwargs)
        if armed:
            armed = False
            committed.set()
            await asyncio.Event().wait()
    monkeypatch.setattr(target, 'commit', committed_then_wait)
    original_update = dao.update_task
    async def pause_compensation(task_uuid, **kwargs):
        if task_uuid == tid and kwargs.get('status') == 'cancelled':
            cleanup_entered.set()
            await allow_cleanup.wait()
        return await original_update(task_uuid, **kwargs)
    monkeypatch.setattr(dao, 'update_task', pause_compensation)
    parent = asyncio.create_task(dao.create_task(chat_id=11, workflow_uuid=workflow,
        title='committed before cancellation', agent_session_uuid=session.session_uuid if session else '',
        task_uuid=tid))
    await asyncio.wait_for(committed.wait(), 2)
    # Separate SQLite connection proves the row is already durable while the
    # original commit-await has not yet returned its task ID to the caller.
    with sqlite3.connect(db.path) as verifier:
        assert verifier.execute('SELECT status FROM rath_tasks WHERE task_uuid=?', (tid,)).fetchone()[0] == 'queued'
        if session:
            assert verifier.execute('SELECT active_task_uuid FROM rath_agent_sessions WHERE session_uuid=?',
                                    (session.session_uuid,)).fetchone()[0] == tid
    parent.cancel()
    await asyncio.wait_for(cleanup_entered.wait(), 2)
    parent.cancel()  # second stop during compensation must not abort settlement
    allow_cleanup.set()
    await asyncio.gather(parent, return_exceptions=True)
    assert parent.cancelled()
    assert (await dao.get_task(tid)).status == 'cancelled'
    if session:
        assert not (await dao.agent_session(session.session_uuid)).active_task_uuid


async def test_task_creation_receipt_exception_releases_instance(environment, monkeypatch):
    _, dao, workflow, _ = environment
    session = await dao.create_agent_instance(openbear_session_uuid='audit', chat_id=11,
                                              workflow_uuid=workflow, agent_key='general-purpose')
    original = dao.append_event
    async def fail_created(task_uuid, kind, **kwargs):
        if kind == 'task_created':
            raise RuntimeError('injected task event failure')
        return await original(task_uuid, kind, **kwargs)
    monkeypatch.setattr(dao, 'append_event', fail_created)
    with pytest.raises(RuntimeError, match='injected task event failure'):
        await dao.create_task(chat_id=11, workflow_uuid=workflow, title='fail receipt',
                              agent_session_uuid=session.session_uuid)
    rows = await dao.list_tasks(chat_id=11)
    assert len(rows) == 1 and rows[0].status == 'failed'
    assert not (await dao.agent_session(session.session_uuid)).active_task_uuid


async def test_duplicate_manager_start_never_launches_unregistered_runner(environment):
    _, dao, workflow, manager = environment
    tid = await dao.create_task(chat_id=11, workflow_uuid=workflow, title='one runner', status='running')
    entered = asyncio.Event()
    async def first(_):
        entered.set()
        await asyncio.Event().wait()
    first_child = manager.start(tid, 11, first)
    await asyncio.wait_for(entered.wait(), 2)
    second_entered = asyncio.Event()
    async def duplicate(_):
        second_entered.set()
    try:
        with pytest.raises(RuntimeError, match='active runner'):
            manager.start(tid, 11, duplicate)
        await asyncio.sleep(0)
        assert not second_entered.is_set()
        assert manager.task(tid) is first_child
        assert (await dao.get_task(tid)).status == 'running'
    finally:
        first_child.cancel()
        await asyncio.gather(first_child, return_exceptions=True)
    assert manager.execution_slots_in_use == 0


async def test_runner_error_after_stop_cannot_reclassify_cancel_as_failure(environment):
    _, dao, workflow, manager = environment
    session = await dao.create_agent_instance(openbear_session_uuid='audit', chat_id=11,
                                              workflow_uuid=workflow, agent_key='general-purpose')
    tid = await dao.create_task(chat_id=11, workflow_uuid=workflow, title='late error',
                                agent_session_uuid=session.session_uuid)
    await dao.update_task(tid, status='stopping', expected_statuses=('queued',))
    tools = AgentTools(config=_FakeConfig(), dao=dao, manager=manager, registry=ToolRegistry(),
                       llm_factory=_FakeFactory(), model_selection=_FakeSelection())
    result = await tools._mark_task_failed(tid, RuntimeError('model returned after stop'))
    assert result.status == 'cancelled'
    assert not (await dao.agent_session(session.session_uuid)).active_task_uuid


async def test_plan_cancel_without_runner_releases_instance_immediately(environment):
    _, dao, workflow, manager = environment
    coordinator = AgentPlanCoordinator(dao, manager)
    session = await dao.create_agent_instance(openbear_session_uuid='audit', chat_id=11,
                                              workflow_uuid=workflow, agent_key='general-purpose')
    tid = await dao.create_task(chat_id=11, workflow_uuid=workflow, title='no runner',
                                agent_session_uuid=session.session_uuid)
    await coordinator.submit_plan(tid, sample_plan(second_step=False), request_id='submit',
                                  wait_for_decision=False)
    await coordinator.decide(tid, expected_version=1, action='cancel', request_id='cancel')
    assert (await dao.get_task(tid)).status == 'cancelled'
    assert not (await dao.agent_session(session.session_uuid)).active_task_uuid


async def test_plan_cancel_retains_instance_until_cancellation_resistant_runner_exits(environment):
    _, dao, workflow, manager = environment
    coordinator = AgentPlanCoordinator(dao, manager)
    session = await dao.create_agent_instance(openbear_session_uuid='audit', chat_id=11,
                                              workflow_uuid=workflow, agent_key='general-purpose')
    tid = await dao.create_task(chat_id=11, workflow_uuid=workflow, title='pending Plan',
                                agent_session_uuid=session.session_uuid)
    await coordinator.submit_plan(tid, sample_plan(second_step=False), request_id='submit',
                                  wait_for_decision=False)
    entered, caught, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def runner(_):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            caught.set()
            await release.wait()
    child = manager.start(tid, 11, runner)
    await asyncio.wait_for(entered.wait(), 2)
    try:
        decision = await coordinator.decide(tid, expected_version=1, action='cancel',
                                            request_id='cancel', reason='stop pending Plan')
        assert decision['phase'] == 'cancelled'
        assert caught.is_set() and not child.done()
        assert (await coordinator.snapshot(tid))['state']['phase'] == 'cancelled'
        assert (await dao.get_task(tid)).status == 'stopping'
        assert (await dao.agent_session(session.session_uuid)).active_task_uuid == tid
        assert manager.execution_slots_in_use == 1
    finally:
        release.set()
        await asyncio.wait_for(child, 2)
    assert (await dao.get_task(tid)).status == 'cancelled'
    assert not (await dao.agent_session(session.session_uuid)).active_task_uuid
    assert manager.execution_slots_in_use == 0


async def test_stop_does_not_release_instance_before_cancellation_resistant_runner_exits(environment):
    _, dao, workflow, manager = environment
    session = await dao.create_agent_instance(openbear_session_uuid='audit', chat_id=11,
                                              workflow_uuid=workflow, agent_key='general-purpose')
    tid = await dao.create_task(chat_id=11, workflow_uuid=workflow, title='delayed cancellation',
                                agent_session_uuid=session.session_uuid)
    entered, caught, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def runner(_):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            caught.set()
            await release.wait()
    child = manager.start(tid, 11, runner)
    await asyncio.wait_for(entered.wait(), 2)
    try:
        await manager.stop(tid)
        await asyncio.wait_for(caught.wait(), 2)
        assert not child.done()
        assert (await dao.get_task(tid)).status == 'stopping'
        assert (await dao.agent_session(session.session_uuid)).active_task_uuid == tid
        assert manager.execution_slots_in_use == 1
    finally:
        release.set()
        await asyncio.wait_for(child, 2)
    assert (await dao.get_task(tid)).status == 'cancelled'
    assert not (await dao.agent_session(session.session_uuid)).active_task_uuid
    assert manager.execution_slots_in_use == 0


async def test_pause_queued_task_waiting_for_slot_does_not_cancel_it(environment):
    _, dao, workflow, _ = environment
    manager = AgentControlService(dao, max_concurrent_tasks=1)
    tid = await dao.create_task(chat_id=11, workflow_uuid=workflow, title='queued pause',
                                input_data={'instruction': 'respond'})
    class Backend:
        protocol = 'chat'
        async def complete(self, *args, **kwargs):
            return AgentResult(text='done')
    executor = AgentExecutor(dao, tid,
        agent=AgentDefinition(workflow_uuid=workflow, agent_key='general-purpose', name='General'),
        backend=Backend(), model='fake', max_tokens=128, poll_interval_s=.01)
    async with manager.execution_slot('occupy-only-slot'):
        child = manager.start(tid, 11, lambda _: executor.run())
        await manager.pause(tid)
        assert (await dao.get_task(tid)).status == 'pausing'
        assert not child.done()
    async def paused():
        while (await dao.get_task(tid)).status != 'paused':
            assert not child.done(), 'queued pause incorrectly cancelled the runner'
            await asyncio.sleep(.01)
    await asyncio.wait_for(paused(), 3)
    await manager.resume(tid)
    await asyncio.wait_for(child, 3)
    assert (await dao.get_task(tid)).status == 'completed'
    assert manager.execution_slots_in_use == 0


async def test_failed_continuation_claim_does_not_start_progress_watcher(environment, monkeypatch):
    _, dao, workflow, manager = environment
    session = await dao.create_agent_instance(openbear_session_uuid='audit', chat_id=11,
                                              workflow_uuid=workflow, agent_key='general-purpose')
    tid = await dao.create_task(chat_id=11, workflow_uuid=workflow, title='needs control',
                                agent_session_uuid=session.session_uuid, parent_session_uuid='audit',
                                input_data={'agentSnapshot': {'agentKey': 'general-purpose', 'name': 'General', 'toolAllowlist': []}},
                                status='needs_openbear_control')
    original = dao.update_task
    async def reject_claim(task_uuid, **kwargs):
        if task_uuid == tid and kwargs.get('status') == 'resuming':
            return False
        return await original(task_uuid, **kwargs)
    monkeypatch.setattr(dao, 'update_task', reject_claim)
    registry = ToolRegistry()
    tools = AgentTools(config=_FakeConfig(), dao=dao, manager=manager, registry=registry,
                       llm_factory=_FakeFactory(), model_selection=_FakeSelection())
    async def progress(_):
        pass
    registry.add('AuditContinue', 'test', {'type': 'object'}, tools.continue_task)
    result = await registry.dispatch('AuditContinue', json.dumps({'taskUuid': tid}), context=ToolRuntimeContext(
        chat_id=11, session_uuid='audit', progress_update_payload=progress))
    assert json.loads(result)['error'] == 'agent_task_continuation_already_claimed'
    await asyncio.sleep(0)
    assert not [t for t in asyncio.all_tasks() if not t.done()
                and getattr(t.get_coro(), '__qualname__', '').endswith('._progress_loop')]
