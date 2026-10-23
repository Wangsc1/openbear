"""Durable push-only gateway sessions; never usable as node login cookies."""
from __future__ import annotations

import hashlib
import json
import time

import aiohttp

from app.managed.http import valid_gateway_key
from app.managed.settings import LOCAL_OWNER_ID, validate_origin

MAX_SESSIONS = 1000
ACTIVE_SUBSCRIPTIONS = """SELECT p.* FROM web_push_subscriptions p JOIN managed_push_sessions s
ON s.session_hash=p.session_token_hash AND p.owner_chat_id=1
WHERE s.revoked_at=0 AND s.expires_at>?"""


class GatewaySessionInactive(Exception):
    pass


class GatewaySessionUnavailable(Exception):
    pass


class GatewayPushSessions:
    def __init__(self, db, settings):
        self.db, self.settings = db, settings

    async def open(self):
        async with self.db.write_transaction(label="gateway-push-schema") as conn:
            await conn.execute("""CREATE TABLE IF NOT EXISTS managed_push_sessions (
                session_hash TEXT PRIMARY KEY, instance_id TEXT NOT NULL,
                origin TEXT NOT NULL, expires_at INTEGER NOT NULL,
                revoked_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)""")

    async def prune(self):
        # Bounded table, no wholesale rewrite of business sessions/subscriptions.
        async with self.db.write_transaction(label="gateway-push-prune", wait_timeout_s=0.01,
                                             sqlite_busy_timeout_ms=25) as conn:
            expired = "SELECT session_hash FROM managed_push_sessions WHERE expires_at<=? OR revoked_at>0"
            now = int(time.time())
            await conn.execute(f"""DELETE FROM web_push_deliveries WHERE subscription_id IN
                (SELECT id FROM web_push_subscriptions WHERE session_token_hash IN ({expired}))""", (now,))
            await conn.execute(f"DELETE FROM web_push_subscriptions WHERE session_token_hash IN ({expired})", (now,))
            await conn.execute("DELETE FROM managed_push_sessions WHERE expires_at<=? OR revoked_at>0", (now,))

    async def bind(self, request) -> tuple[str, str]:
        # Recheck the actual secret + instance + opaque upstream session, rather
        # than trusting that a caller's Origin/body or a management key is a user.
        if not valid_gateway_key(request, self):
            raise GatewaySessionInactive()
        try:
            origin = validate_origin(request.headers.get("X-OpenBear-Gateway-Origin", ""))
            raw = request.headers.get("X-OpenBear-Gateway-Expires", "")
            if not raw.isascii() or not raw.isdecimal() or len(raw) > 18:
                raise ValueError()
            expires = int(raw)
            if expires <= int(time.time()):
                raise ValueError()
        except ValueError:
            raise GatewaySessionInactive() from None
        session_hash = hashlib.sha256(request.headers["X-OpenBear-Gateway-Session"].encode()).hexdigest()
        await self.prune()
        async with self.db.write_transaction(label="gateway-push-bind") as conn:
            row = await (await conn.execute("SELECT * FROM managed_push_sessions WHERE session_hash=?", (session_hash,))).fetchone()
            if row:
                if row['instance_id'] != self.settings.instance_id or row['origin'] != origin or row['revoked_at']:
                    raise GatewaySessionInactive()
                # Never extend a recorded deadline using a delayed request.
                await conn.execute("UPDATE managed_push_sessions SET expires_at=MIN(expires_at,?) WHERE session_hash=?", (expires, session_hash))
            else:
                count = await (await conn.execute("SELECT COUNT(*) FROM managed_push_sessions")).fetchone()
                if count[0] >= MAX_SESSIONS:
                    raise GatewaySessionUnavailable()
                await conn.execute("""INSERT INTO managed_push_sessions(session_hash,instance_id,origin,expires_at,created_at)
                    VALUES(?,?,?,?,?)""", (session_hash, self.settings.instance_id, origin, expires, int(time.time())))
        return session_hash, origin

    async def _revoke(self, session_hash):
        async with self.db.write_transaction(label="gateway-push-revoke") as conn:
            await conn.execute("UPDATE managed_push_sessions SET revoked_at=? WHERE session_hash=?", (int(time.time()), session_hash))
            await conn.execute("""UPDATE web_push_deliveries SET state='suppressed',last_error='gateway_session_inactive'
                WHERE state='pending' AND subscription_id IN
                (SELECT id FROM web_push_subscriptions WHERE session_token_hash=?)""", (session_hash,))

    async def check(self, subscription, http):
        session_hash = subscription['session_token_hash']
        row = await (await self.db.conn.execute("SELECT * FROM managed_push_sessions WHERE session_hash=?", (session_hash,))).fetchone()
        if (not row or subscription['owner_chat_id'] != LOCAL_OWNER_ID or row['instance_id'] != self.settings.instance_id
                or row['revoked_at'] or row['expires_at'] <= int(time.time())):
            raise GatewaySessionInactive()
        # No cache authorizes a send. Gateway outages, malformed responses,
        # credential failures, redirects, and TLS errors all fail closed.
        try:
            origin = validate_origin(row['origin'])
            headers = {'Authorization': 'Bearer ' + self.settings.gateway_key,
                       'X-OpenBear-Instance': self.settings.instance_id,
                       'X-OpenBear-Gateway-Session-Hash': session_hash}
            async with http.get(origin + '/api/gateway/v1/session-status', headers=headers,
                                timeout=aiohttp.ClientTimeout(total=5), allow_redirects=False) as response:
                if response.status != 200:
                    raise GatewaySessionUnavailable()
                raw = bytearray()
                async for chunk in response.content.iter_chunked(1024):
                    raw.extend(chunk)
                    if len(raw) > 4096:
                        raise GatewaySessionUnavailable()
                value = json.loads(raw)
                if (not isinstance(value, dict) or value.get('ok') is not True or not isinstance(value.get('active'), bool)
                        or type(value.get('expiresAt')) is not int or not 0 <= value['expiresAt'] < 10**18):
                    raise GatewaySessionUnavailable()
        except (aiohttp.ClientError, TimeoutError, ValueError, AttributeError):
            raise GatewaySessionUnavailable() from None
        if not value['active'] or value['expiresAt'] <= int(time.time()):
            await self._revoke(session_hash)
            raise GatewaySessionInactive()
        async with self.db.write_transaction(label="gateway-push-deadline") as conn:
            await conn.execute("UPDATE managed_push_sessions SET expires_at=MIN(expires_at,?) WHERE session_hash=?",
                               (value['expiresAt'], session_hash))
            # A rebind/unsubscribe during the HTTP await must not send to a
            # different session that now owns the same browser endpoint.
            current = await (await conn.execute("""SELECT 1 FROM web_push_subscriptions p
                JOIN managed_push_sessions s ON s.session_hash=p.session_token_hash
                WHERE p.id=? AND p.session_token_hash=? AND p.owner_chat_id=?
                AND s.revoked_at=0 AND s.expires_at>?""",
                (subscription['id'], session_hash, LOCAL_OWNER_ID, int(time.time())))).fetchone()
            if not current:
                raise GatewaySessionInactive()
