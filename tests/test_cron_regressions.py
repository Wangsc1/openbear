"""Regression tests for the Cron backend audit, on isolated SQLite/HTTP/processes."""
from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace

import pytest

from app.cron.contracts import CronError
from app.cron.notifications import deliver
from app.cron.service import CronService
from app.tools.base import ToolRuntimeContext
from app.tools.cron import dispatch
from app.webhooks.repository import many, one
from tests.test_cron import base_env as base_env
from tests.test_cron import create, run
from tests.test_cron import cron_env as cron_env
from tests.test_web_admin import _login_cookie


async def tool_context(e):
    conversation = await e.server._create_web_conversation(123, folder_uuid='folder')
    return ToolRuntimeContext(conversation_uuid=conversation['conversation_uuid'],
                              chat_id=conversation['internal_chat_id'])


@pytest.mark.parametrize('folder', [{}, {'folderId': ''}, {'folderId': '  '}, {'folderId': None}])
async def test_create_requires_a_real_directory(cron_env, folder):
    e = cron_env
    cookies = {'openbear_web_session': await _login_cookie(e)}
    response = await e.client.post('/api/cron/jobs', cookies=cookies, json={
        **folder, 'name': 'Must be bound', 'enabled': True, 'requestId': 'empty-folder',
        'config': {'instructions': 'test'},
    })
    assert response.status == 422
    assert (await response.json())['code'] == 'folder_required'
    assert not await many(e.db.conn, 'SELECT * FROM cron_jobs')
    assert not await many(e.db.conn, 'SELECT * FROM cron_operations')
    # Do not remove the ordinary conversation system's temporary-root capability.
    assert await e.server._tree_folder_owned(123, '')


async def test_legacy_unbound_job_cannot_run_or_enable(cron_env):
    e = cron_env
    job = await create(e)
    await e.db.conn.execute("UPDATE cron_jobs SET folder_id='',enabled=0 WHERE job_id=?", (job['id'],))
    await e.db.conn.commit()
    for method, body in [
        (e.cron.run, {'requestId': 'run', 'expectedRevision': 1}),
        (e.cron.set_enabled, {'requestId': 'enable', 'expectedRevision': 1, 'enabled': True}),
    ]:
        with pytest.raises(CronError, match='定时任务必须绑定真实目录'):
            await method(123, job['id'], body)
    assert not await many(e.db.conn, 'SELECT * FROM cron_runs')


@pytest.mark.parametrize('identity', [{}, {'jobId': None}, {'jobId': ''}, {'jobId': '  '}])
async def test_tool_update_requires_job_id_without_creating(cron_env, identity):
    e = cron_env
    with pytest.raises(CronError) as caught:
        await dispatch(e.cron, 'update', {
            **identity, 'folderId': 'folder', 'name': 'Not a new job', 'enabled': True,
            'expectedRevision': 5, 'requestId': 'bad-update', 'config': {'instructions': 'test'},
        }, await tool_context(e))
    assert caught.value.payload['code'] == 'job_id_required'
    assert not await many(e.db.conn, 'SELECT * FROM cron_jobs')
    assert not await many(e.db.conn, 'SELECT * FROM cron_operations')


@pytest.mark.parametrize('enabled', [False, True])
@pytest.mark.parametrize('config_field', [{}, {'config': None}])
async def test_patch_without_config_is_rejected_without_changing_definition(cron_env, enabled, config_field):
    e = cron_env
    job = (await e.cron.save(123, {
        'folderId': 'folder', 'name': 'Original', 'description': 'Keep description',
        'enabled': enabled, 'requestId': 'create', 'config': {
            'instructions': 'Keep instructions', 'totalTokensBudget': 1234,
            'schedule': {'kind': 'every', 'everySeconds': 17},
        },
    }))['job']
    response = await e.client.patch('/api/cron/jobs/' + job['id'],
        cookies={'openbear_web_session': await _login_cookie(e)},
        json={'name': 'Renamed', 'expectedRevision': 1, 'requestId': 'incomplete', **config_field})
    assert response.status == 422
    assert (await response.json())['code'] == 'config_required'
    assert (await e.cron.get(123, job['id']))['job'] == job
    assert not await one(e.db.conn, "SELECT 1 FROM cron_operations WHERE request_id='incomplete'")


