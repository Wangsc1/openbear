"""Explicit verified recovery; toggles never replay uncertain external effects."""
from __future__ import annotations

import json
import secrets

from app.webhooks.contracts import WebhookError, digest, dumps, iso
from app.webhooks.repository import many, one
from app.webhooks.receipts import candidate, receipt
from app.webhooks.waits import close_wait, public
from app.webhooks.routing import claim


async def owned_event(s,conn,owner,event_id):
    e=await one(conn,'SELECT e.* FROM webhook_events e JOIN webhook_endpoints p USING(endpoint_id) WHERE e.event_id=? AND p.owner_chat_id=?',(event_id,owner))
    if not e: raise WebhookError('not_found',status=404)
    return e


def check_version(e,request,column='route_version'):
    if request.get('expectedVersion')!=e[column]: raise WebhookError('version_conflict',status=409,currentRevision=e[column])


async def operation_start(s,conn,owner,request,action,eid):
    old,fp=await s.operation(conn,owner,request,action,eid)
    if old: return old,None
    await s.record_operation(conn,owner,request,action,eid,fp,{})
    row=await one(conn,'SELECT * FROM webhook_control_operations WHERE owner_chat_id=? AND request_id=?',(owner,request['requestId']))
    return None,row['operation_id']


async def operation_done(conn,op,result):
    await conn.execute('UPDATE webhook_control_operations SET result_json=? WHERE operation_id=?',(dumps(result),op))
    return result


async def retry(s,owner,event_id,request):
    stage=request.get('stage')
    if stage not in ('pre','post','model'): raise WebhookError('invalid_stage')
    async with s.db.webhook_transaction() as conn:
        e=await owned_event(s,conn,owner,event_id)
        old,op=await operation_start(s,conn,owner,request,'retry',e['endpoint_id'])
        if old: return json.loads(old['result_json'])
        check_version(e,request)
        if stage in ('pre','post'):
            job=await one(conn,'SELECT * FROM webhook_stage_jobs WHERE stage=? AND (event_id=? OR assignment_id IN (SELECT assignment_id FROM webhook_assignment_events WHERE event_id=?)) ORDER BY queued_at_ms DESC LIMIT 1',(stage,event_id,event_id))
            if not job or job['state'] not in ('failed','unknown','held'): raise WebhookError('stage_not_retryable',status=409)
            attempt=await one(conn,'SELECT * FROM webhook_stage_attempts WHERE job_id=? ORDER BY attempt_no DESC LIMIT 1',(job['job_id'],))
            policy=json.loads(job['idempotency_policy_json'])
            verified=await one(conn,"SELECT * FROM webhook_receipts WHERE event_id=? AND source='administrator' AND stage_attempt_id=? ORDER BY result_version DESC LIMIT 1",(event_id,attempt['attempt_id'])) if attempt else None
            if attempt and attempt['side_effect_state']=='unknown' and not policy.get('idempotencyDeclaration') and not (verified and verified['outcome']=='failed'):
                raise WebhookError('verify_unknown_effect_first',status=409,effectState='unknown',details={'attemptId':attempt['attempt_id'],'actionKey':job['action_key']})
            await conn.execute("UPDATE webhook_stage_jobs SET state='pending',next_attempt_at_ms=?,terminal_at_ms=NULL,retry_operation_id=?,row_version=row_version+1 WHERE job_id=?",(s.clock(),op,job['job_id']))
            if stage=='pre': await conn.execute("UPDATE webhook_events SET route_state='pre',terminal_at_ms=NULL,review_required=0,route_version=route_version+1 WHERE event_id=?",(event_id,))
            result={'eventId':event_id,'jobId':job['job_id'],'effectState':attempt['side_effect_state'] if attempt else 'none'}
        else:
            m=await one(conn,'SELECT m.*,a.state assignment_state FROM webhook_assignment_events m JOIN webhook_assignments a USING(assignment_id) WHERE m.event_id=? AND m.released_at_ms IS NULL',(event_id,))
            if not m or m['assignment_state']!='finalized': raise WebhookError('assignment_not_finalized',status=409)
            r=await one(conn,'SELECT * FROM webhook_receipts WHERE event_id=? ORDER BY result_version DESC LIMIT 1',(event_id,))
            if not r or r['outcome'] in ('completed','skipped'): raise WebhookError('completed_event_not_retryable',status=409)
            uncertain=await one(conn,"SELECT 1 FROM runtime_actions x JOIN webhook_runtime_links l USING(run_id) WHERE l.assignment_id=? AND x.kind='tool' AND x.status IN ('started','unknown') LIMIT 1",(m['assignment_id'],))
            if (r['outcome']=='unknown' or uncertain or (m['delivered_at_ms'] is not None and r['disposition'] in ('cancelled','protocol_incomplete'))) and not (r['source']=='administrator' and r['outcome']=='failed'):
                raise WebhookError('verify_unknown_effect_first',status=409,effectState='unknown')
            await conn.execute('UPDATE webhook_assignment_events SET released_at_ms=?,release_operation_id=? WHERE assignment_event_id=?',(s.clock(),op,m['assignment_event_id']))
            await conn.execute("UPDATE webhook_events SET route_state='eligible',terminal_at_ms=NULL,review_required=0,route_version=route_version+1 WHERE event_id=?",(event_id,))
            result={'eventId':event_id,'effectState':'reported','previousAssignmentId':m['assignment_id']}
        await operation_done(conn,op,result)
    s.wake.set(); return result


