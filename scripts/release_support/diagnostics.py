"""Read-only, bounded release status protocol (schema 1).

No stage execution, credentials, source maps or complete test collections are
returned. Paths refer to the original evidence, including cross-run test reuse.
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from .common import load, process_ticks
from . import scope
from .publication import asset_metadata
from .runner import TEST_STAGES, verified_build

MAX_STAGES, MAX_FAILED_STAGES, MAX_CASES, MAX_LOGS = 32, 8, 5, 6
MAX_JSON_BYTES = 32 * 1024 * 1024
MAX_XML_BYTES = 32 * 1024 * 1024
MAX_SUMMARY_BYTES = 60 * 1024


def redact(text):
    text = str(text or "")
    for name in ("GH_TOKEN", "GITHUB_TOKEN"):
        token = os.environ.get(name)
        if token:
            for secret in (token, base64.b64encode(("x-access-token:" + token).encode()).decode()):
                text = text.replace(secret, "<redacted>")
    text = re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b", "<redacted>", text)
    text = re.sub(r"(?i)((?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+", r"\1<redacted>", text)
    text = re.sub(r'''(?ix)(?<![\w])(["']?(?:[\w-]{0,64}(?:token|password|passwd|secret)|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)''', r"\1<redacted>", text)
    text = re.sub(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9_+/.=-]+", r"\1 <redacted>", text)
    return re.sub(r"(https?://)[^/@\s]+:[^/@\s]+@", r"\1<redacted>@", text)


def excerpt(text, limit=2048, *, tail=False):
    text = redact(text)
    if len(text) <= limit:
        return text
    return ("…" + text[-limit + 1:]) if tail else (text[:limit - 1] + "…")


def safe_path(value, directory):
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    if not path.is_absolute():
        path = directory / path
    try:
        if path.resolve().is_relative_to(directory.parent.resolve()):
            return path
    except (OSError, ValueError):
        pass
    return None


def read_json(path):
    if path.stat().st_size > MAX_JSON_BYTES:
        raise ValueError("Result JSON exceeds diagnostic read limit")
    return load(path)


def log_tail(path):
    try:
        with path.open("rb") as stream:
            stream.seek(0, 2)
            stream.seek(max(0, stream.tell() - 16384))
            return excerpt(stream.read().decode("utf-8", "replace"), tail=True)
    except OSError as exc:
        return excerpt(f"Cannot read log: {exc}")


def junit_failures(path):
    """Prefer assertion/traceback evidence, without materializing passed cases."""
    if path.stat().st_size > MAX_XML_BYTES:
        raise ValueError("JUnit exceeds diagnostic read limit")
    failures, total = [], 0
    for _event, item in ET.iterparse(path, events=("end",)):
        tag = item.tag.rsplit("}", 1)[-1]
        if tag == "testcase":
            errors = [child for child in item if child.tag.rsplit("}", 1)[-1] in {"failure", "error"}]
            if errors:
                total += 1
                if len(failures) < MAX_CASES:
                    error = errors[0]
                    body = "".join(error.itertext())
                    assertion = error.get("message") or next((line for line in reversed(body.splitlines()) if "assert" in line.lower() or "Error" in line), body)
                    failures.append({"id": excerpt(item.get("classname", "") + "::" + item.get("name", ""), 512),
                                     "assertion": excerpt(assertion, 1024), "stackTrace": excerpt(body, tail=True)})
            item.clear()
    return failures, max(0, total - len(failures))


def evidence(directory, name, record):
    if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", name):
        return {}, {"result": None, "junit": None, "logs": []}, ["Invalid stage name"]
    result = record.get("result") or {}
    result_path = None
    diagnostics = []
    # Failed commands raise before State gets their structured result. Read only
    # the result belonging to this attempt, never a previous candidate's pointer.
    pointer = (directory / "acceptance" / ("case-" + name[-1].lower()) / "report.json"
               if name in {"acceptance-A", "acceptance-B"} else directory / "results" / name / "result.json")
    if not result:
        try:
            if pointer.stat().st_mtime >= record.get("startedAt", 0):
                result = read_json(pointer)
                result_path = pointer
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as exc:
            diagnostics.append(excerpt(exc, 512))
    outputs = result.get("outputs") or {}
    junit = safe_path(outputs.get("junit"), directory)
    logs = []
    log = safe_path(outputs.get("log") or result.get("log"), directory)
    if log:
        logs.append(log)
        immutable_result = log.parent / "result.json"
        if immutable_result.is_file():
            result_path = immutable_result
    evidence_dir = safe_path(result.get("evidenceDirectory"), directory)
    if evidence_dir:
        if (evidence_dir / "report.json").is_file():
            result_path = evidence_dir / "report.json"
        logs.extend(sorted((evidence_dir / "evidence").glob("*.log"), reverse=True)[:MAX_LOGS])
    # Outer CLI log is useful for timeouts, parser failures and non-test stages.
    for path in sorted((directory / "logs").glob("*-" + name + ".log"), reverse=True):
        try:
            receipt = read_json(path.with_suffix(".json"))
            if receipt.get("startedAt", 0) >= record.get("startedAt", 0) and receipt.get("startedAt", 0) <= record.get("finishedAt", time.time()):
                logs.append(path)
                break
        except (OSError, ValueError):
            continue
    logs = list(dict.fromkeys(logs))[:MAX_LOGS]
    return result, {"result": str(result_path) if result_path else None,
                    "junit": str(junit) if junit else None, "logs": [str(p) for p in logs]}, diagnostics


def run_status(value):
    if value.get("completed"):
        return "completed"
    if value.get("published"):
        return "cleanup-required"
    invocations = value.get("invocations") or []
    if invocations:
        last = invocations[-1]
        if not last.get("finishedAt") and last.get("pid") and last.get("startTicks") == process_ticks(last["pid"]):
            return "running"
    records = value.get("stages", {}).values()
    if any(r.get("status") == "paused" for r in records) or (value.get("lastError") or {}).get("exitCode") == 2:
        return "paused"
    if any(r.get("status") == "failed" for r in records) or value.get("lastError"):
        return "failed"
    if any(r.get("status") == "running" for r in records) or (invocations and not invocations[-1].get("finishedAt")):
        return "interrupted"
    return "pending"


def summary(directory: Path, value: dict) -> dict:
    now = time.time()
    records = value.get("stages", {})
    stages, failed, reusable = [], [], []
    failure_count = sum(r.get("status") in {"failed", "paused"} for r in records.values())
    for name, record in list(records.items())[:MAX_STAGES]:
        status = record.get("status", "unknown")
        result, paths, diagnostic_errors = evidence(directory, name, record)
        seconds = max(0, record.get("finishedAt", now) - record.get("startedAt", now))
        row = {"stage": excerpt(name, 64), "status": excerpt(status, 32), "seconds": round(seconds, 3),
               "reused": bool(record.get("lastReusedAt") or result.get("evidenceReuse") or result.get("reused") or result.get("reusedFrontend"))}
        stages.append(row)
        if status == "passed":
            # Eligibility is conditional on unchanged candidate/environment. The
            # runner always repeats its input and integrity checks on resume.
            eligible = False
            try:
                if name in TEST_STAGES or name == "frontend-checks":
                    eligible = scope.verified_result(result)
                elif name == "build":
                    eligible = verified_build(result, directory / "build")
                elif name in {"package", "smoke", "acceptance-A", "acceptance-B"}:
                    assets = records.get("package", {}).get("result", {}).get("assets")
                    eligible = bool(assets and asset_metadata(directory / "assets", assets))
                elif name == "source":
                    eligible = (directory / "source/.git").is_dir()
                elif name == "env":
                    eligible = (directory / "environment.json").is_file()
            except (OSError, ValueError, KeyError):
                pass
            if eligible:
                reusable.append(name)
        if status not in {"failed", "paused"}:
            continue
        if len(failed) >= MAX_FAILED_STAGES:
            continue
        cases, omitted_cases = [], 0
        if paths["junit"]:
            try:
                cases, omitted_cases = junit_failures(Path(paths["junit"]))
            except (OSError, ValueError, ET.ParseError) as exc:
                diagnostic_errors.append(excerpt(f"JUnit: {exc}", 512))
        failure = result.get("failure") or {}
        error = "\n".join(dict.fromkeys(str(e) for e in (record.get("error"), result.get("error"), failure.get("message")) if e)) or "Stage did not pass"
        failed.append({"stage": excerpt(name, 64), "status": status, "error": excerpt(error),
                       "failedTests": cases, "omittedFailedTests": omitted_cases,
                       "logTail": log_tail(Path(paths["logs"][0])) if paths["logs"] else "",
                       "evidence": paths, "diagnosticErrors": diagnostic_errors[:3]})
    invocations = value.get("invocations", [])
    wall = max(0, value.get("completedAt", now) - value.get("createdAt", now))
    active = sum(max(0, i.get("finishedAt", now) - i.get("startedAt", now)) for i in invocations)
    approval = not value.get("completed") and not value.get("published") and not all(
        records.get("acceptance-" + case, {}).get("status") == "passed" for case in ("A", "B"))
    argv = [value.get("python") or sys.executable, str(Path(__file__).resolve().parents[1] / "release.py"),
            "--repo", value["repo"], "resume", value["runId"]]
    error = value.get("lastError") or {}
    answer = {"schema": 1, "runId": value["runId"], "version": excerpt(value["version"], 128),
              "completed": bool(value.get("completed")), "status": run_status(value),
              "stages": stages, "failedStages": failed, "reusableStages": reusable,
              "reuseCondition": "Unchanged stage inputs and environment; resume revalidates evidence and artifacts.",
              "timing": {"wallSeconds": round(wall, 3), "scriptActiveSeconds": round(active, 3),
                         "outsideScriptSeconds": round(max(0, wall - active), 3)},
              "lastError": {"type": excerpt(error.get("type"), 128), "message": excerpt(error.get("message"))} if error else None,
              "publication": {"url": excerpt(records.get("publication", {}).get("result", {}).get("url"), 2048) or None},
              "resume": {"action": "resume", "runId": value["runId"],
                         "needed": not bool(value.get("completed")), "argv": argv if not value.get("completed") else None,
                         "requiresContainerCgroupApproval": approval,
                         "approvalFlag": "--approve-container-cgroup" if approval else None,
                         "correctiveFilesOption": "--files", "replacementEnvironmentOption": "--environment"},
              "paths": {"state": str(directory / "state.json"), "report": str(directory / "report.json"),
                        "logs": str(directory / "logs")},
              "omitted": {"stages": max(0, len(records) - MAX_STAGES),
                          "failedStages": max(0, failure_count - len(failed)), "details": False}}
    # Sanitize every returned string, including diagnostic paths; never copy
    # notes, argv from process receipts, candidate fingerprints or environments.
    def sanitize(item):
        if isinstance(item, str):
            return excerpt(item, 4096)
        if isinstance(item, list):
            return [sanitize(x) for x in item]
        if isinstance(item, dict):
            return {k: sanitize(v) for k, v in item.items()}
        return item
    answer = sanitize(answer)
    # Include pretty-print overhead in the wire-size ceiling. If paths or text
    # are pathological, retain stage/status/recovery and point to raw state.
    def size():
        return len(json.dumps(answer, ensure_ascii=False, indent=2).encode()) + 1
    if size() > MAX_SUMMARY_BYTES:
        answer["omitted"]["details"] = True
        for row in reversed(answer["failedStages"]):
            row["omittedFailedTests"] += len(row["failedTests"])
            row["failedTests"], row["logTail"] = [], ""
            if size() <= MAX_SUMMARY_BYTES:
                break
    if size() > MAX_SUMMARY_BYTES:
        for row in answer["failedStages"]:
            row["evidence"] = {"result": None, "junit": None, "logs": []}
    while size() > MAX_SUMMARY_BYTES and answer["failedStages"]:
        answer["failedStages"].pop()
        answer["omitted"]["failedStages"] += 1
    while size() > MAX_SUMMARY_BYTES and answer["stages"]:
        answer["stages"].pop()
        answer["omitted"]["stages"] += 1
    return answer
