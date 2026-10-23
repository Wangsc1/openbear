"""Deterministic model-save / real send-and-run boundary regressions."""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

import pytest

from app.db.dao import MessageDAO
from tests.test_controller_model_switch import (
    FACT,
    MARKER,
    NEW,
    OLD,
    checkpoint,
    choose,
    originals,
    run,
    setup,
)
from tests.test_web_admin import web_env as web_env


class Barrier:
    def __init__(self):
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def pause(self):
        self.entered.set()
        await asyncio.wait_for(self.release.wait(), 10)

    async def wait(self):
        await asyncio.wait_for(self.entered.wait(), 10)


async def window(x):
    cur = await x.env.db.conn.execute(
        "SELECT * FROM context_windows WHERE owner_kind='controller' AND conversation_uuid=?",
        (x.uuid,),
    )
    row = await cur.fetchone()
    return dict(row) if row else None


async def send(x, text="Continue through the real send/register path"):
    server = x.env.server
    row = await server._conversation_row(123, x.uuid, require=True)
    result = await server._start_or_steer_web_conversation(row, text, [], server._live_for(row))
    assert result["ok"] and not result["queued"]
    task = server.runs.task(x.chat)
    assert task is not None
    return task


@asynccontextmanager
async def running_turn(x, model=OLD):
    barrier = Barrier()
    backend = x.backends[model]
    previous = backend.on_call
    backend.on_call = barrier.pause
    task = None
    try:
        task = await send(x)
        await barrier.wait()
        yield task
    finally:
        barrier.release.set()
        if task is not None:
            assert await asyncio.wait_for(task, 10) is True
        backend.on_call = previous


def pause_preferences(monkeypatch, x):
    """Pause the first preference read, not subsequent reads by the real runner."""
    barrier = Barrier()
    original = MessageDAO.get_thinking_level

    async def read(dao, chat_id):
        if dao._db is x.env.db and chat_id == x.chat and not barrier.entered.is_set():
            await barrier.pause()
        return await original(dao, chat_id)

    monkeypatch.setattr(MessageDAO, "get_thinking_level", read)
    return barrier


async def test_model_save_serializes_actual_websocket_start(web_env, monkeypatch, tmp_path):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    await run(x)
    before = await checkpoint(x)
    preferences = pause_preferences(monkeypatch, x)
    starting, upstream = Barrier(), Barrier()
    original_start = web_env.server._start_or_steer_web_conversation

    async def start(*args, **kwargs):
        starting.entered.set()
        return await original_start(*args, **kwargs)

    monkeypatch.setattr(web_env.server, "_start_or_steer_web_conversation", start)
    x.backends[NEW].on_call = upstream.pause
    choice = asyncio.create_task(choose(x, NEW))
    ws = None
    try:
        await preferences.wait()
        assert await web_env.server.operation_locks.current_operation(x.chat) == "web_model"
        ws = await web_env.client.ws_connect(
            f"/api/conversations/{x.uuid}/ws",
            headers={"Cookie": f"openbear_web_session={x.cookie['openbear_web_session']}"},
        )
        await ws.send_json({"type": "send", "text": "Use the committed model", "requestId": "during-save"})
        await starting.wait()
        assert not web_env.server.runs.is_running(x.chat)
        assert await checkpoint(x) == before
        preferences.release.set()
        assert (await choice)["nextRun"] is False
        await upstream.wait()
        assert web_env.server.runs.is_running(x.chat)
        current = await checkpoint(x)
        # Only the new run's own pre-request checkpoint, never the old chain.
        assert current is None or (current["model_label"] == NEW and MARKER not in current["state_json"])
        assert MARKER not in json.dumps(x.backends[NEW].wires[-1])
        assert FACT in json.dumps(x.backends[NEW].wires[-1])
    finally:
        preferences.release.set()
        upstream.release.set()
        await asyncio.wait_for(choice, 10)
        task = web_env.server.runs.task(x.chat)
        if task is not None:
            assert await asyncio.wait_for(task, 10) is True
        if ws is not None:
            await ws.close()
    assert (await checkpoint(x))["model_label"] == NEW


