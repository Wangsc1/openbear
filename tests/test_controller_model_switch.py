"""Conversation model changes use neutral history without borrowing native state."""
from __future__ import annotations

import asyncio
import copy
import json
from types import SimpleNamespace

import pytest

from app.config import ModelsConfig
from app.db.dao import MessageDAO, SummaryDAO
from app.llm.anthropic import _to_anthropic
from app.llm.events import StreamEvent, ToolCall
from app.llm.openai_chat import _to_chat_messages
from app.llm.openai_responses import _to_responses_input
from app.models.selection import ModelSelection
from app.runtime.scheduler import ControllerRuns
from app.tools.base import ToolRegistry
from app.web_admin import _WebStreamRenderer
from tests.test_web_admin import FakeStreamBackend, _login_cookie
from tests.test_web_admin import web_env as web_env

OLD = "source/model-a"
NEW = "target/model-b"
MARKER = "private-state-from-source"
FACT = "the tool already completed exactly once"


def native_turn(protocol, *, tool=False, label=MARKER):
    if protocol == "responses":
        if tool:
            return [{"type": "reasoning", "id": "rs-source", "summary": [], "encrypted_content": label},
                    {"type": "function_call", "id": "fc-source", "call_id": "call-source", "name": "ReadMarker", "arguments": "{}"}]
        return [{"type": "message", "id": label, "content": [{"type": "output_text", "text": "completed"}]}]
    if protocol == "anthropic":
        if tool:
            return [{"type": "thinking", "thinking": "inspect the fact", "signature": label},
                    {"type": "tool_use", "id": "call-source", "name": "ReadMarker", "input": {}}]
        return [{"type": "text", "text": "completed"}]
    return []


def script(protocol, *, tool=False, label=MARKER):
    events = []
    if tool:
        events.append(StreamEvent(kind="reasoning", text="inspect the fact", signature=label if protocol == "anthropic" else ""))
        events.append(StreamEvent(kind="tool_call", tool_calls=[ToolCall("call-source", "ReadMarker", "{}")]))
    else:
        events.append(StreamEvent(kind="content", text="completed"))
    if native := native_turn(protocol, tool=tool, label=label):
        events.append(StreamEvent(kind="native_output_item", native_output_items=native))
    events.append(StreamEvent(kind="finish", finish_reason="tool_calls" if tool else "stop"))
    return events


def wire(protocol, messages):
    if protocol == "responses":
        return _to_responses_input(messages)
    if protocol == "anthropic":
        return _to_anthropic(messages)
    return _to_chat_messages(messages, "fixed system")


async def setup(env, monkeypatch, tmp_path, protocol, target="anthropic"):
    env.server.config.models = ModelsConfig(primary=OLD, providers={
        channel: {"baseUrl": f"https://{channel}.invalid", "apiKey": "fixture", "protocol": kind,
                  "models": [{"id": name, "contextWindow": 128000, "maxTokens": 8192,
                              "thinkingLevels": ["low", "high"], "defaultThinkingLevel": "low"}]}
        for channel, name, kind in [("source", "model-a", protocol), ("target", "model-b", target)]
    })
    env.server.model_selection = ModelSelection(env.server.config.models, tmp_path / "unused.json")
    env.server.runs = ControllerRuns()
    backends = {}

    class Backend(FakeStreamBackend):
        def __init__(self, kind, scripts):
            super().__init__(scripts)
            self.protocol = kind
            self.on_call = None
            self.wires = []

        async def stream(self, messages, **options):
            self.wires.append(copy.deepcopy(wire(self.protocol, messages)))
            if self.on_call:
                await self.on_call()
            async for event in super().stream(messages, **options):
                yield event

    backends[OLD] = Backend(protocol, [script(protocol, tool=True), script(protocol), script(protocol)])
    backends[NEW] = Backend(target, [script(target, label="new-state")])
    env.server.llm_factory = SimpleNamespace(
        backend_for=lambda label: (backends[label], label.split("/", 1)[1], 8192),
        context_window=lambda label: 128000,
    )
    tools, executions = ToolRegistry(), []

    async def read(_args):
        executions.append("read")
        return FACT

    tools.add("ReadMarker", "Read a fact", {"type": "object", "properties": {}}, read)
    env.server.tools = tools

    async def system(**kwargs):
        return "Keep the original instructions and never repeat completed effects."

    monkeypatch.setattr(env.server, "_build_system_prompt_for_chat", system)
    row = await env.server._create_web_conversation(123, title="retain this conversation", model=OLD)
    cookie = {"openbear_web_session": await _login_cookie(env)}
    return SimpleNamespace(env=env, row=row, chat=row["internal_chat_id"], uuid=row["conversation_uuid"],
                           cookie=cookie, backends=backends, executions=executions, turns=0)


