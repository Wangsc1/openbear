"""Isolated authenticated WebSocket lifecycle regressions (no live upstream)."""
import asyncio
from types import SimpleNamespace

import pytest
from aiohttp import WSMsgType, web

from tests.test_web_admin import web_env


async def _session(env):
    token = "audit-local-session"
    from app.web_admin import _sha256
    from app.db.engine import now_ts
    await env.db.conn.execute(
        "INSERT INTO web_sessions(session_token_hash,chat_id,created_at,expires_at,last_seen_at,ip,user_agent) VALUES(?,?,?,?,?,?,?)",
        (_sha256(token), 123, now_ts(), now_ts() + 3600, now_ts(), "", ""),
    )
    await env.db.conn.commit()
    return token


@pytest.mark.parametrize("channel", ["conversation", "global"])
async def test_revoked_socket_rejects_next_command_without_waiting_for_heartbeat(web_env, channel):
    token = await _session(web_env)
    row = await web_env.server._create_web_conversation(123, title="auth socket")
    path = (f"/api/conversations/{row['conversation_uuid']}/ws" if channel == "conversation"
            else "/api/events/ws")
    ws = await web_env.client.ws_connect(path, headers={"Cookie": f"openbear_web_session={token}"})
    try:
        initial = await ws.receive_json(timeout=3)
        assert initial["type"] in {"state", "snapshot"}
        await web_env.server.revoke_session(token)
        await ws.send_json({"type": "ping"})
        response = await ws.receive(timeout=3)
        assert response.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING}, response
        assert ws.close_code == 1008
    finally:
        await ws.close()


@pytest.mark.parametrize("channel", ["conversation", "global"])
async def test_revoked_socket_does_not_send_queued_event(web_env, channel):
    token = await _session(web_env)
    row = await web_env.server._create_web_conversation(123, title="revoked subscriber")
    path = (f"/api/conversations/{row['conversation_uuid']}/ws" if channel == "conversation"
            else "/api/events/ws")
    ws = await web_env.client.ws_connect(path, headers={"Cookie": f"openbear_web_session={token}"})
    try:
        assert (await ws.receive_json(timeout=3))["type"] in {"state", "snapshot"}
        await web_env.server.revoke_session(token)
        if channel == "conversation":
            await web_env.server._live_for(row).publish({"type": "notice", "text": "private"})
        else:
            web_env.server.global_realtime.put(next(iter(web_env.server.global_realtime.clients)), {"type": "patch", "private": True})
        response = await ws.receive(timeout=3)
        assert response.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING}, response
        assert ws.close_code == 1008
    finally:
        await ws.close()


async def test_global_writer_failure_closes_channel_instead_of_silent_metadata_loss(web_env):
    token = await _session(web_env)
    ws = await web_env.client.ws_connect(
        "/api/events/ws", headers={"Cookie": f"openbear_web_session={token}"},
    )
    try:
        assert (await ws.receive_json(timeout=3))["type"] == "snapshot"
        hub = web_env.server.global_realtime
        assert len(hub.clients) == 1
        next(iter(hub.clients)).put_nowait({"type": "invalid", "value": object()})
        response = await ws.receive(timeout=3)
        assert response.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING}, response
    finally:
        await ws.close()


async def test_approved_login_request_expires_before_session_consumption(web_env):
    from app.db.engine import now_ts
    await web_env.db.conn.execute(
        "INSERT INTO web_login_requests(request_uuid,chat_id,status,nonce_hash,ip,user_agent,created_at,expires_at) "
        "VALUES('expired-approved',123,'approved','','','',?,?)",
        (now_ts() - 600, now_ts() - 1),
    )
    await web_env.db.conn.commit()
    request = SimpleNamespace(cookies={}, remote="", headers={})
    assert await web_env.server.login_request_status("expired-approved") == "expired"
    with pytest.raises(web.HTTPForbidden):
        await web_env.server.create_session_from_request("expired-approved", request)
    count = await (await web_env.db.conn.execute("SELECT COUNT(*) FROM web_sessions")).fetchone()
    assert count[0] == 0


async def test_concurrent_bad_secrets_do_not_lose_failure_count(web_env, monkeypatch):
    writer = web_env.db.conn._writer
    reader = web_env.db.conn._reader
    original_writer, original_reader = writer.execute, reader.execute
    first_insert, release, second_select = asyncio.Event(), asyncio.Event(), asyncio.Event()
    selections = 0

    async def paused_writer(sql, *args, **kwargs):
        if "INSERT INTO web_login_failures" in sql and not first_insert.is_set():
            first_insert.set()
            await release.wait()
        return await original_writer(sql, *args, **kwargs)

    async def counted_reader(sql, *args, **kwargs):
        nonlocal selections
        cursor = await original_reader(sql, *args, **kwargs)
        if "SELECT failed_count, first_failed_at, blocked_until FROM web_login_failures" in sql:
            selections += 1
            if selections == 2:
                second_select.set()
        return cursor

    monkeypatch.setattr(writer, "execute", paused_writer)
    monkeypatch.setattr(reader, "execute", counted_reader)
    first = asyncio.create_task(web_env.server._record_login_failure("local-test-ip"))
    second = None
    try:
        await asyncio.wait_for(first_insert.wait(), 3)
        second = asyncio.create_task(web_env.server._record_login_failure("local-test-ip"))
        # The old split read/write path lets both readers consume failedCount=0.
        # With one writer transaction, the second reader must wait for commit.
        try:
            await asyncio.wait_for(second_select.wait(), .2)
        except TimeoutError:
            pass
        release.set()
        await asyncio.wait_for(asyncio.gather(first, second), 3)
        count = await (await web_env.db.conn.execute(
            "SELECT failed_count FROM web_login_failures WHERE ip='local-test-ip'",
        )).fetchone()
        assert count["failed_count"] == 2
    finally:
        release.set()
        for task in (first, second):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*(task for task in (first, second) if task is not None), return_exceptions=True)


