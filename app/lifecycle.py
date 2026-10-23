"""Startup readiness shared by lifecycle-owned background consumers."""
from __future__ import annotations


async def wait_for_startup(owner) -> None:
    ready = getattr(owner, "startup_ready", None)
    if ready is not None:
        await ready.wait()
