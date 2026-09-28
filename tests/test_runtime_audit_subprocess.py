import asyncio
import sys

import pytest

from app.tools import bash


async def test_closed_stdout_does_not_bypass_command_deadline():
    proc = await asyncio.create_subprocess_exec(sys.executable, '-c',
        'import os,time; os.close(1); os.close(2); time.sleep(20)',
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
    buf = bash.SpoolingTextBuffer(inline_limit=1000)
    try:
        rc, interrupted, note, detached = await asyncio.wait_for(bash._consume_proc(
            proc, command='isolated child', timeout=.1, buf=buf), 1)
        assert interrupted and 'timeout' in note and not detached
        assert proc.returncode is not None
    finally:
        await bash._kill_and_wait(proc)
        buf.close()


async def test_progress_exception_cannot_orphan_subprocess(monkeypatch):
    monkeypatch.setattr(bash, '_PROGRESS_AFTER_S', 0)
    monkeypatch.setattr(bash, '_PROGRESS_INTERVAL_S', 0)
    proc = await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time; time.sleep(20)',
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
    buf = bash.SpoolingTextBuffer(inline_limit=1000)
    async def broken_progress(_):
        raise RuntimeError('display-write-failed')
    try:
        with pytest.raises(RuntimeError, match='display-write-failed'):
            await bash._consume_proc(proc, command='isolated child', timeout=2, buf=buf,
                                     progress_update=broken_progress)
        assert proc.returncode is not None, 'tool error cannot unregister a still-live process'
    finally:
        await bash._kill_and_wait(proc)
        buf.close()
