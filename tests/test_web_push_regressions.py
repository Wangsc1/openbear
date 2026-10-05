"""Regression coverage for the notification audit's actual runtime boundaries."""
import asyncio
import json
import sqlite3
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.db.engine import DB
from app.tools.base import ToolRegistry
from app.user_interactions import InteractionService
from app.web_admin import WebAdminServer, _WebStreamRenderer, _sha256
from app.web_push import BrowserPush
from tests.test_web_admin import _cfg, FakeBot, FakeRunFactory, FakeStreamBackend
from tests.test_web_push import add_device, add_interaction, deliveries


@pytest.fixture
async def env(tmp_path):
    db = DB(str(tmp_path / 'push-regressions.db'))
    await db.connect()
    await db.conn.execute('INSERT INTO web_sessions(session_token_hash,chat_id,expires_at) VALUES(?,?,?)', (_sha256('token'), 123, int(time.time()) + 3600))
    await db.conn.commit()
    await add_device(db)
    host = WebAdminServer(_cfg(), db, FakeBot())
    host.tools = ToolRegistry()
    host.llm_factory = FakeRunFactory(FakeStreamBackend(), context_window=128000)
    host.browser_push.send = AsyncMock(return_value=201)
    conv = await host._create_web_conversation(123, title='通知回归', model='openai/gpt')
    yield SimpleNamespace(db=db, host=host, conv=conv)
    await host.browser_push.stop()
    await db.close()


async def test_real_stop_never_generates_completed_push(env, monkeypatch):
    h, row = env.host, env.conv
    live, started = h._live_for(row), asyncio.Event()
    async def blocked_prompt():
        started.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(h, '_build_system_prompt_for_chat', blocked_prompt)
    await live.publish({'type': 'accepted', 'turnUuid': 'stop-root', 'runUuid': 'stop-root'})
    q = live.subscribe()
    task = asyncio.create_task(h._run_web_turn(row['internal_chat_id'], '执行任务', _WebStreamRenderer(live), conversation=row, root_turn_uuid='stop-root'))
    h.runs.register(row['internal_chat_id'], task)
    await asyncio.wait_for(started.wait(), 3)
    result = await h._stop_web_conversation(row)
    await task
    events = []
    while not q.empty():
        events.append(q.get_nowait()['type'])
    assert result['stoppedRun'] is True
    assert events.count('stopped') == 1 and 'done' not in events
    assert not await deliveries(env.db)
    run = await (await env.db.conn.execute("SELECT status FROM web_push_runs WHERE root_uuid='stop-root'")).fetchone()
    assert run['status'] == 'stopped'
    await h.browser_push.recover()
    assert not await deliveries(env.db)


@pytest.mark.parametrize('resolution', ['cancelled', 'answered'])
async def test_resolved_during_created_lookup_cannot_reinsert(env, monkeypatch, resolution):
    push, service = env.host.browser_push, InteractionService(env.db)
    service.add_listener(push.on_interaction)
    started, release = asyncio.Event(), asyncio.Event()
    original = push.subscriptions
    async def blocked_subscriptions(owner):
        rows = await original(owner)
        started.set()
        await release.wait()
        return rows
    monkeypatch.setattr(push, 'subscriptions', blocked_subscriptions)
    request = asyncio.create_task(service.request({'action': 'confirm', 'title': '隔离问题'}, owner_chat_id=123, conversation_uuid=env.conv['conversation_uuid']))
    await asyncio.wait_for(started.wait(), 3)
    iid = next(iter(service.pending))
    if resolution == 'cancelled':
        await service.terminate(iid, 'cancelled')
    else:
        await service.submit(iid, owner_chat_id=123, answer={'confirmed': True}, source='web')
    release.set()
    result = await asyncio.wait_for(request, 3)
    assert result['status'] == resolution
    assert not await deliveries(env.db)
    assert not await push.deliver_one()
    push.send.assert_not_called()


