"""Transaction-aware SQLite read/write routing.

All application writes share one physical writer connection and one task-owned
transaction lock.  Reads use a query-only connection unless the current task
already owns the writer transaction.  This avoids WAL writer collisions and the
SQLITE_BUSY_SNAPSHOT failure caused by upgrading a shared read connection after
another connection committed.
"""
from __future__ import annotations

import asyncio
import contextlib
import re
import sqlite3
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any, TypeVar

import aiosqlite

from app.logging import get_logger

log = get_logger("db.router")

_T = TypeVar("_T")
_FIRST_TOKEN_RE = re.compile(r"^\s*([A-Za-z]+)")
_CTE_WRITE_RE = re.compile(r"\b(?:INSERT|UPDATE|DELETE|REPLACE)\b", re.IGNORECASE)
_READ_TOKENS = {"SELECT", "EXPLAIN"}
_TRANSACTION_TOKENS = {"BEGIN", "SAVEPOINT", "RELEASE", "COMMIT", "END", "ROLLBACK"}


def _strip_leading_comments(sql: str) -> str:
    value = str(sql or "")
    while True:
        stripped = value.lstrip()
        if stripped.startswith("--"):
            _, sep, tail = stripped.partition("\n")
            value = tail if sep else ""
            continue
        if stripped.startswith("/*"):
            end = stripped.find("*/", 2)
            value = stripped[end + 2 :] if end >= 0 else ""
            continue
        return stripped


def _statement_token(sql: str) -> str:
    match = _FIRST_TOKEN_RE.match(_strip_leading_comments(sql))
    return str(match.group(1) if match else "").upper()


def _is_read_statement(sql: str) -> bool:
    cleaned = _strip_leading_comments(sql)
    token = _statement_token(cleaned)
    if token in _READ_TOKENS:
        return True
    if token == "WITH":
        return _CTE_WRITE_RE.search(cleaned) is None
    return False


def _is_locked_error(exc: BaseException) -> bool:
    if not isinstance(exc, sqlite3.OperationalError):
        return False
    code = getattr(exc, "sqlite_errorcode", None)
    if code in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
        return True
    text = str(exc).lower()
    return "database is locked" in text or "database table is locked" in text


