"""Runtime ownership tests, not assertions about obsolete directory names."""
import asyncio
from types import SimpleNamespace

import pytest

from app.agents.control import AgentControlService
from app.runtime.scheduler import ControllerRuns, ExecutionScheduler
from app.runtime.lifecycle import RunSession
from app.runtime.model_call import PreparedRequest, execute_attempt
from app.context.store import ContextOwner, WindowStore
from app.context.runtime import ContextManager
from app.context.window import WindowPolicy
from tests.test_web_admin import web_env as shared_web_env

web_env = shared_web_env


async def test_controller_and_agent_share_owner_but_not_cancellation_or_routing():
    scheduler = ExecutionScheduler(max_concurrent_agents=1)
    controllers = ControllerRuns(scheduler)
    agents = AgentControlService(SimpleNamespace(), scheduler=scheduler)
    root = asyncio.create_task(asyncio.Event().wait())
    child = asyncio.create_task(asyncio.Event().wait())
    controllers.register(42, root)
    agents.register("42", 42, child, occupies_chat=False)
    try:
        assert scheduler.tasks() == [root, child]
        assert controllers.count() == agents.count() == 1
        assert scheduler.routed(42, kind="agent") == []
        assert controllers.task(42) is root and agents.task("42") is child
        assert controllers.cancel(42)
        await asyncio.gather(root, return_exceptions=True)
        assert agents.is_running("42")
        assert scheduler.cancel(scheduler.key("agent", "42"))
        await asyncio.gather(child, return_exceptions=True)
        assert not scheduler.tasks()
    finally:
        await scheduler.cancel_all_and_wait()


async def test_new_controller_does_not_get_unregistered_by_old_done_callback():
    scheduler = ExecutionScheduler()
    controllers = ControllerRuns(scheduler)
    old = asyncio.create_task(asyncio.Event().wait())
    new = asyncio.create_task(asyncio.Event().wait())
    controllers.register(1, old)
    controllers.register(1, new)
    old.cancel()
    await asyncio.gather(old, return_exceptions=True)
    assert controllers.task(1) is new
    await scheduler.cancel_all_and_wait()


async def test_common_capacity_can_be_released_for_plan_and_reacquired():
    scheduler = ExecutionScheduler(max_concurrent_agents=1)
    agents = AgentControlService(SimpleNamespace(), scheduler=scheduler)
    entered = asyncio.Event()
    release = asyncio.Event()

    async def second():
        async with agents.execution_slot("second"):
            entered.set()
            await release.wait()

    async with agents.execution_slot("first"):
        pending = asyncio.create_task(second())
        assert await agents.release_execution_slot("first")
        await asyncio.wait_for(entered.wait(), 1)
        assert scheduler.slots_in_use == 1
        release.set()
        await pending
        assert await agents.acquire_execution_slot("first")
        assert agents.execution_slot_held("first")
    assert scheduler.slots_in_use == 0
    assert scheduler.lease(scheduler.key("agent", "first")) is None


async def test_real_web_construction_uses_one_scheduler(web_env):
    server = web_env.server
    assert server.runs.scheduler is server.runtime
    assert server.agents.scheduler is server.runtime


@pytest.mark.parametrize("cancelled", [False, True])
async def test_preflight_failure_is_recorded_not_started_without_provider_call(tmp_path, cancelled):
    from app.db.engine import DB
    db = DB(str(tmp_path / "preflight.db"))
    await db.connect()
    calls = []

    class Backend:
        async def complete(self, *args, **kwargs):
            calls.append(kwargs)
            raise AssertionError("provider must not run")

    async def fail(outcome):
        if cancelled:
            raise asyncio.CancelledError()
        raise ValueError("preflight persistence failed")

    try:
        runtime = ContextManager(WindowStore(db, ContextOwner.agent(task_uuid="preflight")),
                                 WindowPolicy(10000), backend=Backend(), model="test")
        session = RunSession(runtime, task_uuid="preflight")
        async def body():
            return await execute_attempt(PreparedRequest(Backend(), [], {"model": "test"}), on_start=fail)
        with pytest.raises(asyncio.CancelledError if cancelled else ValueError):
            await session.run(body)
        assert calls == []
        actions = await session.store.actions(session.run_id)
        assert len(actions) == 1 and actions[0]["status"] == "not_started"
        cur = await db.conn.execute("SELECT COUNT(*) FROM runtime_accounting_claims")
        assert (await cur.fetchone())[0] == 0
    finally:
        await db.close()
