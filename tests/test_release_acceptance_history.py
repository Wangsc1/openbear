"""B gate helper tests only: real temporary SQLite/Python, no systemd or release."""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace

import aiosqlite
import pytest

from scripts.release_support.acceptance_helpers import heavy_upgrade as history
from scripts.release_support.acceptance_helpers.startup_audit import verify_audit

HELPERS = pathlib.Path(__file__).resolve().parents[1] / "scripts/release_support/acceptance_helpers"
OLD_SCHEMA = pathlib.Path(__file__).parent / "fixtures/upgrade_v092.sql"


@pytest.fixture(scope="module")
def seeded_history(tmp_path_factory):
    path = tmp_path_factory.mktemp("acceptance-history") / "old.db"
    with sqlite3.connect(path) as con:
        con.executescript(OLD_SCHEMA.read_text())
        con.execute("INSERT INTO web_conversations(conversation_uuid,owner_chat_id,internal_chat_id) VALUES('history',1,-1)")
        before_schema = list(con.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name"))

    async def seed():
        async with aiosqlite.connect(path) as conn:
            result = await history.seed_heavy_history(SimpleNamespace(conn=conn), "history")
            await conn.commit()
            return result

    baseline = asyncio.run(seed())
    with sqlite3.connect(path) as con:
        assert list(con.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")) == before_schema
    return path, baseline


def test_fixture_uses_native_old_schema_and_real_aged_payloads(seeded_history):
    path, baseline = seeded_history
    assert baseline["frameCount"] == 120_000
    assert baseline["payloadBytes"] > 100_000_000
    assert baseline["compatibility"]["strategy"] == "native-old-schema-required-no-ddl"
    with sqlite3.connect(path) as con:
        assert history.verify_heavy_history(con, baseline)["ok"]
        cutoff = int((time.time() - 7 * 86400) * 1000)
        assert con.execute("SELECT COUNT(*) FROM web_event_frames WHERE created_at_ms<?", (cutoff,)).fetchone()[0] == 120_000
        assert con.execute("SELECT COUNT(DISTINCT op_id) FROM web_event_frames").fetchone()[0] == 24
        for op_id, raw in con.execute("SELECT op_id,payload_json FROM web_operations"):
            payload = json.loads(raw)
            assert "UPGRADE_HISTORY_BODY_SENTINEL" in payload["text"] and "历史正文" in payload["text"]
            assert payload["terminalAtMs"] > 0
        assert sum(item["frameSeq"] < baseline["lastFrameSeq"] - 5000 for item in baseline["latestFrames"]) >= 20


@pytest.mark.parametrize("mutation,error", [
    ("DELETE FROM web_event_frames WHERE frame_seq=1", "frame count"),
    ("DELETE FROM web_event_frames WHERE frame_seq=5000", "latest frame"),
    ("UPDATE web_event_frames SET payload_json='{}' WHERE frame_seq=5000", "latest frame"),
    ("UPDATE web_operations SET payload_json='{}' WHERE op_id='upgrade-history-00'", "operation body"),
    ("DELETE FROM web_operations WHERE op_id='upgrade-history-00'", "operation body"),
])
def test_history_detects_loss_or_body_corruption_without_mutating_db(seeded_history, mutation, error):
    path, baseline = seeded_history
    con = sqlite3.connect(path)
    try:
        con.execute(mutation)
        before = con.total_changes
        result = history.verify_heavy_history(con, baseline)
        assert not result["ok"] and any(error in message for message in result["errors"])
        assert con.total_changes == before
    finally:
        con.rollback()
        con.close()


def test_unsupported_old_schema_fails_explicitly_without_ddl(tmp_path):
    async def run():
        async with aiosqlite.connect(tmp_path / "unsupported.db") as con:
            await con.execute("CREATE TABLE web_event_frames(id INTEGER PRIMARY KEY)")
            with pytest.raises(RuntimeError, match="unsupported previous history schema.*no schema fabrication or skipped gate"):
                await history.seed_heavy_history(SimpleNamespace(conn=con), "history")
            cursor = await con.execute("SELECT name FROM sqlite_master WHERE type='table'")
            assert await cursor.fetchall() == [("web_event_frames",)]
    asyncio.run(run())


def test_small_fixture_cannot_satisfy_gate():
    with pytest.raises(ValueError, match=">=100000"):
        asyncio.run(history.seed_heavy_history(None, "history", frame_count=96))


def test_inherited_audit_environment_does_not_count_child_python_as_service_boot(tmp_path):
    audit = tmp_path / "audit.jsonl"
    env = {**os.environ, "PYTHONPATH": str(HELPERS), "OB_ACCEPTANCE_STARTUP_AUDIT": str(audit), "OB_ACCEPTANCE_TG": ""}
    proc = subprocess.run([sys.executable, "-c", "import sqlite3; sqlite3.connect(':memory:').close()"],
                          cwd=tmp_path, env=env, capture_output=True, text=True, timeout=15)
    assert proc.returncode == 0, proc.stderr
    assert not audit.exists()


def audit_rows():
    return [dict(event=event, pid=123, bootId="one-boot", elapsedSeconds=0.5, **fields) for event, fields in [
        ("observerInstalled", {}), ("startupEntered", {}),
        ("sqliteObserved", {"database": "/tmp/fixture.db"}), ("startupReturned", {"startupReady": True}),
    ]]


@pytest.mark.parametrize("broken", ["missing-observer", "missing-connection", "wrong-database", "missing-ready", "slow", "delete", "failed", "wrong-pid", "duplicate-boot"])
def test_audit_cannot_pass_missing_or_bad_evidence(broken):
    rows = audit_rows()
    assert verify_audit(rows, 123, database="/tmp/fixture.db")["ok"]
    if broken == "missing-observer":
        rows.pop(0)
    elif broken == "missing-connection":
        rows.pop(2)
    elif broken == "wrong-database":
        rows[2]["database"] = "/tmp/unrelated.db"
    elif broken == "missing-ready":
        rows[-1]["startupReady"] = False
    elif broken == "slow":
        rows[-1]["elapsedSeconds"] = 60.1
    elif broken in {"delete", "failed"}:
        rows.append({**rows[0], "event": "frameDeleteAttempt" if broken == "delete" else "startupFailed"})
    elif broken == "wrong-pid":
        for row in rows:
            row["pid"] = 999
    else:
        rows.append({**rows[0], "bootId": "unexpected-restart"})
    assert not verify_audit(rows, 123, database="/tmp/fixture.db")["ok"]


@pytest.mark.parametrize("sql,expected_deletes", [
    ("SELECT * FROM web_event_frames", 0),
    ('/* old startup cleanup */ DELETE FROM "web_event_frames" WHERE id=-1', 1),
    ("WITH doomed AS (SELECT id FROM web_event_frames WHERE id=-1) DELETE FROM web_event_frames WHERE id IN (SELECT id FROM doomed)", 1),
    ("CREATE TRIGGER prune AFTER INSERT ON other BEGIN DELETE FROM web_event_frames WHERE id=-1; END; INSERT INTO other VALUES(1);", 1),
])
def test_sitecustomize_observes_real_sqlite_without_suppressing_execution(tmp_path, sql, expected_deletes):
    app = tmp_path / "app"
    app.mkdir()
    (app / "__init__.py").write_text("")
    (app / "services.py").write_text('''import asyncio, os, sqlite3
class Services:
    async def startup(self):
        self.startup_ready = asyncio.Event()
        with sqlite3.connect('fixture.db') as con:
            con.executescript('CREATE TABLE web_event_frames(id INTEGER); INSERT INTO web_event_frames VALUES(1); CREATE TABLE other(id INTEGER);')
            con.executescript(os.environ['TEST_SQL'])
            assert con.execute('SELECT COUNT(*) FROM web_event_frames').fetchone()[0] == 1
        self.startup_ready.set()
''')
    (app / "main.py").write_text("import asyncio, os\nfrom app.services import Services\nasyncio.run(Services().startup())\nprint(os.getpid())\n")
    audit = tmp_path / "audit.jsonl"
    env = {**os.environ, "PYTHONPATH": str(HELPERS), "OB_ACCEPTANCE_STARTUP_AUDIT": str(audit),
           "OB_ACCEPTANCE_TG": "", "TEST_SQL": sql}
    proc = subprocess.run([sys.executable, "-m", "app.main"], cwd=tmp_path, env=env,
                          capture_output=True, text=True, timeout=15)
    assert proc.returncode == 0, proc.stderr
    rows = [json.loads(line) for line in audit.read_text().splitlines()]
    result = verify_audit(rows, proc.stdout.strip(), database=tmp_path / "fixture.db")
    assert result["sqliteConnectionsObserved"] == 1
    assert result["frameDeleteAttempts"] == expected_deletes
    assert result["ok"] is (expected_deletes == 0)
    assert "DELETE FROM" not in audit.read_text()
    assert result["readySeconds"] < 15


@pytest.mark.parametrize("fault", [None, "delete", "wrong-version", "extra-boot"])
def test_startup_probe_cli_writes_bounded_http_history_and_failure_evidence(tmp_path, seeded_history, fault):
    path, baseline = seeded_history
    before = tmp_path / "baseline.json"
    before.write_text(json.dumps({"dbPath": str(path), "heavyHistory": baseline}))
    rows = audit_rows()
    rows[2]["database"] = str(path)
    if fault == "delete":
        rows.append({**rows[0], "event": "frameDeleteAttempt"})
    if fault == "extra-boot":
        rows.append({**rows[0], "pid": 456, "bootId": "crash-restart"})
    audit, output = tmp_path / "audit.jsonl", tmp_path / "probe.json"
    audit.write_text("".join(json.dumps(row) + "\n" for row in rows))

    class Health(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == "/health"
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "version": "wrong" if fault == "wrong-version" else "2.4.0"}).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Health)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        proc = subprocess.run([sys.executable, str(HELPERS / "startup_probe.py"),
            "--baseline", str(before), "--audit", str(audit), "--output", str(output),
            "--pid", "123", "--boot-number", "1", "--version", "2.4.0", "--port", str(server.server_port)],
            capture_output=True, text=True, timeout=15)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert proc.returncode == (0 if fault is None else 1), proc.stderr
    result = json.loads(output.read_text())
    assert result["ok"] is (fault is None)
    if fault != "wrong-version":
        assert result["history"]["afterFrames"] == 120_000
        assert result["history"]["latestFramesChecked"] == 24
        assert result["health"]["samples"] == 3
    if fault:
        assert result["errors"]
