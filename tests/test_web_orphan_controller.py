"""Background round facts cannot consume input without a live controller."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.agent import steering
from app.media.attachments import InboundMedia
from app.runtime.scheduler import ControllerRuns
from tests import test_web_admin

web_env = test_web_admin.web_env


@pytest.mark.parametrize("task_status", ["running", "needs_openbear_control"])
@pytest.mark.parametrize("with_attachment", [False, True])
async def test_agent_without_controller_accepts_new_input_with_task_context(
    web_env, monkeypatch, tmp_path, task_status, with_attachment,
):
    server = web_env.server
    server.runs = ControllerRuns()
    row = await server._create_web_conversation(123, title="orphan controller")
    chat_id = int(row["internal_chat_id"])
    conv_uuid = row["conversation_uuid"]
    live = server._live_for(row)
    task_uuid = await server.agent_dao.create_task(
        chat_id=chat_id, parent_session_uuid=conv_uuid, workflow_uuid="wf-test",
        title="Existing Agent", status=task_status, task_uuid="orphan-agent",
    )
    await live.publish({"type": "accepted", "turnUuid": "old-root"})
    await live.publish({"type": "user", "turnUuid": "old-root", "text": "old input"})
    await live.publish({"type": "done", "turnUuid": "old-root"})
    assert not server.runs.is_running(chat_id)
    assert "agent" in (await server._web_active_round_info(conv_uuid, chat_id))["activeReasons"]
    calls = []

    async def run(chat_id_arg, text, renderer, **kwargs):
        calls.append((chat_id_arg, text, kwargs))
        await renderer.finalize("Controller resumed")
        await renderer.close()

    monkeypatch.setattr(server, "_run_web_turn", run)
    media = []
    if with_attachment:
        path = tmp_path / "input.txt"
        path.write_text("attachment body", encoding="utf-8")
        media = [InboundMedia(
            kind="file", upload_type="websocket_upload", file_name="input.txt", mime_type="text/plain",
            size=path.stat().st_size, path=str(path),
        )]
    try:
        result = await server._start_or_steer_web_conversation(row, "new input", media, live)
        assert result == {"ok": True, "queued": False}
        controller = server.runs.task(chat_id)
        assert controller is not None
        await asyncio.wait_for(controller, 2)
        assert len(calls) == 1
        assert calls[0][:2] == (chat_id, "new input")
        assert calls[0][2]["media"] == media
        context = calls[0][2]["background_control_payload"]
        assert context["activeBackgroundTasks"][0]["taskUuid"] == task_uuid
        assert context["activeBackgroundTasks"][0]["status"] == task_status
        assert (await server.agent_dao.get_task(task_uuid)).status == task_status
        assert await server.agent_dao.pending_controls(task_uuid) == []
        assert not steering.has_pending(chat_id)
        new_input = next(
            op for op in await server._web_operations(conv_uuid)
            if op["opType"] == "user_message" and op["payload"].get("text") == "new input"
        )
        assert new_input["turnUuid"] != "old-root"
        assert not new_input["payload"].get("queued")
        if with_attachment:
            assert new_input["payload"]["attachments"][0]["fileName"] == "input.txt"
    finally:
        await server.runs.cancel_all_and_wait()
        steering.clear(chat_id)


@pytest.mark.parametrize("background", ["process", "notification"])
async def test_background_only_round_starts_input_consumer(web_env, monkeypatch, background):
    server = web_env.server
    server.runs = ControllerRuns()
    row = await server._create_web_conversation(123, title="background only")
    chat_id = int(row["internal_chat_id"])
    conv_uuid = row["conversation_uuid"]
    if background == "process":
        monkeypatch.setattr(
            "app.web_console.conversations.processes.active_for_chat",
            lambda cid: [SimpleNamespace(
                chat_id=cid, session_uuid=conv_uuid, turn_uuid="old-root", run_root_turn_uuid="old-root",
            )],
        )
    else:
        server._web_task_notification_deferred[conv_uuid] = [{"rootTurnUuid": "old-root"}]
    assert background in (await server._web_active_round_info(conv_uuid, chat_id))["activeReasons"]
    calls = []

    async def run(chat_id_arg, text, renderer, **kwargs):
        calls.append(text)
        await renderer.finalize("Accepted")
        await renderer.close()

    monkeypatch.setattr(server, "_run_web_turn", run)
    try:
        result = await server._start_or_steer_web_conversation(row, "new input", [], server._live_for(row))
        assert result == {"ok": True, "queued": False}
        controller = server.runs.task(chat_id)
        assert controller is not None
        await asyncio.wait_for(controller, 2)
        assert calls == ["new input"]
        assert not steering.has_pending(chat_id)
    finally:
        server._web_task_notification_deferred.pop(conv_uuid, None)
        await server.runs.cancel_all_and_wait()
        steering.clear(chat_id)


async def test_controller_exiting_during_reference_preparation_is_rechecked(web_env, monkeypatch):
    server = web_env.server
    server.runs = ControllerRuns()
    row = await server._create_web_conversation(123, title="controller exit during prepare")
    chat_id = int(row["internal_chat_id"])
    live = server._live_for(row)
    release = asyncio.Event()
    old_controller = asyncio.create_task(release.wait())
    server.runs.register(chat_id, old_controller)
    original_prepare = server._prepare_reference_bundle
    calls = []

    async def prepare(*args, **kwargs):
        release.set()
        await old_controller
        return await original_prepare(*args, **kwargs)

    async def run(chat_id_arg, text, renderer, **kwargs):
        calls.append(text)
        await renderer.finalize("Accepted after old controller exited")
        await renderer.close()

    monkeypatch.setattr(server, "_prepare_reference_bundle", prepare)
    monkeypatch.setattr(server, "_run_web_turn", run)
    try:
        result = await server._start_or_steer_web_conversation(row, "new input", [], live)
        assert result == {"ok": True, "queued": False}
        controller = server.runs.task(chat_id)
        assert controller is not None and controller is not old_controller
        await asyncio.wait_for(controller, 2)
        assert calls == ["new input"]
        assert not steering.has_pending(chat_id)
    finally:
        release.set()
        await server.runs.cancel_all_and_wait()
        steering.clear(chat_id)
