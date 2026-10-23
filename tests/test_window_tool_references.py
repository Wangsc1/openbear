"""Seen tool bodies are replaceable; instructions and protocol shells are not."""
from __future__ import annotations

import copy
import json

import pytest

from app.agent.native_continuation import validate_model_context
from app.context.runtime import ContextManager
from app.context.store import ContextOwner, WindowStore
from app.context.strategies import CompressionRequest, SlidingWindowStrategy
from app.context.window import (
    RequiredContextTooLarge, WindowPolicy, estimate_request, mark_source,
    protocol_groups, required_context_groups, select_window, source_of,
)
from app.llm.events import ToolCall
from app.tools.agent_history import query_execution_history
from tests.test_context_window import db as shared_db

db = shared_db


def msg(role, content, identity, kind="execution", **extra):
    return mark_source({"role": role, "content": content, **extra}, kind=kind,
                       source_id=identity, run_root_turn_uuid="root", task_uuid="task")


def batch(index, *specs, text="Checking these facts."):
    calls = [ToolCall(f"call:{index}:{n}", name, arguments) for n, (name, arguments, body) in enumerate(specs)]
    return [msg("assistant", text, f"assistant:{index}", tool_calls=calls),
            *[msg("tool", body, f"result:{index}:{n}", tool_call_id=call.id, name=call.name)
              for n, (call, (_, _, body)) in enumerate(zip(calls, specs))]]


def cost(messages):
    return estimate_request(messages, system="system", tools=[], backend=None)


def select(messages, ceiling=12_000, **kwargs):
    return select_window(messages, estimate=cost, target=2000, input_ceiling=ceiling,
                         active_run_root_turn_uuid="root", **kwargs)


def refs(selection):
    return [m for m in selection.messages if source_of(m).get("tool_result_reference")]


@pytest.mark.parametrize("agent", [False, True])
def test_anchor_preserves_text_calls_and_pairs_but_not_large_seen_bodies(agent):
    older = batch(0, ("Read", "{}", "证据" * 15000), ("Bash", "{}", "细节" * 10000))
    control = msg("user", "Only inspect; do not deploy.", "control", kind="control")
    latest = batch(1, ("Read", "{}", "new"), text="Read the next file.")
    messages = [msg("user", "Original task", "input", kind="task" if agent else "human"), *older, control, *latest]
    original = copy.deepcopy(messages)
    selected = select(messages, active_task_uuid="task" if agent else "")
    assert len(refs(selected)) == 2
    assert selected.referenced_results == 2 and selected.changed
    assert older[0] in selected.messages and control in selected.messages
    assert all(m in selected.messages for m in latest)
    for result in refs(selected):
        meta = source_of(result)
        assert meta["id"].startswith(meta["derived_from"] + "/tool-reference:")
        assert meta["message_id"] == 0 and meta["reference_only"] is False
        assert 'original size=' in result['content'] and 'tool_call_id=' in result['content']
        assert ("AgentHistory" if agent else "History") in result["content"]
        if not agent:
            assert '"source":"execution"' in result["content"]
    assert validate_model_context(selected.messages)
    assert messages == original
    assert select(messages, active_task_uuid="task" if agent else "").messages == selected.messages


def test_recent_floor_can_reference_penultimate_parallel_results_oldest_first():
    old = batch(0, ("Read", "{}", "旧" * 18000), ("Bash", "{}", "次" * 3000))
    latest = batch(1, ("Read", "{}", "新" * 4000))
    messages = [msg("user", "task", "input", kind="human"), *old, *latest]
    selected = select(messages, ceiling=10000)
    assert [source_of(m)["derived_from"] for m in refs(selected)] == ["result:0:0"]
    assert old[2] in selected.messages and all(m in selected.messages for m in latest)
    assert selected.removed_groups == () and selected.changed


