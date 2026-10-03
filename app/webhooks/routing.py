"""Wait-first single ownership; sealed history is never rewritten."""
from __future__ import annotations

import json

from app.webhooks.contracts import WebhookError, digest, dumps, matches
from app.webhooks.repository import insert, many, one, uid
from app.webhooks.receipts import receipt
from app.webhooks.observability import span


async def expire(s,conn,e,*,member=None):
    if e['expires_at_ms'] is None or e['expires_at_ms']>s.clock(): return False
    _,config=await s.revision(conn,e['endpoint_id'],e['processing_revision'])
    await conn.execute("UPDATE webhook_batch_members SET invalidated_at_ms=?,invalidated_reason='expired' WHERE event_id=? AND invalidated_at_ms IS NULL",(s.clock(),e['event_id']))
    await receipt(s,conn,e['event_id'],source='framework',request_key='expired:'+e['event_id'],disposition='expired',member=member)
    await conn.execute("UPDATE webhook_events SET route_state='terminal',terminal_at_ms=?,terminal_reason='expired',review_required=? WHERE event_id=?",(s.clock(),int(config.expiry.on_expired=='needsReview'),e['event_id']))
    return True


async def seal(s,conn,batch_id,reason):
    b=await one(conn,"SELECT * FROM webhook_batches WHERE batch_id=? AND state='collecting'",(batch_id,))
    if not b: return
    counts=await one(conn,'SELECT COUNT(*) n,COALESCE(SUM(snapshot_bytes),0) bytes FROM webhook_batch_members WHERE batch_id=?',(batch_id,))
    for m in await many(conn,'SELECT * FROM webhook_batch_members WHERE batch_id=?',(batch_id,)):
        await span(s,conn,'aggregation',batch_id+':'+m['event_id'],start=m['entered_at_ms'],end=s.clock(),endpoint=b['endpoint_id'],event=m['event_id'],batch=batch_id,reason=reason)
    await conn.execute("UPDATE webhook_batches SET state='sealed',sealed_at_ms=?,seal_reason=?,snapshot_event_count=?,snapshot_bytes=? WHERE batch_id=? AND state='collecting'",(s.clock(),reason,counts['n'],counts['bytes'],batch_id))


async def material(s,conn,e):
    """Quarantine one corrupt accepted event without rewriting its receipt/body."""
    try:
        data=await s.event_material(conn,e['event_id'])
        dumps(data).encode()
        return data
    except (ValueError,UnicodeError,TypeError,OverflowError,WebhookError) as exc:
        if isinstance(exc,WebhookError) and exc.payload['code'] not in ('invalid_body','invalid_material','payload_unavailable'): raise
        await conn.execute("UPDATE webhook_events SET route_state='hold',review_required=1,terminal_reason='invalid_persisted_material',route_version=route_version+1 WHERE event_id=?",(e['event_id'],))
        await conn.execute("UPDATE webhook_batch_members SET invalidated_at_ms=?,invalidated_reason='invalid_persisted_material' WHERE event_id=? AND invalidated_at_ms IS NULL",(s.clock(),e['event_id']))
        return None


