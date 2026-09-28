"""Deterministic fault injection for the 2026-09-27 full reliability audit."""
import asyncio
import threading
import sqlite3
from types import SimpleNamespace

import pytest

from app.db.engine import DB
from app.llm.events import StreamEvent
from app.llm.base import OpenBearLLMError
from app.runtime.lifecycle import RunSession
from app.runtime.model_call import ModelCallDriver, PreparedRequest
from app.llm.retry import RetryPolicy


@pytest.fixture
async def db(tmp_path):
    value = DB(str(tmp_path / 'audit.db'))
    await value.connect()
    try:
        yield value
    finally:
        await value.close()


@pytest.mark.parametrize('outcome', ['ok', 'error', 'cancelled'])
async def test_retry_terminal_presentation_is_outside_global_writer(db, outcome):
    calls, terminal, writes = [], [], []
    class Backend:
        async def stream(self, messages, **options):
            calls.append(1)
            if len(calls) == 1 or outcome == 'error':
                yield StreamEvent('error', error='temporary', status=503, retryable=True)
            elif outcome == 'cancelled':
                raise asyncio.CancelledError()
            else:
                yield StreamEvent('content', text='done')
    async def persist_notice():
        async with db.write_transaction(label='separate-web-event') as conn:
            await conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('notice','saved',0)")
        writes.append(1)
    async def retry(state):
        if state.get('terminal') and state.get('status') in {'completed', 'failed', 'cancelled'}:
            terminal.append(state['status'])
            # A Web publish may belong to a different task that needs the writer.
            await asyncio.wait_for(asyncio.create_task(persist_notice()), .5)
    async def settle(value):
        assert db.conn._owner is asyncio.current_task()
    window = SimpleNamespace(store=SimpleNamespace(db=db, owner=SimpleNamespace(key='audit-retry')))
    session = RunSession(window)
    async def body():
        return await ModelCallDriver(RetryPolicy(max_retries=1, base_delay_s=0)).call(
            lambda _: PreparedRequest(Backend(), [], {}), settle, on_retry=retry)
    if outcome == 'ok':
        await session.run(body)
    else:
        expected = asyncio.CancelledError if outcome == 'cancelled' else OpenBearLLMError
        with pytest.raises(expected):
            await session.run(body)
    assert terminal == [{'ok': 'completed', 'error': 'failed', 'cancelled': 'cancelled'}[outcome]]
    assert writes == [1]
    cur = await db.conn.execute('SELECT COUNT(*) FROM runtime_accounting_claims')
    assert (await cur.fetchone())[0] == 2


async def test_cancel_queued_sql_cannot_be_committed_by_next_writer(db, monkeypatch):
    loop = asyncio.get_running_loop()
    worker_blocked, queued = asyncio.Event(), asyncio.Event()
    release_worker = threading.Event()
    writer = db.conn._writer
    def block_worker():
        loop.call_soon_threadsafe(worker_blocked.set)
        assert release_worker.wait(3), 'test failed to release SQLite worker'
        return 1
    await writer.create_function('audit_block_worker', 0, block_worker)
    blocker = asyncio.create_task(writer.execute('SELECT audit_block_worker()'))
    await asyncio.wait_for(worker_blocked.wait(), 1)
    original = writer.execute
    async def execute(sql, parameters=()):
        if 'cancelled-write' in sql:
            queued.set()
        return await original(sql, parameters)
    monkeypatch.setattr(writer, 'execute', execute)
    async def write(key):
        await db.conn.execute(f"INSERT INTO app_state(key,value,updated_at) VALUES('{key}','yes',0)")
        await db.conn.commit()
    cancelled = asyncio.create_task(write('cancelled-write'))
    survivor = None
    try:
        await asyncio.wait_for(queued.wait(), 1)
        assert not writer.in_transaction  # The queued INSERT has not run yet.
        cancelled.cancel()
        await asyncio.sleep(0)
        survivor = asyncio.create_task(write('surviving-write'))
    finally:
        release_worker.set()
        await blocker
        await asyncio.gather(cancelled, return_exceptions=True)
        if survivor:
            await survivor
    cur = await db.conn.execute("SELECT key FROM app_state WHERE key IN ('cancelled-write','surviving-write') ORDER BY key")
    assert [row[0] for row in await cur.fetchall()] == ['surviving-write']
    assert db.conn._owner is None and not db.conn.in_transaction


async def test_failed_commit_rolls_back_before_next_writer(db, monkeypatch):
    original = db.conn._writer.commit
    async def fail_commit():
        raise sqlite3.OperationalError('injected disk I/O error')
    await db.conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('failed-commit','yes',0)")
    monkeypatch.setattr(db.conn._writer, 'commit', fail_commit)
    with pytest.raises(sqlite3.OperationalError, match='disk I/O'):
        await db.conn.commit()
    assert db.conn._owner is None and not db.conn.in_transaction
    monkeypatch.setattr(db.conn._writer, 'commit', original)
    await db.conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('next-commit','yes',0)")
    await db.conn.commit()
    row = await (await db.conn.execute("SELECT key FROM app_state WHERE key='failed-commit'")).fetchone()
    assert row is None


async def test_writer_release_removes_abandonment_callback(db):
    task = asyncio.current_task()
    before = len(task._callbacks or [])
    for n in range(100):
        async with db.write_transaction(label='repeated-short-write') as conn:
            await conn.execute("INSERT OR REPLACE INTO app_state(key,value,updated_at) VALUES('counter',?,0)", (str(n),))
    assert len(task._callbacks or []) == before, 'long runs must not accumulate one recovery task per transaction'


@pytest.mark.parametrize('method', ['execute', 'executemany'])
async def test_error_in_implicit_transaction_does_not_leave_handler_holding_writer(db, method):
    await db.conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('uncommitted','yes',0)")
    try:
        with pytest.raises(sqlite3.OperationalError):
            if method == 'execute':
                await db.conn.execute('INSERT INTO no_such_table VALUES(1)')
            else:
                await db.conn.executemany('INSERT INTO no_such_table VALUES(?)', [(1,)])
        assert db.conn._owner is None, 'error reporting must not inherit a leaked writer transaction'
    finally:
        await db.conn.rollback()
    row = await (await db.conn.execute("SELECT key FROM app_state WHERE key='uncommitted'")).fetchone()
    assert row is None


async def test_repeated_cancellation_does_not_release_writer_before_rollback(db, monkeypatch):
    entered, rollback_started, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original = db.conn._writer.rollback
    async def blocked_rollback():
        rollback_started.set()
        await release.wait()
        return await original()
    monkeypatch.setattr(db.conn._writer, 'rollback', blocked_rollback)
    async def body():
        async with db.write_transaction() as conn:
            await conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('rolled-back','yes',0)")
            entered.set()
            await asyncio.Event().wait()
    child = asyncio.create_task(body())
    await entered.wait()
    child.cancel()
    await rollback_started.wait()
    child.cancel()
    await asyncio.sleep(0)
    try:
        assert db.conn._owner is child and db.conn._writer_lock.locked()
    finally:
        release.set()
        await asyncio.gather(child, return_exceptions=True)
    assert (await (await db.conn.execute("SELECT key FROM app_state WHERE key='rolled-back'")).fetchone()) is None
    assert db.conn._owner is None