@pytest.mark.parametrize("suffix", [[], [msg("user", "steer", "control", kind="control")]])
def test_newest_batch_is_never_referenced_even_after_control_arrival(suffix):
    messages = [msg("user", "task", "input", kind="human"),
                *batch(0, ("Read", "{}", "新" * 20000)), *suffix]
    original = copy.deepcopy(messages)
    with pytest.raises(RequiredContextTooLarge):
        select(messages, ceiling=10000)
    assert messages == original


def test_batch_before_a_control_is_not_pinned_or_referenced_but_dropped_whole():
    first = batch(0, ("Read", "{}", "旧" * 9000))
    second = batch(1, ("Read", "{}", "较新" * 3500))
    latest = batch(2, ("Read", "{}", "最新" * 1500))
    messages = [msg("user", "task", "input", kind="human"), *first,
                msg("user", "first steer", "control:0", kind="control"), *second,
                msg("user", "second steer", "control:1", kind="control"), *latest]
    selected = select(messages, ceiling=15000)
    assert refs(selected) == []
    assert not any(m in selected.messages for m in first)
    assert all(m in selected.messages for m in second + latest)


@pytest.mark.parametrize("protocol", ["chat", "responses", "anthropic"])
def test_referenced_pairs_serialize_through_real_backends_without_network(protocol):
    from app.llm.anthropic import AnthropicBackend
    from app.llm.openai_chat import OpenAIChatBackend
    from app.llm.openai_responses import OpenAIResponsesBackend
    cls = {"chat": OpenAIChatBackend, "responses": OpenAIResponsesBackend,
           "anthropic": AnthropicBackend}[protocol]
    backend = cls(None, "https://isolated.invalid", "")
    messages = [msg("user", "task", "input", kind="human"),
                *batch(0, ("Read", "{}", [{"type": "text", "text": "旧" * 20000}])),
                *batch(1, ("Read", "{}", "new"))]
    original = copy.deepcopy(messages)
    selected = select(messages)
    assert len(refs(selected)) == 1 and validate_model_context(selected.messages)
    payload = backend.build_payload(selected.messages, model="offline", system="system",
                                    tools=[], max_tokens=100, stream=False)
    assert "Historical tool result referenced" in json.dumps(payload, ensure_ascii=False)
    assert "openbear_context_source" not in json.dumps(payload)
    assert messages == original


def test_optional_old_bodies_are_evicted_without_creating_references():
    messages = [msg("user", "task", "input", kind="human")]
    for i in range(5):
        messages += batch(i, ("Read", "{}", "旧" * 1000), text=None)
    selected = select(messages, ceiling=12000)
    assert not refs(selected)
    assert selected.removed_groups


@pytest.mark.parametrize("name,args,body", [
    ("UserInteraction", "{}", '{"status":"feedback","text":"stop"}'),
    ("OpenBearControl", '{"action":"restart"}', '{"confirmation":{"confirmed":false}}'),
    ("OpenBearControl", '{"action":"status"}', '{"confirmation":{"confirmed":false}}'),
    ("OpenBearControl", '{"action":"unknown"}', '{"text":"decision"}'),
])
def test_confirmations_and_decisions_survive_mixed_parallel_batch(name, args, body):
    decision = body + " " * 5000
    old = batch(0, (name, args, decision), ("Read", "{}", "可替换" * 15000))
    latest = batch(1, ("Read", "{}", "new"))
    messages = [msg("user", "task", "input", kind="human"), *old, *latest]
    selected = select(messages, ceiling=10000)
    assert old[1] in selected.messages
    assert [source_of(m)["derived_from"] for m in refs(selected)] == ["result:0:1"]
    assert validate_model_context(selected.messages)


def test_control_query_without_confirmation_can_be_referenced():
    old = batch(0, ("OpenBearControl", '{"action":"status"}', "status " * 12000))
    latest = batch(1, ("Read", "{}", "new"))
    messages = [msg("user", "task", "input", kind="human"), *old, *latest]
    selected = select(messages)
    assert len(refs(selected)) == 1


