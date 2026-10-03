"""Owner-scoped product queries; physical model calls remain the billing ledger."""
from __future__ import annotations

import json
import math
from datetime import datetime

from app.webhooks.contracts import WebhookError, iso
from app.webhooks.repository import many, one


async def usage(s,conn,*,endpoint_id=None,start=0,end=None,owner=None,scope_type=None,scope_id=None,assignment_id=None):
    # Projected rows retain physical call identity after the ordinary session
    # deletion path removes model_calls. Missing historical references are unknown.
    clauses=['m.created_at>=?','m.created_at<?']; args=[start/1000,(end if end is not None else s.clock()+1)/1000]
    for value,column in [(endpoint_id,'a.origin_endpoint_id'),(assignment_id,'a.assignment_id'),(owner,'e.owner_chat_id'),(scope_type,'e.binding_kind'),(scope_id,'e.binding_uuid')]:
        if value is not None and value!='': clauses.append(column+'=?'); args.append(value)
    cte="""WITH billing AS (
        SELECT * FROM webhook_call_projections
        UNION ALL
        SELECT m.id,m.attempt_id,l.assignment_id,m.created_at,m.usage_known,m.input_tokens,m.output_tokens,m.cache_read_tokens,m.cache_write_tokens,m.cost_usd,
          CASE WHEN m.cost_usd IS NULL THEN 'unknown' WHEN json_extract(r.outcome_json,'$.providerCostUsd') IS NOT NULL THEN 'providerReported'
          WHEN json_extract(r.outcome_json,'$.usageKnown')=1 THEN 'estimated' ELSE 'unclassified' END,0
        FROM model_calls m JOIN runtime_actions r ON r.action_id=m.attempt_id JOIN webhook_runtime_links l USING(run_id)
        WHERE l.billing_scope='origin_webhook' AND NOT EXISTS(SELECT 1 FROM webhook_call_projections p WHERE p.model_call_id=m.id)
    ) """
    rows=await many(conn,cte+'SELECT m.* FROM billing m JOIN webhook_assignments a USING(assignment_id) JOIN webhook_endpoints e ON e.endpoint_id=a.origin_endpoint_id WHERE '+' AND '.join(clauses),args)
    missing=await one(conn,"SELECT COUNT(*) n FROM runtime_actions m JOIN webhook_runtime_links l USING(run_id) JOIN webhook_assignments a USING(assignment_id) JOIN webhook_endpoints e ON e.endpoint_id=a.origin_endpoint_id WHERE l.billing_scope='origin_webhook' AND m.kind='model' AND m.status NOT IN ('not_started','started') AND NOT EXISTS(SELECT 1 FROM model_calls c WHERE c.attempt_id=m.action_id) AND NOT EXISTS(SELECT 1 FROM webhook_call_projections c WHERE c.attempt_id=m.action_id) AND "+' AND '.join(clauses),args)
    result=dict(inputTokens=0,outputTokens=0,cacheReadTokens=0,cacheWriteTokens=0,costUsd=0.0,unknownUsageCalls=missing['n'],unknownCostCalls=missing['n'],modelCalls=len(rows)+missing['n'],cacheHitRate=None,
                providerReportedCostUsd=0.0,estimatedCostUsd=0.0,unclassifiedCostUsd=0.0,costSources={'providerReported':0,'estimated':0,'unknown':missing['n'],'unclassified':0},ledgerDeletedCalls=0,missingLedgerCalls=missing['n'],coverage='complete',warnings=[])
    for r in rows:
        if not r['usage_known']: result['unknownUsageCalls']+=1
        for field,col in [('inputTokens','input_tokens'),('outputTokens','output_tokens'),('cacheReadTokens','cache_read_tokens'),('cacheWriteTokens','cache_write_tokens')]: result[field]+=r[col] or 0
        source='unknown' if r['cost_usd'] is None else r['cost_source']
        result['costSources'][source]+=1
        result['ledgerDeletedCalls']+=r['ledger_deleted']
        if r['cost_usd'] is None: result['unknownCostCalls']+=1
        else:
            result['costUsd']+=r['cost_usd']
            result[source+'CostUsd']+=r['cost_usd']
    total=result['inputTokens']+result['cacheReadTokens']+result['cacheWriteTokens']
    result['cacheHitRate']=result['cacheReadTokens']/total if total else None
    if result['ledgerDeletedCalls']: result['coverage']='projected'; result['warnings'].append('original_ledger_deleted')
    if missing['n']: result['coverage']='incomplete'; result['warnings'].append('missing_billing_evidence')
    if result['costSources']['estimated']: result['warnings'].append('estimated_cost')
    if result['costSources']['unclassified']: result['warnings'].append('unclassified_cost_source')
    return result


def event_public(e):
    return dict(eventId=e['event_id'],endpointId=e['endpoint_id'],receiveSeq=e['receive_seq'],receivedRevision=e['received_revision'],processingRevision=e['processing_revision'],receivedAt=iso(e['received_at_ms']),expiresAt=iso(e['expires_at_ms']),state=e['route_state'],reason=e['terminal_reason'],reviewRequired=bool(e['review_required']),version=e['route_version'])


