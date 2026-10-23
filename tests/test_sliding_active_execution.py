"""Current-execution sliding pins; summary policy and original archives stay intact."""
from __future__ import annotations

import copy
from types import SimpleNamespace

import pytest

from app.agent.native_continuation import validate_model_context
from app.context.prompts import LEGACY_WINDOW_SYSTEM_POLICY, effective_context_prompt
from app.context.runtime import ContextManager
from app.context.store import ContextOwner, WindowStore
from app.context.strategies import (
    CompressionRequest,
    ContextCompressionError,
    SlidingWindowStrategy,
)
from app.context.window import (
    CONTEXT_META,
    WINDOW_SYSTEM_POLICY,
    ActiveContextUnavailable,
    InputEstimate,
    RequiredContextTooLarge,
    WindowPolicy,
    mark_source,
    protocol_groups,
    required_context_groups,
    select_window,
    sliding_required_context_groups,
    source_of,
)
from app.db.dao import MessageDAO
from tests.test_context_strategies import env as shared_strategy_env
from tests.test_context_window import batch
from tests.test_context_window import db as shared_db

strategy_env = shared_strategy_env
db = shared_db


def msg(role, text, *, kind=None, root="", turn="", task=""):
    return mark_source({"role": role, "content": text}, kind=kind or ("human" if role == "user" else "execution"),
                       run_root_turn_uuid=root, turn_uuid=turn, task_uuid=task)


def tool(index, *, root="", task="", decision=False):
    group = batch(index, name="OpenBearControl" if decision else "Bash", text="result")
    if decision:
        group[0]["tool_calls"][0].arguments = '{"action":"restart"}'
        group[1]["content"] = '{"confirmation":{"confirmed":false,"text":"current confirmation feedback"}}'
    for message in group:
        mark_source(message, run_root_turn_uuid=root, task_uuid=task)
    return group


def cost(messages):
    return InputEstimate(10 + len(messages) * 10)


def fixture_history(n, *, task=""):
    history = [msg("user", "OLD SUMMARY", kind="summary"), msg("user", "OLD HANDOFF", kind="legacy_handoff")]
    for i in range(n):
        history += [msg("user", f"OLD USER {i}", root=f"old-{i}", task=f"old-task-{i}"),
                    *tool(i, root=f"old-{i}", task=f"old-task-{i}", decision=True),
                    msg("assistant", f"OLD ANSWER {i}", root=f"old-{i}", task=f"old-task-{i}")]
    plan = msg("assistant", "CURRENT PROPOSAL: edit the bounded files; no deployment.", root="preceding", task="prior")
    current = msg("user", "好，改吧", kind="task" if task else "human", root="active", task=task)
    followup = msg("assistant", "CURRENT QUESTION: preserve the existing font size?", root="active", task=task)
    feedback = msg("user", "Yes, keep that size.", kind="control", root="active", turn="steering-turn", task=task)
    history += [plan, current, *tool(80, root="active", task=task), followup, feedback,
                *tool(81, root="active", task=task, decision=True),
                *tool(82, root="active", task=task), *tool(83, root="active", task=task),
                msg("user", "LATEST RUNTIME", kind="required_runtime")]
    return history, plan, current, followup, feedback


@pytest.mark.parametrize("old_rounds", [20, 50])
def test_only_current_inputs_controls_and_runtime_are_required(old_rounds):
    history, plan, current, followup, feedback = fixture_history(old_rounds)
    original = copy.deepcopy(history)
    selected = select_window(history, estimate=cost, target=90, input_ceiling=500,
                             active_run_root_turn_uuid="active")
    text = str(selected.messages)
    assert "OLD USER" not in text and "OLD ANSWER" not in text
    assert "OLD SUMMARY" not in text and "OLD HANDOFF" not in text
    assert current in selected.messages and feedback in selected.messages
    # The message before an input is not reliably what it answers: no positional pin.
    assert plan not in selected.messages and followup not in selected.messages
    assert "LATEST RUNTIME" in text and "current confirmation feedback" in text
    assert sum(m.get("name") == "OpenBearControl" for m in selected.messages) == 1
    assert len(selected.required_groups) == 6  # input/feedback/decision/two recent/runtime
    assert validate_model_context(selected.messages)
    assert history == original
    # Previous policy is still the summary policy; it has not been weakened.
    assert len(required_context_groups(history, protocol_groups(history))) > old_rounds * 3