async def verify(s,owner,event_id,request):
    stage=request.get('stage')
    if stage not in ('pre','post','model'): raise WebhookError('invalid_stage')
    if request.get('outcome') not in ('completed','skipped','failed','unknown') or not request.get('reason') or not request.get('evidenceRefs'): raise WebhookError('verification_evidence_required')
    async with s.db.webhook_transaction() as conn:
        e=await owned_event(s,conn,owner,event_id)
        old,op=await operation_start(s,conn,owner,request,'recover',e['endpoint_id'])
        if old: return json.loads(old['result_json'])
        check_version(e,request)
        m=await one(conn,'SELECT * FROM webhook_assignment_events WHERE event_id=? AND released_at_ms IS NULL',(event_id,))
        if m:
            a=await one(conn,'SELECT * FROM webhook_assignments WHERE assignment_id=?',(m['assignment_id'],))
            if a['state']!='finalized' and a['recovery_state']!='needs_control': raise WebhookError('active_assignment',status=409)
        job=await one(conn,'SELECT * FROM webhook_stage_jobs WHERE stage=? AND (event_id=? OR assignment_id IN (SELECT assignment_id FROM webhook_assignment_events WHERE event_id=?)) ORDER BY queued_at_ms DESC LIMIT 1',(stage,event_id,event_id)) if stage!='model' else None
        if stage!='model' and (not job or job['state'] not in ('unknown','failed','held')): raise WebhookError('stage_not_verifiable',status=409)
        if stage=='model' and not m: raise WebhookError('stage_not_verifiable',status=409)
        attempt=await one(conn,'SELECT * FROM webhook_stage_attempts WHERE job_id=? ORDER BY attempt_no DESC LIMIT 1',(job['job_id'],)) if job else None
        rid=await receipt(s,conn,event_id,source='administrator',request_key='verification:'+op,outcome=request['outcome'],member=m['assignment_event_id'] if m and stage=='model' else None,attempt=attempt['attempt_id'] if attempt else None,reason=request['reason'],evidence=request['evidenceRefs'],result=request.get('result'))
        if job:
            await conn.execute('UPDATE webhook_stage_jobs SET state=?,terminal_at_ms=?,row_version=row_version+1 WHERE job_id=?',('succeeded' if request['outcome'] in ('completed','skipped') else 'unknown' if request['outcome']=='unknown' else 'failed',s.clock(),job['job_id']))
        unresolved_model=await one(conn,'SELECT review_required FROM webhook_receipts WHERE assignment_event_id=? ORDER BY result_version DESC LIMIT 1',(m['assignment_event_id'],)) if m else None
        unresolved_stage=await one(conn,"SELECT 1 FROM webhook_stage_jobs WHERE state IN ('unknown','held') AND (event_id=? OR assignment_id=?)",(event_id,m['assignment_id'] if m else None))
        review=bool(request['outcome']=='unknown' or unresolved_stage or unresolved_model and unresolved_model['review_required'])
        if stage=='model' or not m:
            await conn.execute("UPDATE webhook_events SET route_state='terminal',terminal_at_ms=COALESCE(terminal_at_ms,?),review_required=?,terminal_reason='administrator_verified',route_version=route_version+1 WHERE event_id=?",(s.clock(),int(review),event_id))
        else:
            # A pre/post verification is not a replacement model business result.
            await conn.execute('UPDATE webhook_events SET review_required=?,route_version=route_version+1 WHERE event_id=?',(int(review),event_id))
        if m and stage=='model' and a['origin_endpoint_id']:
            unresolved=await one(conn,"SELECT 1 FROM webhook_assignment_events m JOIN webhook_receipts r ON r.assignment_event_id=m.assignment_event_id WHERE m.assignment_id=? AND r.result_version=(SELECT MAX(result_version) FROM webhook_receipts r2 WHERE r2.assignment_event_id=m.assignment_event_id) AND r.review_required=1 LIMIT 1",(a['assignment_id'],))
            if not unresolved:
                endpoint=await s.endpoint_row(conn,a['origin_endpoint_id'],deleted=True); blockers=json.loads(endpoint['model_blockers_json']); blockers.pop('review:'+a['assignment_id'],None)
                await conn.execute('UPDATE webhook_endpoints SET model_blockers_json=?,control_version=control_version+1 WHERE endpoint_id=?',(dumps(blockers),a['origin_endpoint_id']))
        result={'eventId':event_id,'version':e['route_version']+1,'effectState':'unknown' if request['outcome']=='unknown' else 'confirmed','receiptId':rid}
        return await operation_done(conn,op,result)