async def test_complete_tool_update_preserves_optional_description_and_can_clear_it(cron_env):
    e = cron_env
    job = (await e.cron.save(123, {
        'folderId': 'folder', 'name': 'Original', 'description': 'Keep description',
        'enabled': True, 'requestId': 'create', 'config': {'instructions': 'Original instruction'},
    }))['job']
    ctx = await tool_context(e)
    request = {'jobId': job['id'], 'name': 'Renamed', 'expectedRevision': 1, 'requestId': 'update',
               'config': {**job['config'], 'instructions': 'Changed instruction'}}
    result = await dispatch(e.cron, 'update', request, ctx)
    updated = result['job']
    assert updated['description'] == job['description']
    assert updated['config']['instructions'] == 'Changed instruction'
    assert updated['nextRunAt'] == job['nextRunAt'] and updated['enabled']
    assert updated['revision'] == 2
    assert await dispatch(e.cron, 'update', request, ctx) == result
    cleared = await dispatch(e.cron, 'update', {**request, 'requestId': 'clear', 'expectedRevision': 2, 'description': ''}, ctx)
    assert cleared['job']['description'] == ''
    assert (await e.cron.list(123, {}))['total'] == 1


async def test_tool_delete_replays_durable_intent_without_reconfirming(cron_env):
    e = cron_env
    job = await create(e)
    ctx = await tool_context(e)
    confirmations = []

    async def confirm(payload):
        confirmations.append(payload)
        return {'confirmed': True}

    ctx.web_confirm = confirm
    request = {'jobId': job['id'], 'expectedRevision': 1, 'requestId': 'delete-stable'}
    deleted = await dispatch(e.cron, 'delete', request, ctx)
    assert deleted['job']['scheduleState'] == 'deleted'
    assert len(confirmations) == 1 and confirmations[0]['_requiresAuthorization']
    assert await dispatch(e.cron, 'delete', request, ctx) == deleted
    assert len(confirmations) == 1
    # Simulate losing the response and restarting: no in-memory grant is needed.
    await e.db.close()
    await e.db.connect()
    fresh = CronService(e.db, e.server)
    ctx.web_confirm = None
    assert await dispatch(fresh, 'delete', request, ctx) == deleted
    for changed in [{**request, 'expectedRevision': 2}, {**request, 'jobId': 'another-job'}]:
        with pytest.raises(CronError) as caught:
            await dispatch(fresh, 'delete', changed, ctx)
        assert caught.value.payload['code'] == 'request_id_conflict'
    other = await create(e)
    new_request = {'jobId': other['id'], 'expectedRevision': 1, 'requestId': 'new-delete'}
    with pytest.raises(CronError) as caught:
        await dispatch(fresh, 'delete', new_request, ctx)
    assert caught.value.payload['code'] == 'user_confirmation_unavailable'
    ctx.web_confirm = confirm
    assert (await dispatch(fresh, 'delete', new_request, ctx))['job']['scheduleState'] == 'deleted'
    assert len(confirmations) == 2


async def test_tool_delete_new_intent_still_checks_confirmation_revision(cron_env):
    e = cron_env
    job = await create(e)
    ctx = await tool_context(e)

    async def change_while_confirming(payload):
        await e.cron.set_enabled(123, job['id'], {'enabled': False, 'expectedRevision': 1, 'requestId': 'edit'})
        return {'confirmed': True}

    ctx.web_confirm = change_while_confirming
    with pytest.raises(CronError) as caught:
        await dispatch(e.cron, 'delete', {'jobId': job['id'], 'expectedRevision': 1, 'requestId': 'delete'}, ctx)
    assert caught.value.payload['code'] == 'confirmation_stale'
    assert (await e.cron.get(123, job['id']))['job']['revision'] == 2
    assert not await one(e.db.conn, "SELECT 1 FROM cron_operations WHERE request_id='delete'")


async def notification_channels(e):
    from app.web_console.core import _sha256
    from app.web_push import BrowserPush
    from app.web_task_telegram import WebTaskTelegramNotifier
    from tests.test_web_push import add_device
    from tests.test_web_task_telegram import _config

    e.server.web_task_telegram = WebTaskTelegramNotifier(_config(), e.db, SimpleNamespace())
    e.server.browser_push = BrowserPush(e.db)
    await add_device(e.db)
    cookie = await _login_cookie(e)
    await e.db.conn.execute('UPDATE web_push_subscriptions SET session_token_hash=?', (_sha256(cookie),))
    await e.db.conn.commit()


