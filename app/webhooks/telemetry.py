"""Idempotent business observations and mergeable minute/hour projections."""
from __future__ import annotations

import bisect
import json
import math

from app.webhooks.contracts import MISSING, WebhookError, digest, dumps, path_value, validate_material
from app.webhooks.repository import insert, many, one, uid


async def register_definitions(s,conn,eid,config):
    for m in config.statistics.metric_definitions:
        labels={x:{} for x in m.allowed_labels}
        values=dict(metric_type=m.type,unit=m.unit,allowed_labels_json=dumps(labels),histogram_bounds_json=dumps(m.histogram_buckets) if m.type=='histogram' else None,
                    gauge_ttl_ms=int((m.gauge_stale_seconds or s.config.telemetry.gauge_default_stale_seconds)*1000) if m.type=='gauge' else None)
        old=await one(conn,'SELECT * FROM webhook_metric_definitions WHERE endpoint_id=? AND name=?',(eid,m.name))
        if old:
            if any(old[k]!=v for k,v in values.items()): raise WebhookError('metric_contract_immutable',details={'name':m.name})
        else:
            await insert(conn,'webhook_metric_definitions',definition_id=uid(),endpoint_id=eid,name=m.name,source_kind='custom',description=m.description,
                         max_series=s.config.telemetry.max_series_per_endpoint,created_at_ms=s.clock(),**values)


def project_dimensions(config, material, explicit=None):
    """Bounded projection only: a bad dimension never removes the event."""
    projected={}; problems={}; explicit=explicit or {}
    for d in config.statistics.dimensions:
        value=explicit.get(d.name,path_value(material,d.path))
        if value is MISSING or value is None:
            if d.missing=='unknown': projected[d.name]='__unknown__'
            elif d.missing=='rejectMetric': problems[d.name]='missing_dimension:'+d.name
            continue
        if not isinstance(value,(str,int,float,bool)):
            problems[d.name]='invalid_dimension:'+d.name; continue
        value=value if isinstance(value,str) else dumps(value)
        if len(value)>d.max_length:
            problems[d.name]='dimension_too_long:'+d.name
            if d.kind!='category': projected[d.name]=value[:d.max_length]
            continue
        projected[d.name]=value
    return projected,problems


async def observation_context(s,conn,eid,*,event_id=None,assignment_id=None,attempt_id=None,action_id=None):
    revision=None; material={}
    if attempt_id:
        job=await one(conn,'SELECT j.* FROM webhook_stage_jobs j JOIN webhook_stage_attempts t USING(job_id) WHERE t.attempt_id=? AND j.endpoint_id=?',(attempt_id,eid))
        if not job: raise WebhookError('invalid_observation_context')
        revision=job['revision']; event_id=event_id or job['event_id']; assignment_id=assignment_id or job['assignment_id']
    if action_id and not assignment_id:
        link=await one(conn,'SELECT l.assignment_id FROM webhook_runtime_links l JOIN runtime_actions r USING(run_id) WHERE r.action_id=?',(action_id,))
        if link: assignment_id=link['assignment_id']
    if assignment_id:
        a=await one(conn,'SELECT * FROM webhook_assignments WHERE assignment_id=?',(assignment_id,))
        if not a: raise WebhookError('invalid_observation_context')
        if a['origin_endpoint_id']==eid: revision=revision or a['origin_revision']
    if event_id:
        event=await one(conn,'SELECT * FROM webhook_events WHERE event_id=? AND endpoint_id=?',(event_id,eid))
        if not event: raise WebhookError('invalid_observation_context')
        revision=revision or event['processing_revision']
        try: material=await s.event_material(conn,event_id)
        except WebhookError as exc:
            if exc.payload['code']!='payload_unavailable': raise
    if revision is None:
        endpoint=await s.endpoint_row(conn,eid,deleted=True); revision=endpoint['current_revision']
    return revision,material


