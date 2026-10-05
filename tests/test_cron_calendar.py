"""Calendar acceptance: isolated SQLite/HTTP, no scheduler or execution launched."""
from __future__ import annotations

import uuid

import pytest

from app.cron import calendar as calendar_module
from app.cron.contracts import CronError, JobConfig, Schedule, timestamp
from app.cron.schedule import next_time
from app.cron.service import CronService
from app.webhooks.contracts import dumps, iso
from app.webhooks.repository import insert, many, one
from tests.test_web_admin import _login_cookie
from tests.test_webhooks_backend import env as base_env


@pytest.fixture
async def env(base_env):  # noqa: F811 - pytest fixture dependency
    e = base_env
    e.now = timestamp('2026-10-05T12:00:00Z')
    e.cron = CronService(e.db, e.server, clock=lambda: e.now)
    e.server.cron = e.cron
    yield e
    await e.cron.close()


async def job(e, *, schedule=None, name='Calendar', description='', owner=123,
              folder='folder', enabled=True, created='2026-01-01T00:00:00Z',
              deleted=False, state=None):
    config = JobConfig.model_validate({'instructions': 'Isolated fixture only.', 'schedule': schedule or {
        'kind': 'cron', 'timezone': 'UTC', 'expression': '0 9 * * *'}})
    job_id = uuid.uuid4().hex
    await insert(e.db.conn, 'cron_jobs', job_id=job_id, owner_chat_id=owner, folder_id=folder,
                 name=name, description=description, enabled=int(enabled), config_json=dumps(config.wire()),
                 next_run_at_ms=next_time(config.schedule, e.now) if enabled else None,
                 schedule_state=state or ('armed' if enabled else 'disabled'),
                 created_at_ms=timestamp(created), updated_at_ms=e.now,
                 deleted_at_ms=e.now if deleted else None)
    await e.db.conn.commit()
    return await one(e.db.conn, 'SELECT * FROM cron_jobs WHERE job_id=?', (job_id,))


async def run(e, j, at, status='completed', *, name=None, trigger='scheduled', started=None):
    at = timestamp(at)
    run_id = uuid.uuid4().hex
    await insert(e.db.conn, 'cron_runs', run_id=run_id, job_id=j['job_id'],
                 owner_chat_id=j['owner_chat_id'], folder_id=j['folder_id'],
                 job_name=j['name'] if name is None else name, trigger_kind=trigger,
                 scheduled_at_ms=at, occurrence_key=f'{trigger}:{run_id}',
                 config_json=j['config_json'], config_revision=1, root_turn_uuid=uuid.uuid4().hex,
                 conversation_uuid='conversation-' + run_id, status=status,
                 started_at_ms=at if started is None else timestamp(started))
    await e.db.conn.commit()
    return run_id


def params(start='2026-10-01T00:00:00Z', end='2026-10-10T00:00:00Z', timezone='UTC', **extra):
    return dict(start=start, end=end, timezone=timezone, **extra)


async def test_daily_history_snapshots_and_current_future_are_separate(env):
    e = env
    j = await job(e)
    a = await run(e, j, '2026-10-02T09:00:00Z', name='Old success')
    b = await run(e, j, '2026-10-04T09:00:00Z', 'failed', name='Old failure',
                  started='2026-10-15T00:00:00Z')
    result = await e.cron.calendar(123, params())
    assert result['warnings'] == [] and result['now'] == iso(e.now)
    assert result['jobs'] == [(await e.cron.get(123, j['job_id']))['job']]
    assert result['totalJobs'] == 1
    history = [x for x in result['items'] if not x['projected']]
    assert [(x['runId'], x['name'], x['status'], x['date']) for x in history] == [
        (a, 'Old success', 'completed', '2026-10-02'), (b, 'Old failure', 'failed', '2026-10-04')]
    future = [x for x in result['items'] if x['projected']]
    assert [x['date'] for x in future] == [f'2026-10-{d:02}' for d in range(6, 10)]
    for item in result['items']:
        assert item['count'] == 1 and item['lastAt'] == item['at']
        assert item['statusCounts'] == {item['status']: 1}
        assert item['folderPath'] == 'Fixture'
    assert all(x['status'] == 'waiting' and x['name'] == 'Calendar' and
               not x['runId'] and not x['conversationId'] for x in future)
    assert len({x['id'] for x in result['items']}) == len(result['items'])
    assert await e.cron.calendar(123, params()) == result


