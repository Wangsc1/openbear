"""Versioned, atomic schema installation. Never uses executescript's implicit commit."""
from __future__ import annotations

import hashlib
import sqlite3
import time
from importlib.resources import files


# Applied resources are immutable. Keep v1 unchanged for already installed DBs;
# fixes extend it through separately signed, ordered migrations.
MIGRATIONS = (
    ('webhooks_v1', 'webhooks.sql'),
    ('webhooks_v2_data', 'webhooks_data_v2.sql'),
    ('webhooks_v2_runtime', 'webhooks_runtime_v2.sql'),
    ('webhooks_v3_simplification', 'webhooks_simplification_v3.sql'),
    ('webhooks_v4_credentials', 'webhooks_credentials_v4.sql'),
    ('webhooks_v5_presentation', 'webhooks_presentation_v5.sql'),
)


async def _apply_sql(conn, sql):
    statement = ''
    for line in sql.splitlines(keepends=True):
        statement += line
        if sqlite3.complete_statement(statement):
            await conn.execute(statement)
            statement = ''
    # A final line comment (or a deliberately empty migration) is not SQL.
    if any(line.strip() and not line.lstrip().startswith('--') for line in statement.splitlines()):
        raise RuntimeError('Incomplete Webhook schema resource')


async def migrate(db):
    # Resolve every resource before writes: an incomplete package must never
    # leave the database partially upgraded.
    resources = []
    for version, filename in MIGRATIONS:
        sql = files('app.db').joinpath(filename).read_text(encoding='utf-8')
        resources.append((version, version + ':' + hashlib.sha256(sql.encode()).hexdigest(), sql))
    async with db.webhook_transaction() as conn:
        cursor = await conn.execute("SELECT name FROM schema_data_migrations WHERE name LIKE 'webhooks_v%'")
        markers = [row[0] for row in await cursor.fetchall()]
        expected = {name for _, name, _ in resources}
        if len(markers) != len(set(markers)) or any(name not in expected for name in markers):
            raise RuntimeError('Webhook schema signature mismatch; explicit migration required')
        installed = set(markers)
        # The ledger is a prefix of the migration sequence, not a collection
        # of unrelated switches. A missing predecessor indicates corruption.
        missing_seen = False
        for _, name, _ in resources:
            if name not in installed:
                missing_seen = True
            elif missing_seen:
                raise RuntimeError('Partial Webhook migration ledger; refusing repair')
        if not installed:
            cursor = await conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'webhook_%'")
            if await cursor.fetchone():
                raise RuntimeError('Partial/unversioned Webhook schema; refusing destructive repair')
        for _, name, sql in resources:
            if name in installed:
                continue
            await _apply_sql(conn, sql)
            await conn.execute('INSERT INTO schema_data_migrations(name,applied_at) VALUES (?,?)', (name, int(time.time())))
