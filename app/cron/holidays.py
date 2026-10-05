"""Offline mainland-China days off and display-only date labels.

The bundled data transcribes the State Council's published annual notice; its
URL, document number, publication date and retrieval date are in holidays_cn.json.
Only explicitly covered years permit scheduling decisions. Callers supply a date
in their intended timezone; this module does not convert timestamps or use a clock.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from importlib.resources import files


def _load_calendar() -> tuple[dict, dict[date, str], set[date]]:
    data = json.loads(files(__package__).joinpath("holidays_cn.json").read_text(encoding="utf-8"))
    holidays: dict[date, str] = {}
    workdays: set[date] = set()
    for entries in data["years"].values():
        for entry in entries:
            start, end = date.fromisoformat(entry["start"]), date.fromisoformat(entry["end"])
            for offset in range((end - start).days + 1):
                holidays[start + timedelta(days=offset)] = entry["label"]
            workdays.update(date.fromisoformat(value) for value in entry["workdays"])
    return data, holidays, workdays


_DATA, _HOLIDAYS, _WORKDAYS = _load_calendar()
_YEARS = frozenset(int(year) for year in _DATA["years"])


def coverage() -> dict:
    """Return the bundled (not predicted) calendar's country, years and source."""
    source = _DATA["source"]
    return {
        "country": "CN",
        "years": sorted(_YEARS),
        "source": (
            f'{source["publisher"]}《{source["title"]}》'
            f'（{source["documentNumber"]}，{source["publishedOn"]}） {source["url"]}'
        ),
    }


def holiday_info(day: date) -> dict:
    """Return date, known, isDayOff and independent display tags.

    Official makeup workdays override weekends. Only ordinary weekends get a
    weekend tag (holiday/workday tags take precedence). In uncovered years a
    weekend tag is still a calendar fact, but isDayOff remains None. Black Friday
    and Christmas are display-only and never affect the scheduling decision.
    """
    known = day.year in _YEARS
    tags = []
    if day in _WORKDAYS:
        day_off = False
        tags.append({"label": "调休班", "kind": "workday"})
    elif day in _HOLIDAYS:
        day_off = True
        tags.append({"label": _HOLIDAYS[day], "kind": "holiday"})
    else:
        day_off = day.weekday() >= 5
        if day_off:
            tags.append({"label": "周末", "kind": "weekend"})

    if day.month == 11:
        first = date(day.year, 11, 1)
        # US Thanksgiving is the fourth Thursday; its following Friday can be
        # November's FIFTH Friday (e.g. 2024-11-29), not always the fourth.
        black_friday = first + timedelta(days=(3 - first.weekday()) % 7 + 21 + 1)
        if day == black_friday:
            tags.append({"label": "黑五", "kind": "special"})
    if (day.month, day.day) == (12, 25):
        tags.append({"label": "圣诞节", "kind": "special"})

    return {
        "date": day.isoformat(),
        "known": known,
        "isDayOff": day_off if known else None,
        "tags": tags,
    }


def is_day_off(day: date) -> bool:
    """Return a confirmed day-off decision, or refuse an uncovered year."""
    result = holiday_info(day)["isDayOff"]
    if result is None:
        raise ValueError(f"缺少 {day.year} 年中国大陆放假调休数据，无法判断休息日")
    return result