async def test_pause_and_missing_target_do_not_relabel_history(env):
    e = env
    j = await job(e)
    await run(e, j, '2026-10-04T09:00:00Z', 'failed')
    before = await e.cron.calendar(123, params())
    await e.cron.set_enabled(123, j['job_id'], {
        'enabled': False, 'expectedRevision': 1, 'requestId': 'pause-fixture'})
    paused = await e.cron.calendar(123, params())
    assert [x for x in paused['items'] if not x['projected']] == [
        x for x in before['items'] if not x['projected']]
    assert {x['status'] for x in paused['items'] if x['projected']} == {'disabled'}
    await e.db.conn.execute("DELETE FROM web_conversation_folders WHERE folder_uuid='folder'")
    await e.db.conn.commit()
    missing = await e.cron.calendar(123, params())
    assert {x['status'] for x in missing['items'] if x['projected']} == {'target_missing'}
    assert [x['status'] for x in missing['items'] if not x['projected']] == ['failed']
    assert all(x['folderPath'] == '' for x in missing['items'])


async def test_deleted_and_orphaned_jobs_keep_actual_history(env):
    e = env
    deleted = await job(e, deleted=True, enabled=False)
    orphan = await job(e, name='Orphan')
    a = await run(e, deleted, '2026-10-03T00:00:00Z', name='Deleted snapshot')
    b = await run(e, orphan, '2026-10-04T00:00:00Z', trigger='manual')
    await e.db.conn.execute('DELETE FROM cron_jobs WHERE job_id=?', (orphan['job_id'],))
    await e.db.conn.commit()
    result = await e.cron.calendar(123, params())
    assert result['jobs'] == [] and result['totalJobs'] == 0
    assert [x['runId'] for x in result['items']] == [a, b]
    assert [x['trigger'] for x in result['items']] == ['scheduled', 'manual']
    assert not any(x['projected'] for x in result['items'])
    assert (await e.cron.calendar(123, params(search='Orphan')))['items'][0]['runId'] == b
    assert (await e.cron.calendar(123, params(enabled='false')))['items'][0]['runId'] == a


@pytest.mark.parametrize(('at', 'state', 'expected'), [
    ('2026-10-05T11:59:59Z', 'armed', 0),
    ('2026-10-05T12:00:00Z', 'armed', 1),
    ('2026-10-06T00:00:00Z', 'armed', 1),
    ('2026-10-10T00:00:00Z', 'armed', 0),
    ('2026-10-06T00:00:00Z', 'exhausted', 0),
    ('2026-10-06T00:00:00Z', 'missed', 0),
])
async def test_once_now_and_half_open_bounds(env, at, state, expected):
    await job(env, schedule={'kind': 'at', 'at': at}, state=state)
    result = await env.cron.calendar(123, params())
    assert len(result['items']) == expected
    if expected:
        assert result['items'][0]['at'] == at


async def test_created_bound_and_no_backfilled_past(env):
    e = env
    await job(e, created='2026-10-07T09:00:00Z')
    result = await e.cron.calendar(123, params())
    assert [x['date'] for x in result['items']] == ['2026-10-07', '2026-10-08', '2026-10-09']
    assert not (await e.cron.calendar(123, params(end='2026-10-05T12:00:00Z')))['items']


async def test_scheduled_occurrence_dedup_but_manual_is_independent(env):
    e = env
    j = await job(e, schedule={'kind': 'at', 'at': iso(e.now)})
    manual = await run(e, j, e.now, trigger='manual')
    result = await e.cron.calendar(123, params())
    assert len(result['items']) == 2 and sum(x['projected'] for x in result['items']) == 1
    scheduled = await run(e, j, e.now, status='running')
    result = await e.cron.calendar(123, params())
    assert {x['runId'] for x in result['items']} == {manual, scheduled}
    assert not any(x['projected'] for x in result['items'])


@pytest.mark.parametrize('count', [8, 9])
async def test_high_frequency_threshold(env, count):
    e = env
    await job(e, schedule={'kind': 'every', 'everySeconds': 1, 'anchorAt': iso(e.now)})
    result = await e.cron.calendar(123, params(start=iso(e.now), end=iso(e.now + count * 1000)))
    assert sum(x['count'] for x in result['items']) == count
    assert len(result['items']) == (8 if count == 8 else 1)
    assert result['items'][0]['at'] == iso(e.now)
    assert result['items'][-1]['lastAt'] == iso(e.now + (count - 1) * 1000)
    assert result['items'][0]['statusCounts'] == {'waiting': 1 if count == 8 else count}


