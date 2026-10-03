"""Layered retention with one shared protection closure; identity facts survive."""
from __future__ import annotations

import json
from app.webhooks.contracts import dumps
from app.webhooks.repository import many, one

# Protection is independent of the particular storage layer. A review on an
# event also protects its attempts and observations, including assignment-only
# post telemetry. Never infer eligibility merely from an attempt's exit code.
_PROTECTED = """WITH RECURSIVE protected_events(event_id) AS (
    SELECT event_id FROM webhook_events WHERE terminal_at_ms IS NULL OR review_required=1
    UNION SELECT event_id FROM webhook_receipts WHERE review_required=1 OR outcome='unknown' OR evidence_refs_json!='[]'
    UNION SELECT event_id FROM webhook_stage_jobs WHERE event_id IS NOT NULL AND state NOT IN ('succeeded','cancelled')
    UNION SELECT event_id FROM webhook_wait_candidates WHERE resolved_at_ms IS NULL
    UNION SELECT m.event_id FROM webhook_assignment_events m JOIN webhook_assignments a USING(assignment_id)
      WHERE a.state!='finalized' OR a.recovery_state!='healthy' OR (a.origin_kind='webhook' AND a.notification_key IS NULL)
      OR EXISTS(SELECT 1 FROM webhook_waits w WHERE w.assignment_id=a.assignment_id AND w.state IN ('registered','collecting','sealed'))
      OR EXISTS(SELECT 1 FROM webhook_stage_jobs j WHERE j.assignment_id=a.assignment_id AND j.state NOT IN ('succeeded','cancelled'))
      OR EXISTS(SELECT 1 FROM web_task_notifications n WHERE n.notification_key=a.notification_key AND n.state NOT IN ('delivered','suppressed'))
    UNION SELECT e.event_id FROM webhook_events e JOIN webhook_telemetry_operations t ON t.event_id=e.event_id
      WHERE t.state!='applied' OR EXISTS(SELECT 1 FROM webhook_business_records b WHERE b.telemetry_id=t.telemetry_id AND b.evidence_refs_json!='[]')
    UNION SELECT m.event_id FROM webhook_assignment_events m JOIN webhook_telemetry_operations t USING(assignment_id)
      WHERE t.state!='applied' OR EXISTS(SELECT 1 FROM webhook_business_records b WHERE b.telemetry_id=t.telemetry_id AND b.evidence_refs_json!='[]')
    UNION SELECT m.event_id FROM webhook_assignment_events m JOIN webhook_assignment_events other USING(assignment_id)
      JOIN protected_events p ON p.event_id=other.event_id
), protected_assignments AS (
    SELECT DISTINCT assignment_id FROM webhook_assignment_events WHERE event_id IN (SELECT event_id FROM protected_events)
), protected_jobs AS (
    SELECT job_id FROM webhook_stage_jobs WHERE event_id IN (SELECT event_id FROM protected_events)
       OR assignment_id IN (SELECT assignment_id FROM protected_assignments) OR state NOT IN ('succeeded','cancelled')
), protected_telemetry AS (
    SELECT telemetry_id FROM webhook_telemetry_operations WHERE state!='applied'
       OR event_id IN (SELECT event_id FROM protected_events)
       OR assignment_id IN (SELECT assignment_id FROM protected_assignments)
       OR stage_attempt_id IN (SELECT attempt_id FROM webhook_stage_attempts WHERE job_id IN (SELECT job_id FROM protected_jobs))
       OR telemetry_id IN (SELECT telemetry_id FROM webhook_business_records WHERE evidence_refs_json!='[]')
) """