async def run(x, text="Keep my original requirements"):
    x.turns += 1
    turn = f"switch-test-{x.turns}"
    row = await x.env.server._conversation_row(123, x.uuid, require=True)
    live = x.env.server._live_for(row)
    await live.publish({"type": "accepted", "turnUuid": turn})
    assert await x.env.server._run_web_turn(x.chat, text, _WebStreamRenderer(live), conversation=row, root_turn_uuid=turn) is True


async def choose(x, label):
    response = await x.env.client.post(f"/api/conversations/{x.uuid}/model", cookies=x.cookie, json={"model": label})
    body = await response.json()
    assert response.status == 200, body
    return body


async def checkpoint(x):
    cur = await x.env.db.conn.execute("SELECT * FROM controller_model_contexts WHERE chat_id=?", (x.chat,))
    row = await cur.fetchone()
    return dict(row) if row else None


async def originals(x):
    cur = await x.env.db.conn.execute("SELECT * FROM messages WHERE chat_id=? ORDER BY id", (x.chat,))
    return [dict(row) for row in await cur.fetchall()]


@pytest.mark.parametrize("protocol", ["responses", "anthropic", "chat"])
@pytest.mark.parametrize("reselect", [False, True])
async def test_unchanged_model_keeps_native_prefix_and_tool_results(web_env, monkeypatch, tmp_path, protocol, reselect):
    x = await setup(web_env, monkeypatch, tmp_path, protocol)
    await run(x)
    saved = await checkpoint(x)
    assert saved is not None
    if reselect:
        assert (await choose(x, OLD))["nextRun"] is False
        assert await checkpoint(x) == saved
    await run(x, "Continue the same conversation")
    request = x.backends[OLD].seen_convos[-1]
    assert request[:len(x.backends[OLD].seen_convos[1])] == x.backends[OLD].seen_convos[1]
    if protocol != "chat":
        assert MARKER in json.dumps(x.backends[OLD].wires[-1])
    assert FACT in json.dumps(x.backends[OLD].wires[-1])
    assert x.executions == ["read"]
    assert (await checkpoint(x))["model_label"] == OLD


@pytest.mark.parametrize("protocol", ["responses", "anthropic", "chat"])
@pytest.mark.parametrize("target", ["responses", "anthropic", "chat"])
async def test_idle_switch_clears_only_private_state_and_preserves_history(web_env, monkeypatch, tmp_path, protocol, target):
    x = await setup(web_env, monkeypatch, tmp_path, protocol, target)
    await run(x)
    saved_rows = await originals(x)
    session = await MessageDAO(web_env.db).current_session_uuid(x.chat)
    before_history = await web_env.server._build_history(x.chat)
    assert await checkpoint(x) is not None
    assert (await choose(x, NEW))["nextRun"] is False
    assert await checkpoint(x) is None
    assert await originals(x) == saved_rows
    assert await MessageDAO(web_env.db).current_session_uuid(x.chat) == session
    assert await web_env.server._build_history(x.chat) == before_history
    await run(x, "Continue with the new model")
    messages = x.backends[NEW].seen_convos[0]
    assert all(not any(key in item for key in ("native_output_items", "reasoning", "signature")) for item in messages)
    outgoing = json.dumps(x.backends[NEW].wires[0])
    assert MARKER not in outgoing and FACT in outgoing and "Keep my original requirements" in outgoing
    assert x.executions == ["read"]
    assert (await checkpoint(x))["model_label"] == NEW
    row = await web_env.server._conversation_row(123, x.uuid, require=True)
    assert row["title"] == "retain this conversation" and row["internal_chat_id"] == x.chat


