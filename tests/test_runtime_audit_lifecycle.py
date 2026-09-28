import asyncio
from types import SimpleNamespace

import pytest

from app.runtime.lifecycle import RunSession
from app.runtime.model_call import PreparedRequest, execute_attempt
from app.llm.events import StreamEvent, Usage
from tests.test_runtime_audit_transactions import db


def session_for(db):
    return RunSession(SimpleNamespace(store=SimpleNamespace(db=db, owner=SimpleNamespace(key='audit-lifecycle'))))


async def test_cancellation_after_begin_commit_does_not_orphan_running_record(db, monkeypatch):
    session = session_for(db)
    entered = asyncio.Event()
    original = session.store.begin_run
    async def blocked(*args, **kwargs):
        result = await original(*args, **kwargs)
        entered.set()
        await asyncio.Event().wait()
        return result
    monkeypatch.setattr(session.store, 'begin_run', blocked)
    child = asyncio.create_task(session.run(lambda: asyncio.sleep(0)))
    await asyncio.wait_for(entered.wait(), 1)
    child.cancel()
    with pytest.raises(asyncio.CancelledError):
        await child
    assert (await session.store.get_run(session.run_id))['status'] == 'cancelled'


async def test_second_stop_during_terminal_persistence_still_finishes_run(db, monkeypatch):
    session = session_for(db)
    body_entered, cleanup_entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original = session.finish
    async def finish(status):
        cleanup_entered.set()
        await release.wait()
        return await original(status)
    monkeypatch.setattr(session, 'finish', finish)
    async def body():
        body_entered.set()
        await asyncio.Event().wait()
    child = asyncio.create_task(session.run(body))
    await body_entered.wait()
    child.cancel()
    await cleanup_entered.wait()
    child.cancel()
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await child
    assert (await session.store.get_run(session.run_id))['status'] == 'cancelled'


async def test_cleanup_failure_preserves_original_execution_error(db, monkeypatch):
    session = session_for(db)
    async def finish(status):
        raise RuntimeError('cleanup-storage-error')
    monkeypatch.setattr(session, 'finish', finish)
    async def body():
        raise ValueError('original-execution-error')
    with pytest.raises(ValueError, match='original-execution-error'):
        await session.run(body)


async def test_repeated_stop_during_cancelled_model_settlement_keeps_known_usage():
    received, settlement, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    billed = []
    class Backend:
        async def stream(self, *args, **kwargs):
            yield StreamEvent('usage', usage=Usage(output_tokens=7))
            received.set()
            await asyncio.Event().wait()
    async def settle(outcome):
        settlement.set()
        await release.wait()
        billed.append((outcome.status, outcome.response.usage.output_tokens))
    child = asyncio.create_task(execute_attempt(PreparedRequest(Backend(), [], {}), settle=settle))
    await received.wait()
    child.cancel()
    await settlement.wait()
    child.cancel()
    await asyncio.wait({child}, timeout=.02)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await child
    assert billed == [('cancelled', 7)]
