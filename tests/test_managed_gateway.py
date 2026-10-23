"""Managed gateway trust boundary, persistent upgrade and real business runtime."""
from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
from pathlib import Path

import pytest
from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from app.config import load_config
from app.db.dao import MessageDAO
from app.managed.maintenance import maintain
from app.managed.settings import LOCAL_OWNER_ID, ManagedConfig, sanitized_env, validate_origin
from app.services import Services
from app.webhooks.repository import many, one
from tests.test_managed_runtime import RuntimeFixture, seed
from tests.test_web_admin import FakeRunFactory, FakeStreamBackend


@pytest.fixture
async def gateway(monkeypatch, tmp_path):
    root, values, raw = seed(monkeypatch, tmp_path)
    values['OPENBEAR_CHILD_AUTH'] = 'gateway'
    values['OPENBEAR_GATEWAY_KEY'] = secrets.token_urlsafe(32)
    for key in ('OPENBEAR_USERNAME', 'OPENBEAR_PASSWORD'):
        monkeypatch.delenv(key)
        values.pop(key)
    for key in ('OPENBEAR_CHILD_AUTH', 'OPENBEAR_GATEWAY_KEY'):
        monkeypatch.setenv(key, values[key])
    svc = Services(load_config())
    await svc.db.connect()
    await svc.mem._bootstrap()
    await svc.managed_runtime.open()
    svc.managed_runtime.ready = True
    client = TestClient(TestServer(svc.web_admin.make_app()))
    await client.start_server()
    try:
        yield RuntimeFixture(root=root, values=values, raw=raw, svc=svc, client=client,
            auth={'X-OpenBear-Gateway-Key': values['OPENBEAR_GATEWAY_KEY'],
                  'X-OpenBear-Instance': values['OPENBEAR_INSTANCE_ID'],
                  'X-OpenBear-Gateway-Session': secrets.token_urlsafe(24)},
            management={'Authorization': 'Bearer ' + values['OPENBEAR_MANAGEMENT_KEY']})
    finally:
        await client.close()
        await svc.shutdown()


async def test_gateway_bootstrap_persistence_and_no_pushed_events(gateway, monkeypatch):
    r = gateway
    assert LOCAL_OWNER_ID == 1 and r.svc.managed_runtime.account is None and r.svc.bot is None
    assert not (r.root / '.managed/account.json').exists()
    assert 'OPENBEAR_GATEWAY_KEY' not in sanitized_env({'OPENBEAR_GATEWAY_KEY': 'temporary', 'PATH': '/bin'})
    identity = json.loads((r.root / '.managed/identity.json').read_text())
    assert identity['auth_mode'] == 'gateway' and identity['gateway_key'] == r.values['OPENBEAR_GATEWAY_KEY']
    recovered = ManagedConfig.from_environment()
    assert recovered.gateway_key == identity['gateway_key'] and not recovered.startup_errors()
    assert recovered.gateway_key not in repr(recovered) and 'gateway_key' not in recovered.model_dump()
    monkeypatch.setenv('OPENBEAR_CHILD_AUTH', 'local')
    with pytest.raises(ValueError):
        ManagedConfig.from_environment()
    monkeypatch.setenv('OPENBEAR_CHILD_AUTH', 'gateway')
    monkeypatch.setenv('OPENBEAR_GATEWAY_KEY', secrets.token_urlsafe(32))
    with pytest.raises(ValueError):
        ManagedConfig.from_environment()
    monkeypatch.delenv('OPENBEAR_GATEWAY_KEY')
    for method, path in [('POST', '/api/auth/password/login'), ('POST', '/api/auth/password/change'),
                         ('GET', '/api/auth/session'), ('GET', '/api/auth/sessions'), ('POST', '/api/auth/logout')]:
        response = await r.client.request(method, path, json={'username': 'owner', 'password': 'invalid'})
        assert response.status == 403 and 'Set-Cookie' not in response.headers
    await r.svc.managed_runtime.start()
    # The controller pulls status; the child never needs the controller's address.
    assert not hasattr(r.svc.managed_runtime, 'outbox')
    assert not (r.root / '.managed/outbox.db').exists()


