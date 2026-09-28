"""Opt-in browser notifications, independent of Telegram and its long-task threshold."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import time
from urllib.parse import urlsplit

import aiohttp
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.logging import get_logger

log = get_logger("web.push")
_KEY = "web_push_vapid_private_key"
_ACTIVE = """SELECT p.* FROM web_push_subscriptions p JOIN web_sessions s
ON s.session_token_hash=p.session_token_hash AND s.chat_id=p.owner_chat_id
WHERE s.revoked_at=0 AND s.expires_at>?"""


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def validate_subscription(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("订阅数据无效")
    endpoint = value.get("endpoint")
    if not isinstance(endpoint, str) or len(endpoint) > 4096:
        raise ValueError("推送地址无效")
    try:
        url = urlsplit(endpoint)
        host = (url.hostname or "").lower()
        # A browser supplies the endpoint, but it is still untrusted HTTP input.
        # Only send to the actual supported browser push providers, never a LAN
        # address or a redirect target. Endpoints/tokens must not enter logs.
        allowed = host in {"fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"}
        allowed = allowed or host.endswith(".push.apple.com") or host.endswith(".notify.windows.com")
        if url.scheme != "https" or not allowed or url.port not in {None, 443} or url.username or url.password or url.fragment:
            raise ValueError()
        keys = value.get("keys") or {}
        decoded = {}
        for name, size in (("p256dh", 65), ("auth", 16)):
            text = keys.get(name)
            if not isinstance(text, str) or len(text) > 128:
                raise ValueError()
            raw = base64.b64decode(text + "=" * (-len(text) % 4), altchars=b"-_", validate=True)
            if len(raw) != size:
                raise ValueError()
            decoded[name] = b64url(raw)
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.urlsafe_b64decode(decoded["p256dh"] + "="))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("浏览器推送订阅无效或该推送服务暂不支持") from exc
    return {"endpoint": endpoint, "keys": decoded}


class BrowserPush:
    def __init__(self, db):
        self.db = db
        self.wake = asyncio.Event()
        self.task = None
        self.http = None
        self.presence: dict[int, tuple[str, float]] = {}

    async def key_pair(self) -> tuple[str, str]:
        async with self.db.write_transaction(label="browser-push-key") as conn:
            row = await (await conn.execute("SELECT value FROM app_state WHERE key=?", (_KEY,))).fetchone()
            if row:
                pem = str(row["value"])
                private = serialization.load_pem_private_key(pem.encode(), password=None)
            else:
                private = ec.generate_private_key(ec.SECP256R1())
                pem = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
                await conn.execute("INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?)", (_KEY, pem, int(time.time())))
        public = private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        return pem, b64url(public)

    async def subscriptions(self, owner: int) -> list[dict]:
        rows = await (await self.db.conn.execute(_ACTIVE + " AND p.owner_chat_id=?", (int(time.time()), owner))).fetchall()
        return [dict(row) for row in rows]

    async def start(self):
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
        # A small durable outbox retries transient delivery failures after restart.
        await self.db.conn.execute("DELETE FROM web_push_deliveries WHERE created_at<?", (int(time.time()) - 86400,))
        await self.db.conn.execute("DELETE FROM web_push_runs WHERE created_at<? AND status!='running'", (int(time.time()) - 7 * 86400,))
        await self.db.conn.commit()
        self.task = asyncio.create_task(self._worker(), name="browser-push-delivery")

    async def stop(self):
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
            self.task = None
        if self.http:
            await self.http.close()
            self.http = None

    @staticmethod
    def payload(kind: str, conversation: str, key: str) -> dict:
        labels = {"completed": "任务已完成", "failed": "任务执行失败", "interaction": "有一项操作需要你确认", "test": "本设备的通知测试"}
        return {"title": "OpenBear", "body": labels[kind], "conversationUuid": conversation,
                "tag": "openbear:" + key, "kind": kind, "createdAt": int(time.time())}

    async def enqueue(self, owner: int, conversation: str, key: str, kind: str, *, conn=None):
        rows = await self.subscriptions(owner)
        target = conn or self.db.conn
        now = int(time.time())
        payload = json.dumps(self.payload(kind, conversation, key), ensure_ascii=False)
        for row in rows:
            await target.execute("""INSERT OR IGNORE INTO web_push_deliveries
                (subscription_id,event_key,payload_json,next_attempt_at,created_at) VALUES(?,?,?,?,?)""",
                (row["id"], key, payload, now, now))
        if conn is None:
            await self.db.conn.commit()
        self.wake.set()

    async def observe(self, event: dict, *, owner_chat_id: int, internal_chat_id: int):
        kind = str(event.get("type") or "")
        if kind not in {"accepted", "done", "error", "stopped"}:
            return
        root = str(event.get("runUuid") or event.get("rootTurnUuid") or event.get("turnUuid") or "")
        conversation = str(event.get("conversationUuid") or "")
        if not root or not conversation:
            return
        if kind == "accepted":
            if any(event.get(key) for key in ("taskNotificationSilent", "hidden", "internal")) or not await self.subscriptions(owner_chat_id):
                return
            await self.db.conn.execute("""INSERT OR IGNORE INTO web_push_runs
                (root_uuid,conversation_uuid,owner_chat_id,created_at) VALUES(?,?,?,?)""",
                (root, conversation, owner_chat_id, int(time.time())))
            await self.db.conn.commit()
            return
        status = {"done": "completed", "error": "failed", "stopped": "stopped"}[kind]
        async with self.db.write_transaction(label="browser-push-terminal") as conn:
            changed = await conn.execute("""UPDATE web_push_runs SET status=?
                WHERE root_uuid=? AND owner_chat_id=? AND conversation_uuid=? AND status='running'""",
                (status, root, owner_chat_id, conversation))
            if changed.rowcount and status != "stopped":
                await self.enqueue(owner_chat_id, conversation, "run:" + root, status, conn=conn)
        self.wake.set()  # Wake after COMMIT as well, so the reader sees the new row.

    async def on_interaction(self, event: str, item: dict):
        conversation = str(item.get("conversationUuid") or "")
        key = "interaction:" + str(item.get("interactionId") or "")
        if event == "created" and conversation:
            await self.enqueue(int(item["ownerChatId"]), conversation, key, "interaction")
        elif event != "created":
            await self.db.conn.execute("DELETE FROM web_push_deliveries WHERE event_key=? AND state='pending'", (key,))
            await self.db.conn.commit()

    async def send(self, subscription: dict, payload: dict) -> int:
        # Standard RFC 8291 encryption and VAPID signing; no custom crypto.
        from py_vapid import Vapid
        from pywebpush import WebPusher

        info = validate_subscription(json.loads(subscription["subscription_json"]))
        pem, _ = await self.key_pair()
        url = urlsplit(info["endpoint"])
        subject = subscription["origin"]
        if not subject.startswith("https://"):
            subject = "mailto:notifications@openbear.invalid"
        headers = Vapid.from_pem(pem.encode()).sign({"aud": f"{url.scheme}://{url.netloc}", "sub": subject, "exp": int(time.time()) + 3600})
        encoded = WebPusher(info).encode(json.dumps(payload, ensure_ascii=False).encode(), "aes128gcm")
        headers.update({"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": "900", "Urgency": "normal"})
        async with self.http.post(info["endpoint"], data=encoded["body"], headers=headers, allow_redirects=False) as response:
            return response.status

    async def deliver_one(self) -> bool:
        now = int(time.time())
        row = await (await self.db.conn.execute("""SELECT * FROM web_push_deliveries
            WHERE state='pending' AND next_attempt_at<=? ORDER BY id LIMIT 1""", (now,))).fetchone()
        if not row:
            return False
        subscription = await (await self.db.conn.execute(_ACTIVE + " AND p.id=?", (now, row["subscription_id"]))).fetchone()
        status = 0
        payload = json.loads(row["payload_json"])
        active_conversation, active_until = self.presence.get(row["subscription_id"], ("", 0))
        quiet = bool(active_conversation and active_until > time.monotonic() and active_conversation == payload.get("conversationUuid"))
        if quiet:
            status = 204  # Viewed on this device: no push sent, no silent SW push.
        elif subscription and now - row["created_at"] < 900:
            try:
                status = await self.send(dict(subscription), payload)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Do not log exceptions containing endpoint credentials or payloads.
                log.warning("浏览器推送投递失败", error_type=type(exc).__name__)
        attempts = row["attempts"] + 1
        retry = subscription and now - row["created_at"] < 900 and attempts < 3 and (status == 0 or status == 429 or status >= 500)
        state = "pending" if retry else ("sent" if 200 <= status < 300 else "failed")
        async with self.db.write_transaction(label="browser-push-delivery") as conn:
            await conn.execute("UPDATE web_push_deliveries SET attempts=?,state=?,next_attempt_at=? WHERE id=?", (attempts, state, now + 30 * attempts, row["id"]))
            if status in {404, 410}:
                await conn.execute("DELETE FROM web_push_subscriptions WHERE id=?", (row["subscription_id"],))
        return True

    async def _worker(self):
        while True:
            self.wake.clear()
            try:
                while await self.deliver_one():
                    pass
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("浏览器推送队列暂不可用", error_type=type(exc).__name__)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.wake.wait(), timeout=30)