async def _hold_auth_writer(db, entered, release):
    async with db.write_transaction(label="test-auth-expiry-writer-held"):
        entered.set()
        await release.wait()


async def test_login_approval_cannot_reanimate_expired_request(web_env, monkeypatch):
    from app.web_console import auth_api
    clock = [1_900_000_000]
    monkeypatch.setattr(auth_api, "now_ts", lambda: clock[0])
    await web_env.db.conn.execute(
        "INSERT INTO web_login_requests(request_uuid,chat_id,status,nonce_hash,ip,user_agent,created_at,expires_at) "
        "VALUES('approve-expiry-race',123,'pending','','','',?,?)",
        (clock[0], clock[0] + 1),
    )
    await web_env.db.conn.commit()
    entered, release, attempting = asyncio.Event(), asyncio.Event(), asyncio.Event()
    holder = asyncio.create_task(_hold_auth_writer(web_env.db, entered, release))
    approval = None
    try:
        await asyncio.wait_for(entered.wait(), 3)
        original = web_env.db.conn._acquire_writer

        async def observed_claim():
            attempting.set()
            return await original()

        monkeypatch.setattr(web_env.db.conn, "_acquire_writer", observed_claim)
        approval = asyncio.create_task(web_env.server.decide_login_request("approve-expiry-race", approved=True, decided_by=123))
        await asyncio.wait_for(attempting.wait(), 3)
        clock[0] += 2
        release.set()
        assert await asyncio.wait_for(approval, 3) == "expired"
        assert await web_env.server.login_request_status("approve-expiry-race") == "expired"
        audit = await (await web_env.db.conn.execute("SELECT COUNT(*) FROM audit_logs WHERE kind='web.login.approved'")).fetchone()
        assert audit[0] == 0
    finally:
        release.set()
        if approval is not None and not approval.done():
            approval.cancel()
        await asyncio.gather(holder, *([approval] if approval is not None else []), return_exceptions=True)


async def test_login_consume_expiring_while_waiting_for_writer_does_not_mint_session(web_env, monkeypatch):
    from app.web_console import auth_api
    clock = [1_900_000_000]
    monkeypatch.setattr(auth_api, "now_ts", lambda: clock[0])
    await web_env.db.conn.execute(
        "INSERT INTO web_login_requests(request_uuid,chat_id,status,nonce_hash,ip,user_agent,created_at,expires_at) "
        "VALUES('consume-expiry-race',123,'approved','','','',?,?)",
        (clock[0], clock[0] + 1),
    )
    await web_env.db.conn.commit()
    entered, release, attempting = asyncio.Event(), asyncio.Event(), asyncio.Event()
    holder = asyncio.create_task(_hold_auth_writer(web_env.db, entered, release))
    consume = None
    try:
        await asyncio.wait_for(entered.wait(), 3)
        original = web_env.db.conn._acquire_writer

        async def observed_claim():
            attempting.set()
            return await original()

        monkeypatch.setattr(web_env.db.conn, "_acquire_writer", observed_claim)
        request = SimpleNamespace(cookies={}, remote="", headers={})
        consume = asyncio.create_task(web_env.server.create_session_from_request("consume-expiry-race", request))
        await asyncio.wait_for(attempting.wait(), 3)
        clock[0] += 2
        release.set()
        with pytest.raises(web.HTTPForbidden):
            await asyncio.wait_for(consume, 3)
        count = await (await web_env.db.conn.execute("SELECT COUNT(*) FROM web_sessions")).fetchone()
        assert count[0] == 0
        row = await (await web_env.db.conn.execute("SELECT status FROM web_login_requests WHERE request_uuid='consume-expiry-race'")).fetchone()
        assert row["status"] != "consumed"
    finally:
        release.set()
        if consume is not None and not consume.done():
            consume.cancel()
        await asyncio.gather(holder, *([consume] if consume is not None else []), return_exceptions=True)


