"""Managed-only owner migration. Runtime chat IDs are never owner identities."""
from __future__ import annotations

from app.managed.settings import LOCAL_OWNER_ID


async def migrate_local_owner(db):
    # Runs before any listener/background worker under the managed volume lock.
    # One transaction means a conflict fails startup, never silently overwrites
    # an existing owner's settings or partially reassigns history.
    async with db.write_transaction(label="managed-local-owner-migration") as conn:
        marker = "managed:local-owner-v2"
        cursor = await conn.execute("SELECT value FROM app_state WHERE key=?", (marker,))
        if await cursor.fetchone():
            return
        cursor = await conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        for row in await cursor.fetchall():
            table = '"' + row[0].replace('"', '""') + '"'
            info = await conn.execute(f"PRAGMA table_info({table})")
            columns = {item[1] for item in await info.fetchall()}
            if "owner_chat_id" in columns:
                await conn.execute(f"UPDATE {table} SET owner_chat_id=? WHERE owner_chat_id=-1", (LOCAL_OWNER_ID,))
        # This table's chat_id is explicitly a login principal, unlike sessions,
        # messages, model/tool calls, agent tasks and internal_chat_id columns.
        await conn.execute("UPDATE web_sessions SET chat_id=? WHERE chat_id=-1", (LOCAL_OWNER_ID,))
        # Only known owner-keyed preferences; never rewrite arbitrary JSON or
        # controller:-1/context keys, which refer to the first business chat.
        prefixes = ("folder_prompt_policy:",)
        for prefix in prefixes:
            old, new = prefix + "-1", prefix + str(LOCAL_OWNER_ID)
            cursor = await conn.execute("SELECT key FROM app_state WHERE key=? OR key LIKE ?", (old, old + ":%"))
            for row in await cursor.fetchall():
                await conn.execute("UPDATE app_state SET key=? WHERE key=?", (new + row[0][len(old):], row[0]))
        await conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES(?,?,0)", (marker, str(LOCAL_OWNER_ID)))
