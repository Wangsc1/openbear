"""Bounded in-container environment jobs, not a controller/host exec service."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import time
import uuid
from pathlib import Path

import aiosqlite

from app.managed.settings import sanitized_env

OUTPUT_LIMIT = 1024 * 1024


class EnvironmentJobs:
    def __init__(self, root: str, cwd: str):
        self.path = Path(root) / ".managed" / "jobs.db"
        self.cwd = cwd
        self.conn = None
        self.tasks = {}
        self.processes = {}
        self.lock = asyncio.Lock()

    async def open(self):
        self.conn = await aiosqlite.connect(self.path)
        await self.conn.execute("PRAGMA journal_mode=WAL")
        await self.conn.execute("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        cur = await self.conn.execute("SELECT id,payload FROM jobs")
        for job_id, payload in await cur.fetchall():
            job = json.loads(payload)
            if job["status"] in {"queued", "running"}:
                job.update(status="interrupted", finishedAtMs=int(time.time() * 1000))
                await self.conn.execute("UPDATE jobs SET payload=? WHERE id=?", (json.dumps(job), job_id))
        await self.conn.commit()

    async def save(self, job):
        async with self.lock:
            await self.conn.execute("INSERT OR REPLACE INTO jobs(id,payload) VALUES(?,?)", (job["id"], json.dumps(job)))
            await self.conn.commit()

    async def get(self, job_id):
        cur = await self.conn.execute("SELECT payload FROM jobs WHERE id=?", (job_id,))
        row = await cur.fetchone()
        return json.loads(row[0]) if row else None

    async def create(self, command, timeout=120):
        if not isinstance(command, str) or not command.strip() or len(command) > 65536:
            raise ValueError("command must contain 1..65536 characters")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 3600:
            raise ValueError("timeoutSeconds must be 1..3600")
        # Serialize admission + row retention; only terminal rows may be evicted.
        async with self.lock:
            if len(self.tasks) >= 4:
                raise RuntimeError("job_capacity_reached")
            cur = await self.conn.execute("SELECT id,payload FROM jobs ORDER BY rowid")
            rows = await cur.fetchall()
            for old_id, payload in rows[:max(0, len(rows) - 199)]:
                if json.loads(payload)["status"] not in {"queued", "running"}:
                    await self.conn.execute("DELETE FROM jobs WHERE id=?", (old_id,))
            job = {"id": str(uuid.uuid4()), "status": "queued", "command": command,
                   "timeoutSeconds": timeout, "createdAtMs": int(time.time() * 1000),
                   "output": "", "truncated": False, "exitCode": None}
            await self.conn.execute("INSERT INTO jobs VALUES(?,?)", (job["id"], json.dumps(job)))
            await self.conn.commit()
            task = asyncio.create_task(self._run(job), name="managed-job-" + job["id"])
            self.tasks[job["id"]] = task
            task.add_done_callback(lambda _: self.tasks.pop(job["id"], None))
        return dict(job)

    @staticmethod
    async def _kill(proc):
        if proc:
            # Even an exited shell can leave descendants holding the output pipe.
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()

    async def _run(self, job):
        proc = None
        output = bytearray()
        reader = None
        try:
            job.update(status="running", startedAtMs=int(time.time() * 1000))
            await self.save(job)
            proc = await asyncio.create_subprocess_exec(
                "/bin/bash", "-c", job["command"], cwd=self.cwd, env=sanitized_env(),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
            self.processes[job["id"]] = proc

            async def drain():
                while chunk := await proc.stdout.read(16384):
                    room = OUTPUT_LIMIT - len(output)
                    output.extend(chunk[:room])
                    if len(chunk) > room:
                        job["truncated"] = True
            reader = asyncio.create_task(drain())
            await asyncio.wait_for(asyncio.gather(proc.wait(), reader), job["timeoutSeconds"])
            job.update(status="completed" if proc.returncode == 0 else "failed", exitCode=proc.returncode)
        except TimeoutError:
            job["status"] = "timed_out"
        except asyncio.CancelledError:
            job["status"] = "cancelled"
        except Exception:
            job["status"] = "failed"
            job["error"] = "process_execution_failed"
        finally:
            await self._kill(proc)
            if reader and not reader.done():
                reader.cancel()
            if reader:
                with contextlib.suppress(asyncio.CancelledError):
                    await reader
            self.processes.pop(job["id"], None)
            job.update(output=output.decode("utf-8", errors="replace"), finishedAtMs=int(time.time() * 1000))
            await self.save(job)

    async def cancel(self, job_id):
        task = self.tasks.get(job_id)
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            # Cancellation before the coroutine's first execution still terminates row.
            job = await self.get(job_id)
            if job and job["status"] in {"queued", "running"}:
                job.update(status="cancelled", finishedAtMs=int(time.time() * 1000))
                await self.save(job)
        return await self.get(job_id)

    async def close(self):
        for job_id in list(self.tasks):
            await self.cancel(job_id)
        if self.conn:
            await self.conn.close()
