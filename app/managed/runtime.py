"""Managed lifecycle and readiness; the controller pulls status, nothing is pushed."""
from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

from app import installed_version
from app.managed.account import LocalAccount
from app.managed.jobs import EnvironmentJobs
from app.managed.persistence import WorkspaceLock, workspace_mounted
from app.managed.settings import MANAGEMENT_ENV


class ManagedRuntime:
    def __init__(self, services):
        self.services = services
        self.settings = services.config.managed
        self.workspace_lock = WorkspaceLock(self.settings.workspace_root)
        try:
            self.pepper = self.settings.persist()
            self.account = LocalAccount(self.settings.workspace_root) if self.settings.auth_mode == "local" else None
        except BaseException:
            self.workspace_lock.close()
            raise
        self.login_lock = asyncio.Lock()
        self.jobs = EnvironmentJobs(self.settings.workspace_root, services.workspace_dir)
        self.ready = False
        for name in MANAGEMENT_ENV:
            os.environ.pop(name, None)

    async def open(self):
        from app.managed.migration import migrate_local_owner
        await migrate_local_owner(self.services.db)
        await self.jobs.open()

    async def emit(self, kind, data=None):
        """Login events on legacy local-auth volumes; kept for callers, no longer pushed."""
        return None

    async def status(self):
        issues = []
        root = Path(self.settings.workspace_root).resolve()
        mounted = workspace_mounted(str(root))
        if not mounted:
            issues.append("workspace_not_mounted")
        paths = [Path(self.services.config.storage.db_path).resolve(), Path(self.services.workspace_dir).resolve()]
        if any(not path.is_relative_to(root) or path == root for path in paths):
            issues.append("persistence_path_outside_workspace")
        try:
            await self.services.db.conn.execute("SELECT 1")
        except Exception:
            issues.append("database_unavailable")
        if not root.is_dir() or not os.access(root, os.W_OK):
            issues.append("workspace_unwritable")
        else:
            if shutil.disk_usage(root).free < 16 * 1024 * 1024:
                issues.append("workspace_low_space")
        return {"ok": True, "instanceId": self.settings.instance_id,
                "version": installed_version(), "ready": self.ready,
                "persistence": {"root": str(root), "mounted": mounted, "dbPath": str(paths[0]),
                                "workspacePath": str(paths[1])},
                "health": {"status": "degraded" if issues or not self.ready else "healthy", "issues": issues}}

    async def start(self):
        self.ready = True

    async def close(self):
        self.ready = False
        try:
            await self.jobs.close()
        finally:
            self.workspace_lock.close()
