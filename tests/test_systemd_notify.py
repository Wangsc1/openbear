from __future__ import annotations

import asyncio
import os
import socket
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.systemd_notify import CONFIG_ERROR_EXIT, SystemdNotify


@pytest.fixture(autouse=True)
def clean_notify_environment(monkeypatch):
    for key in ("NOTIFY_SOCKET", "WATCHDOG_PID", "WATCHDOG_USEC"):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def receiver(tmp_path):
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
        address = str(tmp_path / "notify.sock")
        sock.bind(address)
        sock.setblocking(False)
        yield sock, address


async def receive(sock):
    return (await asyncio.wait_for(asyncio.get_running_loop().sock_recv(sock, 4096), 1)).decode()


async def test_no_systemd_environment_is_noop():
    notifier = SystemdNotify.from_environment({})
    await notifier.ready()
    await notifier.stopping()
    assert not notifier.address and notifier._task is None


def test_other_platform_is_noop(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    assert not SystemdNotify.from_environment({"NOTIFY_SOCKET": "/missing"}).address


def test_child_process_does_not_notify_for_parent():
    assert not SystemdNotify.from_environment({
        "NOTIFY_SOCKET": "/missing", "WATCHDOG_PID": str(os.getpid() + 1),
        "WATCHDOG_USEC": "60000000",
    }).address


@pytest.mark.parametrize("extra", [
    {"WATCHDOG_USEC": "wrong"}, {"WATCHDOG_USEC": "-1"},
    {"WATCHDOG_PID": "wrong"}, {"NOTIFY_SOCKET": "relative"},
])
def test_invalid_systemd_environment_fails(extra):
    with pytest.raises(RuntimeError, match="Invalid systemd"):
        SystemdNotify.from_environment({"NOTIFY_SOCKET": "/notify", **extra})


async def test_ready_only_and_idempotent_stop(receiver):
    sock, address = receiver
    notifier = SystemdNotify.from_environment({"NOTIFY_SOCKET": address})
    await notifier.ready(bot=object())
    assert await receive(sock) == "READY=1\nSTATUS=OpenBear ready"
    await notifier.ready()
    assert notifier._task is None
    await notifier.stopping()
    assert await receive(sock) == "STOPPING=1\nSTATUS=OpenBear stopping"
    await notifier.stopping()
    await notifier.ready()
    with pytest.raises(BlockingIOError):
        sock.recv(4096)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux abstract sockets")
async def test_abstract_notification_socket():
    address = f"openbear-test-{os.getpid()}-{os.urandom(6).hex()}"
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
        sock.bind("\0" + address)
        sock.setblocking(False)
        notifier = SystemdNotify.from_environment({"NOTIFY_SOCKET": "@" + address})
        await notifier.ready()
        assert "READY=1" in await receive(sock)
        await notifier.stopping()


async def test_async_work_keeps_watchdog_alive_and_stop_cancels_it(receiver):
    sock, address = receiver
    notifier = SystemdNotify.from_environment({
        "NOTIFY_SOCKET": address, "WATCHDOG_USEC": "250000", "WATCHDOG_PID": str(os.getpid()),
    })
    await notifier.ready()
    assert "WATCHDOG=1" in await receive(sock)
    assert notifier._task.get_loop() is asyncio.get_running_loop()
    # Longer than the 0.25s watchdog; pings every 0.0625s (~5 expected).
    await asyncio.sleep(0.35)
    messages = []
    while True:
        try:
            messages.append(sock.recv(4096).decode())
        except BlockingIOError:
            break
    assert len(messages) >= 3 and set(messages) == {"WATCHDOG=1"}
    await notifier.stopping()
    assert notifier._task.cancelled()
    assert "STOPPING=1" in await receive(sock)
    await asyncio.sleep(0.15)  # > 2 ping intervals: a live task would have sent again
    with pytest.raises(BlockingIOError):
        sock.recv(4096)


async def test_missed_deadline_is_not_revived(receiver):
    sock, address = receiver
    notifier = SystemdNotify(address, 0.04)
    await notifier._watchdog(asyncio.get_running_loop().time() - 1)
    with pytest.raises(BlockingIOError):
        sock.recv(4096)


async def test_notification_failure_is_not_reported_as_ready(tmp_path):
    notifier = SystemdNotify(str(tmp_path / "missing"), 1)
    with pytest.raises(RuntimeError, match="readiness"):
        await notifier.ready()
    assert not notifier._ready and notifier._task is None
    await notifier.stopping()


async def test_watchdog_send_failure_stops_without_retry_spam(monkeypatch):
    notifier = SystemdNotify("/notify", 0.04)
    send = Mock(return_value=False)
    monkeypatch.setattr(notifier, "_notify", send)
    await notifier._watchdog(asyncio.get_running_loop().time() + 1)
    send.assert_called_once_with("WATCHDOG=1")


@pytest.fixture
def entrypoint(monkeypatch):
    from app import main

    events = []
    config = SimpleNamespace(
        managed=SimpleNamespace(enabled=False), log_level="INFO",
        telegram=SimpleNamespace(mode="polling", bot_token="test", webhook_host="https://example.test",
                                 webhook_secret="test", webhook_port=0),
        models=SimpleNamespace(primary="test"), validate_for_startup=lambda: [],
    )

    def mark(name):
        async def call(*_, **__):
            events.append(name)
        return call

    bot = SimpleNamespace(
        session=SimpleNamespace(close=mark("bot-close")),
        delete_webhook=mark("delete-webhook"), set_webhook=mark("set-webhook"),
    )
    service = SimpleNamespace(startup=mark("service-start"), shutdown=mark("service-stop"))
    notifier = SimpleNamespace(ready=mark("ready"), stopping=mark("stopping"))
    monkeypatch.setattr(main, "get_config", lambda: config)
    monkeypatch.setattr(main, "setup_logging", lambda _: None)
    monkeypatch.setattr(main, "Bot", lambda *a, **k: bot)
    monkeypatch.setattr(main, "Services", lambda *a: service)
    monkeypatch.setattr(main.SystemdNotify, "from_environment", lambda: notifier)
    monkeypatch.setattr(main, "_drain_startup_backlog", mark("backlog"))
    monkeypatch.setattr(main, "_telegram_startup_notices", AsyncMock())
    return main, config, service, notifier, events


async def test_polling_ready_after_required_startup_and_stop_before_cleanup(entrypoint, monkeypatch):
    main, _, _, _, events = entrypoint
    from aiogram import Dispatcher

    dispatcher = Dispatcher()

    async def poll(*args, **kwargs):
        assert events == ["service-start", "delete-webhook", "backlog"]
        await dispatcher.emit_startup()
        events.append("polling")
        await dispatcher.emit_shutdown()

    monkeypatch.setattr(dispatcher, "start_polling", poll)
    monkeypatch.setattr(main, "build_dispatcher", lambda _: dispatcher)
    await main.run()
    assert events.index("backlog") < events.index("ready") < events.index("polling")
    assert events.index("stopping") < events.index("service-stop") < events.index("bot-close")


async def test_startup_failure_never_sends_ready(entrypoint):
    main, _, service, _, events = entrypoint
    service.startup = AsyncMock(side_effect=RuntimeError("startup"))
    with pytest.raises(RuntimeError, match="startup"):
        await main.run()
    assert events == ["stopping", "service-stop", "bot-close"]


async def test_managed_ready_and_cancel_cleanup(entrypoint, monkeypatch, tmp_path):
    main, config, _, _, events = entrypoint
    config.managed = SimpleNamespace(enabled=True, workspace_root=str(tmp_path))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(os, "umask", Mock())
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "add_signal_handler", Mock())
    monkeypatch.setattr(loop, "remove_signal_handler", Mock())
    task = asyncio.create_task(main.run())
    await asyncio.sleep(0)
    assert events == ["service-start", "ready"]
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert events == ["service-start", "ready", "stopping", "service-stop"]


