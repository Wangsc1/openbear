from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp.test_utils import TestClient, TestServer
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.db.engine import DB
from app.web_admin import WebAdminServer
from app.web_console.core import _COOKIE, _sha256
from app.web_console.live_stream import _WebLiveStream
from app.web_push import BrowserPush, b64url, validate_subscription


def subscription(endpoint="https://fcm.googleapis.com/wp/device-one"):
    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {"endpoint": endpoint, "keys": {"p256dh": b64url(public), "auth": b64url(b"0123456789abcdef")}}


@pytest.fixture
async def db(tmp_path):
    db = DB(str(tmp_path / "push.db"))
    await db.connect()
    await db.conn.execute("INSERT INTO web_sessions(session_token_hash,chat_id,expires_at) VALUES(?,?,?)", (_sha256("token"), 123, int(time.time()) + 3600))
    await db.conn.commit()
    yield db
    await db.close()


async def add_device(db, *, owner=123, endpoint="https://fcm.googleapis.com/wp/device-one"):
    info = subscription(endpoint)
    await db.conn.execute("""INSERT INTO web_push_subscriptions(endpoint,owner_chat_id,session_token_hash,subscription_json,origin,updated_at)
        VALUES(?,?,?,?,?,?)""", (endpoint, owner, _sha256("token"), json.dumps(info), "https://bear.example.test", int(time.time())))
    await db.conn.commit()
    return info


async def observe(push, kind, **extra):
    await push.observe({"type": kind, "runUuid": "run", "turnUuid": "turn", "conversationUuid": "conv", **extra}, owner_chat_id=123, internal_chat_id=-1)


async def deliveries(db):
    return [dict(r) for r in await (await db.conn.execute("SELECT * FROM web_push_deliveries ORDER BY id")).fetchall()]


@pytest.mark.parametrize("endpoint", ["http://fcm.googleapis.com/wp/a", "https://127.0.0.1/x", "https://fcm.googleapis.com.evil.test/x", "https://evil.test/x", "https://a:b@web.push.apple.com/x", "https://web.push.apple.com:444/x", "https://web.push.apple.com/x#bad"])
def test_endpoint_validation(endpoint):
    with pytest.raises(ValueError):
        validate_subscription(subscription(endpoint))


@pytest.mark.parametrize("endpoint", ["https://fcm.googleapis.com/wp/a", "https://updates.push.services.mozilla.com/wpush/v2/a", "https://web.push.apple.com/a", "https://wns2-bl2p.notify.windows.com/a"])
def test_supported_push_endpoints(endpoint):
    assert validate_subscription(subscription(endpoint))["endpoint"] == endpoint


async def test_vapid_keys_persist_and_are_unique_per_database(db):
    first, concurrent = await asyncio.gather(BrowserPush(db).key_pair(), BrowserPush(db).key_pair())
    assert first == concurrent == await BrowserPush(db).key_pair()
    assert first[0].startswith("-----BEGIN PRIVATE KEY-----")
    assert len(first[1]) == 87


async def test_terminal_deduplication_no_final_or_retry_notification(db):
    await add_device(db)
    push = BrowserPush(db)
    await observe(push, "accepted")
    for event in ["delta", "final", "retry_wait", "tool_result"]:
        await observe(push, event, text="private answer", reasoning="private reasoning")
    assert not await deliveries(db)
    await observe(push, "error")
    await observe(push, "done")
    await observe(push, "error")
    rows = await deliveries(db)
    assert len(rows) == 1
    assert json.loads(rows[0]["payload_json"])["kind"] == "failed"
    assert "private" not in rows[0]["payload_json"]


async def test_live_stream_completes_by_run_not_latest_steering_turn(db):
    await add_device(db)
    push = BrowserPush(db)
    async def sink(event):
        await push.observe(event, owner_chat_id=123, internal_chat_id=-1)
        return event
    live = _WebLiveStream("conv", -1, event_sink=sink)
    await live.publish({"type": "accepted", "turnUuid": "turn", "runUuid": "run"})
    await live.publish({"type": "user", "turnUuid": "later-steering-turn"})
    await live.publish({"type": "final", "text": "private result"})
    await live.publish({"type": "done"})
    rows = await deliveries(db)
    assert len(rows) == 1 and rows[0]["event_key"] == "run:run"
    assert json.loads(rows[0]["payload_json"])["kind"] == "completed"


@pytest.mark.parametrize("flag", ["hidden", "internal", "taskNotificationSilent"])
async def test_internal_turns_do_not_notify(db, flag):
    await add_device(db)
    push = BrowserPush(db)
    await observe(push, "accepted", **{flag: True})
    await observe(push, "done")
    assert not await deliveries(db)


async def test_no_subscription_and_explicit_stop_do_not_notify(db):
    push = BrowserPush(db)
    await observe(push, "accepted")
    await observe(push, "done")
    assert not await deliveries(db)
    await add_device(db)
    await observe(push, "accepted")
    await observe(push, "stopped")
    await observe(push, "done")
    assert not await deliveries(db)


async def test_interaction_private_content_never_sent_and_resolved_queue_removed(db):
    await add_device(db)
    push = BrowserPush(db)
    item = {"interactionId": "question", "ownerChatId": 123, "conversationUuid": "conv", "sensitive": True, "title": "secret", "body": "secret", "result": {"text": "secret"}}
    await push.on_interaction("created", item)
    await push.on_interaction("created", item)
    rows = await deliveries(db)
    assert len(rows) == 1 and "secret" not in rows[0]["payload_json"]
    await push.on_interaction("resolved", item)
    assert not await deliveries(db)


