"""Isolated systemd fixture: no OpenBear config, database, Bot or business runtime."""
from __future__ import annotations

import asyncio
import signal
import sys
import time
from pathlib import Path

from app.systemd_notify import CONFIG_ERROR_EXIT, SystemdNotify


async def run(mode: str, state: Path) -> None:
    count = int(state.read_text()) + 1 if state.exists() else 1
    state.write_text(str(count))
    if mode == "config-error":
        raise SystemExit(CONFIG_ERROR_EXIT)
    if mode == "startup-stall":
        await asyncio.Event().wait()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    notifier = SystemdNotify.from_environment()
    await notifier.ready()
    if mode == "stall" or (mode == "recover" and count == 1):
        time.sleep(30)
    try:
        await stop.wait()
    finally:
        await notifier.stopping()


if __name__ == "__main__":
    asyncio.run(run(sys.argv[1], Path(sys.argv[2])))
