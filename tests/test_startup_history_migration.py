from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest

from app.db.engine import DB
from app.db import schema_migrations as migrations


async def legacy_database(path, *, count=5):
    database = DB(str(path))
    await database.connect()
    try:
        for index in range(count + 1):
            payload = {"text": f"keep-{index}"}
            if index == count:
                payload["terminalAtMs"] = 777
            await database.conn.execute(
                """INSERT INTO web_operations
                   (conversation_uuid, op_id, op_type, lifecycle, status, revision,
                    display_seq, payload_json, created_at_ms, updated_at_ms)
                   VALUES ('history', ?, 'reasoning', 'terminal', 'completed', 1, ?, ?, 100, 9000)""",
                (f"op-{index}", index + 1, json.dumps(payload)),
            )
            await database.conn.execute(
                """INSERT INTO web_event_frames
                   (conversation_uuid, frame_seq, op_id, op_type, action, revision,
                    display_seq, payload_json, created_at_ms, updated_at_ms)
                   VALUES ('history', ?, ?, 'reasoning', 'end', 1, ?, '{}', ?, ?)""",
                (index + 1, f"op-{index}", index + 1, 1000 + index, 1000 + index),
            )
        # Model unfinished history repair without invalidating other installed schemas.
        await database.conn.execute(
            "DELETE FROM schema_data_migrations WHERE name=?",
            (migrations.WEB_OPERATION_HISTORY_MIGRATION,),
        )
        await database.conn.commit()
    finally:
        await database.close()


def read_state(path):
    with sqlite3.connect(path) as connection:
        marker = connection.execute(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE name=?",
            (migrations.WEB_OPERATION_HISTORY_MIGRATION,),
        ).fetchone()[0]
        rows = connection.execute(
            "SELECT op_id, revision, payload_json FROM web_operations ORDER BY id"
        ).fetchall()
        frames = connection.execute("SELECT COUNT(*) FROM web_event_frames").fetchone()[0]
    return marker, rows, frames


async def test_fresh_database_records_completion_and_restarts_without_history_scans(tmp_path, monkeypatch):
    path = tmp_path / "fresh.db"
    database = DB(str(path))
    await database.connect()
    await database.close()
    assert read_state(path)[0] == 1

    async def unexpected_scan(_connection):
        pytest.fail("completed historical migration must not scan records again")

    monkeypatch.setattr(migrations, "backfill_web_operation_terminal_times", unexpected_scan)
    monkeypatch.setattr(migrations, "reconcile_web_operation_snapshot_frames", unexpected_scan)
    restarted = DB(str(path))
    try:
        await restarted.connect()
        assert read_state(path)[0] == 1
    finally:
        await restarted.close()


async def test_legacy_migration_batches_only_missing_timestamps_and_commits_matching_frames(tmp_path, monkeypatch):
    path = tmp_path / "legacy.db"
    await legacy_database(path)
    monkeypatch.setattr(migrations, "_HISTORY_BATCH_SIZE", 2)
    original_loads = json.loads
    decoded_payloads = []

    def record_loads(value, *args, **kwargs):
        if isinstance(value, str) and '"text"' in value and 'keep-' in value:
            decoded_payloads.append(value)
        return original_loads(value, *args, **kwargs)

    monkeypatch.setattr(migrations.json, "loads", record_loads)
    database = DB(str(path))
    try:
        await database.connect()
    finally:
        await database.close()
    marker, rows, frames = read_state(path)
    assert marker == 1
    assert len(decoded_payloads) == 5  # Already-complete payload never reaches Python.
    assert all('keep-5' not in value for value in decoded_payloads)
    assert frames == 11  # Six original ends plus five reconciled revisions.
    for index, (_op_id, revision, raw) in enumerate(rows):
        payload = original_loads(raw)
        assert payload["text"] == f"keep-{index}"
        assert payload["terminalAtMs"] == (1000 + index if index < 5 else 777)
        assert revision == (2 if index < 5 else 1)

    before = read_state(path)
    restarted = DB(str(path))
    await restarted.connect()
    await restarted.close()
    assert read_state(path) == before
    assert len(decoded_payloads) == 5


@pytest.mark.parametrize("cancelled", [False, True])
async def test_failed_or_cancelled_history_migration_rolls_back_and_retries(tmp_path, monkeypatch, cancelled):
    path = tmp_path / "retry.db"
    await legacy_database(path, count=1)
    original_reconcile = migrations.reconcile_web_operation_snapshot_frames

    async def fail_after_partial_repair(connection):
        row = await (await connection.execute(
            "SELECT payload_json FROM web_operations WHERE op_id='op-0'"
        )).fetchone()
        assert json.loads(row[0])["terminalAtMs"] == 1000
        if cancelled:
            raise asyncio.CancelledError("fixture interruption")
        raise RuntimeError("fixture migration failure")

    monkeypatch.setattr(migrations, "reconcile_web_operation_snapshot_frames", fail_after_partial_repair)
    database = DB(str(path))
    try:
        with pytest.raises(asyncio.CancelledError if cancelled else RuntimeError):
            await database.connect()
    finally:
        await database.close()
    marker, rows, frames = read_state(path)
    assert marker == 0
    assert frames == 2
    assert rows[0][1] == 1
    assert "terminalAtMs" not in json.loads(rows[0][2])

    monkeypatch.setattr(migrations, "reconcile_web_operation_snapshot_frames", original_reconcile)
    recovered = DB(str(path))
    await recovered.connect()
    await recovered.close()
    marker, rows, frames = read_state(path)
    assert marker == 1
    assert frames == 3
    assert json.loads(rows[0][2])["terminalAtMs"] == 1000


async def test_pruned_frames_are_not_recreated_by_later_startup(tmp_path):
    path = tmp_path / "retention.db"
    await legacy_database(path, count=1)
    database = DB(str(path))
    await database.connect()
    await database.conn.execute("DELETE FROM web_event_frames")
    await database.conn.commit()
    await database.close()
    restarted = DB(str(path))
    await restarted.connect()
    await restarted.close()
    marker, rows, frames = read_state(path)
    assert marker == 1
    assert frames == 0
    assert json.loads(rows[0][2])["terminalAtMs"] == 1000