def query_timestamp(value,default):
    if value is None or value=='': return default
    try: return int(value)
    except (TypeError,ValueError):
        try: return int(datetime.fromisoformat(str(value).replace('Z','+00:00')).timestamp()*1000)
        except (TypeError,ValueError,OverflowError): raise WebhookError('invalid_time_range') from None


async def events(s,owner,params):
    clauses=['p.owner_chat_id=?']; args=[owner]
    for key,col in [('endpointId','e.endpoint_id'),('state','e.route_state'),('scopeType','p.binding_kind'),('scopeId','p.binding_uuid')]:
        if params.get(key): clauses.append(col+'=?'); args.append(params[key])
    start=query_timestamp(params.get('start'),0); end=query_timestamp(params.get('end'),s.clock()+1)
    if start<0 or end<=start: raise WebhookError('invalid_time_range')
    clauses.extend(['e.received_at_ms>=?','e.received_at_ms<?']); args.extend([start,end])
    if params.get('cursor'): clauses.append('e.receive_seq>?'); args.append(int(params['cursor']))
    limit=min(100,max(1,int(params.get('limit') or 50)))
    rows=await many(s.db.conn,'SELECT e.* FROM webhook_events e JOIN webhook_endpoints p USING(endpoint_id) WHERE '+' AND '.join(clauses)+' ORDER BY e.receive_seq LIMIT ?',(*args,limit+1))
    return {'items':[event_public(e) for e in rows[:limit]],'nextCursor':str(rows[limit-1]['receive_seq']) if len(rows)>limit else None}


