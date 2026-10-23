"""Opt-in real systemd tests, restricted to disposable ob-watchdog-test-* units."""
from __future__ import annotations

import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("OPENBEAR_SYSTEMD_TEST") != "1",
    reason="set OPENBEAR_SYSTEMD_TEST=1 to test disposable systemd services",
)
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def unit(tmp_path):
    name = f"ob-watchdog-test-{uuid.uuid4().hex}.service"

    def systemctl(*args):
        return subprocess.run(["systemctl", *args, name], capture_output=True, text=True, timeout=12)

    def state():
        result = systemctl("show", "--property=ActiveState,SubState,Result,NRestarts,ExecMainStatus")
        assert result.returncode == 0, result.stderr
        return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)

    def launch(mode, *, restart=False):
        properties = {
            "Type": "notify", "NotifyAccess": "main", "WorkingDirectory": str(ROOT),
            "TimeoutStartSec": "2s", "TimeoutStopSec": "2s", "TimeoutAbortSec": "1s",
            "WatchdogSec": "1s", "Restart": "on-failure" if restart else "no",
            "RestartSec": "200ms", "RestartPreventExitStatus": "78",
            "StartLimitIntervalSec": "30s", "StartLimitBurst": "3", "RuntimeMaxSec": "20s",
            "LimitCORE": "0",
        }
        args = ["systemd-run", "--quiet", "--no-block", f"--unit={name}", f"--setenv=PYTHONPATH={ROOT}"]
        args += [f"--property={key}={value}" for key, value in properties.items()]
        args += [sys.executable, str(ROOT / "tests/fixtures/systemd_watchdog_process.py"),
                 mode, str(tmp_path / "starts")]
        result = subprocess.run(args, capture_output=True, text=True, timeout=12)
        assert result.returncode == 0, result.stderr

    def wait_for(predicate, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = state()
            if predicate(current):
                return current
            time.sleep(0.05)
        journal = subprocess.run(["journalctl", "-u", name, "-n", "40", "--no-pager"],
                                 capture_output=True, text=True, timeout=10)
        pytest.fail(f"unit did not reach expected state: {current}\n{journal.stdout}")

    try:
        yield launch, state, wait_for, systemctl, tmp_path / "starts"
    finally:
        systemctl("stop")
        systemctl("reset-failed")


def test_unready_service_hits_startup_timeout(unit):
    launch, _, wait_for, _, _ = unit
    launch("startup-stall")
    result = wait_for(lambda s: s["ActiveState"] == "failed")
    assert result["Result"] == "timeout"


def test_async_long_wait_is_healthy_and_normal_stop_does_not_restart(unit):
    launch, state, wait_for, control, _ = unit
    launch("healthy", restart=True)
    wait_for(lambda s: s["ActiveState"] == "active")
    time.sleep(2.5)
    result = state()
    assert result["ActiveState"] == "active" and result["NRestarts"] == "0"
    assert control("stop").returncode == 0
    time.sleep(0.4)
    assert state()["ActiveState"] == "inactive"


def test_stalled_loop_is_detected_and_restarted(unit):
    launch, _, wait_for, _, starts = unit
    launch("recover", restart=True)
    result = wait_for(lambda s: s["ActiveState"] == "active" and int(s["NRestarts"]) >= 1)
    assert result["NRestarts"] == "1" and starts.read_text() == "2"


def test_repeated_stalls_hit_start_limit(unit):
    launch, _, wait_for, _, starts = unit
    launch("stall", restart=True)
    result = wait_for(lambda s: s["ActiveState"] == "failed" and s["NRestarts"] == "3")
    assert result["Result"] in {"watchdog", "start-limit-hit"} and starts.read_text() == "3"
    time.sleep(0.5)
    assert starts.read_text() == "3"


def test_configuration_error_does_not_restart(unit):
    launch, state, wait_for, _, starts = unit
    launch("config-error", restart=True)
    wait_for(lambda s: s["ActiveState"] == "failed")
    time.sleep(0.5)
    result = state()
    assert result["ExecMainStatus"] == "78" and result["NRestarts"] == "0"
    assert starts.read_text() == "1"
