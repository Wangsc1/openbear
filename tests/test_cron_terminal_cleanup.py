"""Stop at the exact Cron accounting/terminal boundaries, with no live service."""
from __future__ import annotations

import asyncio

import pytest

from app.cron import executor
from app.runtime import budget as budget_registry
from app.webhooks.repository import one
from tests.test_cron import base_env as base_env
from tests.test_cron import cron_env as cron_env
from tests.test_cron import create


@pytest.mark.parametrize('boundary', ['final_usage', 'final_status'])
@pytest.mark.parametrize('repeat_stop', [False, True])
async def test_stop_during_final_cleanup_persists_terminal_and_unbinds(cron_env, monkeypatch, boundary, repeat_stop):
    e = cron_env
    usage_entered, terminal_entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    stop_requested = asyncio.Event()
    original_refresh, original_patch = executor.RunBudget.refresh, executor.patch
    original_unbind, original_stop = executor.unbind, e.server.runs.cancel_and_wait
    terminal_writes, unbindings = [], []

    async def refresh(self):
        if boundary == 'final_usage' and self.closed:
            usage_entered.set()
            await release.wait()
        return await original_refresh(self)

    async def patch(s, run_id, **values):
        if values.get('phase') == 'finished':
            terminal_writes.append(values)
            terminal_entered.set()
            await release.wait()
        return await original_patch(s, run_id, **values)

    def unbind(budget, token):
        assert asyncio.current_task() is budget.task
        original_unbind(budget, token)
        unbindings.append(budget_registry._current.get())

    async def stop(chat_id, **kwargs):
        stop_requested.set()
        return await original_stop(chat_id, **kwargs)

    monkeypatch.setattr(executor.RunBudget, 'refresh', refresh)
    monkeypatch.setattr(executor, 'patch', patch)
    monkeypatch.setattr(executor, 'unbind', unbind)
    monkeypatch.setattr(e.server.runs, 'cancel_and_wait', stop)
    job = await create(e, post={'enabled': True, 'code': "print('cancel cleanup')", 'onOutcomes': ['cancelled']})
    accepted = await e.cron.run(123, job['id'], {'expectedRevision': job['revision'], 'requestId': 'run'})
    run_id = accepted['run']['id']
    runner = e.cron.tasks[run_id]
    stopper = None
    try:
        await asyncio.wait_for((usage_entered if boundary == 'final_usage' else terminal_entered).wait(), 5)
        stopper = asyncio.create_task(e.cron.stop(123, run_id, {'requestId': 'stop'}))
        await asyncio.wait_for(stop_requested.wait(), 5)
        await asyncio.wait_for(terminal_entered.wait(), 5)
        # A second stop races with the same terminal write, not a second execution.
        if repeat_stop:
            runner.cancel()
            await asyncio.sleep(0)
        assert not runner.done()
        release.set()
        answer = await asyncio.wait_for(stopper, 5)
        await asyncio.wait_for(asyncio.shield(runner), 5)
        result = (await e.cron.get_run(123, run_id))['run']
        expected = 'cancelled' if boundary == 'final_usage' else 'completed'
        assert answer['ok'] and result['status'] == result['outcome'] == expected
        assert result['phase'] == 'finished' and result['finishedAt'] is not None
        assert (await e.cron.get(123, job['id']))['job']['activeRuns'] == 0
        row = await one(e.db.conn, 'SELECT * FROM cron_runs WHERE run_id=?', (run_id,))
        conversation = await one(e.db.conn, 'SELECT internal_chat_id FROM web_conversations WHERE conversation_uuid=?', (row['conversation_uuid'],))
        assert not e.server.runs.is_running(conversation['internal_chat_id'])
        assert (id(e.db), row['root_turn_uuid']) not in budget_registry._active
        assert unbindings == [None]
        assert len(terminal_writes) == 1 and e.backend.calls == 1
        assert len(result['postAttempts']) == int(boundary == 'final_usage')
        if boundary == 'final_usage':
            assert result['postAttempts'][0]['stdout'] == 'cancel cleanup\n'
        assert result['notificationState'] == 'suppressed'
        assert not any(t.get_name() == 'cron-finalize:' + run_id for t in asyncio.all_tasks())
    finally:
        release.set()
        if not runner.done(): runner.cancel()
        await asyncio.gather(runner, *([stopper] if stopper else []), return_exceptions=True)


