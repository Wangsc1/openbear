"""Cron cards preserve trusted origin without rewriting model input or legacy rows."""
import json

import pytest
from tests.test_web_admin import _login_cookie

from app.cron.presentation import enrich_operations
from app.web_operations import web_event_operation_specs
from app.webhooks.repository import one
from tests.test_cron import base_env, cron_env, create, run


def test_cron_source_survives_native_mapping_only_when_explicit():
    card = {'runId': 'run-1', 'name': '定时验收', 'trigger': 'scheduled'}
    event = {'type': 'user', 'source': 'cron', 'messageUuid': 'run-1', 'turnUuid': 'root',
             'text': 'unchanged input', 'cronRunId': 'run-1', 'cronCard': card}
    spec = web_event_operation_specs(event)[0]
    assert spec['source'] == spec['payload']['source'] == 'cron'
    assert spec['payload']['cronCard'] == card
    assert spec['payload']['text'] == 'unchanged input'
    assert spec['payload']['eventTriggered'] is True
    assert 'eventCard' not in spec['payload'] and 'assignmentId' not in spec['payload']
    accepted = web_event_operation_specs({'type': 'accepted', 'source': 'cron', 'turnUuid': 'root'})[0]
    assert accepted['source'] == accepted['payload']['source'] == 'cron'
    event['source'] = 'user'
    ordinary = web_event_operation_specs(event)[0]
    assert ordinary['source'] == 'user' and 'cronCard' not in ordinary['payload']
    assert 'eventTriggered' not in ordinary['payload']


async def test_live_cron_card_is_persisted_with_original_input(cron_env):
    e = cron_env
    job = await create(e, pre={'enabled': True, 'code': "print('PRE_DATA')"})
    result = await run(e, job)
    assert result['status'] == 'completed'
    stored = await one(e.db.conn, "SELECT source,payload_json FROM web_operations WHERE conversation_uuid=? AND op_type='user_message'", (result['conversationId'],))
    payload = json.loads(stored['payload_json'])
    assert stored['source'] == 'cron'
    assert payload['cronRunId'] == result['id']
    assert payload['cronCard']['name'] == job['name']
    assert payload['cronCard']['trigger'] == 'manual'
    assert payload['cronCard']['schedule'] == job['config']['schedule']
    assert payload['text'].startswith(job['config']['instructions'])
    assert 'PRE_DATA' in payload['text']
    page, _ = await e.server._web_operations_page(result['conversationId'], limit=100)
    user = next(op for op in page if op['opType'] == 'user_message')
    assert user['source'] == 'cron' and user['payload']['text'] == payload['text']


async def test_cron_automatic_messages_do_not_bump_human_recency(cron_env):
    e = cron_env
    result = await run(e, await create(e))
    cid, root = result['conversationId'], result['rootTurnId']
    await e.server._tree_ensure_interaction_projection(123)
    current = await one(e.db.conn, 'SELECT last_interaction_at_ms FROM web_conversations WHERE conversation_uuid=?', (cid,))
    assert current['last_interaction_at_ms'] == 0
    row = await e.server._conversation_row(123, cid)
    await e.server._live_for(row).publish({'type': 'user', 'turnUuid': root, 'messageUuid': 'human', 'text': '我来继续', 'interruption': True})
    before = (await one(e.db.conn, 'SELECT last_interaction_at_ms FROM web_conversations WHERE conversation_uuid=?', (cid,)))['last_interaction_at_ms']
    assert before > 0
    await e.server._publish_operation(cid, op_id='assistant:cron-later', op_type='assistant_message', action='end', turn_uuid=root,
        payload={'text': 'automatic continuation'}, status='completed', lifecycle='terminal')
    after = (await one(e.db.conn, 'SELECT last_interaction_at_ms FROM web_conversations WHERE conversation_uuid=?', (cid,)))['last_interaction_at_ms']
    assert before == after
    # A new human turn and its answer remain normal interactions.
    await e.server._publish_operation(cid, op_id='assistant:human-later', op_type='assistant_message', action='end', turn_uuid='new-human-root',
        payload={'text': 'human follow-up answer'}, status='completed', lifecycle='terminal')
    answer = await one(e.db.conn, 'SELECT payload_json,created_at_ms FROM web_operations WHERE conversation_uuid=? AND op_id=?', (cid, 'assistant:human-later'))
    assert not json.loads(answer['payload_json']).get('eventTriggered')


