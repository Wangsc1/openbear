"""Real private subprocesses: a departed leader must not strand pipe cleanup."""
from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
import signal
import sys
import time
from types import SimpleNamespace

import pytest

from app.webhooks import scripts
from app.webhooks.contracts import Environments, Script
from app.webhooks.repository import one
from app.webhooks.worker import Worker
from tests.test_webhooks_backend import accept, create
from tests.test_webhooks_backend import env as env
from tests.test_web_admin import _login_cookie


def _alive(pid):
    try:
        # Orphaned children may briefly remain as zombies until PID 1 reaps them.
        return Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1][0] != "Z"
    except FileNotFoundError:
        return False


async def _until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(.01)


@pytest.mark.parametrize("mode", ["timeout", "cancel", "worker_close", "repeated_cancel"])
async def test_exited_leader_pipe_cleanup(tmp_path, monkeypatch, mode):
    escaped = mode == "repeated_cancel"
    if escaped:
        monkeypatch.setattr(scripts, "_PROCESS_CLEANUP_TIMEOUT_S", .15)
    pidfile = tmp_path / "child.pid"
    processes = []
    original_spawn = asyncio.create_subprocess_exec

    async def spawn(*args, **kwargs):
        proc = await original_spawn(*args, **kwargs)
        processes.append(proc)
        return proc

    monkeypatch.setattr(scripts.asyncio, "create_subprocess_exec", spawn)
    cleanup_started = asyncio.Event()
    original_cleanup = scripts._cleanup_process

    async def cleanup(*args, **kwargs):
        cleanup_started.set()
        return await original_cleanup(*args, **kwargs)

    monkeypatch.setattr(scripts, "_cleanup_process", cleanup)
    code = f'''import subprocess, sys
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session={escaped!r})
Path({str(pidfile)!r}).write_text(str(child.pid))
print('{{"decision":"continue"}}', flush=True)
'''
    task = asyncio.create_task(scripts.execute(
        Script(enabled=True, code=code, timeout_seconds=.3 if mode == "timeout" else 60),
        Environments(default_cwd=str(tmp_path)), {"phase": "pre"},
    ))
    close_task = None
    child_pid = None
    try:
        await _until(lambda: processes and processes[0].returncode == 0 and pidfile.exists())
        child_pid = int(pidfile.read_text())
        assert _alive(child_pid)
        started = time.monotonic()
        if mode == "worker_close":
            worker = Worker(SimpleNamespace(wake=asyncio.Event()))
            worker.tasks["own-test-job"] = task
            close_task = asyncio.create_task(worker.close())
        elif mode != "timeout":
            task.cancel()
            if mode == "repeated_cancel":
                await cleanup_started.wait()
                task.cancel()
        observed = close_task or task
        done, _ = await asyncio.wait({observed}, timeout=3)
        assert observed in done, "script/worker cleanup waited indefinitely for descendant EOF"
        assert time.monotonic() - started < 3
        if mode == "timeout":
            result = task.result()
            assert result["errorClass"] == "timeout"
            assert result["exitCode"] == 0
            assert result["effectState"] == "unknown"
        else:
            assert task.cancelled()
            if close_task:
                close_task.result()
                assert not worker.tasks
        assert processes[0]._transport.is_closing()
        if not escaped:
            await _until(lambda: not _alive(child_pid))
        else:
            # An escaped session is not ours to kill by group. Our local pipes
            # must still close and cancellation must return within its budget.
            assert _alive(child_pid)
    finally:
        if child_pid is None and pidfile.exists():
            child_pid = int(pidfile.read_text())
        for pid in [p.pid for p in processes] + ([child_pid] if escaped and child_pid else []):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(pid, signal.SIGKILL)
        if child_pid:
            with contextlib.suppress(ProcessLookupError):
                os.kill(child_pid, signal.SIGKILL)
        for pending in [task, *([close_task] if close_task else [])]:
            if not pending.done():
                pending.cancel()
        await asyncio.gather(task, *([close_task] if close_task else []), return_exceptions=True)


