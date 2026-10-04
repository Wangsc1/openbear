"""The same calendar calculator is used for preview and durable scheduling."""
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from croniter import croniter

from app.cron.contracts import Schedule, timestamp


def next_time(schedule: Schedule, after_ms: int) -> int | None:
    if schedule.kind == 'at':
        at = timestamp(schedule.at)
        return at if at > after_ms else None
    if schedule.kind == 'every':
        anchor = timestamp(schedule.anchor_at) if schedule.anchor_at else after_ms
        period = schedule.every_seconds * 1000
        return anchor + max(0, (after_ms - anchor) // period + 1) * period
    # Iterate local wall-clock minutes but validate candidates by a UTC round-trip.
    # Missing DST minutes are skipped. Ambiguous minutes run once, at fold=0.
    tz = ZoneInfo(schedule.timezone)
    local = datetime.fromtimestamp(after_ms / 1000, UTC).astimezone(tz)
    iterator = croniter(schedule.expression, local.replace(tzinfo=None), max_years_between_matches=8)
    for _ in range(180):
        candidate = iterator.get_next(datetime)
        aware = candidate.replace(tzinfo=tz, fold=0)
        if aware.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != candidate:
            continue
        result = int(aware.timestamp() * 1000)
        if result > after_ms:
            return result
    raise ValueError('无法计算下一次有效执行时间')


def preview(schedule, now, count=5):
    result = []
    for _ in range(min(20, max(1, int(count)))):
        value = next_time(schedule, now)
        if value is None:
            break
        result.append(datetime.fromtimestamp(value / 1000, UTC).isoformat().replace('+00:00', 'Z'))
        now = value
    return result
