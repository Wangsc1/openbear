"""Recoverable owner-Web credentials on isolated SQLite and real HTTP auth only."""
import json

import pytest

from app.db.engine import DB
from app.tools.base import ToolRuntimeContext
from app.tools.webhook import dispatch
from app.webhooks.contracts import EndpointConfig, WebhookError
from app.webhooks.repository import insert, many, one
from app.webhooks.service import WebhookService
from tests.test_web_admin import _login_cookie
from tests.test_webhooks_backend import create, env


async def rotate(s, eid, *, grace=0, request_id='rotate'):
    prepared = await s.prepare(123, eid, 'rotate_key', {'graceSeconds': grace})
    request = {'requestId': request_id, 'confirmationToken': prepared['confirmationToken']}
    result = await s.control(123, eid, request, action='rotate_key')
    return result, request


async def test_encrypted_create_survives_database_reopen_without_plaintext_storage(env, caplog):
    created = await create(env)
    eid, key = created['endpoint']['id'], created['credential']['key']
    assert created['credential']['recoverable'] and not created['credential']['displayOnce']
    row = await one(env.db.conn, 'SELECT * FROM webhook_credentials')
    assert row['encrypted_key'].startswith(b'\x01') and key.encode() not in row['encrypted_key']
    assert row['verifier'] == env.s.verifier(key) and key not in row['key_prefix']
    assert key not in repr(await many(env.db.conn, 'SELECT * FROM webhook_control_operations'))
    assert key not in json.dumps(await env.s.list(123, {}))
    assert key not in json.dumps(await env.s.get(123, eid))
    await env.db.close()
    assert key.encode() not in (env.tmp / 'webhooks.sqlite').read_bytes()
    await env.db.connect()
    reloaded = WebhookService(env.db, pepper=b'isolated-only', config=env.s.config, host=env.server)
    for _ in range(2):
        assert (await reloaded.web_credential(123, eid))['credential']['key'] == key
    await reloaded.authenticate(env.db.conn, eid, key)
    assert key not in caplog.text


async def test_rotation_returns_latest_even_with_equal_timestamp_and_preserves_grace(env, monkeypatch):
    now = [1000000]
    env.s.clock = lambda: now[0]
    created = await create(env)
    eid, old_key = created['endpoint']['id'], created['credential']['key']
    # Deliberately sort below the original random UUID: insertion order wins.
    identifiers = iter(['000-new-credential', 'operation-1', '000-newer-credential', 'operation-2'])
    monkeypatch.setattr('app.webhooks.service.uid', lambda: next(identifiers))
    with pytest.raises(WebhookError, match='confirmation_required'):
        await env.s.control(123, eid, {'requestId': 'unconfirmed'}, action='rotate_key')
    rotated, request = await rotate(env.s, eid, grace=10)
    new_key = rotated['credential']['key']
    assert new_key != old_key
    assert (await env.s.web_credential(123, eid))['credential']['key'] == new_key
    assert (await env.s.get(123, eid))['endpoint']['credential']['prefix'] == (await one(env.db.conn, "SELECT key_prefix FROM webhook_credentials WHERE credential_id='000-new-credential'"))['key_prefix']
    replay = await env.s.control(123, eid, request, action='rotate_key')
    assert 'credential' not in replay
    assert (await env.s.web_credential(123, eid))['credential']['key'] == new_key
    assert (await one(env.db.conn, 'SELECT COUNT(*) n FROM webhook_credentials'))['n'] == 2
    await env.s.authenticate(env.db.conn, eid, old_key)
    await env.s.authenticate(env.db.conn, eid, new_key)
    now[0] += 10000
    with pytest.raises(WebhookError, match='invalid_credential'):
        await env.s.authenticate(env.db.conn, eid, old_key)
    assert (await env.s.web_credential(123, eid))['credential']['key'] == new_key
    latest, _ = await rotate(env.s, eid, request_id='rotate-again')
    with pytest.raises(WebhookError, match='invalid_credential'):
        await env.s.authenticate(env.db.conn, eid, new_key)
    assert (await env.s.web_credential(123, eid))['credential']['key'] == latest['credential']['key']