async def wait_control(s,owner,wait_id,request):
    async with s.db.webhook_transaction() as conn:
        w=await one(conn,'SELECT w.* FROM webhook_waits w JOIN webhook_endpoints e USING(endpoint_id) WHERE w.wait_id=? AND e.owner_chat_id=?',(wait_id,owner))
        if not w: raise WebhookError('not_found',status=404)
        action=request.get('action')
        if action not in ('cancel','resolve_match'): raise WebhookError('invalid_wait_control')
        old,op=await operation_start(s,conn,owner,request,'resolve_match' if action=='resolve_match' else 'stop',w['endpoint_id'])
        if old: return json.loads(old['result_json'])
        check_version(w,request,'row_version')
        if action=='cancel': await close_wait(s,conn,w,request.get('reason') or 'cancelled')
        else:
            eid=request.get('eventId'); e=await owned_event(s,conn,owner,eid)
            c=await one(conn,'SELECT * FROM webhook_wait_candidates WHERE event_id=? AND wait_id=? AND resolved_at_ms IS NULL',(eid,wait_id))
            if not c or e['route_state']!='match_conflict' or w['state'] not in ('registered','collecting'): raise WebhookError('match_conflict_changed',status=409)
            await conn.execute("UPDATE webhook_wait_candidates SET resolved_at_ms=?,resolution=CASE WHEN wait_id=? THEN 'selected' ELSE 'rejected' END,operation_id=? WHERE event_id=? AND resolved_at_ms IS NULL",(s.clock(),wait_id,op,eid))
            await conn.execute("UPDATE webhook_events SET route_state='eligible',route_version=route_version+1 WHERE event_id=?",(eid,)); e['route_state']='eligible'
            await claim(s,conn,e,w)
        result={'wait':public(await one(conn,'SELECT * FROM webhook_waits WHERE wait_id=?',(wait_id,)))}
        await operation_done(conn,op,result)
    s.wake.set(); return result


