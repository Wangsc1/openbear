"""Small, resumable retention slices for auxiliary Web history tables."""
from __future__ import annotations

import asyncio
import sqlite3
import time

_TABLES = {
    "user_interactions", "web_task_notifications", "web_tg_notification_outbox",
    "web_tg_notification_runs", "web_push_deliveries", "web_push_runs",
}


async def prune_rows(owner, table: str, predicate: str, parameters: tuple, *,
                     batch_size: int = 128, max_scan_rows: int = 4096,
                     time_budget_s: float = 1.0) -> int:
    """The predicate is trusted application SQL; eligibility is rechecked at deletion."""
    if table not in _TABLES:
        raise ValueError("unsupported retention table")
    batch_size = max(1, min(128, int(batch_size)))
    max_scan_rows = max(1, int(max_scan_rows))
    cursors = getattr(owner, "_maintenance_cursors", None)
    if cursors is None:
        cursors = owner._maintenance_cursors = {}
    lock = getattr(owner, "_maintenance_lock", None)
    if lock is None:
        lock = owner._maintenance_lock = asyncio.Lock()
    if lock.locked():
        return 0
    async with lock:
        state = cursors.setdefault(table, {"after": 0, "high": None})
        deleted = scanned = 0
        deadline = time.monotonic() + max(0.01, float(time_budget_s))
        try:
            while scanned < max_scan_rows and time.monotonic() < deadline:
                async with asyncio.timeout(0.2):
                    if state["high"] is None:
                        async with await owner.db.conn.execute(f"SELECT MAX(rowid) FROM {table}") as cur:
                            state["high"] = int((await cur.fetchone())[0] or 0)
                    async with await owner.db.conn.execute(
                        f"SELECT rowid FROM {table} WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?",
                        (state["after"], state["high"], min(batch_size, max_scan_rows - scanned)),
                    ) as cur:
                        rows = await cur.fetchall()
                    if not rows:
                        cursors.pop(table, None)
                        break
                    ids = [int(row[0]) for row in rows]
                    async with owner.db.write_transaction(
                        label=f"retention:{table}", wait_timeout_s=0.01, sqlite_busy_timeout_ms=25,
                    ) as conn:
                        cur = await conn.execute(
                            f"DELETE FROM {table} WHERE rowid IN ({','.join('?' for _ in ids)}) AND ({predicate})",
                            (*ids, *parameters),
                        )
                        count = max(0, cur.rowcount)
                        await cur.close()
                deleted += count
                scanned += len(ids)
                state["after"] = ids[-1]
                if state["after"] >= state["high"]:
                    cursors.pop(table, None)
                    break
                await asyncio.sleep(0.001)
        except TimeoutError:
            pass
        except sqlite3.OperationalError as exc:
            if getattr(exc, "sqlite_errorcode", 0) & 255 not in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
                raise
        return deleted