async def test_real_v3_upgrade_keeps_legacy_key_authenticating_until_manual_rotation(tmp_path, monkeypatch):
    import app.webhooks.schema as schema
    migrations = schema.MIGRATIONS
    v4_index = next(i for i, (version, _) in enumerate(migrations) if version == 'webhooks_v4_credentials')
    path = tmp_path / 'legacy.sqlite'
    with monkeypatch.context() as patch:
        patch.setattr(schema, 'MIGRATIONS', migrations[:v4_index])
        db = DB(str(path)); await db.connect()
    key = 'wh_legacy-test-plaintext-never-stored'
    s = WebhookService(db, pepper=b'upgrade-fixture')
    try:
        async with db.webhook_transaction() as conn:
            await conn.execute("INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name) VALUES('F',123,'Legacy')")
            await insert(conn, 'webhook_endpoints', endpoint_id='E', owner_chat_id=123, binding_kind='folder', binding_uuid='F', create_request_id='legacy', enabled=1, created_at_ms=1, updated_at_ms=1)
            await s.save_revision(conn, 'E', 1, EndpointConfig(), {}, 123)
            await insert(conn, 'webhook_credentials', credential_id='K', endpoint_id='E', key_prefix='random-prefix', verifier=s.verifier(key), verifier_algorithm='hmac-sha256', pepper_version='1', created_at_ms=1, valid_from_ms=1)
        before = await one(db.conn, 'SELECT * FROM webhook_credentials')
        markers = await many(db.conn, "SELECT name FROM schema_data_migrations WHERE name LIKE 'webhooks_v%'")
    finally:
        await db.close()
    db = DB(str(path)); await db.connect()
    try:
        s = WebhookService(db, pepper=b'upgrade-fixture')
        after = await one(db.conn, 'SELECT * FROM webhook_credentials')
        assert {k: after[k] for k in before} == before and after['encrypted_key'] is None
        assert (await one(db.conn, 'SELECT COUNT(*) n FROM webhook_credentials'))['n'] == 1
        for marker in markers:
            assert await one(db.conn, 'SELECT name FROM schema_data_migrations WHERE name=?', (marker['name'],)) == marker
        await schema.migrate(db)  # Repeated migration is a no-op, including any later migrations.
        assert (await s.web_credential(123, 'E'))['credential'] == {'hasCredential': True, 'recoverable': False, 'key': None, 'unavailableReason': 'legacy_not_recoverable'}
        assert not (await s.get(123, 'E'))['endpoint']['credential']['recoverable']
        await s.authenticate(db.conn, 'E', key)
        rotated, _ = await rotate(s, 'E', grace=60)
        await s.authenticate(db.conn, 'E', key)
        assert (await s.web_credential(123, 'E'))['credential']['key'] == rotated['credential']['key']
        assert (await one(db.conn, "SELECT encrypted_key FROM webhook_credentials WHERE credential_id='K'"))['encrypted_key'] is None
        assert (await one(db.conn, 'PRAGMA integrity_check'))['integrity_check'] == 'ok'
    finally:
        await db.close()


async def test_current_key_http_requires_only_existing_login_and_is_never_cached(env):
    created = await create(env)
    eid, key = created['endpoint']['id'], created['credential']['key']
    path = f'/api/webhooks/{eid}/credentials/current'
    assert (await env.client.get(path)).status == 401
    assert (await env.client.get(path, headers={'Authorization': 'Bearer ' + key})).status == 401
    cookie = await _login_cookie(env)
    for _ in range(2):
        response = await env.client.get(path, cookies={'openbear_web_session': cookie})
        assert response.status == 200 and response.headers['Cache-Control'] == 'no-store'
        assert (await response.json())['credential']['key'] == key
    # Ordinary details and lists still contain metadata only.
    for ordinary in ['/api/webhooks', '/api/webhooks/' + eid]:
        response = await env.client.get(ordinary, cookies={'openbear_web_session': cookie})
        assert key not in await response.text()
    with pytest.raises(WebhookError, match='not_found'):
        await env.s.web_credential(456, eid)
    await env.s.control(123, eid, {'action': 'set_enabled', 'enabled': False, 'expectedControlRevision': 0, 'requestId': 'disable'})
    assert (await env.s.web_credential(123, eid))['credential']['key'] == key
    with pytest.raises(WebhookError, match='not_receiving'):
        await env.s.authenticate(env.db.conn, eid, key)
    prepared = await env.s.prepare(123, eid, 'delete', {})
    await env.s.control(123, eid, {'requestId': 'delete', 'confirmationToken': prepared['confirmationToken']}, action='delete')
    response = await env.client.get(path, cookies={'openbear_web_session': cookie})
    assert response.status == 404 and response.headers['Cache-Control'] == 'no-store'
    assert key not in await response.text()


