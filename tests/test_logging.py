"""Logging isolation: real loggers/fake models, only local disposable sinks."""
from __future__ import annotations

import asyncio
import faulthandler
import io
import json
import logging
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import time

import pytest

import app.logging as logmod


@pytest.fixture
def log_env(monkeypatch):
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    noisy = {name: logging.getLogger(name).level for name in (
        'httpx', 'httpcore', 'aiosqlite', 'asyncio', 'aiogram.event',
    )}
    writer = logmod.BackgroundLogWriter('test-log-stdout', capacity=8)
    output = io.StringIO()
    monkeypatch.setattr(logmod, '_stdout_writer', writer)
    monkeypatch.setattr(sys, 'stdout', output)
    logmod.setup_logging()
    try:
        yield output, writer
    finally:
        writer.close(1)
        for handler in root.handlers[:]:
            if isinstance(handler, logmod._QueuedStreamHandler):
                handler.close()
        root.handlers[:] = handlers
        root.setLevel(level)
        for name, old_level in noisy.items():
            logging.getLogger(name).setLevel(old_level)


def test_format_levels_exception_and_stdlib_interpolation(log_env, monkeypatch):
    output, writer = log_env
    log = logmod.get_logger('fixture')
    log.info('中文事件', 轮次=1, value='ok')
    logging.getLogger('fixture').debug('filtered-debug')
    logging.getLogger('fixture').warning('stdlib %s', 'argument')
    try:
        raise ValueError('exception detail')
    except ValueError:
        log.exception('失败', step=2)
    assert writer.flush(1)
    text = output.getvalue()
    assert re.search(r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \| INFO  \| \[fixture\] \| 中文事件 \| 轮次=1 \| value=ok\n', text)
    assert 'filtered-debug' not in text
    assert 'stdlib argument' in text
    assert '[fixture] | 失败 | step=2\nTraceback (most recent call last):' in text
    assert 'ValueError: exception detail' in text
    for name in ('httpx', 'httpcore', 'aiosqlite', 'asyncio', 'aiogram.event'):
        assert logging.getLogger(name).level == logging.WARNING
    # pytest changes its capture stream between fixture setup and test call.
    monkeypatch.setattr(sys, 'stdout', output)
    logmod.setup_logging('DEBUG')
    logging.getLogger('fixture').debug('visible-debug')
    assert writer.flush(1)
    assert 'visible-debug' in output.getvalue()
    logmod.setup_logging('invalid')
    assert logging.getLogger().level == logging.INFO


def test_fd_sink_preserves_utf8_and_exception_content(log_env, tmp_path, monkeypatch):
    _, writer = log_env
    path = tmp_path / 'stdout.txt'
    with path.open('w', encoding='utf-8') as stream:
        monkeypatch.setattr(sys, 'stdout', stream)
        logmod.setup_logging()
        try:
            raise RuntimeError('真实FD异常')
        except RuntimeError:
            logmod.get_logger('fd-fixture').exception('中文输出', 内容='完整')
        assert writer.flush(1)
        text = path.read_text()
        assert '[fd-fixture] | 中文输出 | 内容=完整\nTraceback' in text
        assert 'RuntimeError: 真实FD异常' in text


def test_setup_never_exposes_synchronous_last_resort(log_env, monkeypatch):
    output, writer = log_env
    root = logging.getLogger()
    remove = root.removeHandler
    def observed_remove(handler):
        remove(handler)
        assert root.handlers
        logmod.get_logger('fixture').warning('concurrent-setup-warning')
    monkeypatch.setattr(root, 'removeHandler', observed_remove)
    monkeypatch.setattr(sys, 'stdout', output)
    logmod.setup_logging()
    assert writer.flush(1)
    assert 'concurrent-setup-warning' in output.getvalue()


def test_formatting_is_off_thread_and_failure_never_writes_stderr(log_env, monkeypatch):
    output, writer = log_env
    seen_threads = []
    class Value:
        def __str__(self):
            seen_threads.append(threading.current_thread())
            return 'background-value'
    class BadValue:
        def __str__(self):
            raise ValueError('bad format')
    class ForbiddenStderr:
        def write(self, value):
            raise AssertionError('logging must not use stderr')
    monkeypatch.setattr(sys, 'stderr', ForbiddenStderr())
    logmod.get_logger('fixture').info('value', data=Value())
    logmod.get_logger('fixture').warning('bad', data=BadValue())
    assert writer.flush(1)
    assert seen_threads == [writer._thread]
    assert 'background-value' in output.getvalue()
    assert writer.failed == 1


def test_reentrant_formatter_does_not_feed_an_infinite_queue(log_env):
    output, writer = log_env
    class Reentrant:
        def __str__(self):
            logmod.get_logger('fixture').warning('recursive sink log')
            return 'outer-value'
    logmod.get_logger('fixture').info('outer', value=Reentrant())
    assert writer.flush(1)
    assert 'outer-value' in output.getvalue()
    assert 'recursive sink log' not in output.getvalue()
    assert writer.dropped == 1


def test_queue_full_failure_and_close_never_wait_for_sink():
    writer = logmod.BackgroundLogWriter('test-full', capacity=2)
    entered, release = threading.Event(), threading.Event()
    output = []
    def blocked():
        entered.set()
        release.wait(5)
    try:
        assert writer.submit(blocked)
        assert entered.wait(1)
        assert writer.submit(output.append, 1)
        assert writer.submit(output.append, 2)
        start = time.monotonic()
        assert not writer.submit(output.append, 3)
        assert not writer.flush(.1)  # Even the flush marker cannot fit.
        writer.close(.02)
        assert time.monotonic() - start < .3
        assert writer.dropped >= 2
        assert not writer.submit(output.append, 4)
    finally:
        release.set()
        writer.close(1)
    assert output == [1, 2]
    assert not writer._thread.is_alive()


def test_writer_survives_baseexception_without_thread_excepthook(monkeypatch):
    writer = logmod.BackgroundLogWriter('test-errors')
    errors = []
    monkeypatch.setattr(threading, 'excepthook', errors.append)
    def fail():
        raise SystemExit('bad sink')
    try:
        assert writer.submit(fail)
        assert writer.flush(1)
        assert writer.failed == 1 and not errors
    finally:
        writer.close(1)


@pytest.fixture
def debug_env(tmp_path, monkeypatch):
    from app.web_console import core
    writer = logmod.BackgroundLogWriter('test-log-debug', capacity=8)
    monkeypatch.setattr(core, '_WEB_DEBUG_LOG_WRITER', writer)
    monkeypatch.setattr(core, '_WEB_FRONTEND_EVENT_LOG_DIR', tmp_path / 'frontend')
    monkeypatch.setattr(core, '_WEB_WS_AUDIT_LOG_DIR', tmp_path / 'ws')
    try:
        yield core, writer
    finally:
        writer.close(1)


def test_debug_default_off_does_not_start_worker(debug_env, monkeypatch):
    core, writer = debug_env
    monkeypatch.setattr(core, '_WEB_DEBUG_FILE_LOGS_ENABLED', False)
    core._log_web_frontend_event({'value': 'ignored'})
    core._log_web_ws_audit({'value': 'ignored'})
    assert writer._thread is None


def test_debug_jsonl_redaction_paths_timestamp_and_failure(debug_env, tmp_path, monkeypatch):
    core, writer = debug_env
    monkeypatch.setattr(core, '_WEB_DEBUG_FILE_LOGS_ENABLED', True)
    main_thread = threading.current_thread()
    redact = core.redact_interaction_log
    def check_thread(record):
        assert threading.current_thread() is not main_thread
        return redact(record)
    monkeypatch.setattr(core, 'redact_interaction_log', check_thread)
    record = {
        'conversationUuid': 'fixture/one',
        'payload': {'interactionId':'a', 'sensitive':True, 'body':'SECRET-FIXTURE'},
    }
    record['frameText'] = json.dumps(record['payload'])
    start_ms = int(time.time() * 1000)
    core._log_web_frontend_event(record)
    core._log_web_ws_audit(record)
    assert writer.flush(1)
    files = list(tmp_path.rglob('*.jsonl'))
    assert len(files) == 3
    rows = [json.loads(path.read_text()) for path in files]
    assert all(start_ms <= row['tsMs'] <= int(time.time() * 1000) for row in rows)
    assert all(row['pid'] == os.getpid() for row in rows)
    assert all(row['conversationUuid'] == 'fixture/one' for row in rows)
    assert all('SECRET-FIXTURE' not in path.read_text() for path in files)
    assert record['payload']['body'] == 'SECRET-FIXTURE'
    assert len(list((tmp_path / 'ws' / 'by-conversation' / 'fixture_one').glob('*.jsonl'))) == 1
    bad_dir = tmp_path / 'not-directory'
    bad_dir.write_text('fixture')
    monkeypatch.setattr(core, '_WEB_FRONTEND_EVENT_LOG_DIR', bad_dir)
    monkeypatch.setattr(core, '_WEB_WS_AUDIT_LOG_DIR', bad_dir)
    core._log_web_frontend_event(record)
    core._log_web_ws_audit(record)
    assert writer.flush(1)
    assert writer.failed == 2


def _fill_socket(sock):
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
    sock.setblocking(False)
    filled = 0
    try:
        while True:
            filled += sock.send(b'x' * 1024)
    except BlockingIOError:
        pass
    try:
        while True:
            filled += sock.send(b'x')
    except BlockingIOError:
        pass
    sock.setblocking(True)
    return filled


@pytest.mark.parametrize('mode', ['stdout', 'stdout-buffered', 'stderr', 'frontend-file', 'ws-file'])
def test_process_exits_and_loop_advances_while_sink_stays_blocked(tmp_path, mode):
    """Unlike the pre-fix repro, the parent NEVER drains/unblocks the sink."""
    left, right = socket.socketpair()
    filled = _fill_socket(left) if mode in {'stdout', 'stdout-buffered', 'stderr'} else 0
    safe = (tmp_path / 'safe-output.txt').open('w')
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]), PYTHONDONTWRITEBYTECODE='1')
    env.pop('PYTHONUNBUFFERED', None)
    if mode != 'stdout-buffered':
        env['PYTHONUNBUFFERED'] = '1'
    command = [sys.executable, str(Path(__file__).resolve()), '--blocked-child', mode, str(tmp_path)]
    proc = subprocess.Popen(command, cwd=tmp_path, env=env,
                            stdout=left if mode.startswith('stdout') else safe,
                            stderr=left if mode == 'stderr' else safe)
    left.close()
    try:
        proc.wait(timeout=15)
        assert proc.returncode == 0, (tmp_path / 'safe-output.txt').read_text()
        result = json.loads((tmp_path / 'result.json').read_text())
        assert result['timer_ran'] and result['calls'] == 2 and result['text'] == 'recovered'
        assert result['setup_seconds'] < 1
        assert result['shutdown_seconds'] < 1
        assert result['stdout_threads'] == 1
        if mode != 'stderr':
            assert result['dropped'] > 0
            trace = (tmp_path / 'stacks.txt').read_text()
            assert '_write_record' in trace if mode.startswith('stdout') else '_write_web_' in trace
        else:
            assert result['failed'] >= 1 and result['flush_ok']
            # No secondary 'Logging error' reached stderr, even on sink failure.
            right.setblocking(False)
            data = bytearray()
            while True:
                try:
                    part = right.recv(65536)
                except BlockingIOError:
                    break
                if not part:
                    break
                data.extend(part)
            assert data == b'x' * filled
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        right.close()
        safe.close()


