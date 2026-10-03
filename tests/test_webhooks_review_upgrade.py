"""Upgrade the deployed v1 in place; preserve acceptance, raw bytes and billing."""
from __future__ import annotations

import sqlite3
from contextlib import asynccontextmanager

import pytest

from app.db.engine import DB
from app.webhooks import schema
from app.webhooks.repository import many, one


@asynccontextmanager
async def installed_v1(tmp_path, monkeypatch):
    db = DB(str(tmp_path / 'v1.sqlite'))
    with monkeypatch.context() as patch:
        patch.setattr(schema, 'MIGRATIONS', (schema.MIGRATIONS[0],))
        await db.connect()
    try:
        async with db.webhook_transaction() as conn:
            await conn.execute("""INSERT INTO webhook_endpoints
                (endpoint_id,owner_chat_id,binding_kind,binding_uuid,create_request_id,created_at_ms,updated_at_ms)
                VALUES('old-endpoint',123,'folder','old-folder','old-create',1000,1000)""")
            await conn.execute("""INSERT INTO webhook_revisions
                (endpoint_id,revision,target_mode,config_json,config_sha256,created_by,created_at_ms)
                VALUES('old-endpoint',1,'newConversation','{}','old-config','owner',1000)""")
            await conn.execute("""INSERT INTO webhook_events
                (event_id,endpoint_id,idempotency_key,identity_source,content_fingerprint,
                 received_revision,processing_revision,received_at_ms,acceptance_json,
                 route_state,review_required,terminal_at_ms)
                VALUES('old-event','old-endpoint','old-key','header','old-fingerprint',1,1,1000,
                    '{"eventId":"old-event","status":"accepted"}','terminal',1,2000)""")
            await conn.execute("""INSERT INTO webhook_event_payloads
                (event_id,content_type,body_bytes,query_pairs_json)
                VALUES('old-event','application/json',?,'[["a","1"],["a","2"]]')""",
                (' {"duplicate":1,"duplicate":2,"原文":true} '.encode(),))
            await conn.execute("""INSERT INTO webhook_receipts
                (receipt_id,event_id,result_version,source,request_key,request_sha256,
                 disposition,review_required,reported_at_ms)
                VALUES('old-receipt','old-event',1,'framework','old-receipt-key','old-hash','cancelled',1,2000)""")
            await conn.execute("""INSERT INTO model_calls
                (chat_id,model,created_at,input_tokens,output_tokens,cost_usd)
                VALUES(123,'old-model',1000,19,5,.7)""")
        yield db
    finally:
        await db.close()


