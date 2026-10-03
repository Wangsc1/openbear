"""D12/D13 retention, unknown usage and dynamically reduced capacity on isolated facts."""
import asyncio
import json

import pytest
from app.webhooks import receipts
from app.webhooks.retention import prune
from app.webhooks.telemetry import observe
from app.webhooks.repository import one,many
from app.webhooks.queries import detail,usage
from tests.test_webhooks_backend import env,create,accept,drain_scripts


async def test_D12_retention_preserves_active_review_and_business_evidence(env):
    env.s.bridge=None; now=[1_800_000_000_000]; env.s.clock=lambda:now[0]
    r=env.s.config.retention; r.payload_days=1; r.script_log_days=1; r.processing_days=1; r.metric_sample_days=1; r.metric_rollup_days=2; r.business_record_days=1
    code='import sys,json\nx=json.load(sys.stdin)\nprint("retention-log",file=sys.stderr)\nprint(json.dumps({"decision":"skip_model","outcome":"handled","result":{"large":"output"}}))'
    c=await create(env,pre={'enabled':True,'code':code},statistics={'metricDefinitions':[{'name':'custom_n','type':'counter'}]})
    cases={k:await accept(env,c,key=k) for k in ('clean','evidence','unknown')}
    await drain_scripts(env)
    while env.worker.tasks: await asyncio.gather(*list(env.worker.tasks.values()))
    async with env.db.webhook_transaction() as conn:
        for k in ('evidence','unknown'):
            await receipts.receipt(env.s,conn,cases[k]['eventId'],source='administrator',request_key=k,outcome='unknown' if k=='unknown' else 'completed',evidence=['external:investigation'] if k=='evidence' else [])
    for k,e in cases.items():
        await observe(env.s,c['endpoint']['id'],{'operationId':k,'metrics':[{'name':'custom_n','value':1}],'records':[{'event':'audit','fields':{},'evidenceRefs':['external:retained'] if k=='evidence' else []}]},source='script',event_id=e['eventId'])
    pending=await accept(env,c,key='pending')
    now[0]+=3*86400000
    result=await prune(env.s)
    assert (await detail(env.s,123,cases['clean']['eventId']))['event']['payloadStatus']=='purged'
    for k in ('evidence','unknown'):
        assert (await detail(env.s,123,cases[k]['eventId']))['event']['payloadStatus']=='retained'
        job=await one(env.db.conn,'SELECT job_id FROM webhook_stage_jobs WHERE event_id=?',(cases[k]['eventId'],))
        assert (await one(env.db.conn,'SELECT stderr_text FROM webhook_stage_attempts WHERE job_id=?',(job['job_id'],)))['stderr_text']=='retention-log\n'
        assert await one(env.db.conn,'SELECT * FROM webhook_metric_samples m JOIN webhook_telemetry_operations t USING(telemetry_id) WHERE t.event_id=?',(cases[k]['eventId'],))
        assert await one(env.db.conn,'SELECT * FROM webhook_business_records b JOIN webhook_telemetry_operations t USING(telemetry_id) WHERE t.event_id=?',(cases[k]['eventId'],))
    assert await env.s.event_material(env.db.conn,pending['eventId'])
    assert (await accept(env,c,key='clean'))['eventId']==cases['clean']['eventId']
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_metric_rollups'))['n']>0


async def test_D13_unknown_usage_and_lower_queue_limit(env):
    c=await create(env,batching={'enabled':False})
    # Missing provider usage remains visibly unknown, without an automatic budget.
    await accept(env,c,key='one'); await env.worker.tick(); await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller'))
    values=await usage(env.s,env.db.conn,endpoint_id=c['endpoint']['id'])
    assert values['unknownUsageCalls']>0 and values['unknownCostCalls']>0
    await accept(env,c,key='two'); await accept(env,c,key='three'); env.s.config.queue.max_events=1
    with pytest.raises(Exception) as error: await accept(env,c,key='four')
    assert error.value.payload['code']=='queue_full'
    assert (await accept(env,c,key='two'))['duplicate']
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_events'))['n']==3
    assert any(r.startswith('review:') for r in (await env.s.get(123,c['endpoint']['id']))['endpoint']['pauseReasons'])


@pytest.mark.parametrize('protect',['none','post_observation','notification'])
async def test_D12_processing_snapshots_and_assignment_only_reference(env,protect):
    from tests.test_webhooks_wait_acceptance import held
    from app.webhooks.notifications import tick
    from types import SimpleNamespace
    async with held(env) as (c,a,first,release):
        initial=env.s.clock()
        env.s.clock=lambda:initial+3*86400000
        env.s.config.retention.payload_days=1; env.s.config.retention.processing_days=1
        await prune(env.s)
        assert (await detail(env.s,123,first['eventId']))['event']['payloadStatus']=='retained'
        env.s.clock=lambda:initial
        release.set()
    if protect=='post_observation':
        await observe(env.s,c['endpoint']['id'],{'operationId':'post-only','records':[{'event':'evidence','fields':{},'evidenceRefs':['external:keep']}]},source='script',assignment_id=a['assignment_id'])
    if protect=='notification':
        async def unavailable(*args,**kwargs): raise OSError('isolated channel unavailable')
        env.server.browser_push=SimpleNamespace(enqueue=unavailable)
    await tick(env.s)
    env.s.clock=lambda:initial+3*86400000
    await prune(env.s)
    d=(await detail(env.s,123,first['eventId']))['event']
    assert d['payloadStatus']==('purged' if protect=='none' else 'retained')
    assert d['assignments'][0]['processingStatus']==('purged' if protect=='none' else 'retained')
    if protect=='none':
        assert json.loads((await one(env.db.conn,'SELECT final_snapshot_json FROM webhook_assignments'))['final_snapshot_json'])=={'retention':'purged'}
        assert d['receipts'][0]['source']=='model' and d['receipts'][0]['outcome']=='completed'
    else: assert 'materials' in json.loads((await one(env.db.conn,'SELECT final_snapshot_json FROM webhook_assignments'))['final_snapshot_json'])


async def test_D12_cleanup_advances_past_purged_first_page(env):
    now=[1800000000000]; env.s.clock=lambda:now[0]
    env.s.config.ingress.requests_per_minute=2000
    c=await create(env,limits={'pendingEvents':2000,'requestsPerMinute':2000})
    ids=[(await accept(env,c,key=str(i)))['eventId'] for i in range(1001)]
    async with env.db.webhook_transaction() as conn:
        await conn.execute("UPDATE webhook_events SET route_state='terminal',terminal_at_ms=?,terminal_reason='expired'",(now[0],))
    env.s.config.retention.payload_days=1; now[0]+=3*86400000
    assert (await prune(env.s))['payloads']==1000
    assert (await prune(env.s))['payloads']==1
    assert not await many(env.db.conn,'SELECT * FROM webhook_event_payloads')
    assert (await accept(env,c,key='1000'))['eventId']==ids[-1]