async def test_second_interval_45_days_uses_arithmetic(env, monkeypatch):
    e = env
    e.now = timestamp('2026-10-01T00:00:00Z')
    await job(e, schedule={'kind': 'every', 'everySeconds': 1, 'anchorAt': iso(e.now)})
    calls = []
    actual = calendar_module.next_time
    def counted(*args):
        calls.append(args)
        assert len(calls) <= 1, 'second-level calendar must not enumerate occurrences'
        return actual(*args)
    monkeypatch.setattr(calendar_module, 'next_time', counted)
    result = await e.cron.calendar(123, params(iso(e.now), iso(e.now + 45 * 86400000)))
    assert result['warnings'] == [] and len(calls) == 1
    assert len(result['items']) == 45
    assert all(x['count'] == 86400 and x['statusCounts'] == {'waiting': 86400} for x in result['items'])
    assert sum(x['count'] for x in result['items']) == 3_888_000


@pytest.mark.parametrize('remaining', [7, 27])
async def test_interval_excludes_real_first_last_and_middle_occurrences(env, remaining):
    e = env
    j = await job(e, schedule={'kind': 'every', 'everySeconds': 1, 'anchorAt': iso(e.now)})
    for offset in (0, 3, remaining + 2):
        await run(e, j, e.now + offset * 1000, status='running')
    result = await e.cron.calendar(123, params(iso(e.now), iso(e.now + (remaining + 3) * 1000)))
    future = [x for x in result['items'] if x['projected']]
    assert sum(x['count'] for x in future) == remaining
    assert future[0]['at'] == iso(e.now + 1000)
    assert future[-1]['lastAt'] == iso(e.now + (remaining + 1) * 1000)
    assert len(future) == (remaining if remaining <= 8 else 1)
    assert sum(x['count'] for x in result['items'] if not x['projected']) == 3


async def test_history_aggregation_exact_status_counts_separate_from_projections(env):
    e = env
    j = await job(e, schedule={'kind': 'every', 'everySeconds': 1, 'anchorAt': iso(e.now)})
    for i in range(12):
        await run(e, j, e.now - (12 - i) * 1000, 'failed' if i < 3 else 'completed',
                  trigger='manual' if i == 0 else 'scheduled', name=f'Snapshot {i}')
    result = await e.cron.calendar(123, params(iso(e.now - 12000), iso(e.now + 12000)))
    assert len(result['items']) == 2
    history, future = result['items']
    assert not history['projected'] and future['projected']
    assert history['count'] == future['count'] == 12
    assert history['name'] == 'Snapshot 0'
    assert history['status'] == 'mixed' and history['trigger'] == 'mixed'
    assert history['statusCounts'] == {'failed': 3, 'completed': 9}
    assert future['statusCounts'] == {'waiting': 12}
    assert history['at'] == iso(e.now - 12000) and history['lastAt'] == iso(e.now - 1000)
    assert not history['runId'] and not history['conversationId']


async def test_display_timezone_groups_and_partial_day_interval_phase(env):
    e = env
    e.now = timestamp('2026-10-05T15:59:58Z')
    j = await job(e, schedule={'kind': 'every', 'everySeconds': 3,
                              'anchorAt': '2026-10-05T15:59:57Z'})
    await run(e, j, '2026-10-05T15:59:59Z', trigger='manual')
    await run(e, j, '2026-10-05T16:00:00Z', trigger='manual')
    result = await e.cron.calendar(123, params('2026-10-05T15:59:58Z', '2026-10-05T16:00:07Z',
                                             'Asia/Shanghai'))
    assert [(x['at'], x['date']) for x in result['items'] if not x['projected']] == [
        ('2026-10-05T15:59:59Z', '2026-10-05'), ('2026-10-05T16:00:00Z', '2026-10-06')]
    future = [x for x in result['items'] if x['projected']]
    assert [x['at'] for x in future] == ['2026-10-05T16:00:00Z', '2026-10-05T16:00:03Z', '2026-10-05T16:00:06Z']
    assert {x['date'] for x in future} == {'2026-10-06'}