async def test_shutdown_during_final_usage_still_finishes_without_post_replay(cron_env, monkeypatch):
    e = cron_env
    entered, release = asyncio.Event(), asyncio.Event()
    original = executor.RunBudget.refresh

    async def refresh(self):
        if self.closed:
            entered.set()
            await release.wait()
        return await original(self)

    monkeypatch.setattr(executor.RunBudget, 'refresh', refresh)
    job = await create(e, post={'enabled': True, 'code': "raise RuntimeError('must not run at shutdown')", 'onOutcomes': ['completed', 'cancelled']})
    accepted = await e.cron.run(123, job['id'], {'expectedRevision': job['revision'], 'requestId': 'run'})
    try:
        await asyncio.wait_for(entered.wait(), 5)
        await asyncio.wait_for(e.cron.close(), 5)
        result = (await e.cron.get_run(123, accepted['run']['id']))['run']
        assert result['status'] == result['outcome'] == 'interrupted'
        assert result['phase'] == 'finished' and result['finishedAt'] is not None
        assert result['postAttempts'] == []
        assert (await e.cron.get(123, job['id']))['job']['activeRuns'] == 0
        assert not any(key[0] == id(e.db) for key in budget_registry._active)
    finally:
        release.set()


async def test_persistence_timeout_is_not_relabelled_as_stop_timeout(cron_env, monkeypatch):
    e = cron_env
    original = executor.patch

    async def patch(s, run_id, **values):
        if values.get('phase') == 'finished':
            raise TimeoutError('storage timeout')
        return await original(s, run_id, **values)

    monkeypatch.setattr(executor, 'patch', patch)
    job = await create(e)
    accepted = await e.cron.run(123, job['id'], {'expectedRevision': job['revision'], 'requestId': 'run'})
    runner = e.cron.tasks[accepted['run']['id']]
    with pytest.raises(TimeoutError, match='^storage timeout$'):
        await asyncio.wait_for(asyncio.shield(runner), 5)
    assert not any(key[0] == id(e.db) for key in budget_registry._active)


async def test_terminal_shield_has_one_fixed_stop_deadline(cron_env, monkeypatch):
    e = cron_env
    entered, released = asyncio.Event(), asyncio.Event()
    original = executor.patch
    finalizers = []

    async def patch(s, run_id, **values):
        if values.get('phase') == 'finished':
            finalizers.append(asyncio.current_task())
            entered.set()
            try:
                await asyncio.Event().wait()  # Simulate unavailable terminal storage.
            finally:
                released.set()
        return await original(s, run_id, **values)

    monkeypatch.setattr(executor, 'patch', patch)
    monkeypatch.setattr(executor, '_FINALIZE_CANCEL_TIMEOUT_S', .05)
    job = await create(e)
    accepted = await e.cron.run(123, job['id'], {'expectedRevision': job['revision'], 'requestId': 'run'})
    runner = e.cron.tasks[accepted['run']['id']]
    loop = asyncio.get_running_loop()
    repeats = []
    try:
        await asyncio.wait_for(entered.wait(), 5)
        runner.cancel()
        # Continued stop clicks must neither cancel persistence early nor extend
        # its original deadline until the last click (0.3 seconds here).
        repeats = [loop.call_later(i * .01, runner.cancel) for i in range(1, 31)]
        done, _ = await asyncio.wait([runner], timeout=.2)
        assert runner in done
        with pytest.raises(TimeoutError, match='Cron terminal cleanup'):
            runner.result()
        await asyncio.wait_for(released.wait(), 1)
        assert len(finalizers) == 1 and finalizers[0].cancelled()
        assert not any(key[0] == id(e.db) for key in budget_registry._active)
    finally:
        for handle in repeats: handle.cancel()
        if not runner.done(): runner.cancel()
        await asyncio.gather(runner, return_exceptions=True)
