"""Simplified Webhook target/context/observation APIs on isolated real HTTP + SQLite."""
import json

import pytest

from app.webhooks.repository import one
from app.webhooks.telemetry import observe
from tests.test_web_admin import _login_cookie
from tests.test_webhooks_backend import env, create, accept


async def get(env, path, **params):
    response = await env.client.get(path, params=params, cookies={'openbear_web_session': await _login_cookie(env)})
    assert response.status == 200, await response.text()
    return await response.json()


async def target_tree(env):
    folders = [
        ('late', 'folder', 'Same folder', 20, 0, 100, 123),
        ('early', 'folder', 'Same folder', 10, 0, 100, 123),
        ('pinned', 'folder', 'ZZ pinned folder', 999, 1, 100, 123),
        ('deep', 'early', 'Deep', None, 0, 100, 123),
        ('deeper', 'deep', 'Deeper', None, 0, 100, 123),
        ('outside', '', 'Other root', None, 0, 100, 123),
        ('private', '', 'Private', None, 0, 100, 999),
    ]
    for fid, parent, name, order, pinned, created, owner in folders:
        await env.db.conn.execute('INSERT INTO web_conversation_folders(folder_uuid,parent_uuid,name,display_order,pinned_at,created_at,owner_chat_id) VALUES(?,?,?,?,?,?,?)', (fid, parent, name, order, pinned, created, owner))
    await env.db.conn.commit()
    specs = [
        ('same-late', 'folder', 'Same conversation', 20, 0, 100, 0, 123),
        ('same-early', 'folder', 'Same conversation', 10, 0, 100, 0, 123),
        ('pinned-conv', 'folder', 'ZZ pinned conversation', 999, 1, 100, 0, 123),
        ('unordered-old', 'folder', 'AA old', None, 0, 100, 0, 123),
        ('unordered-new', 'folder', 'ZZ new', None, 0, 500, 0, 123),
        ('tie-first', 'folder', 'Same tie', 40, 0, 100, 0, 123),
        ('tie-second', 'folder', 'Same tie', 40, 0, 100, 0, 123),
        ('needle', 'deeper', 'Needle conversation', 10, 0, 100, 0, 123),
        ('early-conv', 'early', 'Early child', 10, 0, 100, 0, 123),
        ('late-conv', 'late', 'Late child', 10, 0, 100, 0, 123),
        ('archived', 'deeper', 'Needle archived', 0, 1, 100, 500, 123),
        ('cross-root', 'outside', 'Needle other root', 0, 1, 100, 0, 123),
        ('temporary', '', 'Needle unfiled', 0, 1, 100, 0, 123),
        ('other-owner', 'private', 'Needle private', 0, 1, 100, 0, 999),
    ]
    for cid, folder, title, order, pinned, created, archived, owner in specs:
        await env.server._create_web_conversation(owner, conversation_uuid=cid, title=title, folder_uuid=folder)
        await env.db.conn.execute('UPDATE web_conversations SET display_order=?,pinned_at=?,created_at=?,archived_at=? WHERE conversation_uuid=?', (order, pinned, created, archived, cid))
        await env.db.conn.commit()


async def test_targets_folder_scope_matches_authoritative_tree_order(env):
    await target_tree(env)
    result = await get(env, '/api/webhooks/targets', scopeType='folder', scopeId='folder')
    items = result['items']
    assert items[0]['id'] == 'folder' and items[0]['parentId'] == ''
    assert {i['id'] for i in items}.isdisjoint({'outside', 'private', 'cross-root', 'temporary', 'archived', 'other-owner'})
    # Compare each branch to the actual ordinary conversation-tree HTTP endpoint,
    # rather than creating a different comparator in this test or the frontend.
    for fid in ('folder', 'early', 'deep', 'deeper', 'late', 'pinned'):
        normal = await get(env, '/api/conversation-tree/children', parentId=fid, limit=100)
        expected = [(i['kind'], i['id']) for i in normal['items']]
        actual = [(i['type'], i['id']) for i in items if i['parentId'] == fid]
        assert actual == expected, (fid, actual, expected)
    root_ids = [i['id'] for i in items if i['parentId'] == 'folder']
    assert root_ids == ['pinned', 'early', 'late', 'pinned-conv', 'same-early', 'same-late', 'tie-second', 'tie-first', 'unordered-new', 'unordered-old']
    assert all(not i['selectable'] for i in items if i['type'] == 'folder')
    assert all(i['selectable'] and i['available'] for i in items if i['type'] == 'conversation')
    # Existing callers that passed only scopeId remain scoped, not globally listed.
    assert (await get(env, '/api/webhooks/targets', scopeId='folder'))['items'] == items
    print('SIMPLIFIED_TARGET_ORDER', json.dumps(root_ids))


@pytest.mark.parametrize('selected', ['cross-root', 'archived', 'temporary', 'other-owner'])
async def test_target_search_keeps_only_legal_ancestors_and_never_injects_selected(env, selected):
    await target_tree(env)
    result = await get(env, '/api/webhooks/targets', scopeType='folder', scopeId='folder', search=' nEeDlE ', selectedId=selected)
    assert [i['id'] for i in result['items']] == ['folder', 'early', 'deep', 'deeper', 'needle']
    ids = {i['id'] for i in result['items']}
    assert all(not i['parentId'] or i['parentId'] in ids for i in result['items'])
    # An in-scope selected conversation can remain visible during remote search.
    legal = await get(env, '/api/webhooks/targets', scopeId='folder', search='Needle', selectedId='same-late')
    assert [i['id'] for i in legal['items']] == ['folder', 'early', 'deep', 'deeper', 'needle', 'same-late']


