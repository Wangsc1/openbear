"""Gateway push: real HTTP session checks, captured (never external) provider sends."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import secrets
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from app.config import load_config
from app.db.engine import DB
from app.web_push import BrowserPush
from app.webhooks.repository import many, one
from tests.test_managed_gateway import gateway  # noqa: F401
from tests.test_managed_runtime import runtime  # noqa: F401
from tests.test_web_push import subscription


async def stop_worker(push):
    if push.task:
        push.task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await push.task
        push.task = None


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


@pytest.fixture
async def env(gateway):  # noqa: F811
    r = gateway
    push = r.svc.web_admin.browser_push
    await stop_worker(push)
    push._send_provider = AsyncMock(return_value=201)
    state = SimpleNamespace(active=True, result='normal', checks=[], redirects=0, expires=int(time.time()) + 3600)

    async def check(request):
        assert request.headers['Authorization'] == 'Bearer ' + r.svc.config.managed.gateway_key
        assert request.headers['X-OpenBear-Instance'] == r.svc.config.managed.instance_id
        assert 'Cookie' not in request.headers
        state.checks.append(request.headers['X-OpenBear-Gateway-Session-Hash'])
        if getattr(state, 'before_reply', None):
            await state.before_reply()
        if state.result == 'redirect':
            raise web.HTTPFound('/not-followed')
        if isinstance(state.result, int):
            return web.Response(status=state.result)
        if state.result == 'malformed':
            return web.json_response({'ok': True, 'active': 'true', 'expiresAt': state.expires})
        return web.json_response({'ok': True, 'active': state.active, 'expiresAt': state.expires if state.active else 0},
                                 headers={'Cache-Control': 'no-store'})

    async def redirected(request):
        state.redirects += 1
        return web.json_response({'ok': True, 'active': True, 'expiresAt': state.expires})

    app = web.Application()
    app.router.add_get('/api/gateway/v1/session-status', check)
    app.router.add_get('/not-followed', redirected)
    server = TestServer(app)
    await server.start_server()
    r.push = push
    r.status = state
    r.gateway_server = server
    r.auth = {**r.auth, 'X-OpenBear-Gateway-Origin': str(server.make_url('')).rstrip('/'),
              'X-OpenBear-Gateway-Expires': str(state.expires)}
    r.info = subscription()
    try:
        yield r
    finally:
        await server.close()


async def register(r, *, headers=None, info=None):
    response = await r.client.post('/api/push/subscription', headers=headers or r.auth,
        json={'subscription': info or r.info, 'origin': 'http://untrusted-body.invalid', 'expiresAt': 999999999999})
    assert response.status == 200
    return await one(r.svc.db.conn, 'SELECT * FROM web_push_subscriptions WHERE endpoint=?', ((info or r.info)['endpoint'],))


async def test_gateway_push_registration_presence_rebind_and_unsubscribe(env):
    r = env
    first = await register(r, headers={**r.auth, 'Origin': 'http://untrusted-browser.invalid'})
    expected = digest(r.auth['X-OpenBear-Gateway-Session'])
    assert first['session_token_hash'] == expected
    assert expected not in {digest(''), digest(r.svc.config.managed.gateway_key)}
    binding = await one(r.svc.db.conn, 'SELECT * FROM managed_push_sessions')
    assert binding['origin'] == r.auth['X-OpenBear-Gateway-Origin'] == first['origin']
    assert binding['expires_at'] == r.status.expires
    assert not await many(r.svc.db.conn, 'SELECT * FROM web_sessions')
    assert r.auth['X-OpenBear-Gateway-Session'] not in str(binding)
    for headers, enabled in ((r.auth, True), ({**r.auth, 'X-OpenBear-Gateway-Session': secrets.token_urlsafe(24)}, False)):
        response = await r.client.post('/api/push/status', headers=headers, json={'endpoint': r.info['endpoint']})
        assert response.status == 200 and (await response.json())['enabled'] is enabled
    other = {**r.auth, 'X-OpenBear-Gateway-Session': secrets.token_urlsafe(24)}
    for headers in (r.auth, other):
        response = await r.client.post('/api/push/presence', headers=headers, json={
            'endpoint': r.info['endpoint'], 'clientId': headers['X-OpenBear-Gateway-Session'], 'conversationUuid': 'visible'})
        assert response.status == 200
    assert list(r.push.presence[first['id']]) == [r.auth['X-OpenBear-Gateway-Session']]
    await r.client.delete('/api/push/subscription', headers=other, json={'endpoint': r.info['endpoint']})
    assert await one(r.svc.db.conn, 'SELECT * FROM web_push_subscriptions')
    await r.push.enqueue(1, '', 'before-rebind', 'completed')
    assert await one(r.svc.db.conn, 'SELECT * FROM web_push_deliveries')
    second = await register(r, headers=other)
    assert second['id'] != first['id'] and second['session_token_hash'] == digest(other['X-OpenBear-Gateway-Session'])
    assert not await many(r.svc.db.conn, 'SELECT * FROM web_push_deliveries')
    assert first['id'] not in r.push.presence
    await r.client.delete('/api/push/subscription', headers=r.auth, json={'endpoint': r.info['endpoint']})
    assert await one(r.svc.db.conn, 'SELECT * FROM web_push_subscriptions')
    await r.client.delete('/api/push/subscription', headers=other, json={'endpoint': r.info['endpoint']})
    assert not await many(r.svc.db.conn, 'SELECT * FROM web_push_subscriptions')


@pytest.mark.parametrize('change', [
    {'X-OpenBear-Gateway-Origin': ''}, {'X-OpenBear-Gateway-Origin': 'http://bad.example/path'},
    {'X-OpenBear-Gateway-Expires': '0'}, {'X-OpenBear-Gateway-Expires': 'invalid'},
    {'X-OpenBear-Gateway-Expires': '9' * 32}, {'X-OpenBear-Gateway-Key': 'wrong'},
    {'X-OpenBear-Instance': 'another-instance'},
])
async def test_push_binding_requires_authenticated_valid_gateway_metadata(env, change):
    r = env
    response = await r.client.post('/api/push/subscription', headers={**r.auth, **change}, json={'subscription': r.info})
    assert response.status in {401, 403}
    assert not await many(r.svc.db.conn, 'SELECT * FROM managed_push_sessions')
    assert not await many(r.svc.db.conn, 'SELECT * FROM web_push_subscriptions')


async def test_management_bearer_cannot_mint_push_session(env):
    r = env
    for path in ('/api/push/subscription', '/api/push/status', '/api/push/presence', '/api/push/test'):
        response = await r.client.post(path, headers=r.management, json={'subscription': r.info})
        assert response.status == 403
    assert not await many(r.svc.db.conn, 'SELECT * FROM managed_push_sessions')
    assert not await many(r.svc.db.conn, 'SELECT * FROM web_sessions')


@pytest.mark.parametrize('kind', ['completed', 'failed', 'interrupted', 'interaction', 'test'])
async def test_every_gateway_delivery_checks_live_session_and_carries_instance_id(env, kind):
    r = env
    row = await register(r)
    if kind == 'interaction':
        now = int(time.time() * 1000)
        await r.svc.db.conn.execute('''INSERT INTO user_interactions
            (interaction_id,owner_chat_id,conversation_uuid,expires_at_ms,created_at_ms,payload_json)
            VALUES('push-check',1,'conv',?,?,'{}')''', (now + 60000, now))
        await r.svc.db.conn.commit()
        await r.push.on_interaction('created', {'interactionId': 'push-check', 'ownerChatId': 1, 'conversationUuid': 'conv'})
    elif kind == 'completed':
        for event in ('accepted', 'done'):
            await r.push.observe({'type': event, 'runUuid': 'push-turn', 'conversationUuid': 'conv'}, owner_chat_id=1, internal_chat_id=-1)
    elif kind != 'test':
        await r.push.enqueue(1, 'conv', 'proof:' + kind, kind)
    if kind == 'test':
        response = await r.client.post('/api/push/test', headers=r.auth, json={'endpoint': r.info['endpoint']})
        assert response.status == 200
    else:
        queued = await one(r.svc.db.conn, 'SELECT * FROM web_push_deliveries')
        assert json.loads(queued['payload_json'])['instanceId'] == r.svc.config.managed.instance_id
        assert await r.push.deliver_one()
        assert (await one(r.svc.db.conn, 'SELECT * FROM web_push_deliveries'))['state'] == 'accepted'
    assert r.status.checks == [row['session_token_hash']]
    payload = r.push._send_provider.call_args.args[1]
    assert payload['instanceId'] == r.svc.config.managed.instance_id and payload['kind'] == kind
    assert r.svc.config.managed.gateway_key not in json.dumps(payload)
    # No positive cache: a second test send must recheck, then suppress on revoke.
    r.status.active = False
    response = await r.client.post('/api/push/test', headers=r.auth, json={'endpoint': r.info['endpoint']})
    assert response.status == 409 and (await response.json())['error'] == 'gateway_session_inactive'
    assert len(r.status.checks) == 2 and r.push._send_provider.call_count == 1
    assert (await one(r.svc.db.conn, 'SELECT * FROM managed_push_sessions'))['revoked_at'] > 0
    assert not await r.push.subscriptions(1)


async def test_gateway_inactive_suppresses_all_pending_for_that_session(env):
    r = env
    await register(r)
    await r.push.enqueue(1, 'conv', 'one', 'completed')
    await r.push.enqueue(1, 'conv', 'two', 'failed')
    r.status.active = False
    assert await r.push.deliver_one()
    rows = await many(r.svc.db.conn, 'SELECT state,last_error FROM web_push_deliveries')
    assert all(x == {'state': 'suppressed', 'last_error': 'gateway_session_inactive'} for x in rows)
    r.push._send_provider.assert_not_called()


@pytest.mark.parametrize('result', [503, 401, 'redirect', 'malformed'])
async def test_gateway_status_fail_closed_retries_without_external_push(env, result):
    r = env
    await register(r)
    await r.push.enqueue(1, 'conv', 'outage', 'completed')
    r.status.result = result
    assert await r.push.deliver_one()
    failed = await one(r.svc.db.conn, 'SELECT * FROM web_push_deliveries')
    assert failed['state'] == 'pending' and failed['attempts'] == 1
    assert failed['last_error'] == 'GatewaySessionUnavailable'
    r.push._send_provider.assert_not_called()
    response = await r.client.post('/api/push/test', headers=r.auth, json={'endpoint': r.info['endpoint']})
    assert response.status == 503
    assert not r.status.redirects
    r.status.result = 'normal'
    await r.svc.db.conn.execute('UPDATE web_push_deliveries SET next_attempt_at=0')
    await r.svc.db.conn.commit()
    assert await r.push.deliver_one()
    assert (await one(r.svc.db.conn, 'SELECT * FROM web_push_deliveries'))['state'] == 'accepted'
    r.push._send_provider.assert_called_once()
    assert len(r.status.checks) == 3


async def test_gateway_unreachable_never_uses_cached_authorization(env):
    r = env
    await register(r)
    response = await r.client.post('/api/push/test', headers=r.auth, json={'endpoint': r.info['endpoint']})
    assert response.status == 200
    await r.gateway_server.close()
    await r.push.enqueue(1, 'conv', 'after-disconnect', 'completed')
    await r.push.deliver_one()
    assert (await one(r.svc.db.conn, 'SELECT * FROM web_push_deliveries'))['state'] == 'pending'
    assert r.push._send_provider.call_count == 1


async def test_gateway_push_mapping_and_queue_survive_database_reopen(env):
    r = env
    original = await register(r)
    await r.push.enqueue(1, 'conv', 'durable', 'completed')
    await r.push.stop()
    db = DB(r.svc.config.storage.db_path)
    await db.connect()
    rebuilt = BrowserPush(db, managed=load_config().managed)
    rebuilt._send_provider = AsyncMock(return_value=201)
    try:
        await rebuilt.start()
        await stop_worker(rebuilt)
        assert len(await rebuilt.subscriptions(1)) == 1
        assert await rebuilt.deliver_one()
        assert r.status.checks == [original['session_token_hash']]
        assert rebuilt._send_provider.call_args.args[1]['instanceId'] == r.svc.config.managed.instance_id
        assert not await many(db.conn, 'SELECT * FROM web_sessions')
        # Same durable binding is rejected after gateway logout across restart.
        await rebuilt.enqueue(1, 'conv', 'revoked-after-restart', 'completed')
        r.status.active = False
        await rebuilt.deliver_one()
        assert rebuilt._send_provider.call_count == 1
        assert (await one(db.conn, "SELECT * FROM web_push_deliveries WHERE event_key='revoked-after-restart'"))['state'] == 'suppressed'
    finally:
        await rebuilt.stop()
        await db.close()


async def test_gateway_push_records_bounded_and_expired_bindings_cleaned(env, monkeypatch):
    import app.managed.push as gateway_push
    r = env
    monkeypatch.setattr(gateway_push, 'MAX_SESSIONS', 2)
    first = await register(r)
    await r.push.enqueue(1, '', 'old', 'completed')
    second_headers = {**r.auth, 'X-OpenBear-Gateway-Session': secrets.token_urlsafe(24)}
    await register(r, headers=second_headers, info=subscription('https://fcm.googleapis.com/wp/device-two'))
    third_headers = {**r.auth, 'X-OpenBear-Gateway-Session': secrets.token_urlsafe(24)}
    response = await r.client.post('/api/push/status', headers=third_headers, json={})
    assert response.status == 503
    await r.svc.db.conn.execute('UPDATE managed_push_sessions SET expires_at=0 WHERE session_hash=?', (first['session_token_hash'],))
    await r.svc.db.conn.commit()
    response = await r.client.post('/api/push/status', headers=third_headers, json={})
    assert response.status == 200
    assert len(await many(r.svc.db.conn, 'SELECT * FROM managed_push_sessions')) == 2
    assert not await many(r.svc.db.conn, 'SELECT * FROM web_push_deliveries')
    assert len(await many(r.svc.db.conn, 'SELECT * FROM web_push_subscriptions')) == 1


async def test_legacy_local_push_still_uses_revocable_cookie_and_original_payload(runtime):  # noqa: F811
    r = runtime
    push = r.svc.web_admin.browser_push
    await stop_worker(push)
    push._send_provider = AsyncMock(return_value=201)
    assert push.gateway_sessions is None
    response = await r.client.post('/api/auth/password/login', json={'username': 'owner', 'password': r.values['OPENBEAR_PASSWORD']})
    assert response.status == 200
    info = subscription()
    assert (await r.client.post('/api/push/subscription', json={'subscription': info})).status == 200
    assert (await r.client.post('/api/push/subscription', headers=r.auth, json={'subscription': info})).status == 403
    await push.enqueue(1, 'conv', 'local', 'completed')
    await push.deliver_one()
    assert 'instanceId' not in push._send_provider.call_args.args[1]
    await push.enqueue(1, 'conv', 'after-logout', 'completed')
    assert (await r.client.post('/api/auth/logout')).status == 200
    await push.deliver_one()
    assert push._send_provider.call_count == 1


@pytest.mark.parametrize('change', ['unsubscribe', 'expire'])
async def test_subscription_cannot_be_revived_during_gateway_check(env, change):
    r = env
    await register(r)
    await r.push.enqueue(1, 'conv', 'awaiting-check', 'completed')
    entered, release = asyncio.Event(), asyncio.Event()
    async def pause():
        entered.set()
        await release.wait()
    r.status.before_reply = pause
    task = asyncio.create_task(r.push.deliver_one())
    try:
        await asyncio.wait_for(entered.wait(), 2)
        if change == 'unsubscribe':
            response = await r.client.delete('/api/push/subscription', headers=r.auth, json={'endpoint': r.info['endpoint']})
            assert response.status == 200
        else:
            await r.svc.db.conn.execute('UPDATE managed_push_sessions SET expires_at=0')
            await r.svc.db.conn.commit()
        release.set()
        await asyncio.wait_for(task, 2)
        r.push._send_provider.assert_not_called()
    finally:
        release.set()
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