async def snapshot(db):
    tables = await many(db.conn, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'webhook_%' ORDER BY name")
    return {row['name']: await many(db.conn, f'SELECT * FROM "{row["name"]}"') for row in tables}


async def test_review_v2_upgrade_preserves_v1_data_and_is_reentrant(tmp_path, monkeypatch):
    async with installed_v1(tmp_path, monkeypatch) as db:
        before = await snapshot(db)
        billing = await one(db.conn, 'SELECT * FROM model_calls')
        v1_marker = await one(db.conn, "SELECT * FROM schema_data_migrations WHERE name LIKE 'webhooks_v1:%'")
        await schema.migrate(db)
        for table, old_rows in before.items():
            new_rows = await many(db.conn, f'SELECT * FROM "{table}"')
            assert len(new_rows) == len(old_rows), table
            for old, new in zip(old_rows, new_rows):
                assert {k: new[k] for k in old} == old, table
        new_billing = await one(db.conn, 'SELECT * FROM model_calls')
        assert {k: new_billing[k] for k in billing} == billing
        assert await one(db.conn, "SELECT * FROM schema_data_migrations WHERE name LIKE 'webhooks_v1:%'") == v1_marker
        markers = await many(db.conn, "SELECT * FROM schema_data_migrations WHERE name LIKE 'webhooks_v%' ORDER BY name")
        assert len(markers) == len(schema.MIGRATIONS)
        after = await snapshot(db)
        await schema.migrate(db)
        assert await snapshot(db) == after
        assert await many(db.conn, "SELECT * FROM schema_data_migrations WHERE name LIKE 'webhooks_v%' ORDER BY name") == markers
        assert await many(db.conn, 'PRAGMA foreign_key_check') == []
        assert (await one(db.conn, 'PRAGMA integrity_check'))['integrity_check'] == 'ok'


async def test_simplification_upgrade_removes_only_budget_blocker(tmp_path, monkeypatch):
    import json
    async with installed_v1(tmp_path, monkeypatch) as db:
        async with db.webhook_transaction() as conn:
            await conn.execute("""UPDATE webhook_endpoints SET paused=1,pause_reason='owner pause',
                model_blockers_json='{"budget":{"reason":"old limit"},"manual":{"reason":"keep"}}',
                dispatch_blockers_json='{"manual":{"reason":"keep"}}',control_version=7""")
        before = await snapshot(db)
        await schema.migrate(db)
        endpoint = await one(db.conn, "SELECT * FROM webhook_endpoints WHERE endpoint_id='old-endpoint'")
        assert json.loads(endpoint['model_blockers_json']) == {'manual': {'reason': 'keep'}}
        assert endpoint['control_version'] == 8
        assert endpoint['paused'] == 1 and endpoint['pause_reason'] == 'owner pause'
        assert endpoint['dispatch_blockers_json'] == before['webhook_endpoints'][0]['dispatch_blockers_json']
        for table in ('webhook_revisions', 'webhook_events', 'webhook_event_payloads', 'webhook_receipts'):
            current = await many(db.conn, f'SELECT * FROM {table}')
            assert [{key: row[key] for key in old} for row, old in zip(current, before[table])] == before[table]
        await schema.migrate(db)
        assert await one(db.conn, "SELECT * FROM webhook_endpoints WHERE endpoint_id='old-endpoint'") == endpoint


def override_resource(monkeypatch, filename, transform):
    original = schema.files
    class Resources:
        def joinpath(self, name):
            class Resource:
                def read_text(self, **kwargs):
                    text = original('app.db').joinpath(name).read_text(**kwargs)
                    return transform(text) if name == filename else text
            return Resource()
    monkeypatch.setattr(schema, 'files', lambda package: Resources())


async def test_review_v2_failure_rolls_back_all_extensions_and_markers(tmp_path, monkeypatch):
    async with installed_v1(tmp_path, monkeypatch) as db:
        before = await many(db.conn, 'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
        data = await snapshot(db)
        markers = await many(db.conn, "SELECT * FROM schema_data_migrations WHERE name LIKE 'webhooks_v%' ORDER BY name")
        with monkeypatch.context() as patch:
            override_resource(patch, 'webhooks_runtime_v2.sql', lambda sql: sql + '\nCREATE TABLE webhook_failed_tail(id TEXT);\nINVALID MIGRATION;\n')
            with pytest.raises(sqlite3.OperationalError):
                await schema.migrate(db)
        assert await many(db.conn, 'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name') == before
        assert await snapshot(db) == data
        assert await many(db.conn, "SELECT * FROM schema_data_migrations WHERE name LIKE 'webhooks_v%' ORDER BY name") == markers
        await schema.migrate(db)
        assert not await one(db.conn, "SELECT name FROM sqlite_master WHERE name='webhook_failed_tail'")


@pytest.mark.parametrize('filename', [filename for _, filename in schema.MIGRATIONS])
async def test_review_installed_migration_signature_remains_enforced(tmp_path, monkeypatch, filename):
    db = DB(str(tmp_path / 'current.sqlite'))
    await db.connect()
    try:
        with monkeypatch.context() as patch:
            override_resource(patch, filename, lambda sql: sql + '\n-- unauthorized resource mutation\n')
            with pytest.raises(RuntimeError, match='signature mismatch'):
                await schema.migrate(db)
    finally:
        await db.close()


async def test_review_missing_extension_is_fatal_before_any_webhook_write(tmp_path, monkeypatch):
    async with installed_v1(tmp_path, monkeypatch) as db:
        markers = await many(db.conn, "SELECT * FROM schema_data_migrations WHERE name LIKE 'webhooks_v%' ORDER BY name")
        def missing(sql):
            raise FileNotFoundError('webhooks_runtime_v2.sql')
        with monkeypatch.context() as patch:
            override_resource(patch, 'webhooks_runtime_v2.sql', missing)
            with pytest.raises(FileNotFoundError):
                await schema.migrate(db)
        assert await many(db.conn, "SELECT * FROM schema_data_migrations WHERE name LIKE 'webhooks_v%' ORDER BY name") == markers
        assert len(await snapshot(db)) == 25
