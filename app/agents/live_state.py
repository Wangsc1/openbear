"""Newest in-memory progress of running Agent tasks.

Streaming status, model-output progress and partial output are refreshed many
times per model call. Only the latest value matters and it is meaningless once
the call ends, so it is never written to the task row or the event log. A
process restart drops it together with the task's execution.
"""
from __future__ import annotations

from typing import Any

from app.agents.schemas import ACTIVE_TASK_STATUSES

_ACTIVE_STATUSES = frozenset(ACTIVE_TASK_STATUSES)
_states: dict[str, dict[str, Any]] = {}


def update(
    task_uuid: str, *,
    status: str | None = None,
    progress: dict[str, Any] | None = None,
    output: dict[str, Any] | None = None,
) -> None:
    state = _states.setdefault(str(task_uuid), {})
    if status is not None:
        state["currentStatus"] = status
    if progress is not None:
        state["progress"] = dict(progress)
    if output is not None:
        state["output"] = dict(output)


def progress(task_uuid: str) -> dict[str, Any] | None:
    value = (_states.get(str(task_uuid)) or {}).get("progress")
    return dict(value) if isinstance(value, dict) else None


def clear(task_uuid: str) -> None:
    _states.pop(str(task_uuid), None)


def current_status(task: Any) -> str:
    """The task's status line, preferring live progress while it runs."""
    stored = str(getattr(task, "current_status", "") or "")
    if str(getattr(task, "status", "") or "") not in _ACTIVE_STATUSES:
        return stored
    return str((_states.get(str(getattr(task, "task_uuid", "") or "")) or {}).get("currentStatus") or stored)


def apply_public(task: Any, payload: dict[str, Any], *, include_progress: bool = False) -> dict[str, Any]:
    """Overlay the live status line and partial output onto a public task payload.

    ``include_progress`` adds ``liveProgress`` for UI pushes only (model
    streaming telemetry is not controller-visible). It is ``False`` when absent:
    payload patches are deep-merged, so an omitted key would keep a finished
    call's progress.
    """
    state = None
    if str(getattr(task, "status", "") or "") in _ACTIVE_STATUSES:
        state = _states.get(str(getattr(task, "task_uuid", "") or ""))
    if include_progress:
        payload["liveProgress"] = dict(state["progress"]) if state and isinstance(state.get("progress"), dict) else False
    if not state:
        return payload
    if state.get("currentStatus"):
        payload["currentStatus"] = state["currentStatus"]
    if isinstance(state.get("output"), dict) and "output" in payload:
        stored = payload.get("output") if isinstance(payload.get("output"), dict) else {}
        payload["output"] = {**stored, **state["output"]}
    return payload