async def test_webhook_ready_only_after_listener_started(entrypoint, monkeypatch):
    main, config, _, _, events = entrypoint
    config.telegram.mode = "webhook"
    import aiogram.webhook.aiohttp_server as hooks

    runner = SimpleNamespace(setup=AsyncMock(), cleanup=AsyncMock())

    async def listen():
        assert "ready" not in events
        events.append("listening")

    monkeypatch.setattr(main, "build_dispatcher", lambda _: object())
    monkeypatch.setattr(hooks, "SimpleRequestHandler", Mock())
    monkeypatch.setattr(hooks, "setup_application", Mock())
    monkeypatch.setattr(main.web, "AppRunner", lambda _: runner)
    monkeypatch.setattr(main.web, "TCPSite", lambda *a, **k: SimpleNamespace(start=listen))
    task = asyncio.create_task(main.run())
    await asyncio.sleep(0)
    assert events.index("listening") < events.index("ready")
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert events.index("stopping") < events.index("service-stop")
    runner.cleanup.assert_awaited_once()


@pytest.mark.parametrize("error", [ValueError("secret-value"), FileNotFoundError("secret-value"),
                                  PermissionError("secret-value")])
async def test_config_error_uses_non_restart_exit_without_secrets(monkeypatch, capsys, error):
    from app import main

    monkeypatch.setattr(main, "get_config", Mock(side_effect=error))
    with pytest.raises(SystemExit) as exc:
        await main.run()
    assert exc.value.code == CONFIG_ERROR_EXIT
    assert "secret-value" not in capsys.readouterr().err


async def test_semantic_config_error_is_not_retried(entrypoint):
    main, config, _, _, events = entrypoint
    config.validate_for_startup = lambda: ["missing required configuration"]
    with pytest.raises(SystemExit) as exc:
        await main.run()
    assert exc.value.code == CONFIG_ERROR_EXIT and not events


async def test_unexpected_config_failure_is_not_classified_as_permanent(monkeypatch):
    from app import main

    monkeypatch.delenv("OPENBEAR_INSTANCE_ROLE", raising=False)
    monkeypatch.setattr(main, "get_config", Mock(side_effect=RuntimeError("unexpected")))
    with pytest.raises(RuntimeError, match="unexpected"):
        await main.run()


def test_unit_has_matching_watchdog_and_bounded_restart_policy():
    unit = (Path(__file__).resolve().parents[1] / "openbear.service").read_text()
    for setting in (
        "Type=notify", "NotifyAccess=main", "WatchdogSec=60", "TimeoutStartSec=180",
        "TimeoutStopSec=90", "TimeoutAbortSec=15", "Restart=on-failure", "RestartSec=10",
        f"RestartPreventExitStatus={CONFIG_ERROR_EXIT}", "StartLimitIntervalSec=10min", "StartLimitBurst=10",
    ):
        assert setting in unit.splitlines()
