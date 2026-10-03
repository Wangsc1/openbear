"""E06-E12 edge facts through production observation writes and authenticated queries."""
import asyncio
import json
import sqlite3
import pytest
from app.webhooks.telemetry import observe
from app.webhooks.retention import prune
from app.webhooks.contracts import WebhookError
from app.webhooks.repository import one,many
from tests.test_webhooks_backend import env,create
from tests.test_web_admin import _login_cookie


async def metric_http(env,eid,start,end):
    cookie=await _login_cookie(env)
    r=await env.client.get('/api/webhooks/statistics',params={'view':'metrics','endpointId':eid,'start':str(start),'end':str(end)},cookies={'openbear_web_session':cookie})
    assert r.status==200; return (await r.json())['metrics']


async def test_E12_projection_commit_failure_replay_and_partial_retention(env):
    now=[1200000]; env.s.clock=lambda:now[0]
    c=await create(env,statistics={'metricDefinitions':[{'name':'custom_hist','type':'histogram','histogramBuckets':[.1,.5,1.]}]}); eid=c['endpoint']['id']
    p={'operationId':'atomic','metrics':[{'name':'custom_hist','value':.05,'observedAtMs':1201000}]}
    await env.db.conn.execute("CREATE TRIGGER isolated_fail_rollup BEFORE INSERT ON webhook_metric_rollups BEGIN SELECT RAISE(ABORT,'isolated projection failure'); END"); await env.db.conn.commit()
    with pytest.raises(sqlite3.IntegrityError): await observe(env.s,eid,p,source='script')
    assert not await many(env.db.conn,'SELECT * FROM webhook_metric_samples') and not await many(env.db.conn,"SELECT * FROM webhook_telemetry_operations WHERE operation_id='atomic'")
    await env.db.conn.execute('DROP TRIGGER isolated_fail_rollup'); await env.db.conn.commit()
    await observe(env.s,eid,p,source='script'); assert (await observe(env.s,eid,p,source='script'))['duplicate']
    now[0]+=120000
    for op,at,value in [('later',1261000,1),('late-arrival',1202000,.4)]: await observe(env.s,eid,{'operationId':op,'metrics':[{'name':'custom_hist','value':value,'observedAtMs':at}]},source='script')
    h=(await metric_http(env,eid,1200000,1320000))[0]; assert h['count']==3 and h['sum']==pytest.approx(1.45) and h['precision']=='raw'
    assert (await one(env.db.conn,'SELECT SUM(sample_count) n FROM webhook_metric_rollups WHERE resolution_seconds=3600'))['n']==3
    now[0]+=31*86400000; await prune(env.s)
    h=(await metric_http(env,eid,1200000,1320000))[0]
    assert h['count']==3 and h['sum']==pytest.approx(1.45) and h['precision']=='bucketApproximation' and h['buckets']['counts']==[1,1,1,0]
    edge=(await metric_http(env,eid,1201500,1210000))[0]
    assert edge['count']==0 and 'purged_partial_bucket' in edge['warnings'] and edge['p95'] is None
    with pytest.raises(WebhookError,match='observation_outside_window'):
        await observe(env.s,eid,{'operationId':'too-late','metrics':[{'name':'custom_hist','value':1,'observedAtMs':1201000}]},source='script')


async def test_E07_E09_E10_contract_immutability_validation_and_series_budget(env):
    clock=[1000000]; env.s.clock=lambda:clock[0]
    c=await create(env,statistics={'dimensions':[{'name':'category','path':'body.c','kind':'category'}],'metricDefinitions':[{'name':'custom_g','type':'gauge','allowedLabels':['category'],'gaugeStaleSeconds':30,'unit':'items'},{'name':'custom_h','type':'histogram','histogramBuckets':[1,2]}]}); eid=c['endpoint']['id']
    for i,value in enumerate([3,7]): await observe(env.s,eid,{'operationId':str(i),'metrics':[{'name':'custom_g','value':value,'observedAtMs':clock[0],'labels':{'category':'a'}}]},source='script')
    g=next(m for m in await metric_http(env,eid,0,clock[0]+1) if m['name']=='custom_g'); assert g['lastValue']==7
    for change in ({'type':'counter'},{'unit':'ms'}):
        config=c['endpoint']['config']; config=json.loads(json.dumps(config)); config['statistics']['metricDefinitions'][0].update(change)
        with pytest.raises(WebhookError,match='metric_contract_immutable'): await env.s.update(123,eid,{'requestId':'change'+str(change),'expectedRevision':1,'config':config})
    cfg=json.loads(json.dumps(c['endpoint']['config'])); cfg['statistics']['metricDefinitions'][1]['histogramBuckets']=[1,3]
    with pytest.raises(WebhookError,match='metric_contract_immutable'): await env.s.update(123,eid,{'requestId':'bucket','expectedRevision':1,'config':cfg})
    invalid=[{'name':'custom_g','value':float('nan')},{'name':'custom_g','value':float('inf')},{'name':'custom_g','value':1,'labels':{'undeclared':'x'}},{'name':'framework_calls','value':1},{'name':'custom_g','value':1,'type':'histogram'}]
    before=(await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_metric_samples'))['n']
    for i,m in enumerate(invalid):
        with pytest.raises((WebhookError,ValueError)): await observe(env.s,eid,{'operationId':'bad'+str(i),'metrics':[m]},source='script')
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_metric_samples'))['n']==before
    env.s.config.telemetry.max_series_per_endpoint=2
    async def submit(i): return await observe(env.s,eid,{'operationId':'concurrent'+str(i),'metrics':[{'name':'custom_g','value':1,'labels':{'category':str(i)}}],'records':[{'event':'not-dropped','fields':{'sender':str(i)}}]},source='script')
    results=await asyncio.gather(*(submit(i) for i in range(5)))
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_metric_series'))['n']==2
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_business_records'))['n']==5
    assert sum(bool(r['warnings']) for r in results)==4
    with pytest.raises(WebhookError,match='telemetry_conflict'): await observe(env.s,eid,{'operationId':'0','metrics':[]},source='script')