async def rebind(s,owner,eid,request):
    async with s.db.webhook_transaction() as conn:
        endpoint=await s.endpoint_row(conn,eid,owner)
        if request.get('prepare'):
            if request.get('expectedRevision')!=endpoint['current_revision']: raise WebhookError('revision_conflict',status=409)
            await s.revision(conn,eid,request.get('toRevision'))
            ids=request.get('eventIds')
            if not isinstance(ids,list) or not ids or len(ids)>1000: raise WebhookError('event_selection_required')
            selected=[]
            for event_id in ids:
                e=await owned_event(s,conn,owner,event_id)
                if e['endpoint_id']!=eid or e['route_state'] not in ('pre','eligible','batch','hold'): raise WebhookError('event_already_executed',status=409)
                job=await one(conn,'SELECT * FROM webhook_stage_jobs WHERE event_id=?',(event_id,))
                if job and (job['state'] not in ('pending','succeeded') or job['state']=='pending' and job['execution_fence']): raise WebhookError('stage_already_attempted',status=409)
                selected.append({'eventId':event_id,'version':e['route_version']})
            token=secrets.token_urlsafe(32); s.confirmations[digest(token)]={'owner':owner,'endpoint':eid,'action':'rebind','revision':endpoint['current_revision'],'control':endpoint['control_version'],'params':request,'events':selected,'expiry':s.clock()+300000}
            return {'impact':{'events':selected,'toRevision':request['toRevision'],'completedPreWillNotRerun':True},'confirmationToken':token,'expiresAt':iso(s.clock()+300000)}
        audit={**request,'confirmationToken':digest(request.get('confirmationToken'))}
        old,op=await operation_start(s,conn,owner,audit,'rebind',eid)
        if old: return json.loads(old['result_json'])
        key=digest(request.get('confirmationToken')); grant=s.confirmations.get(key)
        if not grant or grant['owner']!=owner or grant['endpoint']!=eid or grant['action']!='rebind' or grant['expiry']<=s.clock(): raise WebhookError('confirmation_required',status=403)
        if grant['revision']!=endpoint['current_revision'] or grant['control']!=endpoint['control_version']: raise WebhookError('confirmation_stale',status=409)
        revision=grant['params']['toRevision']; changed=[]
        for selected in grant['events']:
            e=await owned_event(s,conn,owner,selected['eventId'])
            if e['route_version']!=selected['version'] or e['route_state'] not in ('pre','eligible','batch','hold'): raise WebhookError('selection_changed',status=409)
            active_job=await one(conn,'SELECT * FROM webhook_stage_jobs WHERE event_id=?',(e['event_id'],))
            if active_job and (active_job['state'] not in ('pending','succeeded') or active_job['state']=='pending' and active_job['execution_fence']): raise WebhookError('stage_already_attempted',status=409)
            await conn.execute("UPDATE webhook_batch_members SET invalidated_at_ms=?,invalidated_reason='rebind' WHERE event_id=? AND invalidated_at_ms IS NULL",(s.clock(),e['event_id']))
            job=await one(conn,'SELECT * FROM webhook_stage_jobs WHERE event_id=?',(e['event_id'],))
            if job and job['state']=='pending': await conn.execute('UPDATE webhook_stage_jobs SET revision=? WHERE job_id=?',(revision,job['job_id']))
            await conn.execute('UPDATE webhook_events SET processing_revision=?,route_state=?,route_version=route_version+1 WHERE event_id=?',(revision,'pre' if job and job['state']=='pending' else 'eligible',e['event_id']))
            changed.append(e['event_id'])
        result={'eventIds':changed,'processingRevision':revision,'unchangedEventIds':[]}; await operation_done(conn,op,result)
    s.confirmations.pop(key,None); s.wake.set(); return result


async def recover_assignment(s,owner,aid,request):
    async with s.db.webhook_transaction() as conn:
        a=await one(conn,'SELECT a.* FROM webhook_assignments a JOIN web_conversations c ON c.conversation_uuid=a.conversation_uuid WHERE a.assignment_id=? AND c.owner_chat_id=?',(aid,owner))
        if not a: raise WebhookError('not_found',status=404)
        if request.get('prepare'):
            check_version(a,request,'row_version')
            if a['recovery_state']!='needs_control' or request.get('decision')!='finalizeInterrupted' or not request.get('reason'): raise WebhookError('invalid_recovery')
            token=secrets.token_urlsafe(32); s.confirmations[digest(token)]={'owner':owner,'action':'recover','assignment':aid,'version':a['row_version'],'params':request,'expiry':s.clock()+300000}
            return {'impact':{'assignmentId':aid,'decision':'finalizeInterrupted','replaysBusiness':False},'confirmationToken':token,'expiresAt':iso(s.clock()+300000)}
        audit={**request,'confirmationToken':digest(request.get('confirmationToken'))}
        old,op=await operation_start(s,conn,owner,audit,'recover',a['origin_endpoint_id'])
        if old: return json.loads(old['result_json'])
        key=digest(request.get('confirmationToken')); grant=s.confirmations.get(key)
        if not grant or grant['owner']!=owner or grant.get('assignment')!=aid or grant['expiry']<=s.clock(): raise WebhookError('confirmation_required',status=403)
        if a['row_version']!=grant['version']: raise WebhookError('confirmation_stale',status=409)
        runs=await many(conn,"SELECT r.run_id FROM runtime_runs r JOIN webhook_runtime_links l USING(run_id) WHERE l.assignment_id=? AND r.status IN ('running','waiting','created')",(aid,))
        if runs: raise WebhookError('runtime_still_active',status=409)
        await candidate(s,aid,abnormal='interrupted')
        result={'assignmentId':aid,'state':'finalized','version':a['row_version']+2}; await operation_done(conn,op,result)
    s.confirmations.pop(key,None); return result