async def route(s,conn,e,*,only_wait=False):
    if e['route_state'] not in ('eligible','batch'): return
    if await expire(s,conn,e): return
    endpoint=await s.endpoint_row(conn,e['endpoint_id'],deleted=True)
    if s.blockers(endpoint): return
    _,c=await s.revision(conn,e['endpoint_id'],e['processing_revision'])
    data=await material(s,conn,e)
    if data is None: return
    size=len(dumps(data).encode())
    await seal_due_waits(s,conn,e['endpoint_id'])
    waits=await many(conn,"SELECT w.* FROM webhook_waits w JOIN webhook_assignments a USING(assignment_id) WHERE w.endpoint_id=? AND w.state IN ('registered','collecting') AND w.after_receive_seq<? AND (w.deadline_ms IS NULL OR w.deadline_ms>?) AND a.state='open'",(e['endpoint_id'],e['receive_seq'],s.clock()))
    matched=[w for w in waits if matches(json.loads(w['predicate_json']),data)]
    if matched:
        await conn.execute("UPDATE webhook_batch_members SET invalidated_at_ms=?,invalidated_reason='wait_claim' WHERE event_id=? AND invalidated_at_ms IS NULL",(s.clock(),e['event_id']))
        if len(matched)>1:
            for w in matched:
                await insert(conn,'webhook_wait_candidates',event_id=e['event_id'],wait_id=w['wait_id'],detected_at_ms=s.clock())
            await conn.execute("UPDATE webhook_events SET route_state='match_conflict',route_version=route_version+1 WHERE event_id=?",(e['event_id'],))
            return
        await claim(s,conn,e,matched[0]); return
    if only_wait or e['route_state']=='batch': return
    maximum=min(c.batching.max_bytes,s.config.batching.max_batch_bytes)
    if size>maximum:
        await conn.execute("UPDATE webhook_events SET route_state='hold',review_required=1,terminal_reason='oversize_event',model_bytes=? WHERE event_id=?",(size,e['event_id'])); return
    keys=[]
    if isinstance(data.get('preResult'),dict) and 'aggregation_key' in data['preResult']: keys.append({'script':data['preResult']['aggregation_key']})
    group=digest(keys)
    b=await one(conn,"SELECT * FROM webhook_batches WHERE endpoint_id=? AND revision=? AND aggregation_key=? AND state='collecting'",(e['endpoint_id'],e['processing_revision'],group))
    if b and ((b['idle_deadline_ms'] is not None and b['idle_deadline_ms']<=s.clock()) or (b['max_deadline_ms'] is not None and b['max_deadline_ms']<=s.clock())):
        await seal(s,conn,b['batch_id'],'maxWait' if b['max_deadline_ms'] is not None and b['max_deadline_ms']<=s.clock() else 'idle')
        b=None
    if b:
        counts=await one(conn,'SELECT COUNT(*) n,COALESCE(SUM(snapshot_bytes),0) bytes FROM webhook_batch_members WHERE batch_id=? AND invalidated_at_ms IS NULL',(b['batch_id'],))
        if counts['bytes']+size>maximum:
            await seal(s,conn,b['batch_id'],'bytes'); b=None
    now=s.clock()
    if not b:
        bid=uid()
        await insert(conn,'webhook_batches',batch_id=bid,endpoint_id=e['endpoint_id'],revision=e['processing_revision'],aggregation_key=group,state='collecting',first_entered_at_ms=now,last_entered_at_ms=now,
                     idle_deadline_ms=now+int(c.batching.idle_seconds*1000) if c.batching.idle_seconds else None,max_deadline_ms=now+int(c.batching.max_wait_seconds*1000) if c.batching.max_wait_seconds else None)
    else: bid=b['batch_id']
    await insert(conn,'webhook_batch_members',batch_id=bid,event_id=e['event_id'],receive_seq=e['receive_seq'],entered_at_ms=now,snapshot_bytes=size)
    await conn.execute("UPDATE webhook_events SET route_state='batch',route_version=route_version+1,aggregation_key=?,model_bytes=? WHERE event_id=?",(group,size,e['event_id']))
    await conn.execute('UPDATE webhook_batches SET last_entered_at_ms=?,idle_deadline_ms=? WHERE batch_id=?',(now,now+int(c.batching.idle_seconds*1000) if c.batching.idle_seconds else None,bid))
    counts=await one(conn,'SELECT COUNT(*) n,COALESCE(SUM(snapshot_bytes),0) bytes FROM webhook_batch_members WHERE batch_id=? AND invalidated_at_ms IS NULL',(bid,))
    if not c.batching.enabled or counts['n']>=min(c.batching.max_events,s.config.batching.max_batch_events) or counts['bytes']>=maximum:
        await seal(s,conn,bid,'disabled' if not c.batching.enabled else 'count' if counts['n']>=min(c.batching.max_events,s.config.batching.max_batch_events) else 'bytes')


