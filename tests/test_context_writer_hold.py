"""Work moved outside the SQLite writer must produce exactly the old results."""
from __future__ import annotations

import copy
import json

import pytest

from app.agent.native_continuation import serialize_messages, transcript_message_fingerprint
from app.context.runtime import ContextManager
from app.context.store import ContextOwner, WindowStore, _json, _json_with
from app.context.window import WindowPolicy, mark_source, neutral_context, neutral_view, source_of
from app.db.dao import MessageDAO
from app.db.engine import DB
from app.llm.events import ToolCall
from app.runtime.lifecycle import RunSession
from app.utils import estimate_tokens


@pytest.fixture
async def db(tmp_path):
    instance = DB(str(tmp_path / "writer-hold.db"))
    await instance.connect()
    yield instance
    await instance.close()


def conversation():
    return [
        mark_source({"role": "user", "content": "整理一下 the plan"}, kind="human", source_id="u1"),
        mark_source({"role": "assistant", "content": None, "reasoning": "private", "signature": "sig",
                     "tool_calls": [ToolCall(id="t1", name="Read", arguments="{}")]}, source_id="a1"),
        mark_source({"role": "tool", "tool_call_id": "t1", "name": "Read", "content": "结果 result"}, source_id="r1"),
    ]


def manager(db, identity):
    store = WindowStore(db, ContextOwner.agent(task_uuid="task", agent_session_uuid=identity, conversation_uuid="c"))
    return ContextManager(store, WindowPolicy(context_window=100_000, max_output_tokens=1_000), backend=None, model="m")


def test_spliced_encoding_is_byte_identical():
    messages = serialize_messages(neutral_context(conversation()))
    state = {"version": 1, "sourceMessageHighWater": 3, "calibration": {"tokens": 5}, "zeta": "中文"}
    assert _json_with(state, "messages", _json(messages)) == _json({**state, "messages": messages})


def test_neutral_view_serializes_like_neutral_context_without_touching_originals():
    messages = conversation()
    before = copy.deepcopy(messages)
    assert serialize_messages(neutral_view(messages)) == serialize_messages(neutral_context(messages))
    assert messages == before


@pytest.mark.parametrize("text", ["", "a", "中", "abc中文def", "\u4dff\u4e00\u9fff\ua000", "😀 é\n" * 7, "中" * 9 + "x" * 9])
def test_token_estimate_matches_per_character_count(text):
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    expected = 0 if not text else cjk + (len(text) - cjk) // 4 + 1
    assert estimate_tokens(text) == expected


@pytest.mark.asyncio
async def test_planned_checkpoint_stores_the_same_window_as_direct_checkpoint(db):
    direct, planned = manager(db, "direct"), manager(db, "planned")
    one, two = conversation(), conversation()
    await direct.checkpoint(one, extra_state={"stage": "s"})
    await planned.checkpoint(two, extra_state={"stage": "s"}, plan=await planned.plan_checkpoint(two))
    assert (await direct.store.load())["state"] == (await planned.store.load())["state"]


@pytest.mark.asyncio
async def test_planned_checkpoint_rereads_state_changed_after_planning(db):
    runtime = manager(db, "stale")
    messages = conversation()
    await runtime.checkpoint(messages)
    plan = await runtime.plan_checkpoint(messages)
    version = await runtime.store.archive(messages)
    await runtime.store.save(messages, expected_revision=version["revision"],
                             expected_source_revision=version["sourceRevision"], route="r",
                             extra_state={"estimatedNextInputTokens": 123})
    await runtime.checkpoint(messages, plan=plan)
    assert (await runtime.store.load())["state"]["estimatedNextInputTokens"] == 123


@pytest.mark.asyncio
async def test_run_archives_only_units_it_has_not_archived(db, monkeypatch):
    runtime = manager(db, "incremental")
    session = RunSession(runtime)
    archived = []
    original = runtime.store.archive

    async def spy(messages, **kwargs):
        archived.append([source_of(message)["id"] for message in messages])
        return await original(messages, **kwargs)

    monkeypatch.setattr(runtime.store, "archive", spy)
    messages = conversation()
    await session.archive(messages)
    messages.append({"role": "assistant", "content": "next"})
    await session.archive(messages)
    assert archived[0] == ["u1", "a1", "r1"]
    assert archived[1] == [source_of(messages[-1])["id"]] and archived[1][0] not in archived[0]
    assert len((await runtime.store.index())["events"]) == 4


@pytest.mark.asyncio
async def test_transcript_fingerprint_cache_follows_row_edits(db):
    dao = MessageDAO(db)
    await dao.ensure_session(-10)
    first = await dao.add(-10, "user", "original")
    await dao.add(-10, "assistant", "answer")

    async def rows():
        return await (await db.conn.execute("SELECT * FROM messages WHERE chat_id=-10 ORDER BY id")).fetchall()

    def direct(fetched):
        return [transcript_message_fingerprint(MessageDAO._row(row).to_message()) for row in fetched]

    fetched = await rows()
    assert dao._transcript_fingerprints(-10, fetched) == direct(fetched)
    await db.conn.execute("UPDATE messages SET content='edited' WHERE id=?", (first,))
    await db.conn.commit()
    edited = await rows()
    assert dao._transcript_fingerprints(-10, edited) == direct(edited) != direct(fetched)


@pytest.mark.asyncio
async def test_native_anchor_is_rebuilt_when_transcript_moves_before_the_writer(db, monkeypatch):
    dao = MessageDAO(db)
    await dao.ensure_session(-10)
    await dao.add(-10, "user", "visible user")
    original = dao._controller_context_anchor
    moved = []

    async def anchor(chat_id, *, connection=None):
        result = await original(chat_id, connection=connection)
        if connection is None and not moved:
            moved.append(await dao.add(-10, "assistant", "arrived before the writer"))
        return result

    monkeypatch.setattr(dao, "_controller_context_anchor", anchor)
    identity = dict(conversation_uuid="conversation-1", session_id="session-1", protocol="anthropic",
                    model="m", model_label="provider/m")
    await dao.save_controller_model_context(-10, state={"messages": []}, **identity)
    stored = json.loads((await (await db.conn.execute(
        "SELECT state_json FROM controller_model_contexts WHERE chat_id=-10")).fetchone())[0])
    assert moved and stored["anchor"]["sourceHighWater"] == moved[0]
    assert await MessageDAO(db).load_controller_model_context(-10, **identity) is not None
