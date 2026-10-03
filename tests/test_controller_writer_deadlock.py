"""2026-10-03: parameter-progress settlement, Web publication and auth lockout."""
import asyncio
import hashlib
import json
import time
from types import SimpleNamespace

import pytest

from app.agent.loop import Agent
from app.db.connection_router import SQLiteWriterTimeout
from app.llm.events import StreamEvent, ToolCall, Usage
from app.web_console.auth_api import WebAdminAuthMixin
from app.web_console.live_stream import _WebLiveStream, _WebStreamRenderer
from tests.test_agent_loop import _echo_registry
from tests.test_runtime_lifecycle import env
from tests.test_web_operations_schema import _OperationStore
from tests.test_web_admin import web_env


async def session_request(db, *, expires_at=None):
    token = 'isolated-deadlock-cookie'
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    await db.conn.execute(
        'INSERT INTO web_sessions(session_token_hash,chat_id,created_at,expires_at,last_seen_at,ip,user_agent) '
        "VALUES(?,17,0,?,0,'','')", (token_hash, expires_at or int(time.time()) + 3600))
    await db.conn.commit()
    return SimpleNamespace(cookies={'openbear_web_session': token}), token_hash


@pytest.mark.parametrize('terminal', ['complete', 'error', 'cancel'])
async def test_progress_settlement_cannot_deadlock_web_publish_or_auth(env, terminal):
    db = env.db
    publisher_entered, settlement_entered = asyncio.Event(), asyncio.Event()
    competitors, clear_owners, statuses_at_clear = [], [], []
    operation_store = _OperationStore(db)

    async def sink(event):
        if event.get('competing'):
            publisher_entered.set()
            await settlement_entered.wait()
        await operation_store._publish_native_operations(event)
        return event

    live = _WebLiveStream('isolated-repro', 17, event_sink=sink)
    await live.publish({'type': 'accepted', 'turnUuid': 'repro-turn', 'runUuid': 'repro-run'})

    class Renderer(_WebStreamRenderer):
        async def on_model_output_progress(self, progress):
            if progress is None:
                clear_owners.append(db.conn._owner is asyncio.current_task())
                cur = await db.conn.execute("SELECT status FROM runtime_actions WHERE kind='model' ORDER BY created_at, rowid")
                statuses_at_clear.append([row[0] for row in await cur.fetchall()])
                await cur.close()
                settlement_entered.set()
            await super().on_model_output_progress(progress)

    renderer = Renderer(live)

    class Backend:
        protocol = 'chat'
        calls = 0

        async def stream(self, messages, **options):
            self.calls += 1
            if self.calls > 1:
                yield StreamEvent('content', text='done')
                yield StreamEvent('finish', finish_reason='stop')
                return
            yield StreamEvent('tool_input', details={'toolNames': ['echo'], 'receivedBytes': 10,
                'phase': 'ready', 'startedAtMs': 1, 'updatedAtMs': 2})
            yield StreamEvent('usage', usage=Usage(input_tokens=7, output_tokens=3))
            competitors.append(asyncio.create_task(live.publish({'type': 'status', 'competing': True}),
                                                   name='concurrent-web-publisher'))
            await publisher_entered.wait()
            if terminal == 'cancel':
                raise asyncio.CancelledError()
            if terminal == 'error':
                yield StreamEvent('error', error='deterministic error', retryable=False)
                return
            yield StreamEvent('tool_call', tool_calls=[ToolCall('repro-call', 'echo', '{"x":"hi"}')])
            yield StreamEvent('finish', finish_reason='tool_calls')

    request, _ = await session_request(db)
    controller = asyncio.create_task(Agent(Backend(), _echo_registry(), max_retries=0).run(
        env.messages, renderer, model='test', window_runtime=env.window, persister=env.persister),
        name='real-controller-loop')
    auth = None
    try:
        await asyncio.wait_for(settlement_entered.wait(), 3)
        auth = asyncio.create_task(WebAdminAuthMixin.session_from_request(SimpleNamespace(db=db), request))
        done, pending = await asyncio.wait({controller, auth, *competitors}, timeout=3)
        assert not pending, f'writer={db.conn._owner}; publisherLocked={live._publish_lock.locked()}'
        assert clear_owners == [False]
        expected = {'complete': 'completed', 'error': 'failed', 'cancel': 'cancelled'}[terminal]
        assert statuses_at_clear == [[expected]]  # Already durable before presentation.
        assert (await auth).chat_id == 17
        if terminal == 'cancel':
            assert controller.cancelled()
        else:
            assert not controller.exception()
        cur = await db.conn.execute('SELECT COUNT(*) FROM runtime_accounting_claims')
        assert (await cur.fetchone())[0] == (2 if terminal == 'complete' else 1)
        await cur.close()
        cur = await db.conn.execute("SELECT outcome_json FROM runtime_actions WHERE kind='model' ORDER BY created_at, rowid LIMIT 1")
        outcome = json.loads((await cur.fetchone())[0])
        await cur.close()
        assert outcome['inputTokens'] == 7 and outcome['outputTokens'] == 3
        assert db.conn._owner is None and not db.conn.in_transaction
    finally:
        settlement_entered.set()
        tasks = [controller, *competitors, *([auth] if auth else [])]
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await renderer.close()


