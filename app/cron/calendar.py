"""Read-only calendar: execution facts and current-rule projections stay separate."""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.cron.contracts import CronError, JobConfig, timestamp
from app.cron.holidays import coverage, holiday_info, is_day_off
from app.cron.schedule import next_time
from app.webhooks.contracts import iso
from app.webhooks.repository import many

# Allow 45 displayed days across a DST offset change, but not unbounded queries.
MAX_RANGE_MS = (45 * 24 + 2) * 3_600_000
MAX_CRON_STEPS = 100_000  # Across the entire request, not per job or per day.
SINGLE_LIMIT = 8


def _bound(value):
    if not isinstance(value, str) or not value:
        raise ValueError('start/end 必须是含时区的 ISO 时间')
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('start/end 必须包含时区')
    delta = dt.astimezone(UTC) - datetime(1970, 1, 1, tzinfo=UTC)
    # SQLite occurrences have millisecond precision. Ceil both half-open bounds.
    us = (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds
    return -(-us // 1000)


def _parameters(params):
    try:
        start, end = _bound(params.get('start')), _bound(params.get('end'))
        if not 0 < end - start <= MAX_RANGE_MS:
            raise ValueError('范围必须左闭右开且不超过45天（含2小时夏令时余量）')
    except (ValueError, TypeError, OverflowError) as exc:
        raise CronError('invalid_calendar_range', str(exc)) from None
    try:
        timezone = params.get('timezone')
        if not isinstance(timezone, str) or not timezone:
            raise ValueError('timezone 必须是 IANA 时区')
        tz = ZoneInfo(timezone)
    except (ValueError, ZoneInfoNotFoundError):
        raise CronError('invalid_timezone', 'timezone 必须是有效 IANA 时区') from None
    if params.get('enabled') not in (None, '') and str(params['enabled']).lower() not in ('true', 'false'):
        raise CronError('invalid_enabled')
    return start, end, tz


def _filters(params, *, history=False):
    # Definition filters have the same meaning as /jobs, including name/description
    # search. A retained run without any definition can still match its snapshot name.
    where, args = [], []
    if params.get('folderId'):
        where.append(('r.folder_id' if history else 'j.folder_id') + '=?')
        args.append(params['folderId'])
    if params.get('enabled') not in (None, ''):
        where.append('j.enabled=?')
        args.append(int(str(params['enabled']).lower() == 'true'))
    if params.get('search'):
        name = 'COALESCE(j.name,r.job_name)' if history else 'j.name'
        where.append(f"(instr(lower({name}),lower(?)) OR instr(lower(j.description),lower(?)))")
        args.extend([params['search']] * 2)
    return ''.join(' AND ' + w for w in where), args


def _date(ms, tz):
    return datetime.fromtimestamp(ms / 1000, UTC).astimezone(tz).date().isoformat()


def _days(start, end, tz):
    day = datetime.fromtimestamp(start / 1000, UTC).astimezone(tz).date()
    last = datetime.fromtimestamp((end - 1) / 1000, UTC).astimezone(tz).date()
    while day <= last:
        following = day + timedelta(days=1)
        lo = max(start, int(datetime.combine(day, time(), tz).timestamp() * 1000))
        hi = min(end, int(datetime.combine(following, time(), tz).timestamp() * 1000))
        if lo < hi:  # A timezone may skip an entire civil date.
            yield day.isoformat(), lo, hi
        day = following


class _Group:
    """Keep at most eight details, regardless of the number of real occurrences."""

    def __init__(self):
        self.details = []
        self.summary = None

    def add(self, item):
        if self.summary is None:
            self.summary = {**item, 'count': 0, 'statusCounts': {}}
        summary = self.summary
        summary['count'] += item['count']
        summary['lastAt'] = item['lastAt']
        if summary['trigger'] != item['trigger']:
            summary['trigger'] = 'mixed'
        for status, count in item['statusCounts'].items():
            summary['statusCounts'][status] = summary['statusCounts'].get(status, 0) + count
        if summary['count'] <= SINGLE_LIMIT:
            self.details.append(item)
        else:
            self.details.clear()

    def items(self):
        if self.summary is None:
            return []
        if self.summary['count'] <= SINGLE_LIMIT:
            return self.details
        summary = self.summary
        return [{**summary,
                 'id': f"aggregate:{summary['jobId']}:{summary['date']}:{int(summary['projected'])}",
                 'status': next(iter(summary['statusCounts'])) if len(summary['statusCounts']) == 1 else 'mixed',
                 'runId': '', 'conversationId': ''}]


def _item(row, day, at, status, *, projected, paths, last=None, count=1):
    return dict(id=f"projection:{row['job_id']}:{at}" if projected else 'run:' + row['run_id'],
                jobId=row['job_id'], name=row['name'] if projected else row['job_name'],
                folderId=row['folder_id'], folderPath=paths.get(row['folder_id'], ''), date=day,
                at=iso(at), lastAt=iso(at if last is None else last), status=status,
                projected=projected, count=count, runId='' if projected else row['run_id'],
                conversationId='' if projected else row['conversation_uuid'],
                trigger='scheduled' if projected else row['trigger_kind'], statusCounts={status: count})


def _every_day(first, period, lo, hi, excluded):
    """Return exact (first, last, count) without enumerating seconds, even for gaps."""
    first += max(0, -(-(lo - first) // period)) * period
    if first >= hi:
        return None
    last = first + ((hi - 1 - first) // period) * period
    blocked = {at for at in excluded if first <= at <= last and (at - first) % period == 0}
    count = (last - first) // period + 1 - len(blocked)
    if not count:
        return None
    while first in blocked:
        first += period
    while last in blocked:
        last -= period
    if count > SINGLE_LIMIT:
        return [(first, last, count)]
    # Walking gaps is proportional to existing runs, never the interval's seconds.
    result, cursor = [], first
    for stop in sorted(blocked) + [last + period]:
        if stop < cursor:
            continue
        while cursor < stop and cursor <= last:
            result.append((cursor, cursor, 1))
            cursor += period
        cursor = stop + period
    return result


class _ProjectionLimit(Exception):
    pass


class _CronBudget:
    def __init__(self):
        self.remaining = MAX_CRON_STEPS

    async def next(self, schedule, after):
        if self.remaining <= 0:
            raise _ProjectionLimit
        self.remaining -= 1
        if self.remaining % 256 == 0:
            await asyncio.sleep(0)
        return next_time(schedule, after)


async def calendar(service, owner, params):
    start, end, tz = _parameters(params)
    now, conn = service.clock(), service.db.conn
    folders = await service.host._tree_folders(owner)
    paths = {fid: service.host._tree_folder_path_text(fid, folders) for fid in folders}
    clause, args = _filters(params)
    rows = await many(conn, '''SELECT j.* FROM cron_jobs j
        WHERE j.owner_chat_id=? AND j.deleted_at_ms IS NULL''' + clause +
        ' ORDER BY j.created_at_ms DESC,j.job_id', [owner, *args])
    jobs = [await service.public(conn, row, folders=folders) for row in rows]
    groups, occupied = defaultdict(_Group), defaultdict(set)
    clause, args = _filters(params, history=True)
    cursor = await conn.execute('''SELECT r.* FROM cron_runs r
        LEFT JOIN cron_jobs j ON j.job_id=r.job_id AND j.owner_chat_id=r.owner_chat_id
        WHERE r.owner_chat_id=? AND r.scheduled_at_ms>=? AND r.scheduled_at_ms<?''' + clause +
        ' ORDER BY r.scheduled_at_ms,r.run_id', [owner, start, end, *args])
    try:
        while batch := await cursor.fetchmany(512):
            for record in batch:
                row = dict(record)
                at = row['scheduled_at_ms']
                day = _date(at, tz)
                groups[row['job_id'], day, False].add(
                    _item(row, day, at, row['status'], projected=False, paths=paths))
                # Manual runs are independent occurrences, even at an identical time.
                if row['trigger_kind'] == 'scheduled' and at >= now:
                    occupied[row['job_id'], day].add(at)
    finally:
        await cursor.close()

    warnings, budget = [], _CronBudget()
    for row in rows:
        lower = max(start, now, row['created_at_ms'])
        if lower >= end:
            continue
        day = _date(lower, tz)
        try:
            schedule = JobConfig.model_validate_json(row['config_json']).schedule
            if schedule.kind == 'at' and row['schedule_state'] in ('exhausted', 'missed'):
                continue
            status = 'target_missing' if row['folder_id'] not in folders else 'disabled' if not row['enabled'] else 'waiting'
            if schedule.kind in ('at', 'every'):
                first = next_time(schedule, lower - 1)
                if first is None or first >= end:
                    continue
                if schedule.kind == 'at':
                    day = _date(first, tz)
                    if first not in occupied[row['job_id'], day]:
                        groups[row['job_id'], day, True].add(
                            _item(row, day, first, status, projected=True, paths=paths))
                    continue
                period = schedule.every_seconds * 1000
                upper = min(end, timestamp(schedule.end_at)) if schedule.end_at else end
                # Decide rest days in the rule timezone, then group in the display timezone.
                for rule_day, rule_lo, rule_hi in _days(max(lower, first), upper, ZoneInfo(schedule.timezone)):
                    if schedule.skip_holidays and is_day_off(date.fromisoformat(rule_day)):
                        continue
                    for day, lo, hi in _days(rule_lo, rule_hi, tz):
                        spans = _every_day(first, period, lo, hi, occupied[row['job_id'], day])
                        for at, last, count in spans or ():
                            groups[row['job_id'], day, True].add(
                                _item(row, day, at, status, projected=True, paths=paths, last=last, count=count))
                continue
            for day, lo, hi in _days(lower, end, tz):
                # Publish only complete civil-day groups: an interrupted count must
                # never masquerade as an exact aggregate. Earlier days remain valid.
                pending, after = _Group(), lo - 1
                while True:
                    at = await budget.next(schedule, after)
                    if at is None or at >= hi:
                        break
                    after = at
                    if at not in occupied[row['job_id'], day]:
                        pending.add(_item(row, day, at, status, projected=True, paths=paths))
                groups[row['job_id'], day, True] = pending
        except _ProjectionLimit:
            warnings.append(f"任务 {row['job_id']}：cron 计算达到请求上限；显示日期 {day} 及之后的未来投影已省略，历史不受影响，请缩小范围或筛选任务。")
        except (ValueError, OverflowError) as exc:
            warnings.append(f"任务 {row['job_id']}：无法计算显示日期 {day} 及之后的未来投影（{exc}），历史不受影响。")

    items = [item for group in groups.values() for item in group.items()]
    items.sort(key=lambda item: (_bound(item['at']), item['id']))
    return dict(items=items, jobs=jobs, now=iso(now), totalJobs=len(jobs), warnings=warnings,
                annotations=[holiday_info(date.fromisoformat(day)) for day, _, _ in _days(start, end, tz)],
                holidayCalendar=coverage())