async def test_gateway_probe_credential_and_instance_boundaries(gateway):
    r = gateway
    probe_headers = {k: v for k, v in r.auth.items() if k != 'X-OpenBear-Gateway-Session'}
    response = await r.client.get('/api/gateway/v1/probe', headers=probe_headers)
    assert response.status == 200
    status = await response.json()
    assert status == await (await r.client.get('/api/managed/v1/status', headers=r.management)).json()
    assert status['instanceId'] == r.values['OPENBEAR_INSTANCE_ID'] and status['ready']
    assert status['persistence']['mounted'] is False
    assert status['health']['status'] == 'degraded' and 'workspace_not_mounted' in status['health']['issues']
    for headers in ({}, r.management, {**probe_headers, 'X-OpenBear-Instance': secrets.token_hex(12)},
                    {**probe_headers, 'X-OpenBear-Gateway-Key': r.values['OPENBEAR_MANAGEMENT_KEY']}):
        assert (await r.client.get('/api/gateway/v1/probe', headers=headers)).status == 401
    for path in ('/api/managed/v1/status', '/api/managed/v1/config', '/api/auth/session', '/api/instances', '/api/system/restart'):
        response = await r.client.get(path, headers=r.auth)
        assert response.status == 403
    for headers in ({}, probe_headers, {**r.auth, 'X-OpenBear-Gateway-Session': ''},
                    {**r.auth, 'X-OpenBear-Instance': secrets.token_hex(12)},
                    {**r.auth, 'Cookie': 'openbear_gateway_session=not-forwarded'},
                    {**r.auth, **r.management}, {'Authorization': 'Bearer ' + r.values['OPENBEAR_GATEWAY_KEY']}):
        assert (await r.client.get('/api/conversations', headers=headers)).status == 401
    assert (await r.client.get('/api/managed/v1/status', headers={'Authorization': 'Bearer ' + r.values['OPENBEAR_GATEWAY_KEY']})).status == 401
    for headers in (r.auth, r.management):
        for path in ('/api/conversations', '/api/memory/categories', '/api/skills', '/api/mcp/status', '/api/settings', '/api/rath/options'):
            response = await r.client.get(path, headers=headers)
            assert response.status == 200, path
            assert 'Set-Cookie' not in response.headers
    # Even a previously minted valid local cookie cannot bypass gateway mode.
    token = secrets.token_urlsafe(32)
    await r.svc.db.conn.execute('INSERT INTO web_sessions(session_token_hash,chat_id,expires_at) VALUES(?,?,?)',
                               (hashlib.sha256(token.encode()).hexdigest(), LOCAL_OWNER_ID, int(time.time()) + 3600))
    await r.svc.db.conn.commit()
    assert (await r.client.get('/api/conversations', headers={'Cookie': 'openbear_web_session=' + token})).status == 401


async def test_gateway_websocket_full_turn_and_continuous_revalidation(gateway):
    from tests.test_managed_runtime import test_managed_websocket_chat_turn_without_telegram_or_business_reports as full_turn
    r = gateway
    await full_turn(r)
    row = (await many(r.svc.db.conn, 'SELECT * FROM web_conversations'))[0]
    assert row['owner_chat_id'] == 1 and row['internal_chat_id'] == -1
    ws = await r.client.ws_connect('/api/conversations/' + row['conversation_uuid'] + '/ws', headers=r.auth)
    try:
        assert (await ws.receive_json(timeout=2))['type'] == 'state'
        r.svc.managed_runtime.settings.gateway_key = secrets.token_urlsafe(32)
        await ws.send_json({'type': 'send', 'text': 'must not run after revoked key'})
        message = await ws.receive(timeout=2)
        assert message.type == WSMsgType.CLOSE and message.data == 1008
        assert not r.svc.runs.is_running(row['internal_chat_id'])
    finally:
        await ws.close()


async def test_gateway_authenticated_file_stream_and_callback_auth(gateway):
    r = gateway
    row = await r.svc.web_admin._create_web_conversation(LOCAL_OWNER_ID, title='gateway file')
    source = r.root / 'workspace/artifacts/gateway/hello.txt'
    source.parent.mkdir(parents=True)
    source.write_text('isolated gateway file body')
    await r.svc.web_admin._rewrite_web_artifact_links(f'[file]({source})', conversation=row)
    artifact = await one(r.svc.db.conn, 'SELECT * FROM web_artifacts')
    path = f"/api/conversations/{row['conversation_uuid']}/artifacts/{artifact['artifact_uuid']}/content?download=1"
    response = await r.client.get(path, headers=r.auth)
    assert response.status == 200 and await response.read() == source.read_bytes()
    assert response.headers['Content-Disposition'].startswith('attachment;')
    assert (await r.client.get(path)).status == 401
    # Callback stays on its original independent credential path; gateway key
    # does not become an implicit producer credential.
    hook = await r.svc.webhooks.create(LOCAL_OWNER_ID, {'scope': {'type': 'conversation', 'id': row['conversation_uuid']},
        'name': 'gateway callback', 'enabled': True, 'requestId': secrets.token_hex(8),
        'config': {'processing': {'instructions': 'Isolated callback.'}}})
    callback = '/webhook/' + hook['endpoint']['id']
    assert (await r.client.post(callback, headers=r.auth, json={})).status == 401
    assert (await r.client.post(callback, headers={'Authorization': 'Bearer ' + hook['credential']['key']}, json={})).status == 202


