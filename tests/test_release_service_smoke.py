"""The packaged smoke must exercise Services, not just a healthy Web listener."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from app import installed_version
from scripts.release_support.build import anomalies

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("fail_recovery", [False, True])
def test_smoke_uses_full_service_and_propagates_required_recovery_failure(tmp_path, fail_recovery):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    # Carries the login-mode placeholder the server fills in, like the real build.
    (dist / "index.html").write_text('<html><script>window.__OPENBEAR_AUTH__ = "[[controller]]"</script>'
                                     '<script type="module" src="/assets/main.js"></script></html>')
    (dist / "assets/main.js").write_text("console.log('smoke')")
    (dist / "build-info.json").write_text(json.dumps({"schema": 1, "version": installed_version(), "buildId": "a" * 16}))
    output = tmp_path / "smoke.json"
    launch = '''
import sys
sys.path.insert(0, sys.argv[1])
from scripts.smoke_release_login import main
if sys.argv[2] == 'fail':
    from app.collab.service import CollabService
    async def fail(self):
        raise RuntimeError('required-recovery-injected')
    CollabService.start = fail
sys.argv = ['smoke', '--root', sys.argv[1], '--dist', sys.argv[3], '--output', sys.argv[4]]
main()
'''
    result = subprocess.run([sys.executable, "-I", "-c", launch, str(ROOT),
                             "fail" if fail_recovery else "ok", str(dist), str(output)],
                            cwd=tmp_path, capture_output=True, text=True, timeout=45)
    combined = result.stdout + result.stderr
    assert not anomalies(combined), combined
    if fail_recovery:
        assert result.returncode != 0 and "required-recovery-injected" in combined
        assert not output.exists(), "A failed service must not produce successful smoke evidence"
    else:
        assert result.returncode == 0, combined
        report = json.loads(output.read_text())
        assert report["serviceLifecycle"] == {"fullStartup": True, "ready": True, "cleanShutdown": True}
        assert report["approvedLogin"]["sessionEstablished"]
        assert report["conversationWebSocket"]["authenticatedPingPong"]
