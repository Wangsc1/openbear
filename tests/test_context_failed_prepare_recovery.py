"""A send that archives its model-side input and then fails the budget must not lock the conversation,
and a committed rotation is metered the same way by the next prepare."""
from __future__ import annotations

import pytest

from app.context.builder import build_controller_history
from app.context.runtime import WindowRuntime
from app.context.store import ContextOwner, WindowStore
from app.context.window import RequiredContextTooLarge, WindowPolicy, mark_source
from app.db.dao import MessageDAO
from app.db.engine import DB

SUFFIX = "\n\n<message-meta time=\"2026-10-19 20:36:19\" source=\"web\"/>"


class _Backend:
    protocol = "chat"


@pytest.fixture
async def db(tmp_path):
    database = DB(str(tmp_path / "failed-prepare.db"))
    await database.connect()
    try:
        yield database
    finally:
        await database.close()


def _runtime(store, trigger):
    return WindowRuntime(store, WindowPolicy(context_window=1_000_000, trigger_tokens=trigger), backend=_Backend(), model="test")


def _user(text, message_id, turn=""):
    # Real Web turns carry their run root, which identifies the active input.
    turn = turn or f"turn-{message_id}"
    return mark_source({"role": "user", "content": text}, kind="human",
                       source_id=f"message:{message_id}", message_id=message_id,
                       turn_uuid=turn, run_root_turn_uuid=turn)


async def test_archived_suffix_survives_a_failed_budget_check(db):
    dao = MessageDAO(db)
    session = await dao.get_or_create_session_uuid(40)
    store = WindowStore(db, ContextOwner.controller(chat_id=40, session_uuid=session, conversation_uuid="c"))
    first = await dao.add(40, "user", "hello", turn_uuid="turn-a", run_root_turn_uuid="turn-a")
    await _runtime(store, 100_000).prepare([_user("hello" + SUFFIX, first, "turn-a")], system="sys", tools=[])

    # Like the Web runner: history is built first, then the current row is saved;
    # the public row keeps only the visible text, the model input carries the suffix.
    history = await build_controller_history(dao, 40)
    failing = await dao.add(40, "user", "short public text", turn_uuid="turn-b", run_root_turn_uuid="turn-b")
    with pytest.raises(RequiredContextTooLarge):
        await _runtime(store, 5).prepare([*history, _user("short public text" + SUFFIX, failing, "turn-b")], system="sys", tools=[])

    # The next message rebuilds the tail; the failed row must come back as archived.
    history = await build_controller_history(dao, 40)
    later = await dao.add(40, "user", "continue", turn_uuid="turn-c", run_root_turn_uuid="turn-c")
    restored = [m for m in history if (m.get("openbear_context_source") or {}).get("id") == f"message:{failing}"]
    assert restored and restored[0]["content"].endswith(SUFFIX)
    prepared = await _runtime(store, 100_000).prepare([*history, _user("continue" + SUFFIX, later, "turn-c")], system="sys", tools=[])
    assert prepared[-1]["content"].startswith("continue")


async def test_unarchived_tail_still_uses_the_public_row(db):
    dao = MessageDAO(db)
    session = await dao.get_or_create_session_uuid(41)
    store = WindowStore(db, ContextOwner.controller(chat_id=41, session_uuid=session, conversation_uuid="c"))
    first = await dao.add(41, "user", "hello")
    await _runtime(store, 100_000).prepare([_user("hello" + SUFFIX, first)], system="sys", tools=[])
    plain = await dao.add(41, "assistant", "reply text")
    history = await build_controller_history(dao, 41)
    assert history[-1]["content"] == "reply text"
    assert (history[-1]["openbear_context_source"] or {}).get("id") == f"message:{plain}"


async def test_rotation_is_metered_like_the_next_prepare(db):
    """The live failure: tool schemas dominate the request, the rough estimate runs ~29%
    above real usage, and the last real request just crossed the trigger."""
    dao = MessageDAO(db)
    session = await dao.get_or_create_session_uuid(42)
    store = WindowStore(db, ContextOwner.controller(chat_id=42, session_uuid=session, conversation_uuid="c"))
    tools = [{"name": "Big", "description": "schema " * 60000, "parameters": {"type": "object"}}]
    messages = []
    for i in range(12):
        turn = f"turn-{i}"
        message_id = await dao.add(42, "user", f"turn {i} " + "x" * 2000, turn_uuid=turn, run_root_turn_uuid=turn)
        messages.append(_user(f"turn {i} " + "x" * 2000, message_id, turn))
        messages.append(mark_source({"role": "assistant", "content": f"answer {i} " + "y" * 2000},
                                    kind="execution", source_id=f"assistant:{i}", turn_uuid=turn, run_root_turn_uuid=turn))
    runtime = _runtime(store, 10_000_000)
    await runtime.prepare(messages, system="sys", tools=tools)
    real = int(runtime.last_estimate.tokens / 1.29)
    ticket = await runtime.begin_request()
    usage = type("U", (), {"input_tokens": real, "cache_read_tokens": 0, "cache_write_tokens": 0, "output_tokens": 0})()
    assert await runtime.observe_usage(usage, ticket=ticket)

    trigger = real - 10
    window = await _runtime(store, trigger).prepare(messages, system="sys", tools=tools)
    saved = await store.load()
    assert len(window) < len(messages) and saved["window_version"] == 2
    # The window judged to fit must still fit when the next request prepares it.
    assert await _runtime(store, trigger).prepare(window, system="sys", tools=tools)
