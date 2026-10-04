"""Trusted subprocesses, not a sandbox. Never interpolate ingress data into argv."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import shutil
import signal
import sys
from pathlib import Path

from app.webhooks.contracts import WebhookError, dumps


def resolve_environment(script,system):
    path=system.python_path or sys.executable if script.runtime=='python' else system.node_path or shutil.which('node')
    if not path or not Path(path).is_file() or not os.access(path,os.X_OK): raise WebhookError('interpreter_unavailable',details={'runtime':script.runtime})
    cwd=system.default_cwd
    if not Path(cwd).is_absolute() or not Path(cwd).is_dir(): raise WebhookError('cwd_unavailable')
    return str(Path(path).resolve()),str(Path(cwd).resolve())


async def environment(system):
    result=[]
    for runtime,path in [('python',system.python_path or sys.executable),('node',system.node_path or shutil.which('node'))]:
        item={'runtime':runtime,'available':False,'path':path,'version':None}
        if path and Path(path).is_file() and os.access(path,os.X_OK):
            p=None; readers=[]; finished=False
            try:
                try:
                    async with asyncio.timeout(5):
                        p=await _spawn_owned_process(path,'--version',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT)
                        communication=asyncio.create_task(p.communicate())
                        readers.append(communication)
                        # Cleanup, not caller cancellation, owns the pipe reader.
                        out,_=await asyncio.shield(communication)
                        item.update(available=p.returncode==0,version=out.decode(errors='replace').strip()[:256])
                        finished=True
                finally:
                    if p is not None:
                        await _finish_process(p,readers,terminate=not finished)
            except (OSError,TimeoutError):
                pass
        result.append(item)
    return result


_PROCESS_CLEANUP_TIMEOUT_S = 2.0


async def _cleanup_process(proc, readers, *, terminate):
    """Bound pipe cleanup even when an exited parent's descendants hold them open."""
    waiter = None
    try:
        if terminate:
            # returncode only describes the group leader, not its descendants.
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
        if proc.stdin is not None:
            proc.stdin.close()
        waiter = asyncio.create_task(proc.wait())
        await asyncio.wait([waiter, *readers], timeout=_PROCESS_CLEANUP_TIMEOUT_S)
    finally:
        # An escaped descendant may keep a pipe open despite killpg. Stop reading
        # and release our pipe transports; do not wait for that descendant's EOF.
        tasks = [*readers, *([waiter] if waiter is not None else [])]
        for task in tasks:
            if not task.done():
                task.cancel()
        # asyncio.subprocess.Process has no public close() for stdout/stderr.
        proc._transport.close()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _finish_process(proc, readers, *, terminate):
    # A second stop must not cancel cleanup halfway and abandon the pipes/child.
    cleanup = asyncio.create_task(_cleanup_process(proc, readers, terminate=terminate))
    cancelled = False
    while not cleanup.done():
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            cancelled = True
    cleanup.result()
    if cancelled:
        raise asyncio.CancelledError()


async def _spawn_owned_process(*args, **kwargs):
    # Retain the handle even if stop arrives while asyncio is setting up pipes.
    # Only these private sessions may be passed to the group-based cleanup.
    spawn = asyncio.create_task(asyncio.create_subprocess_exec(
        *args, **kwargs, start_new_session=True,
    ))
    cancelled = False
    try:
        while not spawn.done():
            try:
                await asyncio.shield(spawn)
            except asyncio.CancelledError:
                if spawn.cancelled():
                    raise
                cancelled = True
        proc = spawn.result()
    except BaseException:
        if cancelled:
            raise asyncio.CancelledError()
        raise
    if cancelled:
        await _finish_process(proc, [], terminate=True)
        raise asyncio.CancelledError()
    return proc


class StartDeferred(Exception):
    """The durable launch reservation was returned without spawning."""


