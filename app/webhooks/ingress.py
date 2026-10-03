"""Persistent acceptance, raw-byte fingerprints and bounded intake."""
from __future__ import annotations

import hashlib
import json
import struct
from datetime import datetime

from app.webhooks.contracts import MISSING, WebhookError, dumps, iso, material, path_value, validate_material
from app.webhooks.repository import insert, one, uid


def rate(service,eid,c):
    # One calendar-minute counter per global/endpoint scope, no separate burst
    # capacity or hidden endpoint default. An explicit endpoint cap may be lower.
    minute=service.clock()//60000; system=service.config; candidates=[]
    specs=[('global',system.ingress.requests_per_minute),
           (eid,min(c.limits.requests_per_minute or system.ingress.requests_per_minute,system.ingress.requests_per_minute))]
    for key,limit in specs:
        at,count=service.rate_windows.get(key,(minute,0))
        count=count if at==minute else 0
        if count>=limit: raise WebhookError('rate_limited',status=429,retryable=True,details={'retryAfter':max(1,60-service.clock()//1000%60)})
        candidates.append((key,count+1))
    for key,count in candidates: service.rate_windows[key]=(minute,count)


def parse_body(content_type, body_bytes):
    try:
        text=body_bytes.decode('utf-8',errors='strict')
        body=json.loads(text,parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x))) if content_type=='application/json' else text
        validate_material(body)
        return body
    except (ValueError,UnicodeError,RecursionError,WebhookError):
        raise WebhookError('invalid_body') from None


async def receive(s,eid,key,content_type,body_bytes,query_pairs,identity=None):
    if len(body_bytes)>s.config.ingress.max_body_bytes: raise WebhookError('body_too_large',status=413)
    if content_type not in ('application/json','text/plain'): raise WebhookError('unsupported_type',status=415)
    body=parse_body(content_type,body_bytes)
    validate_material(query_pairs)
    validate_material(identity)
    parts=[content_type.encode(),dumps(query_pairs).encode(),body_bytes]
    fp=hashlib.sha256(b''.join(struct.pack('!Q',len(p))+p for p in parts)).hexdigest()
    async with s.db.webhook_transaction() as conn:
        e=await s.authenticate(conn,eid,key)
        _,c=await s.revision(conn,eid,e['current_revision'])
        source='header' if identity is not None else 'generated'
        if identity is None and c.idempotency.body_id_path:
            path=c.idempotency.body_id_path
            identity=path_value({'body':body},path) if path.startswith('body.') else path_value(body,path)
            if identity is MISSING or identity is None or type(identity) not in (str,int): raise WebhookError('body_id_missing')
            identity=str(identity); source='body'
        if identity is None: identity=uid()
        if not isinstance(identity,str) or not 1<=len(identity)<=512: raise WebhookError('invalid_idempotency_key')
        old=await one(conn,'SELECT * FROM webhook_events WHERE endpoint_id=? AND idempotency_key=?',(eid,identity))
        if old:
            if old['content_fingerprint']!=fp: raise WebhookError('idempotency_conflict',status=409)
            return {**json.loads(old['acceptance_json']),'duplicate':True}
        rate(s,eid,c)
        for args,suffix,max_events,max_bytes in [((),'',s.config.queue.max_events,s.config.queue.max_bytes),((eid,),' AND endpoint_id=?',min(c.limits.pending_events or s.config.queue.max_events,s.config.queue.max_events),min(c.limits.pending_bytes or s.config.queue.max_bytes,s.config.queue.max_bytes))]:
            size=await one(conn,'SELECT COUNT(*) n,COALESCE(SUM(model_bytes),0) bytes FROM webhook_events WHERE (terminal_at_ms IS NULL OR review_required=1)'+suffix,args)
            if size['n']>=max_events or size['bytes']+len(body_bytes)>max_bytes: raise WebhookError('queue_full',status=429,retryable=True,details={'retryAfter':1})
        now=s.clock(); event_id=uid(); data=material(query_pairs,body); base=now; source_at=None; reason=None
        state='pre' if c.pre.enabled else 'eligible'
        if c.expiry.basis=='sourceField':
            raw=path_value(data,c.expiry.timestamp_path)
            try:
                if c.expiry.source_time_format=='unixSeconds':
                    if type(raw) not in (int,float): raise ValueError()
                    base=int(raw*1000)
                else:
                    dt=datetime.fromisoformat(raw.replace('Z','+00:00'))
                    if dt.tzinfo is None: raise ValueError()
                    base=int(dt.timestamp()*1000)
                if base>now+c.expiry.max_future_skew_seconds*1000: raise ValueError()
                source_at=base
            except (TypeError,ValueError,AttributeError,OverflowError):
                base=now; reason='invalid_source_time'
                if c.expiry.missing_timestamp=='hold': state='hold'
        expiry=base+int(c.expiry.ttl_seconds*1000) if c.expiry.ttl_seconds is not None else None
        origin=path_value(data,c.correlation.origin_path,None); correlation=path_value(data,c.correlation.id_path,None)
        receipt={'eventId':event_id,'duplicate':False,'acceptedAt':iso(now),'status':'accepted'}
        await insert(conn,'webhook_events',event_id=event_id,endpoint_id=eid,idempotency_key=identity,identity_source=source,content_fingerprint=fp,
                     received_revision=e['current_revision'],processing_revision=e['current_revision'],received_at_ms=now,source_at_ms=source_at,expires_at_ms=expiry,
                     route_state=state,model_bytes=len(body_bytes),review_required=int(state=='hold'),terminal_reason=reason,origin=str(origin) if origin is not None else None,
                     correlation_id=str(correlation) if correlation is not None else None,acceptance_json=dumps(receipt))
        await insert(conn,'webhook_event_payloads',event_id=event_id,content_type=content_type,body_bytes=body_bytes,query_pairs_json=dumps(query_pairs))
        from app.webhooks.telemetry import project_dimensions
        dimensions,_=project_dimensions(c,data)
        await conn.execute('UPDATE webhook_event_payloads SET dimensions_json=? WHERE event_id=?',(dumps(dimensions),event_id))
        if c.correlation.ignore_own_echo and origin in c.correlation.own_origin_values:
            await conn.execute("UPDATE webhook_events SET route_state='terminal',terminal_at_ms=?,terminal_reason='own_echo' WHERE event_id=?",(now,event_id))
        elif state=='pre':
            await insert(conn,'webhook_stage_jobs',job_id=uid(),stage='pre',event_id=event_id,endpoint_id=eid,revision=e['current_revision'],action_key='pre:'+event_id,queued_at_ms=now,idempotency_policy_json=dumps(c.pre.retry.wire()))
    s.wake.set(); return receipt


async def event_material(conn,event_id):
    e=await one(conn,'SELECT * FROM webhook_events WHERE event_id=?',(event_id,)); p=await one(conn,'SELECT * FROM webhook_event_payloads WHERE event_id=?',(event_id,))
    if not e or not p: raise WebhookError('payload_unavailable',status=410)
    body=parse_body(p['content_type'],bytes(p['body_bytes'])); content=bytes(p['body_bytes']).decode()
    data=material(json.loads(p['query_pairs_json']),body,json.loads(p['model_data_json']) if p['model_data_json'] else None)
    validate_material(data)
    return {**data,'eventId':event_id,'endpointId':e['endpoint_id'],'receiveSeq':e['receive_seq'],'receivedRevision':e['received_revision'],
            'receivedAt':iso(e['received_at_ms']),'content':content,'preResult':json.loads(p['pre_result_json']) if p['pre_result_json'] else None}
