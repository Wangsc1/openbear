from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import pytest

from app.agents.control import AgentControlService
from app.agents.execution import agent_to_snapshot
from app.agents.schemas import AgentDefinition
from app.config import ModelsConfig
from app.llm.base import AgentResult, OpenBearLLMError
from app.llm.events import ToolCall
from app.llm.factory import BackendFactory, _BACKEND_CLS
from app.models.agent_runtime import agent_preset_fields, resolve_agent_runtime_config
from app.tools.agents import register_agent_tools
from app.tools.base import ToolRegistry, ToolRuntimeContext
from tests.test_agent_continuity import call
from tests.test_tools_agent_orchestration import _FakeConfig, _FakeSelection, agent_tool_env

OLD = "WorkBuddy/glm-5.3-flash"
NEW = "parrot-gpt/glm-5.3-flash"


@pytest.mark.parametrize("source,expected", [("main", ""), ("conversation", ""), ("preset", OLD), ("snapshot", OLD), (None, OLD)])
def test_legacy_snapshot_recovers_model_intent_without_guessing(source, expected):
    snapshot = {"model": OLD, "thinkLevel": "low", "thinkSource": "model_default"}
    if source:
        snapshot["modelSource"] = source
    assert agent_preset_fields(snapshot) == {"model": expected, "think_level": ""}


@pytest.mark.parametrize("source,expected", [("model_default", ""), ("conversation", ""), ("preset", "low"), (None, "low")])
def test_legacy_snapshot_recovers_thinking_intent(source, expected):
    assert agent_preset_fields({"thinkLevel": "low", "thinkSource": source})["think_level"] == expected


def test_snapshot_separates_explicit_preset_intent_from_effective_runtime():
    agent = AgentDefinition(agent_key="worker", name="worker", model="openai/main", think_level="unsupported")
    resolved = resolve_agent_runtime_config(agent, config=_FakeConfig())
    snapshot = agent_to_snapshot(agent, runtime=resolved)
    assert snapshot["thinkLevel"] == "high"
    assert snapshot["presetThinkLevel"] == "unsupported"
    assert agent_preset_fields(snapshot) == {"model": "openai/main", "think_level": "unsupported"}
    snapshot.update(presetModel="", presetThinkLevel="")
    assert agent_preset_fields(snapshot) == {"model": "", "think_level": ""}


@pytest.fixture
async def model_env(agent_tool_env, monkeypatch, tmp_path):
    dao = agent_tool_env
    config = _FakeConfig()
    config.agents = copy.copy(config.agents)
    config.models = ModelsConfig(primary=OLD, providers={
        channel: {"baseUrl": f"https://{host}.invalid/v1", "apiKey": "fixture-only", "protocol": "responses", "models": [{
            "id": "glm-5.3-flash", "thinkingLevels": ["low", "high"], "defaultThinkingLevel": default,
            "supportsFast": True, "contextWindow": 128000, "maxTokens": 4096,
        }]}
        for channel, host, default in [("WorkBuddy", "workbuddy", "low"), ("parrot-gpt", "parrot", "high")]
    })
    backends, reads = {}, []

    class Backend:
        protocol = "responses"

        def __init__(self, client, base_url, api_key):
            self._base = base_url
            self.calls = []
            self.on_call = None
            backends[base_url] = self

        async def complete(self, messages, *, model, system="", tools=None, **options):
            self.calls.append(copy.deepcopy({"messages": messages, "model": model, "system": system, "tools": tools, **options}))
            if self.on_call:
                await self.on_call()
            # Real completed tool output must survive a channel switch without replay.
            if "workbuddy" in self._base and len(self.calls) == 1:
                return AgentResult(tool_calls=[ToolCall(id="read-once", name="Read", arguments="{}")])
            return AgentResult(text="retained-answer", native_output_items=[{"type": "reasoning", "id": "opaque-old-route"}],
                               reasoning="old-private-reasoning", signature="old-route-signature")

    monkeypatch.setitem(_BACKEND_CLS, "responses", Backend)
    factory = BackendFactory(config.models, client=None)
    registry = ToolRegistry()

    async def read(args):
        reads.append(args)
        return "retained-tool-fact"

    registry.add("Read", "Read", {"type": "object", "properties": {}}, read)
    manager = AgentControlService(dao)
    register_agent_tools(registry, config=config, dao=dao, manager=manager, llm_factory=factory,
                         model_selection=_FakeSelection(), workspace_dir=str(tmp_path))
    handlers = registry._tools["Agent"].handler.__self__
    registry.add("ResumeForTest", "internal resume", {"type": "object"}, handlers.continue_task)
    await dao.db.conn.execute(
        "INSERT INTO web_conversations (conversation_uuid,owner_chat_id,internal_chat_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        ("model-conversation", 123, 123, "test", OLD, 1, 1),
    )
    await dao.db.conn.commit()
    context = ToolRuntimeContext(chat_id=123, session_uuid="model-conversation", conversation_uuid="model-conversation", source="web")
    return SimpleNamespace(dao=dao, reg=registry, config=config, ctx=context, factory=factory, backends=backends, reads=reads)


