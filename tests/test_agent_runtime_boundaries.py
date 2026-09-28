"""Deterministic Agent execution-boundary regressions; fake model, temp SQLite only."""
from __future__ import annotations

import asyncio
import copy
import json
import re

import pytest

from app.agents.control import AgentControlService
from app.agents.dao import AgentDAO
from app.agents.execution import AgentExecutor, agent_to_snapshot
from app.agents.profiles import ensure_builtin_workflows
from app.agents.schemas import AgentDefinition
from app.db.engine import DB
from app.llm.base import AgentResult
from app.llm.events import ToolCall, Usage
from app.tools.agents import register_agent_tools
from app.tools.base import ToolRegistry, ToolRuntimeContext
from tests.test_tools_agent_orchestration import _FakeConfig, _FakeFactory, _FakeSelection


@pytest.fixture
async def env(tmp_path):
    db = DB(str(tmp_path / "agent-runtime-boundaries.db"))
    await db.connect()
    dao = AgentDAO(db)
    workflow = await ensure_builtin_workflows(dao)
    agent = AgentDefinition(workflow_uuid=workflow, agent_key="review", name="Review",
                            description="boundary checks", system_prompt="", model="openai/gpt",
                            think_level="off", tool_allowlist=["Read"], enabled=True, id=11)
    async def task(*, continued=False):
        task_id = await dao.create_task(chat_id=123, workflow_uuid=workflow,
            title="boundary task", parent_session_uuid="review-session",
            input_data={"instruction": "finish safely", "agentSnapshot": agent_to_snapshot(agent),
                        "planMode": "direct"},
            status="needs_openbear_control" if continued else "queued")
        if continued:
            await dao.create_artifact(task_id, kind="agent_continuation_state", name="safe checkpoint",
                content=json.dumps({"kind": "model", "messages": [{"role": "user", "content": "original task"}],
                                    "roundNo": 0, "pendingToolCalls": []}))
        return task_id
    try:
        yield dao, agent, task
    finally:
        await db.close()


def runner(dao, agent, task_id, backend, reg, **kwargs):
    return AgentExecutor(dao, task_id, agent=agent, backend=backend, model="gpt",
                         max_tokens=512, tools=reg, plan_protocol_enabled=False, **kwargs)


@pytest.mark.parametrize("continued", [False, True])
async def test_final_checkpoint_intervention_is_acknowledged_before_completion(env, monkeypatch, continued):
    dao, agent, make_task = env
    task_id = await make_task(continued=continued)
    seen = []
    class Backend:
        protocol = "chat"
        async def complete(self, messages, **options):
            seen.append(copy.deepcopy(messages))
            control_ids = re.findall(r'<agent-control id="([^"]+)"', str(messages))
            if control_ids and not any(m.get("role") == "tool" and m.get("name") == "AgentControlAck" for m in messages):
                return AgentResult(tool_calls=[ToolCall(id="ack-final", name="AgentControlAck",
                    arguments=json.dumps({"controlUuid": control_ids[-1], "status": "accepted", "reason": "acknowledged"}))],
                    finish_reason="tool_calls", usage=Usage(input_tokens=1))
            return AgentResult(text="final answer", finish_reason="stop", usage=Usage(input_tokens=1))
    backend = Backend()
    reg = ToolRegistry()
    register_agent_tools(reg, config=_FakeConfig(), dao=dao, manager=AgentControlService(dao),
                         llm_factory=_FakeFactory(backend), model_selection=_FakeSelection())
    published = []
    async def on_event(**event):
        published.append(event["kind"])
    execution = runner(dao, agent, task_id, backend, reg, on_event=on_event)
    original = execution._checkpoint_model_context
    injected = []
    async def inject(*args, **kwargs):
        if kwargs.get("stage") == "completed" and not injected:
            injected.append(await AgentControlService(dao).steer(task_id, "new instruction before completion",
                                                                 requested_by="review"))
        return await original(*args, **kwargs)
    monkeypatch.setattr(execution, "_checkpoint_model_context", inject)
    output = await (execution.run_continue() if continued else execution.run())
    assert output["summary"] == "final answer"
    assert len(seen) >= 3
    assert "new instruction before completion" in str(seen[-2]) or "new instruction before completion" in str(seen[-1])
    control = await dao.control(injected[0])
    assert control.responded_at > 0
    assert (await dao.get_task(task_id)).status == "completed"
    await asyncio.sleep(0)
    assert published.count("task_completed") == 1
    with pytest.raises(RuntimeError, match="not active"):
        await dao.add_control(task_id, "steer", message="too late")
    cur = await dao.db.conn.execute("SELECT status FROM runtime_runs WHERE task_uuid=? ORDER BY rowid", (task_id,))
    assert [row[0] for row in await cur.fetchall()] == ["completed"]


