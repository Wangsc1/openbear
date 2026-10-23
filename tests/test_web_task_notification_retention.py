"""The event-frame maintenance companion must not retain an unbounded DELETE."""
from contextlib import asynccontextmanager

from app.web_console.operation_store import WebAdminOperationsMixin
from tests.test_web_event_frame_retention import _FRESH, _OLD
from tests.test_web_event_frame_retention import retention_env as retention_env

_INSERT = """
    INSERT INTO web_task_notifications
      (notification_uuid, notification_key, conversation_uuid, internal_chat_id,
       payload_json, state, created_at, updated_at)
    VALUES (?,?, 'a', 1, '{}', ?, 1, ?)
"""


async def test_notification_history_preserves_states_and_advances_over_protected_prefix(retention_env):
    owner = retention_env
    records = [(str(i), str(i), ("pending", "processing", "paused")[i % 3], _OLD) for i in range(8200)]
    records += [(str(i), str(i), "delivered" if i % 2 else "suppressed", _OLD) for i in range(8200, 8400)]
    records += [(str(i), str(i), "delivered" if i % 2 else "suppressed", _FRESH) for i in range(8400, 8600)]
    async with owner.db.write_transaction() as conn:
        await conn.executemany(_INSERT, records)
    prune = WebAdminOperationsMixin._prune_web_task_notification_history
    assert await prune(owner) == 0
    assert 0 < owner._maintenance_cursors["web_task_notifications"]["after"] <= 4096
    deleted = 0
    for _ in range(20):
        deleted += await prune(owner)
        if not owner._maintenance_cursors:
            break
    assert not owner._maintenance_cursors
    assert deleted == 200
    cur = await owner.db.conn.execute("SELECT notification_uuid FROM web_task_notifications ORDER BY id")
    try:
        remaining = [row[0] for row in await cur.fetchall()]
    finally:
        await cur.close()
    assert remaining == [str(i) for i in (*range(8200), *range(8400, 8600))]


async def test_notification_history_rechecks_changed_delivery_state_before_delete(retention_env):
    owner = retention_env
    async with owner.db.write_transaction() as conn:
        await conn.execute(_INSERT, ("n", "n", "delivered", _OLD))
    transaction = owner.db.write_transaction
    @asynccontextmanager
    async def change_state(**kwargs):
        async with transaction(**kwargs) as conn:
            if kwargs.get("label") == "retention:web_task_notifications":
                await conn.execute("UPDATE web_task_notifications SET state='pending'")
            yield conn
    owner.db.write_transaction = change_state
    assert await WebAdminOperationsMixin._prune_web_task_notification_history(owner) == 0
    cur = await owner.db.conn.execute("SELECT state FROM web_task_notifications")
    assert (await cur.fetchone())[0] == "pending"
    await cur.close()