@pytest.mark.parametrize("current_batches", [0, 1, 2])
@pytest.mark.parametrize("old_rounds", [20, 50])
@pytest.mark.parametrize("owner", ["controller", "agent"])
def test_recent_tool_floor_cannot_pin_old_tools_and_subsequent_dialogue(current_batches, old_rounds, owner):
    # Agent rounds intentionally share a parent root: only task identity counts.
    old_root = "active" if owner == "agent" else "old-root"
    history = [msg("user", "OLD TOOL TASK", root=old_root, task="old-task"),
               *tool(800, root=old_root, task="old-task", decision=True),
               *tool(801, root=old_root, task="old-task")]
    for index in range(old_rounds):
        history += [msg("user", f"OLD DIALOGUE {index}", root=old_root, task="old-task"),
                    msg("assistant", f"OLD ANSWER {index}", root=old_root, task="old-task")]
    proposal = msg("assistant", "CURRENT BOUNDED PROPOSAL", root=old_root, task="old-task")
    current = msg("user", "好，改吧" if owner == "controller" else "Complete current standalone task brief",
                  kind="human" if owner == "controller" else "task", root="active", task="current-task")
    history += [proposal, current]
    current_tail = []
    for index in range(current_batches):
        current_tail += [*tool(900 + index, root="active", task="current-task"),
                         msg("assistant", f"CURRENT CONTIGUOUS RESULT {index}", root="active", task="current-task")]
    runtime = msg("user", "LATEST RUNTIME", kind="required_runtime")
    history += [*current_tail, runtime]
    original = copy.deepcopy(history)
    selected = select_window(history, estimate=cost, target=20, input_ceiling=500,
                             active_run_root_turn_uuid="active",
                             active_task_uuid="current-task" if owner == "agent" else "")
    expected = [current, *current_tail, runtime]
    assert selected.messages == expected
    assert len(selected.required_groups) == len(protocol_groups(expected))
    assert all(m.get("name") != "OpenBearControl" for m in selected.messages)
    assert validate_model_context(selected.messages)
    assert history == original


@pytest.mark.parametrize("current_batches", [0, 1, 2])
def test_single_unscoped_input_fallback_never_reaches_back_to_old_tool_batches(current_batches):
    history = [*tool(800, decision=True), *tool(801)]
    proposal = msg("assistant", "bounded preceding proposal")
    current = msg("user", "go ahead")
    history += [proposal, current]
    current_tail = []
    for index in range(current_batches):
        current_tail += [*tool(900 + index), msg("assistant", f"current suffix {index}")]
    runtime = msg("user", "latest state", kind="required_runtime")
    history += [*current_tail, runtime]
    selected = select_window(history, estimate=cost, target=20, input_ceiling=500)
    assert selected.messages == [current, *current_tail, runtime]
    assert len(selected.required_groups) == 2 + current_batches * 2
    assert validate_model_context(selected.messages)


async def test_long_run_keeps_short_authorization_proposal_across_repeated_windows_and_archive(db):
    history, plan, current, followup, feedback = fixture_history(50)
    for m in history:
        if source_of(m)["kind"] == "required_runtime":
            m[CONTEXT_META] = {**source_of(m), "kind": "runtime"}
    store = WindowStore(db, ContextOwner.controller(chat_id=7, session_uuid="session"))
    manager = ContextManager(store, WindowPolicy(128000, trigger_tokens=8000, retain_tokens=1200, dialogue_tokens=300),
                             backend=SimpleNamespace(protocol="chat"), model="fake", active_run_root_turn_uuid="active")
    await manager.checkpoint(history)
    old_id = source_of(history[2])["id"]
    old_original = await store.event_payload(old_id)
    for index in range(4):
        history += tool(100 + index * 3, root="active") + tool(101 + index * 3, root="active")
        history = await manager.prepare(history, system="", tools=[], force=True)
        assert all(m in history for m in (plan, current, followup, feedback))
        assert "OLD USER 0" not in str(history) and "OLD SUMMARY" not in str(history)
        assert "OLD ANSWER 0" not in str(history)
        assert len([m for m in history if source_of(m).get("kind") == "runtime"]) == 1
    assert await store.event_payload(old_id) == old_original
    assert manager.policy.threshold == 8000 and manager.policy.target() == 1200
    assert manager.policy.dialogue_target() == 300


