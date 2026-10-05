"""Offline calendar snapshots; runtime updates replace a whole snapshot at once."""
from __future__ import annotations

import json
from datetime import date, timedelta
from importlib.resources import files


class MissingCalendar(ValueError):
    def __init__(self, year: int):
        self.year = year
        super().__init__(f"缺少 {year} 年中国大陆放假调休数据，无法判断休息日")


class CalendarSnapshot:
    def __init__(self, records: dict[int, dict], source: str):
        self.years = frozenset(records)
        self.source = source
        self._days = {}
        # A following year's notice can also arrange the previous December.
        # Later annual notices take precedence over the earlier annual table.
        for year in sorted(records):
            for item in records[year]["days"]:
                self._days[date.fromisoformat(item["date"])] = (item["name"], item["isOffDay"])

    def coverage(self) -> dict:
        return {"country": "CN", "years": sorted(self.years), "source": self.source}

    def holiday_info(self, day: date) -> dict:
        known = day.year in self.years or day in self._days
        tags = []
        entry = self._days.get(day)
        if entry is not None:
            name, day_off = entry
            tags.append({"label": name if day_off else "调休班", "kind": "holiday" if day_off else "workday"})
        else:
            day_off = day.weekday() >= 5
            if day_off:
                tags.append({"label": "周末", "kind": "weekend"})
        if day.month == 11:
            first = date(day.year, 11, 1)
            black_friday = first + timedelta(days=(3 - first.weekday()) % 7 + 21 + 1)
            if day == black_friday:
                tags.append({"label": "黑五", "kind": "special"})
        if (day.month, day.day) == (12, 25):
            tags.append({"label": "圣诞节", "kind": "special"})
        return {"date": day.isoformat(), "known": known, "isDayOff": day_off if known else None, "tags": tags}

    def is_day_off(self, day: date) -> bool:
        result = self.holiday_info(day)["isDayOff"]
        if result is None:
            raise MissingCalendar(day.year)
        return result


def _bundled():
    data = json.loads(files(__package__).joinpath("holidays_cn.json").read_text(encoding="utf-8"))
    records = {}
    for year, entries in data["years"].items():
        days = []
        for entry in entries:
            start, end = date.fromisoformat(entry["start"]), date.fromisoformat(entry["end"])
            days.extend({"date": (start + timedelta(days=n)).isoformat(), "name": entry["label"], "isOffDay": True}
                        for n in range((end - start).days + 1))
            days.extend({"date": value, "name": entry["label"], "isOffDay": False} for value in entry["workdays"])
        records[int(year)] = {"year": int(year), "papers": [data["source"]["url"]], "days": days}
    source = data["source"]
    label = (f'{source["publisher"]}《{source["title"]}》'
             f'（{source["documentNumber"]}，{source["publishedOn"]}） {source["url"]}')
    return records, label


BUNDLED_RECORDS, _SOURCE = _bundled()
DEFAULT_CALENDAR = CalendarSnapshot(BUNDLED_RECORDS, _SOURCE)


# Pure callers and packaged/offline use retain the bundled baseline. Each live
# CronService supplies its own snapshot rather than mutating these module globals.
def coverage():
    return DEFAULT_CALENDAR.coverage()


def holiday_info(day: date):
    return DEFAULT_CALENDAR.holiday_info(day)


def is_day_off(day: date):
    return DEFAULT_CALENDAR.is_day_off(day)
