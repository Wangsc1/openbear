"""中文结构化日志：时间 | 级别 | [模块] | 事件 | 键=值 | 键=值。"""
from __future__ import annotations

import atexit
import logging
import os
import queue
import sys
import threading
from collections.abc import Callable
from typing import Any

_LEVELS = {
    "DEBUG": logging.DEBUG, "INFO": logging.INFO,
    "WARNING": logging.WARNING, "ERROR": logging.ERROR,
}


class _Formatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = self.formatTime(record, "%Y-%m-%d %H:%M:%S")
        base = f"{ts} | {record.levelname:<5} | [{record.name}] | {record.getMessage()}"
        kv = getattr(record, "kv", None)
        if kv:
            pairs = " | ".join(f"{k}={v}" for k, v in kv.items())
            base = f"{base} | {pairs}"
        if record.exc_info:
            base = f"{base}\n{self.formatException(record.exc_info)}"
        return base


class BackgroundLogWriter:
    """Bounded best-effort diagnostics, never backpressure the caller.

    Only this daemon calls the sink. Neither queue overflow nor sink failure may
    log to stderr (which commonly shares stdout's blocked journal socket).
    One worker is reused across logging setups; a stuck sink cannot accumulate
    replacement threads. Pending records may be lost on overflow or shutdown.
    """

    def __init__(self, name: str, *, capacity: int = 1024) -> None:
        self._name = name
        self._queue: queue.Queue = queue.Queue(maxsize=max(1, capacity))
        self._start_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._closed = False
        self.dropped = 0
        self.failed = 0
        atexit.register(self.close)

    def submit(self, write: Callable[..., Any], /, *args: Any) -> bool:
        # A formatter/sink logging recursively must not feed its own queue.
        if self._closed or threading.current_thread() is self._thread:
            self.dropped += 1
            return False
        if not self._start_lock.acquire(blocking=False):
            self.dropped += 1
            return False
        try:
            if self._closed:
                self.dropped += 1
                return False
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name=self._name, daemon=True)
                try:
                    self._thread.start()
                except Exception:
                    self._thread = None
                    self.failed += 1
                    return False
            try:
                self._queue.put_nowait((write, args))
                return True
            except queue.Full:
                self.dropped += 1
                return False
        finally:
            self._start_lock.release()

    def _run(self) -> None:
        while True:
            try:
                job = self._queue.get(timeout=0.05)
            except queue.Empty:
                if self._closed:
                    return
                continue
            try:
                write, args = job
                write(*args)
            except BaseException:
                # Even a broken formatter must not reach threading.excepthook,
                # whose default implementation writes synchronously to stderr.
                self.failed += 1
            finally:
                self._queue.task_done()
                del job, write, args

    def flush(self, timeout: float = 0.2) -> bool:
        """Best-effort barrier; never an unbounded Queue.join()/sink.flush()."""
        done = threading.Event()
        return self.submit(done.set) and done.wait(max(0.0, timeout))

    def close(self, timeout: float = 0.2) -> None:
        self._closed = True
        thread = self._thread
        if thread is not None and thread.ident is not None and thread is not threading.current_thread():
            thread.join(max(0.0, timeout))


class _StreamSink:
    def __init__(self, stream: Any) -> None:
        self._stream = None
        self._raw = None
        self._encoding = getattr(stream, "encoding", None) or "utf-8"
        self._errors = getattr(stream, "errors", None) or "strict"
        try:
            fd = os.dup(stream.fileno())
        except (AttributeError, OSError, ValueError):
            # StringIO/custom streams (including test capture) have no usable FD.
            self._stream = stream
        else:
            # Never hold sys.stdout's BufferedWriter lock in a stuck daemon:
            # Python flushes sys.stdout again at interpreter shutdown. A private
            # unbuffered duplicate also keeps later setup/close off that lock.
            self._raw = os.fdopen(fd, "wb", buffering=0)

    def write(self, text: str) -> None:
        if self._raw is not None:
            data = memoryview(text.encode(self._encoding, self._errors))
            while data:
                written = self._raw.write(data)
                if not written:
                    raise OSError("log stream made no write progress")
                data = data[written:]
        else:
            self._stream.write(text)
            self._stream.flush()


def _write_record(sink: _StreamSink, formatter: logging.Formatter, record: logging.LogRecord) -> None:
    sink.write(formatter.format(record) + "\n")


_stdout_writer = BackgroundLogWriter("openbear-log-stdout")


class _QueuedStreamHandler(logging.Handler):
    def __init__(self, stream: Any) -> None:
        super().__init__()
        self._sink: _StreamSink | None = _StreamSink(stream)
        self.setFormatter(_Formatter())

    def emit(self, record: logging.LogRecord) -> None:
        if self._sink is not None:
            # No QueueHandler.prepare(): it formats exceptions on the caller.
            # Keeping the original record retains exc_info for the writer.
            _stdout_writer.submit(_write_record, self._sink, self.formatter, record)

    def flush(self) -> None:
        if not self._closed:
            _stdout_writer.flush()

    def close(self) -> None:
        # Queued jobs retain their own sink; no sink close/flush/join here.
        self._sink = None
        super().close()


class _Logger:
    """轻量包装：log.info("事件", 键=值) 风格。"""

    def __init__(self, name: str) -> None:
        self._log = logging.getLogger(name)

    def _emit(self, level: int, event: str, **kv: Any) -> None:
        self._log.log(level, event, extra={"kv": kv} if kv else {})

    def info(self, event: str, **kv: Any) -> None:
        self._emit(logging.INFO, event, **kv)

    def warning(self, event: str, **kv: Any) -> None:
        self._emit(logging.WARNING, event, **kv)

    def error(self, event: str, **kv: Any) -> None:
        self._emit(logging.ERROR, event, **kv)

    def exception(self, event: str, **kv: Any) -> None:
        self._log.log(logging.ERROR, event, extra={"kv": kv} if kv else {}, exc_info=True)


def setup_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    root.setLevel(_LEVELS.get(level.upper(), logging.INFO))
    previous = list(root.handlers)
    # Install before removing the old sink: concurrent warnings must never fall
    # through an empty root to logging.lastResort's synchronous stderr handler.
    root.addHandler(_QueuedStreamHandler(sys.stdout))
    for h in previous:
        root.removeHandler(h)
        if isinstance(h, _QueuedStreamHandler):
            h.close()
    # 降噪第三方库
    for noisy in ("httpx", "httpcore", "aiosqlite", "asyncio", "aiogram.event"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> _Logger:
    return _Logger(name)