@pytest.mark.parametrize("unreplaceable", ["instruction", "decision", "no_source", "control_result"])
def test_exhausted_references_still_fail_without_truncating_protected_material(unreplaceable):
    old = batch(0, ("UserInteraction" if unreplaceable == "decision" else "Read", "{}", "旧" * 20000))
    user = msg("user", "任务" * 10000 if unreplaceable == "instruction" else "task", "input", kind="human")
    if unreplaceable == "no_source":
        old[1].pop("openbear_context_source")
    if unreplaceable == "control_result":
        mark_source(old[1], kind="control")
    messages = [user, *old, *batch(1, ("Read", "{}", "new"))]
    original = copy.deepcopy(messages)
    with pytest.raises(RequiredContextTooLarge):
        select(messages, ceiling=10000)
    assert messages == original


def test_budget_that_fits_keeps_old_selection_and_summary_policy_exact():
    old = batch(0, ("Read", "{}", "旧" * 1000))
    control = msg("user", "continue", "control", kind="control")
    messages = [msg("user", "task", "input", kind="human"), *old, control, *batch(1, ("Read", "{}", "new"))]
    summary_before = required_context_groups(messages, protocol_groups(messages))
    selected = select(messages, ceiling=20000)
    assert selected.messages == messages and not refs(selected) and not selected.changed
    assert required_context_groups(messages, protocol_groups(messages)) == summary_before


@pytest.mark.asyncio
async def test_strategy_reports_reference_only_change():
    messages = [msg("user", "task", "input", kind="human"),
                *batch(0, ("Read", "{}", "旧" * 20000)), *batch(1, ("Read", "{}", "new"))]
    result = await SlidingWindowStrategy().compress(CompressionRequest(messages, cost, 2000, 10000, active_run_root_turn_uuid="root"))
    assert result.changed and result.detail["referencedToolResults"] == 1
    assert result.detail["removedBatches"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("agent", [False, True])
async def test_runtime_archives_derivative_and_history_recovers_original_pages(db, agent):
    owner = (ContextOwner.agent(task_uuid="task", agent_session_uuid="instance") if agent else
             ContextOwner.controller(chat_id=123, session_uuid="session"))
    store = WindowStore(db, owner)
    manager = ContextManager(store, WindowPolicy(100000, trigger_tokens=12000), backend=None,
                             model="offline", active_run_root_turn_uuid="root", frozen_system=True)
    body = "原始中文工具证据" * 10000
    messages = [msg("user", "Original authorization", "input", kind="task" if agent else "human"),
                *batch(0, ("Read", "{}", body)), *batch(1, ("Read", "{}", "new" * 1000))]
    original = copy.deepcopy(messages)
    outgoing = await manager.prepare(messages, system="system", tools=[], force=True)
    assert messages == original and validate_model_context(outgoing)
    assert await store.restore_messages() == outgoing
    reference = next(m for m in outgoing if source_of(m).get("tool_result_reference"))
    event_id = source_of(reference)["derived_from"]
    assert (await store.event_payload(event_id))["payload"]["content"] == body
    assert (await store.event_payload(source_of(reference)["id"]))["payload"]["content"] == reference["content"]
    # Use the actual History/AgentHistory shared reader, following real paging.
    chunks = []
    offset = 0
    while True:
        answer = await query_execution_history(store, {"action":"read_event", "eventId":event_id, "offset":offset, "maxChars":32000})
        event = answer["events"][0]
        chunks.append(event["text"])
        if not event["hasMore"]:
            break
        offset = event["nextOffset"]
    assert json.loads("".join(chunks))["content"] == body
    assert len(chunks) > 1
    # A future rotation cannot point a reference at a reference or mutate it.
    second = await manager.prepare(outgoing, system="system", tools=[], force=True)
    assert second == outgoing
    assert (await store.event_payload(event_id))["payload"]["content"] == body
