"""systemd readiness and watchdog notifications from the application event loop."""
from __future__ import annotations

import asyncio
import contextlib
import os
import socket
import sys
from collections.abc import Mapping

from app.logging import get_logger

log = get_logger("systemd")
CONFIG_ERROR_EXIT = 78


class SystemdNotify:
    def __init__(self, address: str = "", watchdog_seconds: float = 0) -> None:
        self.address = address
        self.watchdog_seconds = watchdog_seconds
        self._task: asyncio.Task | None = None
        self._ready = False
        self._stopping = False

    @classmethod
    def from_environment(cls, env: Mapping[str, str] | None = None) -> SystemdNotify:
        env = os.environ if env is None else env
        address = env.get("NOTIFY_SOCKET", "")
        if sys.platform != "linux" or not address:
            return cls()
        try:
            pid = int(env.get("WATCHDOG_PID", str(os.getpid())))
            usec = int(env.get("WATCHDOG_USEC", "0"))
            seconds = usec / 1_000_000
        except (ValueError, OverflowError) as exc:
            raise RuntimeError("Invalid systemd watchdog environment") from exc
        if pid != os.getpid():
            return cls()
        if usec < 0 or not address.startswith(("/", "@")):
            raise RuntimeError("Invalid systemd notification environment")
        return cls("\0" + address[1:] if address.startswith("@") else address, seconds)

    def _notify(self, message: str) -> bool:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
                sock.setblocking(False)
                sock.sendto(message.encode("utf-8"), self.address)
        except OSError as exc:
            log.warning("systemd 通知发送失败", 错误类型=type(exc).__name__)
            return False
        return True

    async def ready(self, **_: object) -> None:
        if not self.address or self._ready or self._stopping:
            return
        message = "READY=1\nSTATUS=OpenBear ready"
        if self.watchdog_seconds:
            message += "\nWATCHDOG=1"
        if not self._notify(message):
            raise RuntimeError("Could not notify systemd of readiness")
        self._ready = True
        if self.watchdog_seconds:
            deadline = asyncio.get_running_loop().time() + self.watchdog_seconds
            self._task = asyncio.create_task(self._watchdog(deadline), name="systemd-watchdog")
        log.info("已通知 systemd 服务就绪", 看门狗秒数=self.watchdog_seconds)

    async def _watchdog(self, deadline: float) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(self.watchdog_seconds / 4)
            # A resumed loop must not revive a watchdog deadline it already missed.
            if loop.time() >= deadline:
                log.error("事件循环错过看门狗期限，停止保活等待 systemd 处理")
                return
            if not self._notify("WATCHDOG=1"):
                return
            deadline = loop.time() + self.watchdog_seconds

    async def stopping(self, **_: object) -> None:
        if self._stopping:
            return
        self._stopping = True
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        if self.address:
            self._notify("STOPPING=1\nSTATUS=OpenBear stopping")
