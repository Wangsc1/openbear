"""One coroutine owner for controller turns and independent Agent executions.

Role policies do not keep a second runner registry or concurrency pool. A
controller view preserves chat-keyed operations; Agent controls use task keys.
Neither view changes the other role's routing, limits, or authorization.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from app.runtime.lifecycle import cancel_execution


@dataclass(frozen=True)
class ExecutionKey:
    kind: str
    identity: str


@dataclass
class ScheduledExecution:
    key: ExecutionKey
    task: asyncio.Task
    chat_id: int
    occupies_chat: bool


class ExecutionLease:
    """A shared-scheduler Agent slot, releasable during approval/wait states."""

    def __init__(self, scheduler: ExecutionScheduler, key: ExecutionKey) -> None:
        self.scheduler, self.key = scheduler, key
        self.held = False
        self.closed = False

    async def acquire(self) -> bool:
        scheduler = self.scheduler
        async with scheduler._slot_condition:
            if self.closed:
                raise RuntimeError("execution lease is closed")
            if self.held:
                return False
            await scheduler._slot_condition.wait_for(
                lambda: self.closed or scheduler._slots_in_use < scheduler.max_concurrent_agents
            )
            if self.closed:
                raise RuntimeError("execution lease is closed")
            if self.held:
                return False
            scheduler._slots_in_use += 1
            self.held = True
            return True

    async def release(self) -> bool:
        async with self.scheduler._slot_condition:
            if not self.held:
                return False
            self.held = False
            self.scheduler._slots_in_use -= 1
            self.scheduler._slot_condition.notify_all()
            return True

    async def close(self) -> None:
        async with self.scheduler._slot_condition:
            self.closed = True
            if self.held:
                self.held = False
                self.scheduler._slots_in_use -= 1
            self.scheduler._slot_condition.notify_all()


class ExecutionScheduler:
    def __init__(self, *, max_concurrent_agents: int = 3) -> None:
        self._executions: dict[ExecutionKey, ScheduledExecution] = {}
        self._retry_cancel: set[ExecutionKey] = set()
        self._retry_actions: dict[ExecutionKey, tuple[str, str]] = {}
        self.max_concurrent_agents = max(1, int(max_concurrent_agents or 1))
        self._slot_condition = asyncio.Condition()
        self._slots_in_use = 0
        self._leases: dict[ExecutionKey, ExecutionLease] = {}

    @staticmethod
    def key(kind: str, identity: str | int) -> ExecutionKey:
        return ExecutionKey(kind, str(identity))

    def register(self, key: ExecutionKey, task: asyncio.Task, *, chat_id: int = 0,
                 occupies_chat: bool = False, replace: bool = False) -> None:
        previous = self.task(key)
        if previous is not None and previous is not task and not replace:
            raise RuntimeError(f"execution already has an active runner: {key.kind}:{key.identity}")
        self._executions[key] = ScheduledExecution(key, task, int(chat_id or 0), occupies_chat)
        task.add_done_callback(lambda finished: self._clear(key, finished))

    def _clear(self, key: ExecutionKey, task: asyncio.Task) -> None:
        record = self._executions.get(key)
        if record is not None and record.task is task:
            self._executions.pop(key, None)
            self._retry_cancel.discard(key)
            self._retry_actions.pop(key, None)

    def task(self, key: ExecutionKey) -> asyncio.Task | None:
        record = self._executions.get(key)
        return record.task if record is not None and not record.task.done() else None

    def tasks(self, *, kind: str | None = None) -> list[asyncio.Task]:
        return [record.task for record in self._executions.values()
                if (kind is None or record.key.kind == kind) and not record.task.done()]

    def routed(self, chat_id: int, *, kind: str) -> list[str]:
        return [record.key.identity for record in self._executions.values()
                if record.key.kind == kind and record.chat_id == chat_id and record.occupies_chat]

    def unroute(self, key: ExecutionKey) -> None:
        record = self._executions.get(key)
        if record is not None:
            record.occupies_chat = False

    def cancel(self, key: ExecutionKey, *, reason: str = "user_stop") -> bool:
        task = self.task(key)
        return cancel_execution(task, reason) if task is not None else False

    async def cancel_and_wait(self, key: ExecutionKey, *, timeout_s: float = 10) -> bool:
        task = self.task(key)
        if task is None:
            return False
        cancel_execution(task, "user_stop")
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout_s)
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise
        except TimeoutError:
            return False
        except Exception:
            pass
        return True

    async def cancel_all_and_wait(self, *, kind: str | None = None,
                                  timeout_s: float | None = None) -> int:
        tasks = self.tasks(kind=kind)
        if not tasks:
            return 0
        for task in tasks:
            cancel_execution(task, "shutdown")
        done, _ = await asyncio.wait(tasks, timeout=None if timeout_s is None else max(0, timeout_s))
        for task in done:
            try:
                task.result()
            except (asyncio.CancelledError, Exception):
                pass
        return len(done)

    def request_retry_cancel(self, key: ExecutionKey) -> bool:
        if self.task(key) is None:
            return False
        self._retry_cancel.add(key)
        return True

    def consume_retry_cancel(self, key: ExecutionKey) -> bool:
        if key not in self._retry_cancel:
            return False
        self._retry_cancel.remove(key)
        return True

    def request_retry_action(self, key: ExecutionKey, wait_id: str, action: str) -> bool:
        if not wait_id or action not in {"retry", "cancel"} or self.task(key) is None:
            return False
        pending = self._retry_actions.get(key)
        if pending and pending[0] == wait_id:
            return False
        self._retry_actions[key] = (wait_id, action)
        return True

    def consume_retry_action(self, key: ExecutionKey, wait_id: str) -> str:
        pending = self._retry_actions.get(key)
        if pending is None or pending[0] != wait_id:
            return ""
        self._retry_actions.pop(key, None)
        return pending[1]

    def configure(self, *, max_concurrent_agents: int) -> None:
        limit = max(1, int(max_concurrent_agents or 1))
        if limit == self.max_concurrent_agents:
            return
        self.max_concurrent_agents = limit

        async def wake() -> None:
            async with self._slot_condition:
                self._slot_condition.notify_all()
        try:
            asyncio.get_running_loop().create_task(wake())
        except RuntimeError:
            pass

    @property
    def slots_in_use(self) -> int:
        return self._slots_in_use

    def lease(self, key: ExecutionKey) -> ExecutionLease | None:
        return self._leases.get(key)

    @asynccontextmanager
    async def execution_slot(self, key: ExecutionKey) -> AsyncIterator[ExecutionLease]:
        if key in self._leases:
            raise RuntimeError(f"execution already owns a lease: {key.identity}")
        lease = ExecutionLease(self, key)
        self._leases[key] = lease
        try:
            await lease.acquire()
            yield lease
        finally:
            if self._leases.get(key) is lease:
                self._leases.pop(key, None)
            await lease.close()


class ControllerRuns:
    """Chat-keyed policy view; all runner state lives in ExecutionScheduler."""

    def __init__(self, scheduler: ExecutionScheduler | None = None) -> None:
        self.scheduler = scheduler if scheduler is not None else ExecutionScheduler()

    def register(self, chat_id: int, task: asyncio.Task) -> None:
        self.scheduler.register(self.scheduler.key("controller", chat_id), task,
                                chat_id=chat_id, occupies_chat=True, replace=True)

    def task(self, chat_id: int) -> asyncio.Task | None:
        return self.scheduler.task(self.scheduler.key("controller", chat_id))

    def is_running(self, chat_id: int) -> bool:
        return self.task(chat_id) is not None

    def cancel(self, chat_id: int) -> bool:
        return self.scheduler.cancel(self.scheduler.key("controller", chat_id))

    async def cancel_and_wait(self, chat_id: int, *, timeout_s: float = 10) -> bool:
        return await self.scheduler.cancel_and_wait(self.scheduler.key("controller", chat_id), timeout_s=timeout_s)

    async def cancel_all_and_wait(self, *, timeout_s: float | None = None) -> int:
        return await self.scheduler.cancel_all_and_wait(kind="controller", timeout_s=timeout_s)

    def count(self) -> int:
        return len(self.scheduler.tasks(kind="controller"))