async def observe(s,eid,payload,*,source,event_id=None,assignment_id=None,attempt_id=None,action_id=None,revalidate=False):
    op=payload.get('operationId',payload.get('operation_id'))
    if not isinstance(op,str) or not 1<=len(op)<=256: raise WebhookError('operation_id_required')
    validate_material(payload)
    fp=digest(payload)
    async with s.db.webhook_transaction() as conn:
        revision,material=await observation_context(s,conn,eid,event_id=event_id,assignment_id=assignment_id,attempt_id=attempt_id,action_id=action_id)
        old=await one(conn,'SELECT * FROM webhook_telemetry_operations WHERE scope_key=? AND operation_id=?',('endpoint:'+eid,op))
        if old:
            if old['content_sha256']!=fp: raise WebhookError('telemetry_conflict',status=409)
            if old['state']=='applied': return {'operationId':op,'state':old['state'],'duplicate':True}
        revision=old['revision'] if old and old['revision'] is not None else revision
        # Only the authenticated administrative replay endpoint opts in. An
        # ordinary delayed/automatic observation never adopts current semantics.
        if revalidate and old and old['state']=='rejected':
            endpoint=await s.endpoint_row(conn,eid,deleted=True); revision=endpoint['current_revision']
        _,config=await s.revision(conn,eid,revision)
        tid=old['telemetry_id'] if old else uid(); now=s.clock()
        if not old:
            await insert(conn,'webhook_telemetry_operations',telemetry_id=tid,scope_key='endpoint:'+eid,operation_id=op,endpoint_id=eid,event_id=event_id,
                         assignment_id=assignment_id,stage_attempt_id=attempt_id,runtime_action_id=action_id,revision=revision,source=source,content_sha256=fp,payload_json=dumps(payload),state='pending',created_at_ms=now)
        await conn.execute('UPDATE webhook_telemetry_operations SET revision=? WHERE telemetry_id=?',(revision,tid))
        warnings=[]
        if event_id and material:
            dimensions,_=project_dimensions(config,material)
            await conn.execute('UPDATE webhook_event_payloads SET dimensions_json=? WHERE event_id=?',(dumps(dimensions),event_id))
        declared_metrics={m.name:m for m in config.statistics.metric_definitions}
        for idx,m in enumerate(payload.get('metrics',[])):
            definition=await one(conn,'SELECT * FROM webhook_metric_definitions WHERE endpoint_id=? AND name=?',(eid,m.get('name')))
            if m.get('name') not in declared_metrics or not definition or definition['source_kind']!='custom': raise WebhookError('undeclared_metric')
            if m.get('type',definition['metric_type'])!=definition['metric_type']: raise WebhookError('metric_type_mismatch')
            value=m.get('value')
            if type(value) not in (int,float) or not math.isfinite(value) or definition['metric_type']=='counter' and value<0: raise WebhookError('invalid_metric_value')
            labels=m.get('labels',{})
            if not isinstance(labels,dict) or set(labels)-set(json.loads(definition['allowed_labels_json'])): raise WebhookError('undeclared_label')
            labels=dict(labels)  # bounded projection must not rewrite the source operation
            if any(not isinstance(v,str) for v in labels.values()): raise WebhookError('invalid_label')
            declared={d.name:d for d in config.statistics.dimensions}
            projected,problems=project_dimensions(config,material,labels)
            allowed=declared_metrics[m['name']].allowed_labels
            rejected=[problems[k] for k in allowed if k in problems]
            if rejected:
                warnings.extend(rejected); continue
            for k in allowed:
                if k in projected: labels[k]=projected[k]
            if any(len(v)>(declared[k].max_length if k in declared else 128) for k,v in labels.items()):
                warnings.append('invalid_label_length:'+m['name']); continue
            for k,v in list(labels.items()):
                d=declared.get(k)
                if d and d.kind!='category': raise WebhookError('high_cardinality_label',details={'label':k})
                if d and d.allowed_values is not None and v not in d.allowed_values: labels[k]='__other__'; warnings.append('category_overflow:'+k)
                existing=await many(conn,'SELECT labels_json FROM webhook_metric_series WHERE endpoint_id=?',(eid,))
                values={json.loads(r['labels_json']).get(k) for r in existing}
                maximum=min(d.max_categories or s.config.telemetry.max_categories_per_dimension,s.config.telemetry.max_categories_per_dimension) if d else s.config.telemetry.max_categories_per_dimension
                if v not in values and len(values-{None,'__other__'})>=maximum: labels[k]='__other__'; warnings.append('category_overflow:'+k)
            labels_json=dumps(labels)
            series=await one(conn,'SELECT * FROM webhook_metric_series WHERE definition_id=? AND endpoint_id=? AND labels_json=?',(definition['definition_id'],eid,labels_json))
            if not series:
                budget=await one(conn,'SELECT COUNT(*) n FROM webhook_metric_series WHERE endpoint_id=?',(eid,))
                local=await one(conn,'SELECT COUNT(*) n FROM webhook_metric_series WHERE definition_id=?',(definition['definition_id'],))
                if budget['n']>=s.config.telemetry.max_series_per_endpoint or local['n']>=definition['max_series']:
                    warnings.append('series_budget_exceeded:'+definition['name']); continue
                sid=uid()
                await insert(conn,'webhook_metric_series',series_id=sid,definition_id=definition['definition_id'],endpoint_id=eid,labels_json=labels_json,created_at_ms=now)
            else: sid=series['series_id']
            observed=m.get('observedAtMs',payload.get('observedAtMs',now))
            if type(observed) is not int or observed>now+300000 or observed<now-s.config.retention.metric_sample_days*86400000: raise WebhookError('observation_outside_window')
            expiry=observed+definition['gauge_ttl_ms'] if definition['gauge_ttl_ms'] else None
            cur=await insert(conn,'webhook_metric_samples',telemetry_id=tid,item_no=idx,series_id=sid,observed_at_ms=observed,recorded_at_ms=now,value=value,expires_at_ms=expiry)
            sample_id=cur.lastrowid
            for resolution in (60,3600):
                bucket=observed//(resolution*1000)*(resolution*1000)
                previous=await one(conn,'SELECT * FROM webhook_metric_rollups WHERE series_id=? AND resolution_seconds=? AND bucket_start_ms=?',(sid,resolution,bucket))
                bounds=json.loads(definition['histogram_bounds_json']) if definition['histogram_bounds_json'] else None
                counts=[0]*(len(bounds)+1) if bounds is not None else None
                if counts is not None: counts[bisect.bisect_left(bounds,value)]=1
                if previous:
                    if counts is not None: counts=[a+b for a,b in zip(counts,json.loads(previous['histogram_counts_json']))]
                    latest=(observed,sample_id)>(previous['last_observed_at_ms'],previous['last_sample_id'])
                    await conn.execute('UPDATE webhook_metric_rollups SET sample_count=sample_count+1,sum_value=sum_value+?,min_value=MIN(min_value,?),max_value=MAX(max_value,?),last_value=?,last_observed_at_ms=?,last_sample_id=?,last_expires_at_ms=?,histogram_counts_json=?,updated_at_ms=? WHERE series_id=? AND resolution_seconds=? AND bucket_start_ms=?',
                                       (value,value,value,value if latest else previous['last_value'],observed if latest else previous['last_observed_at_ms'],sample_id if latest else previous['last_sample_id'],expiry if latest else previous['last_expires_at_ms'],dumps(counts) if counts else None,now,sid,resolution,bucket))
                else:
                    await insert(conn,'webhook_metric_rollups',series_id=sid,resolution_seconds=resolution,bucket_start_ms=bucket,sample_count=1,sum_value=value,min_value=value,max_value=value,
                                 last_value=value,last_observed_at_ms=observed,last_sample_id=sample_id,last_expires_at_ms=expiry,histogram_counts_json=dumps(counts) if counts else None,updated_at_ms=now)
        records=payload.get('records',[])
        if 'event' in payload: records=[*records,{'event':payload['event'],'fields':payload.get('fields',{})}]
        for idx,r in enumerate(records):
            fields=r.get('fields',{})
            if not isinstance(fields,dict) or len(dumps(r).encode())>s.config.telemetry.max_business_record_bytes: raise WebhookError('business_record_too_large')
            fields=dict(fields)
            context={**material,**r,'body':material.get('body',fields),'fields':fields}
            for f in config.statistics.business_fields:
                if f.name not in fields:
                    value=path_value(context,f.path)
                    if value is not MISSING: fields[f.name]=value
            if len(dumps(fields).encode())>s.config.telemetry.max_business_record_bytes: raise WebhookError('business_record_too_large')
            observed=r.get('observedAtMs',now); rid=uid()
            await insert(conn,'webhook_business_records',record_id=rid,telemetry_id=tid,item_no=idx,endpoint_id=eid,record_type=str(r.get('event') or 'business'),observed_at_ms=observed,fields_json=dumps(fields),evidence_refs_json=dumps(r.get('evidenceRefs',[])))
            for f in config.statistics.business_fields:
                if not f.queryable or f.name not in fields: continue
                v=fields[f.name]; kind='null' if v is None else 'boolean' if isinstance(v,bool) else 'number' if type(v) in (int,float) else 'string' if isinstance(v,str) else None
                if kind is None or kind!=f.value_type: raise WebhookError('business_field_type')
                await insert(conn,'webhook_business_fields',record_id=rid,endpoint_id=eid,field_name=f.name,value_type=kind,value_text=v if kind=='string' else None,value_number=v if kind in ('number','boolean') else None,observed_at_ms=observed)
        await conn.execute("UPDATE webhook_telemetry_operations SET state='applied',applied_at_ms=?,error_reason=? WHERE telemetry_id=?",(now,';'.join(warnings) or None,tid))
    return {'operationId':op,'state':'applied','duplicate':False,'warnings':warnings}


