"""Product management queries on real authenticated HTTP and isolated SQLite."""
import json

import pytest

from app.webhooks.observability import span
from app.webhooks.telemetry import observe
from tests.test_web_admin import _login_cookie
from tests.test_webhooks_backend import env, accept


async def endpoint(env, name, *, owner=123, conversation=False, fields=None):
    if conversation:
        row = await env.server._create_web_conversation(owner, title=name)
        scope = {'type': 'conversation', 'id': row['conversation_uuid']}
    else:
        await env.db.conn.execute('INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name) VALUES(?,?,?)', (name, owner, name))
        await env.db.conn.commit()
        scope = {'type': 'folder', 'id': name}
    return await env.s.create(owner, {'scope': scope, 'requestId': name, 'name': name, 'enabled': True, 'config': {
        'processing': {'instructions': 'Only process isolated query fixtures.'},
        'statistics': {'businessFields': fields or [
            {'name': 'sender', 'path': 'body.sender', 'valueType': 'string'},
            {'name': 'amount', 'path': 'body.amount', 'valueType': 'number'},
            {'name': 'done', 'path': 'body.done', 'valueType': 'boolean'},
        ], 'metricDefinitions': [{'name': 'custom_count', 'type': 'counter', 'unit': 'count'}]},
    }})


async def report(env, created, operation, sender, amount, done):
    await observe(env.s, created['endpoint']['id'], {'operationId': operation,
        'metrics': [{'name': 'custom_count', 'value': 1}],
        'records': [{'event': 'order_result', 'fields': {'sender': sender, 'amount': amount, 'done': done}}]}, source='script')


async def query(env, cookies, view, **params):
    response = await env.client.get('/api/webhooks/statistics', params={'view': view, **params}, cookies=cookies)
    body = await response.json()
    assert response.status == 200, body
    return body


async def test_E13_global_endpoint_folder_conversation_query_contract(env):
    a = await endpoint(env, 'F1'); b = await endpoint(env, 'C1', conversation=True); hidden = await endpoint(env, 'other-owner', owner=999)
    await report(env, a, 'a', 'shared', 0, False)
    await report(env, b, 'b', 'shared', 2, True)
    await report(env, hidden, 'secret', 'private', 999, True)
    cookies = {'openbear_web_session': await _login_cookie(env)}
    all_data = await query(env, cookies, 'business')
    ids = {a['endpoint']['id'], b['endpoint']['id']}
    assert {row['endpointId'] for row in all_data['items']} == ids
    assert {field['name'] for field in all_data['queryableFields']} == {'sender', 'amount', 'done'}
    assert all(row['source'] == 'script' for row in all_data['items'])
    metrics = await query(env, cookies, 'metrics')
    custom = [m for m in metrics['metrics'] if m['name'] == 'custom_count']
    assert {m['endpointId'] for m in custom} == ids and sum(m['sum'] for m in custom) == 2
    for created in [a, b]:
        e = created['endpoint']; scoped = await query(env, cookies, 'business', scopeType=e['scope']['type'], scopeId=e['scope']['id'])
        direct = await query(env, cookies, 'business', endpointId=e['id'])
        assert scoped['items'] == direct['items'] and len(scoped['items']) == 1
        assert scoped['items'][0]['scope'] == e['scope']
    missing = await query(env, cookies, 'metrics', scopeType='folder', scopeId='absent')
    assert missing['metrics'] == []
    forbidden = await env.client.get('/api/webhooks/statistics', params={'endpointId': hidden['endpoint']['id']}, cookies=cookies)
    assert forbidden.status in (403, 404)


async def test_E11_typed_filters_ranking_and_cross_endpoint_conflicts(env):
    a = await endpoint(env, 'F1'); b = await endpoint(env, 'F2')
    await report(env, a, 'a1', '001', 0, False); await report(env, a, 'a2', '001', 2, True); await report(env, b, 'b1', '002', 0, False)
    cookies = {'openbear_web_session': await _login_cookie(env)}
    selected = await query(env, cookies, 'business', filters=json.dumps({'sender': '001', 'amount': 0, 'done': False}))
    assert len(selected['items']) == 1 and selected['items'][0]['fields'] == {'sender': '001', 'amount': 0, 'done': False}
    text = await query(env, cookies, 'ranking', field='sender'); number = await query(env, cookies, 'ranking', field='amount'); boolean = await query(env, cookies, 'ranking', field='done')
    assert text['items'][0]['value'] == '001' and text['items'][0]['count'] == 2
    assert number['items'][0]['value'] == 0 and number['items'][0]['count'] == 2
    assert boolean['items'][0]['value'] is False and boolean['items'][0]['count'] == 2
    invalid = await env.client.get('/api/webhooks/statistics', params={'view': 'business', 'filters': '{"amount":"0"}'}, cookies=cookies)
    assert invalid.status == 422 and (await invalid.json())['code'] == 'business_filter_type'
    conflict = await endpoint(env, 'F3', fields=[{'name': 'sender', 'path': 'body.different', 'valueType': 'number'}])
    catalog = await query(env, cookies, 'business')
    assert 'sender' not in {f['name'] for f in catalog['queryableFields']}
    assert {f['name'] for f in catalog['fieldConflicts']} == {'sender'}
    refused = await env.client.get('/api/webhooks/statistics', params={'view': 'ranking', 'field': 'sender'}, cookies=cookies)
    assert refused.status == 422 and (await refused.json())['code'] == 'ambiguous_business_field'
    assert (await query(env, cookies, 'ranking', endpointId=a['endpoint']['id'], field='sender'))['items'][0]['count'] == 2


