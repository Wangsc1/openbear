"""Real legacy-schema copy upgrade and atomic Webhook DDL failure isolation."""
import sqlite3
import subprocess
from pathlib import Path

import pytest
from app.db.engine import DB
from app.webhooks.schema import migrate
from app.webhooks.repository import one,many


async def test_upgrade_actual_legacy_schema_without_rewriting_billing(tmp_path):
    root=Path(__file__).resolve().parents[1]
    legacy=subprocess.run(['git','show','HEAD:app/db/schema.sql'],cwd=root,text=True,capture_output=True,check=True).stdout
    path=tmp_path/'legacy.sqlite'
    with sqlite3.connect(path) as c:
        c.executescript(legacy)
        c.execute("INSERT INTO model_calls(chat_id,model,created_at,input_tokens,cost_usd) VALUES(123,'legacy',123456,19,.7)")
        c.execute("CREATE TRIGGER preserve_legacy_calls BEFORE UPDATE ON model_calls BEGIN SELECT RAISE(ABORT,'do not rewrite legacy calls'); END")
        old=dict(zip([d[0] for d in c.execute('SELECT * FROM model_calls').description],c.execute('SELECT * FROM model_calls').fetchone()))
    db=DB(str(path)); await db.connect()
    try:
        row=await one(db.conn,'SELECT * FROM model_calls')
        assert {k:row[k] for k in old}==old and row['attempt_id']=='' and row['usage_known'] is None
        marker=await one(db.conn,"SELECT name FROM schema_data_migrations WHERE name LIKE 'webhooks_v1:%'"); assert marker
        tables=await many(db.conn,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'webhook_%' ORDER BY name")
        await migrate(db)
        assert await many(db.conn,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'webhook_%' ORDER BY name")==tables
        assert (await one(db.conn,'PRAGMA integrity_check'))['integrity_check']=='ok'
    finally: await db.close()
    db=DB(str(path)); await db.connect()
    try:
        assert (await one(db.conn,"SELECT name FROM schema_data_migrations WHERE name LIKE 'webhooks_v1:%'"))==marker
        assert (await one(db.conn,'SELECT input_tokens FROM model_calls'))['input_tokens']==19
    finally: await db.close()


async def test_schema_failure_is_atomic_and_missing_resource_is_fatal(tmp_path,monkeypatch):
    import app.webhooks.schema as schema
    original=schema.files
    class Resource:
        def joinpath(self,name): return self
        def read_text(self,**kwargs): return 'CREATE TABLE webhook_half (id TEXT);\nTHIS IS INVALID SQL;\n'
    monkeypatch.setattr(schema,'files',lambda *args:Resource())
    path=tmp_path/'failed.sqlite'; db=DB(str(path))
    with pytest.raises(sqlite3.OperationalError): await db.connect()
    with sqlite3.connect(path) as c:
        assert not c.execute("SELECT name FROM sqlite_master WHERE name LIKE 'webhook_%'").fetchall()
        assert not c.execute("SELECT name FROM schema_data_migrations WHERE name LIKE 'webhooks_v1:%'").fetchall()
    class Missing(Resource):
        def read_text(self,**kwargs): raise FileNotFoundError('webhooks.sql')
    monkeypatch.setattr(schema,'files',lambda *args:Missing())
    with pytest.raises(FileNotFoundError): await DB(str(path)).connect()
    monkeypatch.setattr(schema,'files',original)
    db=DB(str(path)); await db.connect()
    try: assert await one(db.conn,"SELECT name FROM sqlite_master WHERE name='webhook_endpoints'")
    finally: await db.close()