def test_agent_uses_task_not_parent_root_and_never_backfills_old_task_proposal():
    history, plan, current, followup, feedback = fixture_history(20, task="current-task")
    for message in history:
        # Several AgentContinue rounds can belong to a single parent run.
        message[CONTEXT_META]["run_root_turn_uuid"] = "same-parent"
    selected = select_window(history, estimate=cost, target=110, active_task_uuid="current-task",
                             active_run_root_turn_uuid="same-parent")
    assert current in selected.messages and feedback in selected.messages and followup in selected.messages
    assert plan not in selected.messages
    assert "OLD USER" not in str(selected.messages)
    assert validate_model_context(selected.messages)


def test_legacy_fallback_rejects_ambiguous_inputs_and_never_adopts_runtime_as_input():
    old = []
    for i in range(50):
        old += [msg("user", f"old {i}"), msg("assistant", f"reply {i}")]
    proposal = msg("assistant", "last local proposal")
    current = msg("user", "go ahead")
    latest = msg("user", "runtime is not a user task", kind="required_runtime")
    history = [*old, proposal, current, *tool(1), *tool(2), latest]
    with pytest.raises(ActiveContextUnavailable, match="ambiguous_legacy_execution_inputs"):
        select_window(history, estimate=cost, target=80)
    # A single unscoped input is safe to adopt; unknown runtime role=user never
    # becomes a fake current task. Explicit scoped history remains optional.
    for i, message in enumerate(old):
        message[CONTEXT_META]["run_root_turn_uuid"] = f"old-{i // 2}"
    selected = select_window(history, estimate=cost, target=80, active_run_root_turn_uuid="unmarked-current")
    assert proposal in selected.messages and current in selected.messages and latest in selected.messages
    assert "old " not in str(selected.messages)


async def test_missing_authoritative_current_input_fails_without_guessing_old_task():
    history = [msg("user", "old input", task="old"), *tool(1, task="old")]
    with pytest.raises(ContextCompressionError, match="active_execution_input_missing"):
        await SlidingWindowStrategy().compress(CompressionRequest(history, cost, 50, 100, active_task_uuid="new"))


async def test_legacy_controller_turn_to_root_enrichment_does_not_change_source_fingerprint(db):
    dao = MessageDAO(db)
    rows = []
    for turn, root, text in [("old-turn", "old-root", "old"), ("root", "root", "current task"),
                             ("steer", "root", "current feedback")]:
        ident = await dao.add(7, "user", text, turn_uuid=turn, run_root_turn_uuid=root)
        rows.append(mark_source({"role": "user", "content": text}, kind="human", source_id=f"message:{ident}",
                                message_id=ident, reference_only=True, turn_uuid=turn))
    store = WindowStore(db, ContextOwner.controller(chat_id=7, session_uuid="session"))
    manager = ContextManager(store, WindowPolicy(128000, trigger_tokens=8000),
                             backend=SimpleNamespace(protocol="chat"), model="fake", active_run_root_turn_uuid="root")
    await manager.checkpoint(rows + tool(1) + tool(2))
    before = [dict(row) for row in await (await db.conn.execute("SELECT * FROM context_execution_events ORDER BY seq")).fetchall()]
    messages = await store.restore_messages()
    await manager.restore_source_scopes(messages)
    assert [source_of(m).get("run_root_turn_uuid") for m in messages[:3]] == ["old-root", "root", "root"]
    required = sliding_required_context_groups(messages, protocol_groups(messages), active_run_root_turn_uuid="root")
    assert 0 not in required and {1, 2} <= required
    await manager.checkpoint(messages)
    after = [dict(row) for row in await (await db.conn.execute("SELECT * FROM context_execution_events ORDER BY seq")).fetchall()]
    assert before == after
    assert (await store.event_payload(source_of(rows[2])["id"]))["payload"]["content"] == "current feedback"


async def test_agent_legacy_checkpoint_migration_does_not_relabel_prior_task(db):
    owner = ContextOwner.agent(task_uuid="old-task", agent_session_uuid="instance")
    store = WindowStore(db, owner)
    original = [msg("user", "legacy brief", kind="task"), *tool(1), *tool(2)]
    previous = ContextManager(store, WindowPolicy(128000), backend=SimpleNamespace(protocol="chat"), model="fake")
    await previous.checkpoint(original)
    new_store = WindowStore(db, ContextOwner.agent(task_uuid="new-task", agent_session_uuid="instance"))
    manager = ContextManager(new_store, WindowPolicy(128000), backend=SimpleNamespace(protocol="chat"), model="fake")
    restored = await new_store.restore_messages()
    await manager.restore_source_scopes(restored, origin_task_uuid="old-task")
    assert all(source_of(m)["task_uuid"] == "old-task" for m in restored)
    archived_before = [dict(row) for row in await (await db.conn.execute("SELECT * FROM context_execution_events")).fetchall()]
    await manager.checkpoint(restored)
    assert archived_before == [dict(row) for row in await (await db.conn.execute("SELECT * FROM context_execution_events")).fetchall()]
    # Very old checkpoints have no source metadata at all; bind to the actual
    # source checkpoint task, not the new Continue task.
    raw = [{"role": "user", "content": "older raw brief"}]
    await manager.restore_source_scopes(raw, origin_task_uuid="old-task")
    assert source_of(raw[0])["task_uuid"] == "old-task"
    new = msg("user", "new complete brief", kind="task", task="new-task")
    selected = select_window(restored + raw + [new] + tool(3, task="new-task") + tool(4, task="new-task"),
                             estimate=cost, target=60, active_task_uuid="new-task")
    assert new in selected.messages and not any("legacy brief" in str(m) for m in selected.messages)