@pytest.mark.parametrize('invalidity', ['future', 'expired', 'revoked'])
async def test_only_current_effective_credentials_are_recoverable(env, invalidity):
    env.s.clock = lambda: 1000000
    created = await create(env)
    eid = created['endpoint']['id']
    changes = {'future': 'valid_from_ms=2000000', 'expired': 'valid_from_ms=1,expires_at_ms=999999', 'revoked': 'revoked_at_ms=1000000'}
    async with env.db.webhook_transaction() as conn:
        await conn.execute('UPDATE webhook_credentials SET ' + changes[invalidity])
    assert (await env.s.web_credential(123, eid))['credential']['key'] is None
    assert not (await env.s.get(123, eid))['endpoint']['credential']['hasCredential']


async def test_tampering_wrong_pepper_and_ciphertext_transplant_fail_closed_without_rotation(env):
    created = await create(env)
    eid, key = created['endpoint']['id'], created['credential']['key']
    wrong_secret = WebhookService(env.db, pepper=b'different-runtime-secret', config=env.s.config)
    with pytest.raises(WebhookError, match='credential_unavailable'):
        await wrong_secret.web_credential(123, eid)
    row = await one(env.db.conn, 'SELECT * FROM webhook_credentials')
    async with env.db.webhook_transaction() as conn:
        await conn.execute("UPDATE webhook_credentials SET credential_id='different-id'")
    with pytest.raises(WebhookError, match='credential_unavailable'):
        await env.s.web_credential(123, eid)
    async with env.db.webhook_transaction() as conn:
        await conn.execute('UPDATE webhook_credentials SET credential_id=?,encrypted_key=?', (row['credential_id'], row['encrypted_key'][:-1] + bytes([row['encrypted_key'][-1] ^ 1])))
    cookie = await _login_cookie(env)
    response = await env.client.get(f'/api/webhooks/{eid}/credentials/current', cookies={'openbear_web_session': cookie})
    assert response.status == 503 and response.headers['Cache-Control'] == 'no-store'
    assert (await response.json())['code'] == 'credential_unavailable'
    assert (await one(env.db.conn, 'SELECT COUNT(*) n FROM webhook_credentials'))['n'] == 1
    await env.s.authenticate(env.db.conn, eid, key)  # Authentication still uses unchanged HMAC.


async def test_model_tool_create_rotate_list_get_and_event_outputs_never_contain_key(env, caplog):
    ctx = ToolRuntimeContext(webhook_owner_id=123, conversation_uuid='management')
    result = await dispatch(env.s, 'create', {'scope': {'type': 'folder', 'id': 'folder'}, 'enabled': True, 'requestId': 'tool-create', 'config': {'processing': {'instructions': 'fixture'}}}, ctx)
    eid = result['endpoint']['id']
    original = (await env.s.web_credential(123, eid))['credential']['key']
    assert original not in json.dumps(result) and 'credential' not in result
    async def confirm(_request):
        return {'confirmed': True}
    ctx.web_confirm = confirm
    result = await dispatch(env.s, 'update', {'endpointId': eid, 'operation': 'rotate_key', 'requestId': 'tool-rotate'}, ctx)
    key = (await env.s.web_credential(123, eid))['credential']['key']
    assert original != key
    outputs = [result, await dispatch(env.s, 'list', {}, ctx), await dispatch(env.s, 'get', {'endpointId': eid}, ctx)]
    for action in ['credential', 'web_credential', 'credentials/current']:
        with pytest.raises(WebhookError, match='invalid_action'):
            await dispatch(env.s, action, {'endpointId': eid}, ctx)
    accepted = await env.s.receive(eid, key, 'application/json', b'{"fixture":true}', [], 'event')
    outputs.append(await dispatch(env.s, 'events', {'eventId': accepted['eventId']}, ctx))
    for secret in [original, key]:
        assert secret not in json.dumps(outputs) and secret not in caplog.text
        for table in ['webhook_control_operations', 'webhook_events', 'webhook_event_payloads']:
            assert secret not in repr(await many(env.db.conn, 'SELECT * FROM ' + table))
