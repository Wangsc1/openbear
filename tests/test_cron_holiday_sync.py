"""Dynamic calendar acceptance with isolated storage, HTTP and deterministic time."""
import asyncio
import copy
from datetime import date

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from app.cron.contracts import Schedule, timestamp
from app.cron.holiday_sync import HolidayStore, INDEX, Unpublished, validate_year
from app.cron.holidays import BUNDLED_RECORDS, CalendarSnapshot, MissingCalendar
from app.cron.schedule import next_time
from app.cron.service import CronService
from app.webhooks.repository import many, one
from tests.test_cron_calendar import env, base_env, params  # noqa: F401
from tests.test_web_admin import _login_cookie


def annual(year=2027):
    # Deliberately fictional test-only notice, never a prediction or live cache.
    return {'year': year, 'papers': ['https://www.gov.cn/test-notice'], 'days': [
        {'date': f'{year}-01-01', 'name': '元旦', 'isOffDay': True},
        {'date': f'{year}-01-02', 'name': '元旦', 'isOffDay': False},
        {'date': f'{year}-05-01', 'name': '劳动节', 'isOffDay': True},
        {'date': f'{year}-10-01', 'name': '国庆节', 'isOffDay': True},
    ]}


def source(monkeypatch, store, records):
    calls = []
    async def fetch(session, url):
        calls.append(url)
        if url == INDEX:
            return [{'name': f'{y}.json'} for y in records]
        year = int(url.rsplit('/', 1)[-1][:4])
        if year not in records:
            raise Unpublished('404 fixture')
        value = records[year]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)
    monkeypatch.setattr(store, 'fetch', fetch)
    return calls


async def sync(service):
    service.request_holiday_sync()
    await service.holiday_refresh_task
    return service.holiday_status()


async def save(e, kind='cron', **extra):
    schedule = {'kind': kind, 'timezone': 'Asia/Shanghai', 'skipHolidays': True,
                **({'expression': '0 9 * * *'} if kind == 'cron' else
                   {'everySeconds': 86400, 'anchorAt': '2026-12-31T09:00:00+08:00'}), **extra}
    return (await e.cron.save(123, {'folderId': 'folder', 'name': kind, 'enabled': True,
        'requestId': f'create-{kind}', 'config': {'instructions': 'Fixture only', 'schedule': schedule}}))['job']


@pytest.mark.parametrize('invalid', ['empty', 'partial', 'year', 'boolean', 'conflict', 'source', 'date'])
def test_reject_invalid_annual_data(invalid):
    record = annual()
    if invalid == 'empty': record.update(papers=[], days=[])
    if invalid == 'partial': record['days'] = record['days'][:1]
    if invalid == 'year': record['year'] = 2026
    if invalid == 'boolean': record['days'][0]['isOffDay'] = 1
    if invalid == 'conflict': record['days'].append({**record['days'][0], 'isOffDay': False})
    if invalid == 'source': record['papers'] = ['https://gov.cn.example.com/fake']
    if invalid == 'date': record['days'][0]['date'] = '2027-02-30'
    with pytest.raises(ValueError): validate_year(record, 2027)


def test_later_notice_controls_explicit_previous_december_not_entire_unknown_year():
    record = annual()
    record['days'].append({'date': '2026-12-31', 'name': '跨年假期', 'isOffDay': True})
    snapshot = CalendarSnapshot({**BUNDLED_RECORDS, 2027: validate_year(record, 2027)}, 'fixture')
    assert snapshot.is_day_off(date(2026, 12, 31)) is True
    assert snapshot.is_day_off(date(2027, 1, 2)) is False
    with pytest.raises(MissingCalendar): snapshot.is_day_off(date(2028, 1, 3))