@pytest.mark.parametrize('state', ['cancelled', 'answered', 'expired'])
async def test_delivery_rechecks_interaction_even_if_resolved_listener_failed(env, state):
    p, db, conv = env.host.browser_push, env.db, env.conv['conversation_uuid']
    await add_interaction(db, conversation=conv)
    await p.on_interaction('created', {'ownerChatId': 123, 'conversationUuid': conv, 'interactionId': 'question'})
    if state == 'expired':
        await db.conn.execute("UPDATE user_interactions SET expires_at_ms=1")
    else:
        await db.conn.execute("UPDATE user_interactions SET status=?", (state,))
    await db.conn.commit()
    await p.deliver_one()
    p.send.assert_not_called()
    row = (await deliveries(db))[0]
    assert (row['state'], row['last_error'], row['attempts']) == ('suppressed', 'interaction_inactive', 0)


@pytest.mark.parametrize('terminal,expected', [('done', 'completed'), ('error', 'failed'), ('stopped', 'stopped')])
async def test_post_commit_observer_fault_recovers_once_with_frozen_duration(env, monkeypatch, terminal, expected):
    h, db = env.host, env.db
    live = h._live_for(env.conv)
    started = (int(time.time()) - 192) * 1000
    await live.publish({'type': 'accepted', 'turnUuid': 'gap-root', 'runUuid': 'gap-root', 'ts': started})
    original = h.browser_push.observe
    async def fail_terminal(event, **kwargs):
        if event.get('type') == terminal:
            raise RuntimeError('isolated post-commit fault')
        return await original(event, **kwargs)
    monkeypatch.setattr(h.browser_push, 'observe', fail_terminal)
    await live.publish({'type': terminal})
    assert not await deliveries(db)
    operation = await (await db.conn.execute("SELECT payload_json FROM web_operations WHERE op_id='run:gap-root'")).fetchone()
    ended = json.loads(operation['payload_json'])['terminalAtMs'] // 1000
    h.browser_push = p = BrowserPush(db)
    p.send = AsyncMock(return_value=503)
    await p.recover()
    await p.recover()
    run = await (await db.conn.execute("SELECT status FROM web_push_runs WHERE root_uuid='gap-root'")).fetchone()
    assert run['status'] == expected
    rows = await deliveries(db)
    if terminal == 'stopped':
        assert not rows
        return
    assert len(rows) == 1 and rows[0]['created_at'] == ended
    payload = json.loads(rows[0]['payload_json'])
    assert payload['kind'] == expected
    assert payload['body'] == p.payload(expected, env.conv['conversation_uuid'], 'run:gap-root',
                                        task_title='通知回归', elapsed_seconds=ended - started // 1000)['body']
    await p.deliver_one()
    await db.conn.execute('UPDATE web_push_deliveries SET next_attempt_at=0')
    await db.conn.commit()
    p.send = AsyncMock(return_value=201)
    await p.deliver_one()
    assert p.send.call_args.args[1] == payload
    assert (await deliveries(db))[0]['state'] == 'accepted'


async def test_recovery_does_not_invent_success_or_revive_expired_alert(env, monkeypatch):
    h, db = env.host, env.db
    live = h._live_for(env.conv)
    await live.publish({'type': 'accepted', 'turnUuid': 'active', 'runUuid': 'active'})
    await h.browser_push.recover()
    assert not await deliveries(db)
    monkeypatch.setattr(h.browser_push, 'observe', AsyncMock(side_effect=RuntimeError('gap')))
    await live.publish({'type': 'done'})
    row = await (await db.conn.execute("SELECT payload_json FROM web_operations WHERE op_id='run:active'")).fetchone()
    payload = json.loads(row['payload_json'])
    payload['terminalAtMs'] = (int(time.time()) - 1000) * 1000
    await db.conn.execute("UPDATE web_operations SET payload_json=? WHERE op_id='run:active'", (json.dumps(payload),))
    await db.conn.commit()
    await h.browser_push.recover()
    assert not await deliveries(db)
    run = await (await db.conn.execute("SELECT status FROM web_push_runs WHERE root_uuid='active'")).fetchone()
    assert run['status'] == 'completed'


async def test_startup_invalidates_old_interactions_before_worker(env):
    h, db, conv = env.host, env.db, env.conv['conversation_uuid']
    await add_interaction(db, conversation=conv)
    await h.browser_push.on_interaction('created', {'ownerChatId': 123, 'conversationUuid': conv, 'interactionId': 'question'})
    assert await deliveries(db)
    context = h._web_push_context(None)
    await anext(context)
    assert not await deliveries(db)
    h.browser_push.send.assert_not_called()
    row = await (await db.conn.execute('SELECT status FROM user_interactions')).fetchone()
    assert row['status'] == 'interrupted'
    await context.aclose()


async def test_page_presence_aggregation_and_delivery_observations(env):
    from app.webhooks.notifications import channel_delivery_states
    p, db, conv = env.host.browser_push, env.db, env.conv['conversation_uuid']
    sub = (await p.subscriptions(123))[0]
    p.set_presence(sub['id'], 'focused-a', conv)
    p.set_presence(sub['id'], 'background-b', '')
    p.set_presence(sub['id'], 'other-c', 'other-conversation')
    await p.enqueue(123, conv, 'quiet', 'completed')
    await p.deliver_one()
    p.send.assert_not_called()
    row = (await deliveries(db))[0]
    assert (row['state'], row['attempts'], row['last_status'], row['last_error']) == ('suppressed', 0, 0, 'foreground')
    p.set_presence(sub['id'], 'focused-a', '')
    p.send = AsyncMock(return_value=403)
    await p.enqueue(123, conv, 'rejected', 'completed')
    await p.deliver_one()
    row = (await deliveries(db))[1]
    assert (row['state'], row['last_status'], row['last_error']) == ('failed', 403, 'provider_http_403')
    service = SimpleNamespace(db=db)
    assert await channel_delivery_states(service, 'rejected') == [{'channel': 'browser_push', 'state': 'failed', 'error': 'provider_http_403', 'providerStatus': 403, 'verificationRequired': False, 'deviceReceipt': 'unavailable'}]
    p.presence[sub['id']]['expired-page'] = (conv, time.monotonic() - 1)
    p.send = AsyncMock(return_value=201)
    await p.enqueue(123, conv, 'accepted', 'completed')
    await p.deliver_one()
    assert p.send.await_count == 1 and (await deliveries(db))[2]['state'] == 'accepted'
    assert 'expired-page' not in p.presence[sub['id']]


async def test_periodic_prune_preserves_live_runs_and_recent_records(env):
    h, p, db = env.host, env.host.browser_push, env.db
    conv, now = env.conv['conversation_uuid'], int(time.time())
    live = h._live_for(env.conv)
    await live.publish({'type': 'accepted', 'turnUuid': 'live', 'runUuid': 'live'})
    for root, status, age in [('orphan', 'running', 8 * 86400), ('terminal', 'completed', 8 * 86400), ('recent', 'completed', 60)]:
        await db.conn.execute('INSERT INTO web_push_runs VALUES(?,?,?,?,?)', (root, conv, 123, status, now - age))
    await db.conn.execute("UPDATE web_push_runs SET created_at=? WHERE root_uuid='live'", (now - 8 * 86400,))
    await db.conn.commit()
    await p.enqueue(123, conv, 'old', 'completed')
    await p.enqueue(123, conv, 'new', 'completed')
    await db.conn.execute("UPDATE web_push_deliveries SET created_at=? WHERE event_key='old'", (now - 86401,))
    await db.conn.commit()
    assert await p.prune() == (2, 1)
    roots = {r['root_uuid'] for r in await (await db.conn.execute('SELECT root_uuid FROM web_push_runs')).fetchall()}
    assert roots == {'live', 'recent'}
    assert [r['event_key'] for r in await deliveries(db)] == ['new']
    assert await p.prune() == (0, 0)


async def test_legacy_delivery_schema_migration_preserves_uncertain_sent(tmp_path):
    path = str(tmp_path / 'legacy.db')
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE web_push_deliveries (id INTEGER PRIMARY KEY,subscription_id INTEGER,event_key TEXT,payload_json TEXT,attempts INTEGER DEFAULT 0,next_attempt_at INTEGER,created_at INTEGER,state TEXT DEFAULT 'pending',UNIQUE(subscription_id,event_key))")
        conn.execute("INSERT INTO web_push_deliveries VALUES(1,1,'legacy','{}',1,1,1,'sent')")
    db = DB(path)
    await db.connect()
    row = (await deliveries(db))[0]
    assert (row['state'], row['last_status'], row['last_error']) == ('sent', 0, '')
    await db.close()
