"""Acceptance transport and opt-in passive startup observers; no app file changes."""
import os
import sys

audit = os.environ.get("OB_ACCEPTANCE_STARTUP_AUDIT", "")
# Child MCP/browser Python processes inherit the environment but are not boots.
main_service = any(sys.orig_argv[i:i + 2] == ["-m", "app.main"] for i in range(len(sys.orig_argv) - 1))
if audit and main_service:
    from startup_audit import install
    install(audit)

url = os.environ.get("OB_ACCEPTANCE_TG", "")
if url:
    if not url.startswith("http://127.0.0.1:"):
        raise RuntimeError("acceptance Telegram endpoint must be loopback")
    from aiogram.client.session.aiohttp import AiohttpSession
    from aiogram.client.telegram import TelegramAPIServer

    original_init = AiohttpSession.__init__

    def local_init(self, *args, **kwargs):
        kwargs["api"] = TelegramAPIServer.from_base(url)
        original_init(self, *args, **kwargs)

    AiohttpSession.__init__ = local_init
