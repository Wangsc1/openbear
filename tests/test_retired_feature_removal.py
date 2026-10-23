"""Startup removes the recommendation, background-assistant, habit and resource-monitoring data, idempotently."""
from __future__ import annotations

import sqlite3

from app.db.engine import DB

RETIRED = ("rec_settings", "rec_runs", "rec_cursors", "rec_profile", "rec_cards", "rec_feedback", "rec_weights",
           "rec_usage", "rec_usage_migrations", "request_snapshots", "request_blobs", "regression_cases",
           "memory_entry_versions")
RESOURCE_TABLES = ("resource_epochs", "resource_objects", "resource_package_pending", "resource_handles",
                   "resource_statistics", "resource_pages", "resource_page_items", "resource_plans",
                   "resource_requests", "resource_jobs")
# Same shape as the removed feature: triggers on tables that remain, writing to tables that go.
RESOURCE_TRIGGERS = {
    "resource_archive_epoch": "AFTER UPDATE OF archived_at ON web_conversations BEGIN "
                              "UPDATE resource_epochs SET epoch=epoch+1 WHERE conversation_uuid=NEW.conversation_uuid; END",
    "resource_unarchive": "AFTER UPDATE OF archived_at ON web_conversations BEGIN "
                          "UPDATE resource_epochs SET detached=0 WHERE conversation_uuid=NEW.conversation_uuid; END",
    "resource_delivery_created": "AFTER INSERT ON web_artifacts BEGIN "
                                 "INSERT INTO resource_objects(conversation_uuid) VALUES (NEW.conversation_uuid); END",
}


def tables(path):
    with sqlite3.connect(path) as conn:
        return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def triggers(path):
    with sqlite3.connect(path) as conn:
        return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}


async def test_fresh_database_has_no_retired_tables(tmp_path):
    path = tmp_path / "fresh.db"
    db = DB(str(path))
    await db.connect()
    await db.close()
    assert not set(RETIRED) & tables(path)
    with sqlite3.connect(path) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(memory_entries)")}
    assert not {"author", "user_edited"} & columns


async def test_old_database_loses_only_retired_data(tmp_path):
    path = tmp_path / "old.db"
    db = DB(str(path))
    await db.connect()
    await db.close()
    with sqlite3.connect(path) as conn:
        for table in RETIRED:
            conn.execute(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY, value TEXT)")
            conn.execute(f"INSERT INTO {table}(value) VALUES ('x')")
        conn.execute("ALTER TABLE memory_entries ADD COLUMN author TEXT NOT NULL DEFAULT ''")
        conn.execute("ALTER TABLE memory_entries ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0")
        habit = conn.execute("INSERT INTO memory_categories(key,name) VALUES ('habit','习惯')").lastrowid
        kept = conn.execute("INSERT INTO memory_categories(key,name) VALUES ('notes','笔记')").lastrowid
        conn.execute("INSERT INTO memory_entries(category_id,ref,title,author) VALUES (?,?,?,?)",
                     (habit, "habit-a", "习惯", "assistant"))
        conn.execute("INSERT INTO memory_entries(category_id,ref,title) VALUES (?,?,?)", (kept, "note-a", "保留"))
        for key in ("recommendation_prompt_default:7", "recommendation_managed_tools:7:f",
                    "folder_prompt_policy:7:f", "web_secret_key"):
            conn.execute("INSERT OR REPLACE INTO app_state(key,value) VALUES (?, 'v')", (key,))
        conn.execute("INSERT INTO web_conversations(conversation_uuid,owner_chat_id,internal_chat_id,title,origin_kind)"
                     " VALUES ('from-card',7,-5,'推荐发起','recommendation')")

    for _ in range(2):  # The second start finds nothing left to remove.
        again = DB(str(path))
        await again.connect()
        await again.close()

    assert not set(RETIRED) & tables(path)
    with sqlite3.connect(path) as conn:
        assert [r[0] for r in conn.execute("SELECT key FROM memory_categories WHERE key IN ('habit','notes')")] == ["notes"]
        assert [r[0] for r in conn.execute("SELECT ref FROM memory_entries WHERE ref IN ('habit-a','note-a')")] == ["note-a"]
        columns = {row[1] for row in conn.execute("PRAGMA table_info(memory_entries)")}
        assert not {"author", "user_edited"} & columns
        keys = {r[0] for r in conn.execute("SELECT key FROM app_state")}
        assert {"folder_prompt_policy:7:f", "web_secret_key"} <= keys
        assert not any(k.startswith("recommendation_") for k in keys)
        # Conversations a removed feature started stay, with their origin.
        assert conn.execute("SELECT origin_kind FROM web_conversations WHERE conversation_uuid='from-card'").fetchone() == (
            "recommendation",)


async def test_resource_monitoring_tables_and_triggers_are_removed(tmp_path):
    path = tmp_path / "resources.db"
    db = DB(str(path))
    await db.connect()
    await db.close()
    with sqlite3.connect(path) as conn:
        for table in RESOURCE_TABLES:
            conn.execute(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY, conversation_uuid TEXT,"
                         " epoch INTEGER NOT NULL DEFAULT 0, detached INTEGER NOT NULL DEFAULT 0)")
        for name, body in RESOURCE_TRIGGERS.items():
            conn.execute(f"CREATE TRIGGER {name} {body}")
        conn.execute("INSERT INTO web_conversations(conversation_uuid,owner_chat_id,internal_chat_id,title)"
                     " VALUES ('kept',7,-6,'保留')")

    for _ in range(2):
        again = DB(str(path))
        await again.connect()
        await again.close()

    assert not set(RESOURCE_TABLES) & tables(path)
    assert not set(RESOURCE_TRIGGERS) & triggers(path)
    # Writes that used to fire the triggers no longer reach the dropped tables.
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE web_conversations SET archived_at=1 WHERE conversation_uuid='kept'")
        conn.execute("UPDATE web_conversations SET archived_at=0 WHERE conversation_uuid='kept'")
        conn.execute("INSERT INTO web_artifacts(artifact_uuid,conversation_uuid,owner_chat_id,internal_chat_id,"
                     "file_name,sha256,storage_path) VALUES ('a1','kept',7,-6,'f.txt','0','/tmp/f.txt')")
        assert conn.execute("SELECT title FROM web_conversations WHERE conversation_uuid='kept'").fetchone() == ("保留",)
