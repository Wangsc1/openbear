"""A delivered control ack releases the gate, and a stuck ack gate is handed to the controller."""
from __future__ import annotations

import json
import re

import pytest

from app.agents.control import AgentControlService
from app.llm.base import AgentResult
from app.llm.events import ToolCall, Usage
from app.tools.agents import register_agent_tools
from app.tools.base import ToolRegistry
from tests.test_agent_runtime_boundaries import env, runner  # noqa: F401
from tests.test_tools_agent_orchestration import _FakeConfig, _FakeFactory, _FakeSelection

def _registry(dao, backend):
    reg = ToolRegistry()
    register_agent_tools(reg, config=_FakeConfig(), dao=dao, manager=AgentControlService(dao),
                         llm_factory=_FakeFactory(backend), model_selection=_FakeSelection())
    return reg


class _AckingBackend:
    """Acks every delivered control once, then tries a work tool, then finishes."""
    protocol = "chat"

    def __init__(self):
        self.turns = 0

    async def complete(self, messages, **options):
        self.turns += 1
        text = str(messages)
        control_ids = re.findall(r'<agent-control id="([^"]+)"', text)
        acked = {m.get("tool_call_id") for m in messages if m.get("role") == "tool" and m.get("name") == "AgentControlAck"}
        if control_ids and f"ack-{self.turns}" not in acked and "ack-done" not in acked:
            return AgentResult(tool_calls=[ToolCall(id="ack-done", name="AgentControlAck",
                arguments=json.dumps({"controlUuid": control_ids[-1], "status": "accepted"}))],
                finish_reason="tool_calls", usage=Usage(input_tokens=1))
        return AgentResult(text="final answer", finish_reason="stop", usage=Usage(input_tokens=1))


async def _steer_once(execution, dao, task_id, monkeypatch):
    original = execution._checkpoint_model_context
    injected = []
    async def inject(*args, **kwargs):
        if kwargs.get("stage") == "completed" and not injected:
            injected.append(await AgentControlService(dao).steer(task_id, "use the new backup", requested_by="main"))
        return await original(*args, **kwargs)
    monkeypatch.setattr(execution, "_checkpoint_model_context", inject)
    return injected


async def test_ack_releases_the_gate(env, monkeypatch):  # noqa: F811
    dao, agent, make_task = env
    task_id = await make_task()
    backend = _AckingBackend()
    execution = runner(dao, agent, task_id, backend, _registry(dao, backend))
    injected = await _steer_once(execution, dao, task_id, monkeypatch)
    output = await execution.run()
    assert output["summary"] == "final answer"
    assert (await dao.control(injected[0])).responded_at > 0
    assert (await dao.get_task(task_id)).status == "completed"


class _StuckBackend:
    """Keeps trying to finish without ever acknowledging, as a confused model would."""
    protocol = "chat"

    def __init__(self):
        self.turns = 0

    async def complete(self, messages, **options):
        self.turns += 1
        assert self.turns < 20, "gate never handed the task back"
        return AgentResult(text="final answer", finish_reason="stop", usage=Usage(input_tokens=1))


async def test_repeated_ack_gate_is_handed_to_the_controller(env, monkeypatch):  # noqa: F811
    dao, agent, make_task = env
    task_id = await make_task()
    backend = _StuckBackend()
    events = []
    async def on_event(**event):
        events.append((event["kind"], event.get("summary", ""), event.get("detail") or {}))
    execution = runner(dao, agent, task_id, backend, _registry(dao, backend), on_event=on_event)
    await _steer_once(execution, dao, task_id, monkeypatch)
    output = await execution.run()
    assert output["status"] == "needs_openbear_control"
    assert output["reason"] == "agent_gate_repeated"
    assert (await dao.get_task(task_id)).status == "needs_openbear_control"
    corrections = [e for e in events if e[0] == "agent_plan_protocol_corrected"]
    # Wording names the real gate; nothing claims a Plan gate on a direct task.
    assert corrections and all("回执" in summary and "Plan" not in summary for _, summary, _ in corrections)
    assert all(detail["gate"] == "control_ack" for _, _, detail in corrections)
    assert any(kind == "agent_gate_repeated" for kind, _, _ in events)
    assert backend.turns <= 5