@pytest.mark.parametrize("continued", [False, True])
async def test_artifact_failure_cannot_mark_run_completed_or_leave_partial_output(env, monkeypatch, continued):
    dao, agent, make_task = env
    task_id = await make_task(continued=continued)
    class Backend:
        protocol = "chat"
        async def complete(self, messages, **options):
            return AgentResult(text="final answer", finish_reason="stop", usage=Usage(input_tokens=1))
    execution = runner(dao, agent, task_id, Backend(), ToolRegistry())
    async def fail(*args, **kwargs):
        raise OSError("simulated artifact failure")
    monkeypatch.setattr(dao, "create_artifact", fail)
    with pytest.raises(OSError, match="simulated artifact failure"):
        await (execution.run_continue() if continued else execution.run())
    cur = await dao.db.conn.execute("SELECT status FROM runtime_runs WHERE task_uuid=?", (task_id,))
    assert [row[0] for row in await cur.fetchall()] == ["failed"]
    assert (await dao.get_task(task_id)).status != "completed"
    assert not await dao.artifacts(task_id, kind="agent_output")


async def test_new_task_persists_complete_accepted_batch_after_partial_execution(env, monkeypatch):
    dao, agent, make_task = env
    task_id = await make_task()
    executed = []
    class Backend:
        protocol = "chat"
        async def complete(self, messages, **options):
            return AgentResult(tool_calls=[
                ToolCall(id="first", name="Read", arguments='{"path":"first"}'),
                ToolCall(id="second", name="Read", arguments='{"path":"second"}'),
            ], finish_reason="tool_calls", usage=Usage(input_tokens=1))
    reg = ToolRegistry()
    async def read(args):
        executed.append(args["path"])
        return "read-result"
    reg.add("Read", "fake read", {"type": "object", "properties": {"path": {"type": "string"}}},
            read, visibility={"agent"})
    execution = runner(dao, agent, task_id, Backend(), reg)
    original = execution._checkpoint_model_context
    async def interrupt(*args, **kwargs):
        await original(*args, **kwargs)
        if kwargs.get("stage") == "after_tool_result" and args[0][-1].get("tool_call_id") == "first":
            raise RuntimeError("injected partial batch interruption")
    monkeypatch.setattr(execution, "_checkpoint_model_context", interrupt)
    with pytest.raises(RuntimeError, match="partial batch interruption"):
        await execution.run()
    assert executed == ["first"]
    state = (await dao.task_model_context(task_id))["state"]
    assert [call["id"] for call in state["acceptedToolCalls"]] == ["first", "second"]
    assert state["acceptedToolStates"] == [
        {"id": "first", "state": "completed"}, {"id": "second", "state": "not_started"}]
    cur = await dao.db.conn.execute("SELECT status FROM runtime_runs WHERE task_uuid=?", (task_id,))
    assert [row[0] for row in await cur.fetchall()] == ["failed"]


@pytest.mark.parametrize("interruption", ["after_first", "before_second", "before_second_unsaved"])
async def test_two_public_agent_messages_recover_unstarted_call_without_replay(env, monkeypatch, interruption):
    dao, agent, make_task = env
    task_id = await make_task(continued=True)
    executions = []
    calls = []
    class Backend:
        protocol = "chat"
        async def complete(self, messages, **options):
            calls.append(copy.deepcopy(messages))
            pending_controls = re.findall(r'<agent-control id="([^"]+)"', str(messages))
            acknowledged = [m.get("content", "") for m in messages
                            if m.get("role") == "tool" and m.get("name") == "AgentControlAck"]
            if len(pending_controls) > len(acknowledged):
                return AgentResult(tool_calls=[ToolCall(id=f"ack-{len(calls)}", name="AgentControlAck",
                    arguments=json.dumps({"controlUuid": pending_controls[-1], "status": "accepted", "reason": "ack"}))],
                    finish_reason="tool_calls", usage=Usage(input_tokens=1))
            if not any("incomplete tool batch" in str(m.get("content") or "") for m in messages):
                return AgentResult(tool_calls=[
                    ToolCall(id="one", name="Read", arguments='{"path":"first"}'),
                    ToolCall(id="two", name="Read", arguments='{"path":"second"}'),
                ], finish_reason="tool_calls", usage=Usage(input_tokens=1))
            return AgentResult(text="The second accepted call was not started; investigate as instructed.",
                               finish_reason="stop", usage=Usage(input_tokens=1))
    backend = Backend()
    reg = ToolRegistry()
    async def read(args):
        executions.append(args["path"])
        return "read-result:" + args["path"]
    reg.add("Read", "fake read", {"type": "object", "properties": {"path": {"type": "string"}}},
            read, visibility={"agent"})
    manager = AgentControlService(dao)
    register_agent_tools(reg, config=_FakeConfig(), dao=dao, manager=manager,
                         llm_factory=_FakeFactory(backend), model_selection=_FakeSelection())
    original = AgentExecutor._checkpoint_model_context
    fail_once = True
    async def interrupt_after_first_result(self, *args, **kwargs):
        nonlocal fail_once
        second_start = (kwargs.get("stage") == "before_tool_call"
                        and (kwargs.get("extra_state") or {}).get("inflightTool", {}).get("id") == "two")
        if fail_once and interruption == "before_second_unsaved" and second_start:
            fail_once = False
            raise RuntimeError("simulated failure before second tool checkpoint")
        result = await original(self, *args, **kwargs)
        if (fail_once and (
            (interruption == "after_first" and kwargs.get("stage") == "after_tool_result"
             and args[0][-1].get("tool_call_id") == "one")
            or (interruption == "before_second" and second_start)
        )):
            fail_once = False
            raise RuntimeError("simulated interruption at the tool boundary")
        return result
    monkeypatch.setattr(AgentExecutor, "_checkpoint_model_context", interrupt_after_first_result)
    context = ToolRuntimeContext(chat_id=123, session_uuid="review-session", source="chat")
    async def message(text):
        return json.loads(await reg.dispatch("AgentMessage", json.dumps({
            "to": task_id, "message": text, "reasonCode": "user_instruction", "reason": text,
        }), context=context))
    first = await message("first AgentMessage continuation")
    assert first["status"] == "needs_openbear_control", first
    assert first["reason"] == "agent_task_continue_failed"
    assert executions == ["first"], first
    checkpoint = (await dao.task_model_context(task_id))["state"]
    assert checkpoint["acceptedToolStates"] == [
        {"id": "one", "state": "completed"},
        {"id": "two", "state": "unknown" if interruption == "before_second" else "not_started"}]
    model_calls_before_second = len(calls)
    second = await message("second AgentMessage continuation")
    assert executions == ["first"]  # no implicit replay, including unknown effects
    if interruption.startswith("before_second"):
        assert second["status"] == "needs_openbear_control", second
        assert "tool outcome unknown" in second["message"]
        assert len(calls) == model_calls_before_second  # no new provider turn before inspection
        assert (await dao.get_task(task_id)).status == "needs_openbear_control"
    else:
        assert second["status"] == "completed", second
        assert any('"id": "two"' in str(m) and '"state": "not_started"' in str(m)
                   for m in calls[-2:])
        controls = await dao.db.conn.execute(
            "SELECT responded_at FROM rath_task_controls WHERE task_uuid=? AND action='steer' ORDER BY id", (task_id,))
        assert [row[0] > 0 for row in await controls.fetchall()] == [True, True]
        assert len(await dao.artifacts(task_id, kind="agent_output")) == 1
        assert (await dao.get_task(task_id)).status == "completed"


