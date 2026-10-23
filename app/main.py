"""入口 —— 建 Bot/Dispatcher、注册中间件与路由、polling/webhook 启动。"""
from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import sys
from pathlib import Path

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiohttp import web

from app.bot import admin, interactions, task_replies
from app.bot.menu import setup_menu
from app.bot.whitelist import WhitelistMiddleware
from app.config import get_config
from app.logging import get_logger, setup_logging
from app.restart_notify import send_pending_restart_completion_notices
from app.services import Services
from app.systemd_notify import CONFIG_ERROR_EXIT, SystemdNotify

log = get_logger("main")


def build_dispatcher(svc: Services) -> Dispatcher:
    dp = Dispatcher()
    dp["svc"] = svc
    wl = WhitelistMiddleware(svc.config.telegram.whitelist_ids)
    dp.message.middleware(wl)
    dp.callback_query.middleware(wl)
    # Exact registered replies precede the admin settings text handler.
    # Neither route accepts ordinary Telegram chat messages as Agent input.
    dp.include_router(interactions.router)
    dp.include_router(task_replies.router)
    dp.include_router(admin.router)
    return dp


async def _drain_startup_backlog(bot: Bot, svc: Services) -> None:
    """Persist only exact task-notification replies before advancing the offset.

    Ordinary text, commands, media and interaction callbacks are not replayed as
    Agent input. Task reply buttons only open prompts; the reply inbox deduplicates
    Telegram redelivery across restart.
    A lookup/storage failure aborts draining instead of acknowledging lost work.
    """
    offset: int | None = None
    drained = 0
    while True:
        updates = await bot.get_updates(offset=offset, timeout=0, limit=100, allowed_updates=["message", "callback_query"])
        if not updates:
            break
        bridge = task_replies.transport(svc)
        for update in updates:
            message = getattr(update, "message", None)
            if message is not None and bridge is not None:
                record = await bridge.match_reply(message)
                if record is not None:
                    await bridge.handle_reply(message, record)
            query = getattr(update, "callback_query", None)
            if query is not None and bridge is not None and getattr(query, "data", None) == task_replies.REPLY_CALLBACK:
                await bridge.handle_callback(query)
        drained += len(updates)
        offset = max(int(upd.update_id) for upd in updates) + 1
    if drained:
        log.info("已消费 Telegram 启动积压消息，仅登记匹配的会话回复", 数量=drained)


async def _telegram_startup_notices(bot: Bot, svc: Services) -> None:
    await setup_menu(bot)
    try:
        await send_pending_restart_completion_notices(bot, svc)
    except Exception:
        log.exception("重启完成通知暂未送达")


async def run() -> None:
    try:
        config = get_config()
    except (ValueError, FileNotFoundError, PermissionError) as exc:
        # Validation errors can contain submitted credentials.
        print(f"OpenBear configuration invalid or unreadable ({type(exc).__name__})", file=sys.stderr)
        raise SystemExit(CONFIG_ERROR_EXIT) from None
    except Exception:
        if os.environ.get("OPENBEAR_INSTANCE_ROLE") == "managed":
            # Pydantic errors may reproduce submitted provider/account inputs.
            print("managed startup configuration invalid or missing", file=sys.stderr)
            raise SystemExit(1) from None
        raise
    setup_logging(config.log_level)
    errors = config.validate_for_startup()
    if errors:
        for e in errors:
            log.error("启动配置校验失败", 原因=e)
        sys.exit(CONFIG_ERROR_EXIT)

    notifier = SystemdNotify.from_environment()
    if config.managed.enabled:
        root = Path(config.managed.workspace_root)
        root.mkdir(parents=True, exist_ok=True)
        os.chdir(root)
        os.umask(0o077)
        log.info("OpenBear 启动中", 模式="managed", 主力模型=config.models.primary)
        svc = Services(config, None)
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        try:
            await svc.startup()
            await notifier.ready()
            await stop.wait()
        finally:
            await notifier.stopping()
            try:
                await svc.shutdown()
            finally:
                for sig in (signal.SIGTERM, signal.SIGINT):
                    loop.remove_signal_handler(sig)
        return

    log.info("OpenBear 启动中", 模式=config.telegram.mode, 主力模型=config.models.primary)
    bot = Bot(config.telegram.bot_token, default=DefaultBotProperties(parse_mode=None))
    svc = None
    runner = None
    notices = None
    try:
        svc = Services(config, bot)
        await svc.startup()
        dp = build_dispatcher(svc)
        notices = asyncio.create_task(_telegram_startup_notices(bot, svc), name="telegram-startup-notices")
        if config.telegram.mode == "webhook":
            from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application
            host = config.telegram.webhook_host.rstrip("/")
            secret = config.telegram.webhook_secret
            url = f"{host}/tg/{secret}"
            await bot.set_webhook(url, secret_token=secret, drop_pending_updates=False)
            app = web.Application()
            SimpleRequestHandler(dispatcher=dp, bot=bot,
                                 secret_token=secret).register(app, path=f"/tg/{secret}")
            setup_application(app, dp, bot=bot)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, host="0.0.0.0", port=config.telegram.webhook_port)
            await site.start()
            log.info("Webhook 已启动", 端口=config.telegram.webhook_port)
            await notifier.ready()
            await asyncio.Event().wait()
        else:
            await bot.delete_webhook(drop_pending_updates=False)
            await _drain_startup_backlog(bot, svc)
            log.info("Polling 模式启动")
            dp.startup.register(notifier.ready)
            dp.shutdown.register(notifier.stopping)
            await dp.start_polling(bot, handle_as_tasks=True)
    finally:
        await notifier.stopping()
        if notices is not None:
            notices.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await notices
        try:
            if runner is not None:
                await runner.cleanup()
        finally:
            try:
                if svc is not None:
                    await svc.shutdown()
            finally:
                await bot.session.close()
                log.info("OpenBear 已退出")


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
