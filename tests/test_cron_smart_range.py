"""Smart calendar rules preserve seconds, bounds and confirmed CN rest days."""
import pytest

from app.cron.contracts import Schedule, timestamp
from app.cron.schedule import next_time, preview, preview_details
from tests.test_cron_calendar import env, job, params, base_env  # noqa: F401


def rule(kind='cron', **extra):
    return {'kind': kind, 'timezone': 'Asia/Shanghai', 'expression': '0 12 * * *',
            'second': 23 if kind == 'cron' else 0,
            'startAt': '2026-10-06T12:00:23+08:00', 'endAt': '2026-10-12T00:00:00+08:00',
            **({'anchorAt': '2026-10-06T12:00:23+08:00', 'everySeconds': 3600} if kind == 'every' else {}), **extra}


def test_daily_seconds_and_holidays():
    s = Schedule.model_validate(rule(skipHolidays=True))
    assert preview(s, timestamp('2026-10-05T00:00:00Z'), 20) == [
        '2026-10-08T04:00:23Z', '2026-10-09T04:00:23Z', '2026-10-10T04:00:23Z']
    assert next_time(s, timestamp('2026-10-10T04:00:23Z')) is None


@pytest.mark.parametrize('seconds', [60, 3600])
def test_intervals_start_exactly_at_anchor_and_end_exclusively(seconds):
    s = Schedule.model_validate(rule('every', everySeconds=seconds, endAt='2026-10-06T13:00:23+08:00'))
    first = timestamp(s.start_at)
    assert next_time(s, first - 1) == first
    assert next_time(s, first) == (first + seconds * 1000 if seconds < 3600 else None)
    assert next_time(s, timestamp(s.end_at) - 1) is None


def test_interval_skips_days_without_resetting_anchor():
    s = Schedule.model_validate(rule('every', skipHolidays=True, everySeconds=3600))
    assert preview(s, timestamp('2026-10-05T00:00:00Z'), 2) == ['2026-10-07T16:00:23Z', '2026-10-07T17:00:23Z']
    assert next_time(s, timestamp('2026-10-10T23:00:23+08:00')) is None


def test_unknown_year_and_all_skipped_range_are_explicit():
    schedule = Schedule.model_validate(rule(skipHolidays=True, endAt='2027-01-03T00:00:00+08:00'))
    assert preview(schedule, timestamp('2026-10-05T00:00:00Z'))  # Known dates do not depend on a future year's notice.
    waiting = preview_details(schedule, timestamp('2026-12-30T13:00:00+08:00'))
    assert waiting['times'] == ['2026-12-31T04:00:23Z']
    assert waiting['waitingYears'] == [2027]
    assert preview(Schedule.model_validate(rule(skipHolidays=True, endAt='2026-10-08T00:00:00+08:00')), timestamp('2026-10-05T00:00:00Z')) == []


@pytest.mark.parametrize('kind', ['cron', 'every'])
async def test_paused_calendar_and_live_timer_obey_same_rest_days_and_bounds(env, kind):
    e = env
    saved = await e.cron.save(123, {'folderId': 'folder', 'name': 'Bounded rest days', 'enabled': False,
        'requestId': f'smart-{kind}', 'config': {'instructions': 'isolated fixture', 'schedule': rule(kind, skipHolidays=True)}})
    j = saved['job']
    shown = await e.cron.calendar(123, params(end='2026-10-13T00:00:00Z', timezone='Asia/Shanghai'))
    assert {i['date'] for i in shown['items']} == {'2026-10-08', '2026-10-09', '2026-10-10'}
    assert all(i['status'] == 'disabled' for i in shown['items'])
    if kind == 'every':
        assert [i['count'] for i in shown['items']] == [24, 24, 24]
    assert next(a for a in shown['annotations'] if a['date'] == '2026-10-10')['isDayOff'] is False
    assert shown['holidayCalendar']['years'] == [2026]
    on = (await e.cron.set_enabled(123, j['id'], {'enabled': True, 'expectedRevision': 1, 'requestId': f'on-{kind}'}))['job']
    first = on['nextRunAt']
    assert first == shown['items'][0]['at']
    launches = []
    e.cron.launch = launches.append
    e.now = timestamp(first)
    await e.cron.tick()
    assert len(launches) == 1
    e.now = timestamp(rule(kind)['endAt'])
    await e.cron.tick()
    assert len(launches) == 1
    assert (await e.cron.get(123, j['id']))['job']['scheduleState'] == 'exhausted'


async def test_interval_calendar_uses_rule_timezone_for_holidays(env):
    await job(env, schedule=rule('every', skipHolidays=True))
    shown = await env.cron.calendar(123, params(end='2026-10-13T00:00:00Z', timezone='UTC'))
    assert sum(i['count'] for i in shown['items']) == 72
    assert min(i['at'] for i in shown['items']) == '2026-10-07T16:00:23Z'
    assert max(i['lastAt'] for i in shown['items']) == '2026-10-10T15:00:23Z'