async def execute(script,system,payload=None,*,capability_env=None,on_start=None,start_guard=None,protocol='webhook'):
    # The subprocess owner is shared with Cron; only the wire adapter differs.
    if protocol not in ('webhook', 'text'): raise ValueError('unsupported script protocol')
    path,cwd=resolve_environment(script,system)
    source=script.code.encode()
    argv=[path, '-c' if script.runtime=='python' else '-e',script.code]
    # Explicit minimal host environment; never inherit service secrets or webhook Authorization.
    env={k:v for k,v in os.environ.items() if k in ('PATH','LANG','LC_ALL','HOME','TMPDIR','SYSTEMROOT')}
    env.update(PYTHONIOENCODING='utf-8',PYTHONUNBUFFERED='1')
    env.update(capability_env or {})
    info={'interpreter':path,'cwd':cwd,'sourceSha256':hashlib.sha256(source).hexdigest(),'runtime':script.runtime}
    p=None; stderr=bytearray(); stdout=bytearray(); truncated=False; too_large=False

    async def drain(stream,target,limit,is_stdout=False):
        nonlocal truncated,too_large
        while chunk:=await stream.read(65536):
            room=max(0,limit-len(target)); target.extend(chunk[:room])
            if len(chunk)>room:
                if is_stdout: too_large=True
                else: truncated=True

    try:
        # Persist starting before spawn: a crash in the spawn gap is conservatively unknown.
        if on_start: await on_start(info)
        readers=[]; finished=False
        try:
            # Own p before exiting the guard: its commit/FK restoration can be
            # cancelled or fail after spawn, before any reader has been created.
            async with start_guard() if start_guard else contextlib.nullcontext():
                p=await _spawn_owned_process(*argv,cwd=cwd,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            readers=[asyncio.create_task(drain(p.stdout,stdout,system.max_stdout_bytes,True)),asyncio.create_task(drain(p.stderr,stderr,system.max_stderr_bytes))]
            async with asyncio.timeout(min(script.timeout_seconds or system.default_timeout_seconds,system.max_timeout_seconds)):
                try:
                    p.stdin.write(b'' if payload is None else dumps(payload).encode()); await p.stdin.drain()
                except (BrokenPipeError,ConnectionResetError): pass
                finally: p.stdin.close()
                await p.wait(); await asyncio.gather(*readers)
                finished = True
        finally:
            if p is not None:
                await _finish_process(p, readers, terminate=not finished)
        error='stdout_limit' if too_large else 'nonzero_exit' if p.returncode else None
        result=None
        if not error and protocol == 'webhook':
            try:
                result=json.loads(stdout.decode(),parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
                if not isinstance(result,dict): raise ValueError()
                if payload['phase']=='pre' and (result.get('decision') not in ('continue','skip_model') or result.get('decision')=='skip_model' and result.get('outcome') not in ('handled','ignored')): raise ValueError()
            except (ValueError,UnicodeError): error='invalid_protocol'
        return {'stdout':stdout.decode(errors='replace'),'stdoutTruncated':too_large,'result':result if not error else None,'errorClass':error,'exitCode':p.returncode,'stderr':stderr.decode(errors='replace'),'stderrTruncated':truncated,'execution':info,'effectState':'unknown' if error else 'reported'}
    except asyncio.CancelledError as exc:
        # Cleanup above has already reaped our process and bounded pipe draining.
        # Keep the original exception (asyncio.timeout relies on its type) while
        # allowing the owning Cron stage to persist the output captured so far.
        exc.script_result = {'stdout':stdout.decode(errors='replace'),'stdoutTruncated':too_large,
            'stderr':stderr.decode(errors='replace'),'stderrTruncated':truncated,
            'errorClass':'cancelled','errorSummary':'脚本已取消','exitCode':p.returncode if p else None}
        raise
    except TimeoutError:
        return {'stdout':stdout.decode(errors='replace'),'stdoutTruncated':too_large,'result':None,'errorClass':'timeout','exitCode':p.returncode if p else None,'stderr':stderr.decode(errors='replace'),'stderrTruncated':truncated,'execution':info,'effectState':'unknown'}
    except OSError as e:
        return {'result':None,'errorClass':'spawn_error','errorSummary':str(e),'exitCode':None,'stderr':'','stderrTruncated':False,'execution':info,'effectState':'none'}