async def detail(s,owner,event_id):
    e=await one(s.db.conn,'SELECT e.* FROM webhook_events e JOIN webhook_endpoints p USING(endpoint_id) WHERE e.event_id=? AND p.owner_chat_id=?',(event_id,owner))
    if not e: raise WebhookError('not_found',status=404)
    result=event_public(e)
    p=await one(s.db.conn,'SELECT * FROM webhook_event_payloads WHERE event_id=?',(event_id,))
    result['payloadStatus']='retained' if p else 'purged'
    if p:
        from app.webhooks.ingress import parse_body
        text=bytes(p['body_bytes']).decode()
        try: body=parse_body(p['content_type'],bytes(p['body_bytes'])); body_error=None
        except WebhookError as exc: body=None; body_error=exc.payload['code']
        result.update(raw={'query':json.loads(p['query_pairs_json']),'body':body,'bodyError':body_error,'content':text,'contentType':p['content_type']},derived=json.loads(p['model_data_json']) if p['model_data_json'] else None,dimensions=json.loads(p['dimensions_json']))
    jobs=await many(s.db.conn,'SELECT * FROM webhook_stage_jobs WHERE event_id=? OR assignment_id IN (SELECT assignment_id FROM webhook_assignment_events WHERE event_id=?) ORDER BY queued_at_ms,job_id',(event_id,event_id))
    result['stages']=[]; result['retryStages']=[]; result['verifyStages']=[]; result['effectState']='none'
    result['canRebind']=e['route_state'] in ('pre','eligible','batch','hold') and not any(j['event_id']==event_id and (j['state'] not in ('pending','succeeded') or j['execution_fence'] and j['state']=='pending') for j in jobs)
    for j in jobs:
        attempts=await many(s.db.conn,'SELECT * FROM webhook_stage_attempts WHERE job_id=? ORDER BY attempt_no',(j['job_id'],))
        stage=dict(jobId=j['job_id'],stage=j['stage'],state=j['state'],revision=j['revision'],version=j['row_version'],actionKey=j['action_key'],queuedAt=iso(j['queued_at_ms']),terminalAt=iso(j['terminal_at_ms']),attempts=[])
        for a in attempts:
            stage['attempts'].append(dict(attemptId=a['attempt_id'],attemptNo=a['attempt_no'],executionFence=a['execution_fence'],state=a['state'],startedAt=iso(a['started_at_ms']),finishedAt=iso(a['finished_at_ms']),exitCode=a['exit_code'],errorClass=a['error_class'],errorSummary=a['error_summary'],sideEffectState=a['side_effect_state'],stderr=a['stderr_text'],stderrTruncated=bool(a['stderr_truncated']),logStatus='purged' if a['log_ref']=='retention:purged' else 'retained',execution=json.loads(a['execution_json']),resultStatus='purged' if json.loads(a['execution_json']).get('resultPurged') else 'retained' if a['result_json'] else 'notReported',result=json.loads(a['result_json']) if a['result_json'] else None))
        if attempts: result['effectState']='reported' if j['state']=='succeeded' else attempts[-1]['side_effect_state']
        if j['state'] in ('failed','unknown','held'):
            result['verifyStages'].append(j['stage'])
            verified=await one(s.db.conn,"SELECT outcome FROM webhook_receipts WHERE event_id=? AND stage_attempt_id=? AND source='administrator' ORDER BY result_version DESC LIMIT 1",(event_id,attempts[-1]['attempt_id'])) if attempts else None
            if not attempts or attempts[-1]['side_effect_state']=='none' or json.loads(j['idempotency_policy_json']).get('idempotencyDeclaration') or verified and verified['outcome']=='failed':
                result['retryStages'].append(j['stage'])
        result['stages'].append(stage)
    assignments=await many(s.db.conn,'SELECT a.*,m.claimed_at_ms,m.delivered_at_ms,m.wait_id FROM webhook_assignment_events m JOIN webhook_assignments a USING(assignment_id) WHERE m.event_id=?',(event_id,))
    result['assignments']=[dict(assignmentId=a['assignment_id'],originKind=a['origin_kind'],conversationId=a['conversation_uuid'],rootTurnId=a['root_turn_uuid'],initialBatchId=a['initial_batch_id'],state=a['state'],recoveryState=a['recovery_state'],version=a['row_version'],repairCount=a['repair_count'],claimedAt=iso(a['claimed_at_ms']),deliveredAt=iso(a['delivered_at_ms']),waitId=a['wait_id'],finalizedAt=iso(a['finalized_at_ms']),terminalReason=a['terminal_reason'],notificationKey=a['notification_key'],processingStatus='purged' if a['final_snapshot_json']=='{"retention":"purged"}' else 'retained') for a in assignments]
    results=await many(s.db.conn,'SELECT * FROM webhook_receipts WHERE event_id=? ORDER BY result_version',(event_id,))
    result['receipts']=[dict(receiptId=r['receipt_id'],eventId=r['event_id'],resultVersion=r['result_version'],assignmentEventId=r['assignment_event_id'],stageAttemptId=r['stage_attempt_id'],source=r['source'],runId=r['runtime_run_id'],actionId=r['runtime_action_id'],outcome=r['outcome'],disposition=r['disposition'],reviewRequired=bool(r['review_required']),summary=r['summary'],reason=r['reason'],evidenceRefs=json.loads(r['evidence_refs_json']),result=json.loads(r['result_json']) if r['result_json'] else None,reportedAt=iso(r['reported_at_ms'])) for r in results]
    if results and results[-1]['source']=='administrator': result['effectState']='unknown' if results[-1]['outcome']=='unknown' else 'confirmed'
    for item,a in zip(result['assignments'],assignments):
        active=await one(s.db.conn,"SELECT 1 FROM webhook_runtime_links l JOIN runtime_runs r USING(run_id) WHERE l.assignment_id=? AND r.status IN ('running','waiting','created')",(a['assignment_id'],))
        n=await one(s.db.conn,'SELECT * FROM web_task_notifications WHERE notification_key=?',(a['notification_key'],))
        item.update(canRecover=a['recovery_state']=='needs_control' and a['state']!='finalized' and not active,notificationState=n['state'] if n else 'notQueued',canRetryNotification=bool(n and n['state']=='paused'),notificationEffectState='enqueued' if n and n['state']=='delivered' else 'unknown' if n and n['state']=='processing' else 'notEnqueued')
        from app.webhooks.notifications import channel_delivery_states
        item['notificationChannels']=await channel_delivery_states(s,a['notification_key']) if a['notification_key'] else []
        item['notificationVerificationRequired']=any(c['verificationRequired'] for c in item['notificationChannels'])
        if item['notificationVerificationRequired']: item['canRetryNotification']=False
        item['runs']=[dict(runId=r['run_id'],relationKind=r['relation_kind'],billingScope=r['billing_scope'],taskId=r['task_uuid']) for r in await many(s.db.conn,'SELECT * FROM webhook_runtime_links WHERE assignment_id=?',(a['assignment_id'],))]
        if a['state']=='finalized' or a['recovery_state']=='needs_control':
            if results and results[-1]['outcome'] not in ('completed','skipped'):
                result['verifyStages'].append('model')
                if a['state']=='finalized' and results[-1]['outcome']=='failed': result['retryStages'].append('model')
    observations=await many(s.db.conn,'SELECT operation_id,source,state,error_reason,created_at_ms,applied_at_ms,revision FROM webhook_telemetry_operations WHERE event_id=? OR assignment_id IN (SELECT assignment_id FROM webhook_assignment_events WHERE event_id=?)',(event_id,event_id))
    result['observations']=[dict(operationId=o['operation_id'],source=o['source'],state=o['state'],revision=o['revision'],errorReason=o['error_reason'],createdAt=iso(o['created_at_ms']),appliedAt=iso(o['applied_at_ms'])) for o in observations]
    # Shared batch/assignment spans appear once, with their actual measurement
    # level. Never copy another member's per-event latency into this event.
    phase_endpoints=sorted({e['endpoint_id'],*(a['origin_endpoint_id'] for a in assignments if a['origin_endpoint_id'])})
    spans=await many(s.db.conn,'SELECT s.* FROM webhook_phase_spans s WHERE s.endpoint_id IN ('+','.join('?' for _ in phase_endpoints)+') AND (s.event_id=? OR (s.event_id IS NULL AND (s.assignment_id IN (SELECT assignment_id FROM webhook_assignment_events WHERE event_id=?) OR s.batch_id IN (SELECT batch_id FROM webhook_batch_members WHERE event_id=?)))) ORDER BY s.started_at_ms,s.span_id',(*phase_endpoints,event_id,event_id,event_id))
    result['phaseSpans']=[dict(spanId=p['span_id'],phase=p['phase'],measurementLevel=p['measurement_level'],endpointId=p['endpoint_id'],eventId=p['event_id'],batchId=p['batch_id'],assignmentId=p['assignment_id'],attemptId=p['stage_attempt_id'],startedAt=iso(p['started_at_ms']),endedAt=iso(p['ended_at_ms']),durationSeconds=(p['ended_at_ms']-p['started_at_ms'])/1000 if p['ended_at_ms'] is not None else None,endReason=p['end_reason'],shared=p['event_id'] is None,source='framework') for p in spans]
    if e['terminal_at_ms'] is not None:
        result['phaseSpans'].append(dict(spanId='end_to_end:'+event_id,phase='end_to_end',measurementLevel='event',endpointId=e['endpoint_id'],eventId=event_id,batchId=None,assignmentId=None,attemptId=None,startedAt=iso(e['received_at_ms']),endedAt=iso(e['terminal_at_ms']),durationSeconds=(e['terminal_at_ms']-e['received_at_ms'])/1000,endReason=e['terminal_reason'],shared=False,source='framework'))
    for a in assignments:
        n=await one(s.db.conn,"SELECT * FROM web_task_notifications WHERE notification_key=? AND state='delivered'",(a['notification_key'],))
        if n:
            result['phaseSpans'].append(dict(spanId='delivery:'+a['assignment_id'],phase='delivery',measurementLevel='assignment',endpointId=a['origin_endpoint_id'],eventId=None,batchId=None,assignmentId=a['assignment_id'],attemptId=None,startedAt=iso(n['created_at']*1000),endedAt=iso(n['delivered_at']*1000),durationSeconds=max(0,n['delivered_at']-n['created_at']),endReason='notification_adapter_delivered',shared=True,source='framework'))
    result['verifyStages']=list(dict.fromkeys(result['verifyStages']))
    candidates=await many(s.db.conn,'SELECT * FROM webhook_wait_candidates WHERE event_id=?',(event_id,))
    result['waitCandidates']=[dict(waitId=w['wait_id'],detectedAt=iso(w['detected_at_ms']),resolvedAt=iso(w['resolved_at_ms']),resolution=w['resolution']) for w in candidates]
    return {'event':result}