async def test_current_required_input_over_threshold_leaves_original_window_unchanged(db):
    store = WindowStore(db, ContextOwner.controller(chat_id=7, session_uuid="s"))
    manager = ContextManager(store, WindowPolicy(1000000, trigger_tokens=2000, retain_tokens=300), backend=SimpleNamespace(protocol="chat"),
                             model="fake", active_run_root_turn_uuid="root")
    original = [msg("user", "short", root="root"), *tool(1, root="root"), *tool(2, root="root")]
    await manager.checkpoint(original)
    before = await store.load()
    oversized = original + [msg("user", "current required feedback " * 2000, kind="control", root="root")]
    input_before = copy.deepcopy(oversized)
    with pytest.raises(RequiredContextTooLarge) as error:
        await manager.prepare(oversized, system="", tools=[], force=True)
    assert error.value.input_ceiling == 1999
    after = await store.load()
    assert before["state"] == after["state"] and before["window_version"] == after["window_version"]
    assert oversized == input_before
    assert manager.policy.threshold == 2000 and manager.policy.target() == 300


async def test_summary_policy_unchanged_and_switches_do_not_reload_history(strategy_env):
    env = strategy_env
    env.manager.active_run_root_turn_uuid = "active"
    history, plan, current, followup, feedback = fixture_history(20)
    env.selected["strategy"] = "model_summary"
    # First summary retains old source inputs/decisions just as before.
    summary = await env.manager.prepare(history, system="", tools=[], force=True)
    assert "OLD USER 0" in str(summary) and "OLD ANSWER 0" in str(summary)
    assert "OLD HANDOFF" in str(summary)
    calls = len(env.calls)
    env.selected["strategy"] = "sliding_window"
    env.manager.policy = WindowPolicy(128000, trigger_tokens=8000, retain_tokens=1200, dialogue_tokens=200)
    sliding = await env.manager.prepare(summary + tool(110, root="active") + tool(111, root="active"), system=env.manager.system, tools=[], force=True)
    assert "OLD USER 0" not in str(sliding) and "OLD ANSWER 0" not in str(sliding)
    assert "OLD HANDOFF" not in str(sliding)
    assert current in sliding and plan in sliding and feedback in sliding
    assert len(env.calls) == calls
    env.selected["strategy"] = "model_summary"
    again = await env.manager.prepare(sliding + tool(112, root="active") + tool(113, root="active"), system=env.manager.system, tools=[], force=True)
    assert len(env.calls) == calls + 1
    assert "OLD USER 0" not in str(again)  # switching back cannot reload evicted history
    assert (await env.store.index(query="OLD USER 0"))["events"]


def test_frozen_previous_window_policy_remains_exact_in_request_view():
    stored = "Custom rule remains.\n\n" + LEGACY_WINDOW_SYSTEM_POLICY
    rendered = effective_context_prompt(stored)
    assert rendered == stored
    assert rendered.count("## Context window runtime") == 1
    assert LEGACY_WINDOW_SYSTEM_POLICY in rendered
    assert effective_context_prompt(rendered) == stored
    assert effective_context_prompt(effective_context_prompt(rendered, "model_summary")) == stored


def test_legacy_agent_control_metadata_is_a_current_input_without_relabeling():
    instruction = msg("user", "complete brief", kind="task", task="t")
    question = msg("assistant", "current clarification question", task="t")
    legacy_control = msg("user", "yes", kind="task", task="t")
    legacy_control["_openbear_runtime"] = {"kind": "agent_control"}
    messages = [instruction, question, legacy_control, *tool(1, task="t"), *tool(2, task="t")]
    required = sliding_required_context_groups(messages, protocol_groups(messages), active_task_uuid="t")
    assert {0, 2} <= required and 1 not in required
    assert source_of(legacy_control)["kind"] == "task"