def _blocked_child(mode, folder):
    from app.agent.loop import Agent
    from app.llm.events import StreamEvent
    from tests.test_agent_loop import FakeBackend, RecordRenderer, _echo_registry

    entered = threading.Event()
    original_stdout = sys.stdout
    if mode == 'stderr':
        class BrokenStream:
            def write(self, _):
                entered.set()
                raise BrokenPipeError('injected stdout failure')
            def flush(self):
                pass
        sys.stdout = BrokenStream()
    elif mode.startswith('stdout'):
        original_write = logmod._StreamSink.write
        def observed_write(self, text):
            entered.set()
            original_write(self, text)
        logmod._StreamSink.write = observed_write
    logmod.setup_logging()
    sys.stdout = original_stdout
    writer = logmod._stdout_writer
    if mode.endswith('-file'):
        from app.web_console import core
        core._WEB_DEBUG_FILE_LOGS_ENABLED = True
        core._WEB_FRONTEND_EVENT_LOG_DIR = folder / 'frontend'
        core._WEB_WS_AUDIT_LOG_DIR = folder / 'ws'
        day = time.strftime('%Y-%m-%d', time.gmtime())
        fifo = ((folder / 'frontend' / f'{day}.jsonl') if mode == 'frontend-file'
                else (folder / 'ws' / 'by-day' / f'{day}.jsonl'))
        fifo.parent.mkdir(parents=True, exist_ok=True)
        os.mkfifo(fifo)
        callback_name = '_write_web_frontend_event' if mode == 'frontend-file' else '_write_web_ws_audit'
        original = getattr(core, callback_name)
        def observed_file(*args):
            entered.set()
            original(*args)
        setattr(core, callback_name, observed_file)
        emit_debug = core._log_web_frontend_event if mode == 'frontend-file' else core._log_web_ws_audit
        emit_debug({'stage':'fixture', 'conversationUuid':'local'})
        writer = core._WEB_DEBUG_LOG_WRITER
    backend = FakeBackend([
        [StreamEvent(kind='finish', finish_reason='stop')],
        [StreamEvent(kind='content', text='recovered'), StreamEvent(kind='finish', finish_reason='stop')],
    ])
    result = {}
    async def run():
        timer = asyncio.Event()
        asyncio.get_running_loop().call_later(.05, timer.set)
        value = await asyncio.wait_for(Agent(backend, _echo_registry(), empty_response_retry_limit=1).run(
            [{'role':'user','content':'fixture'}], RecordRenderer(), model='fake'), 2)
        await asyncio.wait_for(timer.wait(), 1)
        assert entered.is_set()
        result.update(timer_ran=timer.is_set(), calls=value.model_calls, text=value.text)
        if mode.endswith('-file'):
            for _ in range(200):
                emit_debug({'stage':'overflow'})
            # Separate file worker must not prevent stdout draining.
            assert await asyncio.to_thread(logmod._stdout_writer.flush, 1)
        elif mode.startswith('stdout'):
            for _ in range(1100):
                logmod.get_logger('fixture').info('overflow')
        else:
            result['flush_ok'] = await asyncio.to_thread(writer.flush, 1)
        with (folder / 'stacks.txt').open('w') as trace:
            faulthandler.dump_traceback(file=trace)
        start = time.monotonic()
        for _ in range(10):
            logmod.setup_logging()
        result['setup_seconds'] = time.monotonic() - start
        result['stdout_threads'] = sum(t.name == 'openbear-log-stdout' for t in threading.enumerate())
        start = time.monotonic()
        logging.shutdown()
        writer.close(.05)
        result['shutdown_seconds'] = time.monotonic() - start
        result['dropped'], result['failed'] = writer.dropped, writer.failed
    asyncio.run(run())
    (folder / 'result.json').write_text(json.dumps(result))
    # Normal interpreter finalization, deliberately NOT os._exit().


if __name__ == '__main__' and len(sys.argv) == 4 and sys.argv[1] == '--blocked-child':
    _blocked_child(sys.argv[2], Path(sys.argv[3]))