async def test_gateway_real_cron_webhook(gateway):
    from tests.test_managed_runtime import test_managed_local_owner_cron_and_webhook as background
    await background(gateway)


@pytest.mark.parametrize('url', ['http://family.example', 'http://8.8.8.8:18961', 'http://[2001:4860:4860::8888]',
                                'http://localhost:18961/', 'https://家庭.example'])
def test_valid_http_and_https_origins(url):
    assert validate_origin(url) == url.rstrip('/')


@pytest.mark.parametrize('url', ['http://u:p@example.com', 'http://@example.com', 'http://example.com/a',
                                'http://example.com/../', 'http://example.com?a=1', 'http://example.com#x',
                                'http://bad_host', 'http://x:0', 'http://x:65536', 'http://x:',
                                'ftp://example.com', 'http://bad..example', 'http://x\\y', 'http://x\n',
                                'http://[::1]evil', 'http://[::1]@example.com'])
def test_invalid_origins_rejected(url):
    with pytest.raises(ValueError):
        validate_origin(url)


@pytest.mark.parametrize('role', [None, '', 'controller', 'other', 'managed'])
def test_main_preserves_failure_exit_code_for_every_role(monkeypatch, role):
    import app.main as entrypoint
    if role is None:
        monkeypatch.delenv('OPENBEAR_INSTANCE_ROLE', raising=False)
    else:
        monkeypatch.setenv('OPENBEAR_INSTANCE_ROLE', role)
    async def invalid_startup():
        raise SystemExit(7)
    monkeypatch.setattr(entrypoint, 'run', invalid_startup)
    with pytest.raises(SystemExit) as exc:
        entrypoint.main()
    assert exc.value.code == 7


async def test_legacy_owner_migration_preserves_first_chat_and_agent_trial(monkeypatch, tmp_path):
    root, values, _ = seed(monkeypatch, tmp_path)
    svc = Services(load_config())
    await svc.db.connect()
    await svc.mem._bootstrap()
    # Construct the actual legacy collision: owner and first internal chat both -1.
    row = await svc.web_admin._create_web_conversation(-1, title='legacy first chat', internal_chat_id=-1)
    await MessageDAO(svc.db).add(-1, 'user', 'historical business message')
    folder = secrets.token_hex(12)
    await svc.db.conn.execute('INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name) VALUES(?,-1,?)', (folder, 'legacy folder'))
    await svc.db.conn.execute("INSERT INTO app_state(key,value) VALUES(?,?)", ('folder_prompt_policy:-1:' + folder, '{"text":"preserve"}'))
    await svc.db.conn.execute("INSERT INTO app_state(key,value) VALUES('controller:-1:history','unchanged')")
    token = secrets.token_urlsafe(32)
    await svc.db.conn.execute('INSERT INTO web_sessions(session_token_hash,chat_id,expires_at) VALUES(?,-1,?)',
                             (hashlib.sha256(token.encode()).hexdigest(), int(time.time()) + 3600))
    await svc.db.conn.commit()
    from app.agents.profiles import ensure_builtin_workflows
    await ensure_builtin_workflows(svc.agent_dao)
    wf = await svc.agent_dao.workflow_by_slug('single-agent')
    old_task = await svc.agents.create_task(chat_id=-1, workflow_uuid=wf.workflow_uuid, title='legacy task',
                                          input_data={}, parent_session_uuid=row['conversation_uuid'])
    await svc.managed_runtime.open()
    client = TestClient(TestServer(svc.web_admin.make_app()))
    await client.start_server()
    try:
        migrated = await one(svc.db.conn, 'SELECT * FROM web_conversations')
        assert migrated['owner_chat_id'] == 1 and migrated['internal_chat_id'] == -1
        assert (await one(svc.db.conn, 'SELECT * FROM messages'))['chat_id'] == -1
        assert (await svc.agent_dao.get_task(old_task)).chat_id == -1
        assert (await one(svc.db.conn, 'SELECT * FROM sessions WHERE chat_id=-1'))['session_uuid'] == row['conversation_uuid']
        assert (await one(svc.db.conn, 'SELECT * FROM web_conversation_folders'))['owner_chat_id'] == 1
        assert await one(svc.db.conn, 'SELECT * FROM app_state WHERE key=?', ('folder_prompt_policy:1:' + folder,))
        assert (await one(svc.db.conn, "SELECT value FROM app_state WHERE key='controller:-1:history'"))['value'] == 'unchanged'
        cookie = {'Cookie': 'openbear_web_session=' + token}
        assert (await (await client.get('/api/auth/session', headers=cookie)).json())['chatId'] == 1
        assert 'legacy first chat' in await (await client.get('/api/conversations', headers=cookie)).text()
        from tests.test_rath_web_api import FakeFactory
        svc.web_admin.llm_factory = FakeFactory()
        svc.config.agents.agent_plan_enabled = False
        agent_id = await svc.agent_dao.create_agent(agent_key='managed-trial', name='Managed trial',
            model='test/model', think_level='off', tool_allowlist=[], enabled=True)
        response = await client.post(f'/api/rath/agents/{agent_id}/trial', headers=cookie, json={'instruction': 'Isolated trial'})
        assert response.status == 200
        trial_id = (await response.json())['taskUuid']
        for _ in range(100):
            trial = await svc.agent_dao.get_task(trial_id)
            if trial.status in {'completed', 'failed'}:
                break
            await asyncio.sleep(.02)
        assert trial.status == 'completed' and trial.chat_id == 1
        assert trial.parent_session_uuid != row['conversation_uuid']
        assert [m['content'] for m in await many(svc.db.conn, 'SELECT content FROM messages WHERE chat_id=-1')] == ['historical business message']
        from app.managed.migration import migrate_local_owner
        await migrate_local_owner(svc.db)  # Idempotent across rebuild.
        assert (await one(svc.db.conn, 'SELECT owner_chat_id FROM web_conversations'))['owner_chat_id'] == 1
        await svc.managed_runtime.emit('login_success', {})
        with pytest.raises(RuntimeError):
            maintain(root, 'set-auth', {'authMode': 'gateway', 'gatewayKey': secrets.token_urlsafe(32)})
    finally:
        await client.close()
        await svc.shutdown()
    # Explicit offline migration preserves pepper/history, revokes old local sessions.
    gateway_key = secrets.token_urlsafe(32)
    pepper = json.loads((root / '.managed/identity.json').read_text())['webhook_pepper']
    maintain(root, 'set-auth', {'authMode': 'gateway', 'gatewayKey': gateway_key})
    cfg = load_config()
    assert cfg.managed.auth_mode == 'gateway' and not cfg.validate_for_startup()
    rebuilt = Services(cfg)
    await rebuilt.db.connect()
    await rebuilt.managed_runtime.open()
    try:
        assert rebuilt.managed_runtime.account is None
        assert rebuilt.managed_runtime.pepper.hex() == pepper
        assert (await one(rebuilt.db.conn, 'SELECT * FROM web_sessions'))['revoked_at'] > 0
        assert (await one(rebuilt.db.conn, 'SELECT * FROM messages WHERE chat_id=-1'))['content'] == 'historical business message'
    finally:
        await rebuilt.shutdown()
    rotated = secrets.token_urlsafe(32)
    maintain(root, 'rotate-identity', {'gatewayKey': rotated})
    assert load_config().managed.gateway_key == rotated
    with pytest.raises(ValueError):
        maintain(root, 'rotate-identity', {'controllerUrl': 'http://controller.example:18961'})
    with pytest.raises(ValueError):
        maintain(root, 'reset-account', {'username': 'owner', 'password': secrets.token_urlsafe(24)})
    maintain(root, 'set-auth', {'authMode': 'local'})
    assert load_config().managed.auth_mode == 'local' and not load_config().managed.gateway_key


