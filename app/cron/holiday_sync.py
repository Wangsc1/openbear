"""Lifecycle-owned holiday-cn JSON sync with an atomic, last-known-good cache."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import aiohttp

from app.cron.holidays import BUNDLED_RECORDS, DEFAULT_CALENDAR, CalendarSnapshot
from app.webhooks.contracts import iso

SOURCE = 'https://github.com/NateScarlet/holiday-cn'
RAW = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master'
INDEX = 'https://api.github.com/repos/NateScarlet/holiday-cn/contents/'
log = logging.getLogger(__name__)


class Unpublished(ValueError):
    pass


def validate_year(value, year):
    if not isinstance(value, dict) or type(value.get('year')) is not int or value['year'] != year:
        raise ValueError('年度字段不匹配')
    papers, days = value.get('papers'), value.get('days')
    if papers == [] and days == []:
        raise Unpublished(f'{year} 年公告尚未发布')
    if not isinstance(papers, list) or not papers or not isinstance(days, list) or not days:
        raise ValueError('缺少公告来源或年度安排')
    for paper in papers:
        if not isinstance(paper, str):
            raise ValueError('无效公告来源')
        url = urlparse(paper)
        if url.scheme not in ('http', 'https') or not (url.hostname == 'gov.cn' or (url.hostname or '').endswith('.gov.cn')):
            raise ValueError('公告来源不是政府网站')
    result, seen, off_months = [], set(), set()
    for item in days:
        if not isinstance(item, dict) or type(item.get('isOffDay')) is not bool or not isinstance(item.get('name'), str) or not item['name'].strip():
            raise ValueError('无效放假/补班字段')
        value = item.get('date')
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            raise ValueError('无效安排日期')
        day = datetime.strptime(value, '%Y-%m-%d').date()
        if not (f'{year-1}-12-01' <= value <= f'{year+1}-01-31') or value in seen:
            raise ValueError('日期越界或放假/补班重复冲突')
        seen.add(value)
        if day.year == year and item['isOffDay']:
            off_months.add(day.month)
        result.append({'date': value, 'name': item['name'], 'isOffDay': item['isOffDay']})
    # Reject truncated/partial tables, not just an HTTP-success empty placeholder.
    # These three annual holidays also exist in the source's earliest (2007) year.
    if not {1, 5, 10} <= off_months:
        raise ValueError('年度数据不完整（缺少元旦、劳动节或国庆期间安排）')
    return {'year': year, 'papers': papers, 'days': sorted(result, key=lambda d: d['date'])}


def version(record):
    return hashlib.sha256(json.dumps(record, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class HolidayStore:
    def __init__(self, path, clock):
        self.path, self.clock = Path(path), clock
        self.records = dict(BUNDLED_RECORDS)
        self.snapshot = DEFAULT_CALENDAR
        self.last_checked = self.last_success = self.updated_at = None
        self.error, self.unavailable = '', []
        self.synced_years = set()
        self._load()

    def _load(self):
        if not self.path.exists():
            return
        try:
            saved = json.loads(self.path.read_text(encoding='utf-8'))
            records = {int(y): validate_year(r, int(y)) for y, r in saved['records'].items()}
            self.records.update(records)
            self.synced_years = set(saved.get('syncedYears', [])) & records.keys()
            self.last_checked = saved.get('lastCheckedAt')
            self.last_success = saved.get('lastSuccessAt')
            self.updated_at = saved.get('updatedAt')
            self.error = saved.get('lastError', '')
            self.unavailable = saved.get('unavailableYears', [])
            self.snapshot = CalendarSnapshot(self.records, SOURCE)
        except (OSError, ValueError, TypeError, KeyError) as exc:
            self.error = f'日历缓存读取失败，使用内置底本：{exc}'
            log.warning('%s', self.error)

    def status(self):
        return {**self.snapshot.coverage(), 'provider': 'holiday-cn（社区整理国务院公告）',
                'sourceUrl': SOURCE, 'lastCheckedAt': self.last_checked,
                'lastSuccessAt': self.last_success, 'updatedAt': self.updated_at,
                'lastError': self.error, 'unavailableYears': self.unavailable,
                'versions': {str(y): version(r) for y, r in self.records.items()},
                'papers': {str(y): r['papers'] for y, r in self.records.items()}}

    async def fetch(self, session, url):
        async with session.get(url) as response:
            if response.status == 404:
                raise Unpublished('年度文件尚未发布')
            response.raise_for_status()
            content = bytearray()
            async for chunk in response.content.iter_chunked(65536):
                content.extend(chunk)
                if len(content) > 1_000_000:
                    raise ValueError('日历响应过大')
            return json.loads(content)

    def _save(self, records, synced, checked, updated, errors, unavailable):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.tmp')
        try:
            with temp.open('w', encoding='utf-8') as handle:
                json.dump({'records': records, 'syncedYears': sorted(synced), 'lastCheckedAt': checked,
                           'lastSuccessAt': self.last_success if errors else checked, 'updatedAt': updated,
                           'lastError': '；'.join(errors), 'unavailableYears': sorted(unavailable)}, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, self.path)
        finally:
            temp.unlink(missing_ok=True)

    async def refresh(self, apply):
        checked = iso(self.clock())
        self.last_checked = checked
        year = datetime.fromtimestamp(self.clock() / 1000, ZoneInfo('Asia/Shanghai')).year
        wanted = {year - 1, year, year + 1}
        records, synced = dict(self.records), set(self.synced_years)
        errors, unavailable = [], []
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25),
                                        headers={'User-Agent': 'OpenBear-holiday-calendar'}) as session:
            try:
                listing = await self.fetch(session, INDEX)
                if not isinstance(listing, list):
                    raise ValueError('年度目录格式错误')
                available = {int(v['name'][:4]) for v in listing if isinstance(v, dict)
                             and re.fullmatch(r'\d{4}\.json', str(v.get('name', '')))}
                wanted |= {y for y in available if 1900 <= y <= year + 1 and y not in synced}
            except (aiohttp.ClientError, TimeoutError, ValueError) as exc:
                errors.append(f'年度目录：{exc}')
            semaphore = asyncio.Semaphore(4)
            async def download(y):
                async with semaphore:
                    try:
                        record = validate_year(await self.fetch(session, f'{RAW}/{y}.json'), y)
                        records[y] = record
                        synced.add(y)
                    except Unpublished:
                        unavailable.append(y)
                        if y in self.records:
                            errors.append(f'{y}：上游为空或未找到，保留已有数据')
                    except (aiohttp.ClientError, TimeoutError, ValueError) as exc:
                        errors.append(f'{y}：{exc}')
            await asyncio.gather(*(download(y) for y in sorted(wanted)))
        changed = records != self.records
        updated = checked if changed else self.updated_at
        try:
            # Persist before publishing; a failed disk write cannot expose a
            # volatile schedule which would disappear at restart.
            self._save(records, synced, checked, updated, errors, unavailable)
            if changed:
                snapshot = CalendarSnapshot(records, SOURCE)
                await apply(snapshot)
                self.snapshot = snapshot
            self.records, self.synced_years = records, synced
            if synced:
                self.snapshot = CalendarSnapshot(records, SOURCE)
            self.updated_at = updated
            if not errors:
                self.last_success = checked
        except (OSError, ValueError) as exc:
            errors.append(f'更新未应用：{exc}')
        self.error, self.unavailable = '；'.join(errors), sorted(unavailable)
        return self.status()