def test_known_strategy_specific_phrases_switch_back_without_drift():
    original = "Context windows retain original user/task instructions, decisions and recent complete execution batches."
    sliding = effective_context_prompt(original, "sliding_window")
    summary = effective_context_prompt(sliding, "model_summary")
    assert original in summary and "Sliding windows pin" not in summary
    assert effective_context_prompt(summary, "sliding_window") == sliding


def test_dialogue_layer_keeps_visible_text_newest_first_without_tool_records():
    history, plan, current, followup, feedback = fixture_history(20)
    original = copy.deepcopy(history)
    selected = select_window(history, estimate=cost, target=90, input_ceiling=1000, dialogue_target=60,
                             active_run_root_turn_uuid="active")
    messages, text = selected.messages, str(selected.messages)
    # Newest first: the current round's earlier text, the proposal before it, then older rounds.
    assert followup in messages and plan in messages
    assert "OLD ANSWER 19" in text and "OLD USER 19" in text and "OLD ANSWER 18" not in text
    # An earlier tool batch is an execution record; a confirmation exchange is dialogue.
    assert not any(m.get("tool_call_id") == "t80" for m in messages)
    assert any(m.get("tool_call_id") == "t19" for m in messages)
    assert len(selected.dialogue_groups) == 5 and set(selected.dialogue_groups) <= set(selected.removed_groups)
    order = [messages.index(m) for m in (plan, current, followup, feedback)]
    assert order == sorted(order)
    assert validate_model_context(messages)
    assert history == original


def test_dialogue_projection_keeps_assistant_text_without_calls_and_is_stable():
    narrated = batch(1, text="old result body")
    narrated[0]["content"] = "I checked the old configuration."
    for message in narrated:
        mark_source(message, run_root_turn_uuid="old")
    history = [msg("user", "old request", root="old"), *narrated,
               msg("user", "tool image evidence", kind="execution", root="old"),
               msg("user", "old runtime state", kind="runtime"),
               msg("user", "current request", root="active"), *tool(2, root="active"), *tool(3, root="active")]
    first = select_window(history, estimate=cost, target=50, input_ceiling=1000, dialogue_target=100,
                          active_run_root_turn_uuid="active")
    text = str(first.messages)
    assert "I checked the old configuration." in text and "old request" in text
    assert "old result body" not in text and "tool image evidence" not in text and "old runtime state" not in text
    projected = next(m for m in first.messages if m.get("content") == "I checked the old configuration.")
    assert not projected.get("tool_calls")
    assert source_of(projected)["derived_from"] == source_of(narrated[0])["id"]
    assert source_of(projected)["dialogue_projection"] is True
    # A later window keeps the projection as it is instead of deriving it again.
    again = select_window(first.messages + tool(4, root="active"), estimate=cost, target=50, input_ceiling=1000,
                          dialogue_target=100, active_run_root_turn_uuid="active")
    assert projected in again.messages
    assert validate_model_context(first.messages) and validate_model_context(again.messages)


def test_earlier_round_keeps_reference_links_while_current_round_keeps_bodies():
    from app.context.request_view import expanded_request_view
    from app.references import BUNDLE_FIELD

    old = msg("user", "see [old notes](openbear://ref/doc/1)", root="old")
    old[BUNDLE_FIELD] = ["bundle-old"]
    current = msg("user", "see [current notes](openbear://ref/doc/2)", root="active")
    current[BUNDLE_FIELD] = ["bundle-current"]
    history = [old, msg("assistant", "old answer", root="old"), current, *tool(1, root="active")]
    expanded = [dict(m, content=m["content"] + " BODY") if m.get(BUNDLE_FIELD) else m for m in history]
    view = expanded_request_view(expanded)
    selected = select_window(history, estimate=lambda items: cost(view(items)), target=500, input_ceiling=1000,
                             dialogue_target=100, active_run_root_turn_uuid="active")
    request = view(selected.messages)
    assert "see [old notes](openbear://ref/doc/1)" in str(request)
    assert "[old notes](openbear://ref/doc/1) BODY" not in str(request)
    assert "[current notes](openbear://ref/doc/2) BODY" in str(request)
    assert current in selected.messages and old not in selected.messages
    marker = next(m for m in selected.messages if "old notes" in str(m.get("content")))
    assert BUNDLE_FIELD not in marker and source_of(marker)["derived_from"] == source_of(old)["id"]
