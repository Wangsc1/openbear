"""Real SQLite interruption and large temporary-log runtime checks."""
from __future__ import annotations

import asyncio
import sqlite3
import statistics
import time
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

from app.web_console.event_frame_retention import prune_event_frames
from tests.test_web_event_frame_retention import (
    _FRESH,
    _INSERT,
    _OLD,
    _finish,
    _seed,
)
from tests.test_web_event_frame_retention import retention_env as retention_env


async def test_external_writer_is_a_short_skip_and_native_timeout_is_restored(retention_env):
    owner = retention_env
    await _seed(owner, (("a", "op", seq, seq, _OLD) for seq in range(1, 301)))
    external = sqlite3.connect(owner.db.path, timeout=0, isolation_level=None)
    external.execute("BEGIN IMMEDIATE")
    try:
        started = time.monotonic()
        assert await prune_event_frames(owner) == 0
        assert time.monotonic() - started < 0.3
        assert owner._web_event_frame_retention_pending
        assert owner._web_event_frame_retention_sweeps[("", 5000, 7)].cursor is None
    finally:
        external.rollback()
        external.close()
    async with owner.db.write_transaction(wait_timeout_s=0.1) as writer:
        async with writer.execute("PRAGMA busy_timeout") as cur:
            assert (await cur.fetchone())[0] == 5000
        await writer.execute("INSERT INTO retention_test_writes VALUES ('external-released','yes')")
    assert await _finish(owner) == 299


@pytest.mark.parametrize("cancel", [False, True])
async def test_slow_retention_read_is_interrupted_without_harming_queued_business_read(retention_env, cancel):
    owner = retention_env
    await _seed(owner, [("a", "op", 1, 1, _OLD), ("a", "op", 2, 2, _OLD)])
    execute = owner.db.conn.execute
    execute_fetchall = owner.db.conn.execute_fetchall
    executing = asyncio.Event()
    async def slow_page(sql, params=()):
        if "ORDER BY conversation_uuid, op_id, revision, id" in sql and not executing.is_set():
            executing.set()
            # Fault injection only: retain the real interruptible DB API/worker.
            return await execute_fetchall("""
                WITH RECURSIVE counter(x) AS (
                  SELECT 1 UNION ALL SELECT x+1 FROM counter WHERE x<1000000000
                ) SELECT SUM(x) FROM counter
            """)
        return await execute_fetchall(sql, params)
    owner.db.conn.execute_fetchall = slow_page
    started = time.monotonic()
    task = asyncio.create_task(prune_event_frames(owner, time_budget_s=0.05))
    await asyncio.wait_for(executing.wait(), 1)
    await asyncio.sleep(0.01)
    business = asyncio.create_task(execute("SELECT 42"))
    if cancel:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 0.5)
    else:
        assert await asyncio.wait_for(task, 0.5) == 0
    cursor = await asyncio.wait_for(business, 0.5)
    assert (await cursor.fetchone())[0] == 42
    await cursor.close()
    assert time.monotonic() - started < 0.5
    assert owner._web_event_frame_retention_pending
    assert owner._web_event_frame_retention_sweeps[("", 5000, 7)].cursor is None
    owner.db.conn.execute_fetchall = execute_fetchall
    async with owner.db.write_transaction(wait_timeout_s=0.1) as writer:
        await writer.execute("INSERT INTO retention_test_writes VALUES ('after-read-stop','yes')")
    assert await _finish(owner) == 1


async def test_cancel_running_delete_interrupts_sqlite_and_releases_writer(retention_env):
    owner = retention_env
    await _seed(owner, (("a", "op", seq, seq, _OLD) for seq in range(1, 301)))
    async with owner.db.write_transaction() as writer:
        await writer.execute("""
            CREATE TRIGGER retention_slow_delete BEFORE DELETE ON web_event_frames
            BEGIN
              SELECT (WITH RECURSIVE counter(x) AS (
                SELECT 1 UNION ALL SELECT x+1 FROM counter WHERE x<1000000000
              ) SELECT SUM(x) FROM counter);
            END
        """)
    original_transaction = owner.db.write_transaction
    executing = asyncio.Event()
    @asynccontextmanager
    async def signalled_transaction(**kwargs):
        async with original_transaction(**kwargs) as writer:
            if kwargs.get("label") == "web-event-frame-retention":
                executing.set()
            yield writer
    owner.db.write_transaction = signalled_transaction
    task = asyncio.create_task(prune_event_frames(owner))
    await asyncio.wait_for(executing.wait(), 1)
    await asyncio.sleep(0.02)  # Let the actual DELETE enter its slow SQL trigger.
    started = time.monotonic()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 0.5)
    assert time.monotonic() - started < 0.5
    assert owner._web_event_frame_retention_pending
    assert owner._web_event_frame_retention_sweeps[("", 5000, 7)].cursor is None
    owner.db.write_transaction = original_transaction
    async with original_transaction(wait_timeout_s=0.1) as writer:
        async with writer.execute("SELECT COUNT(*) FROM web_event_frames") as cur:
            assert (await cur.fetchone())[0] == 300
        await writer.execute("DROP TRIGGER retention_slow_delete")
        await writer.execute("INSERT INTO retention_test_writes VALUES ('after-delete-stop','yes')")
    assert await _finish(owner) == 299


