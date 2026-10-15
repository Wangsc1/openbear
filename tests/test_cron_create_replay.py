"""Create receipts must not mask a task deleted from the list."""
import asyncio

import pytest

from app.cron.contracts import CronError
from app.webhooks.repository import one
from tests.test_cron import base_env, cron_env  # noqa: F401


@pytest.mark.parametrize('physically_missing', [False, True])
async def test_create_again_after_task_removed(cron_env, physically_missing):
    e = cron_env
    body = {'folderId': 'folder', 'name': '重新创建测试', 'enabled': True,
            'requestId': 'repeat-create', 'config': {
                'instructions': 'Isolated test only.',
                'schedule': {'kind': 'every', 'everySeconds': 60},
                'notifications': {'mode': 'silent'}}}
    first = await e.cron.save(123, body)
    assert await e.cron.save(123, body) == first
    job_id = first['job']['id']
    grant = await e.cron.delete_impact(123, job_id, {'expectedRevision': 1})
    await e.cron.delete(123, job_id, {
        'requestId': 'delete-original', 'confirmationToken': grant['confirmationToken']})
    if physically_missing:
        async with e.db.write_transaction(label='test-missing-definition') as conn:
            await conn.execute('DELETE FROM cron_jobs WHERE job_id=?', (job_id,))
    assert (await e.cron.list(123, {}))['total'] == 0

    # Multiple retries of the original request create exactly one replacement.
    replacements = await asyncio.gather(*(e.cron.save(123, body) for _ in range(3)))
    replacement = replacements[0]
    assert all(r == replacement for r in replacements)
    assert replacement['job']['id'] != job_id
    assert replacement['job']['enabled']
    assert (await e.cron.list(123, {}))['total'] == 1
    assert await e.cron.get(123, replacement['job']['id']) == replacement
    assert await e.cron.save(123, body) == replacement
    receipt = await one(e.db.conn, 'SELECT result_json FROM cron_operations WHERE request_id=?', ('repeat-create',))
    assert replacement['job']['id'] in receipt['result_json']
    with pytest.raises(CronError, match='request_id_conflict'):
        await e.cron.save(123, {**body, 'name': 'different request'})
