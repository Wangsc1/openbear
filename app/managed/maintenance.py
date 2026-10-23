"""Explicit OFFLINE maintenance; JSON credentials on stdin, never argv/output.

The caller must stop the managed container and mount its same volume into this
same image. The live runtime's kernel lock refuses concurrent maintenance.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

from app.managed.account import LocalAccount
from app.managed.persistence import WorkspaceLock
from app.managed.settings import ManagedConfig, private_json


def _revoke_sessions(root: Path, config_path: Path | None):
    source = (config_path or root / "openbear.json").resolve()
    if not source.is_relative_to(root):
        raise ValueError("config must be inside workspace")
    raw = json.loads(source.read_text())
    storage = raw.get("storage", {})
    db = (root / storage.get("dbPath", storage.get("db_path", "data/openbear.db"))).resolve()
    if not db.is_relative_to(root) or not db.is_file():
        raise ValueError("invalid managed database path")
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE web_sessions SET revoked_at=? WHERE revoked_at=0", (int(time.time()),))


def maintain(root: Path, action: str, data: dict, *, config_path: Path | None = None):
    root = root.resolve(strict=True)
    if root == Path("/") or not isinstance(data, dict):
        raise ValueError("invalid maintenance input")
    with WorkspaceLock(root):
        identity_path = root / ".managed" / "identity.json"
        identity = json.loads(identity_path.read_text())
        identity.setdefault("auth_mode", "local")
        identity.setdefault("gateway_key", "")
        if action in {"rotate-identity", "set-auth"}:
            allowed = ({"authMode": "auth_mode", "gatewayKey": "gateway_key"} if action == "set-auth" else
                       {"managementKey": "management_key", "gatewayKey": "gateway_key"})
            if not data or set(data) - set(allowed) or any(not isinstance(v, str) for v in data.values()):
                raise ValueError("invalid rotation fields")
            candidate = dict(identity)
            candidate.update({allowed[k]: v for k, v in data.items()})
            if action == "set-auth":
                if data.get("authMode") not in {"local", "gateway"}:
                    raise ValueError("authMode required")
                if data["authMode"] == "local":
                    if data.get("gatewayKey") or not (root / ".managed/account.json").is_file():
                        raise ValueError("local recovery requires an existing local account and no gateway key")
                    candidate["gateway_key"] = ""
                    LocalAccount(str(root))
            config = ManagedConfig(enabled=True, workspace_root=str(root), **{k: candidate[k] for k in
                ("instance_id", "management_key", "auth_mode", "gateway_key")})
            if config.startup_errors():
                raise ValueError("invalid managed identity")
            if action == "set-auth":
                _revoke_sessions(root, config_path)
            private_json(identity_path, candidate)
        elif action == "reset-account":
            if identity["auth_mode"] != "local":
                raise ValueError("gateway accounts are maintained at the gateway")
            if set(data) != {"username", "password"} or any(not isinstance(v, str) for v in data.values()):
                raise ValueError("username and password required")
            LocalAccount._validate(data["username"], data["password"])
            # Revoke first so a subsequent file error cannot preserve old access.
            _revoke_sessions(root, config_path)
            LocalAccount(str(root)).change(data["username"], data["password"])
        else:
            raise ValueError("unknown maintenance action")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", default="/workspace")
    parser.add_argument("--config", type=Path, help="optional config path inside the workspace")
    parser.add_argument("action", choices=["rotate-identity", "reset-account", "set-auth"])
    args = parser.parse_args()
    try:
        text = sys.stdin.read(65537)
        if len(text) > 65536:
            raise ValueError("input too large")
        maintain(Path(args.workspace), args.action, json.loads(text), config_path=args.config)
    except Exception:
        print("managed maintenance rejected; check input, volume and stopped runtime", file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps({"ok": True, "action": args.action}))


if __name__ == "__main__":
    main()