@pytest.mark.parametrize('kind', ['cron', 'every'])
async def test_last_known_run_waits_then_new_year_resumes_without_restart_or_catchup(env, monkeypatch, kind):
    e = env
    e.now = timestamp('2026-12-30T12:00:00+08:00')
    j = await save(e, kind)
    assert j['nextRunAt'] == '2026-12-31T01:00:00Z'
    assert j['config']['schedule']['endAt'] is None
    preview = e.cron.preview({'schedule': j['config']['schedule']})
    assert preview['times'] == [j['nextRunAt']] and preview['waitingYears'] == [2027]
    shown = await e.cron.calendar(123, params('2026-12-31T00:00:00+08:00', '2027-01-03T00:00:00+08:00', timezone='Asia/Shanghai'))
    assert [i['at'] for i in shown['items']] == [j['nextRunAt']]
    assert shown['holidayCalendar']['missingYears'] == [2027]
    launches = []
    e.cron.launch = launches.append
    e.now = timestamp(j['nextRunAt'])
    await e.cron.tick()
    assert len(launches) == 1  # Next year's missing data cannot roll back this run.
    waiting = (await e.cron.get(123, j['id']))['job']
    assert waiting['scheduleState'] == 'waiting_calendar' and waiting['nextRunAt'] is None

    records = {2026: BUNDLED_RECORDS[2026], 2027: {'year': 2027, 'papers': [], 'days': []}}
    source(monkeypatch, e.cron.holidays, records)
    status = await sync(e.cron)
    assert status['years'] == [2026] and status['unavailableYears'] == [2025, 2027]
    assert (await e.cron.get(123, j['id']))['job']['scheduleState'] == 'waiting_calendar'
    records[2027] = annual()
    e.now = timestamp('2027-01-04T10:00:00+08:00')
    status = await sync(e.cron)
    updated = (await e.cron.get(123, j['id']))['job']
    assert status['years'] == [2026, 2027] and not status['lastError']
    assert updated['scheduleState'] == 'armed' and updated['nextRunAt'] == '2027-01-05T01:00:00Z'
    assert updated['revision'] == j['revision']
    assert e.cron.preview({'schedule': j['config']['schedule']})['times'][0] == updated['nextRunAt']
    assert len(launches) == 1
    e.now = timestamp(updated['nextRunAt'])
    await e.cron.tick()
    assert len(launches) == 2
    assert len(await many(e.db.conn, 'SELECT * FROM cron_runs')) == 2


async def test_revised_notice_recomputes_durable_due_and_calendar(env, monkeypatch):
    e = env
    e.now = timestamp('2026-12-30T12:00:00+08:00')
    j = await save(e)
    records = {2026: copy.deepcopy(BUNDLED_RECORDS[2026])}
    records[2026]['days'].append({'date': '2026-12-31', 'name': '修订测试', 'isOffDay': True})
    source(monkeypatch, e.cron.holidays, records)
    await sync(e.cron)
    updated = (await e.cron.get(123, j['id']))['job']
    assert updated['nextRunAt'] is None and updated['scheduleState'] == 'waiting_calendar'
    shown = await e.cron.calendar(123, params('2026-12-31T00:00:00+08:00', '2027-01-01T00:00:00+08:00', timezone='Asia/Shanghai'))
    assert not shown['items'] and shown['annotations'][0]['isDayOff'] is True
    e.now = timestamp('2026-12-31T09:00:00+08:00')
    await e.cron.tick()
    assert not await many(e.db.conn, 'SELECT * FROM cron_runs')


async def test_first_sync_discovers_history_offline_and_empty_never_replace_cache(tmp_path, monkeypatch):
    clock = lambda: timestamp('2026-10-05T00:00:00Z')
    store = HolidayStore(tmp_path / 'calendar.json', clock)
    records = {2007: annual(2007), 2025: annual(2025), 2026: BUNDLED_RECORDS[2026], 2027: annual()}
    calls = source(monkeypatch, store, records)
    applied = []
    async def apply(snapshot): applied.append(snapshot)
    await store.refresh(apply)
    assert store.snapshot.years == {2007, 2025, 2026, 2027}
    before = store.status()
    assert before['lastSuccessAt'] and before['updatedAt'] and len(applied) == 1
    calls.clear()
    records[2027] = {'year': 2027, 'papers': [], 'days': []}
    records[2026] = aiohttp.ClientConnectionError('offline fixture')
    await store.refresh(apply)
    assert store.status()['versions'] == before['versions']
    assert '2007.json' not in ' '.join(calls)  # Backfill once; refresh adjacent years daily.
    assert store.status()['lastError'] and len(applied) == 1
    loaded = HolidayStore(store.path, clock)
    assert loaded.status()['versions'] == before['versions']
    assert loaded.status()['lastError']
    assert loaded.snapshot.is_day_off(date(2027, 1, 2)) is False
    isolated = HolidayStore(tmp_path / 'another.json', clock)
    assert isolated.snapshot.years == {2026}