@pytest.mark.parametrize('state,has_conversation,mode,expected', [
    ('running', True, 'both', 'enqueued'),
    ('running', True, 'silent', 'suppressed'),
    ('starting', False, 'both', 'unavailable'),
])
async def test_restart_notifies_interruption_once_without_replaying_business(cron_env, state, has_conversation, mode, expected):
    e = cron_env
    await notification_channels(e)
    job = (await e.cron.save(123, {'folderId': 'folder', 'name': 'Interrupted', 'requestId': 'create',
        'config': {'instructions': 'Do not rerun', 'notifications': {'mode': mode, 'errorsOnly': True},
                   'pre': {'enabled': True, 'code': "from pathlib import Path; Path('pre-ran').touch()"},
                   'post': {'enabled': True, 'code': "from pathlib import Path; Path('post-ran').touch()"}}}))['job']
    conv = await e.server._create_web_conversation(123, folder_uuid='folder') if has_conversation else None
    async with e.db.write_transaction() as conn:
        row = await e.cron.row(conn, 123, job['id'])
        accepted = await e.cron.accept_run(conn, row, e.cron.clock(), 'manual', 'interrupted')
        await conn.execute('UPDATE cron_runs SET status=?,conversation_uuid=? WHERE run_id=?',
                           (state, conv['conversation_uuid'] if conv else '', accepted['run_id']))
    await e.cron.close()
    await e.db.close()
    await e.db.connect()
    e.cron = CronService(e.db, e.server)
    e.server.cron = e.cron
    for _ in range(2):
        await e.cron.start()
        await e.cron.close()
        result = (await e.cron.get_run(123, accepted['run_id']))['run']
        assert result['status'] == result['outcome'] == 'interrupted'
        assert result['phase'] == 'finished' and result['notificationState'] == expected
        assert result['preAttempts'] == result['postAttempts'] == []
        assert (await e.cron.runs(123, {}))['total'] == 1
        assert len(await many(e.db.conn, 'SELECT * FROM web_tg_notification_outbox')) == int(expected == 'enqueued')
        assert len(await many(e.db.conn, 'SELECT * FROM web_push_deliveries')) == int(expected == 'enqueued')
    assert e.backend.calls == 0 and not e.cron.tasks
    assert not (e.tmp / 'pre-ran').exists() and not (e.tmp / 'post-ran').exists()


@pytest.mark.parametrize('mode', ['timeout', 'stop-pre', 'stop-post'])
@pytest.mark.parametrize('truncate', [False, True])
async def test_cancelled_script_preserves_captured_logs_and_reaps_process(cron_env, mode, truncate):
    e = cron_env
    limit = 1024
    e.server.config.webhooks.scripts.max_stdout_bytes = limit
    e.server.config.webhooks.scripts.max_stderr_bytes = limit
    stdout = 'output:' + 'x' * (2048 if truncate else 16) + '\n'
    stderr = 'diagnostic:' + 'y' * (2048 if truncate else 16) + '\n'
    code = (f"import os,sys,time\nfrom pathlib import Path\nsys.stdout.write({stdout!r});sys.stdout.flush()\n"
            f"sys.stderr.write({stderr!r});sys.stderr.flush()\nPath('logs-emitted').write_text(str(os.getpid()))\ntime.sleep(30)")
    phase = 'post' if mode == 'stop-post' else 'pre'
    job = await create(e, timeoutSeconds=.8 if mode == 'timeout' else None,
                       **{phase: {'enabled': True, 'code': code, 'timeoutSeconds': 30}})
    accepted = await e.cron.run(123, job['id'], {'requestId': 'run', 'expectedRevision': 1})
    async with asyncio.timeout(5):
        while not (e.tmp / 'logs-emitted').exists():
            await asyncio.sleep(.01)
    pid = int((e.tmp / 'logs-emitted').read_text())
    if mode != 'timeout':
        await e.cron.stop(123, accepted['run']['id'], {'requestId': 'stop'})
    await asyncio.wait_for(asyncio.gather(*list(e.cron.tasks.values())), 5)
    result = (await e.cron.get_run(123, accepted['run']['id']))['run']
    assert result['status'] == ('timed_out' if mode == 'timeout' else 'cancelled')
    attempt = result[phase + 'Attempts'][0]
    assert attempt['stdout'] == stdout[:limit] and attempt['stderr'] == stderr[:limit]
    assert attempt['stdoutTruncated'] is truncate and attempt['stderrTruncated'] is truncate
    assert attempt['errorClass'] == 'cancelled' and attempt['exitCode'] is not None
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.parametrize('events,include_result,elapsed,expected', [
    (['task_failed'], False, 86400000, 'suppressed'),
    (['task_completed'], False, 86400000, 'enqueued'),
    ([], True, 86400000, 'enqueued'),
    (['task_started', 'task_completed'], False, 0, 'suppressed'),
])
async def test_inherit_notification_state_tracks_actual_outbox(cron_env, events, include_result, elapsed, expected):
    from app.web_task_telegram import WebTaskTelegramNotifier
    from tests.test_web_task_telegram import _config

    e = cron_env
    cfg = _config()
    cfg.web.task_notifications.events = events
    cfg.web.task_notifications.include_result = include_result
    e.server.web_task_telegram = WebTaskTelegramNotifier(cfg, e.db, SimpleNamespace())
    result = await run(e, await create(e))
    row = await one(e.db.conn, 'SELECT * FROM cron_runs WHERE run_id=?', (result['id'],))
    config = json.loads(row['config_json'])
    config['notifications'] = {'mode': 'inherit', 'errorsOnly': False}
    await e.db.conn.execute("UPDATE cron_runs SET config_json=?,notification_state='pending',started_at_ms=? WHERE run_id=?",
                            (json.dumps(config), e.cron.clock() - elapsed, result['id']))
    await e.db.conn.commit()
    for _ in range(2):
        await deliver(e.cron, await one(e.db.conn, 'SELECT * FROM cron_runs WHERE run_id=?', (result['id'],)))
        assert (await e.cron.get_run(123, result['id']))['run']['notificationState'] == expected
        rows = await many(e.db.conn, "SELECT * FROM web_tg_notification_outbox WHERE state!='cancelled'")
        assert len(rows) == int(expected == 'enqueued')
        await e.db.conn.execute("UPDATE cron_runs SET notification_state='pending' WHERE run_id=?", (result['id'],))
        await e.db.conn.commit()