@pytest.mark.parametrize("stage", ["summary", "terminal"])
async def test_final_output_unit_rolls_back_artifact_and_task_on_late_failure(env, monkeypatch, stage):
    dao, agent, make_task = env
    task_id = await make_task()
    class Backend:
        protocol = "chat"
        async def complete(self, messages, **options):
            return AgentResult(text="delivered response", finish_reason="stop", usage=Usage(input_tokens=2))
    execution = runner(dao, agent, task_id, Backend(), ToolRegistry(), agent_session_uuid="legacy-session")
    if stage == "summary":
        async def fail(*args, **kwargs):
            raise OSError("instance projection failed")
        monkeypatch.setattr(dao, "update_agent_session_after_task", fail)
    else:
        original_update = dao.update_task
        async def fail(task_uuid, **kwargs):
            if kwargs.get("status") == "completed":
                raise OSError("task terminal commit failed")
            return await original_update(task_uuid, **kwargs)
        monkeypatch.setattr(dao, "update_task", fail)
    with pytest.raises(OSError):
        await execution.run()
    assert not await dao.artifacts(task_id, kind="agent_output")
    assert (await dao.get_task(task_id)).status == "running"
    cur = await dao.db.conn.execute("SELECT status FROM runtime_runs WHERE task_uuid=?", (task_id,))
    assert [row[0] for row in await cur.fetchall()] == ["failed"]


async def test_control_arriving_during_final_writer_commit_is_explicitly_rejected(env, monkeypatch):
    dao, agent, make_task = env
    task_id = await make_task()
    class Backend:
        protocol = "chat"
        async def complete(self, messages, **options):
            return AgentResult(text="result", finish_reason="stop")
    execution = runner(dao, agent, task_id, Backend(), ToolRegistry())
    entered = asyncio.Event()
    release = asyncio.Event()
    original_create = dao.create_artifact
    async def hold(*args, **kwargs):
        if kwargs.get("kind") == "agent_output":
            entered.set()
            await release.wait()
        return await original_create(*args, **kwargs)
    monkeypatch.setattr(dao, "create_artifact", hold)
    running = asyncio.create_task(execution.run())
    await asyncio.wait_for(entered.wait(), 3)
    late = asyncio.create_task(AgentControlService(dao).steer(task_id, "arrived too late"))
    # The runtime owns the writer during finalization; receipt cannot race past it.
    await asyncio.sleep(0)
    assert not late.done()
    release.set()
    output = await asyncio.wait_for(running, 3)
    assert output["summary"] == "result"
    with pytest.raises(RuntimeError, match="not active"):
        await asyncio.wait_for(late, 3)
    controls = await dao.db.conn.execute("SELECT COUNT(*) FROM rath_task_controls WHERE task_uuid=?", (task_id,))
    assert (await controls.fetchone())[0] == 0