async def metric_query(s,eid,start,end,*,name=None):
    from app.webhooks.retention import coverage
    gaps=await coverage(s.db.conn,[eid],start,end,['samples','rollups','framework_series','legacy_unknown'])
    series=await many(s.db.conn,'SELECT s.*,d.* FROM webhook_metric_series s JOIN webhook_metric_definitions d USING(definition_id) WHERE s.endpoint_id=?'+(' AND d.name=?' if name else ''),(eid,name) if name else (eid,)); result=[]
    for row in series:
        samples=await many(s.db.conn,'SELECT * FROM webhook_metric_samples WHERE series_id=? AND observed_at_ms>=? AND observed_at_ms<? ORDER BY observed_at_ms,sample_id',(row['series_id'],start,end))
        latest=await one(s.db.conn,'SELECT * FROM webhook_metric_rollups WHERE series_id=? AND resolution_seconds=60 AND last_observed_at_ms<? ORDER BY last_observed_at_ms DESC,last_sample_id DESC LIMIT 1',(row['series_id'],end))
        raw_latest=await one(s.db.conn,'SELECT value last_value,observed_at_ms last_observed_at_ms,sample_id last_sample_id,expires_at_ms last_expires_at_ms FROM webhook_metric_samples WHERE series_id=? AND observed_at_ms<? ORDER BY observed_at_ms DESC,sample_id DESC LIMIT 1',(row['series_id'],end))
        if raw_latest and (not latest or (raw_latest['last_observed_at_ms'],raw_latest['last_sample_id'])>(latest['last_observed_at_ms'],latest['last_sample_id'])): latest=raw_latest
        rollups=await many(s.db.conn,'SELECT * FROM webhook_metric_rollups WHERE series_id=? AND resolution_seconds=60 AND bucket_start_ms>=? AND bucket_start_ms<? ORDER BY bucket_start_ms',(row['series_id'],start//60000*60000,end))
        raw_by_bucket={}
        for sample in samples: raw_by_bucket.setdefault(sample['observed_at_ms']//60000*60000,[]).append(sample['value'])
        values=[]; coarse=[]; warnings=[]
        for bucket in rollups:
            at=bucket['bucket_start_ms']; raw=raw_by_bucket.pop(at,[])
            full=at>=start and at+60000<=end
            if full and len(raw)<bucket['sample_count']: coarse.append(bucket)
            else:
                values.extend(raw)
                if not full and len(raw)<bucket['sample_count'] and at+60000<s.clock()-s.config.retention.metric_sample_days*86400000: warnings.append('purged_partial_bucket')
        for raw in raw_by_bucket.values(): values.extend(raw)
        values.sort(); n=len(values)+sum(b['sample_count'] for b in coarse)
        minima=values+[b['min_value'] for b in coarse]; maxima=values+[b['max_value'] for b in coarse]
        item=dict(name=row['name'],type=row['metric_type'],unit=row['unit'],labels=json.loads(row['labels_json']),count=n,sum=sum(values)+sum(b['sum_value'] for b in coarse),min=min(minima) if minima else None,max=max(maxima) if maxima else None,
                  lastValue=latest['last_value'] if latest else None,lastObservedAt=latest['last_observed_at_ms'] if latest else None,stale=bool(latest and latest['last_expires_at_ms'] and latest['last_expires_at_ms']<s.clock()),precision='bucketApproximation' if coarse else 'raw',warnings=warnings,resolutionSeconds=60 if coarse else None)
        if row['histogram_bounds_json']:
            bounds=json.loads(row['histogram_bounds_json']); counts=[0]*(len(bounds)+1)
            for value in values: counts[bisect.bisect_left(bounds,value)]+=1
            for b in coarse: counts=[a+b for a,b in zip(counts,json.loads(b['histogram_counts_json']))]
            total=0; cumulative=[]
            for count in counts: total+=count; cumulative.append(total)
            def percentile(q):
                if not n: return None
                if not coarse: return values[math.ceil(n*q)-1]
                for i,count in enumerate(cumulative):
                    if count>=math.ceil(n*q): return bounds[i] if i<len(bounds) else item['max']
            item.update(buckets={'bounds':bounds+[None],'counts':counts,'cumulative':cumulative},p50=percentile(.5),p95=percentile(.95))
        series_gaps=[g for g in gaps if g['kind']!='framework_series' or row['source_kind']=='framework']
        item['coverage']='partial' if series_gaps else 'complete'
        item['warnings'].extend(sorted({'retention_gap:'+g['kind'] for g in series_gaps}))
        if not n and any(g['kind'] in ('rollups','legacy_unknown') for g in series_gaps):
            item.update(count=None,sum=None,coverage='unavailable',precision='unavailable')
        result.append(item)
    return result


async def enqueue_script(s,conn,job,attempt,output):
    if not output or not (output.get('metrics') or output.get('records')): return
    payload={'operationId':output.get('operation_id') or job['action_key']+':telemetry','metrics':output.get('metrics',[]),'records':output.get('records',[])}
    op=payload['operationId']
    # Invalid observations remain in the attempt result; never undo business success.
    if not isinstance(op,str) or not 1<=len(op)<=256: return
    old=await one(conn,'SELECT telemetry_id FROM webhook_telemetry_operations WHERE scope_key=? AND operation_id=?',('endpoint:'+job['endpoint_id'],op))
    if old: return
    revision,_=await observation_context(s,conn,job['endpoint_id'],event_id=job['event_id'],assignment_id=job['assignment_id'],attempt_id=attempt)
    await insert(conn,'webhook_telemetry_operations',revision=revision,telemetry_id=uid(),scope_key='endpoint:'+job['endpoint_id'],operation_id=op,endpoint_id=job['endpoint_id'],event_id=job['event_id'],assignment_id=job['assignment_id'],stage_attempt_id=attempt,source='script',content_sha256=digest(payload),payload_json=dumps(payload),state='pending',created_at_ms=s.clock())


async def flush(s):
    for r in await many(s.db.conn,"SELECT * FROM webhook_telemetry_operations WHERE state='pending' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms<=?) ORDER BY telemetry_id LIMIT 100",(s.clock(),)):
        try:
            await observe(s,r['endpoint_id'],json.loads(r['payload_json']),source=r['source'],event_id=r['event_id'],assignment_id=r['assignment_id'],attempt_id=r['stage_attempt_id'],action_id=r['runtime_action_id'])
        except WebhookError as exc:
            async with s.db.webhook_transaction() as conn:
                await conn.execute("UPDATE webhook_telemetry_operations SET state='rejected',error_reason=? WHERE telemetry_id=?",(exc.payload['code'],r['telemetry_id']))
        except Exception as exc:
            async with s.db.webhook_transaction() as conn:
                await conn.execute('UPDATE webhook_telemetry_operations SET next_attempt_at_ms=?,error_reason=? WHERE telemetry_id=?',(s.clock()+30000,type(exc).__name__,r['telemetry_id']))