async def test_save_waits_for_send_registration_and_preserves_active_chain(web_env, monkeypatch, tmp_path):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    await run(x)
    before = await checkpoint(x)
    accepting, upstream = Barrier(), Barrier()
    requested = asyncio.Event()
    live = web_env.server._live_for(x.row)
    original_publish = live.publish
    original_acquire = web_env.server.operation_locks._acquire

    async def publish(event, **kwargs):
        if event.get("type") == "accepted":
            await accepting.pause()
        return await original_publish(event, **kwargs)

    async def acquire(chat_id, operation, **kwargs):
        # Observe the real lock request; acquisition/queueing remain unmodified.
        if chat_id == x.chat and operation == "web_model":
            requested.set()
        return await original_acquire(chat_id, operation, **kwargs)

    monkeypatch.setattr(live, "publish", publish)
    monkeypatch.setattr(web_env.server.operation_locks, "_acquire", acquire)
    x.backends[OLD].on_call = upstream.pause
    sending = asyncio.create_task(send(x))
    choice = task = None
    try:
        await accepting.wait()
        assert not web_env.server.runs.is_running(x.chat)
        choice = asyncio.create_task(choose(x, NEW))
        await asyncio.wait_for(requested.wait(), 10)
        assert not choice.done()
        assert await checkpoint(x) == before
        accepting.release.set()
        task = await sending
        await upstream.wait()
        response = await choice
        assert response["nextRun"] is True
        # The switch leaves the active chain alone; the running request has
        # re-bound it to its own prepared context under the original model.
        current = await checkpoint(x)
        assert current["model_label"] == before["model_label"] == OLD
        assert MARKER in current["state_json"]
        assert MARKER in json.dumps(x.backends[OLD].wires[-1])
        assert not x.backends[NEW].seen_convos
    finally:
        accepting.release.set()
        upstream.release.set()
        task = await asyncio.wait_for(sending, 10)
        assert await asyncio.wait_for(task, 10) is True
        if choice is not None:
            await asyncio.wait_for(choice, 10)
    assert (await checkpoint(x))["model_label"] == OLD
    assert MARKER in (await checkpoint(x))["state_json"]


@pytest.mark.parametrize("slow_model", [NEW, OLD])
async def test_parallel_save_rechecks_selected_model_after_old_request_snapshot(
    web_env, monkeypatch, tmp_path, slow_model,
):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    await run(x)
    snapshot = Barrier()
    original_body = web_env.server._json_body

    async def body(request):
        value = await original_body(request)
        if request.path.endswith("/model") and not snapshot.entered.is_set():
            # _conversation_from_request has returned A, before lock acquisition.
            await snapshot.pause()
        return value

    monkeypatch.setattr(web_env.server, "_json_body", body)
    slow = asyncio.create_task(choose(x, slow_model))
    try:
        await snapshot.wait()
        await choose(x, NEW)
        async with running_turn(x, NEW):
            pass
        saved, measured = await checkpoint(x), await window(x)
        history = await originals(x)
        assert saved["model_label"] == NEW
        snapshot.release.set()
        assert (await slow)["nextRun"] is False
        assert await originals(x) == history
        if slow_model == NEW:
            assert await checkpoint(x) == saved
            assert await window(x) == measured
        else:
            assert await checkpoint(x) is None
            after = await window(x)
            assert after["window_version"] == measured["window_version"] + 1
            assert (after["usage_known"], after["usage_tokens"], after["route_fingerprint"]) == (0, 0, "")
    finally:
        snapshot.release.set()
        await asyncio.wait_for(slow, 10)


