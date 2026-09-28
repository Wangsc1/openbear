"""Old duplicate call IDs: real Controller request boundary, no historical replay."""
from __future__ import annotations

import pytest

from app.agent.loop import Agent
from app.agent.native_continuation import validate_model_context
from app.context.builder import build_controller_history
from app.context.runtime import ContextManager
from app.context.store import ContextOwner, StaleWindow, WindowStore
from app.context.window import WindowPolicy, source_of
from app.db.dao import MessageDAO
from app.db.engine import DB
from app.llm.events import StreamEvent, ToolCall
from app.tools.base import ToolRegistry
from app.web_console.live_stream import _WebDBPersister
from app.web_admin import _WebLiveStream, _WebStreamRenderer
from tests.test_agent_loop import FakeBackend, RecordRenderer
from tests.test_web_admin import FakeRunFactory, FakeStreamBackend, web_env as shared_web_env

web_env = shared_web_env


@pytest.fixture
async def old_chat(tmp_path):
    db = DB(str(tmp_path / "legacy.db"))
    await db.connect()
    dao = MessageDAO(db)
    chat = 37
    await dao.add(chat, "user", "old request")
    old_id = await dao.add(chat, "assistant", "", tool_calls=[
        ToolCall("dup", "LegacySideEffect", '{"value":1}'),
        ToolCall("dup", "LegacySideEffect", '{"value":1}'),
    ])
    await dao.add(chat, "tool", "recorded historical result", tool_call_id="dup", name="LegacySideEffect")
    await dao.add(chat, "tool", "different historical result", tool_call_id="dup", name="LegacySideEffect")
    followup_id = await dao.add(chat, "user", "continue without replaying old tools")
    yield db, dao, chat, old_id, followup_id
    await db.close()


async def test_controller_runner_reaches_fake_provider_without_replaying_history(old_chat):
    db, dao, chat, old_id, _ = old_chat
    cur = await db.conn.execute("SELECT tool_calls_json FROM messages WHERE id=?", (old_id,))
    raw_calls = (await cur.fetchone())[0]
    history = await build_controller_history(dao, chat)
    assert validate_model_context(history)
    backend = FakeBackend([[StreamEvent(kind="content", text="new response"),
                            StreamEvent(kind="finish", finish_reason="stop")]])
    effects = []
    registry = ToolRegistry()
    async def old_side_effect(args):
        effects.append(args)
        raise AssertionError("Historical tool must never execute")
    registry.add("LegacySideEffect", "never replay", {"type": "object"}, old_side_effect)
    session = await dao.current_session_uuid(chat)
    runtime = ContextManager(WindowStore(db, ContextOwner.controller(chat_id=chat, session_uuid=session)),
                             WindowPolicy(1000000), backend=backend, model="fake")
    persister = _WebDBPersister(dao, chat, session_uuid=session)
    persister.window_runtime = runtime
    result = await Agent(backend, registry).run(history, RecordRenderer(), model="fake",
                                                 persister=persister, window_runtime=runtime)
    assert result.text == "new response" and backend._round == 1 and not effects
    assert validate_model_context(backend.seen_convos[0])
    assert len([m for m in backend.seen_convos[0] if source_of(m).get("derived_from") == f"message:{old_id}"]) == 1
    result_row = next(m for m in backend.seen_convos[0] if m.get("role") == "tool" and m.get("tool_call_id") == "dup")
    assert result_row["content"] == "recorded historical result"
    assert len(source_of(result_row)["covered_duplicate_result_ids"]) == 1
    restored = await runtime.store.restore_messages()
    assert restored and validate_model_context(restored)
    cur = await db.conn.execute("SELECT tool_calls_json FROM messages WHERE id=?", (old_id,))
    assert (await cur.fetchone())[0] == raw_calls

    # A second real Controller run restores the checkpoint and still proves the
    # original's lineage rather than re-adopting its malformed batch.
    await dao.add(chat, "user", "next root request")
    next_history = await build_controller_history(dao, chat)
    next_backend = FakeBackend([[StreamEvent(kind="content", text="next response"),
                                 StreamEvent(kind="finish", finish_reason="stop")]])
    next_runtime = ContextManager(WindowStore(db, ContextOwner.controller(chat_id=chat, session_uuid=session)),
                                  WindowPolicy(1000000), backend=next_backend, model="fake")
    next_persister = _WebDBPersister(dao, chat, session_uuid=session)
    next_persister.window_runtime = next_runtime
    second = await Agent(next_backend, registry).run(next_history, RecordRenderer(), model="fake",
                                                    persister=next_persister, window_runtime=next_runtime)
    assert second.text == "next response" and next_backend._round == 1 and effects == []