async def test_conversation_target_is_only_itself_and_scope_is_authorized(env):
    await target_tree(env)
    result = await get(env, '/api/webhooks/targets', scopeType='conversation', scopeId='same-early', search='Needle', selectedId='needle')
    assert [i['id'] for i in result['items']] == ['same-early']
    assert result['items'][0]['parentId'] == ''
    cookies = {'openbear_web_session': await _login_cookie(env)}
    for kind, identifier in [('folder', 'private'), ('folder', 'missing'), ('conversation', 'other-owner'), ('conversation', 'archived')]:
        response = await env.client.get('/api/webhooks/targets', params={'scopeType': kind, 'scopeId': identifier}, cookies=cookies)
        assert response.status == 404
    response = await env.client.get('/api/webhooks/targets', params={'scopeType': 'conversation'}, cookies=cookies)
    assert response.status == 422


async def test_conversation_properties_no_snapshot_computation_or_mutation(env, monkeypatch):
    row = await env.server._create_web_conversation(123, folder_uuid='folder', title='Local properties')
    await env.db.conn.execute("UPDATE web_conversation_folders SET prompt_markdown='Inherited context' WHERE folder_uuid='folder'")
    await env.db.conn.execute('UPDATE sessions SET system_snapshot=? WHERE chat_id=?', ('Frozen system prompt must stay byte-for-byte.', row['internal_chat_id']))
    await env.db.conn.commit()
    before = await one(env.db.conn, 'SELECT * FROM sessions WHERE chat_id=?', (row['internal_chat_id'],))
    async def forbidden_candidate(*args, **kwargs):
        raise AssertionError('Properties must not build a prompt candidate or refresh a frozen session')
    monkeypatch.setattr(env.server, '_build_system_prompt_for_chat', forbidden_candidate)
    async def forbidden_history(*args, **kwargs):
        raise AssertionError('Properties must not load conversation history or model/tool-call ledgers')
    for name in ('_chat_payload', '_web_operations', '_chat_model_calls', '_chat_tool_calls'):
        monkeypatch.setattr(env.server, name, forbidden_history)
    url = '/api/conversations/' + row['conversation_uuid'] + '/properties'
    result = await get(env, url)
    assert set(result) == {'properties', 'runConfig'}
    assert result['runConfig'] == await env.server._conversation_run_config_public(123, row['conversation_uuid'])
    assert result['runConfig']['conversationUuid'] == row['conversation_uuid']
    assert result['runConfig']['model'] == row['model']
    assert len(json.dumps(result)) < 6000
    initial = result['properties']
    assert initial['contextMode'] == 'inherit' and initial['contextText'] == ''
    assert initial['inheritedContext'] == initial['effectiveContext'] == 'Inherited context'
    assert 'snapshotFrozen' not in initial and 'snapshotUpdateRequired' not in initial
    cookies = {'openbear_web_session': await _login_cookie(env)}
    for mode, text, effective in [('override', 'Local text', 'Local text'), ('inherit', '', 'Inherited context')]:
        response = await env.client.put(url, json={'contextText': text}, cookies=cookies)
        assert response.status == 200
        saved = (await response.json())['properties']
        assert saved['contextMode'] == mode and saved['contextText'] == text and saved['effectiveContext'] == effective
        assert 'snapshotFrozen' not in saved and 'snapshotUpdateRequired' not in saved
        assert (await get(env, url))['properties'] == saved
    assert await one(env.db.conn, 'SELECT * FROM sessions WHERE chat_id=?', (row['internal_chat_id'],)) == before
    response = await env.client.put(url, json={'contextMode': 'bad'}, cookies=cookies)
    assert response.status == 422
    print('SIMPLIFIED_CONTEXT', json.dumps({'getPut': True, 'promptCandidateCalls': 0, 'sessionUnchanged': True}))


async def test_observations_have_no_product_test_branch_and_keep_historical_identity(env):
    c = await create(env, statistics={'businessFields': [{'name': 'sender', 'path': 'body.sender'}]})
    accepted = await accept(env, c, '{"sender":"ordinary"}')
    payload = {'operationId': 'ordinary-observation', 'records': [{'fields': {'sender': 'ordinary'}}]}
    await observe(env.s, c['endpoint']['id'], payload, source='script', event_id=accepted['eventId'])
    # Historical flags are immutable schema residue, not a retained product mode.
    # Seed only this isolated fixture to verify queries no longer route by them.
    async with env.db.webhook_transaction() as conn:
        await conn.execute('UPDATE webhook_telemetry_operations SET is_test=1 WHERE operation_id=?', ('ordinary-observation',))
    before = await one(env.db.conn, 'SELECT * FROM webhook_events WHERE event_id=?', (accepted['eventId'],))
    details = await get(env, '/api/webhooks/events/' + accepted['eventId'])
    assert 'test' not in details['event'] and 'test' not in details['event']['observations'][0]
    args = {'endpointId': c['endpoint']['id'], 'view': 'business'}
    business = await get(env, '/api/webhooks/statistics', **args)
    assert len(business['items']) == 1 and 'test' not in business['items'][0]
    # Removed query knobs have no remaining branch.
    for value in ('true', 'false'):
        assert (await get(env, '/api/webhooks/statistics', **args, includeTests=value))['items'] == business['items']
    ranked = await get(env, '/api/webhooks/statistics', endpointId=c['endpoint']['id'], view='ranking', field='sender')
    assert ranked['items'][0]['value'] == 'ordinary' and ranked['items'][0]['count'] == 1
    assert await one(env.db.conn, 'SELECT * FROM webhook_events WHERE event_id=?', (accepted['eventId'],)) == before
    assert (await one(env.db.conn, 'SELECT is_test FROM webhook_telemetry_operations'))['is_test'] == 1
