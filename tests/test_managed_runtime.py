"""Isolated managed runtime contracts; generated temporary credentials only."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
from pathlib import Path
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from app.config import Config, config_path, load_config
from app.managed.account import LocalAccount
from app.managed.http import business_route_allowed
from app.managed.jobs import EnvironmentJobs
from app.managed.settings import LOCAL_OWNER_ID, MANAGEMENT_ENV, ManagedConfig, sanitized_env
from app.services import Services
from app.web_admin import _COOKIE


class RuntimeFixture(SimpleNamespace):
    def __repr__(self):
        return "<isolated managed runtime>"


def seed(monkeypatch, tmp_path):
    root = tmp_path / "volume"
    root.mkdir()
    values = {"OPENBEAR_INSTANCE_ROLE": "managed", "OPENBEAR_WORKSPACE": str(root),
              "OPENBEAR_INSTANCE_ID": secrets.token_hex(12), "OPENBEAR_MANAGEMENT_KEY": secrets.token_urlsafe(32),
              "OPENBEAR_USERNAME": "owner", "OPENBEAR_PASSWORD": secrets.token_urlsafe(24),
              "OPENBEAR_CONFIG": str(root / "openbear.json")}
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    monkeypatch.chdir(root)
    raw = {"models": {"providers": {"test": {"baseUrl": "http://127.0.0.1:9", "apiKey": secrets.token_urlsafe(20),
            "protocol": "chat", "models": [{"id": "model"}]}}, "primary": "test/model"},
           "memory": {"provider": "builtin"}, "web": {"host": "127.0.0.1"}}
    Path(values["OPENBEAR_CONFIG"]).write_text(json.dumps(raw))
    return root, values, raw


@pytest.fixture
async def runtime(monkeypatch, tmp_path):
    root, values, raw = seed(monkeypatch, tmp_path)
    config = load_config()
    assert config.validate_for_startup() == []
    svc = Services(config)
    await svc.db.connect()
    await svc.mem._bootstrap()
    await svc.managed_runtime.open()
    svc.managed_runtime.ready = True
    client = TestClient(TestServer(svc.web_admin.make_app()))
    await client.start_server()
    try:
        yield RuntimeFixture(root=root, values=values, raw=raw, svc=svc, client=client,
                              auth={"Authorization": "Bearer " + values["OPENBEAR_MANAGEMENT_KEY"]})
    finally:
        await client.close()
        await svc.shutdown()


def test_explicit_role_and_missing_config(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENBEAR_INSTANCE_ROLE", raising=False)
    assert not ManagedConfig.from_environment().enabled
    root, values, raw = seed(monkeypatch, tmp_path)
    monkeypatch.delenv("OPENBEAR_MANAGEMENT_KEY")
    config = load_config()
    assert config.managed.enabled and config.telegram is None
    assert any("management_key" in e for e in config.validate_for_startup())
    for role in ("", "typo", "MANAGED", "controller"):
        monkeypatch.setenv("OPENBEAR_INSTANCE_ROLE", role)
        assert not load_config().managed.enabled


def test_role_is_not_json_config(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENBEAR_INSTANCE_ROLE", raising=False)
    cfg = Config.model_validate({"managed": {"enabled": True}, "models": {"providers": {}, "primary": ""}, "memory": {}})
    assert not cfg.managed.enabled
    assert "managed" not in cfg.model_dump()
    assert any("telegram" in error for error in cfg.validate_for_startup())


async def test_password_sessions_and_management_auth(runtime):
    r = runtime
    mode = await r.client.get("/api/auth/mode")
    assert await mode.json() == {"ok": True, "mode": "managed"}
    assert mode.headers["X-OpenBear-Instance"] == r.svc.config.managed.instance_id
    assert mode.headers["Cache-Control"] == "no-store"
    assert r.svc.bot is None
    assert all(getattr(r.svc.web_admin, name) is None for name in ("web_task_telegram", "telegram_replies", "interaction_telegram"))
    assert r.svc.update is None
    assert not set(MANAGEMENT_ENV) & set(os.environ)
    assert "InstanceControl" not in r.svc.tools.names()
    assert (await r.client.get("/api/managed/v1/status")).status == 401
    assert (await r.client.post("/api/auth/login/start", json={})).status == 403
    failed = await r.client.post("/api/auth/password/login", json={"username": "owner", "password": "wrong"})
    assert failed.status == 403
    response = await r.client.post("/api/auth/password/login", json={"username": "owner", "password": r.values["OPENBEAR_PASSWORD"]})
    assert response.status == 200
    cookie = response.cookies[_COOKIE]
    assert cookie["httponly"] and cookie["samesite"] == "Lax" and not cookie["domain"]
    session = await (await r.client.get("/api/auth/session")).json()
    assert session["mode"] == "managed" and session["chatId"] == LOCAL_OWNER_ID
    # Cookie alone is not management authority; management key cannot mint cookie.
    assert (await r.client.get("/api/managed/v1/status")).status == 401
    assert (await r.client.get("/api/auth/session", headers=r.auth)).status == 403
    assert (await r.client.get("/api/instances", headers=r.auth)).status == 403
    assert (await r.client.post("/api/system/update", headers=r.auth, json={})).status == 403
    status = await (await r.client.get("/api/managed/v1/status", headers=r.auth)).json()
    assert status["ready"] and status["instanceId"] == r.values["OPENBEAR_INSTANCE_ID"]
    assert Path(status["persistence"]["dbPath"]).is_relative_to(r.root)
    sessions = await (await r.client.get("/api/auth/sessions")).json()
    assert (await r.client.delete("/api/auth/sessions/" + str(sessions["items"][0]["id"]))).status == 200
    assert (await r.client.get("/api/auth/session")).status == 401


async def test_origin_secure_cookie_rate_limit_and_change(runtime):
    r = runtime
    data = {"username": "owner", "password": r.values["OPENBEAR_PASSWORD"]}
    assert (await r.client.post("/api/auth/password/login", json=data, headers={"Origin": "https://evil.invalid"})).status == 403
    response = await r.client.post("/api/auth/password/login", json=data, headers={"X-Forwarded-Proto": "https"})
    assert response.cookies[_COOKIE]["secure"]
    # Re-login without TLS for this local HTTP-only fixture.
    r.client.session.cookie_jar.clear()
    await r.client.post("/api/auth/password/login", json=data)
    new_password = secrets.token_urlsafe(24)
    response = await r.client.post("/api/auth/password/change", json={"currentPassword": data["password"], "password": new_password})
    assert response.status == 200
    assert (await r.client.get("/api/auth/session")).status == 401
    assert r.svc.managed_runtime.account.verify("owner", new_password)
    for _ in range(5):
        await r.client.post("/api/auth/password/login", json={"username": "owner", "password": "bad"})
    assert (await r.client.post("/api/auth/password/login", json=data)).status == 429


async def test_business_api_config_install_and_safe_paths(runtime):
    r = runtime
    for path in ("/api/settings", "/api/channels", "/api/memory/categories", "/api/skills", "/api/mcp/status", "/api/conversations"):
        response = await r.client.get(path, headers=r.auth)
        assert response.status == 200, (path, await response.text())
    before = await (await r.client.get("/api/managed/v1/config", headers=r.auth)).json()
    assert "managed" not in before["config"] and "telegram" not in before["config"]
    assert r.values["OPENBEAR_MANAGEMENT_KEY"] not in json.dumps(before)
    response = await r.client.patch("/api/managed/v1/config", headers=r.auth, json={"agent": {"maxRetries": 4}})
    assert response.status == 200, await response.text()
    after = (await response.json())["config"]
    assert after["agent"]["maxRetries"] == 4 and after["models"] == before["config"]["models"]
    for patch in ({"managed": {"enabled": False}}, {"web": {"enabled": False}}, {"tools": {"skillsDir": "/tmp/escape"}}):
        assert (await r.client.patch("/api/managed/v1/config", headers=r.auth, json=patch)).status == 400
    response = await r.client.put("/api/managed/v1/files/skills/demo/SKILL.md", headers=r.auth,
                                  json={"content": "---\nname: demo\ndescription: Temporary test skill\n---\nA test skill.\n"})
    assert response.status == 200
    assert (r.root / "skills/demo/SKILL.md").is_file()
    assert (await r.client.post("/api/skills/reload", headers=r.auth)).status == 200
    skills = (await (await r.client.get("/api/skills", headers=r.auth)).json())["items"]
    assert any(skill["name"] == "demo" for skill in skills)
    (r.root / "skills/link").symlink_to(r.root / "workspace", target_is_directory=True)
    assert (await r.client.put("/api/managed/v1/files/skills/link/bad", headers=r.auth, json={"content": "x"})).status == 400
    assert (await r.client.put("/api/managed/v1/files/mcp/server/main.py", headers=r.auth, json={"content": "print('ok')\n"})).status == 200
    assert (r.root / "mcp-servers/server/main.py").is_file()


async def test_jobs_real_subprocess_timeout_cancel_and_env(runtime, monkeypatch):
    r = runtime
    monkeypatch.setenv("OPENBEAR_MANAGEMENT_KEY", secrets.token_urlsafe(32))
    response = await r.client.post("/api/managed/v1/jobs", headers=r.auth,
        json={"command": "printf '%s' \"${OPENBEAR_MANAGEMENT_KEY-unset}\"; printf persisted > marker.txt", "timeoutSeconds": 5})
    assert response.status == 202
    job_id = (await response.json())["job"]["id"]
    await r.svc.managed_runtime.jobs.tasks[job_id]
    job = (await (await r.client.get("/api/managed/v1/jobs/" + job_id, headers=r.auth)).json())["job"]
    assert job["status"] == "completed" and job["output"] == "unset"
    assert (r.root / "workspace/marker.txt").read_text() == "persisted"
    for timeout in (0, 3601, float('inf')):
        assert (await r.client.post("/api/managed/v1/jobs", headers=r.auth, json={"command": "true", "timeoutSeconds": timeout})).status == 400
    job = await r.svc.managed_runtime.jobs.create("sleep 30", 1)
    await r.svc.managed_runtime.jobs.tasks[job["id"]]
    assert (await r.svc.managed_runtime.jobs.get(job["id"]))["status"] == "timed_out"
    job = await r.svc.managed_runtime.jobs.create("sleep 30", 30)
    await asyncio.sleep(.1)
    response = await r.client.post("/api/managed/v1/jobs/" + job["id"] + "/cancel", headers=r.auth)
    assert (await response.json())["job"]["status"] == "cancelled"


def test_business_policy():
    assert business_route_allowed("PATCH", "/api/mcp/servers/demo/enabled")
    for path in ("/api/auth/session", "/api/instances", "/api/system/update", "/api/instance-events/v1", "/api/memory/../auth/session", "/api/memory/%2e%2e/auth"):
        assert not business_route_allowed("POST", path)


async def test_persistent_identity_account_and_pepper(runtime):
    r = runtime
    cfg = load_config()
    assert cfg.managed.management_key == r.values["OPENBEAR_MANAGEMENT_KEY"]
    account = LocalAccount(str(r.root))
    assert account.verify("owner", r.values["OPENBEAR_PASSWORD"])
    assert cfg.managed.persist() == r.svc.managed_runtime.pepper
    assert r.values["OPENBEAR_PASSWORD"] not in account.path.read_text()
    assert account.path.stat().st_mode & 0o077 == 0
    identity = json.loads((r.root / ".managed/identity.json").read_text())
    assert not {"report_token", "controller_url"} & set(identity)


@pytest.mark.parametrize("auth_mode", ["local", "gateway"])
async def test_full_startup_shutdown_without_telegram(monkeypatch, tmp_path, auth_mode):
    root, values, raw = seed(monkeypatch, tmp_path)
    monkeypatch.setenv("OPENBEAR_CHILD_AUTH", auth_mode)
    gateway_key = secrets.token_urlsafe(32)
    if auth_mode == "gateway":
        monkeypatch.setenv("OPENBEAR_GATEWAY_KEY", gateway_key)
        monkeypatch.delenv("OPENBEAR_USERNAME")
        monkeypatch.delenv("OPENBEAR_PASSWORD")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    raw["web"]["port"] = port
    Path(values["OPENBEAR_CONFIG"]).write_text(json.dumps(raw))
    def no_bot(*args, **kwargs):
        raise AssertionError("managed must never construct a Telegram Bot")
    import app.main
    import app.web_admin
    monkeypatch.setattr(app.main, "Bot", no_bot)
    for name in ("WebTaskTelegramNotifier", "WebTelegramReplies", "InteractionTelegram"):
        monkeypatch.setattr(app.web_admin, name, no_bot)
    svc = Services(load_config())
    async def no_network_catalog():
        pass
    monkeypatch.setattr(svc.models_dev_catalog, "start", no_network_catalog)
    try:
        await svc.startup()
        async with aiohttp.ClientSession() as client:
            response = await client.get(f"http://127.0.0.1:{port}/api/managed/v1/status", headers={"Authorization": "Bearer " + values["OPENBEAR_MANAGEMENT_KEY"]})
            assert response.status == 200 and (await response.json())["ready"]
            if auth_mode == "gateway":
                probe = await client.get(f"http://127.0.0.1:{port}/api/gateway/v1/probe", headers={
                    "X-OpenBear-Gateway-Key": gateway_key, "X-OpenBear-Instance": values["OPENBEAR_INSTANCE_ID"]})
                assert probe.status == 200 and (await probe.json())["ready"]
                assert svc.managed_runtime.account is None
                assert not (root / ".managed/account.json").exists()
    finally:
        await svc.shutdown()
    assert not svc.managed_runtime.ready


async def test_mcp_install_config_reload_and_subprocess_env(runtime, monkeypatch):
    import sys
    r = runtime
    script = '''import sys,json,os
from pathlib import Path
Path('mcp-env-check').write_text(str(not any(k in os.environ for k in ('OPENBEAR_MANAGEMENT_KEY','OPENBEAR_REPORT_TOKEN','OPENBEAR_PASSWORD'))))
for line in sys.stdin:
    msg=json.loads(line)
    if 'id' not in msg: continue
    method=msg.get('method')
    result={}
    if method=='initialize': result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'managed-test','version':'1'}}
    elif method=='tools/list': result={'tools':[{'name':'check','description':'Temporary test','inputSchema':{'type':'object','properties':{}}}]}
    elif method=='tools/call': result={'content':[{'type':'text','text':'ok'}]}
    print(json.dumps({'jsonrpc':'2.0','id':msg['id'],'result':result}),flush=True)
'''
    response = await r.client.put('/api/managed/v1/files/mcp/check/main.py', headers=r.auth, json={'content': script})
    assert response.status == 200
    monkeypatch.setenv('OPENBEAR_MANAGEMENT_KEY', r.values['OPENBEAR_MANAGEMENT_KEY'])
    response = await r.client.patch('/api/managed/v1/config', headers=r.auth, json={'mcp': {'enabled': True, 'servers': {
        'check': {'command': sys.executable, 'args': [str(r.root / 'mcp-servers/check/main.py')],
                  'cwd': r.svc.workspace_dir, 'stdioMode': 'newline', 'approval': 'allow',
                  'env': {'OPENBEAR_REPORT_TOKEN': secrets.token_urlsafe(32)}}}}})
    assert response.status == 200
    if r.svc._mcp_reload_task:
        await r.svc._mcp_reload_task
    assert (r.root / 'workspace/mcp-env-check').read_text() == 'True'
    assert any(tool.original_tool_name == 'check' for tool in r.svc.mcp.available_tools())
    assert (await r.client.post('/api/mcp/reload', headers=r.auth)).status == 200
    assert r.svc.bot is None


def test_path_escape_and_identity_mismatch_fail_closed(monkeypatch, tmp_path):
    root, values, raw = seed(monkeypatch, tmp_path)
    (root / 'workspace').symlink_to(tmp_path)
    with pytest.raises(ValueError):
        load_config()
    (root / 'workspace').unlink()
    config = load_config()
    config.managed.persist()
    monkeypatch.setenv('OPENBEAR_INSTANCE_ID', secrets.token_hex(12))
    with pytest.raises(ValueError):
        load_config()


async def test_managed_websocket_chat_turn_without_telegram_or_business_reports(runtime):
    from app.llm.events import StreamEvent
    from tests.test_web_admin import FakeRunFactory, FakeStreamBackend
    r = runtime
    backend = FakeStreamBackend([[StreamEvent(kind='content', text='managed chat proof'), StreamEvent(kind='finish', finish_reason='stop')]])
    r.svc.web_admin.llm_factory = FakeRunFactory(backend, context_window=128000)
    row = await r.svc.web_admin._create_web_conversation(LOCAL_OWNER_ID, title='managed chat test', model='test/model')
    ws = await r.client.ws_connect('/api/conversations/' + row['conversation_uuid'] + '/ws', headers=r.auth)
    events = []
    try:
        await ws.receive_json(timeout=5)
        await ws.send_json({'type': 'send', 'text': 'temporary isolated chat proof'})
        for _ in range(100):
            event = await ws.receive_json(timeout=10)
            events.append(event)
            if 'managed chat proof' in json.dumps(event):
                break
        assert 'managed chat proof' in json.dumps(events)
        task = r.svc.runs.task(row['internal_chat_id'])
        if task:
            await asyncio.wait_for(task, timeout=10)
        await asyncio.sleep(0)
        assert not r.svc.runs.is_running(row['internal_chat_id'])
        assert backend.calls == 1 and r.svc.bot is None
    finally:
        await ws.close()


async def test_managed_local_owner_cron_and_webhook(runtime):
    """Real background services/turns; only the model stream is simulated."""
    from app.llm.events import StreamEvent, ToolCall
    from app.webhooks.repository import many, one
    from tests.test_web_admin import FakeRunFactory, FakeStreamBackend
    r = runtime
    host, owner = r.svc.web_admin, LOCAL_OWNER_ID
    assert r.svc.bot is None and host.bot is None
    assert host.config.telegram is None
    folder = secrets.token_hex(12)
    await r.svc.db.conn.execute(
        'INSERT INTO web_conversation_folders(folder_uuid,owner_chat_id,name) VALUES(?,?,?)',
        (folder, owner, 'Managed background acceptance'))
    await r.svc.db.conn.commit()

    # Cron: create and run through management-key HTTP, including a deliberately
    # enabled Telegram-only notification policy (no fake bot to satisfy it).
    cron_backend = FakeStreamBackend()
    host.llm_factory = FakeRunFactory(cron_backend, context_window=128000)
    response = await r.client.post('/api/cron/jobs', headers=r.auth, json={
        'folderId': folder, 'name': 'Managed Cron', 'enabled': True, 'requestId': secrets.token_hex(12),
        'config': {'instructions': 'Finish this isolated check.', 'schedule': {'kind': 'every', 'everySeconds': 60},
                   'notifications': {'mode': 'telegram'}}})
    assert response.status == 200
    job = (await response.json())['job']
    response = await r.client.post('/api/cron/jobs/' + job['id'] + '/run', headers=r.auth,
        json={'expectedRevision': job['revision'], 'requestId': secrets.token_hex(12)})
    assert response.status == 200
    accepted = await response.json()
    await asyncio.wait_for(asyncio.gather(*list(r.svc.cron.tasks.values())), 15)
    cron = (await r.svc.cron.get_run(owner, accepted['run']['id']))['run']
    assert cron['status'] == 'completed' and cron['finalText'] == 'ok'
    assert cron['notificationState'] == 'suppressed' and cron_backend.calls == 1

    # Webhook: producer credential is separate from management; run the actual
    # worker/bridge, file its existing business receipt, and finalize normally.
    response = await r.client.post('/api/webhooks', headers=r.auth, json={
        'scope': {'type': 'folder', 'id': folder}, 'name': 'Managed Webhook', 'enabled': True,
        'requestId': secrets.token_hex(12), 'config': {'processing': {'instructions': 'Handle only this fixture event.'},
                                                    'batching': {'enabled': False}}})
    assert response.status == 201
    hook = await response.json()
    response = await r.client.post('/webhook/' + hook['endpoint']['id'], json={'test': True},
        headers={'Authorization': 'Bearer ' + hook['credential']['key']})
    assert response.status == 202
    event = await response.json()
    webhook_backend = FakeStreamBackend([
        [StreamEvent(kind='tool_call', tool_calls=[ToolCall('receipt', 'Webhook', json.dumps({
            'action': 'report', 'params': {'receiptId': secrets.token_hex(8), 'results': [
                {'eventId': event['eventId'], 'outcome': 'completed', 'summary': 'Managed fixture'}]}}))]),
         StreamEvent(kind='finish', finish_reason='tool_calls')],
        [StreamEvent(kind='content', text='Managed webhook done'), StreamEvent(kind='finish', finish_reason='stop')]])
    host.llm_factory = FakeRunFactory(webhook_backend, context_window=128000)
    await r.svc.webhook_worker.tick()
    tasks = host.runs.scheduler.tasks(kind='controller')
    assert tasks
    await asyncio.wait_for(asyncio.gather(*tasks), 15)
    assignment = await one(r.svc.db.conn, 'SELECT * FROM webhook_assignments')
    assert assignment['state'] == 'finalized' and assignment['terminal_reason'] == 'normal'
    assert await one(r.svc.db.conn, 'SELECT source,outcome FROM webhook_receipts') == {'source': 'model', 'outcome': 'completed'}
    await r.svc.webhook_worker.tick()  # Existing notification/finalization cleanup.
    assert webhook_backend.calls == 2

    conversations = await many(r.svc.db.conn, 'SELECT owner_chat_id,origin_kind FROM web_conversations')
    assert len(conversations) == 2 and all(c['owner_chat_id'] == owner for c in conversations)
    assert not host.runs.scheduler.tasks(kind='controller')
    assert not await many(r.svc.db.conn, "SELECT * FROM web_operations WHERE lifecycle='active'")
    assert all(getattr(host, name) is None for name in ('web_task_telegram', 'telegram_replies', 'interaction_telegram'))
    assert not await many(r.svc.db.conn, 'SELECT * FROM web_tg_notification_outbox')