@pytest.mark.parametrize("tamper", ["content", "calls", "source", "reference", "foreign", "row_changed"])
async def test_derived_coverage_is_proved_against_same_chat_immutable_row(old_chat, tamper):
    db, dao, chat, old_id, _ = old_chat
    history = await build_controller_history(dao, chat)
    assistant = next(m for m in history if source_of(m).get("derived_from") == f"message:{old_id}")
    if tamper == "content":
        assistant["content"] = "forged answer"
    elif tamper == "calls":
        assistant["tool_calls"][0] = ToolCall("dup", "LegacySideEffect", '{"value":2}')
    elif tamper == "source":
        assistant["openbear_context_source"]["derived_from"] = "message:999999"
    elif tamper == "reference":
        assistant["openbear_context_source"]["reference_only"] = True
    elif tamper == "foreign":
        await db.conn.execute("UPDATE messages SET task_uuid='another-owner' WHERE id=?", (old_id,))
        await db.conn.commit()
    elif tamper == "row_changed":
        await db.conn.execute("UPDATE messages SET content='edited after reading' WHERE id=?", (old_id,))
        await db.conn.commit()
    store = WindowStore(db, ContextOwner.controller(chat_id=chat, session_uuid=await dao.current_session_uuid(chat)))
    with pytest.raises(StaleWindow, match="controller_derived_source_unverified"):
        await store.controller_boundary(history, since=None, phase="pre_model_request")


@pytest.mark.parametrize("tamper", ["wrong_result", "result_body", "result_owner", "result_marker", "result_source"])
async def test_extra_result_coverage_requires_original_batch_and_owner(old_chat, tamper):
    db, dao, chat, old_id, _ = old_chat
    history = await build_controller_history(dao, chat)
    tool = next(m for m in history if source_of(m).get("covered_duplicate_result_ids"))
    extra_id = source_of(tool)["covered_duplicate_result_ids"][0]
    if tamper == "wrong_result":
        source_of(tool)["covered_duplicate_result_ids"] = [old_id]
    elif tamper == "result_body":
        tool["content"] = "fabricated success"
    elif tamper == "result_owner":
        await db.conn.execute("UPDATE messages SET task_uuid='foreign' WHERE id=?", (extra_id,))
        await db.conn.commit()
    elif tamper == "result_marker":
        source_of(tool)["covered_duplicate_result_ids"] = [extra_id + 9999]
    elif tamper == "result_source":
        source_of(tool)["id"] = "message:1"
    store = WindowStore(db, ContextOwner.controller(chat_id=chat, session_uuid=await dao.current_session_uuid(chat)))
    with pytest.raises(StaleWindow, match="controller_duplicate_result_unverified"):
        await store.controller_boundary(history, since=None, phase="pre_model_request")


async def test_covered_raw_result_cas_and_unrecognized_append_stay_fatal(old_chat):
    db, dao, chat, _, _ = old_chat
    history = await build_controller_history(dao, chat)
    store = WindowStore(db, ContextOwner.controller(chat_id=chat, session_uuid=await dao.current_session_uuid(chat)))
    boundary, additions = await store.controller_boundary(history, since=None, phase="pre_model_request")
    assert additions == []
    extra_id = next(source_of(m)["covered_duplicate_result_ids"][0] for m in history
                    if source_of(m).get("covered_duplicate_result_ids"))
    await db.conn.execute("UPDATE messages SET content='modified raw result' WHERE id=?", (extra_id,))
    await db.conn.commit()
    with pytest.raises(StaleWindow, match="controller_history_changed"):
        await store.controller_boundary(history, since=boundary.high_water,
                                        phase="pre_model_request", previous=boundary)

    # An independent copy of the original fixture: new execution after the
    # accepted input cannot be disguised as an old historical result.
    fresh = await build_controller_history(dao, chat)
    await dao.add(chat, "assistant", "unrecognized execution")
    with pytest.raises(StaleWindow, match="controller_unrecognized_execution_append"):
        await store.controller_boundary(fresh, since=None, phase="pre_model_request")