async def prune(s):
    r=s.config.retention; now=s.clock(); removed={'payloads':0,'logs':0,'samples':0,'businessRecords':0,'rollups':0,'processing':0}
    async with s.db.webhook_transaction() as conn:
        if r.payload_days is not None:
            eligible=await many(conn,_PROTECTED+"SELECT event_id FROM webhook_events WHERE terminal_at_ms<? AND event_id IN (SELECT event_id FROM webhook_event_payloads) AND event_id NOT IN (SELECT event_id FROM protected_events) LIMIT 1000",(now-r.payload_days*86400000,))
            for e in eligible:
                cur=await conn.execute('DELETE FROM webhook_event_payloads WHERE event_id=?',(e['event_id'],)); removed['payloads']+=cur.rowcount
            # Final/post/wait snapshots may contain duplicate ingress material.
            # Once the payload is eligible, keep the identity rather than a hidden
            # raw copy that would contradict payloadStatus=purged.
            for a in await many(conn,_PROTECTED+"SELECT * FROM webhook_assignments a WHERE state='finalized' AND finalized_at_ms<? AND assignment_id NOT IN (SELECT assignment_id FROM protected_assignments) AND EXISTS(SELECT 1 FROM json_each(a.final_snapshot_json,'$.materials') m WHERE json_extract(m.value,'$.payloadStatus') IS NULL) LIMIT 1000",(now-r.payload_days*86400000,)):
                snapshot=json.loads(a['final_snapshot_json'])
                changed=False
                for i,m in enumerate(snapshot.get('materials',[])):
                    if m.get('payloadStatus')!='purged' and await _payload_gone(conn,m.get('eventId')):
                        snapshot['materials'][i]={'eventId':m['eventId'],'payloadStatus':'purged'}; changed=True
                if changed:
                    await conn.execute('UPDATE webhook_assignments SET final_snapshot_json=? WHERE assignment_id=?',(dumps(snapshot),a['assignment_id']))
                    await conn.execute("UPDATE webhook_stage_jobs SET execution_input_json=? WHERE assignment_id=? AND state IN ('succeeded','cancelled')",(dumps(snapshot),a['assignment_id']))
            # Wait copies have their own lifetime. Do not gate this on the
            # final snapshot still containing materials (processing may purge first).
            waits=await many(conn,_PROTECTED+"SELECT w.wait_id,w.delivery_json FROM webhook_waits w JOIN webhook_assignments a USING(assignment_id) WHERE a.state='finalized' AND w.delivery_json IS NOT NULL AND a.assignment_id NOT IN (SELECT assignment_id FROM protected_assignments)")
            for w in waits:
                data=json.loads(w['delivery_json']); changed=False
                for i,m in enumerate(data.get('events',[])):
                    if m.get('payloadStatus')!='purged' and await _payload_gone(conn,m.get('eventId')):
                        data['events'][i]={'eventId':m['eventId'],'payloadStatus':'purged'}; changed=True
                if changed: await conn.execute('UPDATE webhook_waits SET delivery_json=? WHERE wait_id=?',(dumps(data),w['wait_id']))
        if r.script_log_days is not None:
            ids=await many(conn,_PROTECTED+"SELECT attempt_id FROM webhook_stage_attempts WHERE finished_at_ms<? AND state='succeeded' AND stderr_text!='' AND job_id NOT IN (SELECT job_id FROM protected_jobs)",(now-r.script_log_days*86400000,))
            for a in ids:
                await conn.execute("UPDATE webhook_stage_attempts SET stderr_text='',stderr_truncated=1,log_ref='retention:purged' WHERE attempt_id=?",(a['attempt_id'],)); removed['logs']+=1
        if r.processing_days is not None:
            threshold=now-r.processing_days*86400000
            jobs=await many(conn,_PROTECTED+"SELECT job_id FROM webhook_stage_jobs WHERE terminal_at_ms<? AND job_id NOT IN (SELECT job_id FROM protected_jobs)",(threshold,))
            for j in jobs:
                cur=await conn.execute("UPDATE webhook_stage_attempts SET result_json=NULL,execution_json=json_set(execution_json,'$.resultPurged',json('true')) WHERE job_id=? AND result_json IS NOT NULL",(j['job_id'],)); removed['processing']+=cur.rowcount
                await conn.execute("UPDATE webhook_stage_jobs SET execution_input_json=NULL WHERE job_id=?",(j['job_id'],))
            assignments=await many(conn,_PROTECTED+"SELECT assignment_id FROM webhook_assignments WHERE finalized_at_ms<? AND assignment_id NOT IN (SELECT assignment_id FROM protected_assignments) AND final_snapshot_json!='{\"retention\":\"purged\"}'",(threshold,))
            for a in assignments:
                await conn.execute("UPDATE webhook_assignments SET final_snapshot_json=? WHERE assignment_id=?",(dumps({'retention':'purged'}),a['assignment_id'])); removed['processing']+=1
            # Receipts/ownership/time spans remain compact immutable provenance;
            # do not erase declarations or billing/latency history to save space.
        sample_predicate="""m.recorded_at_ms<? AND m.telemetry_id NOT IN (SELECT telemetry_id FROM protected_telemetry)
            AND EXISTS(SELECT 1 FROM webhook_metric_rollups r WHERE r.series_id=m.series_id AND r.resolution_seconds=3600 AND r.bucket_start_ms=(m.observed_at_ms/3600000)*3600000)"""
        sample_args=(now-r.metric_sample_days*86400000,)
        await conn.execute(_PROTECTED+"INSERT OR IGNORE INTO webhook_retention_gaps SELECT se.endpoint_id,'samples',MIN(m.observed_at_ms),MAX(m.observed_at_ms)+1 FROM webhook_metric_samples m JOIN webhook_metric_series se USING(series_id) WHERE se.endpoint_id IS NOT NULL AND "+sample_predicate+' GROUP BY se.endpoint_id',sample_args)
        await conn.execute(_PROTECTED+'DELETE FROM webhook_metric_samples AS m WHERE '+sample_predicate,sample_args)
        removed['samples']=(await one(conn,'SELECT changes() n'))['n']
        rollup_predicate="""r.bucket_start_ms<? AND NOT EXISTS(SELECT 1 FROM webhook_metric_samples m WHERE m.series_id=r.series_id AND m.telemetry_id IN (SELECT telemetry_id FROM protected_telemetry)
              AND m.observed_at_ms>=r.bucket_start_ms AND m.observed_at_ms<r.bucket_start_ms+r.resolution_seconds*1000)"""
        rollup_args=(now-r.metric_rollup_days*86400000,)
        await conn.execute(_PROTECTED+"INSERT OR IGNORE INTO webhook_retention_gaps SELECT se.endpoint_id,'rollups',MIN(r.bucket_start_ms),MAX(r.bucket_start_ms+r.resolution_seconds*1000) FROM webhook_metric_rollups r JOIN webhook_metric_series se USING(series_id) WHERE se.endpoint_id IS NOT NULL AND "+rollup_predicate+' GROUP BY se.endpoint_id',rollup_args)
        await conn.execute(_PROTECTED+'DELETE FROM webhook_metric_rollups AS r WHERE '+rollup_predicate,rollup_args)
        removed['rollups']=(await one(conn,'SELECT changes() n'))['n']
        if r.business_record_days is not None:
            records=await many(conn,_PROTECTED+"SELECT record_id,endpoint_id,observed_at_ms FROM webhook_business_records WHERE observed_at_ms<? AND telemetry_id NOT IN (SELECT telemetry_id FROM protected_telemetry) LIMIT 1000",(now-r.business_record_days*86400000,))
            for b in records:
                await conn.execute("INSERT OR IGNORE INTO webhook_retention_gaps VALUES(?,'business',?,?)",(b['endpoint_id'],b['observed_at_ms'],b['observed_at_ms']+1))
                await conn.execute('DELETE FROM webhook_business_fields WHERE record_id=?',(b['record_id'],))
                await conn.execute('DELETE FROM webhook_business_records WHERE record_id=?',(b['record_id'],)); removed['businessRecords']+=1
        await conn.execute(_PROTECTED+"""UPDATE webhook_telemetry_operations SET payload_json=NULL WHERE created_at_ms<?
            AND telemetry_id NOT IN (SELECT telemetry_id FROM protected_telemetry)
            AND NOT EXISTS(SELECT 1 FROM webhook_metric_samples m WHERE m.telemetry_id=webhook_telemetry_operations.telemetry_id)
            AND NOT EXISTS(SELECT 1 FROM webhook_business_records b WHERE b.telemetry_id=webhook_telemetry_operations.telemetry_id)""",(now-r.metric_rollup_days*86400000,))
    return removed


async def _payload_gone(conn,event_id):
    from app.webhooks.repository import one
    return event_id and not await one(conn,'SELECT 1 FROM webhook_event_payloads WHERE event_id=?',(event_id,))


async def coverage(conn,endpoint_ids,start,end,kinds):
    if not endpoint_ids or not kinds: return []
    rows=await many(conn,'SELECT * FROM webhook_retention_gaps WHERE endpoint_id IN ('+','.join('?' for _ in endpoint_ids)+') AND kind IN ('+','.join('?' for _ in kinds)+') AND start_ms<? AND end_ms>? ORDER BY start_ms,end_ms',(*endpoint_ids,*kinds,end,start))
    return [dict(endpointId=r['endpoint_id'],kind=r['kind'],start=max(start,r['start_ms']),end=min(end,r['end_ms'])) for r in rows]