@pytest.mark.parametrize("target", ["responses", "anthropic"])
async def test_deleted_source_channel_does_not_block_recovery(web_env, monkeypatch, tmp_path, target):
    x = await setup(web_env, monkeypatch, tmp_path, "responses", target)
    await run(x)
    del web_env.server.config.models.providers["source"]
    assert web_env.server.model_selection.family_of(OLD) is None
    await choose(x, NEW)
    await run(x, "Recover the original conversation")
    assert FACT in json.dumps(x.backends[NEW].wires[0])
    assert x.executions == ["read"]
    assert MARKER not in json.dumps(x.backends[NEW].wires[0])


@pytest.mark.parametrize("protocol,target", [("responses", "anthropic"), ("anthropic", "responses")])
@pytest.mark.parametrize("switch_back", [False, True])
async def test_running_switch_preserves_current_chain_until_next_run(web_env, monkeypatch, tmp_path, protocol, target, switch_back):
    x = await setup(web_env, monkeypatch, tmp_path, protocol, target)
    await run(x)
    saved = await checkpoint(x)
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold():
        entered.set()
        await release.wait()

    x.backends[OLD].on_call = hold
    task = asyncio.create_task(run(x, "Finish using the original model"))
    web_env.server.runs.register(x.chat, task)
    try:
        await asyncio.wait_for(entered.wait(), 5)
        before_switch = await checkpoint(x)
        assert MARKER in before_switch["state_json"]
        assert (await choose(x, NEW))["nextRun"] is True
        assert await checkpoint(x) == before_switch
        if switch_back:
            await choose(x, OLD)
            assert await checkpoint(x) == before_switch
        assert not x.backends[NEW].seen_convos
        assert MARKER in json.dumps(x.backends[OLD].wires[-1])
    finally:
        release.set()
        await asyncio.wait_for(task, 10)
    x.backends[OLD].on_call = None
    ended = await checkpoint(x)
    assert ended["model_label"] == saved["model_label"] == OLD
    assert MARKER in ended["state_json"]
    expected = OLD if switch_back else NEW

    async def inspect_next_call():
        current = await checkpoint(x)
        if switch_back:
            assert current and MARKER in current["state_json"]
        else:
            # The old chain is gone; at most this run's own pre-request
            # checkpoint for the new model exists, holding no old signature.
            assert current is None or (current["model_label"] == NEW and MARKER not in current["state_json"]), \
                "old checkpoint must be deleted before the new model request"

    x.backends[expected].on_call = inspect_next_call
    await run(x, "Start the next run")
    assert (MARKER in json.dumps(x.backends[expected].wires[-1])) is switch_back
    assert FACT in json.dumps(x.backends[expected].wires[-1])
    assert x.executions == ["read"]
    assert (await checkpoint(x))["model_label"] == expected


@pytest.mark.parametrize("target", ["responses", "anthropic"])
async def test_legacy_history_without_checkpoint_never_replays_old_signatures(web_env, monkeypatch, tmp_path, target):
    x = await setup(web_env, monkeypatch, tmp_path, "anthropic", target)
    dao = MessageDAO(web_env.db)
    await dao.add(x.chat, "user", "legacy requirement")
    await dao.add(x.chat, "assistant", "legacy answer", reasoning="legacy private reasoning", signature=MARKER)
    before = await originals(x)
    del web_env.server.config.models.providers["source"]
    await choose(x, NEW)
    await run(x, "Continue the legacy conversation")
    messages = x.backends[NEW].seen_convos[0]
    assert all(not any(key in item for key in ("native_output_items", "reasoning", "signature")) for item in messages)
    outgoing = json.dumps(x.backends[NEW].wires[0])
    assert "legacy requirement" in outgoing and "legacy answer" in outgoing and MARKER not in outgoing
    assert (await originals(x))[:len(before)] == before


