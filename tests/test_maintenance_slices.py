from __future__ import annotations

import asyncio
import sqlite3
import time
from types import SimpleNamespace

import pytest

from app.db.engine import DB
from app.db.maintenance import prune_rows


@pytest.fixture
async def owner(tmp_path):
    db = DB(str(tmp_path / "retention.db"))
    await db.connect()
    try:
        yield SimpleNamespace(db=db)
    finally:
        await db.close()


async def seed(owner, rows):
    await owner.db.conn.executemany(
        """INSERT INTO web_task_notifications(notification_uuid,notification_key,conversation_uuid,
        internal_chat_id,payload_json,state,created_at,updated_at) VALUES(?,?,'c',1,'{}',?,1,1)""",
        [(str(i), str(i), state) for i, state in enumerate(rows)],
    )
    await owner.db.conn.commit()


async def prune(owner, **kwargs):
    return await prune_rows(owner, "web_task_notifications", "state='delivered' AND updated_at<?", (2,), **kwargs)


async def test_scans_past_retained_pages_and_preserves_live_rows(owner):
    await seed(owner, ["pending"] * 600 + ["delivered"] * 300)
    deleted = await prune(owner, max_scan_rows=256)
    assert deleted == 0
    assert owner._maintenance_cursors["web_task_notifications"]["after"] == 256
    slices = 1
    while owner._maintenance_cursors:
        deleted += await prune(owner, max_scan_rows=256)
        slices += 1
        assert slices <= 4
    assert deleted == 300
    async with await owner.db.conn.execute("SELECT COUNT(*) FROM web_task_notifications") as cur:
        assert (await cur.fetchone())[0] == 600


async def test_busy_writer_defers_without_rolling_back_foreground(owner):
    await seed(owner, ["delivered"] * 10)
    entered, release = asyncio.Event(), asyncio.Event()

    async def foreground():
        async with owner.db.write_transaction() as conn:
            await conn.execute("UPDATE web_task_notifications SET state='pending' WHERE id=1")
            entered.set()
            await release.wait()

    writer = asyncio.create_task(foreground())
    await entered.wait()
    began = time.monotonic()
    try:
        assert await prune(owner) == 0
        assert time.monotonic() - began < 0.5
        assert owner._maintenance_cursors["web_task_notifications"]["after"] == 0
    finally:
        release.set()
        await writer
    assert await prune(owner) == 9
    async with await owner.db.conn.execute("SELECT state FROM web_task_notifications") as cur:
        assert [row[0] for row in await cur.fetchall()] == ["pending"]


async def test_external_writer_does_not_hold_application_writer_for_seconds(owner):
    await seed(owner, ["delivered"] * 10)
    external = sqlite3.connect(owner.db.path)
    external.execute("BEGIN IMMEDIATE")
    try:
        began = time.monotonic()
        assert await prune(owner) == 0
        assert time.monotonic() - began < 0.5
        assert owner.db._router()._owner is None
    finally:
        external.rollback()
        external.close()
    assert await prune(owner) == 10


async def test_committed_batches_yield_to_foreground_writer(owner):
    await seed(owner, ["delivered"] * 3000)
    entered = asyncio.Event()
    original = owner.db._router()._notify_commit

    def committed():
        original()
        entered.set()

    owner.db._router()._notify_commit = committed
    task = asyncio.create_task(prune(owner))
    await entered.wait()
    began = time.monotonic()
    async with owner.db.write_transaction() as conn:
        await conn.execute("UPDATE web_task_notifications SET state='pending' WHERE id=3000")
    assert time.monotonic() - began < 0.5
    deleted = await task
    while owner._maintenance_cursors:
        deleted += await prune(owner)
    assert deleted == 2999
