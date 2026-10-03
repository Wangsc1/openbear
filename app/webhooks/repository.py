"""SQL helpers; every mutation is owned by DB.webhook_transaction()."""
from __future__ import annotations

import uuid


def uid():
    return str(uuid.uuid4())


async def one(conn, sql, args=()):
    cursor = await conn.execute(sql, args)
    try:
        row = await cursor.fetchone()
        return dict(row) if row is not None else None
    finally:
        await cursor.close()


async def many(conn, sql, args=()):
    cursor = await conn.execute(sql, args)
    try:
        return [dict(row) for row in await cursor.fetchall()]
    finally:
        await cursor.close()


async def insert(conn, table, **values):
    # Table/column identifiers are exclusively source-code constants, never API values.
    return await conn.execute(f"INSERT INTO {table} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))
