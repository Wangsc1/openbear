#!/usr/bin/env python3
"""Probe the real systemd app.main over HTTP, Telegram callback and WebSocket."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import pathlib
import sqlite3
import zipfile
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import aiohttp

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=pathlib.Path, required=True)
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--output", type=pathlib.Path, required=True)
parser.add_argument("--version", required=True)
parser.add_argument("--archive", type=pathlib.Path, required=True)
parser.add_argument("--fixture", default="http://127.0.0.1:19580")
parser.add_argument("--session-output", type=pathlib.Path)
args = parser.parse_args()
root = args.root.resolve()
archive_path = args.archive.resolve()
base = f"http://127.0.0.1:{args.port}"
archive = zipfile.ZipFile(archive_path)


class EntryParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths: set[str] = set()
        self.manifests: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("src"):
            self.paths.add(attrs["src"])
        rels = set(str(attrs.get("rel") or "").split())
        if tag == "link" and attrs.get("href") and rels & {"stylesheet", "modulepreload", "manifest", "icon", "apple-touch-icon"}:
            self.paths.add(attrs["href"])
            if "manifest" in rels:
                self.manifests.append(attrs["href"])


async def static_bytes(session: aiohttp.ClientSession, html: bytes) -> list[dict]:
    assert html == archive.read("web/dist/index.html") == (root / "web/dist/index.html").read_bytes()
    parser = EntryParser()
    parser.feed(html.decode())
    assert parser.manifests, "entry manifest missing"
    assert any(urlparse(x).path.endswith(".js") for x in parser.paths), parser.paths
    assert any(urlparse(x).path.endswith(".css") for x in parser.paths), parser.paths
    rows: list[dict] = []
    checked: set[str] = set()

    async def check(path: str) -> bytes:
        url = urljoin(base + "/", path)
        parsed = urlparse(url)
        assert parsed.netloc == urlparse(base).netloc
        response = await session.get(url)
        assert response.status == 200, (path, response.status, await response.text())
        body = await response.read()
        rel = "web/dist/" + parsed.path.lstrip("/")
        assert body == archive.read(rel) == (root / rel).read_bytes(), path
        if parsed.path not in checked:
            checked.add(parsed.path)
            rows.append({"path": parsed.path, "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)})
        return body

    for path in sorted(parser.paths):
        body = await check(path)
        if path in parser.manifests:
            icons = json.loads(body)["icons"]
            assert icons, "manifest icons missing"
            for icon in icons:
                await check(urljoin(urljoin(base + "/", path), icon["src"]))
    return rows


async def main() -> None:
    connection = sqlite3.connect(f"file:{root}/data/openbear.db?mode=ro", uri=True)
    secret = connection.execute("SELECT value FROM app_state WHERE key='web_secret_key'").fetchone()[0]
    connection.close()
    report: dict = {
        "transport": "real-systemd-http-tg-loopback-websocket",
        "root": str(root),
        "archive": str(archive_path),
        "archiveSha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
    }
    timeout = aiohttp.ClientTimeout(total=45)
    jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=jar, timeout=timeout) as session:
        health_response = await session.get(base + "/health")
        assert health_response.status == 200
        health = await health_response.json()
        assert health == {"ok": True, "version": args.version}, health
        assert (await session.get(base + "/api/auth/session")).status == 401
        login_entry = await session.get(base + "/login")
        assert login_entry.status == 200
        html = await login_entry.read()
        assert html == (root / "web/dist/index.html").read_bytes()
        report["staticAssets"] = await static_bytes(session, html)
        report["health"] = health
        report["entrySha256"] = hashlib.sha256(html).hexdigest()

        response = await session.post(base + "/api/auth/login/start", json={"secret": secret})
        assert response.status == 200, await response.text()
        login = await response.json()
        pending = await (await session.get(base + login["statusUrl"])).json()
        assert pending["status"] == "pending", pending
        response = await session.post(args.fixture + "/approve-login", json={"requestUuid": login["requestUuid"]})
        assert response.status == 200, await response.text()
        async with asyncio.timeout(15):
            while True:
                state = await (await session.get(base + login["statusUrl"])).json()
                if state["status"] == "approved":
                    break
                await asyncio.sleep(0.1)
        response = await session.post(base + login["consumeUrl"])
        assert response.status == 200, await response.text()
        auth = await session.get(base + "/api/auth/session")
        assert auth.status == 200, await auth.text()
        auth_body = await auth.json()
        assert int(auth_body["chatId"]) == 123456789
        report["realDispatcherLoginApproval"] = True
        version_response = await session.get(base + "/api/system/version")
        assert version_response.status == 200, await version_response.text()
        version_snapshot = await version_response.json()
        expected_build = json.loads(archive.read("web/dist/build-info.json"))
        assert version_snapshot["version"] == args.version, version_snapshot
        assert version_snapshot["frontend"] == expected_build, version_snapshot
        report["frontendBuild"] = version_snapshot["frontend"]
        session_cookie = jar.filter_cookies(base).get("openbear_web_session")
        assert session_cookie and session_cookie.value
        if args.session_output:
            args.session_output.parent.mkdir(parents=True, exist_ok=True)
            args.session_output.write_text(session_cookie.value, encoding="utf-8")
            args.session_output.chmod(0o600)

        created = await session.post(base + "/api/conversations", json={"title": f"Installed v{args.version} execution acceptance"})
        assert created.status == 200, await created.text()
        conversation = (await created.json())["conversation"]["conversationUuid"]
        async with aiohttp.ClientSession() as unauth:
            try:
                ws0 = await unauth.ws_connect(base + f"/api/conversations/{conversation}/ws")
            except aiohttp.WSServerHandshakeError as exc:
                assert exc.status in {401, 403}, exc.status
            else:
                await ws0.close()
                raise AssertionError("unauthenticated websocket accepted")
        report["unauthenticatedWebsocketRejected"] = True

        ack = False
        async with session.ws_connect(base + f"/api/conversations/{conversation}/ws?bootstrap=incremental") as ws:
            await ws.send_json({"type": "send", "text": "Release acceptance: answer OK only.", "requestId": "acceptance-one"})
            async with asyncio.timeout(30):
                while not ack:
                    frame = await ws.receive_json()
                    assert frame.get("type") != "error", frame
                    if frame.get("type") == "ack" and frame.get("requestId") == "acceptance-one":
                        ack = True
            async with asyncio.timeout(30):
                while True:
                    response = await session.get(base + f"/api/conversations/{conversation}/state")
                    state = await response.json()
                    if not state["running"] and state.get("contextUsage", {}).get("known"):
                        break
                    await asyncio.sleep(0.15)

        connection = sqlite3.connect(f"file:{root}/data/openbear.db?mode=ro", uri=True)
        chat = connection.execute("SELECT internal_chat_id FROM web_conversations WHERE conversation_uuid=?", (conversation,)).fetchone()[0]
        texts = connection.execute("SELECT content FROM messages WHERE chat_id=? AND role='assistant' ORDER BY id", (chat,)).fetchall()
        requests = connection.execute("SELECT status,model,input_tokens,output_tokens FROM model_calls WHERE chat_id=? AND call_kind='controller_request' ORDER BY id", (chat,)).fetchall()
        connection.close()
        assert texts and texts[-1][0] == "OK", texts
        assert len(requests) == 1 and requests[0][0] == "ok", requests
        assert requests[0][2:] == (50, 1), requests
        assert state["contextUsage"]["tokens"] == 50, state["contextUsage"]
        report["modelUsage"] = {"inputTokens": requests[0][2], "outputTokens": requests[0][3], "totalTokens": sum(requests[0][2:])}
        report["websocketSendAck"] = ack
        report["completedModelRequests"] = len(requests)
        report["finalText"] = "OK"
        report["contextUsage"] = state["contextUsage"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


asyncio.run(main())