async def test_revocation_wins_race_with_stale_last_seen_refresh(web_env, monkeypatch):
    from app.db.engine import now_ts
    from app.web_admin import _sha256
    token = await _session(web_env)
    await web_env.db.conn.execute(
        "UPDATE web_sessions SET last_seen_at=? WHERE session_token_hash=?",
        (now_ts() - 3600, _sha256(token)),
    )
    await web_env.db.conn.commit()
    original = web_env.db.conn.execute
    waiting, release = asyncio.Event(), asyncio.Event()

    async def paused_execute(sql, *args, **kwargs):
        if "UPDATE web_sessions SET last_seen_at=" in sql:
            waiting.set()
            await release.wait()
        return await original(sql, *args, **kwargs)

    monkeypatch.setattr(web_env.db.conn, "execute", paused_execute)
    request = SimpleNamespace(cookies={"openbear_web_session": token})
    refresh = asyncio.create_task(web_env.server.session_from_request(request))
    try:
        await asyncio.wait_for(waiting.wait(), 3)
        await web_env.server.revoke_session(token)
        release.set()
        assert await asyncio.wait_for(refresh, 3) is None
    finally:
        release.set()
        if not refresh.done():
            refresh.cancel()
        await asyncio.gather(refresh, return_exceptions=True)


async def test_concurrent_consumers_get_exactly_one_session(web_env, monkeypatch):
    from app.db.engine import now_ts
    await web_env.db.conn.execute(
        "INSERT INTO web_login_requests(request_uuid,chat_id,status,nonce_hash,ip,user_agent,created_at,expires_at) "
        "VALUES('single-use',123,'approved','','','',?,?)",
        (now_ts(), now_ts() + 3600),
    )
    await web_env.db.conn.commit()
    original_execute = web_env.db.conn.execute
    gate = asyncio.Event()
    selected = 0

    class GatedCursor:
        def __init__(self, cursor):
            self.cursor = cursor

        async def fetchone(self):
            nonlocal selected
            row = await self.cursor.fetchone()
            selected += 1
            if selected == 2:
                gate.set()
            await gate.wait()
            return row

    async def gated_execute(sql, *args, **kwargs):
        cursor = await original_execute(sql, *args, **kwargs)
        if "SELECT chat_id, status, nonce_hash" in sql and "web_login_requests" in sql:
            return GatedCursor(cursor)
        return cursor

    monkeypatch.setattr(web_env.db.conn, "execute", gated_execute)
    request = SimpleNamespace(cookies={}, remote="", headers={})
    results = await asyncio.wait_for(asyncio.gather(
        web_env.server.create_session_from_request("single-use", request),
        web_env.server.create_session_from_request("single-use", request),
        return_exceptions=True,
    ), timeout=3)
    assert len([item for item in results if isinstance(item, str)]) == 1
    assert len([item for item in results if isinstance(item, web.HTTPForbidden)]) == 1
    count = await (await web_env.db.conn.execute("SELECT COUNT(*) FROM web_sessions")).fetchone()
    assert count[0] == 1


async def test_refresh_snapshot_cannot_overtake_a_newer_live_frame(web_env, monkeypatch):
    token = await _session(web_env)
    row = await web_env.server._create_web_conversation(123, title="refresh ordering")
    ws = await web_env.client.ws_connect(
        f"/api/conversations/{row['conversation_uuid']}/ws",
        headers={"Cookie": f"openbear_web_session={token}"},
    )
    entered, release = asyncio.Event(), asyncio.Event()
    original = web_env.server._list_web_conversations

    async def paused_list(*args, **kwargs):
        entered.set()
        await release.wait()
        return await original(*args, **kwargs)

    try:
        assert (await ws.receive_json(timeout=3))["type"] == "state"
        monkeypatch.setattr(web_env.server, "_list_web_conversations", paused_list)
        await ws.send_json({"type": "refresh"})
        await asyncio.wait_for(entered.wait(), 3)
        # Refresh has already materialized its old snapshot. A fresh durable
        # event must not be delivered before that snapshot resets client state.
        published = await web_env.server._live_for(row).publish({"type": "notice", "text": "new"})
        assert published["_webFrames"]
        release.set()
        first = await ws.receive_json(timeout=3)
        second = await ws.receive_json(timeout=3)
        assert first["type"] == "state" and second["type"] == "frame"
        assert first["state"]["frameSeq"] < second["frame"]["frameSeq"]
    finally:
        release.set()
        await ws.close()


async def test_conversation_writer_failure_closes_channel_instead_of_silent_event_loss(web_env):
    token = await _session(web_env)
    row = await web_env.server._create_web_conversation(123, title="broken writer")
    ws = await web_env.client.ws_connect(
        f"/api/conversations/{row['conversation_uuid']}/ws",
        headers={"Cookie": f"openbear_web_session={token}"},
    )
    try:
        assert (await ws.receive_json(timeout=3))["type"] == "state"
        live = web_env.server._live_for(row)
        assert len(live._subscribers) == 1
        # A malformed in-process producer used to kill the writer task while the
        # reader kept this socket open, so subsequent committed frames disappeared.
        next(iter(live._subscribers)).put_nowait({"type": "message_visibility.changed", "visibility": object()})
        response = await ws.receive(timeout=3)
        assert response.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING}, response
    finally:
        await ws.close()
