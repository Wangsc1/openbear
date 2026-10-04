"""Cron message presentation only; original model input and stored history stay intact."""
from __future__ import annotations

import json

from app.webhooks.repository import many


def run_card(row):
    config = json.loads(row['config_json'])
    return {'runId': row['run_id'], 'jobId': row['job_id'], 'name': row['job_name'],
            'trigger': row['trigger_kind'], 'scheduledAtMs': row['scheduled_at_ms'],
            'startedAtMs': row['started_at_ms'], 'schedule': config.get('schedule', {})}


async def enrich_operations(conn, operations, conversation_uuid):
    candidates = [op for op in operations if op.get('opType') == 'user_message'
                  and not (op.get('payload') or {}).get('cronCard')]
    if not candidates:
        return operations
    # A legacy operation was stored as source=user. Match the actual run, exact
    # message ID and root turn in this conversation, never text or title prefixes.
    rows = await many(conn, 'SELECT * FROM cron_runs WHERE conversation_uuid=?', (conversation_uuid,))
    runs = {'msg:' + row['run_id']: row for row in rows}
    for op in candidates:
        row = runs.get(op.get('opId'))
        if not row or op.get('turnId') != row['root_turn_uuid']:
            continue
        op['source'] = 'cron'
        op.setdefault('payload', {}).update(source='cron', cronRunId=row['run_id'], cronCard=run_card(row))
    return operations