async def test_push_names_cron_job_and_uses_finished_time_not_retry_time(cron_env):
    e = cron_env
    await notification_channels(e)
    result = await run(e, await create(e, notifications={'mode': 'silent'}))
    row = await one(e.db.conn, 'SELECT * FROM cron_runs WHERE run_id=?', (result['id'],))
    config = json.loads(row['config_json'])
    config['notifications'] = {'mode': 'push', 'errorsOnly': False}
    start = e.cron.clock() - 600000
    await e.db.conn.execute("UPDATE cron_runs SET config_json=?,job_name='日报整理',notification_state='pending',started_at_ms=?,finished_at_ms=? WHERE run_id=?",
                            (json.dumps(config), start, start + 192000, result['id']))
    await e.db.conn.commit()
    await deliver(e.cron, await one(e.db.conn, 'SELECT * FROM cron_runs WHERE run_id=?', (result['id'],)))
    queued = await one(e.db.conn, 'SELECT payload_json FROM web_push_deliveries WHERE event_key=?', ('cron-result:' + result['id'],))
    assert json.loads(queued['payload_json'])['body'] == '定时任务：日报整理\n任务已完成 · 耗时 3分12秒'


async def test_push_subscription_disappearing_before_enqueue_is_not_reported_enqueued(cron_env, monkeypatch):
    e = cron_env
    await notification_channels(e)
    original = e.server.browser_push.subscriptions
    calls = 0

    async def subscriptions(owner):
        nonlocal calls
        calls += 1
        return await original(owner) if calls == 1 else []

    monkeypatch.setattr(e.server.browser_push, 'subscriptions', subscriptions)
    result = await run(e, await create(e, notifications={'mode': 'push'}))
    assert result['notificationState'] == 'suppressed'
    assert not await many(e.db.conn, 'SELECT * FROM web_push_deliveries')


async def test_job_path_uses_full_owned_tree_in_get_and_list(cron_env):
    e = cron_env
    await e.db.conn.execute("INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name) VALUES('other',123,'Other')")
    await e.db.conn.execute("INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name,parent_uuid) VALUES('leaf-a',123,'Leaf','folder'),('leaf-b',123,'Leaf','other')")
    await e.db.conn.commit()
    jobs = []
    for fid in ['leaf-a', 'leaf-b']:
        jobs.append((await e.cron.save(123, {'folderId': fid, 'name': fid, 'requestId': fid}))['job'])
    paths = {f['id']: f['path'] for f in (await e.cron.folders(123))['items']}
    assert {j['folderPath'] for j in jobs} == {'Fixture / Leaf', 'Other / Leaf'}
    for job in (await e.cron.list(123, {}))['items']:
        assert job['folderName'] == 'Leaf' and job['folderPath'] == paths[job['folderId']]
        assert (await e.cron.get(123, job['id']))['job']['folderPath'] == job['folderPath']
    await e.db.conn.execute("UPDATE web_conversation_folders SET name='Renamed' WHERE folder_uuid='folder'")
    await e.db.conn.commit()
    assert (await e.cron.get(123, jobs[0]['id']))['job']['folderPath'] == 'Renamed / Leaf'
