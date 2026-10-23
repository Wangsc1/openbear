"""Writer-lock diagnostics name the holding transaction, how long it held, and where it waits."""
from __future__ import annotations

import asyncio

import pytest

from app.db import connection_router
from app.db.connection_router import SQLiteWriterTimeout
from app.db.engine import DB


class _Recorder:
    def __init__(self):
        self.records = []

    def __getattr__(self, level):
        return lambda event, **fields: self.records.append((level, event, fields))


@pytest.fixture
async def db(tmp_path, monkeypatch):
    database = DB(str(tmp_path / "writer.db"))
    await database.connect()
    recorder = _Recorder()
    monkeypatch.setattr(connection_router, "log", recorder)
    database.recorder = recorder
    yield database
    await database.close()


async def _parked(entered, release):
    entered.set()
    await release.wait()


async def test_timeout_reports_holding_transaction_and_its_suspension_point(db):
    db.conn._writer_wait_timeout_s = 0.05
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold():
        async with db.write_transaction(label="slow-holder"):
            await _parked(entered, release)

    holder = asyncio.create_task(hold(), name="holder-task")
    try:
        await asyncio.wait_for(entered.wait(), 2)
        with pytest.raises(SQLiteWriterTimeout, match=r"owner=holder-task, transaction=slow-holder, held=\d+\.\ds"):
            async with db.write_transaction(label="contender"):
                pytest.fail("must not enter")
    finally:
        release.set()
        await holder

    [(_, _, fields)] = [r for r in db.recorder.records if r[0] == "error"]
    assert fields["持锁事务"] == "slow-holder" and fields["等待事务"] == "contender"
    assert fields["已持锁秒"] >= 0
    # The caller line awaiting the event, not the task entry nor asyncio internals.
    assert fields["持锁位置"] == f"{__file__}:{_parked.__code__.co_firstlineno + 2}"


async def test_implicit_write_is_labelled_by_its_statement(db):
    db.conn._writer_wait_timeout_s = 0.05
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold():
        await db.conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('held','x',0)")
        await _parked(entered, release)
        await db.conn.commit()

    holder = asyncio.create_task(hold(), name="implicit-holder")
    try:
        await asyncio.wait_for(entered.wait(), 2)
        with pytest.raises(SQLiteWriterTimeout, match=r"transaction=implicit:INSERT INTO app_state"):
            await db.conn.commit()
    finally:
        release.set()
        await holder


async def test_long_hold_is_reported_when_released(db, monkeypatch):
    async with db.write_transaction(label="quick"):
        pass
    assert not [r for r in db.recorder.records if r[0] == "warning"]

    monkeypatch.setattr(connection_router, "_SLOW_HOLD_S", 0.02)
    async with db.write_transaction(label="long-holder"):
        await asyncio.sleep(0.05)

    [(_, event, fields)] = [r for r in db.recorder.records if r[0] == "warning"]
    assert event == "SQLite 写事务持锁过久"
    assert fields["事务"] == "long-holder" and fields["持锁秒"] >= 0.02
