"""Offline calendar tests; expected dates transcribed from 国办发明电〔2025〕7号."""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import tomllib
import zipfile
from datetime import date, timedelta
from pathlib import Path

import pytest

from app.cron.holidays import coverage, holiday_info, is_day_off

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html"
# Independent expectations, not computed from the shipped JSON.
HOLIDAYS = [
    ("元旦", "2026-01-01", "2026-01-03"),
    ("春节", "2026-02-15", "2026-02-23"),
    ("清明节", "2026-04-04", "2026-04-06"),
    ("劳动节", "2026-05-01", "2026-05-05"),
    ("端午节", "2026-06-19", "2026-06-21"),
    ("中秋节", "2026-09-25", "2026-09-27"),
    ("国庆节", "2026-10-01", "2026-10-07"),
]
WORKDAYS = {
    "2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09",
    "2026-09-20", "2026-10-10",
}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("calendar tests must not access the network")

    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)


def test_coverage_and_reproducible_source():
    assert coverage() == {
        "country": "CN",
        "years": [2026],
        "source": (
            "中国政府网《国务院办公厅关于2026年部分节假日安排的通知》"
            f"（国办发明电〔2025〕7号，2025-11-04） {SOURCE_URL}"
        ),
    }
    data = json.loads((ROOT / "app/cron/holidays_cn.json").read_text(encoding="utf-8"))
    assert data["source"]["url"] == SOURCE_URL
    assert data["source"]["documentNumber"] == "国办发明电〔2025〕7号"
    assert data["source"]["publishedOn"] == "2025-11-04"
    assert data["source"]["retrievedOn"] == "2026-10-05"
    assert list(data["years"]) == ["2026"]
    entries = data["years"]["2026"]
    assert [(e["label"], e["start"], e["end"]) for e in entries] == HOLIDAYS
    assert {d for e in entries for d in e["workdays"]} == WORKDAYS
    assert sum(len(e["workdays"]) for e in entries) == 6


def test_every_day_of_2026_matches_published_notice():
    expected_holidays = {}
    for label, start, end in HOLIDAYS:
        start_day, end_day = date.fromisoformat(start), date.fromisoformat(end)
        for offset in range((end_day - start_day).days + 1):
            expected_holidays[(start_day + timedelta(days=offset)).isoformat()] = label
    assert len(expected_holidays) == 33
    assert not expected_holidays.keys() & WORKDAYS
    for offset in range(365):
        day = date(2026, 1, 1) + timedelta(days=offset)
        iso = day.isoformat()
        expected = iso not in WORKDAYS and (iso in expected_holidays or day.weekday() >= 5)
        info = holiday_info(day)
        assert set(info) == {"date", "known", "isDayOff", "tags"}
        assert info["date"] == iso
        assert info["known"] is True
        assert info["isDayOff"] is expected, iso
        assert is_day_off(day) is expected, iso
        if iso in WORKDAYS:
            primary = [{"label": "调休班", "kind": "workday"}]
        elif iso in expected_holidays:
            primary = [{"label": expected_holidays[iso], "kind": "holiday"}]
        elif day.weekday() >= 5:
            primary = [{"label": "周末", "kind": "weekend"}]
        else:
            primary = []
        assert [t for t in info["tags"] if t["kind"] != "special"] == primary, iso
        assert all(t["kind"] in {"holiday", "workday", "weekend", "special"} for t in info["tags"])


@pytest.mark.parametrize(("iso", "off", "tags"), [
    ("2026-10-05", True, [{"label": "国庆节", "kind": "holiday"}]),
    ("2026-10-07", True, [{"label": "国庆节", "kind": "holiday"}]),
    ("2026-10-08", False, []),
    ("2026-09-20", False, [{"label": "调休班", "kind": "workday"}]),
    ("2026-10-10", False, [{"label": "调休班", "kind": "workday"}]),
    ("2026-10-11", True, [{"label": "周末", "kind": "weekend"}]),
    ("2026-10-17", True, [{"label": "周末", "kind": "weekend"}]),
])
def test_national_day_makeup_and_ordinary_weekends(iso, off, tags):
    assert holiday_info(date.fromisoformat(iso)) == {
        "date": iso, "known": True, "isDayOff": off, "tags": tags,
    }