@pytest.mark.parametrize(('start', 'end', 'hours'), [
    ('2026-03-08T00:00:00-05:00', '2026-03-09T00:00:00-04:00', 23),
    ('2026-11-01T00:00:00-04:00', '2026-11-02T00:00:00-05:00', 25),
])
async def test_dst_interval_counts_display_civil_days(env, start, end, hours):
    e = env
    e.now = timestamp(start)
    await job(e, schedule={'kind': 'every', 'everySeconds': 1, 'anchorAt': start})
    result = await e.cron.calendar(123, params(start, end, 'America/New_York'))
    assert result['warnings'] == [] and len(result['items']) == 1
    item = result['items'][0]
    assert item['count'] == hours * 3600 and item['date'] == start[:10]
    assert item['at'] == iso(timestamp(start)) and item['lastAt'] == iso(timestamp(end) - 1000)


@pytest.mark.parametrize(('start', 'end', 'expression', 'expected'), [
    ('2026-03-07T00:00:00-05:00', '2026-03-10T00:00:00-04:00', '30 2 * * *',
     ['2026-03-07T07:30:00Z', '2026-03-09T06:30:00Z']),
    ('2026-10-31T00:00:00-04:00', '2026-11-03T00:00:00-05:00', '30 1 * * *',
     ['2026-10-31T05:30:00Z', '2026-11-01T05:30:00Z', '2026-11-02T06:30:00Z']),
])
async def test_cron_reuses_scheduler_dst_rules(env, start, end, expression, expected):
    e = env
    e.now = timestamp(start)
    schedule = {'kind': 'cron', 'timezone': 'America/New_York', 'expression': expression}
    await job(e, schedule=schedule)
    result = await e.cron.calendar(123, params(start, end, 'America/New_York'))
    assert result['warnings'] == []
    assert [x['at'] for x in result['items']] == expected
    cursor = e.now - 1
    for at in expected:
        cursor = next_time(Schedule.model_validate(schedule), cursor)
        assert iso(cursor) == at


async def test_minutely_cron_aggregate_and_occurrence_dedup(env):
    e = env
    e.now = timestamp('2026-10-05T00:00:00Z')
    j = await job(e, schedule={'kind': 'cron', 'timezone': 'UTC', 'expression': '* * * * *'})
    await run(e, j, e.now, status='running')
    result = await e.cron.calendar(123, params(iso(e.now), iso(e.now + 86400000)))
    assert result['warnings'] == [] and len(result['items']) == 2
    projected = next(x for x in result['items'] if x['projected'])
    assert projected['count'] == 1439 and projected['statusCounts'] == {'waiting': 1439}
    assert projected['at'] == iso(e.now + 60000)
    assert projected['lastAt'] == iso(e.now + 86340000)


async def test_cron_budget_warns_and_omits_incomplete_day_not_partial_count(env, monkeypatch):
    e = env
    e.now = timestamp('2026-10-05T00:00:00Z')
    j = await job(e)
    await run(e, j, '2026-10-04T09:00:00Z', 'failed')
    monkeypatch.setattr(calendar_module, 'MAX_CRON_STEPS', 3)
    result = await e.cron.calendar(123, params())
    assert len(result['warnings']) == 1
    assert j['job_id'] in result['warnings'][0] and '2026-10-06' in result['warnings'][0]
    assert [(x['date'], x['status']) for x in result['items']] == [
        ('2026-10-04', 'failed'), ('2026-10-05', 'waiting')]


async def test_filters_ownership_and_no_list_pagination(env):
    e = env
    for i in range(105):
        await job(e, name=f'All {i}', enabled=False)
    desired = await job(e, name='Needle', description='Match description')
    foreign = await job(e, owner=999, name='Needle')
    missing = await job(e, folder='missing', name='Needle')
    await run(e, desired, '2026-10-02T00:00:00Z')
    await run(e, foreign, '2026-10-03T00:00:00Z', name='SECRET')
    await run(e, missing, '2026-10-04T00:00:00Z')
    result = await e.cron.calendar(123, params(limit='1', offset='100'))
    assert result['totalJobs'] == len(result['jobs']) == 107
    assert len({x['jobId'] for x in result['items']}) == 107
    assert foreign['job_id'] not in {x['id'] for x in result['jobs']}
    assert foreign['job_id'] not in {x['jobId'] for x in result['items']}
    selected = await e.cron.calendar(123, params(folderId='folder', search='nEEdLe', enabled='TRUE'))
    assert [x['id'] for x in selected['jobs']] == [desired['job_id']]
    assert {x['jobId'] for x in selected['items']} == {desired['job_id']}
    assert (await e.cron.calendar(123, params(search='description')))['totalJobs'] == 1
    assert (await e.cron.calendar(123, params(enabled='false')))['totalJobs'] == 105
    assert not (await e.cron.calendar(123, params(folderId='foreign')))['items']
    assert not (await e.cron.calendar(321, params()))['items']