async def choose_current(x, setting="main"):
    await x.dao.db.conn.execute(
        "UPDATE web_conversations SET model=?,agent_model=?,agent_think_level='high',agent_fast_mode=1 WHERE internal_chat_id=123",
        (NEW, NEW if setting == "agent" else ""),
    )
    await x.dao.db.conn.commit()


@pytest.mark.parametrize("setting", ["main", "agent"])
@pytest.mark.parametrize("legacy", [False, True])
async def test_continue_uses_current_channel_keeps_history_and_freezes_only_new_task(model_env, setting, legacy):
    x = model_env
    if setting == "agent":
        await x.dao.db.conn.execute("UPDATE web_conversations SET agent_model=? WHERE internal_chat_id=123", (OLD,))
        await x.dao.db.conn.commit()
    first = await call(x.reg, "Agent", {"prompt": "retained-original-instruction", "tools": ["Read"]}, x.ctx)
    assert first["status"] == "completed", first
    sid, tid = first["agentSession"]["agentId"], first["task"]["taskId"]
    old_task = await x.dao.get_task(tid)
    old_input, old_output = copy.deepcopy(old_task.input), copy.deepcopy(old_task.output)
    if legacy:
        session = await x.dao.agent_session(sid)
        metadata = copy.deepcopy(session.metadata)
        for key in ("presetModel", "presetThinkLevel"):
            metadata["agentSnapshot"].pop(key)
        await x.dao.db.conn.execute("UPDATE rath_agent_sessions SET metadata_json=? WHERE session_uuid=?", (json.dumps(metadata), sid))
        await x.dao.db.conn.commit()
    await choose_current(x, setting)
    second = await call(x.reg, "AgentContinue", {"to": sid, "prompt": "new-round-instruction", "tools": [], "requestId": "switch-round"}, x.ctx)
    assert second["status"] == "completed", second
    assert second["agentSession"]["agentId"] == sid
    new_tid = second["task"]["taskId"]
    assert new_tid != tid
    task = await x.dao.get_task(new_tid)
    snapshot = task.input["agentSnapshot"]
    assert snapshot["model"] == NEW
    assert snapshot["modelSource"] == ("conversation" if setting == "agent" else "main")
    assert snapshot["presetModel"] == snapshot["presetThinkLevel"] == ""
    assert snapshot["thinkLevel"] == "high" and snapshot["fastMode"] is True
    request = x.backends["https://parrot.invalid/v1"].calls[-1]
    assert request["model"] == "glm-5.3-flash"
    assert request["think_level"] == "high" and request["service_tier"] == "priority"
    text = str(request["messages"])
    for fact in ("retained-original-instruction", "retained-tool-fact", "retained-answer", "new-round-instruction"):
        assert fact in text
    for opaque in ("opaque-old-route", "old-private-reasoning", "old-route-signature"):
        assert opaque not in text
    assert len(x.reads) == 1
    assert not any(tool["name"] == "Read" for tool in (request["tools"] or []))
    events = await x.dao.events(new_tid, limit=100)
    assert any(event.kind == "agent_context_continued" and event.detail["nativeCompatible"] is False for event in events)
    assert any(event.kind == "model_call_started" and event.detail["modelLabel"] == NEW for event in events)
    assert (await x.dao.get_task(tid)).input == old_input
    assert (await x.dao.get_task(tid)).output == old_output
    replay = await call(x.reg, "AgentContinue", {"to": sid, "prompt": "new-round-instruction", "tools": [], "requestId": "switch-round"}, x.ctx)
    assert replay["replayed"] and replay["taskUuid"] == new_tid
    assert len(x.backends["https://parrot.invalid/v1"].calls) == 1


