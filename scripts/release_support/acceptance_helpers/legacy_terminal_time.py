"""Optional, release-specific terminal-history migration probe.

Not called by the version-independent A/B runner. Explicitly opt in via
seed_upgrade.py ROOT BASELINE --legacy-terminal-time only for a migration that
promises this transformation; verify_upgrade.py follows the baseline marker.
The old schema is used as-is, never repaired to fit the fixture.
"""
import json


async def seed_legacy_terminal_time(db, conversation_uuid):
    await db.conn.execute("""INSERT INTO web_operations
        (conversation_uuid,op_id,op_type,lifecycle,status,revision,display_seq,payload_json,created_at_ms,updated_at_ms)
        VALUES (?, 'upgrade-legacy-operation', 'reasoning', 'terminal', 'completed', 1, 1, ?, 100, 9000)""",
        (conversation_uuid, json.dumps({'text': 'LEGACY_END_TIME_ORIGINAL: 中文\nKeep original text.'}, ensure_ascii=False)))
    await db.conn.execute("""INSERT INTO web_event_frames
        (conversation_uuid,frame_seq,op_id,op_type,action,revision,display_seq,payload_json,created_at_ms,updated_at_ms)
        VALUES (?,1,'upgrade-legacy-operation','reasoning','end',1,1,'{}',1234,1234)""",
        (conversation_uuid,))


def verify_legacy_terminal_time(con, conversation_uuid):
    marker = con.execute("SELECT COUNT(*) FROM schema_data_migrations WHERE name='web_operation_history_v1'").fetchone()[0]
    legacy = con.execute("SELECT revision,payload_json FROM web_operations WHERE conversation_uuid=? AND op_id='upgrade-legacy-operation'", (conversation_uuid,)).fetchone()
    frames = con.execute("SELECT MAX(revision) FROM web_event_frames WHERE conversation_uuid=? AND op_id='upgrade-legacy-operation'", (conversation_uuid,)).fetchone()[0]
    expected = {'text': 'LEGACY_END_TIME_ORIGINAL: 中文\nKeep original text.', 'terminalAtMs': 1234}
    ok = marker == 1 and legacy is not None and legacy[0] == 2 and json.loads(legacy[1]) == expected and frames == 2
    return {'ok': ok, 'markerCount': marker, 'operationRevision': legacy[0] if legacy else None,
            'frameRevision': frames, 'terminalAtMs': json.loads(legacy[1]).get('terminalAtMs') if legacy else None}
