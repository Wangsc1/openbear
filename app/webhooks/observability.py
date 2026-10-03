"""Framework-only counters and stage spans, separate from business declarations."""
from __future__ import annotations

from app.webhooks.contracts import dumps
from app.webhooks.repository import insert, one, uid


async def count(s,name,*,endpoint_id=None,operation_id=None,labels=None):
    now=s.clock(); operation_id=operation_id or uid(); labels=dumps(labels or {})
    async with s.db.webhook_transaction() as conn:
        if endpoint_id and not await one(conn,'SELECT endpoint_id FROM webhook_endpoints WHERE endpoint_id=?',(endpoint_id,)): endpoint_id=None
        definition=await one(conn,'SELECT definition_id FROM webhook_metric_definitions WHERE endpoint_id IS NULL AND name=?',(name,))
        if not definition:
            did=uid(); await insert(conn,'webhook_metric_definitions',definition_id=did,name=name,source_kind='framework',metric_type='counter',unit='count',max_series=1000000,created_at_ms=now)
        else: did=definition['definition_id']
        series=await one(conn,'SELECT series_id FROM webhook_metric_series WHERE definition_id=? AND endpoint_id IS ? AND labels_json=?',(did,endpoint_id,labels))
        if not series:
            if endpoint_id:
                size=await one(conn,'SELECT COUNT(*) n FROM webhook_metric_series WHERE endpoint_id=?',(endpoint_id,))
                if size['n']>=s.config.telemetry.max_series_per_endpoint:
                    await conn.execute("INSERT OR IGNORE INTO webhook_retention_gaps VALUES(?,'framework_series',?,?)",(endpoint_id,now,now+1))
                    return {'state':'dropped','warning':'series_budget_exceeded:'+name}
            sid=uid(); await insert(conn,'webhook_metric_series',series_id=sid,definition_id=did,endpoint_id=endpoint_id,labels_json=labels,created_at_ms=now)
        else: sid=series['series_id']
        scope='endpoint:'+endpoint_id if endpoint_id else 'system'
        if await one(conn,'SELECT telemetry_id FROM webhook_telemetry_operations WHERE scope_key=? AND operation_id=?',(scope,operation_id)): return
        tid=uid(); await insert(conn,'webhook_telemetry_operations',telemetry_id=tid,scope_key=scope,operation_id=operation_id,endpoint_id=endpoint_id,source='framework',content_sha256=operation_id,state='applied',created_at_ms=now,applied_at_ms=now)
        cur=await insert(conn,'webhook_metric_samples',telemetry_id=tid,item_no=0,series_id=sid,observed_at_ms=now,recorded_at_ms=now,value=1)
        for resolution in (60,3600):
            bucket=now//(resolution*1000)*(resolution*1000)
            await conn.execute('INSERT INTO webhook_metric_rollups(series_id,resolution_seconds,bucket_start_ms,sample_count,sum_value,min_value,max_value,last_value,last_observed_at_ms,last_sample_id,updated_at_ms) VALUES(?,?,?,1,1,1,1,1,?,?,?) ON CONFLICT(series_id,resolution_seconds,bucket_start_ms) DO UPDATE SET sample_count=sample_count+1,sum_value=sum_value+1,last_observed_at_ms=excluded.last_observed_at_ms,last_sample_id=excluded.last_sample_id,updated_at_ms=excluded.updated_at_ms',(sid,resolution,bucket,now,cur.lastrowid,now))


async def recover_unsettled_calls(conn):
    """Startup only: preserve interrupted automatic attempts as unknown usage.

    Runtime's pre-transport action is the evidence, not proof the provider
    charged. No token/price estimate or ordinary-chat aggregate is invented.
    """
    await conn.execute("""INSERT INTO model_calls(attempt_id,chat_id,model,call_kind,
        usage_known,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
        status,model_ok_count,model_fail_count,error_type,created_at)
        SELECT r.action_id,c.internal_chat_id,r.name,'interrupted_webhook_attempt',
            0,NULL,NULL,NULL,NULL,NULL,'unknown',0,0,'process_interrupted',r.created_at
        FROM runtime_actions r JOIN runtime_runs rr USING(run_id)
        JOIN webhook_runtime_links l USING(run_id)
        JOIN webhook_assignments a USING(assignment_id)
        JOIN web_conversations c USING(conversation_uuid)
        WHERE l.billing_scope='origin_webhook' AND r.kind='model' AND r.status='unknown'
        AND rr.status='interrupted'
        AND NOT EXISTS(SELECT 1 FROM model_calls m WHERE m.attempt_id=r.action_id)
        AND NOT EXISTS(SELECT 1 FROM webhook_call_projections p WHERE p.attempt_id=r.action_id)""")


async def ledger_cost(conn,attempt_id,cost,*,known):
    """Keep missing automatic-work billing facts NULL, not a fabricated zero.

    Legacy/manual session aggregates retain their established numeric behavior;
    only the existing physical-call row carries this accounting uncertainty.
    """
    if not known and attempt_id and await one(conn,"SELECT 1 FROM runtime_actions a JOIN webhook_runtime_links l USING(run_id) WHERE a.action_id=? AND l.billing_scope='origin_webhook'",(attempt_id,)):
        return None
    return cost


async def span(s,conn,phase,key,*,start,end=None,level='event',endpoint=None,event=None,batch=None,assignment=None,attempt=None,reason=None):
    await conn.execute('INSERT INTO webhook_phase_spans(span_id,endpoint_id,event_id,batch_id,assignment_id,stage_attempt_id,phase,measurement_level,source_key,started_at_ms,ended_at_ms,end_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET ended_at_ms=COALESCE(webhook_phase_spans.ended_at_ms,excluded.ended_at_ms),end_reason=COALESCE(webhook_phase_spans.end_reason,excluded.end_reason)',(uid(),endpoint,event,batch,assignment,attempt,phase,level,key,start,end,reason))
