#!/usr/bin/env python3
"""Read startup observations and probe the real service; always persist failures."""
from __future__ import annotations

import argparse
import json
import pathlib
import sqlite3
import time
import urllib.request

from heavy_upgrade import verify_heavy_history
from startup_audit import verify_audit


def probe(*, baseline, audit_path, pid, boot_number, version, port):
    result = {"ok": False, "errors": []}
    try:
        deadline = time.monotonic() + 60
        while True:
            rows = [json.loads(line) for line in audit_path.read_text().splitlines()] if audit_path.exists() else []
            if any(str(row.get("pid")) == str(pid) and row.get("event") in {"startupReturned", "startupFailed"} for row in rows):
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        latencies = []
        for _ in range(3):
            start = time.monotonic()
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
                body = json.load(response)
                if response.status != 200 or body != {"ok": True, "version": version}:
                    raise AssertionError(f"unexpected health response: {body}")
            latencies.append(time.monotonic() - start)
            time.sleep(0.1)
        result["health"] = {"samples": len(latencies), "maxSeconds": max(latencies), "timeoutSeconds": 2}
        with sqlite3.connect(f"file:{baseline['dbPath']}?mode=ro", uri=True) as con:
            result["history"] = verify_heavy_history(con, baseline["heavyHistory"])
        # Include deletes concurrent with HTTP/history probes, not only those before ready.
        rows = [json.loads(line) for line in audit_path.read_text().splitlines()] if audit_path.exists() else []
        result["startup"] = verify_audit(rows, pid, database=baseline["dbPath"])
        observed_boots = sum(row.get("event") == "observerInstalled" for row in rows)
        result["observedBoots"] = observed_boots
        if observed_boots != boot_number:
            result["errors"].append(f"unexpected process restart count: {observed_boots} != {boot_number}")
        if any(row.get("event") in {"frameDeleteAttempt", "startupFailed"} for row in rows):
            result["errors"].append("DELETE/startup failure in observed service boots")
        for key in ("startup", "history"):
            result["errors"].extend(result[key]["errors"])
    except Exception as exc:
        result["errors"].append(f"{type(exc).__name__}: {exc}")
    result["ok"] = not result["errors"]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=pathlib.Path, required=True)
    parser.add_argument("--audit", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--pid", required=True)
    parser.add_argument("--boot-number", type=int, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    result = probe(baseline=json.loads(args.baseline.read_text()), audit_path=args.audit,
                   pid=args.pid, boot_number=args.boot_number, version=args.version, port=args.port)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