async def test_switch_keeps_compacted_window_and_does_not_reload_archived_tail(web_env, monkeypatch, tmp_path):
    x = await setup(web_env, monkeypatch, tmp_path, "responses", "anthropic")
    dao = MessageDAO(web_env.db)
    await dao.add(x.chat, "user", "archived-original-not-for-replay")
    last = await dao.add(x.chat, "assistant", "archived-long-result-not-for-replay")
    summaries = SummaryDAO(web_env.db)
    await summaries.add(x.chat, "Selected summary: preserve the user's constraints.", last, 20)
    saved_summary = await summaries.latest(x.chat)
    await run(x)
    before_history = await web_env.server._build_history(x.chat)
    assert "Selected summary" in json.dumps(before_history, default=str)
    await choose(x, NEW)
    assert await web_env.server._build_history(x.chat) == before_history
    assert await summaries.latest(x.chat) == saved_summary
    await run(x, "Continue from the selected window")
    outgoing = json.dumps(x.backends[NEW].wires[0])
    assert "Selected summary" in outgoing and FACT in outgoing
    assert "not-for-replay" not in outgoing
    assert x.executions == ["read"]


@pytest.mark.parametrize("body,status", [
    ({"model": "missing/model"}, 404),
    ({"model": ""}, 400),
    ({"model": "   "}, 400),
    ({"model": None}, 400),
    ({"model": 3}, 400),
    ({}, 400),
    ({"model": NEW, "extra": True}, 400),
])
async def test_invalid_target_does_not_mutate_current_conversation(web_env, monkeypatch, tmp_path, body, status):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    await run(x)
    saved, rows = await checkpoint(x), await originals(x)
    response = await web_env.client.post(f"/api/conversations/{x.uuid}/model", cookies=x.cookie, json=body)
    assert response.status == status
    assert await checkpoint(x) == saved and await originals(x) == rows
    assert (await web_env.server._conversation_row(123, x.uuid, require=True))["model"] == OLD


@pytest.mark.parametrize("protocol", ["responses", "anthropic", "chat"])
async def test_idle_round_trip_does_not_resurrect_old_private_state(web_env, monkeypatch, tmp_path, protocol):
    x = await setup(web_env, monkeypatch, tmp_path, protocol)
    await run(x)
    await choose(x, NEW)
    await run(x, "The other model's contribution")
    before = await originals(x)
    await choose(x, OLD)
    assert await checkpoint(x) is None
    assert await originals(x) == before
    await run(x, "Return to the original model")
    outgoing = json.dumps(x.backends[OLD].wires[-1])
    assert MARKER not in outgoing
    assert FACT in outgoing and "The other model's contribution" in outgoing
    assert x.executions == ["read"]
    assert (await checkpoint(x))["model_label"] == OLD


async def test_switch_is_scoped_to_one_conversation(web_env, monkeypatch, tmp_path):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    await run(x)
    row = await web_env.server._create_web_conversation(123, title="unrelated", model=OLD)
    other = SimpleNamespace(**{**vars(x), "row": row, "chat": row["internal_chat_id"], "uuid": row["conversation_uuid"], "turns": 0})
    await run(other, "Unrelated conversation")
    other_checkpoint, other_history = await checkpoint(other), await originals(other)
    await choose(x, NEW)
    assert await checkpoint(x) is None
    assert await checkpoint(other) == other_checkpoint
    assert await originals(other) == other_history
    assert (await web_env.server._conversation_row(123, other.uuid, require=True))["model"] == OLD
    await run(other, "Continue without switching")
    assert (await checkpoint(other))["model_label"] == OLD


