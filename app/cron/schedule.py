"""The same calendar calculator is used for preview and durable scheduling."""
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from croniter import croniter

from app.cron.contracts import Schedule, timestamp
from app.cron.holidays import coverage, is_day_off


def validate_calendar_coverage(schedule: Schedule, now_ms: int):
    if not schedule.skip_holidays:
        return
    tz = ZoneInfo(schedule.timezone)
    start = timestamp(schedule.at or schedule.start_at or schedule.anchor_at) if (schedule.at or schedule.start_at or schedule.anchor_at) else now_ms
    end = timestamp(schedule.at) if schedule.kind == 'at' else timestamp(schedule.end_at) - 1
    first = datetime.fromtimestamp(start / 1000, tz).year
    last = datetime.fromtimestamp(end / 1000, tz).year
    missing = sorted(set(range(first, last + 1)) - set(coverage()['years']))
    if missing:
        raise ValueError(f"缺少 {'、'.join(map(str, missing))} 年中国大陆放假调休数据，无法启用跳过休息日")


def next_time(schedule: Schedule, after_ms: int) -> int | None:
    tz = ZoneInfo(schedule.timezone)
    if schedule.kind == 'at':
        at = timestamp(schedule.at)
        if at <= after_ms or schedule.skip_holidays and is_day_off(datetime.fromtimestamp(at / 1000, tz).date()):
            return None
        return at
    if schedule.start_at:
        after_ms = max(after_ms, timestamp(schedule.start_at) - 1)
    end_ms = timestamp(schedule.end_at) if schedule.end_at else None
    # Preserve the interval anchor while jumping over whole rest days.
    anchor = timestamp(schedule.anchor_at) if schedule.anchor_at else after_ms
    while end_ms is None or after_ms < end_ms - 1:
        if schedule.kind == 'every':
            period = schedule.every_seconds * 1000
            result = anchor + max(0, (after_ms - anchor) // period + 1) * period
        else:
            # Iterate local wall-clock time and UTC-roundtrip to skip missing DST
            # times. Ambiguous times run once, at fold=0. Seconds are explicit.
            local = datetime.fromtimestamp(after_ms / 1000, UTC).astimezone(tz)
            iterator = croniter(f'{schedule.expression} {schedule.second}', local.replace(tzinfo=None), max_years_between_matches=8)
            for _ in range(180):
                candidate = iterator.get_next(datetime)
                aware = candidate.replace(tzinfo=tz, fold=0)
                if aware.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != candidate:
                    continue
                result = int(aware.timestamp() * 1000)
                if result > after_ms:
                    break
            else:
                raise ValueError('无法计算下一次有效执行时间')
        if end_ms is not None and result >= end_ms:
            return None
        day = datetime.fromtimestamp(result / 1000, tz).date()
        if not schedule.skip_holidays or not is_day_off(day):
            return result
        after_ms = int(datetime.combine(day + timedelta(days=1), time(), tz).timestamp() * 1000) - 1
    return None


def preview(schedule, now, count=5):
    validate_calendar_coverage(schedule, now)
    result = []
    for _ in range(min(20, max(1, int(count)))):
        value = next_time(schedule, now)
        if value is None:
            break
        result.append(datetime.fromtimestamp(value / 1000, UTC).isoformat().replace('+00:00', 'Z'))
        now = value
    return result
