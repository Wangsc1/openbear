"""Runtime acceptance against the real loop, context store and SQLite writer."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.agent.loop import Agent
from app.context.runtime import WindowRuntime
from app.context.store import ContextOwner, WindowStore
from app.context.window import WindowPolicy, mark_source
from app.db.dao import MessageDAO
from app.db.engine import DB
from app.llm.events import StreamEvent, ToolCall, Usage
from app.runtime.engine import ExecutionRuntime
from app.runtime.lifecycle import RunSession, cancel_execution, current_session
from app.runtime.model_call import AttemptOutcome, PreparedRequest, execute_attempt
from app.runtime.store import RuntimeStore
from app.tools.base import ToolRegistry, ToolRuntimeContext, current_tool_context
from app.web_console.live_stream import _WebDBPersister
from tests.test_agent_loop import RecordRenderer


@pytest.fixture
async def env(tmp_path):
    db = DB(str(tmp_path / "runtime.db"))
    await db.connect()
    dao = MessageDAO(db)
    sid = await dao.get_or_create_session_uuid(17)
    mid = await dao.add(17, "user", "Only test isolated effects.")
    messages = [mark_source({"role": "user", "content": "Only test isolated effects."},
                           kind="human", source_id=f"message:{mid}", message_id=mid)]
    store = WindowStore(db, ContextOwner.controller(chat_id=17, session_uuid=sid))
    window = WindowRuntime(store, WindowPolicy(context_window=128000),
                           backend=SimpleNamespace(protocol="chat"), model="test")
    persister = _WebDBPersister(dao, 17, session_uuid=sid, protocol="chat", model="test")
    persister.window_runtime = window
    try:
        yield SimpleNamespace(db=db, dao=dao, window=window, persister=persister,
                              messages=messages, runtime=RuntimeStore(db))
    finally:
        await db.close()


class ToolBackend:
    protocol = "chat"
    def __init__(self):
        self.calls = 0

    async def stream(self, messages, **options):
        self.calls += 1
        if self.calls == 1:
            yield StreamEvent("tool_call", tool_calls=[ToolCall("effect", "Write", "{}")])
            yield StreamEvent("finish", finish_reason="tool_calls")
        else:
            yield StreamEvent("content", text="done")
            yield StreamEvent("finish", finish_reason="stop")


async def run_controller(env, backend, registry, renderer=None, **kwargs):
    return await Agent(backend, registry).run(env.messages, renderer or RecordRenderer(),
        model="test", window_runtime=env.window, persister=env.persister,
        tool_context=ToolRuntimeContext(chat_id=17), **kwargs)


async def rows(db, table):
    cur = await db.conn.execute(f"SELECT * FROM {table} ORDER BY rowid")
    return [dict(row) for row in await cur.fetchall()]


async def test_controller_uses_shared_engine_and_commits_before_broken_projection(env, monkeypatch):
    seen, effects, projections = [], [], []
    original = ExecutionRuntime.run
    async def spy(self, host, **kwargs):
        seen.append(type(host).__name__)
        return await original(self, host, **kwargs)
    monkeypatch.setattr(ExecutionRuntime, "run", spy)
    reg = ToolRegistry()
    async def write(args):
        # Assistant acceptance and action identity exist before the effect.
        saved = await env.dao.recent(17)
        assert saved[-1].role == "assistant" and saved[-1].tool_calls
        ctx = current_tool_context()
        action = await env.runtime.get_action(ctx.execution_id)
        assert action["status"] == "started" and action["run_id"] == ctx.run_id
        effects.append(1)
        return "raw result"
    reg.add("Write", "test", {}, write)
    class BrokenRenderer(RecordRenderer):
        async def on_tool_start(self, *args):
            raise RuntimeError("display disconnected")
        async def on_tool_result(self, *args):
            actions = await env.runtime.actions(current_session().run_id)
            projections.append((actions[-1]["status"], (await env.dao.recent(17))[-1].content))
            raise RuntimeError("display disconnected")
    backend = ToolBackend()
    result = await run_controller(env, backend, reg, BrokenRenderer())
    assert result.text == "done" and effects == [1] and backend.calls == 2
    assert seen == ["ControllerHost"]
    assert projections == [("completed", "raw result")]
    runs = await rows(env.db, "runtime_runs")
    assert runs[0]["status"] == "completed"
    actions = await env.runtime.actions(runs[0]["run_id"])
    assert [a["kind"] for a in actions] == ["model", "tool", "model"]
    assert actions[0]["outcome"]["usageKnown"] is False
    assert actions[1]["result_ref"].startswith("message:")


async def test_cancelled_tool_stays_unknown_and_never_runs_next_model(env):
    entered = asyncio.Event()
    effects = []
    reg = ToolRegistry()
    async def write(args):
        effects.append(1)
        entered.set()
        await asyncio.Event().wait()
    reg.add("Write", "test", {}, write)
    backend = ToolBackend()
    task = asyncio.create_task(run_controller(env, backend, reg))
    await asyncio.wait_for(entered.wait(), 3)
    assert cancel_execution(task, "acceptance-stop")
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 3)
    runs = await rows(env.db, "runtime_runs")
    assert runs[0]["status"] == "cancelled"
    actions = await env.runtime.actions(runs[0]["run_id"])
    assert actions[-1]["status"] == "unknown" and not actions[-1]["result_ref"]
    await env.runtime.interrupt_open_runs()
    assert effects == [1] and backend.calls == 1
    assert (await env.runtime.get_run(runs[0]["run_id"]))["status"] == "cancelled"


async def test_result_commit_failure_does_not_repeat_effect(env, monkeypatch):
    effects = []
    reg = ToolRegistry()
    async def write(args):
        effects.append(1)
        return "already changed"
    reg.add("Write", "test", {}, write)
    async def fail(**kwargs):
        raise RuntimeError("disk failure")
    monkeypatch.setattr(env.persister, "save_tool_result", fail)
    backend = ToolBackend()
    with pytest.raises(RuntimeError, match="disk failure"):
        await run_controller(env, backend, reg)
    runs = await rows(env.db, "runtime_runs")
    assert runs[0]["status"] == "failed"
    assert (await env.runtime.actions(runs[0]["run_id"]))[-1]["status"] == "unknown"
    assert effects == [1] and backend.calls == 1


async def test_control_received_delivered_and_response_ack_are_separate(env):
    pending = [{"messageUuid": "user-original", "source": "web", "text": "Latest instruction."}]
    def drain():
        result = list(pending)
        pending.clear()
        return result
    class Backend:
        protocol = "chat"
        async def stream(self, messages, **options):
            assert "Latest instruction." in str(messages)
            commands = await rows(env.db, "runtime_commands")
            assert commands[0]["status"] == "delivered"
            assert commands[0]["checkpoint_revision"] > commands[0]["received_checkpoint_revision"]
            yield StreamEvent("content", text="Acknowledged latest instruction.")
            yield StreamEvent("finish", finish_reason="stop")
    await run_controller(env, Backend(), ToolRegistry(), steer_drain=drain)
    commands = await rows(env.db, "runtime_commands")
    assert commands[0]["status"] == "acknowledged"
    assert commands[0]["source_ref"] == "input:user-original"


async def test_attempt_ledger_and_aggregates_rollback_together_then_commit_once(env):
    session = RunSession(env.window)
    outcome = AttemptOutcome(PreparedRequest(None, [], {"model": "test"}))
    outcome.response.usage = Usage(input_tokens=3, output_tokens=2)
    outcome.usage_reported = True
    async def account():
        # Existing DAO methods call commit themselves. They must join the claim.
        await env.dao.add_usage(17, outcome.response.usage, .25)
        await env.dao.add_model_call(17, attempt_id=outcome.attempt_id,
                                    usage_known=True, usage=outcome.response.usage)
    async def body():
        await session.start_attempt(outcome)
        with pytest.raises(RuntimeError, match="rollback"):
            async with session.account_attempt(outcome) as first:
                assert first
                await account()
                raise RuntimeError("rollback")
        assert await rows(env.db, "model_calls") == []
        assert await rows(env.db, "runtime_accounting_claims") == []
        assert (await rows(env.db, "sessions"))[0]["usage_input_tokens"] == 0
        for expected in (True, False):
            async with session.account_attempt(outcome) as first:
                assert first is expected
                if first:
                    await account()
    await session.run(body)
    ledger = await rows(env.db, "model_calls")
    assert len(ledger) == 1 and ledger[0]["attempt_id"] == outcome.attempt_id
    assert ledger[0]["usage_known"] == 1
    assert (await rows(env.db, "sessions"))[0]["usage_input_tokens"] == 3
    assert (await env.runtime.get_action(outcome.attempt_id))["status"] == "completed"


async def test_cancelled_model_closes_transport_and_keeps_reported_usage(env):
    entered = asyncio.Event()
    closed = []
    session = RunSession(env.window)
    class Backend:
        protocol = "chat"
        async def stream(self, messages, **options):
            try:
                yield StreamEvent("usage", usage=Usage(input_tokens=19))
                entered.set()
                await asyncio.Event().wait()
            finally:
                closed.append(True)
    async def settle(outcome):
        await env.dao.add_model_call(17, attempt_id=outcome.attempt_id,
            status=outcome.status, usage_known=outcome.usage_reported, usage=outcome.response.usage)
    task = asyncio.create_task(session.run(lambda: execute_attempt(
        PreparedRequest(Backend(), [], {"model": "test"}), settle=settle)))
    await asyncio.wait_for(entered.wait(), 3)
    cancel_execution(task)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 3)
    assert closed == [True]
    ledger = await rows(env.db, "model_calls")
    assert len(ledger) == 1 and ledger[0]["input_tokens"] == 19
    assert ledger[0]["status"] == "cancelled" and ledger[0]["usage_known"] == 1
    actions = await env.runtime.actions(session.run_id)
    assert actions[0]["status"] == "cancelled" and actions[0]["outcome"]["usageKnown"]


async def test_child_task_does_not_inherit_controller_execution_ownership(env):
    session = RunSession(env.window)
    async def child():
        assert current_session() is None
    async def body():
        assert current_session() is session
        await asyncio.create_task(child())
    await session.run(body)
    assert current_session() is None