@pytest.mark.parametrize("levels,fast,expected", [
    (["low", "high"], True, "high"),
    (["low"], False, "low"),
    ([], False, "off"),
])
async def test_switch_normalizes_capabilities_without_altering_agent_overrides(web_env, monkeypatch, tmp_path, levels, fast, expected):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    await run(x)
    target = web_env.server.config.models.providers["target"].models[0]
    target.thinking_levels = levels
    target.default_thinking_level = "low" if levels else ""
    target.supports_fast = fast
    dao = MessageDAO(web_env.db)
    await dao.set_thinking_level(x.chat, "high")
    await dao.set_fast_mode(x.chat, True)
    response = await web_env.client.post(f"/api/conversations/{x.uuid}/agent-run-config", cookies=x.cookie,
                                         json={"model": OLD, "thinkLevel": "low", "fastMode": False})
    assert response.status == 200, await response.json()
    body = await choose(x, NEW)
    config = body["runConfig"]
    assert config["effectiveThinkingLevel"] == expected
    assert config["effectiveFastMode"] is fast
    assert config["agentRunConfig"]["model"] == OLD
    assert config["agentRunConfig"]["thinkLevel"] == "low"
    assert config["agentRunConfig"]["fastMode"] is False
    state = await (await web_env.client.get(f"/api/conversations/{x.uuid}/state", cookies=x.cookie)).json()
    assert state["effectiveThinkingLevel"] == expected
    assert state["effectiveFastMode"] is fast
    await run(x, "Continue with compatible settings")
    assert FACT in json.dumps(x.backends[NEW].wires[0])
    assert x.executions == ["read"]


@pytest.mark.parametrize("ending", ["cancel", "error"])
async def test_interrupted_run_can_continue_with_pending_model(web_env, monkeypatch, tmp_path, ending):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    await run(x)
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold():
        entered.set()
        await release.wait()
        raise RuntimeError("simulated upstream failure")

    x.backends[OLD].on_call = hold
    row = await web_env.server._conversation_row(123, x.uuid, require=True)
    live = web_env.server._live_for(row)
    await live.publish({"type": "accepted", "turnUuid": "interrupted"})
    task = asyncio.create_task(web_env.server._run_web_turn(
        x.chat, "Do not lose this interrupted request", _WebStreamRenderer(live),
        conversation=row, root_turn_uuid="interrupted"))
    web_env.server.runs.register(x.chat, task)
    try:
        await asyncio.wait_for(entered.wait(), 5)
        before = await checkpoint(x)
        assert (await choose(x, NEW))["nextRun"] is True
        assert await checkpoint(x) == before
        if ending == "cancel":
            task.cancel()
    finally:
        release.set()
        await asyncio.wait_for(task, 10)
    await run(x, "Recover after interruption")
    outgoing = json.dumps(x.backends[NEW].wires[0])
    assert MARKER not in outgoing
    assert FACT in outgoing and "Do not lose this interrupted request" in outgoing
    assert x.executions == ["read"]
    assert (await checkpoint(x))["model_label"] == NEW


async def test_smaller_target_window_keeps_originals_without_replaying_evicted_history(web_env, monkeypatch, tmp_path):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    dao = MessageDAO(web_env.db)
    await dao.add(x.chat, "user", "Old finished task")
    await dao.add(x.chat, "assistant", "old-large-result: " + "archived evidence " * 5000)
    await run(x)
    assert "old-large-result:" in json.dumps(x.backends[OLD].wires[0])
    before = await originals(x)
    target = web_env.server.config.models.providers["target"].models[0]
    target.context_window = 8000
    target.max_tokens = 512
    web_env.server.llm_factory = SimpleNamespace(
        backend_for=lambda label: (x.backends[label], label.split("/", 1)[1], 512),
        context_window=lambda label: 8000 if label == NEW else 128000,
    )
    await choose(x, NEW)
    await run(x, "Current requirement: preserve this exactly; do not repeat completed tools.")
    outgoing = json.dumps(x.backends[NEW].wires[0])
    assert "Current requirement: preserve this exactly; do not repeat completed tools." in outgoing
    assert "old-large-result:" not in outgoing
    assert MARKER not in outgoing
    assert (await originals(x))[:len(before)] == before
    assert x.executions == ["read"]


async def test_switch_before_first_message_needs_no_native_checkpoint(web_env, monkeypatch, tmp_path):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    assert await checkpoint(x) is None
    await choose(x, NEW)
    await run(x, "First message")
    assert not x.backends[OLD].seen_convos
    assert "First message" in json.dumps(x.backends[NEW].wires[0])
    assert (await checkpoint(x))["model_label"] == NEW
