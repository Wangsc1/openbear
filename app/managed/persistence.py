"""Volume evidence and single-runtime/offline-maintenance exclusion."""
from __future__ import annotations

import fcntl
import os
import re
from pathlib import Path


def workspace_mounted(root: str, *, mountinfo: str | None = None) -> bool:
    """Require a distinct kernel mountpoint, not an ordinary writable directory."""
    try:
        expected = Path(root).resolve(strict=True)
        if expected == Path("/"):
            return False
        text = mountinfo if mountinfo is not None else Path("/proc/self/mountinfo").read_text()
        for line in text.splitlines():
            fields = line.split()
            if len(fields) < 10 or "-" not in fields:
                continue
            point = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), fields[4])
            if Path(point) == expected:
                return True
    except (OSError, ValueError):
        pass
    return False


class WorkspaceLock:
    def __init__(self, root):
        directory = Path(root) / ".managed"
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.fd = os.open(directory / "runtime.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.fd)
            self.fd = None
            raise RuntimeError("managed workspace is in use; stop its runtime before maintenance") from None

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
