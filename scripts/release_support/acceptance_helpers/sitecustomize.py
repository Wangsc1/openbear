"""Test transport only: keep app.main/Services unchanged and redirect aiogram locally."""
import os

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