async def test_escaped_descendant_has_bounded_default_cleanup(tmp_path):
    pidfile = tmp_path / "escaped.pid"
    code = f'''import subprocess, sys
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
Path({str(pidfile)!r}).write_text(str(child.pid))
print('{{"decision":"continue"}}', flush=True)
'''
    started = time.monotonic()
    task = asyncio.create_task(scripts.execute(
        Script(enabled=True, code=code, timeout_seconds=.25),
        Environments(default_cwd=str(tmp_path)), {"phase": "pre"},
    ))
    try:
        done, _ = await asyncio.wait({task}, timeout=4)
        assert task in done, "default cleanup budget did not bound pipe EOF wait"
        result = task.result()
        assert result["errorClass"] == "timeout"
        assert result["effectState"] == "unknown"
        assert time.monotonic() - started < 4
    finally:
        if pidfile.exists():
            with contextlib.suppress(ProcessLookupError):
                os.killpg(int(pidfile.read_text()), signal.SIGKILL)
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("code,error,effect", [
    ('print(\'{"decision":"continue"}\')', None, "reported"),
    ('import sys; print("failure", file=sys.stderr); sys.exit(3)', "nonzero_exit", "unknown"),
    ('print("not json")', "invalid_protocol", "unknown"),
])
async def test_normal_script_result_preserved(tmp_path, code, error, effect):
    result = await scripts.execute(
        Script(enabled=True, code=code), Environments(default_cwd=str(tmp_path)), {"phase": "pre"},
    )
    assert result["errorClass"] == error
    assert result["effectState"] == effect
    if error is None:
        assert result["result"] == {"decision": "continue"}
    elif error == "nonzero_exit":
        assert result["exitCode"] == 3
        assert result["stderr"] == "failure\n"


def _assert_reaped(proc):
    assert proc.returncode is not None
    with pytest.raises(ProcessLookupError):
        os.kill(proc.pid, 0)
    assert proc._transport.is_closing()
    for fd in (0, 1, 2):
        pipe = proc._transport.get_pipe_transport(fd)
        assert pipe is None or pipe.is_closing()


async def _reap_test_processes(processes):
    # Failure cleanup only: all processes here were spawned as private sessions.
    for proc in processes:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        proc._transport.close()
        await asyncio.wait_for(proc.wait(), 2)


@pytest.mark.parametrize("mode", ["cancel", "repeated_cancel", "error", "success"])
async def test_worker_spawn_guard_exit_reaps_process(env, monkeypatch, mode):
    """DL-01: real Worker/SQLite commit after spawn, before reader creation."""
    processes = []
    original_spawn = asyncio.create_subprocess_exec
    original_commit = env.db.conn._writer.commit
    original_cleanup = scripts._cleanup_process
    cleanup_started, release_cleanup = asyncio.Event(), asyncio.Event()
    injected = False

    async def spawn(*args, **kwargs):
        proc = await original_spawn(*args, **kwargs)
        processes.append(proc)
        return proc

    async def commit():
        nonlocal injected
        if processes and not injected:
            injected = True
            assert env.db.conn._owner is asyncio.current_task()
            assert asyncio.current_task().get_name().startswith('webhook-pre:')
            if mode == 'error':
                raise RuntimeError('guard commit failed after spawn')
            if mode in ('cancel', 'repeated_cancel'):
                asyncio.current_task().cancel()
        await original_commit()

    async def cleanup(*args, **kwargs):
        cleanup_started.set()
        if mode == 'repeated_cancel':
            await release_cleanup.wait()
        return await original_cleanup(*args, **kwargs)

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    monkeypatch.setattr(env.db.conn._writer, 'commit', commit)
    monkeypatch.setattr(scripts, '_cleanup_process', cleanup)
    code = 'print(\'{"decision":"skip_model","outcome":"handled"}\')' if mode == 'success' else 'import time; time.sleep(60)'
    c = await create(env, pre={'enabled': True, 'code': code})
    await accept(env, c)
    tasks = []
    try:
        await env.worker.tick()
        tasks = list(env.worker.tasks.values())
        assert len(tasks) == 1
        if mode == 'repeated_cancel':
            await asyncio.wait_for(cleanup_started.wait(), 3)
            tasks[0].cancel()
            await asyncio.sleep(0)
            assert not tasks[0].done()
            release_cleanup.set()
        done, pending = await asyncio.wait(tasks, timeout=4)
        assert not pending, 'worker did not complete resource cleanup'
        if mode in ('cancel', 'repeated_cancel'):
            assert tasks[0].cancelled()
        else:
            assert tasks[0].exception() is None
        await env.worker.close()
        assert injected and len(processes) == 1
        _assert_reaped(processes[0])
        assert not env.worker.tasks
        assert env.db.conn._owner is None and not env.db.conn.in_transaction
        attempt = await one(env.db.conn, 'SELECT state,error_class FROM webhook_stage_attempts')
        expected = ('succeeded', None) if mode == 'success' else ('failed', 'environment_error') if mode == 'error' else ('unknown', 'cancelled')
        assert (attempt['state'], attempt['error_class']) == expected
    finally:
        release_cleanup.set()
        await _reap_test_processes(processes)
        for task in tasks:
            if not task.done(): task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize('entry', ['script', 'environment'])