async def test_worker_restart_retry_and_gone_subscription_cleanup(db):
    await add_device(db)
    push = BrowserPush(db)
    await push.enqueue(123, "conv", "one", "completed")
    push = BrowserPush(db)  # durable queue, not in-memory handoff
    push.send = AsyncMock(return_value=503)
    assert await push.deliver_one()
    row = (await deliveries(db))[0]
    assert row["attempts"] == 1 and row["state"] == "pending"
    await db.conn.execute("UPDATE web_push_deliveries SET next_attempt_at=0")
    await db.conn.commit()
    push.send = AsyncMock(return_value=410)
    assert await push.deliver_one()
    assert not await push.subscriptions(123)
    assert (await deliveries(db))[0]["state"] == "failed"


@pytest.mark.parametrize("revoke", [True, False])
async def test_session_revoke_or_expiry_stops_queued_notifications(db, revoke):
    await add_device(db)
    push = BrowserPush(db)
    await push.enqueue(123, "conv", "one", "completed")
    await db.conn.execute("UPDATE web_sessions SET " + ("revoked_at=1" if revoke else "expires_at=1"))
    await db.conn.commit()
    push.send = AsyncMock(return_value=201)
    await push.deliver_one()
    push.send.assert_not_called()
    assert not await push.subscriptions(123)


async def test_presence_suppresses_only_matching_foreground_device(db):
    await add_device(db)
    await add_device(db, endpoint="https://web.push.apple.com/second")
    push = BrowserPush(db)
    rows = await push.subscriptions(123)
    push.presence[rows[0]["id"]] = ("conv", time.monotonic() + 45)
    push.send = AsyncMock(return_value=201)
    await push.enqueue(123, "conv", "one", "completed")
    await push.deliver_one()
    await push.deliver_one()
    assert push.send.await_count == 1
    assert push.send.call_args.args[0]["id"] == rows[1]["id"]


async def test_encryption_vapid_and_no_redirect_transport(db):
    import http_ece
    receiver = ec.generate_private_key(ec.SECP256R1())
    public = receiver.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    info = {"endpoint": "https://web.push.apple.com/device", "keys": {"p256dh": b64url(public), "auth": b64url(b"0123456789abcdef")}}
    push = BrowserPush(db)
    calls = []
    class Response:
        async def __aenter__(self): return SimpleNamespace(status=201)
        async def __aexit__(self, *args): pass
    class HTTP:
        def post(self, url, **kwargs):
            calls.append((url, kwargs))
            return Response()
    push.http = HTTP()
    payload = push.payload("completed", "conv", "one")
    status = await push.send({"subscription_json": json.dumps(info), "origin": "https://bear.example.test"}, payload)
    assert status == 201
    _, kwargs = calls[0]
    assert kwargs["allow_redirects"] is False
    assert kwargs["headers"]["Content-Encoding"] == "aes128gcm"
    assert kwargs["headers"]["Authorization"].startswith("vapid ")
    decrypted = http_ece.decrypt(kwargs["data"], private_key=receiver, auth_secret=b"0123456789abcdef", version="aes128gcm")
    assert json.loads(decrypted) == payload


@pytest.fixture
async def client(db):
    server = WebAdminServer.__new__(WebAdminServer)
    server.db = db
    server.config = SimpleNamespace(web=SimpleNamespace(custom_url=""))
    server.browser_push = BrowserPush(db)
    async def lifecycle(app): yield
    async def shutdown(app): pass
    server._realtime_context = lifecycle
    server._realtime_shutdown = shutdown
    server._web_push_context = lifecycle  # Tests drain the real queue explicitly.
    client = TestClient(TestServer(server.make_app()))
    await client.start_server()
    client.session.cookie_jar.update_cookies({_COOKIE: "token"})
    yield SimpleNamespace(client=client, server=server)
    await client.close()


async def test_http_subscription_status_test_disable_and_csrf(client, db):
    http = client.client
    data = await (await http.get("/api/push/key")).json()
    assert data["ok"] and len(data["publicKey"]) == 87 and "private" not in str(data).lower()
    info = subscription()
    response = await http.post("/api/push/subscription", json={"subscription": info}, headers={"Origin": "https://evil.test"})
    assert response.status == 403
    response = await http.post("/api/push/subscription", json={"subscription": info})
    assert response.status == 200
    response = await http.post("/api/push/status", json={"endpoint": info["endpoint"]})
    assert (await response.json())["enabled"] is True
    client.server.browser_push.send = AsyncMock(return_value=201)
    response = await http.post("/api/push/test", json={"endpoint": info["endpoint"]})
    assert (await response.json()) == {"ok": True, "accepted": True}
    response = await http.delete("/api/push/subscription", json={"endpoint": info["endpoint"]})
    assert (await response.json())["enabled"] is False
    assert not await client.server.browser_push.subscriptions(123)
    http.session.cookie_jar.clear()
    assert (await http.get("/api/push/key")).status == 401


async def test_http_rejects_invalid_keys_and_another_owner(client, db):
    info = await add_device(db, owner=999)
    response = await client.client.post("/api/push/subscription", json={"subscription": info})
    assert response.status == 409
    info["keys"]["auth"] = "invalid"
    response = await client.client.post("/api/push/subscription", json={"subscription": info})
    assert response.status == 400