async def test_disk_failure_keeps_active_snapshot(tmp_path, monkeypatch):
    store = HolidayStore(tmp_path / 'calendar.json', lambda: timestamp('2026-10-05T00:00:00Z'))
    source(monkeypatch, store, {2027: annual()})
    def fail(*args): raise OSError('disk fixture')
    monkeypatch.setattr(store, '_save', fail)
    async def apply(snapshot): pytest.fail('must not publish an unpersisted snapshot')
    await store.refresh(apply)
    assert store.snapshot.years == {2026} and 'disk fixture' in store.error


async def test_sync_http_authenticated_singleflight_and_waiting_save(env, monkeypatch):
    e = env
    for method, url in [('get', '/api/cron/holidays'), ('post', '/api/cron/holidays/sync')]:
        assert (await getattr(e.client, method)(url)).status == 401
    gate = asyncio.Event()
    calls = []
    async def refresh(apply):
        calls.append('refresh')
        await gate.wait()
        return e.cron.holidays.status()
    monkeypatch.setattr(e.cron.holidays, 'refresh', refresh)
    cookies = {'openbear_web_session': await _login_cookie(e)}
    response = await e.client.post('/api/cron/holidays/sync', cookies=cookies, json={})
    assert response.status == 200 and (await response.json())['holidayCalendar']['syncing']
    task = e.cron.holiday_refresh_task
    await e.client.post('/api/cron/holidays/sync', cookies=cookies, json={})
    assert e.cron.holiday_refresh_task is task and calls == ['refresh']
    schedule = {'kind': 'cron', 'expression': '0 9 * * *', 'startAt': '2027-01-01T00:00:00+08:00', 'skipHolidays': True}
    response = await e.client.post('/api/cron/jobs', cookies=cookies, json={'folderId': 'folder', 'name': 'Future', 'enabled': True,
        'requestId': 'http-future', 'config': {'instructions': 'Isolated only', 'schedule': schedule}})
    assert response.status == 200
    assert (await response.json())['job']['scheduleState'] == 'waiting_calendar'
    preview = await e.client.post('/api/cron/preview-next', cookies=cookies, json={'schedule': schedule})
    body = await preview.json()
    assert preview.status == 200 and body['times'] == [] and body['waitingYears'] == [2027]
    gate.set()
    await task
    assert not e.cron.holiday_status()['syncing']
    await e.cron.close()


async def test_real_json_transport_handles_404_empty_and_invalid_body(tmp_path):
    app = web.Application()
    app.router.add_get('/good', lambda r: web.json_response(annual()))
    app.router.add_get('/empty', lambda r: web.json_response({'year': 2027, 'papers': [], 'days': []}))
    app.router.add_get('/bad', lambda r: web.Response(text='<html>failed</html>'))
    async with TestServer(app) as server, aiohttp.ClientSession() as session:
        store = HolidayStore(tmp_path / 'calendar.json', lambda: 0)
        good = await store.fetch(session, str(server.make_url('/good')))
        assert validate_year(good, 2027)['year'] == 2027
        with pytest.raises(Unpublished): await store.fetch(session, str(server.make_url('/404')))
        with pytest.raises(Unpublished): validate_year(await store.fetch(session, str(server.make_url('/empty'))), 2027)
        with pytest.raises(ValueError): await store.fetch(session, str(server.make_url('/bad')))


async def test_startup_loads_cached_calendar_and_repairs_waiting_rows(env, monkeypatch):
    e = env
    j = await save(e, startAt='2027-01-01T00:00:00+08:00')
    source(monkeypatch, e.cron.holidays, {2027: annual()})
    await sync(e.cron)
    await e.db.conn.execute("UPDATE cron_jobs SET next_run_at_ms=NULL,schedule_state='waiting_calendar' WHERE job_id=?", (j['id'],))
    await e.db.conn.commit()
    await e.cron.close()
    new = CronService(e.db, e.server, clock=lambda: e.now)
    gate = asyncio.Event()
    async def offline_refresh(apply): await gate.wait()
    monkeypatch.setattr(new.holidays, 'refresh', offline_refresh)
    try:
        await new.start()  # Must not block on remote data.
        row = await one(e.db.conn, 'SELECT * FROM cron_jobs WHERE job_id=?', (j['id'],))
        assert row['schedule_state'] == 'armed' and row['next_run_at_ms'] == timestamp('2027-01-02T09:00:00+08:00')
        await asyncio.sleep(0)
    finally:
        await new.close()
    assert new.holiday_loop_task.done()
    assert new.holiday_refresh_task is None or new.holiday_refresh_task.done()
