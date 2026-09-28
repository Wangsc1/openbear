"""Durable run/action lifecycle and control delivery facts (not a transcript or UI store).

IDs and detail/payload are supplied by trusted callers. Do not pass provider-private
state, credentials, full messages or tool outputs here; use references to the
existing context, result and billing stores instead.
"""
from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from app.db.engine import DB, now_ts

RUN_STATUSES = frozenset({"running", "waiting", "completed", "cancelled", "failed", "interrupted", "needs_control"})
TERMINAL_RUN_STATUSES = frozenset({"completed", "cancelled", "failed", "interrupted", "needs_control"})
ACTION_KINDS = frozenset({"model", "tool"})
ACTION_OUTCOMES = frozenset({"completed", "failed", "cancelled", "not_started", "unknown"})


def _object(value: dict[str, Any] | None) -> str:
    if value is not None and not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return json.dumps(value or {}, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _decode(row: Any, *fields: str) -> dict[str, Any] | None:
    if row is None:
        return None
    result = dict(row)
    for field in fields:
        result[field.removesuffix("_json")] = json.loads(result.pop(field))
    return result


def _required(value: str, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a nonempty string")
    return value


class RuntimeStore:
    def __init__(self, db: DB) -> None:
        self.db = db

    async def begin_run(self, owner_key: str, *, run_id: str = "", task_uuid: str = "",
                        root_turn_uuid: str = "", metadata: dict | None = None) -> str:
        _required(owner_key, "owner_key")
        run_id = run_id or uuid.uuid4().hex
        meta = _object(metadata)
        async with self.db.write_transaction(label="runtime-begin-run") as conn:
            cur = await conn.execute("SELECT owner_key,task_uuid,root_turn_uuid,metadata_json FROM runtime_runs WHERE run_id=?", (run_id,))
            row = await cur.fetchone()
            if row is not None:
                if tuple(row) != (owner_key, task_uuid, root_turn_uuid, meta):
                    raise ValueError("run_id already belongs to a different run")
                return run_id  # Never reactivate a terminal run.
            ts = now_ts()
            await conn.execute(
                "INSERT INTO runtime_runs (run_id,owner_key,task_uuid,root_turn_uuid,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                (run_id, owner_key, task_uuid, root_turn_uuid, meta, ts, ts),
            )
        return run_id

    async def transition(self, run_id: str, status: str, *, phase: str = "", detail: dict | None = None) -> None:
        if status not in RUN_STATUSES:
            raise ValueError("invalid run status")
        value = _object(detail)
        async with self.db.write_transaction(label="runtime-transition") as conn:
            cur = await conn.execute("SELECT status,phase,detail_json FROM runtime_runs WHERE run_id=?", (run_id,))
            row = await cur.fetchone()
            if row is None:
                raise ValueError("unknown run_id")
            if row[0] in TERMINAL_RUN_STATUSES:
                if tuple(row) == (status, phase, value):
                    return
                raise ValueError("terminal run cannot transition")
            if tuple(row) == (status, phase, value):
                return
            await conn.execute(
                "UPDATE runtime_runs SET status=?,phase=?,detail_json=?,revision=revision+1,updated_at=? WHERE run_id=?",
                (status, phase, value, now_ts(), run_id),
            )

    async def begin_action(self, run_id: str, kind: str, *, action_id: str = "", call_id: str = "",
                           name: str = "", detail: dict | None = None) -> str:
        if kind not in ACTION_KINDS:
            raise ValueError("invalid action kind")
        action_id = action_id or uuid.uuid4().hex
        value = _object(detail)
        async with self.db.write_transaction(label="runtime-begin-action") as conn:
            cur = await conn.execute("SELECT run_id,kind,call_id,name,detail_json FROM runtime_actions WHERE action_id=?", (action_id,))
            row = await cur.fetchone()
            if row is not None:
                if tuple(row) != (run_id, kind, call_id, name, value):
                    raise ValueError("action_id already belongs to a different action")
                return action_id  # Existing result/unknown is never reset to started.
            cur = await conn.execute("SELECT status FROM runtime_runs WHERE run_id=?", (run_id,))
            run = await cur.fetchone()
            if run is None or run[0] in TERMINAL_RUN_STATUSES:
                raise ValueError("run is missing or terminal")
            ts = now_ts()
            await conn.execute(
                "INSERT INTO runtime_actions (action_id,run_id,kind,call_id,name,status,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'started',?,?,?)",
                (action_id, run_id, kind, call_id, name, value, ts, ts),
            )
        return action_id

    async def finish_action(self, action_id: str, *, status: str, result_ref: str = "",
                            detail: dict | None = None) -> bool:
        if status not in ACTION_OUTCOMES:
            raise ValueError("invalid action outcome")
        value = _object(detail)
        async with self.db.write_transaction(label="runtime-finish-action") as conn:
            cur = await conn.execute("SELECT status,result_ref,outcome_json FROM runtime_actions WHERE action_id=?", (action_id,))
            row = await cur.fetchone()
            if row is None:
                raise ValueError("unknown action_id")
            if row[0] != "started":
                if tuple(row) == (status, result_ref, value):
                    return False
                raise ValueError("action outcome already committed; cannot overwrite or replay unknown")
            await conn.execute(
                "UPDATE runtime_actions SET status=?,result_ref=?,outcome_json=?,updated_at=? WHERE action_id=?",
                (status, result_ref, value, now_ts(), action_id),
            )
        return True

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        cur = await self.db.conn.execute("SELECT * FROM runtime_runs WHERE run_id=?", (run_id,))
        return _decode(await cur.fetchone(), "metadata_json", "detail_json")

    async def get_action(self, action_id: str) -> dict[str, Any] | None:
        cur = await self.db.conn.execute("SELECT * FROM runtime_actions WHERE action_id=?", (action_id,))
        return _decode(await cur.fetchone(), "detail_json", "outcome_json")

    async def actions(self, run_id: str) -> list[dict[str, Any]]:
        cur = await self.db.conn.execute("SELECT * FROM runtime_actions WHERE run_id=? ORDER BY rowid", (run_id,))
        return [_decode(row, "detail_json", "outcome_json") for row in await cur.fetchall()]

    async def enqueue_command(self, run_id: str, *, command_id: str = "", kind: str = "input",
                              source_ref: str = "", payload: dict | None = None) -> str:
        _required(kind, "kind")
        command_id = command_id or uuid.uuid4().hex
        value = _object(payload)
        async with self.db.write_transaction(label="runtime-enqueue-command") as conn:
            cur = await conn.execute("SELECT run_id,kind,source_ref,payload_json FROM runtime_commands WHERE command_id=?", (command_id,))
            row = await cur.fetchone()
            if row is not None:
                if tuple(row) != (run_id, kind, source_ref, value):
                    raise ValueError("command_id already belongs to a different command")
                return command_id
            cur = await conn.execute("SELECT status FROM runtime_runs WHERE run_id=?", (run_id,))
            run = await cur.fetchone()
            # Even stop on a terminal run is only idempotent for an existing ID.
            if run is None or run[0] in TERMINAL_RUN_STATUSES:
                raise ValueError("run is missing or terminal")
            cur = await conn.execute("SELECT revision FROM context_windows WHERE owner_key=(SELECT owner_key FROM runtime_runs WHERE run_id=?)", (run_id,))
            checkpoint = await cur.fetchone()
            received_revision = checkpoint[0] if checkpoint is not None else -1
            await conn.execute(
                "INSERT INTO runtime_commands (command_id,run_id,kind,source_ref,payload_json,status,received_checkpoint_revision,created_at) VALUES (?,?,?,?,?,'received',?,?)",
                (command_id, run_id, kind, source_ref, value, received_revision, now_ts()),
            )
        return command_id

    async def pending_commands(self, run_id: str) -> list[dict[str, Any]]:
        """Received or delivered-but-unacknowledged commands, in arrival order."""
        cur = await self.db.conn.execute(
            "SELECT * FROM runtime_commands WHERE run_id=? AND status!='acknowledged' ORDER BY rowid", (run_id,)
        )
        return [_decode(row, "payload_json") for row in await cur.fetchall()]

    async def mark_delivered(self, command_id: str, *, checkpoint_revision: int) -> bool:
        """Only mark a committed/same-transaction context checkpoint as delivered.

        A caller may wrap context checkpoint update and this call in one
        ``db.write_transaction``; nested runtime writes use a savepoint.
        """
        if type(checkpoint_revision) is not int or checkpoint_revision < 0:
            raise ValueError("checkpoint_revision must be a nonnegative integer")
        async with self.db.write_transaction(label="runtime-deliver-command") as conn:
            cur = await conn.execute(
                "SELECT c.status,c.checkpoint_revision,r.owner_key,c.received_checkpoint_revision FROM runtime_commands c "
                "JOIN runtime_runs r ON r.run_id=c.run_id WHERE c.command_id=?", (command_id,)
            )
            row = await cur.fetchone()
            if row is None:
                raise ValueError("unknown command_id")
            if row[0] != "received":
                if row[1] == checkpoint_revision:
                    return False
                raise ValueError("command was delivered against a different checkpoint")
            cur = await conn.execute("SELECT revision FROM context_windows WHERE owner_key=?", (row[2],))
            window = await cur.fetchone()
            if window is None or window[0] != checkpoint_revision or checkpoint_revision <= row[3]:
                raise ValueError("context checkpoint must be newer than command receipt")
            await conn.execute(
                "UPDATE runtime_commands SET status='delivered',checkpoint_revision=?,delivered_at=? WHERE command_id=?",
                (checkpoint_revision, now_ts(), command_id),
            )
        return True

    async def acknowledge_command(self, command_id: str) -> bool:
        async with self.db.write_transaction(label="runtime-acknowledge-command") as conn:
            cur = await conn.execute("SELECT status FROM runtime_commands WHERE command_id=?", (command_id,))
            row = await cur.fetchone()
            if row is None:
                raise ValueError("unknown command_id")
            if row[0] == "acknowledged":
                return False
            if row[0] != "delivered":
                raise ValueError("command has not been delivered")
            await conn.execute(
                "UPDATE runtime_commands SET status='acknowledged',acknowledged_at=? WHERE command_id=?",
                (now_ts(), command_id),
            )
        return True

    async def interrupt_open_runs(self) -> None:
        """At startup only: no coroutine is still executing; never retry an action."""
        async with self.db.write_transaction(label="runtime-recover-interrupted") as conn:
            ts = now_ts()
            await conn.execute(
                "UPDATE runtime_actions SET status='unknown',updated_at=? WHERE status='started'",
                (ts,),
            )
            await conn.execute(
                "UPDATE runtime_runs SET status='interrupted',revision=revision+1,updated_at=? "
                "WHERE status NOT IN ('completed','cancelled','failed','interrupted','needs_control')",
                (ts,),
            )

    @asynccontextmanager
    async def accounting_claim(self, action_id: str) -> AsyncIterator[bool]:
        """Claim one model action atomically with caller's ledger/aggregate writes.

        Usage: ``async with store.accounting_claim(action_id) as first:`` then,
        if first, write model_calls and aggregates through ``db.conn`` INSIDE
        this block. Any exception or outer transaction rollback undoes the claim.
        """
        async with self.db.write_transaction(label="runtime-accounting-claim") as conn:
            cur = await conn.execute("SELECT kind FROM runtime_actions WHERE action_id=?", (action_id,))
            row = await cur.fetchone()
            if row is None or row[0] != "model":
                raise ValueError("accounting claim requires an existing model action")
            cur = await conn.execute(
                "INSERT OR IGNORE INTO runtime_accounting_claims(action_id,created_at) VALUES (?,?)",
                (action_id, now_ts()),
            )
            yield cur.rowcount == 1