@pytest.mark.parametrize('operation', ['execute', 'transaction', 'commit'])
async def test_writer_timeout_does_not_modify_or_release_owner_transaction(env, operation):
    db = env.db
    db.conn._writer_wait_timeout_s = 0.03
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold():
        async with db.write_transaction(label='owner') as conn:
            await conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('owner-value','kept',0)")
            async with db.write_transaction(label='reentrant', wait_timeout_s=0.001):
                assert db.conn._owner is asyncio.current_task()
            entered.set()
            await release.wait()

    holder = asyncio.create_task(hold(), name='test-writer-owner')
    try:
        await asyncio.wait_for(entered.wait(), 2)
        with pytest.raises(SQLiteWriterTimeout, match='test-writer-owner'):
            if operation == 'execute':
                await db.conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('unexpected','no',0)")
            elif operation == 'commit':
                await db.conn.commit()
            else:
                async with db.write_transaction(label='contender'):
                    pytest.fail('must not enter')
        assert db.conn._owner is holder and db.conn.in_transaction
        cur = await db.conn.execute("SELECT value FROM app_state WHERE key='owner-value'")
        assert await cur.fetchone() is None  # No accidental commit of the owner.
        await cur.close()
    finally:
        release.set()
        await holder
    cur = await db.conn.execute("SELECT value FROM app_state WHERE key='owner-value'")
    assert (await cur.fetchone())[0] == 'kept'
    await cur.close()
    await db.conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('after-timeout','ok',0)")
    await db.conn.commit()


@pytest.mark.parametrize('expire_during_wait', [False, True])
async def test_auth_remains_available_while_writer_stalls_and_rechecks_expiry(env, monkeypatch, expire_during_wait):
    from app.web_console import auth_api
    db = env.db
    clock = [int(time.time())]
    monkeypatch.setattr(auth_api, 'now_ts', lambda: clock[0])
    request, token_hash = await session_request(db, expires_at=clock[0] + 1)
    entered, release, attempted = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original = db.conn._acquire_writer

    async def acquire(**kwargs):
        if kwargs.get('wait_timeout_s') == 0.1:
            attempted.set()
        return await original(**kwargs)

    async def hold():
        async with db.write_transaction() as conn:
            await conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('auth-holder','ok',0)")
            entered.set()
            await release.wait()

    holder = asyncio.create_task(hold())
    auth = None
    try:
        await entered.wait()
        monkeypatch.setattr(db.conn, '_acquire_writer', acquire)
        auth = asyncio.create_task(WebAdminAuthMixin.session_from_request(SimpleNamespace(db=db), request))
        await attempted.wait()
        if expire_during_wait:
            clock[0] += 2
        session = await asyncio.wait_for(auth, 1)
        assert (session is None) if expire_during_wait else session.chat_id == 17
        assert db.conn._owner is holder and db.conn.in_transaction
        cur = await db.conn.execute('SELECT last_seen_at FROM web_sessions WHERE session_token_hash=?', (token_hash,))
        assert (await cur.fetchone())[0] == 0
        await cur.close()
    finally:
        release.set()
        await asyncio.gather(holder, *([auth] if auth else []), return_exceptions=True)


async def test_auth_timeout_rechecks_committed_revocation(env, monkeypatch):
    db = env.db
    request, token_hash = await session_request(db)
    original = db.conn._acquire_writer

    async def revoke_between_read_and_timeout(**kwargs):
        if kwargs.get('wait_timeout_s') == 0.1:
            async with db.write_transaction() as conn:
                await conn.execute('UPDATE web_sessions SET revoked_at=1 WHERE session_token_hash=?', (token_hash,))
            raise SQLiteWriterTimeout('simulated contention after committed revocation')
        return await original(**kwargs)

    monkeypatch.setattr(db.conn, '_acquire_writer', revoke_between_read_and_timeout)
    assert await WebAdminAuthMixin.session_from_request(SimpleNamespace(db=db), request) is None


async def test_authenticated_chat_and_websocket_work_while_writer_is_held(web_env, tmp_path, monkeypatch):
    db = web_env.db
    request, _ = await session_request(db)
    headers = {'Cookie': f"openbear_web_session={request.cookies['openbear_web_session']}"}
    index = tmp_path / 'index.html'
    index.write_text('<html>isolated chat</html>')
    monkeypatch.setattr(web_env.server, '_web_index_path', lambda: index)
    # Match an already-used console: the first-ever tree snapshot performs a
    # one-time migration write, independently of session activity refresh.
    await web_env.server._tree_ensure_interaction_projection(17)
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold():
        async with db.write_transaction(label='isolated-stalled-writer') as conn:
            await conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES('http-holder','ok',0)")
            entered.set()
            await release.wait()

    holder = asyncio.create_task(hold())
    ws = None
    try:
        await asyncio.wait_for(entered.wait(), 2)
        response = await asyncio.wait_for(web_env.client.get('/chat', headers=headers), 2)
        assert response.status == 200
        assert 'isolated chat' in await response.text()
        ws = await asyncio.wait_for(web_env.client.ws_connect('/api/events/ws', headers=headers), 2)
        assert (await ws.receive_json(timeout=2))['type'] == 'snapshot'
        assert db.conn._owner is holder and db.conn.in_transaction
    finally:
        release.set()
        await holder
        if ws is not None:
            await ws.close()
