"""Reuse the existing durable Telegram outbox with stable per-event identity."""
from app.webhooks.repository import one


async def deliver(service, row):
    tg = getattr(service.host, 'web_task_telegram', None)
    if not tg:
        return 'suppressed'
    instance = await service.row(row['owner'], row['instance_id'], active=False)
    if instance['status'] == 'archived':
        return 'suppressed'
    conversation = await one(service.db.conn, 'SELECT * FROM web_conversations WHERE conversation_uuid=? AND owner_chat_id=?', (row['conversation_uuid'], row['owner']))
    root = 'instance-notification:'+row['id']
    event = {'source': 'instance', 'conversationUuid': row['conversation_uuid'], 'runUuid': root, 'rootTurnUuid': root, 'turnUuid': root}
    chat = conversation['internal_chat_id'] if conversation else row['owner']
    await tg.register(event, owner_chat_id=row['owner'], internal_chat_id=chat,
                      title='实例管理', model='', config_override=tg._direct_reply_config())
    await tg.observe({**event, 'type': 'final', 'text': row['text']}, owner_chat_id=row['owner'], internal_chat_id=chat)
    await tg.finish(root, 'completed')
    # register/observe/finish and the TG outbox already use this stable root as
    # their idempotency key; a crash here cannot create a second notification.
    return 'enqueued'
