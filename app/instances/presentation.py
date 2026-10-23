"""Deployment/maintenance message presentation only; the model input stays intact."""
from __future__ import annotations

import json

from app.webhooks.repository import many, one


async def enrich_operations(conn, operations, conversation_uuid):
    """Show the controller-started instruction of a deployment/maintenance run as
    a card. Matches the exact operation message, never text or titles."""
    candidates = [op for op in operations if op.get('opType') == 'user_message'
                  and not (op.get('payload') or {}).get('instanceCard')]
    if not candidates:
        return operations
    if not await one(conn, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='instance_operations'"):
        return operations
    rows = await many(conn, 'SELECT * FROM instance_operations WHERE conversation_uuid=?', (conversation_uuid,))
    runs = {'msg:' + row['id']: row for row in rows}
    for op in candidates:
        row = runs.get(op.get('opId'))
        if not row or op.get('turnId') != row['root']:
            continue
        instance = await one(conn, 'SELECT public_json FROM managed_instances WHERE id=?', (row['instance_id'],))
        item = json.loads(instance['public_json']) if instance else {}
        payload = op.setdefault('payload', {})
        text = str(payload.get('text') or '')
        # Maintenance scope is the last block of the original instruction.
        scope = text.rsplit('\n', 1)[-1].strip() if row['kind'] == 'maintenance' and '\n' in text else ''
        op['source'] = 'instance'
        payload.update(source='instance', instanceCard={
            'operationId': row['id'], 'instanceId': row['instance_id'], 'kind': row['kind'], 'name': item.get('name', ''),
            'server': item.get('serverName', ''), 'workspacePath': item.get('workspacePath', ''), 'port': item.get('port'),
            'instructions': scope, 'startedAtMs': row['created_ms']})
    return operations