@pytest.mark.parametrize(('patch', 'code'), [
    ({'start': None}, 'invalid_calendar_range'),
    ({'end': ''}, 'invalid_calendar_range'),
    ({'start': 'garbage'}, 'invalid_calendar_range'),
    ({'start': 123456789}, 'invalid_calendar_range'),
    ({'start': '2026-10-01T00:00:00'}, 'invalid_calendar_range'),
    ({'end': '2026-10-01T00:00:00Z'}, 'invalid_calendar_range'),
    ({'end': '2026-09-30T00:00:00Z'}, 'invalid_calendar_range'),
    ({'end': '2026-11-16T00:00:00Z'}, 'invalid_calendar_range'),
    ({'timezone': None}, 'invalid_timezone'),
    ({'timezone': 'not/a-zone'}, 'invalid_timezone'),
    ({'enabled': '1'}, 'invalid_enabled'),
])
async def test_invalid_parameters(env, patch, code):
    with pytest.raises(CronError) as exc:
        await env.cron.calendar(123, {**params(), **patch})
    assert exc.value.status == 422 and exc.value.payload['code'] == code


async def test_45_local_days_dst_margin_and_fractional_range(env):
    e = env
    assert not (await e.cron.calendar(123, params(
        '2026-10-01T00:00:00-04:00', '2026-11-15T00:00:00-05:00', 'America/New_York')))['warnings']
    e.now = timestamp('2026-10-05T00:00:00Z')
    j = await job(e, schedule={'kind': 'every', 'everySeconds': 1, 'anchorAt': iso(e.now)})
    await run(e, j, e.now, trigger='manual')
    result = await e.cron.calendar(123, params('2026-10-05T00:00:00.000001Z',
                                             '2026-10-05T00:00:01.000001Z'))
    assert [x['at'] for x in result['items']] == ['2026-10-05T00:00:01Z']


async def test_http_auth_validation_and_read_only(env, monkeypatch):
    e = env
    await job(e)
    response = await e.client.get('/api/cron/calendar', params=params())
    assert response.status == 401
    cookies = {'openbear_web_session': await _login_cookie(e)}
    assert (await e.client.get('/api/cron/calendar', cookies=cookies)).status == 422
    bad = await e.client.get('/api/cron/calendar', cookies=cookies, params=params(timezone='invalid'))
    assert bad.status == 422 and (await bad.json())['code'] == 'invalid_timezone'
    bad = await e.client.get('/api/cron/calendar', cookies=cookies,
                             params=params(end='2027-10-01T00:00:00Z'))
    assert bad.status == 422 and (await bad.json())['code'] == 'invalid_calendar_range'

    before = {table: await many(e.db.conn, 'SELECT * FROM ' + table)
              for table in ('cron_jobs', 'cron_runs', 'cron_operations', 'web_conversations')}
    def forbidden(*args, **kwargs):
        raise AssertionError('calendar may not mutate or launch executions')
    monkeypatch.setattr(e.db, 'write_transaction', forbidden)
    monkeypatch.setattr(e.cron, 'launch', forbidden)
    statements = []
    execute = e.db.conn.execute
    async def read_only(sql, *args, **kwargs):
        statements.append(sql)
        assert sql.lstrip().upper().startswith('SELECT')
        return await execute(sql, *args, **kwargs)
    changes = e.db.conn.total_changes
    with monkeypatch.context() as scoped:
        scoped.setattr(e.db.conn, 'execute', read_only)
        scoped.setattr(e.db.conn, 'executemany', forbidden)
        scoped.setattr(e.db.conn, 'executescript', forbidden)
        direct = await e.cron.calendar(123, params())
    assert statements and e.db.conn.total_changes == changes
    response = await e.client.get('/api/cron/calendar', cookies=cookies, params=params())
    assert response.status == 200 and response.headers['Cache-Control'] == 'no-store'
    assert await response.json() == direct
    assert not e.cron.wake.is_set() and not e.cron.tasks
    assert {table: await many(e.db.conn, 'SELECT * FROM ' + table) for table in before} == before