@pytest.mark.parametrize('has_human', [False, True])
async def test_legacy_recency_rebuild_changes_only_projection_and_keeps_humans(cron_env, has_human):
    e = cron_env
    result = await run(e, await create(e))
    cid = result['conversationId']
    if has_human:
        await e.server._publish_operation(cid, op_id='msg:human', op_type='user_message', action='create', turn_uuid=result['rootTurnId'],
            payload={'text': 'a genuine correction'}, status='completed', lifecycle='terminal', source='user')
    await e.db.conn.execute("UPDATE web_operations SET payload_json=json_remove(payload_json,'$.eventTriggered') WHERE conversation_uuid=?", (cid,))
    await e.db.conn.execute('UPDATE web_conversations SET last_interaction_at_ms=9999999999999 WHERE conversation_uuid=?', (cid,))
    await e.db.conn.commit()
    before = await (await e.db.conn.execute('SELECT op_id,payload_json FROM web_operations WHERE conversation_uuid=? ORDER BY op_id', (cid,))).fetchall()
    e.server._tree_projection_ready = set()
    await e.server._tree_ensure_interaction_projection(123)
    value = (await one(e.db.conn, 'SELECT last_interaction_at_ms FROM web_conversations WHERE conversation_uuid=?', (cid,)))['last_interaction_at_ms']
    expected = (await one(e.db.conn, "SELECT created_at_ms FROM web_operations WHERE conversation_uuid=? AND op_id='msg:human'", (cid,)))['created_at_ms'] if has_human else 0
    assert value == expected
    after = await (await e.db.conn.execute('SELECT op_id,payload_json FROM web_operations WHERE conversation_uuid=? ORDER BY op_id', (cid,))).fetchall()
    assert [tuple(row) for row in before] == [tuple(row) for row in after]
    # Existing visibility/timestamp re-projection must also exclude legacy Cron
    # inputs and replies, not resurrect them when the human text is hidden.
    if has_human:
        await e.server._publish_operation(cid, op_id='msg:human', op_type='user_message', action='patch', turn_uuid=result['rootTurnId'],
            payload={'hidden': True}, status='completed', lifecycle='terminal')
        assert (await one(e.db.conn, 'SELECT last_interaction_at_ms FROM web_conversations WHERE conversation_uuid=?', (cid,)))['last_interaction_at_ms'] == 0


async def test_legacy_read_enrichment_matches_exact_run_and_keeps_storage_unchanged(cron_env):
    e = cron_env
    job = await create(e)
    result = await run(e, job)
    cid = result['conversationId']
    await e.db.conn.execute("UPDATE web_operations SET source='user',payload_json=json_remove(payload_json,'$.source','$.cronRunId','$.cronCard') WHERE conversation_uuid=? AND op_type='user_message'", (cid,))
    await e.db.conn.commit()
    before = await one(e.db.conn, "SELECT source,payload_json FROM web_operations WHERE conversation_uuid=? AND op_type='user_message'", (cid,))
    cookies = {'openbear_web_session': await _login_cookie(e)}
    response = await e.client.get(f'/api/conversations/{cid}/operations/msg:{result["id"]}/window', cookies=cookies)
    assert response.status == 200
    search_window = (await response.json())['operations']
    for ops in [await e.server._web_operations(cid), (await e.server._web_operations_page(cid, limit=100))[0], search_window]:
        user = next(op for op in ops if op['opType'] == 'user_message')
        assert user['source'] == 'cron'
        assert user['payload']['cronCard']['runId'] == result['id']
        assert user['payload']['text'] == json.loads(before['payload_json'])['text']
    after = await one(e.db.conn, "SELECT source,payload_json FROM web_operations WHERE conversation_uuid=? AND op_type='user_message'", (cid,))
    assert before == after
    # A later human message is not a Cron input merely because it shares a chat
    # or contains the task marker. A mismatching root is not reclassified either.
    ordinary = {'opType': 'user_message', 'opId': 'msg:human', 'turnId': result['rootTurnId'], 'source': 'user', 'payload': {'text': '[定时] 定时测试'}}
    wrong_root = {**ordinary, 'opId': 'msg:' + result['id'], 'turnId': 'human-root'}
    for operations, conversation in [([ordinary, wrong_root], cid), ([{**wrong_root, 'turnId': result['rootTurnId']}], 'another-conversation')]:
        await enrich_operations(e.db.conn, operations, conversation)
        assert all(op['source'] == 'user' and 'cronCard' not in op['payload'] for op in operations)