async def test_existing_result_archive_fingerprint_does_not_change_for_lineage_marker(old_chat):
    from app.context.window import mark_source
    db, dao, chat, old_id, _ = old_chat
    history = await build_controller_history(dao, chat)
    result = next(m for m in history if source_of(m).get("covered_duplicate_result_ids"))
    row_id = source_of(result)["message_id"]
    cur = await db.conn.execute("SELECT * FROM messages WHERE id=? AND chat_id=?", (row_id, chat))
    raw = dao._row(await cur.fetchone()).to_message()
    mark_source(raw, kind="execution", source_id=f"message:{row_id}", message_id=row_id,
                reference_only=True, turn_uuid="", run_root_turn_uuid="")
    store = WindowStore(db, ContextOwner.controller(chat_id=chat, session_uuid=await dao.current_session_uuid(chat)))
    await store.archive([raw])
    cur = await db.conn.execute("SELECT fingerprint FROM context_execution_events WHERE owner_key=? AND event_id=?",
                                (store.owner.key, f"message:{row_id}"))
    previous = (await cur.fetchone())[0]
    await store.archive(history)
    cur = await db.conn.execute("SELECT fingerprint FROM context_execution_events WHERE owner_key=? AND event_id=?",
                                (store.owner.key, f"message:{row_id}"))
    assert (await cur.fetchone())[0] == previous
    assert source_of(result)["covered_duplicate_result_ids"]


async def test_new_user_append_remains_visible_after_derived_history(old_chat):
    db, dao, chat, _, _ = old_chat
    history = await build_controller_history(dao, chat)
    await dao.add(chat, "user", "new genuine input")
    store = WindowStore(db, ContextOwner.controller(chat_id=chat, session_uuid=await dao.current_session_uuid(chat)))
    _, additions = await store.controller_boundary(history, since=None, phase="pre_model_request")
    assert [m["content"] for m in additions] == ["new genuine input"]


async def test_web_controller_turn_real_entry_reaches_fake_backend(web_env, monkeypatch):
    env = web_env
    row = await env.server._create_web_conversation(123)
    chat, uuid = row["internal_chat_id"], row["conversation_uuid"]
    dao = MessageDAO(env.db)
    await dao.add(chat, "user", "old request", turn_uuid="old")
    old_id = await dao.add(chat, "assistant", "", tool_calls=[ToolCall("dup", "Read", "{}"),
                                                              ToolCall("dup", "Read", "{}")], turn_uuid="old")
    await dao.add(chat, "tool", "old result", tool_call_id="dup", name="Read", turn_uuid="old")
    await dao.add(chat, "tool", "another old result", tool_call_id="dup", name="Read", turn_uuid="old")
    cur = await env.db.conn.execute("SELECT tool_calls_json FROM messages WHERE id=?", (old_id,))
    raw_calls = (await cur.fetchone())[0]
    backend = FakeStreamBackend()
    env.server.tools = ToolRegistry()
    env.server.llm_factory = FakeRunFactory(backend, context_window=1000000)
    async def system():
        return "Test: do not replay historical tools."
    monkeypatch.setattr(env.server, "_build_system_prompt_for_chat", system)
    live = _WebLiveStream(uuid, chat)
    await live.publish({"type": "accepted", "turnUuid": "next"})
    assert await env.server._run_web_turn(chat, "continue", _WebStreamRenderer(live),
                                          conversation=row, root_turn_uuid="next")
    assert backend.calls == 1 and validate_model_context(backend.seen_convos[0])
    assert sum(source_of(m).get("derived_from") == f"message:{old_id}" for m in backend.seen_convos[0]) == 1
    assert sum(bool(source_of(m).get("covered_duplicate_result_ids")) for m in backend.seen_convos[0]) == 1
    cur = await env.db.conn.execute("SELECT tool_calls_json FROM messages WHERE id=?", (old_id,))
    assert (await cur.fetchone())[0] == raw_calls
