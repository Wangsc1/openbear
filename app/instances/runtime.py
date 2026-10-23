"""Precise Web-turn capability hooks; origin labels never grant authority."""
from __future__ import annotations

import asyncio
import contextlib

from app.webhooks.repository import one


def bind_context(service, ctx, binding):
    started, terminal = ctx.execution_started, ctx.terminal_policy

    async def execution_started(session):
        value = await started(session) if started else None
        await service.bind_run(binding, session.run_id)
        return value

    async def terminal_policy(reason):
        try:
            if terminal:
                await terminal(reason)
        finally:
            await service.finish(binding['id'], binding['revision'], binding['root'], reason)

    ctx.execution_started, ctx.terminal_policy = execution_started, terminal_policy


def card(service, op, row, instructions):
    """What the conversation shows instead of the model-facing instruction."""
    item = service.public(row)
    return {'operationId': op['id'], 'instanceId': row['id'], 'kind': op['kind'], 'name': item['name'],
            'server': item.get('serverName', ''), 'workspacePath': item['workspacePath'], 'port': item['port'],
            'instructions': instructions, 'startedAtMs': op['created_ms']}


async def execute(service, op_id, conversation, root, instructions):
    from app.web_console.live_stream import _WebStreamRenderer

    host = service.host
    live = host._live_for(conversation)
    op = await one(service.db.conn, 'SELECT * FROM instance_operations WHERE id=?', (op_id,))
    row = await service.row(op['owner'], op['instance_id'])
    from app.instances.security import Scrubber, secret_values
    scrub = Scrubber(secret_values(service.vault.open(row['protected'])))
    text = (('请把这个实例实际部署好：交付文件、按需构建镜像、启动容器，再核验并通过 InstanceControl 报告结果，不要只给方案。'
             if op['kind'] == 'deployment' else '请只按下面写明的维护范围操作，不要扩大为重新部署。')
            + '\n实例档案已通过本回合 reference 提供。先用 InstanceControl status 取得修订号和目标（运行位置、端口、数据目录、镜像、实例地址）。'
            + '\ndeliver 会把 compose.json（含凭证）和同版本源码放到目标上；remote 在目标上执行命令（本机直接执行，其他服务器经 SSH）。'
            + '\n这些操作不会逐条请用户确认，用户也无法判断命令是否安全，所以由你自己把关：只执行这次部署或维护确实需要的命令；'
            + '不删除、不覆盖已有数据目录、卷和其他容器，不改动无关的服务、防火墙、SSH 与系统配置。'
            + '\n不要打印 compose.json 或把凭证写进命令参数。登录账号由访问网关管理，已自动同步。'
            + '\n' + scrub(instructions))
    success = False
    try:
        await live.publish({'type': 'accepted', 'turnUuid': root, 'runUuid': root, 'source': op['kind'], 'operationId': op_id})
        await live.publish({'type': 'user', 'turnUuid': root, 'messageUuid': op_id, 'text': text, 'source': 'instance',
                            'instanceCard': card(service, op, row, scrub(instructions))})
        renderer = _WebStreamRenderer(live=live, artifact_rewriter=host._web_assistant_artifact_rewriter(conversation, turn_uuid=root))
        success = await host._run_web_turn(conversation['internal_chat_id'], text, renderer, conversation=conversation,
                                           root_turn_uuid=root, user_op_id='instance:'+op_id, reference_bundle_id=op['bundle'])
    except asyncio.CancelledError:
        pass
    except Exception:
        await host._touch_web_conversation(conversation['conversation_uuid'], status='error', current_status='实例操作中断', last_error='instance_execution_failed')
    finally:
        # Covers exceptions before Agent.run reaches its terminal policy.
        current = await one(service.db.conn, 'SELECT * FROM instance_operations WHERE id=?', (op_id,))
        if current:
            with contextlib.suppress(Exception):
                await asyncio.shield(service.finish(op_id, current['revision'], root, 'completed' if success else 'interrupted'))