async def test_cancel_during_spawn_retains_handle_until_reaped(tmp_path, monkeypatch, entry):
    processes = []
    original_spawn = asyncio.create_subprocess_exec
    spawned, release_spawn = asyncio.Event(), asyncio.Event()

    async def spawn(*args, **kwargs):
        proc = await original_spawn(*args, **kwargs)
        processes.append(proc)
        spawned.set()
        await release_spawn.wait()
        return proc

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    wrapper = tmp_path / 'slow-version'
    wrapper.write_text('#!' + sys.executable + '\nimport time\ntime.sleep(60)\n')
    wrapper.chmod(0o700)
    system = Environments(python_path=str(wrapper), node_path=str(tmp_path / 'absent'), default_cwd=str(tmp_path))
    operation = scripts.environment(system) if entry == 'environment' else scripts.execute(
        Script(enabled=True, code='import time; time.sleep(60)'), system, {'phase': 'pre'})
    task = asyncio.create_task(operation)
    try:
        await asyncio.wait_for(spawned.wait(), 3)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done(), 'caller abandoned a still-owned spawn'
        release_spawn.set()
        done, _ = await asyncio.wait({task}, timeout=3)
        assert task in done and task.cancelled()
        assert len(processes) == 1
        _assert_reaped(processes[0])
    finally:
        release_spawn.set()
        await _reap_test_processes(processes)
        if not task.done(): task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_environment_versions_keep_configuration_and_output(tmp_path, monkeypatch):
    processes = []
    original_spawn = asyncio.create_subprocess_exec

    async def spawn(*args, **kwargs):
        proc = await original_spawn(*args, **kwargs)
        processes.append(proc)
        return proc

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    wrapper = tmp_path / 'node-version'
    wrapper.write_text('#!' + sys.executable + '\nimport sys\nprint("node-fixture-" + "v" * 300, file=sys.stderr)\n')
    wrapper.chmod(0o700)
    try:
        rows = await scripts.environment(Environments(python_path=sys.executable, node_path=str(wrapper)))
        assert rows[0]['runtime'] == 'python' and rows[0]['path'] == sys.executable
        assert rows[0]['available'] and rows[0]['version'].startswith('Python ')
        assert rows[1] == {'runtime': 'node', 'path': str(wrapper), 'available': True,
                           'version': ('node-fixture-' + 'v' * 300)[:256]}
        assert len(processes) == 2
        for proc in processes: _assert_reaped(proc)
    finally:
        await _reap_test_processes(processes)