async def test_websocket_refreshes_again_inside_acceptance_lock(web_env, monkeypatch, tmp_path):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    await run(x)
    snapshot, upstream = Barrier(), Barrier()
    original_start = web_env.server._start_or_steer_web_conversation

    async def start(row, *args, **kwargs):
        assert row["model"] == OLD
        await snapshot.pause()
        return await original_start(row, *args, **kwargs)

    monkeypatch.setattr(web_env.server, "_start_or_steer_web_conversation", start)
    x.backends[NEW].on_call = upstream.pause
    ws = await web_env.client.ws_connect(
        f"/api/conversations/{x.uuid}/ws",
        headers={"Cookie": f"openbear_web_session={x.cookie['openbear_web_session']}"},
    )
    try:
        await ws.send_json({"type": "send", "text": "Refresh inside the lock", "requestId": "stale-row"})
        await snapshot.wait()
        await choose(x, NEW)
        snapshot.release.set()
        await upstream.wait()
        assert MARKER not in json.dumps(x.backends[NEW].wires[-1])
        assert FACT in json.dumps(x.backends[NEW].wires[-1])
    finally:
        snapshot.release.set()
        upstream.release.set()
        task = web_env.server.runs.task(x.chat)
        if task is not None:
            assert await asyncio.wait_for(task, 10) is True
        await ws.close()
    assert (await checkpoint(x))["model_label"] == NEW


async def test_runner_can_finish_during_save_preparation(web_env, monkeypatch, tmp_path):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    await run(x)
    choice = None
    preferences = None
    try:
        async with running_turn(x):
            preferences = pause_preferences(monkeypatch, x)
            choice = asyncio.create_task(choose(x, NEW))
            await preferences.wait()
        # The real run completed and saved A while the HTTP request was pending.
        assert not web_env.server.runs.is_running(x.chat)
        assert (await checkpoint(x))["model_label"] == OLD
        preferences.release.set()
        assert (await choice)["nextRun"] is False
        assert await checkpoint(x) is None
        assert (await window(x))["usage_known"] == 0
    finally:
        if preferences is not None:
            preferences.release.set()
        if choice is not None:
            await asyncio.wait_for(choice, 10)


@pytest.mark.parametrize("private", ["valid", "missing", "stale_anchor", "invalid_messages"])
async def test_idle_return_to_unleft_model_uses_actual_context_identity(
    web_env, monkeypatch, tmp_path, private,
):
    x = await setup(web_env, monkeypatch, tmp_path, "responses")
    await run(x)
    async with running_turn(x):
        assert (await choose(x, NEW))["nextRun"] is True
    saved = await checkpoint(x)
    assert saved["model_label"] == OLD
    assert not x.backends[NEW].seen_convos
    if private == "missing":
        await MessageDAO(web_env.db).clear_controller_model_context(x.chat)
    elif private == "stale_anchor":
        await web_env.db.conn.execute(
            "UPDATE controller_model_contexts SET state_json=json_set(state_json,'$.anchor.windowVersion',-1) WHERE chat_id=?",
            (x.chat,),
        )
        await web_env.db.conn.commit()
    elif private == "invalid_messages":
        await web_env.db.conn.execute(
            "UPDATE controller_model_contexts SET state_json=json_set(state_json,'$.messages',json('[1]')) WHERE chat_id=?",
            (x.chat,),
        )
        await web_env.db.conn.commit()
    await web_env.db.conn.execute(
        "UPDATE context_windows SET usage_known=1,usage_tokens=321 WHERE conversation_uuid=?", (x.uuid,),
    )
    await web_env.db.conn.commit()
    measured, history = await window(x), await originals(x)
    session = await MessageDAO(web_env.db).current_session_uuid(x.chat)
    assert (await choose(x, OLD))["nextRun"] is False
    assert await checkpoint(x) == (saved if private == "valid" else None)
    assert await window(x) == measured
    assert await originals(x) == history
    assert await MessageDAO(web_env.db).current_session_uuid(x.chat) == session
    async with running_turn(x):
        outgoing = json.dumps(x.backends[OLD].wires[-1])
        assert (MARKER in outgoing) is (private == "valid")
        assert FACT in outgoing
    assert x.executions == ["read"]
