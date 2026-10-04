"""Terminal Cron notifications reuse TG/Push channel outboxes and stable keys."""
from app.cron.contracts import JobConfig
from app.webhooks.repository import one


async def deliver(s, row):
    from app.cron.executor import patch
    if row['notification_state'] != 'pending': return
    policy = JobConfig.model_validate_json(row['config_json']).notifications
    if policy.mode == 'silent' or policy.errors_only and row['status'] == 'completed':
        await patch(s, row['run_id'], notification_state='suppressed')
        return
    conversation = await one(s.db.conn, 'SELECT * FROM web_conversations WHERE conversation_uuid=? AND owner_chat_id=?', (row['conversation_uuid'], row['owner_chat_id']))
    if not conversation:
        await patch(s, row['run_id'], notification_state='unavailable')
        return
    root = 'cron-result:'+row['run_id']
    status = 'completed' if row['status'] == 'completed' else 'interrupted' if row['status'] in ('cancelled', 'interrupted') else 'failed'
    event = {'source': 'cron', 'conversationUuid': row['conversation_uuid'], 'runUuid': root, 'rootTurnUuid': root,
             'turnUuid': root, 'ts': row['started_at_ms']}
    text = f'定时任务「{row["job_name"]}」：{row["status"]}\n'+row['final_text']
    if row['error']: text += '\n'+row['error']
    channels = 0
    try:
        tg = getattr(s.host, 'web_task_telegram', None)
        if tg and policy.mode in ('inherit', 'telegram', 'both'):
            override = tg._direct_reply_config() if policy.mode != 'inherit' else None
            await tg.register(event, owner_chat_id=row['owner_chat_id'], internal_chat_id=conversation['internal_chat_id'],
                              title=conversation['title'], model=conversation['model'], config_override=override)
            await tg.observe({**event, 'type': 'final', 'text': text}, owner_chat_id=row['owner_chat_id'], internal_chat_id=conversation['internal_chat_id'])
            await tg.finish(root, status)
            # A terminal channel run does not imply a selected notification.
            # Include an earlier enqueue on replay, but not threshold-cancelled rows.
            if await one(s.db.conn, "SELECT 1 FROM web_tg_notification_outbox WHERE root_turn_uuid=? AND state!='cancelled' LIMIT 1", (root,)):
                channels += 1
        push = getattr(s.host, 'browser_push', None)
        if push and policy.mode in ('inherit', 'push', 'both'):
            if await push.subscriptions(row['owner_chat_id']):
                await push.enqueue(row['owner_chat_id'], row['conversation_uuid'], root, 'completed' if status == 'completed' else 'failed')
            if await one(s.db.conn, 'SELECT 1 FROM web_push_deliveries WHERE event_key=? LIMIT 1', (root,)):
                channels += 1
        await patch(s, row['run_id'], notification_state='enqueued' if channels else 'suppressed')
    except Exception:
        # Channels keep their own durable delivery state. Never re-run business.
        await patch(s, row['run_id'], notification_state='failed')
