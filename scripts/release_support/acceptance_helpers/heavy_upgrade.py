"""Large old-install fixture, using only the installed database's existing schema.

Core operation/frame columns are mandatory: unsupported previous releases FAIL the
B gate with their missing columns, rather than creating a new-version schema or
silently skipping this regression. Optional routing columns use old DB defaults.
No app imports: this helper can also be used with a temporary old-version DB.
"""
from __future__ import annotations

import hashlib
import json
import time

FRAME_COUNT = 120_000
OPERATION_COUNT = 24
PREFIX = "upgrade-history-"
CORE = {
    "web_event_frames": {"id", "conversation_uuid", "frame_seq", "op_id", "op_type", "action",
                         "revision", "display_seq", "payload_json", "created_at_ms", "updated_at_ms"},
    "web_operations": {"id", "conversation_uuid", "op_id", "op_type", "lifecycle", "status",
                       "revision", "display_seq", "payload_json", "created_at_ms", "updated_at_ms"},
}


def payload_digest(value):
    # Compare semantic JSON, not serializer whitespace or key order.
    return hashlib.sha256(json.dumps(json.loads(value), sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


async def seed_heavy_history(db, conversation_uuid, *, frame_count=FRAME_COUNT):
    """Append >=100k aged real JSON frames plus completed operation snapshots.

    Caller owns commit/close. Works with old DB.conn/aiosqlite; does not run a new
    application, schema patch, retention implementation or maintenance shortcut.
    """
    if frame_count < 100_000 or frame_count % OPERATION_COUNT:
        raise ValueError("history fixture requires >=100000 rows divisible by 24")
    schema = {}
    for table, required in CORE.items():
        cursor = await db.conn.execute(f"PRAGMA table_info({table})")
        schema[table] = {row[1] for row in await cursor.fetchall()}
        missing = required - schema[table]
        if missing:
            raise RuntimeError(f"unsupported previous history schema: {table} missing {sorted(missing)}; "
                               "B requires native event/operation tables; no schema fabrication or skipped gate")
    cursor = await db.conn.execute("SELECT COALESCE(MAX(frame_seq),0) FROM web_event_frames WHERE conversation_uuid=?",
                                   (conversation_uuid,))
    first_seq = int((await cursor.fetchone())[0]) + 1
    cursor = await db.conn.execute("SELECT COALESCE(MAX(display_seq),0) FROM web_operations WHERE conversation_uuid=?",
                                   (conversation_uuid,))
    first_display = int((await cursor.fetchone())[0]) + 1
    per_operation = frame_count // OPERATION_COUNT
    # All frames, including the protected latest ones, are older than retention.
    old_ms = int((time.time() - 90 * 86400) * 1000)
    sentinels = []
    payload_bytes = 0
    for index in range(OPERATION_COUNT):
        op_id = f"{PREFIX}{index:02d}"
        display = first_display + index
        rows = []
        terminal = old_ms + per_operation
        for revision in range(1, per_operation + 1):
            final = revision == per_operation
            text = (f"UPGRADE_HISTORY_BODY_SENTINEL:{index:02d}\n历史正文必须保留。\n"
                    + "Preserve the user's accepted correction, code and tool result. " * 12
                    + f"\nrevision={revision}")
            payload = {"text": text, "status": "completed" if final else "running"}
            if final:
                payload.update(terminalAtMs=terminal, transcriptMessageIds=[])
            raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            payload_bytes += len(raw.encode())
            seq = first_seq + index * per_operation + revision - 1
            rows.append((conversation_uuid, seq, op_id, "assistant_message", "end" if final else "patch",
                         revision, display, raw, old_ms + revision, old_ms + revision))
            if len(rows) == 1000 or final:
                await db.conn.executemany("""INSERT INTO web_event_frames
                    (conversation_uuid,frame_seq,op_id,op_type,action,revision,display_seq,payload_json,created_at_ms,updated_at_ms)
                    VALUES (?,?,?,?,?,?,?,?,?,?)""", rows)
                rows.clear()
        await db.conn.execute("""INSERT INTO web_operations
            (conversation_uuid,op_id,op_type,lifecycle,status,revision,display_seq,payload_json,created_at_ms,updated_at_ms)
            VALUES (?,?,'assistant_message','terminal','completed',?,?,?,?,?)""",
            (conversation_uuid, op_id, per_operation, display, raw, old_ms + 1, terminal))
        cursor = await db.conn.execute("SELECT id FROM web_event_frames WHERE conversation_uuid=? AND frame_seq=?",
                                       (conversation_uuid, seq))
        frame_id = int((await cursor.fetchone())[0])
        sentinels.append({"opId": op_id, "frameId": frame_id, "frameSeq": seq, "revision": per_operation,
                          "payloadSha256": payload_digest(raw), "displaySeq": display})
    result = {"schema": 1, "conversationUuid": conversation_uuid, "frameCount": frame_count,
              "operationCount": OPERATION_COUNT, "firstFrameSeq": first_seq,
              "lastFrameSeq": first_seq + frame_count - 1, "payloadBytes": payload_bytes,
              "ageDays": 90, "latestFrames": sentinels,
              "compatibility": {"strategy": "native-old-schema-required-no-ddl",
                                "columns": {k: sorted(v) for k, v in schema.items()}}}
    return result


def verify_heavy_history(con, baseline):
    """Read-only preservation, including ALL frames during the startup window.

    Latest frames and operation bodies are separately checked so a count-preserving
    replacement cannot conceal loss. Later daily retention is outside this gate.
    """
    errors = []
    if baseline.get("frameCount", 0) < 100_000 or len(baseline.get("latestFrames", [])) != OPERATION_COUNT:
        errors.append("invalid or incomplete heavy-history baseline")
    conv = baseline["conversationUuid"]
    count = con.execute("SELECT COUNT(*) FROM web_event_frames WHERE conversation_uuid=? AND frame_seq BETWEEN ? AND ?",
                        (conv, baseline["firstFrameSeq"], baseline["lastFrameSeq"])).fetchone()[0]
    if count != baseline["frameCount"]:
        errors.append(f"startup changed historical frame count: {count} != {baseline['frameCount']}")
    checked = 0
    for item in baseline["latestFrames"]:
        frame = con.execute("""SELECT id,frame_seq,revision,payload_json FROM web_event_frames
            WHERE conversation_uuid=? AND op_id=? ORDER BY revision DESC,id DESC LIMIT 1""",
            (conv, item["opId"])).fetchone()
        operation = con.execute("""SELECT revision,display_seq,payload_json,lifecycle,status FROM web_operations
            WHERE conversation_uuid=? AND op_id=?""", (conv, item["opId"])).fetchone()
        if (frame is None or tuple(frame[:3]) != (item["frameId"], item["frameSeq"], item["revision"])
                or payload_digest(frame[3]) != item["payloadSha256"]):
            errors.append(f"latest frame lost/changed: {item['opId']}")
        if (operation is None or tuple(operation[:2]) != (item["revision"], item["displaySeq"])
                or payload_digest(operation[2]) != item["payloadSha256"]
                or tuple(operation[3:]) != ("terminal", "completed")):
            errors.append(f"operation body/state lost/changed: {item['opId']}")
        checked += 1
    return {"ok": not errors, "beforeFrames": baseline["frameCount"], "afterFrames": count,
            "latestFramesChecked": checked, "operationBodiesChecked": checked, "errors": errors}
