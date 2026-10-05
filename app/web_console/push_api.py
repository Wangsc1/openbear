"""Authenticated per-device Web Push controls."""
from __future__ import annotations

import json
import time
from urllib.parse import urlsplit

from aiohttp import web

from app.web_console.core import _COOKIE, _WEB_SESSION_KEY, _sha256
from app.web_push import validate_subscription


class WebAdminPushMixin:
    async def _web_push_context(self, app):
        # Application cleanup contexts start before the HTTP site. Invalidate
        # waiters from the previous process before any pending push can leave.
        interactions = getattr(self, "interactions", None)
        if interactions:
            await interactions.start()
        push = getattr(self, "browser_push", None)
        if push:
            await push.start()
        try:
            yield
        finally:
            if push:
                await push.stop()

    async def handle_api_push_key(self, request):
        _, public = await self.browser_push.key_pair()
        return web.json_response({"ok": True, "publicKey": public}, headers={"Cache-Control": "no-store"})

    async def handle_api_push_status(self, request):
        session = request[_WEB_SESSION_KEY]
        body = await self._json_body(request)
        row = await (await self.db.conn.execute("""SELECT id FROM web_push_subscriptions
            WHERE endpoint=? AND owner_chat_id=? AND session_token_hash=?""",
            (str(body.get("endpoint") or ""), session.chat_id, _sha256(request.cookies.get(_COOKIE, ""))))).fetchone()
        return web.json_response({"ok": True, "enabled": bool(row)}, headers={"Cache-Control": "no-store"})

    async def handle_api_push_presence(self, request):
        body = await self._json_body(request)
        row = await (await self.db.conn.execute("""SELECT id FROM web_push_subscriptions
            WHERE endpoint=? AND owner_chat_id=? AND session_token_hash=?""",
            (str(body.get("endpoint") or ""), request[_WEB_SESSION_KEY].chat_id, _sha256(request.cookies.get(_COOKIE, ""))))).fetchone()
        if row:
            conversation = str(body.get("conversationUuid") or "")[:100]
            client_id = str(body.get("clientId") or "legacy")[:100]
            self.browser_push.set_presence(row["id"], client_id, conversation)
        return web.json_response({"ok": True})

    async def handle_api_push_subscribe(self, request):
        session = request[_WEB_SESSION_KEY]
        body = await self._json_body(request)
        try:
            info = validate_subscription(body.get("subscription"))
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        origin = request.headers.get("Origin") or self.config.web.custom_url or f"{request.scheme}://{request.host}"
        url = urlsplit(origin)
        origin = f"{url.scheme}://{url.netloc}"
        async with self.db.write_transaction(label="subscribe-browser-push") as conn:
            existing = await (await conn.execute("SELECT owner_chat_id FROM web_push_subscriptions WHERE endpoint=?", (info["endpoint"],))).fetchone()
            if existing and existing["owner_chat_id"] != session.chat_id:
                return web.json_response({"ok": False, "error": "subscription_owner_mismatch"}, status=409)
            await conn.execute("""INSERT INTO web_push_subscriptions
                (endpoint,owner_chat_id,session_token_hash,subscription_json,origin,updated_at)
                VALUES(?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET
                session_token_hash=excluded.session_token_hash, subscription_json=excluded.subscription_json,
                origin=excluded.origin, updated_at=excluded.updated_at""",
                (info["endpoint"], session.chat_id, _sha256(request.cookies.get(_COOKIE, "")), json.dumps(info), origin, int(time.time())))
        return web.json_response({"ok": True, "enabled": True})

    async def handle_api_push_unsubscribe(self, request):
        body = await self._json_body(request)
        owner = request[_WEB_SESSION_KEY].chat_id
        async with self.db.write_transaction(label="unsubscribe-browser-push") as conn:
            await conn.execute("""DELETE FROM web_push_deliveries WHERE subscription_id IN
                (SELECT id FROM web_push_subscriptions WHERE endpoint=? AND owner_chat_id=?)""", (str(body.get("endpoint") or ""), owner))
            await conn.execute("DELETE FROM web_push_subscriptions WHERE endpoint=? AND owner_chat_id=?", (str(body.get("endpoint") or ""), owner))
        return web.json_response({"ok": True, "enabled": False})

    async def handle_api_push_test(self, request):
        body = await self._json_body(request)
        row = await (await self.db.conn.execute("""SELECT * FROM web_push_subscriptions
            WHERE endpoint=? AND owner_chat_id=? AND session_token_hash=?""",
            (str(body.get("endpoint") or ""), request[_WEB_SESSION_KEY].chat_id, _sha256(request.cookies.get(_COOKIE, ""))))).fetchone()
        if not row:
            return web.json_response({"ok": False, "error": "请先开启本设备通知"}, status=409)
        try:
            status = await self.browser_push.send(dict(row), self.browser_push.payload("test", "", "test:" + str(time.time_ns())))
        except Exception:
            return web.json_response({"ok": False, "error": "无法连接推送服务，请检查服务器网络后重试"}, status=502)
        if status in {404, 410}:
            await self.db.conn.execute("DELETE FROM web_push_subscriptions WHERE id=?", (row["id"],))
            await self.db.conn.commit()
        if not 200 <= status < 300:
            return web.json_response({"ok": False, "error": "推送服务未接受通知，请重新开启或稍后重试", "pushStatus": status}, status=502)
        return web.json_response({"ok": True, "accepted": True})
