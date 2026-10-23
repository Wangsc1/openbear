#!/usr/bin/env python3
"""Verify unpacked release auth, sessions, WebSocket and assets over HTTP only.

Usage: .venv/bin/python scripts/smoke_release_login.py --root /path/to/unpacked/release
Uses the release's real backend, a disposable DB and a fake Bot. No browser,
production configuration, external login approval, updater or system service changes.
Frontend interaction state machines are covered separately by `npm test`.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aiohttp import ClientSession, CookieJar


class FakeBot:
    def __init__(self):
        self.requests = []

    async def send_message(self, chat_id, text, reply_markup=None):
        self.requests.append(reply_markup.inline_keyboard[0][0].callback_data.rsplit(":", 1)[1])
        return SimpleNamespace(message_id=len(self.requests))


async def verify(args):
    root = args.root.resolve()
    dist = (args.dist or root / "web/dist").resolve()
    assert (dist / "index.html").is_file(), "Built frontend missing"
    sys.path.insert(0, str(root))
    # Import from the unpacked release, never silently from the caller's checkout.
    import app.web_console.auth_api as auth_module
    from app import installed_version
    from app.config import Config
    from app.services import Services
    from scripts.release_validation import index_references, probe_deployment

    assert Path(auth_module.__file__).resolve().is_relative_to(root), "Wrong backend imported"
    report = {"transport": "http-websocket", "version": installed_version()}
    with tempfile.TemporaryDirectory(prefix="openbear-release-smoke-") as temp_dir:
        temp = Path(temp_dir)
        old_cwd = Path.cwd()
        environment = patch.dict(os.environ, {
            "OPENBEAR_WEB_ARTIFACT_DIR": str(temp / "artifacts"),
            "OPENBEAR_CONFIG": str(temp / "openbear.json"),
            "OPENBEAR_INSTANCE_ROLE": "controller",
            "OPENBEAR_DISABLE_UPDATE_CHECK": "1",
        })
        environment.start()
        os.chdir(temp)
        config = Config.model_validate({
            "telegram": {"botToken": "test-only", "whitelistIds": [123]},
            "models": {"providers": {"test": {"baseUrl": "http://127.0.0.1:1", "apiKey": "test-only",
                "protocol": "chat", "models": [{"id": "test"}]}}, "primary": "test/test"},
            "memory": {"provider": "builtin"},
            "tools": {"skillsDir": str(temp / "skills")},
            "browser": {"enabled": False}, "mcp": {"enabled": False},
            "storage": {"dbPath": str(temp / "smoke.db")},
            "web": {"enabled": True, "host": "127.0.0.1", "port": 18961},
        })
        config.web.port = 0
        bot = FakeBot()
        service = Services(config, bot)
        server, db = service.web_admin, service.db
        server._web_dist_dir = lambda: dist
        client = None
        try:
            # Replace only optional Internet fetches, never lifecycle/recovery.
            service.models_dev_catalog.refresh = AsyncMock()
            service.cron._sync_holidays = AsyncMock()
            async with asyncio.timeout(30):
                await service.startup()
            assert service.startup_ready.is_set(), "Full service startup never became ready"
            port = server._site._server.sockets[0].getsockname()[1]
            base = f"http://127.0.0.1:{port}"
            client = ClientSession(base_url=base, cookie_jar=CookieJar(unsafe=True))
            secret = await server.get_secret_key()
            report["serviceLifecycle"] = {"fullStartup": True, "ready": True}
            health = await client.get("/health")
            assert health.status == 200
            assert (await health.json()) == {"ok": True, "version": installed_version()}
            login = await client.get("/login")
            assert login.status == 200 and login.headers["Cache-Control"] == "no-store"
            html = await login.text()
            # The server fills in the login mode; a plain install is the controller.
            expected = (dist / "index.html").read_text().replace('"[[controller]]"', '"controller"', 1)
            assert html == expected, "Not serving the packaged frontend"
            references, scripts = index_references(html)
            assert scripts, "Packaged frontend lacks its entry script"
            assets = [ref for ref in references if ref.startswith("/assets/")]
            for ref in assets:
                response = await client.get(ref)
                assert response.status == 200, f"Missing entry asset: {ref}"
                expected = dist / ref.lstrip("/").split("?", 1)[0]
                assert await response.read() == expected.read_bytes(), f"Wrong served asset: {ref}"
            if (dist / "manifest.webmanifest").is_file():
                installation_resources = []
                for url, (relative_path, mime) in auth_module.PWA_PUBLIC_FILES.items():
                    response = await client.get(url, allow_redirects=False)
                    assert response.status == 200, f"Installation resource requires login: {url}"
                    assert response.content_type == mime, f"Wrong installation resource MIME: {url}"
                    assert response.headers.get("X-Content-Type-Options") == "nosniff"
                    assert "no-cache" in response.headers.get("Cache-Control", "")
                    assert await response.read() == (dist / relative_path).read_bytes(), url
                    installation_resources.append(url)
                report["pwaInstallationResources"] = installation_resources
            assert (await client.get("/api/system/version")).status == 401
            assert (await client.get("/api/auth/session")).status == 401
            assert not bot.requests
            report["anonymousHttp"] = {"loginEntryMatchesPackage": True, "protectedApisRejectAnonymous": True,
                                       "entryAssetsMatched": len(assets)}
            if args.anonymous_only:
                return report

            async def start_login():
                client.cookie_jar.clear()
                before = len(bot.requests)
                response = await client.post("/api/auth/login/start", json={"secret": secret})
                assert response.status == 200
                data = await response.json()
                assert len(bot.requests) == before + 1 and bot.requests[-1] == data["requestUuid"]
                assert response.cookies[auth_module._LOGIN_NONCE_COOKIE]["httponly"]
                return data, response.cookies[auth_module._LOGIN_NONCE_COOKIE].value

            data, nonce = await start_login()
            pending = await client.get(data["statusUrl"])
            assert (await pending.json())["status"] == "pending"
            assert pending.headers["Cache-Control"] == "no-store"
            assert (await client.post(data["consumeUrl"])).status == 409
            await server.decide_login_request(data["requestUuid"], approved=True, decided_by=123)
            # An approved request cannot be consumed by a different client/nonce.
            client.cookie_jar.clear()
            assert (await client.post(data["consumeUrl"])).status == 403
            assert await server.login_request_status(data["requestUuid"]) == "approved"
            accepted = await client.post(data["consumeUrl"], cookies={auth_module._LOGIN_NONCE_COOKIE: nonce})
            assert accepted.status == 200
            session_cookie = accepted.cookies["openbear_web_session"]
            assert session_cookie["httponly"] and session_cookie["samesite"] == "Lax"
            cookies = {"openbear_web_session": session_cookie.value}
            session = await client.get("/api/auth/session", cookies=cookies)
            assert session.status == 200 and (await session.json())["chatId"] == 123
            assert session.headers["Cache-Control"] == "no-store"
            assert (await client.post(data["consumeUrl"], cookies=cookies)).status == 403
            assert (await client.get("/api/auth/session", cookies=cookies)).status == 200
            version = await client.get("/api/system/version", cookies=cookies)
            assert version.status == 200 and version.headers["Cache-Control"] == "no-store"
            real_info = server._frontend_build_info()
            assert real_info and (await version.json())["frontend"] == real_info
            report["approvedLogin"] = {"nonceRequired": True, "sessionEstablished": True, "consumeOnce": True,
                                       "existingSessionSurvivesConsumedRequest": True, "buildIdentityMatches": True}

            created = await client.post("/api/conversations", json={"title": "release HTTP smoke"}, cookies=cookies)
            assert created.status == 200, await created.text()
            conversation = (await created.json())["conversation"]["conversationUuid"]
            async with client.ws_connect(
                f"/api/conversations/{conversation}/ws?bootstrap=incremental",
                headers={"Cookie": f"openbear_web_session={session_cookie.value}"},
            ) as ws:
                await ws.send_json({"type": "ping"})
                async with asyncio.timeout(5):
                    while (await ws.receive_json()).get("type") != "pong":
                        pass
            report["conversationWebSocket"] = {"created": True, "authenticatedPingPong": True}

            report["terminalStatuses"] = {}
            for status in ("missing", "consumed", "expired", "rejected", "unexpected"):
                data, _nonce = await start_login()
                if status == "missing":
                    await db.conn.execute("DELETE FROM web_login_requests WHERE request_uuid=?", (data["requestUuid"],))
                else:
                    await db.conn.execute("UPDATE web_login_requests SET status=? WHERE request_uuid=?", (status, data["requestUuid"]))
                await db.conn.commit()
                response = await client.get(data["statusUrl"])
                assert response.status == 200 and (await response.json())["status"] == status
                assert response.headers["Cache-Control"] == "no-store"
                rejected = await client.post(data["consumeUrl"])
                assert rejected.status == 403 and "openbear_web_session" not in rejected.cookies
                report["terminalStatuses"][status] = {"reported": True, "noSessionIssued": True}

            config.web.custom_url = "https://configured.invalid"
            redirect = await client.get("/login", allow_redirects=False)
            assert redirect.status == 302 and redirect.headers["Location"] == "https://configured.invalid/login"
            before = len(bot.requests)
            rejected = await client.post("/api/auth/login/start", json={"secret": secret})
            assert rejected.status == 400 and (await rejected.json())["error"] == "https_required"
            assert len(bot.requests) == before and not rejected.cookies
            report["httpsEntry"] = {"redirectedToConfiguredOrigin": True, "unsafePostRejectedBeforeNotification": True}
            probe = await asyncio.to_thread(probe_deployment, base + "/health", installed_version())
            assert probe["ok"] and probe["assets"]
            report["updaterWebProbe"] = {"httpsConfigured": True, "entryAssetsFetched": len(probe["assets"])}
        finally:
            try:
                if client:
                    await client.close()
                async with asyncio.timeout(15):
                    await service.shutdown()
                assert db._conn is None and server._runner is None, "Service resources survived shutdown"
                report.setdefault("serviceLifecycle", {})["cleanShutdown"] = True
            finally:
                os.chdir(old_cwd)
                environment.stop()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--dist", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--anonymous-only", action="store_true")
    args = parser.parse_args()
    report = asyncio.run(verify(args))
    text = json.dumps({"ok": True, **report}, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
