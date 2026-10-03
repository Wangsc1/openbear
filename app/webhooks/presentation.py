"""Owner-facing event presentation; never changes controller/model input."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from app.webhooks.repository import many, one

CN_TZ = timezone(timedelta(hours=8))


def conversation_title(name, received_at_ms, batch_id):
    stamp = datetime.fromtimestamp(received_at_ms / 1000, CN_TZ).strftime('%m-%d %H:%M:%S')
    return f'{stamp} · {str(name or "外部事件")[:60]} · {str(batch_id)[:6]}'


def event_summary(body):
    """Only known readable fields, not an invented summary or raw identifiers."""
    if isinstance(body, str):
        return ' '.join(body.split())[:160]
    if not isinstance(body, dict):
        return ''
    pieces = []
    message = body.get('message')
    for value in (body.get('title'), body.get('subject'), body.get('event'), body.get('kind'),
                  body.get('type'), body.get('text'), body.get('caption'),
                  message.get('text') if isinstance(message, dict) else message):
        if isinstance(value, str) and value.strip():
            value = ' '.join(value.split())[:160]
            if value not in pieces: pieces.append(value)
        if len(pieces) == 2: break
    return ' · '.join(pieces)[:180]


async def assignment_card(conn, assignment_id):
    a = await one(conn, '''SELECT a.*,r.config_json FROM webhook_assignments a
        LEFT JOIN webhook_revisions r ON r.endpoint_id=a.origin_endpoint_id AND r.revision=a.origin_revision
        WHERE a.assignment_id=? AND a.origin_kind='webhook' ''', (assignment_id,))
    if not a: return None
    config = json.loads(a['config_json'] or '{}')
    rows = await many(conn, '''SELECT e.event_id,e.received_at_ms,p.content_type,p.body_bytes
        FROM webhook_assignment_events m JOIN webhook_events e USING(event_id)
        LEFT JOIN webhook_event_payloads p USING(event_id)
        WHERE m.assignment_id=? AND m.source_kind='initial' ORDER BY e.receive_seq''', (assignment_id,))
    events = []
    for row in rows:
        summary = ''
        if row['body_bytes'] is not None:
            from app.webhooks.ingress import parse_body
            from app.webhooks.contracts import WebhookError
            try: summary = event_summary(parse_body(row['content_type'], bytes(row['body_bytes'])))
            except (WebhookError, ValueError, UnicodeError): pass
        events.append({'eventId': row['event_id'], 'receivedAtMs': row['received_at_ms'], 'summary': summary})
    return {'name': config.get('name') or '外部事件', 'shortId': assignment_id[:8],
            'receivedAtMs': events[0]['receivedAtMs'] if events else a['created_at_ms'],
            'events': events, 'count': len(events)}


async def enrich_operations(conn, operations):
    # Legacy records are identified by the migration's trusted source flag,
    # never by a user writing webhook-looking text. Fetch only missing cards.
    for op in operations:
        if op.get('opType') != 'user_message' or op.get('source') != 'webhook': continue
        payload = op.setdefault('payload', {})
        if payload.get('eventCard'): continue
        aid = str(op.get('opId') or '').removeprefix('msg:')
        card = await assignment_card(conn, aid)
        if card: payload['eventCard'] = card
    return operations
