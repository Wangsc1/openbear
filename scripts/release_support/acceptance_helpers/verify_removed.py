#!/usr/bin/env python3
"""Verify managed non-web files present only in the old ZIP are absent after upgrade."""
import argparse
import json
import pathlib
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=pathlib.Path, required=True)
parser.add_argument("--old", type=pathlib.Path, required=True)
parser.add_argument("--new", type=pathlib.Path, required=True)
parser.add_argument("--output", type=pathlib.Path, required=True)
args = parser.parse_args()
managed_prefixes = ("app/", "prompts/", "scripts/")
ignored_parts = {"__pycache__"}


def members(path):
    with zipfile.ZipFile(path) as archive:
        return {
            name.rstrip("/")
            for name in archive.namelist()
            if not name.endswith("/")
            and name.startswith(managed_prefixes)
            and not any(part in ignored_parts for part in pathlib.PurePosixPath(name).parts)
            and not name.endswith((".pyc", ".pyo"))
        }

old_only = sorted(members(args.old) - members(args.new))
remaining = [name for name in old_only if (args.root / name).exists() or (args.root / name).is_symlink()]
report = {"managedOldOnly": old_only, "checked": len(old_only), "remaining": remaining, "ok": not remaining}
args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
raise SystemExit(0 if not remaining else 1)