@pytest.mark.parametrize('key_kind', ['missing', 'management', 'short'])
def test_gateway_requires_independent_key_not_local_password(monkeypatch, tmp_path, key_kind):
    _, values, _ = seed(monkeypatch, tmp_path)
    monkeypatch.setenv('OPENBEAR_CHILD_AUTH', 'gateway')
    monkeypatch.delenv('OPENBEAR_USERNAME')
    monkeypatch.delenv('OPENBEAR_PASSWORD')
    key = {'missing': '', 'management': values['OPENBEAR_MANAGEMENT_KEY'], 'short': 'short'}[key_kind]
    monkeypatch.setenv('OPENBEAR_GATEWAY_KEY', key)
    cfg = load_config()
    assert cfg.validate_for_startup()
    with pytest.raises(ValueError):
        Services(cfg)


async def test_owner_migration_conflict_rolls_back_without_rewriting_chats(monkeypatch, tmp_path):
    import sqlite3
    from app.managed.migration import migrate_local_owner
    seed(monkeypatch, tmp_path)
    svc = Services(load_config())
    await svc.db.connect()
    try:
        await svc.web_admin._create_web_conversation(-1, title='legacy', internal_chat_id=-1)
        await svc.db.conn.execute('INSERT INTO web_conversation_defaults(owner_chat_id) VALUES(-1),(1)')
        await svc.db.conn.commit()
        with pytest.raises(sqlite3.IntegrityError):
            await migrate_local_owner(svc.db)
        row = await one(svc.db.conn, 'SELECT owner_chat_id,internal_chat_id FROM web_conversations')
        assert row == {'owner_chat_id': -1, 'internal_chat_id': -1}
        assert not await one(svc.db.conn, "SELECT * FROM app_state WHERE key='managed:local-owner-v2'")
    finally:
        await svc.shutdown()
