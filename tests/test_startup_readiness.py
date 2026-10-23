"""Real local SQLite/HTTP lifecycle; no production data, providers or Telegram."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import aiohttp
import pytest

from app.config import Config
from app.services import Services


@pytest.fixture
async def svc(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OPENBEAR_CONFIG", str(tmp_path / "openbear.json"))
    monkeypatch.delenv("OPENBEAR_INSTANCE_ROLE", raising=False)
    config = Config.model_validate({
        "telegram": {"botToken": "test-token", "whitelistIds": [1]},
        "models": {"providers": {}, "primary": "test/model"},
        "memory": {"provider": "builtin"},
        "storage": {"dbPath": str(tmp_path / "test.db")},
        "tools": {"skillsDir": str(tmp_path / "skills")},
        "web": {"enabled": True, "host": "127.0.0.1"},
        "browser": {"enabled": False}, "mcp": {"enabled": False},
    })
    config.web.port = 0
    service = Services(config, SimpleNamespace())
    monkeypatch.setattr(service.models_dev_catalog, "start", AsyncMock())
    monkeypatch.setattr(service.cron, "request_holiday_sync", lambda: None)
    # The calendar updater is unrelated to readiness and would make HTTP calls.
    monkeypatch.setattr(service.cron, "holiday_loop", AsyncMock())
    try:
        yield service
    finally:
        await service.shutdown()


def listening_url(svc):
    port = svc.web_admin._site._server.sockets[0].getsockname()[1]
    return f"http://127.0.0.1:{port}"


async def test_required_recovery_gates_http_schedulers_and_delivery(svc, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    start = svc.collab.start

    async def blocked_start():
        entered.set()
        await release.wait()
        await start()

    monkeypatch.setattr(svc.collab, "start", blocked_start)
    watchers = [
        (svc.webhook_worker, "tick"), (svc.cron, "tick"),
        (svc.instances, "notify_pending"),
        (svc.web_admin.browser_push, "deliver_one"),
        (svc.web_admin.web_task_telegram, "_claim_due"),
        (svc.web_admin.interaction_telegram, "_claim_due"),
        (svc.web_admin.telegram_replies, "process_one"),
    ]
    checks = []
    called = []
    for owner, name in watchers:
        event = asyncio.Event()
        called.append(event)
        check = AsyncMock(side_effect=lambda signal=event: signal.set())
        monkeypatch.setattr(owner, name, check)
        checks.append(check)
    starting = asyncio.create_task(svc.startup())
    try:
        await asyncio.wait_for(entered.wait(), 5)
        url = listening_url(svc)
        async with aiohttp.ClientSession() as client:
            for path in ("/health", "/api/auth/mode", "/api/cron"):
                response = await client.get(url + path)
                assert response.status == 503
                assert (await response.json())["error"] == "service_not_ready"
            assert not svc.startup_ready.is_set()
            for check in checks:
                check.assert_not_awaited()
            release.set()
            await asyncio.wait_for(starting, 5)
            assert svc.startup_ready.is_set()
            assert (await client.get(url + "/health")).status == 200
            await asyncio.wait_for(asyncio.gather(*(event.wait() for event in called)), 2)
            for check in checks:
                check.assert_awaited()
    finally:
        release.set()
        if not starting.done():
            starting.cancel()
        await asyncio.gather(starting, return_exceptions=True)


@pytest.mark.parametrize("cancel", [False, True])
async def test_partial_startup_unwinds_listener_workers_and_database(svc, monkeypatch, cancel):
    entered = asyncio.Event()
    state = {}

    async def failed_start():
        svc.web_admin._enqueue_web_task_notification(
            "recovered", 1, 1, {"_notificationUuid": "pending", "taskUuid": "recovered"},
        )
        state["url"] = listening_url(svc)
        state["tasks"] = [svc.webhook_worker.loop_task, svc.cron.loop_task,
                          svc.web_admin.browser_push.task, svc.web_admin.global_realtime.task,
                          svc.instances.monitor_task, svc.instances.recovery_task]
        entered.set()
        if cancel:
            await asyncio.Event().wait()
        raise RuntimeError("injected required recovery failure")

    monkeypatch.setattr(svc.collab, "start", failed_start)
    starting = asyncio.create_task(svc.startup())
    await asyncio.wait_for(entered.wait(), 5)
    if cancel:
        starting.cancel()
    done, pending = await asyncio.wait({starting}, timeout=5)
    assert not pending
    with pytest.raises(asyncio.CancelledError if cancel else RuntimeError):
        await starting
    assert not svc.startup_ready.is_set()
    assert svc.db._conn is None
    assert svc.web_admin._runner is None
    assert svc.web_admin.browser_push.http is None
    assert all(task.done() for task in state["tasks"] if task)
    assert not svc.web_admin._web_task_notification_workers
    assert not any(task.get_name().startswith("web-task-notification-") for task in asyncio.all_tasks())
    async with aiohttp.ClientSession() as client:
        with pytest.raises(aiohttp.ClientConnectionError):
            await client.get(state["url"] + "/health")
    await svc.shutdown()


async def test_shutdown_error_does_not_skip_database_and_http(svc, monkeypatch):
    await svc.startup()
    close = svc.collab.stop

    async def failing_close():
        await close()
        raise RuntimeError("injected close failure")

    monkeypatch.setattr(svc.collab, "stop", failing_close)
    http_close = AsyncMock(wraps=svc.http.close)
    monkeypatch.setattr(svc.http, "close", http_close)
    await asyncio.wait_for(asyncio.gather(svc.shutdown(), svc.shutdown()), 5)
    assert svc.db._conn is None
    assert svc.web_admin._runner is None
    http_close.assert_awaited_once()


async def test_repeated_shutdown_cancellation_still_drains_resources(svc, monkeypatch):
    await svc.startup()
    entered, release = asyncio.Event(), asyncio.Event()
    close = svc.collab.stop

    async def blocked_close():
        entered.set()
        await release.wait()
        await close()

    monkeypatch.setattr(svc.collab, "stop", blocked_close)
    closing = asyncio.create_task(svc.shutdown())
    await entered.wait()
    closing.cancel()
    await asyncio.sleep(0)
    closing.cancel()
    release.set()
    done, pending = await asyncio.wait({closing}, timeout=5)
    assert not pending
    with pytest.raises(asyncio.CancelledError):
        await closing
    assert svc.db._conn is None
    assert svc.web_admin._runner is None
    assert svc._shutdown_task.done()


async def test_slow_browser_probe_does_not_delay_readiness(svc, monkeypatch):
    entered = asyncio.Event()

    async def slow_probe():
        entered.set()
        await asyncio.Event().wait()

    svc.config.browser.enabled = True
    monkeypatch.setattr(svc.browser, "validate_connection", slow_probe)
    await asyncio.wait_for(svc.startup(), 5)
    await asyncio.wait_for(entered.wait(), 1)
    assert svc.startup_ready.is_set()
    assert not svc._browser_validation_task.done()
    async with aiohttp.ClientSession() as client:
        assert (await client.get(listening_url(svc) + "/health")).status == 200
    await asyncio.wait_for(svc.shutdown(), 5)
    assert svc._browser_validation_task.done()


async def test_browser_push_does_not_prune_during_startup(svc, monkeypatch):
    prune = AsyncMock()
    monkeypatch.setattr(svc.web_admin.browser_push, "prune", prune)
    await svc.startup()
    await asyncio.sleep(0)
    prune.assert_not_awaited()


async def test_retention_continues_slices_without_rescanning_finished_frames(svc, monkeypatch):
    delays = []
    finished = asyncio.Event()
    sleep = asyncio.sleep
    frame_calls = companion_calls = 0

    async def timer(delay, *args, **kwargs):
        if asyncio.current_task().get_name() != "web-event-frame-retention":
            return await sleep(delay, *args, **kwargs)
        delays.append(delay)
        if len(delays) == 4:
            finished.set()
            await asyncio.Event().wait()

    async def frames():
        nonlocal frame_calls
        frame_calls += 1
        svc.web_admin._web_event_frame_retention_pending = frame_calls == 1
        return 1

    async def interactions():
        nonlocal companion_calls
        companion_calls += 1
        svc.web_admin.interactions._maintenance_cursors = {"pending": {}} if companion_calls == 1 else {}
        return 0

    monkeypatch.setattr(asyncio, "sleep", timer)
    monkeypatch.setattr(svc.web_admin, "_prune_web_event_frames", frames)
    monkeypatch.setattr(svc.web_admin.interactions, "prune", interactions)
    monkeypatch.setattr(svc.web_admin, "_prune_web_task_notification_history", AsyncMock(return_value=0))
    monkeypatch.setattr(svc.web_admin.web_task_telegram, "prune", AsyncMock(return_value=(0, 0)))
    monkeypatch.setattr(svc.web_admin.browser_push, "prune", AsyncMock(return_value=(0, 0)))
    await svc.startup()
    await asyncio.wait_for(finished.wait(), 2)
    assert delays == [86400, 1, 1, 86400]
    assert frame_calls == 2 and companion_calls == 2


async def test_main_closes_bot_when_required_startup_fails(monkeypatch):
    from app import main
    config = SimpleNamespace(managed=SimpleNamespace(enabled=False), log_level="INFO",
                             telegram=SimpleNamespace(mode="polling", bot_token="test"),
                             models=SimpleNamespace(primary="test"), validate_for_startup=lambda: [])
    bot = SimpleNamespace(session=SimpleNamespace(close=AsyncMock()))
    service = SimpleNamespace(startup=AsyncMock(side_effect=RuntimeError("startup")), shutdown=AsyncMock())
    monkeypatch.setattr(main, "get_config", lambda: config)
    monkeypatch.setattr(main, "setup_logging", lambda _: None)
    monkeypatch.setattr(main, "Bot", lambda *a, **k: bot)
    monkeypatch.setattr(main, "Services", lambda *a: service)
    with pytest.raises(RuntimeError, match="startup"):
        await main.run()
    service.shutdown.assert_awaited_once()
    bot.session.close.assert_awaited_once()


async def test_main_polls_while_optional_menu_is_blocked(monkeypatch):
    from app import main
    config = SimpleNamespace(managed=SimpleNamespace(enabled=False), log_level="INFO",
                             telegram=SimpleNamespace(mode="polling", bot_token="test"),
                             models=SimpleNamespace(primary="test"), validate_for_startup=lambda: [])
    entered = asyncio.Event()

    async def menu(*_):
        entered.set()
        await asyncio.Event().wait()

    async def poll(*_, **__):
        await asyncio.wait_for(entered.wait(), 1)

    bot = SimpleNamespace(session=SimpleNamespace(close=AsyncMock()), delete_webhook=AsyncMock())
    service = SimpleNamespace(startup=AsyncMock(), shutdown=AsyncMock())
    monkeypatch.setattr(main, "get_config", lambda: config)
    monkeypatch.setattr(main, "setup_logging", lambda _: None)
    monkeypatch.setattr(main, "Bot", lambda *a, **k: bot)
    monkeypatch.setattr(main, "Services", lambda *a: service)
    from aiogram import Dispatcher
    dispatcher = Dispatcher()
    monkeypatch.setattr(dispatcher, "start_polling", poll)
    monkeypatch.setattr(main, "build_dispatcher", lambda _: dispatcher)
    monkeypatch.setattr(main, "setup_menu", menu)
    monkeypatch.setattr(main, "_drain_startup_backlog", AsyncMock())
    await asyncio.wait_for(main.run(), 2)
    service.shutdown.assert_awaited_once()
    bot.session.close.assert_awaited_once()