async def wait_list(s,owner,params):
    from app.webhooks.waits import public
    clauses=['e.owner_chat_id=?']; args=[owner]
    status=params.get('effectiveStatus') or ''
    if status not in ('','receiving','globalDisabled','disabled','paused','deleted','needs_review'): raise WebhookError('invalid_effective_status')
    if params.get('scopeType') not in (None,'','folder','conversation'): raise WebhookError('invalid_scope')
    if status!='deleted': clauses.append('e.deleted_at_ms IS NULL')
    for key,col in [('endpointId','w.endpoint_id'),('assignmentId','w.assignment_id'),('scopeType','e.binding_kind'),('scopeId','e.binding_uuid')]:
        if params.get(key): clauses.append(col+'=?'); args.append(params[key])
    if 'active' in params:
        active=str(params['active']).lower()
        if active not in ('true','false'): raise WebhookError('invalid_active')
        clauses.append("w.state "+('IN' if active=='true' else 'NOT IN')+" ('registered','collecting','sealed')")
    if params.get('eventId'):
        clauses.append('(EXISTS (SELECT 1 FROM webhook_assignment_events m WHERE m.wait_id=w.wait_id AND m.event_id=?) OR EXISTS (SELECT 1 FROM webhook_wait_candidates c WHERE c.wait_id=w.wait_id AND c.event_id=?))'); args.extend([params['eventId'],params['eventId']])
    cursor=params.get('cursor') or ''; limit=min(100,max(1,int(params.get('limit') or 50)))
    search=str(params.get('search') or '').strip().casefold(); rows=[]; public_cache={}
    while len(rows)<=limit:
        page=await many(s.db.conn,'SELECT w.* FROM webhook_waits w JOIN webhook_endpoints e USING(endpoint_id) WHERE '+' AND '.join(clauses)+' AND w.wait_id>? ORDER BY w.wait_id LIMIT 100',(*args,cursor))
        if not page: break
        for w in page:
            cursor=w['wait_id']; eid=w['endpoint_id']
            if search or status:
                if eid not in public_cache: public_cache[eid]=await s.public(s.db.conn,eid,owner)
                endpoint=public_cache[eid]
                if search and not any(search in str(endpoint[k]).casefold() for k in ('id','name','description')): continue
                if status=='needs_review':
                    if not any(r=='review' or r.startswith('review:') for r in endpoint['pauseReasons']): continue
                elif status and endpoint['effectiveStatus']!=status: continue
            rows.append(w)
            if len(rows)>limit: break
        if len(page)<100: break
    result=[]
    for w in rows[:limit]:
        item=public(w); item['canCancel']=w['state'] in ('registered','collecting','sealed'); members=await many(s.db.conn,'SELECT event_id,delivered_at_ms FROM webhook_assignment_events WHERE wait_id=?',(w['wait_id'],))
        item.update(claimed=[m['event_id'] for m in members],delivered=[m['event_id'] for m in members if m['delivered_at_ms'] is not None]); result.append(item)
    return {'items':result,'nextCursor':rows[limit-1]['wait_id'] if len(rows)>limit else None}