async def test_100k_payload_log_has_short_transactions_and_interactive_latency(retention_env):
    owner = retention_env
    # ~28 MiB on disk, 20k frames (was 100k), both a deletion-heavy operation
    # and a long protected prefix. Payload is deliberately never selected by
    # maintenance. A whole-table delete would be one write transaction; the
    # batch-count and per-batch bounds below scale with ``rows``.
    rows = 20000
    expired = rows // 2
    payload = '{"text":"' + "x" * 1024 + '"}'
    async with owner.db.write_transaction() as conn:
        await conn.executemany(_INSERT.replace("'{}'", "?"), (
            ("large", "a-expired" if seq <= expired else "z-protected", seq,
             seq if seq <= expired else 1, _OLD if seq <= expired else _FRESH, payload)
            for seq in range(1, rows + 1)
        ))
    size = sum(path.stat().st_size for path in Path(owner.db.path).parent.glob("retention.db*"))
    original_transaction = owner.db.write_transaction
    write_times = []
    @asynccontextmanager
    async def measured_transaction(**kwargs):
        async with original_transaction(**kwargs) as conn:
            started = time.monotonic()
            yield conn
        if kwargs.get("label") == "web-event-frame-retention":
            write_times.append(time.monotonic() - started)
    owner.db.write_transaction = measured_transaction
    finished = asyncio.Event()
    latencies = []
    slices = []
    async def cleanup():
        deleted = 0
        try:
            while True:
                started = time.monotonic()
                deleted += await prune_event_frames(owner, keep_recent=rows)
                slices.append(time.monotonic() - started)
                if not owner._web_event_frame_retention_pending:
                    return deleted
                await asyncio.sleep(0.001)
        finally:
            finished.set()
    async def interactive():
        seq = 0
        while not finished.is_set():
            started = time.monotonic()
            async with original_transaction(label="interactive", wait_timeout_s=0.5) as writer:
                await writer.execute("INSERT OR REPLACE INTO retention_test_writes VALUES ('latency',?)", (str(seq),))
            cur = await owner.db.conn.execute("SELECT frame_seq FROM web_event_frames WHERE conversation_uuid='large' ORDER BY frame_seq DESC LIMIT 1")
            assert (await cur.fetchone())[0] == rows
            await cur.close()
            latencies.append(time.monotonic() - started)
            seq += 1
            await asyncio.sleep(0.001)
    started = time.monotonic()
    deleted, _ = await asyncio.wait_for(asyncio.gather(cleanup(), interactive()), 30)
    assert deleted == expired - 1
    assert len(slices) >= -(-rows // 4096)  # 4096 scanned rows per slice, including protected rows.
    assert len(write_times) >= deleted // 128  # at most 128 rows per write transaction
    assert len(latencies) > 10
    assert max(write_times) < 0.3
    assert max(latencies) < 0.5
    async with original_transaction() as writer:
        async with writer.execute("SELECT COUNT(*) FROM web_event_frames") as cur:
            assert (await cur.fetchone())[0] == rows - deleted
    print(
        f"retention benchmark: rows={rows} bytes={size} deleted={deleted} "
        f"slices={len(slices)} seconds={time.monotonic() - started:.3f} "
        f"max_slice_s={max(slices):.4f} batches={len(write_times)} max_write_s={max(write_times):.4f} "
        f"interactive_count={len(latencies)} interactive_p95_s={statistics.quantiles(latencies, n=20)[18]:.4f} "
        f"interactive_max_s={max(latencies):.4f}"
    )
