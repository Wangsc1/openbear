"""Cron wire contracts: no inbound event, batching or queue configuration."""
from __future__ import annotations

from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from pydantic import Field, model_validator

from app.webhooks.contracts import Model, TargetRunConfig


class CronError(Exception):
    def __init__(self, code, message='', status=422, **details):
        super().__init__(message or code)
        self.status = status
        self.payload = {'code': code, 'message': message or code, **details}


def timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('时间必须包含时区')
    return int(dt.timestamp() * 1000)


class Schedule(Model):
    kind: Literal['at', 'every', 'cron'] = 'cron'
    timezone: str = 'Asia/Shanghai'
    at: str | None = None
    every_seconds: int | None = Field(None, ge=1, strict=True)
    anchor_at: str | None = None
    expression: str | None = '0 9 * * *'

    @model_validator(mode='after')
    def valid(self):
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError('无效IANA时区') from None
        if self.kind == 'at':
            if not self.at:
                raise ValueError('一次性任务必须设置执行时间')
            timestamp(self.at)
        if self.kind == 'every':
            if self.every_seconds is None:
                raise ValueError('间隔必须是正整数秒')
            if self.anchor_at:
                timestamp(self.anchor_at)
        if self.kind == 'cron':
            if not self.expression or len(self.expression.split()) != 5 or not croniter.is_valid(self.expression):
                raise ValueError('Cron必须是合法的五段表达式')
        return self


class Retry(Model):
    max_attempts: int = Field(1, ge=1, le=5, strict=True)
    backoff_seconds: list[float] = Field(default_factory=lambda: [2, 10, 30, 60])

    @model_validator(mode='after')
    def valid(self):
        if any(v < 0 or v > 3600 for v in self.backoff_seconds):
            raise ValueError('重试间隔必须在0–3600秒之间')
        return self


Outcome = Literal['completed', 'failed', 'timed_out', 'tokens_exceeded', 'cost_exceeded', 'cancelled']


class Script(Model):
    enabled: bool = Field(False, strict=True)
    runtime: Literal['python', 'node'] = 'python'
    code: str = ''
    timeout_seconds: float = Field(30, gt=0, le=3600)
    retry: Retry = Field(default_factory=Retry)
    on_error: Literal['fail', 'continue'] = 'fail'

    @model_validator(mode='after')
    def valid(self):
        if self.enabled and not self.code.strip():
            raise ValueError('启用脚本必须提供代码')
        return self


class PostScript(Script):
    on_outcomes: list[Outcome] = Field(default_factory=lambda: [
        'completed', 'failed', 'timed_out', 'tokens_exceeded', 'cost_exceeded', 'cancelled'])


class Notifications(Model):
    mode: Literal['inherit', 'silent', 'telegram', 'push', 'both'] = 'inherit'
    errors_only: bool = Field(False, strict=True)


class JobConfig(Model):
    schedule: Schedule = Field(default_factory=Schedule)
    run_config: TargetRunConfig = Field(default_factory=TargetRunConfig)
    instructions: str = ''
    timeout_seconds: float | None = Field(None, gt=0)
    total_tokens_budget: int | None = Field(None, gt=0, strict=True)
    cost_budget_usd: float | None = Field(None, gt=0)
    notifications: Notifications = Field(default_factory=Notifications)
    pre: Script = Field(default_factory=Script)
    post: PostScript = Field(default_factory=PostScript)