@pytest.mark.parametrize("iso", [
    "2024-02-29", "2025-12-31", "2027-01-01", "2027-01-02", "2030-10-01",
])
def test_unknown_years_fail_closed_even_on_weekends(iso):
    day = date.fromisoformat(iso)
    info = holiday_info(day)
    assert info["known"] is False
    assert info["isDayOff"] is None
    assert not any(t["kind"] in {"holiday", "workday"} for t in info["tags"])
    with pytest.raises(ValueError, match=f"缺少 {day.year} 年中国大陆放假调休数据，无法判断休息日"):
        is_day_off(day)


def test_year_boundary_does_not_reuse_previous_notice():
    assert is_day_off(date(2026, 12, 31)) is False
    assert holiday_info(date(2027, 1, 1))["known"] is False
    with pytest.raises(ValueError, match="2027 年"):
        is_day_off(date(2027, 1, 1))


@pytest.mark.parametrize(("year", "day_number"), [(2024, 29), (2026, 27), (2029, 23), (2030, 29)])
def test_black_friday_is_after_fourth_thursday_not_fourth_friday(year, day_number):
    tagged = [
        day_number for day_number in range(1, 31)
        if {"label": "黑五", "kind": "special"} in holiday_info(date(year, 11, day_number))["tags"]
    ]
    assert tagged == [day_number]
    thanksgiving = date(year, 11, day_number) - timedelta(days=1)
    assert thanksgiving.weekday() == 3
    assert 22 <= thanksgiving.day <= 28


@pytest.mark.parametrize(("iso", "label"), [("2026-11-27", "黑五"), ("2026-12-25", "圣诞节")])
def test_special_tags_do_not_make_weekdays_days_off(iso, label):
    day = date.fromisoformat(iso)
    assert holiday_info(day) == {
        "date": iso, "known": True, "isDayOff": False,
        "tags": [{"label": label, "kind": "special"}],
    }
    assert is_day_off(day) is False


def test_unknown_year_special_and_weekend_tags_still_work():
    assert holiday_info(date(2027, 12, 25)) == {
        "date": "2027-12-25", "known": False, "isDayOff": None,
        "tags": [{"label": "周末", "kind": "weekend"}, {"label": "圣诞节", "kind": "special"}],
    }
    assert holiday_info(date(2024, 11, 29)) == {
        "date": "2024-11-29", "known": False, "isDayOff": None,
        "tags": [{"label": "黑五", "kind": "special"}],
    }
    for day_number in (24, 26):
        assert {"label": "圣诞节", "kind": "special"} not in holiday_info(date(2026, 12, day_number))["tags"]


def test_public_results_cannot_mutate_calendar():
    coverage()["years"].append(2027)
    holiday_info(date(2026, 10, 5))["tags"][0]["label"] = "changed"
    assert coverage()["years"] == [2026]
    assert holiday_info(date(2026, 10, 5))["tags"] == [{"label": "国庆节", "kind": "holiday"}]


def test_package_data_and_offline_zip_resource_loading(tmp_path):
    """Load only shipped files, with no source checkout, site packages or network."""
    config = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    patterns = config["tool"]["setuptools"]["package-data"]["app.cron"]
    package_files = {"app/__init__.py", "app/cron/__init__.py", "app/cron/holidays.py"}
    for pattern in patterns:
        package_files.update(p.relative_to(ROOT).as_posix() for p in (ROOT / "app/cron").glob(pattern))
    assert "app/cron/holidays_cn.json" in package_files
    archive = tmp_path / "packaged-calendar.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        for name in sorted(package_files):
            bundle.write(ROOT / name, name)
    script = """
import socket, sys
from datetime import date

def forbidden(*args, **kwargs):
    raise AssertionError('network forbidden, including during calendar import')
socket.socket.connect = forbidden
socket.create_connection = forbidden
socket.getaddrinfo = forbidden
sys.path.insert(0, sys.argv[1])
from app.cron import holidays
assert holidays.__file__.startswith(sys.argv[1])
assert holidays.coverage()['years'] == [2026]
assert holidays.is_day_off(date(2026, 10, 5)) is True
assert holidays.is_day_off(date(2026, 10, 10)) is False
assert holidays.holiday_info(date(2027, 1, 1))['isDayOff'] is None
"""
    result = subprocess.run(
        [sys.executable, "-I", "-S", "-c", script, str(archive)],
        cwd=tmp_path, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