async def test_E05_E13_phases_and_event_ranges_are_scoped_before_pagination(env):
    clock = [1_000_000]; env.s.clock = lambda: clock[0]
    a = await endpoint(env, 'F1'); b = await endpoint(env, 'C1', conversation=True)
    await accept(env, a, key='old'); clock[0] += 1000
    kept1 = await accept(env, a, key='one'); kept2 = await accept(env, a, key='two'); await accept(env, b, key='other')
    async with env.db.webhook_transaction() as conn:
        await span(env.s, conn, 'model_tool', 'span-a', endpoint=a['endpoint']['id'], level='assignment', start=1_000_000, end=1_010_000)
        await span(env.s, conn, 'model_tool', 'span-b', endpoint=b['endpoint']['id'], level='assignment', start=1_000_000, end=1_020_000)
    clock[0] = 1_021_000
    cookies = {'openbear_web_session': await _login_cookie(env)}
    scoped = await query(env, cookies, 'phases', scopeType='folder', scopeId='F1')
    assert scoped['phases'][0]['averageSeconds'] == 10 and scoped['phases'][0]['measurementLevel'] == 'assignment'
    assert (await query(env, cookies, 'phases'))['phases'][0]['averageSeconds'] == 15
    params = {'scopeType': 'folder', 'scopeId': 'F1', 'start': '1970-01-01T00:16:41Z', 'end': '1970-01-01T00:16:42Z', 'limit': 1, 'state': 'eligible'}
    r = await env.client.get('/api/webhooks/events', params=params, cookies=cookies); assert r.status == 200
    first = await r.json(); assert first['items'][0]['eventId'] == kept1['eventId']
    r = await env.client.get('/api/webhooks/events', params={**params, 'cursor': first['nextCursor']}, cookies=cookies)
    second = await r.json(); assert second['items'][0]['eventId'] == kept2['eventId'] and second['nextCursor'] is None


async def test_E11_business_keyset_pagination_uses_time_and_id_without_duplicates(env):
    a = await endpoint(env, 'F1'); cookies = {'openbear_web_session': await _login_cookie(env)}
    for i in range(5): await report(env, a, str(i), 'same', i, False)
    ids = []; cursor = None
    for _ in range(3):
        data = await query(env, cookies, 'business', limit=2, **({'cursor': cursor} if cursor else {}))
        ids.extend(row['recordId'] for row in data['items']); cursor = data['nextCursor']
    assert len(ids) == len(set(ids)) == 5 and cursor is None


async def test_E14_event_phase_details_preserve_shared_levels_and_unknown_end(env):
    import asyncio
    from app.llm.events import StreamEvent, ToolCall
    from app.webhooks.repository import one
    from tests.test_web_admin import FakeRunFactory, FakeStreamBackend
    from tests.test_webhooks_backend import create

    created = await create(env, batching={'enabled': True, 'maxEvents': 2})
    first = await accept(env, created, key='first')
    second = await accept(env, created, key='second')
    report_args = {'action': 'report', 'params': {'receiptId': 'phase-result', 'results': [
        {'eventId': item['eventId'], 'outcome': 'completed', 'summary': 'Fixture reported completion'} for item in [first, second]]}}
    backend = FakeStreamBackend([
        [StreamEvent(kind='tool_call', tool_calls=[ToolCall('report', 'Webhook', json.dumps(report_args))]), StreamEvent(kind='finish', finish_reason='tool_calls')],
        [StreamEvent(kind='content', text='Finished'), StreamEvent(kind='finish', finish_reason='stop')],
    ])
    env.server.llm_factory = FakeRunFactory(backend, context_window=128000)
    await env.worker.tick()
    await asyncio.gather(*env.server.runs.scheduler.tasks(kind='controller'))
    assignment = await one(env.db.conn, 'SELECT * FROM webhook_assignments')
    assert assignment['state'] == 'finalized'
    # Query projection test: an unclosed measurement stays unknown, not zero.
    async with env.db.webhook_transaction() as conn:
        await span(env.s, conn, 'human_wait', 'detail-wait', endpoint=created['endpoint']['id'], assignment=assignment['assignment_id'], level='assignment', start=env.s.clock())
    await observe(env.s, created['endpoint']['id'], {'operationId': 'detail-observation', 'records': [{'event': 'custom_result', 'fields': {}}]}, source='script', event_id=first['eventId'])
    cookies = {'openbear_web_session': await _login_cookie(env)}
    response = await env.client.get('/api/webhooks/events/' + first['eventId'], cookies=cookies)
    assert response.status == 200
    event = (await response.json())['event']
    phases = event['phaseSpans']
    assert {'aggregation', 'model_queue', 'model_tool', 'human_wait'} <= {p['phase'] for p in phases}
    assert all(p['source'] == 'framework' and p['eventId'] in (None, first['eventId']) for p in phases)
    shared_model = [p for p in phases if p['phase'] == 'model_tool']
    assert len(shared_model) == 1 and shared_model[0]['shared'] and shared_model[0]['measurementLevel'] == 'assignment'
    assert shared_model[0]['durationSeconds'] >= 0
    waiting = next(p for p in phases if p['phase'] == 'human_wait')
    assert waiting['durationSeconds'] is None and waiting['endedAt'] is None
    assert event['observations'][0]['state'] == 'applied' and event['observations'][0]['source'] == 'script'
