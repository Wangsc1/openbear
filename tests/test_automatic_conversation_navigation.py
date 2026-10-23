"""Automatic work cannot re-enter recent navigation through the activity inbox."""
import json

import pytest

from tests.test_conversation_activity import start_interaction
from tests.test_recent_conversations import BASE, api, clock, completed_exchange, status
from tests.test_web_admin import _login_cookie, web_env


# 'recommendation' stays a valid legacy origin of existing rows after the feature was removed.
ORIGINS = ['webhook', 'recommendation', 'deployment', 'maintenance']


def navigation_ids(state):
    return {item['conversationUuid'] for item in state['recentItems'] + state['activityItems']}


@pytest.mark.parametrize('origin', ORIGINS)
async def test_automatic_running_unread_and_read_stay_out_until_human_participates(web_env, clock, origin):
    env = web_env
    cookie = await _login_cookie(env)
    folder = (await api(env, cookie, 'POST', '/api/conversation-folders', json={'name': 'Automatic'}))['folder']['folderId']
    row = await env.server._create_web_conversation(123, title='Automatic run', folder_uuid=folder, origin_kind=origin)
    conv_id = row['conversation_uuid']
    await status(env, cookie)

    env.server._web_starting_turns[conv_id] = 'fixture-start'
    try:
        env.server._invalidate_tree_status(123)
        running = await status(env, cookie)
        assert conv_id not in navigation_ids(running)
        assert conv_id in {item['conversationUuid'] for item in running['items']}
        assert running['folderRunningCounts'][folder] == 1
    finally:
        env.server._web_starting_turns.pop(conv_id, None)

    async with env.db.write_transaction() as conn:
        await conn.execute('UPDATE web_conversations SET activity_version=1,activity_read_version=0,activity_result_json=? WHERE conversation_uuid=?',
                           (json.dumps({'status': 'completed', 'atMs': BASE + 100}), conv_id))
    env.server._invalidate_tree_status(123)
    unread = await status(env, cookie)
    assert conv_id not in navigation_ids(unread)
    assert unread['folderConversationCounts'][folder] == 1
    saved = await env.server._conversation_row(123, conv_id)
    assert saved['origin_kind'] == origin and saved['folder_uuid'] == folder
    assert saved['activity_version'] == 1 and saved['activity_read_version'] == 0
    assert saved['last_interaction_at_ms'] == 0

    # Opening and acknowledging a result are not human conversation turns.
    await api(env, cookie, 'GET', f'/api/conversations/{conv_id}/state')
    await api(env, cookie, 'POST', '/api/conversation-tree/read', json={'items': [{'conversationUuid': conv_id, 'version': 1}]})
    assert conv_id not in navigation_ids(await status(env, cookie))
    await completed_exchange(env, row, clock, BASE + 200)
    participated = await status(env, cookie)
    assert conv_id in {item['conversationUuid'] for item in participated['recentItems']}
    assert next(item for item in participated['recentItems'] if item['conversationUuid'] == conv_id)['origin'] == origin

    # Human-participated system conversations retain unread results even after
    # fifteen newer conversations push them out of the recency slice.
    for index in range(15):
        newer = await env.server._create_web_conversation(123, title=f'Newer {index}')
        async with env.db.write_transaction() as conn:
            await conn.execute('UPDATE web_conversations SET last_interaction_at_ms=? WHERE conversation_uuid=?',
                               (BASE + 1000 + index, newer['conversation_uuid']))
    env.server._invalidate_tree_status(123)
    retained = await status(env, cookie)
    assert conv_id not in {item['conversationUuid'] for item in retained['recentItems']}
    assert conv_id in {item['conversationUuid'] for item in retained['activityItems']}


@pytest.mark.parametrize('origin', ORIGINS)
async def test_automatic_pending_confirmation_stays_accessible_outside_recent(web_env, origin):
    env = web_env
    cookie = await _login_cookie(env)
    row = await env.server._create_web_conversation(123, origin_kind=origin)
    conv_id = row['conversation_uuid']
    task, interaction_id = await start_interaction(env, row, {'_sourceTool': 'UserInteraction', 'action': 'confirm'})
    try:
        state = await status(env, cookie)
        assert conv_id not in navigation_ids(state)
        pending = next(item for item in state['items'] if item['conversationUuid'] == conv_id)
        assert pending['activityState'] == 'waiting'
        assert pending['activityPending'][0]['interactionId'] == interaction_id
        bootstrap = await api(env, cookie, 'GET', '/api/conversation-tree/bootstrap')
        assert conv_id not in navigation_ids(bootstrap['running'])
        assert any(item['conversationUuid'] == conv_id and item['activityPending'] for item in bootstrap['running']['items'])
    finally:
        await env.server.interactions.terminate(interaction_id)
        assert (await task)['cancelled'] is True