@pytest.mark.parametrize('mode', ['timeout', 'timeout_exited_leader', 'cancel', 'repeated_cancel', 'escaped_child'])
async def test_environment_version_pipe_cleanup_is_bounded(tmp_path, monkeypatch, mode):
    """DL-02: never unblock the pipe to make environment() meet its budget."""
    escaped = mode == 'escaped_child'
    pidfile = tmp_path / 'version-child.pid'
    wrapper = tmp_path / 'version-wrapper'
    wrapper.write_text('#!' + sys.executable + '\n' + f'''import subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session={escaped!r})
Path({str(pidfile)!r}).write_text(str(child.pid))
''' + ('' if mode == 'timeout_exited_leader' else 'time.sleep(60)\n'))
    wrapper.chmod(0o700)
    processes, signalled_groups = [], []
    original_spawn = asyncio.create_subprocess_exec
    original_killpg = os.killpg
    original_cleanup = scripts._cleanup_process
    cleanup_started, release_cleanup = asyncio.Event(), asyncio.Event()

    async def spawn(*args, **kwargs):
        assert kwargs.get('start_new_session') is True
        proc = await original_spawn(*args, **kwargs)
        processes.append(proc)
        return proc

    def killpg(pgid, sig):
        assert pgid in {proc.pid for proc in processes}, 'must not signal an unrelated process group'
        signalled_groups.append(pgid)
        return original_killpg(pgid, sig)

    async def cleanup(*args, **kwargs):
        cleanup_started.set()
        if mode == 'repeated_cancel':
            await release_cleanup.wait()
        return await original_cleanup(*args, **kwargs)

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    monkeypatch.setattr(os, 'killpg', killpg)
    monkeypatch.setattr(scripts, '_cleanup_process', cleanup)
    system = Environments(python_path=str(wrapper), node_path=str(tmp_path / 'missing-node'))
    task = asyncio.create_task(scripts.environment(system))
    child_pid = None
    try:
        await _until(lambda: pidfile.exists() and bool(processes))
        child_pid = int(pidfile.read_text())
        assert _alive(child_pid)
        if not mode.startswith('timeout'):
            task.cancel()
            if mode == 'repeated_cancel':
                await asyncio.wait_for(cleanup_started.wait(), 3)
                task.cancel()
                await asyncio.sleep(0)
                assert not task.done()
                release_cleanup.set()
        # Production budgets: five-second version deadline + two-second cleanup.
        done, _ = await asyncio.wait({task}, timeout=8)
        assert task in done, 'environment probe waited for descendant EOF beyond cleanup budget'
        if mode.startswith('timeout'):
            assert task.result() == [
                {'runtime': 'python', 'available': False, 'path': str(wrapper), 'version': None},
                {'runtime': 'node', 'available': False, 'path': system.node_path, 'version': None},
            ]
        else:
            assert task.cancelled()
        assert len(processes) == 1 and signalled_groups == [processes[0].pid]
        _assert_reaped(processes[0])
        if escaped:
            # Not our process group: close our pipes without killing that session.
            assert _alive(child_pid)
        else:
            await _until(lambda: not _alive(child_pid))
    finally:
        release_cleanup.set()
        if child_pid is None and pidfile.exists(): child_pid = int(pidfile.read_text())
        if child_pid:
            with contextlib.suppress(ProcessLookupError): os.kill(child_pid, signal.SIGKILL)
        await _reap_test_processes(processes)
        if not task.done(): task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_environment_http_timeout_reaps_and_returns_next_runtime(env, monkeypatch):
    cookie = await _login_cookie(env)
    pidfile = env.tmp / 'http-version-child.pid'
    wrapper = env.tmp / 'http-version-wrapper'
    wrapper.write_text('#!' + sys.executable + '\n' + f'''import subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
Path({str(pidfile)!r}).write_text(str(child.pid))
time.sleep(60)
''')
    wrapper.chmod(0o700)
    env.s.config.scripts.python_path = str(wrapper)
    env.s.config.scripts.node_path = sys.executable
    processes = []
    original_spawn = asyncio.create_subprocess_exec

    async def spawn(*args, **kwargs):
        proc = await original_spawn(*args, **kwargs)
        processes.append(proc)
        return proc

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    task = asyncio.create_task(env.client.get('/api/webhooks/environment', cookies={'openbear_web_session': cookie}))
    try:
        done, _ = await asyncio.wait({task}, timeout=8)
        assert task in done, 'authenticated environment API did not return after timeout cleanup'
        response = task.result()
        assert response.status == 200
        payload = await response.json()
        assert payload['runtimes'][0] == {'runtime': 'python', 'available': False, 'path': str(wrapper), 'version': None}
        assert payload['runtimes'][1]['available'] and payload['runtimes'][1]['version'].startswith('Python ')
        assert payload['defaultCwd'] == str(env.tmp)
        assert len(processes) == 2
        for proc in processes: _assert_reaped(proc)
        await _until(lambda: not _alive(int(pidfile.read_text())))
        assert env.db.conn._owner is None
    finally:
        if pidfile.exists():
            with contextlib.suppress(ProcessLookupError): os.kill(int(pidfile.read_text()), signal.SIGKILL)
        await _reap_test_processes(processes)
        if not task.done(): task.cancel()
        await asyncio.gather(task, return_exceptions=True)