async def claim(s,conn,e,w):
    now=s.clock()
    data=await material(s,conn,e)
    if data is None: return
    size=len(dumps(data).encode())
    if size>w['max_bytes']:
        await conn.execute("UPDATE webhook_events SET route_state='hold',review_required=1,terminal_reason='wait_oversize_event',model_bytes=? WHERE event_id=?",(size,e['event_id']))
        return
    await conn.execute('UPDATE webhook_events SET model_bytes=? WHERE event_id=?',(size,e['event_id']))
    e={**e,'model_bytes':size}
    members=await one(conn,'SELECT COUNT(*) n,COALESCE(SUM(e.model_bytes),0) bytes FROM webhook_assignment_events m JOIN webhook_events e USING(event_id) WHERE m.wait_id=? AND NOT EXISTS(SELECT 1 FROM webhook_receipts r WHERE r.assignment_event_id=m.assignment_event_id)',(w['wait_id'],))
    if members['n'] and members['bytes']+(e['model_bytes'] or 0)>w['max_bytes']:
        await conn.execute("UPDATE webhook_waits SET state='sealed',row_version=row_version+1 WHERE wait_id=?",(w['wait_id'],))
        await conn.execute("UPDATE webhook_events SET route_state='eligible' WHERE event_id=?",(e['event_id'],))
        e={**e,'route_state':'eligible'}
        await route(s,conn,e); return
    await insert(conn,'webhook_assignment_events',assignment_event_id=uid(),assignment_id=w['assignment_id'],event_id=e['event_id'],source_kind='wait',wait_id=w['wait_id'],claimed_at_ms=now)
    await conn.execute("UPDATE webhook_events SET route_state='assigned',route_version=route_version+1 WHERE event_id=?",(e['event_id'],))
    sealed=w['mode']=='single' or members['n']+1>=w['max_events'] or members['bytes']+(e['model_bytes'] or 0)>=w['max_bytes']
    await conn.execute('UPDATE webhook_waits SET state=?,first_claimed_at_ms=COALESCE(first_claimed_at_ms,?),last_claimed_at_ms=?,row_version=row_version+1 WHERE wait_id=?',('sealed' if sealed else 'collecting',now,now,w['wait_id']))


async def seal_due_waits(s,conn,endpoint_id=None):
    await conn.execute("UPDATE webhook_waits SET state='sealed',row_version=row_version+1 WHERE state='collecting' AND (? IS NULL OR endpoint_id=?) AND ((idle_ms IS NOT NULL AND last_claimed_at_ms+idle_ms<=?) OR (collect_max_ms IS NOT NULL AND first_claimed_at_ms+collect_max_ms<=?))",(endpoint_id,endpoint_id,s.clock(),s.clock()))


async def tick(s):
    async with s.db.webhook_transaction() as conn:
        for e in await many(conn,"SELECT * FROM webhook_events WHERE route_state='eligible' ORDER BY receive_seq"):
            await route(s,conn,e)
        for b in await many(conn,"SELECT * FROM webhook_batches WHERE state='collecting' AND (idle_deadline_ms<=? OR max_deadline_ms<=?)",(s.clock(),s.clock())):
            await seal(s,conn,b['batch_id'],'maxWait' if b['max_deadline_ms'] is not None and b['max_deadline_ms']<=s.clock() else 'idle')
        for e in await many(conn,"SELECT * FROM webhook_events WHERE terminal_at_ms IS NULL AND expires_at_ms<=? AND route_state IN ('pre','eligible','batch','hold')",(s.clock(),)):
            running=await one(conn,"SELECT job_id FROM webhook_stage_jobs WHERE event_id=? AND state='running'",(e['event_id'],))
            if not running: await expire(s,conn,e)
        from app.webhooks.waits import close_wait
        for w in await many(conn,"SELECT * FROM webhook_waits WHERE state IN ('registered','collecting','sealed') AND deadline_ms<=?",(s.clock(),)):
            await close_wait(s,conn,w,'timeout')
        await seal_due_waits(s,conn)