@pytest.mark.parametrize("missing_label", [False, True])
async def test_same_channel_preserves_native_compatibility_only_with_known_label(model_env, missing_label):
    x = model_env
    first = await call(x.reg, "Agent", {"prompt": "keep-fact", "tools": ["Read"]}, x.ctx)
    tid = first["task"]["taskId"]
    if missing_label:
        state = (await x.dao.task_model_context(tid))["state"]
        state.pop("modelLabel")
        await x.dao.db.conn.execute("UPDATE rath_task_model_contexts SET state_json=? WHERE task_uuid=?", (json.dumps(state), tid))
        await x.dao.db.conn.commit()
    second = await call(x.reg, "AgentContinue", {"to": first["agentSession"]["agentId"], "prompt": "next", "tools": ["Read"]}, x.ctx)
    assert second["status"] == "completed", second
    events = await x.dao.events(second["task"]["taskId"], limit=100)
    restored = next(event for event in events if event.kind == "agent_context_continued")
    assert restored.detail["nativeCompatible"] is (not missing_label)
    text = str(x.backends["https://workbuddy.invalid/v1"].calls[-1]["messages"])
    assert "keep-fact" in text and "retained-tool-fact" in text
    if missing_label:
        assert "opaque-old-route" not in text


@pytest.mark.parametrize("legacy", [False, True])
async def test_explicit_preset_stays_explicit_across_new_rounds(model_env, legacy):
    x = model_env
    await x.dao.create_agent(agent_key="fixed", name="fixed", model=OLD, think_level="low", tool_allowlist=["Read"])
    first = await call(x.reg, "Agent", {"workerType": "fixed", "prompt": "preset-fact", "tools": ["Read"]}, x.ctx)
    assert first["status"] == "completed", first
    sid = first["agentSession"]["agentId"]
    if legacy:
        metadata = (await x.dao.agent_session(sid)).metadata
        metadata["agentSnapshot"].pop("presetModel")
        metadata["agentSnapshot"].pop("presetThinkLevel")
        await x.dao.db.conn.execute("UPDATE rath_agent_sessions SET metadata_json=? WHERE session_uuid=?", (json.dumps(metadata), sid))
        await x.dao.db.conn.commit()
    await choose_current(x, "agent")
    second = await call(x.reg, "AgentContinue", {"to": sid, "prompt": "next", "tools": []}, x.ctx)
    assert second["status"] == "completed", second
    snapshot = (await x.dao.get_task(second["task"]["taskId"])).input["agentSnapshot"]
    assert snapshot["model"] == OLD and snapshot["modelSource"] == "preset"
    assert snapshot["thinkLevel"] == "low" and snapshot["thinkSource"] == "preset"
    assert "https://parrot.invalid/v1" not in x.backends


async def test_unfinished_task_resume_stays_on_frozen_channel_and_thinking(model_env):
    x = model_env
    x.config.agents.agent_model_call_limit = 1
    first = await call(x.reg, "Agent", {"prompt": "paused-work", "tools": ["Read"]}, x.ctx)
    assert first["status"] == "needs_openbear_control", first
    tid = first["task"]["taskId"]
    snapshot = copy.deepcopy((await x.dao.get_task(tid)).input["agentSnapshot"])
    await choose_current(x, "agent")
    resumed = await call(x.reg, "ResumeForTest", {"taskUuid": tid, "guidance": "finish existing task"}, x.ctx)
    assert resumed["status"] == "completed", resumed
    assert (await x.dao.get_task(tid)).input["agentSnapshot"] == snapshot
    assert "https://parrot.invalid/v1" not in x.backends
    request = x.backends["https://workbuddy.invalid/v1"].calls[-1]
    assert request["think_level"] == "low" and not request.get("service_tier")
    assert "paused-work" in str(request["messages"])


async def test_retry_does_not_switch_channel_when_defaults_change_mid_request(model_env):
    x = model_env
    backend, _, _ = x.factory.backend_for(OLD)

    async def fail_once():
        backend.on_call = None
        await choose_current(x, "agent")
        raise OpenBearLLMError("temporary upstream error", status=503, retryable=True)

    backend.on_call = fail_once
    result = await call(x.reg, "Agent", {"prompt": "retry-work", "tools": []}, x.ctx)
    assert result["status"] == "completed", result
    assert len(backend.calls) == 2
    assert all(request["think_level"] == "low" for request in backend.calls)
    assert "https://parrot.invalid/v1" not in x.backends
    assert (await x.dao.get_task(result["task"]["taskId"])).input["agentSnapshot"]["model"] == OLD
