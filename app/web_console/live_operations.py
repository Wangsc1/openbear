"""Newest in-memory state of operations between durable frames.

Intermediate progress is broadcast without a frame; this store keeps only the
latest complete payload of each such operation so refresh and reconnect can
render it. A process restart discards it by design: the run is gone as well.
"""
from __future__ import annotations

import copy
import json
import time
from dataclasses import dataclass
from typing import Any

from app.web_operations import (
    LIVE_APPEND_OPERATION_TYPES,
    LIVE_PATCH_OPERATION_TYPES,
    frame_public,
    json_loads_dict,
)

_ROW_FIELDS = (
    "conversation_uuid", "internal_chat_id", "owner_chat_id", "op_id", "op_type",
    "turn_uuid", "parent_turn_uuid", "run_root_turn_uuid", "target_type", "target_id",
    "task_uuid", "run_id", "display_seq", "status", "lifecycle", "internal", "source",
    "revision", "created_at_ms", "updated_at_ms",
)
_LIVE_TYPES = LIVE_APPEND_OPERATION_TYPES | LIVE_PATCH_OPERATION_TYPES
# Agent cards outlive the controller run that created them.
_RUN_INDEPENDENT_TYPES = frozenset({"agent", "agent_control", "agent_supervision"})
# liveRev orders live updates within one stored revision. A state rebuilt from
# the database starts beyond any sequence a client may already hold for it.
_SEED_STRIDE = 1_000_000
_next_seed = int(time.time() * 1000) * 1000


@dataclass
class LiveOperation:
    row: dict[str, Any]
    payload: dict[str, Any]
    live_rev: int = 0
    updated_at_ms: int = 0
    # Live updates not yet in the stored revision.
    updates: int = 0

    @classmethod
    def from_row(cls, row: dict[str, Any], payload: dict[str, Any] | None = None) -> LiveOperation:
        fields = {key: row.get(key) for key in _ROW_FIELDS if key in row}
        body = payload if payload is not None else json_loads_dict(str(row.get("payload_json") or "{}"))
        return cls(row=fields, payload=copy.deepcopy(body), updated_at_ms=int(row.get("updated_at_ms") or 0))

    @classmethod
    def seeded(cls, row: dict[str, Any]) -> LiveOperation:
        """State rebuilt from a stored row, with a fresh liveRev range."""
        global _next_seed
        _next_seed += _SEED_STRIDE
        entry = cls.from_row(row)
        entry.live_rev = _next_seed
        return entry

    @property
    def revision(self) -> int:
        return int(self.row.get("revision") or 0)

    def frame(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        public = frame_public({
            **self.row, "frame_seq": 0, "action": action, "payload": payload,
            "updated_at_ms": self.updated_at_ms, "debug": {},
        })
        public.pop("frameSeq", None)
        public.pop("debug", None)
        # frame_public normalizes some actions (UserInteraction); a live
        # update keeps its own, so a snapshot stays recognizable.
        public["action"] = action
        public["liveRev"] = self.live_rev
        return public

    def snapshot(self) -> dict[str, Any]:
        payload = copy.deepcopy(self.payload)
        if self.row.get("op_type") in LIVE_APPEND_OPERATION_TYPES:
            # Same field the replaced append frames carried.
            payload["textLength"] = len(str(payload.get("text") or ""))
        return self.frame("snapshot", payload)


class LiveOperationStore:
    def __init__(self) -> None:
        self._ops: dict[str, dict[str, LiveOperation]] = {}

    @staticmethod
    def eligible(op_type: str, lifecycle: str, payload: dict[str, Any]) -> bool:
        if op_type not in _LIVE_TYPES or lifecycle == "terminal":
            return False
        return op_type != "stats" or bool(payload.get("live"))

    def get(self, conversation_uuid: str, op_id: str) -> LiveOperation | None:
        return self._ops.get(conversation_uuid, {}).get(op_id)

    def put(self, conversation_uuid: str, op_id: str, entry: LiveOperation) -> None:
        self._ops.setdefault(conversation_uuid, {})[op_id] = entry

    def drop(self, conversation_uuid: str, op_id: str) -> None:
        ops = self._ops.get(conversation_uuid)
        if ops is not None:
            ops.pop(op_id, None)
            if not ops:
                self._ops.pop(conversation_uuid, None)

    def foreground_entries(self, conversation_uuid: str) -> list[LiveOperation]:
        """Operations of the conversation's controller runs (Agent cards outlive them)."""
        return [
            entry for entry in self._ops.get(conversation_uuid, {}).values()
            if entry.row.get("op_type") not in _RUN_INDEPENDENT_TYPES
        ]

    def clear(self, conversation_uuid: str) -> None:
        self._ops.pop(conversation_uuid, None)

    def pending(self, conversation_uuid: str) -> list[LiveOperation]:
        return [entry for entry in self._ops.get(conversation_uuid, {}).values() if entry.updates > 0]

    def overlay(self, conversation_uuid: str, row: dict[str, Any]) -> tuple[dict[str, Any], int]:
        """Return a durable row carrying newer in-memory progress, and its liveRev."""
        entry = self.get(conversation_uuid, str(row.get("op_id") or ""))
        if entry is None or entry.revision != int(row.get("revision") or 0):
            return row, 0
        if entry.updates <= 0:
            return row, entry.live_rev
        return {
            **row,
            "payload_json": json.dumps(entry.payload, ensure_ascii=False, separators=(",", ":")),
            "updated_at_ms": entry.updated_at_ms or row.get("updated_at_ms"),
        }, entry.live_rev