async def targets(s,owner,params):
    from app.web_console.conversation_tree import WebAdminConversationTreeMixin as Tree

    scope_type=params.get('scopeType') or ('folder' if params.get('scopeId') else '')
    scope_id=str(params.get('scopeId') or '').strip()
    if scope_type not in ('','folder','conversation') or scope_type and not scope_id:
        raise WebhookError('invalid_scope')
    # Same pin/manual-order/fallback rules as conversation_tree.children and
    # _tree_direct_folder_nodes. Names/UUIDs are not an alternate sort mode.
    order=""" ORDER BY CASE WHEN COALESCE(pinned_at,0)>0 THEN 0 ELSE 1 END,
        CASE WHEN display_order IS NULL THEN 1 ELSE 0 END,
        display_order ASC,COALESCE(created_at,0) DESC,id DESC"""
    folders=await many(s.db.conn,'SELECT * FROM web_conversation_folders WHERE owner_chat_id=?'+order,(owner,))
    mapped={f['folder_uuid']:f for f in folders}
    children={}
    for f in folders: children.setdefault(f['parent_uuid'] or '',[]).append(f['folder_uuid'])
    folder_ids=[]; seen=set()
    roots=[scope_id] if scope_type=='folder' else children.get('',[])
    if scope_type=='folder' and scope_id not in mapped: raise WebhookError('not_found',status=404)
    stack=list(reversed(roots))
    while stack:
        fid=stack.pop()
        if fid in seen: continue
        seen.add(fid); folder_ids.append(fid); stack.extend(reversed(children.get(fid,[])))
    clause=' AND conversation_uuid=?' if scope_type=='conversation' else ''
    conv=await many(s.db.conn,'SELECT * FROM web_conversations WHERE owner_chat_id=? AND COALESCE(archived_at,0)=0'+clause+order,(owner,scope_id) if clause else (owner,))
    if scope_type=='folder': conv=[c for c in conv if c['folder_uuid'] in seen]
    if scope_type=='conversation' and not conv: raise WebhookError('not_found',status=404)
    search=str(params.get('search') or '').strip().casefold(); selected=params.get('selectedId')
    def path(fid): return Tree._tree_folder_path_text(fid,mapped)
    chosen=[c for c in conv if scope_type=='conversation' or not search or c['conversation_uuid']==selected or search in c['title'].casefold() or search in path(c['folder_uuid']).casefold()]
    def conversation(c):
        folder_path=path(c['folder_uuid'])
        return dict(id=c['conversation_uuid'],type='conversation',name=c['title'],title=c['title'],path=folder_path+' / '+c['title'] if folder_path else c['title'],parentId='' if scope_type=='conversation' else c['folder_uuid'] or '',selectable=True,available=True)
    if scope_type=='conversation': return {'items':[conversation(c) for c in chosen],'nextCursor':None}
    visible=set(folder_ids) if not search else {fid for fid in folder_ids if search in path(fid).casefold()}
    for fid in [*(c['folder_uuid'] for c in chosen),*list(visible)]:
        visible.update(parent for parent in Tree._tree_folder_path(fid,mapped) if parent in seen)
    grouped={}
    for c in chosen: grouped.setdefault(c['folder_uuid'] or '',[]).append(c)
    # Flatten in displayed tree order: child folders (with their descendants)
    # precede sibling conversations, exactly as the ordinary lazy tree does.
    items=[]; stack=[('folder',fid) for fid in reversed(roots)]
    if not scope_type: stack=[('conversation',c) for c in reversed(grouped.get('',[]))]+stack
    visited=set()
    while stack:
        kind,value=stack.pop()
        if kind=='conversation': items.append(conversation(value)); continue
        fid=value
        if fid not in visible or fid in visited: continue
        visited.add(fid); f=mapped[fid]
        items.append(dict(id=fid,type='folder',name=f['name'],title=f['name'],path=path(fid),parentId='' if fid==scope_id else f['parent_uuid'] or '',selectable=False,available=True))
        stack.extend(('conversation',c) for c in reversed(grouped.get(fid,[])))
        stack.extend(('folder',child) for child in reversed(children.get(fid,[])))
    return {'items':items,'nextCursor':None}


