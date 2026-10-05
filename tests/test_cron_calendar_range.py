"""A dragged date range is one finite rule, shared by preview, calendar and timer."""
from datetime import datetime, timedelta

import pytest

from app.cron.contracts import Schedule, timestamp
from app.cron.schedule import next_time, preview
from app.webhooks.repository import many
from tests.test_cron_calendar import env, job, params, base_env  # noqa: F401 - fixtures


def bounded(days=3, **extra):
    end = datetime.fromisoformat('2026-10-06T00:00:00+08:00') + timedelta(days=days)
    return {'kind': 'cron', 'timezone': 'Asia/Shanghai', 'expression': '0 12 * * *',
            'startAt': '2026-10-06T00:00:00+08:00', 'endAt': end.isoformat(), **extra}


@pytest.mark.parametrize('days', [3, 7, 15])
def test_preview_exactly_n_noons_then_stops(days):
    schedule = Schedule.model_validate(bounded(days))
    times = preview(schedule, timestamp('2026-10-01T00:00:00Z'), 20)
    assert times == [f'2026-10-{day:02}T04:00:00Z' for day in range(6, 6 + days)]
    assert next_time(schedule, timestamp(times[-1])) is None
    assert next_time(schedule, timestamp(schedule.end_at)) is None


def test_start_is_inclusive_end_exclusive_and_unbounded_rules_unchanged():
    schedule = Schedule.model_validate(bounded(startAt='2026-10-06T12:00:00+08:00', endAt='2026-10-08T12:00:00+08:00'))
    assert preview(schedule, timestamp('2026-10-01T00:00:00Z'), 5) == ['2026-10-06T04:00:00Z', '2026-10-07T04:00:00Z']
    assert len(preview(Schedule(expression='0 12 * * *'), timestamp('2026-10-01T00:00:00Z'), 20)) == 20


@pytest.mark.parametrize('patch', [
    {'startAt': '2026-10-09T00:00:00+08:00'},
    {'startAt': '2026-10-06T00:00:00'},
    {'endAt': 'bad'},
    {'kind': 'at', 'at': '2026-10-06T12:00:00+08:00'},
])
def test_invalid_range_rejected(patch):
    with pytest.raises(ValueError):
        Schedule.model_validate(bounded(**patch))


def test_calendar_days_keep_noon_across_dst():
    schedule = Schedule.model_validate(bounded(timezone='America/New_York',
        startAt='2026-10-31T00:00:00-04:00', endAt='2026-11-03T00:00:00-05:00'))
    assert preview(schedule, timestamp('2026-10-30T00:00:00Z'), 10) == [
        '2026-10-31T16:00:00Z', '2026-11-01T17:00:00Z', '2026-11-02T17:00:00Z']


@pytest.mark.parametrize('days', [3, 7, 15])
async def test_calendar_only_projects_selected_dates_and_pause_preserves_range(env, days):
    e = env
    j = await job(e, schedule=bounded(days))
    result = await e.cron.calendar(123, params(end='2026-11-01T00:00:00Z', timezone='Asia/Shanghai'))
    assert [item['date'] for item in result['items']] == [f'2026-10-{day:02}' for day in range(6, 6 + days)]
    assert all(item['at'].endswith('T04:00:00Z') for item in result['items'])
    await e.cron.set_enabled(123, j['job_id'], {'enabled': False, 'expectedRevision': 1, 'requestId': 'pause-range'})
    paused = await e.cron.calendar(123, params(end='2026-11-01T00:00:00Z', timezone='Asia/Shanghai'))
    assert [x['at'] for x in paused['items']] == [x['at'] for x in result['items']]
    assert all(x['status'] == 'disabled' for x in paused['items'])


async def test_real_save_read_update_preview_and_timer_share_boundaries(env):
    e = env
    saved = await e.cron.save(123, {'folderId': 'folder', 'name': 'Three noons', 'enabled': True,
        'requestId': 'create-range', 'config': {'instructions': 'Isolated fixture only.', 'schedule': bounded()}})
    j = saved['job']
    assert j['config']['schedule']['startAt'] == bounded()['startAt']
    assert j['config']['schedule']['endAt'] == bounded()['endAt']
    assert j['nextRunAt'] == '2026-10-06T04:00:00Z'
    # Saving another field must not silently drop the selected dates.
    updated = await e.cron.save(123, {'name': 'Renamed', 'enabled': True, 'expectedRevision': j['revision'],
        'requestId': 'edit-range', 'config': j['config']}, j['id'])
    assert updated['job']['config']['schedule'] == j['config']['schedule']
    assert len(e.cron.preview({'schedule': j['config']['schedule'], 'count': 20})['times']) == 3
    launched = []
    e.cron.launch = lambda row: launched.append(row)
    e.now = timestamp('2026-10-06T03:59:59Z')
    await e.cron.tick()
    assert launched == []
    for day in (6, 7, 8):
        e.now = timestamp(f'2026-10-{day:02}T04:00:00Z')
        await e.cron.tick()
    assert len(launched) == 3
    e.now = timestamp('2026-10-09T04:00:00Z')
    await e.cron.tick()
    assert len(launched) == 3
    ended = (await e.cron.get(123, j['id']))['job']
    assert ended['nextRunAt'] is None and ended['scheduleState'] == 'exhausted'
    assert len(await many(e.db.conn, 'SELECT * FROM cron_jobs')) == 1


async def test_late_tick_does_not_launch_after_the_end_date(env):
    e = env
    j = await job(e, schedule=bounded())
    e.cron.launch = lambda row: pytest.fail('An expired range must never launch')
    e.now = timestamp('2026-10-09T00:00:00+08:00')
    await e.cron.tick()
    ended = (await e.cron.get(123, j['job_id']))['job']
    assert ended['nextRunAt'] is None and ended['scheduleState'] == 'exhausted'
    assert not await many(e.db.conn, 'SELECT * FROM cron_runs')


async def test_restart_and_reenable_cannot_resurrect_expired_range(env):
    e = env
    j = await job(e, schedule=bounded())
    e.now = timestamp('2026-10-20T00:00:00Z')
    async def no_timer():
        pass
    e.cron.loop = no_timer
    await e.cron.start()
    ended = (await e.cron.get(123, j['job_id']))['job']
    assert ended['nextRunAt'] is None and ended['scheduleState'] == 'exhausted'
    off = (await e.cron.set_enabled(123, j['job_id'], {'enabled': False, 'expectedRevision': 1, 'requestId': 'off'}))['job']
    on = (await e.cron.set_enabled(123, j['job_id'], {'enabled': True, 'expectedRevision': off['revision'], 'requestId': 'on'}))['job']
    assert on['nextRunAt'] is None and on['scheduleState'] == 'exhausted'
    assert not await many(e.db.conn, 'SELECT * FROM cron_runs')
