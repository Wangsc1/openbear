"""E15: 100k isolated rows, actual HTTP query plans and bounded pagination.

Bulk SQL supplies a known capacity fixture, not ingestion/telemetry acceptance.
Queries use the authenticated product APIs. Timings are observations, not an SLA.
"""
import json
import platform
import sqlite3
import time

from app.webhooks.repository import many, one
from tests.test_web_admin import _login_cookie
from tests.test_webhooks_backend import env
from tests.test_webhooks_query_business import endpoint, query, report


async def test_E15_capacity_http_queries_and_plans(env):
    n = 100_000
    start = 1_800_000_000_000
    env.s.clock = lambda: start + n * 1000 + 1
    created = await endpoint(env, 'capacity')
    eid = created['endpoint']['id']
    await report(env, created, 'seed', 'seed', 0, False)
    sid = (await one(env.db.conn, 'SELECT series_id FROM webhook_metric_series WHERE endpoint_id=?', (eid,)))['series_id']
    # Keep the genuine series/definition, replace only the seed fixture observations.
    async with env.db.webhook_transaction() as conn:
        await conn.execute('DELETE FROM webhook_metric_samples')
        await conn.execute('DELETE FROM webhook_metric_rollups')
        await conn.execute('DELETE FROM webhook_business_fields')
        await conn.execute('DELETE FROM webhook_business_records')
        await conn.execute('DELETE FROM webhook_telemetry_operations')
        await conn.execute('CREATE TEMP TABLE fixture_numbers(n INTEGER PRIMARY KEY)')
        await conn.execute('WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n+1<?) INSERT INTO fixture_numbers SELECT n FROM seq', (n,))
        await conn.execute("""INSERT INTO webhook_events(event_id,endpoint_id,idempotency_key,identity_source,content_fingerprint,received_revision,processing_revision,received_at_ms,route_state,acceptance_json)
            SELECT printf('event-%06d',n),?,printf('event-%06d',n),'header','fixture',1,1,?+n*1000,'eligible','{}' FROM fixture_numbers""", (eid, start))
        await conn.execute("""INSERT INTO webhook_telemetry_operations(telemetry_id,scope_key,operation_id,endpoint_id,source,content_sha256,state,created_at_ms,applied_at_ms)
            SELECT printf('op-%06d',n),'endpoint:'||?,printf('op-%06d',n),?,'script','fixture','applied',?+n*1000,?+n*1000 FROM fixture_numbers""", (eid, eid, start, start))
        await conn.execute("""INSERT INTO webhook_metric_samples(telemetry_id,item_no,series_id,observed_at_ms,recorded_at_ms,value)
            SELECT printf('op-%06d',n),0,?,?+n*1000,?+n*1000,1 FROM fixture_numbers""", (sid, start, start))
        for resolution in (60, 3600):
            await conn.execute("""INSERT INTO webhook_metric_rollups(series_id,resolution_seconds,bucket_start_ms,sample_count,sum_value,min_value,max_value,last_value,last_observed_at_ms,last_sample_id,updated_at_ms)
                SELECT series_id,?,observed_at_ms/(?*1000)*(?*1000),COUNT(*),SUM(value),MIN(value),MAX(value),1,MAX(observed_at_ms),MAX(sample_id),MAX(recorded_at_ms)
                FROM webhook_metric_samples GROUP BY series_id,observed_at_ms/(?*1000)""", (resolution, resolution, resolution, resolution))
        await conn.execute("""INSERT INTO webhook_business_records(record_id,telemetry_id,item_no,endpoint_id,record_type,observed_at_ms,fields_json)
            SELECT printf('record-%06d',n),printf('op-%06d',n),0,?,'order_result',?+n*1000,json_object('sender',printf('sender-%04d',n%1000),'amount',n%100,'done',json(CASE WHEN n%2=0 THEN 'false' ELSE 'true' END)) FROM fixture_numbers""", (eid, start))
        await conn.execute("""INSERT INTO webhook_business_fields(record_id,endpoint_id,field_name,value_type,value_text,observed_at_ms)
            SELECT record_id,endpoint_id,'sender','string',json_extract(fields_json,'$.sender'),observed_at_ms FROM webhook_business_records""")
        for field, kind in [('amount', 'number'), ('done', 'boolean')]:
            await conn.execute("""INSERT INTO webhook_business_fields(record_id,endpoint_id,field_name,value_type,value_number,observed_at_ms)
                SELECT record_id,endpoint_id,?,?,json_extract(fields_json,?),observed_at_ms FROM webhook_business_records""", (field, kind, '$.' + field))
        await conn.execute('DROP TABLE fixture_numbers')
    cookies = {'openbear_web_session': await _login_cookie(env)}
    observations = []

    async def measured(label, view, **params):
        statements = []
        await env.db.conn._reader.set_trace_callback(statements.append)
        begin = time.perf_counter()
        try:
            if view == 'events':
                response = await env.client.get('/api/webhooks/events', params=params, cookies=cookies)
                value = await response.json()
                assert response.status == 200, value
            else:
                value = await query(env, cookies, view, **params)
        finally:
            elapsed = (time.perf_counter() - begin) * 1000
            await env.db.conn._reader.set_trace_callback(None)
        plans = []
        for sql in dict.fromkeys(statements):
            if not sql.startswith('SELECT') or 'webhook_' not in sql:
                continue
            assert 'webhook_event_payloads' not in sql, 'Overview must not scan raw bodies'
            plan = await many(env.db.conn, 'EXPLAIN QUERY PLAN ' + sql)
            plans.append({'sql': sql, 'plan': [r['detail'] for r in plan]})
        observations.append({'query': label, 'elapsedMs': round(elapsed, 2), 'plans': plans})
        return value

    common = {'endpointId': eid, 'start': start, 'end': start + n * 1000}
    overview = await measured('overview', 'overview', **common)
    assert overview['overview']['accepted'] == n
    metrics = await measured('metric-time-range', 'metrics', **{**common, 'start': start + 90_000 * 1000})
    assert metrics['metrics'][0]['count'] == 10_000 and metrics['metrics'][0]['sum'] == 10_000
    seen = []
    cursor = None
    for page in range(4):
        result = await measured(f'typed-filter-page-{page}', 'business', **common, limit=30,
            filters=json.dumps({'sender': 'sender-0042', 'amount': 42, 'done': False}), **({'cursor': cursor} if cursor else {}))
        seen.extend(r['recordId'] for r in result['items'])
        cursor = result['nextCursor']
    assert cursor is None and seen == [f'record-{i:06}' for i in range(42, n, 1000)]
    ranking = await measured('numeric-ranking', 'ranking', **common, field='amount', limit=100)
    assert len(ranking['items']) == 100 and all(r['count'] == 1000 for r in ranking['items'])
    events = await measured('event-queue-time-range', 'events', **{**common, 'start': start + 99_000 * 1000}, state='eligible', limit=100)
    assert [r['eventId'] for r in events['items']] == [f'event-{i:06}' for i in range(99_000, 99_100)]
    # Save the actual plans so a failure can be diagnosed without replaying load generation.
    evidence = {'environment': {'platform': platform.platform(), 'python': platform.python_version(), 'sqlite': sqlite3.sqlite_version},
        'rows': {'events': n, 'metricSamples': n, 'businessRecords': n, 'businessFields': 3*n}, 'queries': observations}
    (env.tmp / 'capacity-query-evidence.json').write_text(json.dumps(evidence, indent=2))
    print('E15 evidence:', env.tmp / 'capacity-query-evidence.json')
    print(json.dumps({r['query']: r['elapsedMs'] for r in observations}))
    by_name = {r['query']: r for r in observations}
    assert any('webhook_sample_series_time' in p for q in by_name['metric-time-range']['plans'] for p in q['plan'])
    assert any('webhook_event_queue' in p for q in by_name['event-queue-time-range']['plans'] for p in q['plan'])
    assert any('webhook_business_field_text' in p for q in by_name['typed-filter-page-0']['plans'] for p in q['plan'])
    assert any('webhook_business_field_number' in p for q in by_name['numeric-ranking']['plans'] for p in q['plan'])