async def statistics(s,owner,params):
    eid=params.get('endpointId')
    if eid: await s.endpoint_row(s.db.conn,eid,owner,deleted=True)
    start=query_timestamp(params.get('start'),0); end=query_timestamp(params.get('end'),s.clock()+1); view=params.get('view','overview')
    if params.get('scopeType') not in (None,'','folder','conversation'): raise WebhookError('invalid_scope')
    if start<0 or end<=start: raise WebhookError('invalid_time_range')
    endpoint_where='p.owner_chat_id=?'+(' AND p.endpoint_id=?' if eid else ''); endpoint_args=[owner]+([eid] if eid else [])
    for key,col in [('scopeType','p.binding_kind'),('scopeId','p.binding_uuid')]:
        if params.get(key): endpoint_where+=' AND '+col+'=?'; endpoint_args.append(params[key])
    endpoints=await many(s.db.conn,'SELECT p.endpoint_id,p.binding_kind,p.binding_uuid,r.config_json FROM webhook_endpoints p JOIN webhook_revisions r ON r.endpoint_id=p.endpoint_id AND r.revision=p.current_revision WHERE '+endpoint_where+' ORDER BY p.endpoint_id',endpoint_args)
    scopes={e['endpoint_id']:{'type':e['binding_kind'],'id':e['binding_uuid']} for e in endpoints}
    declarations={}
    for endpoint in endpoints:
        for field in json.loads(endpoint['config_json']).get('statistics',{}).get('businessFields',[]):
            if field.get('queryable',True): declarations.setdefault(field['name'],[]).append((endpoint['endpoint_id'],field))
    fields={}; conflicts={}
    for name,entries in declarations.items():
        signatures={(f.get('valueType','string'),f.get('path')) for _,f in entries}
        if len(signatures)>1: conflicts[name]=[e for e,_ in entries]
        else: fields[name]={'name':name,'valueType':entries[0][1].get('valueType','string'),'endpointIds':[e for e,_ in entries]}
    result={'view':view,'range':{'start':start,'end':end,'coverageStart':start,'resolutionSeconds':None},'warnings':[],
            'queryableFields':[fields[k] for k in sorted(fields)],'fieldConflicts':[{'name':k,'endpointIds':v} for k,v in sorted(conflicts.items())]}
    from app.webhooks.retention import coverage
    gap_kinds=['samples','rollups','framework_series','legacy_unknown'] if view in ('metrics','overview') else ['business','legacy_unknown'] if view in ('business','ranking') else []
    gaps=await coverage(s.db.conn,list(scopes),start,end,gap_kinds)
    result['range'].update(coverageStatus='partial' if gaps else 'complete',gaps=gaps)
    if gaps:
        coverage_start=max(g['end'] for g in gaps)
        result['range']['coverageStart']=coverage_start if coverage_start<end else None
        if all(any(g['endpointId']==endpoint and g['start']<=start and g['end']>=end and g['kind']!='samples' for g in gaps) for endpoint in scopes): result['range']['coverageStatus']='unavailable'
        result['warnings'].extend(sorted({'retention_gap:'+g['kind'] for g in gaps}))
    if conflicts: result['warnings'].append('incompatible_business_fields: select an endpoint for conflicting names')
    def query_field(name):
        if name in conflicts: raise WebhookError('ambiguous_business_field',details={'name':name,'endpointIds':conflicts[name]})
        if name not in fields: raise WebhookError('field_not_queryable',details={'name':name})
        return fields[name]
    if view=='metrics':
        from app.webhooks.telemetry import metric_query
        result['metrics']=[]
        for endpoint in endpoints:
            endpoint_id=endpoint['endpoint_id']
            result['metrics'].extend({**m,'endpointId':endpoint_id,'scope':scopes[endpoint_id]} for m in await metric_query(s,endpoint_id,start,end))
        return result
    clauses=['p.owner_chat_id=?','e.received_at_ms>=?','e.received_at_ms<?']; args=[owner,start,end]
    if eid: clauses.append('e.endpoint_id=?'); args.append(eid)
    for key,col in [('scopeType','p.binding_kind'),('scopeId','p.binding_uuid')]:
        if params.get(key): clauses.append(col+'=?'); args.append(params[key])
    where=' AND '.join(clauses)
    if view=='overview':
        counts=await many(s.db.conn,'SELECT e.route_state,COUNT(*) n,MIN(e.received_at_ms) oldest FROM webhook_events e JOIN webhook_endpoints p USING(endpoint_id) WHERE '+where+' GROUP BY e.route_state',args)
        accepted=sum(r['n'] for r in counts); queue={r['route_state']:r['n'] for r in counts if r['route_state']!='terminal'}
        usage_result=await usage(s,s.db.conn,endpoint_id=eid,start=start,end=end,owner=owner,scope_type=params.get('scopeType'),scope_id=params.get('scopeId'))
        result['warnings'].extend(usage_result['warnings'])
        query='SELECT t.state,COUNT(*) n FROM webhook_stage_attempts t JOIN webhook_stage_jobs j USING(job_id) JOIN webhook_events e ON e.event_id=j.event_id JOIN webhook_endpoints p ON p.endpoint_id=e.endpoint_id WHERE '+where+' GROUP BY t.state'
        attempts=await many(s.db.conn,query,args)
        active=await one(s.db.conn,'SELECT COUNT(*) n FROM webhook_endpoints p WHERE '+endpoint_where+' AND enabled=1 AND deleted_at_ms IS NULL',endpoint_args)
        pending=await one(s.db.conn,'SELECT COUNT(*) n,COALESCE(SUM(review_required),0) review FROM webhook_events e JOIN webhook_endpoints p USING(endpoint_id) WHERE '+endpoint_where+' AND (e.terminal_at_ms IS NULL OR e.review_required=1)',endpoint_args)
        from app.webhooks.telemetry import metric_query
        counters={}; http_warnings=[]
        for endpoint in endpoints:
            for metric in await metric_query(s,endpoint['endpoint_id'],start,end,name='webhook_http_requests'):
                if metric['name']!='webhook_http_requests': continue
                outcome=metric['labels'].get('outcome')
                counters[outcome]=counters.get(outcome,0)+(metric['sum'] or 0)
                http_warnings.extend(metric['warnings'])
        result['warnings'].extend(w for w in sorted(set(http_warnings)) if w not in result['warnings'])
        pre=await many(s.db.conn,'SELECT e.terminal_reason,COUNT(*) n FROM webhook_events e JOIN webhook_endpoints p USING(endpoint_id) WHERE '+where+' AND e.pre_completed_at_ms IS NOT NULL GROUP BY e.terminal_reason',args)
        pre_counts={r['terminal_reason']:r['n'] for r in pre}
        model_events=await one(s.db.conn,'SELECT COUNT(DISTINCT e.event_id) n FROM webhook_events e JOIN webhook_endpoints p USING(endpoint_id) JOIN webhook_assignment_events m USING(event_id) WHERE '+where,args)
        batches=await one(s.db.conn,"SELECT COUNT(*) n FROM webhook_assignments a JOIN webhook_endpoints p ON p.endpoint_id=a.origin_endpoint_id WHERE "+endpoint_where+' AND a.created_at_ms>=? AND a.created_at_ms<?',(*endpoint_args,start,end))
        post=await one(s.db.conn,"SELECT COUNT(*) n FROM webhook_stage_attempts t JOIN webhook_stage_jobs j USING(job_id) JOIN webhook_endpoints p ON p.endpoint_id=j.endpoint_id WHERE "+endpoint_where+" AND j.stage='post' AND t.reserved_at_ms>=? AND t.reserved_at_ms<?",(*endpoint_args,start,end))
        result['overview']={'activeEndpoints':active['n'] if s.config.enabled else 0,'pendingEvents':pending['n'],'needsReview':pending['review'],'requests':sum(counters.values()),'rejected':counters.get('rejected',0),'duplicates':counters.get('duplicate',0),'accepted':accepted,'queue':queue,'preAttempts':sum(r['n'] for r in attempts),'preContinue':sum(pre_counts.values())-pre_counts.get('completed',0)-pre_counts.get('skipped',0),'preHandled':pre_counts.get('completed',0),'preIgnored':pre_counts.get('skipped',0),'modelEvents':model_events['n'],'modelBatches':batches['n'],'postAttempts':post['n'],'usage':usage_result,'modelCalls':usage_result['modelCalls'],
                            'oldestPendingAt':iso(min((r['oldest'] for r in counts if r['route_state']!='terminal'),default=None))}
    elif view=='phases':
        rows=await many(s.db.conn,'SELECT s.* FROM webhook_phase_spans s JOIN webhook_endpoints p USING(endpoint_id) WHERE '+endpoint_where+' AND ended_at_ms IS NOT NULL',endpoint_args)
        groups={}; merged={}
        for r in rows:
            if r['phase'] in ('end_to_end','delivery'): continue  # derived below from authoritative lifecycle times
            if r['phase']=='model_tool' and r['assignment_id']:
                merged.setdefault(r['assignment_id'],[]).append(r)
            elif start<=r['started_at_ms']<end:
                groups.setdefault((r['phase'],r['measurement_level']),[]).append((r['ended_at_ms']-r['started_at_ms'])/1000)
        for parts in merged.values():
            parts.sort(key=lambda r:r['started_at_ms'])
            if not start<=parts[0]['started_at_ms']<end: continue
            # One assignment is one sample. Merge overlapping execution slices,
            # but never include the intervening human/external wait wall time.
            intervals=[]
            for r in parts:
                lo,hi=r['started_at_ms'],r['ended_at_ms']
                if intervals and lo<=intervals[-1][1]: intervals[-1][1]=max(intervals[-1][1],hi)
                else: intervals.append([lo,hi])
            groups.setdefault(('model_tool','assignment'),[]).append(sum(hi-lo for lo,hi in intervals)/1000)
        for row in await many(s.db.conn,'SELECT e.received_at_ms,e.terminal_at_ms FROM webhook_events e JOIN webhook_endpoints p USING(endpoint_id) WHERE '+endpoint_where+' AND e.received_at_ms>=? AND e.received_at_ms<? AND e.terminal_at_ms IS NOT NULL',(*endpoint_args,start,end)):
            groups.setdefault(('end_to_end','event'),[]).append((row['terminal_at_ms']-row['received_at_ms'])/1000)
        for row in await many(s.db.conn,"SELECT a.assignment_id,n.created_at,n.delivered_at FROM webhook_assignments a JOIN webhook_endpoints p ON p.endpoint_id=a.origin_endpoint_id JOIN web_task_notifications n ON n.notification_key=a.notification_key WHERE "+endpoint_where+" AND n.state='delivered' AND n.created_at*1000>=? AND n.created_at*1000<?",(*endpoint_args,start,end)):
            groups.setdefault(('delivery','assignment'),[]).append(max(0,row['delivered_at']-row['created_at']))
        result['phases']=[]
        for (phase,level),values in groups.items():
            values.sort(); n=len(values)
            result['phases'].append(dict(phase=phase,label=phase,measurementLevel=level,count=n,averageSeconds=sum(values)/n,p50Seconds=values[math.ceil(n*.5)-1],p95Seconds=values[math.ceil(n*.95)-1],maxSeconds=values[-1],precision='raw'))
    elif view in ('business','ranking'):
        limit=min(100,max(1,int(params.get('limit') or 50)))
        if view=='ranking':
            field=params.get('field')
            if not field: return {**result,'items':[],'nextCursor':None}
            definition=query_field(field); kind=definition['valueType']; column='value_text' if kind=='string' else 'value_number'
            offset=max(0,int(params.get('cursor') or 0)); selected=definition['endpointIds']; placeholders=','.join('?' for _ in selected)
            # SQLite's partial-index implication rules need the numeric union
            # explicitly, even when the bound type is only number or boolean.
            type_predicate="value_type='null'" if kind=='null' else "value_type='string'" if kind=='string' else "value_type IN ('number','boolean')"
            rows=await many(s.db.conn,'SELECT '+column+' value,COUNT(*) count,json_group_array(DISTINCT endpoint_id) endpoints FROM webhook_business_fields WHERE endpoint_id IN ('+placeholders+') AND field_name=? AND '+type_predicate+' AND value_type=? AND observed_at_ms>=? AND observed_at_ms<? GROUP BY '+column+' ORDER BY count DESC,'+column+' LIMIT ? OFFSET ?',(*selected,field,kind,start,end,limit+1,offset))
            result['items']=[{'value':bool(r['value']) if kind=='boolean' else r['value'],'valueType':kind,'count':r['count'],'endpointIds':json.loads(r['endpoints'])} for r in rows[:limit]]
            result['nextCursor']=str(offset+limit) if len(rows)>limit else None
        else:
            clauses=[endpoint_where,'r.observed_at_ms>=?','r.observed_at_ms<?']; values=[*endpoint_args,start,end]
            try: filters=json.loads(params.get('filters') or '{}')
            except (TypeError,ValueError): raise WebhookError('invalid_business_filter') from None
            if not isinstance(filters,dict): raise WebhookError('invalid_business_filter')
            for key,value in filters.items():
                definition=query_field(key); kind=definition['valueType']
                valid=value is None if kind=='null' else isinstance(value,str) if kind=='string' else type(value) is bool if kind=='boolean' else type(value) in (int,float) and math.isfinite(value)
                if not valid: raise WebhookError('business_filter_type',details={'name':key,'valueType':kind})
                column='value_text' if kind=='string' else 'value_number'; selected=definition['endpointIds']
                # Select matching record IDs through the declared-field indexes;
                # a correlated EXISTS otherwise probes every business record.
                type_predicate="f.value_type='null'" if kind=='null' else "f.value_type='string'" if kind=='string' else "f.value_type IN ('number','boolean')"
                clauses.append('r.record_id IN (SELECT f.record_id FROM webhook_business_fields f WHERE f.endpoint_id IN ('+','.join('?' for _ in selected)+') AND f.field_name=? AND '+type_predicate+' AND f.value_type=? AND f.'+column+' IS ? AND f.observed_at_ms>=? AND f.observed_at_ms<?)')
                values.extend([*selected,key,kind,value,start,end])
            if params.get('cursor'):
                at,record=json.loads(params['cursor']); clauses.append('(r.observed_at_ms,r.record_id)>(?,?)'); values.extend([at,record])
            rows=await many(s.db.conn,'SELECT r.*,o.source,o.revision FROM webhook_business_records r JOIN webhook_telemetry_operations o USING(telemetry_id) JOIN webhook_endpoints p ON p.endpoint_id=r.endpoint_id WHERE '+' AND '.join(clauses)+' ORDER BY r.observed_at_ms,r.record_id LIMIT ?',(*values,limit+1))
            result['items']=[dict(recordId=r['record_id'],endpointId=r['endpoint_id'],scope=scopes[r['endpoint_id']],operationSource=r['source'],source=r['source'],revision=r['revision'],event=r['record_type'],observedAt=iso(r['observed_at_ms']),fields=json.loads(r['fields_json']),evidenceRefs=json.loads(r['evidence_refs_json'])) for r in rows[:limit]]
            result['nextCursor']=json.dumps([rows[limit-1]['observed_at_ms'],rows[limit-1]['record_id']]) if len(rows)>limit else None
    else: raise WebhookError('invalid_statistics_view')
    return result