class SQLiteConnectionRouter:
    """Duck-typed subset of ``aiosqlite.Connection`` used by OpenBear.

    A normal write owns ``_writer_lock`` from its first mutating statement until
    commit/rollback.  Multi-statement DAO methods therefore become atomic without
    changing each call site, and unrelated tasks cannot commit one another's work.
    """

    def __init__(
        self,
        *,
        reader: aiosqlite.Connection,
        writer: aiosqlite.Connection,
        lock_retries: int = 2,
    ) -> None:
        self._reader = reader
        self._writer = writer
        self._writer_lock = asyncio.Lock()
        self._owner: asyncio.Task[Any] | None = None
        self._owner_callback: Callable[[asyncio.Task[Any]], None] | None = None
        self._lock_retries = max(0, int(lock_retries))
        self._closed = False
        self._transaction_depth = 0
        # Notifications only wake consumers; callbacks must not perform database
        # work or delay the owning transaction. No uncommitted data is broadcast.
        self.commit_listeners: set[Callable[[], None]] = set()

    def _notify_commit(self) -> None:
        for callback in tuple(self.commit_listeners):
            with contextlib.suppress(Exception):
                callback()

    @property
    def in_transaction(self) -> bool:
        return bool(self._writer.in_transaction)

    @property
    def total_changes(self) -> int:
        return int(self._writer.total_changes)

    def _current_task(self) -> asyncio.Task[Any]:
        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("SQLite writer operation requires an asyncio task")
        return task

    async def _acquire_writer(self) -> tuple[asyncio.Task[Any], bool]:
        task = self._current_task()
        if self._owner is task:
            return task, False
        await self._writer_lock.acquire()
        if self._closed:
            self._writer_lock.release()
            raise RuntimeError("数据库已关闭")
        self._owner = task
        loop = asyncio.get_running_loop()

        def _owner_done(done_task: asyncio.Task[Any]) -> None:
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(
                    lambda: asyncio.create_task(
                        self._recover_abandoned_owner(done_task),
                        name="sqlite-writer-owner-recovery",
                    )
                )

        self._owner_callback = _owner_done
        task.add_done_callback(_owner_done)
        return task, True

    def _release_writer(self, task: asyncio.Task[Any]) -> None:
        if self._owner is not task:
            return
        if self._owner_callback is not None:
            task.remove_done_callback(self._owner_callback)
            self._owner_callback = None
        self._owner = None
        if self._writer_lock.locked():
            self._writer_lock.release()

    async def _recover_abandoned_owner(self, task: asyncio.Task[Any]) -> None:
        if self._owner is not task:
            return
        try:
            await self._drain_cleanup(self._writer.rollback())
            log.warning("已回滚未正常结束的 SQLite 写事务", 任务=task.get_name())
        except BaseException as exc:  # pragma: no cover - catastrophic connection failure
            log.error("SQLite 写事务自动回滚失败", 错误=f"{type(exc).__name__}: {exc}")
        finally:
            self._release_writer(task)

    async def _drain_cleanup(self, operation: Awaitable[_T]) -> _T:
        """Keep ownership until SQLite has processed cleanup, even on repeated stop.

        Cancelling an aiosqlite await does not remove its queued SQL. A rollback
        must be queued unconditionally behind it, not gated on in_transaction.
        """
        cleanup = asyncio.ensure_future(operation)
        cancelled = False
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
        result = cleanup.result()
        if cancelled:
            raise asyncio.CancelledError()
        return result

    async def _retry_locked(self, operation: Callable[[], Awaitable[_T]], *, label: str) -> _T:
        for attempt in range(self._lock_retries + 1):
            try:
                return await operation()
            except BaseException as exc:
                if not _is_locked_error(exc) or attempt >= self._lock_retries:
                    raise
                delay = 0.05 * (2**attempt)
                log.warning(
                    "SQLite 外部写锁冲突，准备重试",
                    操作=label,
                    次数=attempt + 1,
                    等待秒=delay,
                )
                await asyncio.sleep(delay)
        raise AssertionError("unreachable")

    async def _execute_read(self, sql: str, parameters: Any) -> aiosqlite.Cursor:
        # SQLite keeps executing queued SQL after its caller is cancelled. Keep
        # the result alive until we can close the otherwise unclaimed cursor;
        # an unfinished SELECT would pin the shared reader to an old WAL snapshot.
        pending = asyncio.ensure_future(self._reader.execute(sql, parameters))
        try:
            return await asyncio.shield(pending)
        except asyncio.CancelledError:
            async def close_unclaimed_cursor() -> None:
                cursor = await pending
                await cursor.close()

            # Repeated cancellation must not abandon cursor cleanup either.
            # A query failure during cancellation must not replace cancellation.
            with contextlib.suppress(Exception):
                await self._drain_cleanup(close_unclaimed_cursor())
            raise

    async def execute(self, sql: str, parameters: Any = None) -> aiosqlite.Cursor:
        params = () if parameters is None else parameters
        task = asyncio.current_task()
        if task is not None and self._owner is task:
            try:
                return await self._retry_locked(
                    lambda: self._writer.execute(sql, params),
                    label=_statement_token(sql) or "execute",
                )
            except BaseException:
                if not self._transaction_depth:
                    with contextlib.suppress(BaseException):
                        await self._drain_cleanup(self._writer.rollback())
                    self._release_writer(task)
                raise
        if _is_read_statement(sql):
            return await self._execute_read(sql, params)

        owner, acquired = await self._acquire_writer()
        try:
            cursor = await self._retry_locked(
                lambda: self._writer.execute(sql, params),
                label=_statement_token(sql) or "execute",
            )
            # PRAGMA and transaction-ending statements may leave no active
            # transaction.  Do not retain the writer lock in that case.
            if not self._writer.in_transaction:
                self._release_writer(owner)
                self._notify_commit()
            return cursor
        except BaseException:
            if acquired or self._owner is owner:
                with contextlib.suppress(BaseException):
                    await self._drain_cleanup(self._writer.rollback())
                self._release_writer(owner)
            raise

    async def executemany(self, sql: str, parameters: Any) -> aiosqlite.Cursor:
        task = asyncio.current_task()
        if task is not None and self._owner is task:
            try:
                return await self._retry_locked(
                    lambda: self._writer.executemany(sql, parameters),
                    label=f"executemany:{_statement_token(sql) or 'SQL'}",
                )
            except BaseException:
                if not self._transaction_depth:
                    with contextlib.suppress(BaseException):
                        await self._drain_cleanup(self._writer.rollback())
                    self._release_writer(task)
                raise
        if _is_read_statement(sql):
            return await self._reader.executemany(sql, parameters)
        owner, _ = await self._acquire_writer()
        try:
            cursor = await self._retry_locked(
                lambda: self._writer.executemany(sql, parameters),
                label=f"executemany:{_statement_token(sql) or 'SQL'}",
            )
            if not self._writer.in_transaction:
                self._release_writer(owner)
                self._notify_commit()
            return cursor
        except BaseException:
            with contextlib.suppress(BaseException):
                await self._drain_cleanup(self._writer.rollback())
            self._release_writer(owner)
            raise

    async def executescript(self, sql_script: str) -> aiosqlite.Cursor:
        owner, _ = await self._acquire_writer()
        try:
            cursor = await self._retry_locked(
                lambda: self._writer.executescript(sql_script),
                label="executescript",
            )
            if not self._writer.in_transaction:
                self._release_writer(owner)
                self._notify_commit()
            return cursor
        except BaseException:
            with contextlib.suppress(BaseException):
                await self._drain_cleanup(self._writer.rollback())
            self._release_writer(owner)
            raise

    async def commit(self) -> None:
        # DAO-level commits join an explicit transaction owned by this task.
        # Only its outer context manager can commit/notify; other tasks still wait.
        if self._owner is asyncio.current_task() and self._transaction_depth:
            return
        owner, _ = await self._acquire_writer()
        try:
            await self._retry_locked(self._writer.commit, label="commit")
            self._notify_commit()
        except BaseException:
            with contextlib.suppress(BaseException):
                await self._drain_cleanup(self._writer.rollback())
            raise
        finally:
            self._release_writer(owner)

    async def rollback(self) -> None:
        owner, _ = await self._acquire_writer()
        try:
            await self._drain_cleanup(self._writer.rollback())
        finally:
            self._release_writer(owner)

    async def backup(self, target: sqlite3.Connection, **kwargs: Any) -> None:
        owner, _ = await self._acquire_writer()
        try:
            if self._writer.in_transaction:
                await self._writer.commit()
                self._notify_commit()
            await self._writer.backup(target, **kwargs)
        finally:
            self._release_writer(owner)

    @asynccontextmanager
    async def transaction(self, *, label: str = "transaction") -> AsyncIterator[aiosqlite.Connection]:
        owner, acquired = await self._acquire_writer()
        nested = bool(self._writer.in_transaction)
        savepoint = f"openbear_{uuid.uuid4().hex}"
        try:
            if nested:
                await self._writer.execute(f"SAVEPOINT {savepoint}")
            else:
                await self._retry_locked(
                    lambda: self._writer.execute("BEGIN IMMEDIATE"),
                    label=f"{label}:begin",
                )
            self._transaction_depth += 1
            try:
                yield self._writer
            finally:
                self._transaction_depth -= 1
            if nested:
                await self._writer.execute(f"RELEASE {savepoint}")
            else:
                await self._retry_locked(self._writer.commit, label=f"{label}:commit")
                self._notify_commit()
        except BaseException:
            with contextlib.suppress(BaseException):
                if nested:
                    await self._drain_cleanup(self._writer.execute(f"ROLLBACK TO {savepoint}"))
                    await self._drain_cleanup(self._writer.execute(f"RELEASE {savepoint}"))
                else:
                    await self._drain_cleanup(self._writer.rollback())
            raise
        finally:
            if acquired:
                self._release_writer(owner)

    async def close(self) -> None:
        if self._closed:
            return
        owner, _ = await self._acquire_writer()
        try:
            self._closed = True
            with contextlib.suppress(BaseException):
                if self._writer.in_transaction:
                    await self._writer.rollback()
            await self._reader.close()
            await self._writer.close()
        finally:
            self._release_writer(owner)
