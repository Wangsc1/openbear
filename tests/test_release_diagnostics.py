"""The summary CLI reads real temporary evidence, never runs release stages."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from release_support import diagnostics  # noqa: E402
from release_support.common import atomic_json, sha  # noqa: E402


def saved_run(tmp_path):
    run_id = "1.0.1-123456789abc"
    directory = tmp_path / ".release-runs" / run_id
    directory.mkdir(parents=True)
    value = {"schema": 1, "runId": run_id, "repo": str(tmp_path), "python": sys.executable,
             "version": "1.0.1", "createdAt": time.time() - 40, "stages": {},
             "notes": "secret notes must not be returned", "candidate": {"files": {"SOURCE-MAP": "huge"}}}
    return directory, value


def test_cli_summary_prefers_junit_preserves_paths_and_is_read_only(tmp_path):
    directory, value = saved_run(tmp_path)
    out = directory / "results/py312/attempts/failed"
    out.mkdir(parents=True)
    junit = out / "junit.xml"
    junit.write_text('<testsuites><testsuite><testcase classname="tests.test_cron" name="test_finish">'
                     '<failure message="assert status == done">tests/test_cron.py:42\nassert status == done\nE AssertionError: pending != done</failure>'
                     '</testcase><testcase name="passed"/></testsuite></testsuites>')
    log = out / "stage.log"
    log.write_text("x" * 100000 + "\nAssertionError: pending != done\npassword=diagnostic-private\n")
    result = {"ok": False, "error": "test process exited 1", "testCases": [{"id": "MUST-NOT-RETURN"}] * 10000,
              "outputs": {"log": str(log), "junit": str(junit)}}
    atomic_json(out / "result.json", result)
    atomic_json(directory / "results/py312/result.json", result)
    value["stages"]["py312"] = {"status": "failed", "startedAt": time.time() - 10,
                                 "finishedAt": time.time(), "error": "py312: exit 1"}
    front = directory / "frontend.log"
    front.write_text("all passed")
    value["stages"]["frontend"] = {"status": "passed", "startedAt": time.time() - 12, "finishedAt": time.time() - 11,
        "result": {"ok": True, "counts": {"tests": 3, "failed": 0},
                   "outputs": {"log": str(front), "logSha256": sha(front.read_bytes())}}}
    atomic_json(directory / "state.json", value)
    before = {p: (p.stat().st_mtime_ns, sha(p.read_bytes())) for p in directory.rglob("*") if p.is_file()}
    command = [sys.executable, str(ROOT / "scripts/release.py"), "--repo", str(tmp_path), "status", value["runId"]]
    process = subprocess.run(command + ["--summary"], capture_output=True, text=True)
    assert process.returncode == 0, process.stderr
    answer = json.loads(process.stdout)
    assert answer["schema"] == 1 and answer["status"] == "failed"
    failure = answer["failedStages"][0]
    assert failure["failedTests"] == [{"id": "tests.test_cron::test_finish", "assertion": "assert status == done",
                                       "stackTrace": "tests/test_cron.py:42\nassert status == done\nE AssertionError: pending != done"}]
    assert failure["evidence"]["result"] == str(out / "result.json")
    assert failure["evidence"]["junit"] == str(junit)
    assert "pending != done" in failure["logTail"]
    assert "frontend" in answer["reusableStages"]
    assert all(set(row) == {"stage", "status", "seconds", "reused"} for row in answer["stages"])
    assert answer["resume"]["action"] == "resume" and answer["resume"]["runId"] == value["runId"]
    assert answer["resume"]["argv"] == [sys.executable, str(ROOT / "scripts/release.py"), "--repo", str(tmp_path), "resume", value["runId"]]
    assert answer["resume"]["approvalFlag"] == "--approve-container-cgroup"
    assert not any(word in process.stdout for word in ("testCases", "SOURCE-MAP", "MUST-NOT-RETURN", "secret notes", "diagnostic-private"))
    assert len(process.stdout.encode()) < 20000
    full = subprocess.run(command, capture_output=True, text=True)
    assert full.returncode == 0 and json.loads(full.stdout) == value
    assert before == {p: (p.stat().st_mtime_ns, sha(p.read_bytes())) for p in directory.rglob("*") if p.is_file()}
    assert not (directory.parent / "lock").exists()


def test_summary_log_fallback_and_missing_or_malformed_junit(tmp_path):
    directory, value = saved_run(tmp_path)
    logs = directory / "logs"
    logs.mkdir()
    log = logs / "100-build.log"
    log.write_text("relevant build failure\nstack: failed compiler")
    atomic_json(log.with_suffix(".json"), {"startedAt": 10})
    value["stages"]["build"] = {"status": "failed", "startedAt": 9, "finishedAt": 11, "error": "exit 1"}
    result = diagnostics.summary(directory, value)
    assert result["failedStages"][0]["logTail"].endswith("stack: failed compiler")
    assert result["failedStages"][0]["evidence"]["logs"] == [str(log)]
    bad = directory / "bad.xml"
    bad.write_text("<truncated>")
    value["stages"]["build"]["result"] = {"outputs": {"junit": str(bad)}}
    result = diagnostics.summary(directory, value)
    assert result["failedStages"][0]["diagnosticErrors"][0].startswith("JUnit:")
    bad.unlink()
    assert diagnostics.summary(directory, value)["failedStages"][0]["diagnosticErrors"]


def test_summary_caps_failure_collection_and_redacts_credentials(tmp_path, monkeypatch):
    directory, value = saved_run(tmp_path)
    monkeypatch.setenv("GH_TOKEN", "arbitrary-environment-token")
    junit = directory / "large.xml"
    junit.write_text('<testsuites><testsuite>' + ''.join(
        f'<testcase classname="cron" name="test_{n}"><failure message="assert False">' + '堆栈' * 8000 +
        '\nghp_aCredentialValue\nGH_TOKEN=arbitrary-environment-token\nAuthorization: Bearer credential\n' +
        '</failure></testcase>' for n in range(20)) + '</testsuite></testsuites>')
    for n in range(50):
        value["stages"][f"py{n}"] = {"status": "failed", "startedAt": 1, "finishedAt": 2,
            "error": 'api_key="quoted value with spaces"', "result": {"outputs": {"junit": str(junit)}}}
    result = diagnostics.summary(directory, value)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    assert len(text.encode()) + 1 <= diagnostics.MAX_SUMMARY_BYTES < 64 * 1024
    assert len(result["stages"]) == 32 and len(result["failedStages"]) == 8
    assert result["omitted"]["stages"] == 18 and result["omitted"]["failedStages"] == 42
    assert all(len(f["failedTests"]) <= 5 and f["omittedFailedTests"] >= 15 for f in result["failedStages"])
    assert not any(s in text for s in ("ghp_aCredentialValue", "arbitrary-environment-token", "Bearer credential", "quoted value"))


@pytest.mark.parametrize("status", ["completed", "cleanup-required", "paused", "interrupted", "running"])
def test_recovery_status_and_conditional_approval(tmp_path, status):
    directory, value = saved_run(tmp_path)
    if status == "completed":
        value["completed"] = True
        value["stages"]["publication"] = {"status": "passed", "result": {"url": "https://github.com/fixture/repo/releases/tag/v1.0.1"}}
    elif status == "cleanup-required":
        value["published"] = True
    elif status == "paused":
        value["lastError"] = {"exitCode": 2, "message": "need approval"}
    else:
        value["stages"]["build"] = {"status": "running", "startedAt": time.time()}
        if status == "running":
            value["invocations"] = [{"startedAt": time.time(), "pid": os.getpid(), "startTicks": diagnostics.process_ticks(os.getpid())}]
    answer = diagnostics.summary(directory, value)
    assert answer["status"] == status
    if status in {"completed", "cleanup-required"}:
        assert not answer["resume"]["requiresContainerCgroupApproval"]
    if status == "completed":
        assert not answer["resume"]["needed"] and answer["resume"]["argv"] is None
        assert answer["publication"]["url"].endswith("/v1.0.1")


def test_status_failure_does_not_create_run_root(tmp_path):
    result = subprocess.run([sys.executable, str(ROOT / "scripts/release.py"), "--repo", str(tmp_path),
                             "status", "1.0.1-123456789abc", "--summary"], capture_output=True)
    assert result.returncode == 1
    assert not (tmp_path / ".release-runs").exists()


def test_stale_result_pointer_and_outside_evidence_are_not_read(tmp_path):
    directory, value = saved_run(tmp_path)
    pointer = directory / "results/py312/result.json"
    atomic_json(pointer, {"error": "obsolete candidate", "ok": False})
    value["stages"]["py312"] = {"status": "failed", "startedAt": time.time() + 1, "error": "new command failed"}
    answer = diagnostics.summary(directory, value)
    assert "obsolete candidate" not in json.dumps(answer)
    external = tmp_path / "external.xml"
    external.write_text("do not read")
    value["stages"]["py312"]["result"] = {"outputs": {"junit": str(external)}}
    assert diagnostics.summary(directory, value)["failedStages"][0]["evidence"]["junit"] is None
