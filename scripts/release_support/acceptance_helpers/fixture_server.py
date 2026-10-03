#!/usr/bin/env python3
"""Acceptance-only GitHub release, Telegram Bot API and model fixture.

Runs only inside an owned container.  It serves the exact read-only release
assets mounted by the runner, and never contacts Telegram or a model upstream.
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True, help="root containing assets/<version> and state")
parser.add_argument("--versions", nargs="+", required=True, help="validated mounted release versions")
parser.add_argument("--http-port", type=int, default=19580)
parser.add_argument("--https-port", type=int, default=443)
parser.add_argument("--cert", required=True)
parser.add_argument("--key", required=True)
args = parser.parse_args()
root = pathlib.Path(args.root).resolve()
state = root / "state"
state.mkdir(parents=True, exist_ok=True)
counts: collections.Counter[str] = collections.Counter()
lock = threading.Lock()
logins: dict[str, tuple[str, str, int]] = {}
updates: dict[str, list[dict]] = collections.defaultdict(list)
next_update = 1
next_message = 1


def append_event(kind: str, payload: dict) -> None:
    record = {"time": time.time(), "kind": kind, **payload}
    with (state / "fixture-events.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def release_version() -> str:
    value = (state / "release-version").read_text(encoding="utf-8").strip()
    if value not in set(args.versions):
        raise RuntimeError(f"unapproved release version: {value!r}")
    return value


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenBearAcceptanceFixture"

    def log_message(self, *_args) -> None:
        return

    def reply(self, obj, status: int = 200) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def counted(self, key: str) -> None:
        with lock:
            counts[key] += 1

    def fields(self, raw: bytes) -> dict[str, str]:
        content_type = self.headers.get("Content-Type", "")
        if "application/json" in content_type:
            data = json.loads(raw or b"{}")
            return {str(k): json.dumps(v) if isinstance(v, (dict, list)) else str(v) for k, v in data.items()}
        return {k: v[0] for k, v in parse_qs(raw.decode("utf-8", "replace")).items()}

    def release_metadata(self, version: str) -> dict:
        base = f"http://127.0.0.1:{args.http_port}/assets/{version}"
        names = [f"openbear-{version}.zip", "SHA256SUMS", "install.sh", "release-meta.json"]
        return {
            "tag_name": "v" + version,
            "draft": False,
            "prerelease": False,
            "assets": [{"name": name, "browser_download_url": f"{base}/{name}"} for name in names],
        }

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/counts":
            with lock:
                self.reply(dict(counts))
            return
        if path == "/repos/danger-dream/openbear/releases/latest":
            version = release_version()
            self.counted("release_metadata_" + version)
            append_event("release-metadata", {"version": version, "host": self.headers.get("Host", "")})
            self.reply(self.release_metadata(version))
            return
        if path.startswith("/releases/"):
            version = path.rsplit("/", 1)[1]
            if version not in set(args.versions):
                self.reply({"error": "unsupported release"}, 404)
                return
            self.reply(self.release_metadata(version))
            return
        if path.startswith("/assets/"):
            part = pathlib.PurePosixPath(path).parts
            if len(part) != 4 or part[2] not in set(args.versions):
                self.reply({"error": "invalid asset path"}, 400)
                return
            file = root / "assets" / part[2] / part[3]
            if not file.is_file() or file.parent != (root / "assets" / part[2]):
                self.reply({"error": "asset missing"}, 404)
                return
            raw = file.read_bytes()
            self.counted(f"asset_{part[2]}_{part[3]}")
            append_event("asset", {"version": part[2], "name": part[3], "bytes": len(raw)})
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if path in {"/v1/models", "/models"}:
            self.counted("model_list")
            self.reply({"object": "list", "data": [{"id": "acceptance-model", "object": "model"}]})
            return
        self.reply({"error": "unknown local fixture path", "path": path}, 404)

    def do_POST(self) -> None:
        global next_update, next_message
        path = urlparse(self.path).path
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if path == "/approve-login":
            request = json.loads(raw)
            with lock:
                login = logins.get(str(request["requestUuid"]))
                if login is None:
                    self.reply({"error": "login callback not observed"}, 409)
                    return
                token, callback, chat_id = login
                update = {
                    "update_id": next_update,
                    "callback_query": {
                        "id": "acceptance-" + str(next_update),
                        "chat_instance": str(chat_id),
                        "data": callback,
                        "from": {"id": chat_id, "is_bot": False, "first_name": "Acceptance admin"},
                        "message": {
                            "message_id": next_message,
                            "date": int(time.time()),
                            "chat": {"id": chat_id, "type": "private"},
                            "text": "Local login approval",
                        },
                    },
                }
                next_update += 1
                updates[token].append(update)
            append_event("telegram-login-approved", {"requestUuid": request["requestUuid"]})
            self.reply({"queued": True})
            return
        if path.startswith("/bot"):
            method = path.rsplit("/", 1)[1]
            token = path.split("/")[1][3:]
            fields = self.fields(raw)
            self.counted("telegram_" + method)
            if method == "getMe":
                result = {
                    "id": int(token.split(":", 1)[0]),
                    "is_bot": True,
                    "first_name": "Acceptance",
                    "username": "local_acceptance_bot",
                }
            elif method == "getUpdates":
                time.sleep(0.3)
                offset = int(fields.get("offset", "0"))
                with lock:
                    updates[token] = [x for x in updates[token] if x["update_id"] >= offset]
                    result = list(updates[token])
            elif method in {"sendMessage", "editMessageText"}:
                chat_id = int(fields.get("chat_id", "123456789"))
                try:
                    markup = json.loads(fields.get("reply_markup", "{}"))
                except ValueError:
                    markup = {}
                for buttons in markup.get("inline_keyboard", []):
                    for button in buttons:
                        callback = str(button.get("callback_data", ""))
                        if callback.startswith("web_login:approve:"):
                            with lock:
                                logins[callback.split(":", 2)[2]] = (token, callback, chat_id)
                            append_event("telegram-login-observed", {"requestUuid": callback.split(":", 2)[2]})
                result = {
                    "message_id": next_message,
                    "date": int(time.time()),
                    "chat": {"id": chat_id, "type": "private"},
                    "text": "Local test delivery",
                }
                next_message += 1
            elif method == "getWebhookInfo":
                result = {"url": "", "has_custom_certificate": False, "pending_update_count": 0}
            else:
                result = True
            self.reply({"ok": True, "result": result})
            return
        self.counted("model_request")
        try:
            request = json.loads(raw)
        except ValueError:
            self.reply({"error": "invalid JSON"}, 400)
            return
        append_event("model-request", {"path": path, "model": request.get("model"), "stream": bool(request.get("stream"))})
        if path == "/v1/chat/completions":
            usage = {"prompt_tokens": 50, "completion_tokens": 1, "total_tokens": 51}
            payload = {
                "id": "local-acceptance",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": request.get("model", "acceptance-model"),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                "usage": usage,
            }
            if request.get("stream"):
                chunks = [
                    {"id": "local-acceptance", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "OK"}, "finish_reason": None}]},
                    {"id": "local-acceptance", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage},
                ]
                body = "".join("data: " + json.dumps(x) + "\n\n" for x in chunks) + "data: [DONE]\n\n"
                encoded = body.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            else:
                self.reply(payload)
            return
        self.reply({"error": "unknown model path", "path": path}, 404)


httpd = ThreadingHTTPServer(("127.0.0.1", args.http_port), Handler)
httpsd = ThreadingHTTPServer(("127.0.0.1", args.https_port), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(args.cert, args.key)
httpsd.socket = context.wrap_socket(httpsd.socket, server_side=True)
threading.Thread(target=httpsd.serve_forever, name="fixture-https", daemon=True).start()
append_event("fixture-start", {"httpPort": args.http_port, "httpsPort": args.https_port})
httpd.serve_forever()
