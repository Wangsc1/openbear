"""Process role and persistent managed identity; never business configuration.

Environment scrubbing reduces accidental disclosure, not same-UID isolation. A
child with Bash/file tools can access its own volume, including private files.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

MANAGEMENT_ENV = frozenset({
    "OPENBEAR_MANAGEMENT_KEY", "OPENBEAR_PASSWORD", "OPENBEAR_USERNAME",
    "OPENBEAR_INSTANCE_ID", "OPENBEAR_GATEWAY_KEY",
    # Accepted from older deployments and ignored; the controller pulls status.
    "OPENBEAR_REPORT_TOKEN", "OPENBEAR_CONTROLLER_URL",
})
# A local principal in the existing integer owner column, NOT a Telegram user.
LOCAL_OWNER_ID = 1


def sanitized_env(env=None) -> dict[str, str]:
    return {str(k): str(v) for k, v in (os.environ if env is None else env).items()
            if k not in MANAGEMENT_ENV}


def validate_origin(value: str) -> str:
    """An HTTP(S) root origin, e.g. the gateway's public address for push checks."""
    try:
        u = urlsplit(value)
        if (u.scheme not in {"http", "https"} or not u.hostname or u.username or u.password
                or u.query or u.fragment or u.path not in {"", "/"}
                or any(ord(c) <= 32 for c in value) or "\\" in value):
            raise ValueError
        _ = u.port
        authority_host = f"[{u.hostname}]" if ":" in u.hostname else u.hostname
        if (u.port == 0 or not re.fullmatch(re.escape(authority_host) + r"(?::[0-9]+)?", u.netloc, re.IGNORECASE)
                or "%" in u.hostname):
            raise ValueError
        try:
            ipaddress.ip_address(u.hostname)
        except ValueError:
            host = u.hostname.encode("idna").decode("ascii")
            labels = host.rstrip(".").split(".")
            if len(host) > 253 or any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in labels):
                raise ValueError
    except (ValueError, TypeError):
        raise ValueError("a valid HTTP(S) root origin is required") from None
    return value.rstrip("/")


def private_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        tmp.unlink(missing_ok=True)


class ManagedConfig(BaseModel):
    enabled: bool = False
    instance_id: str = ""
    management_key: str = Field(default="", repr=False, exclude=True)
    workspace_root: str = "/workspace"
    auth_mode: str = "local"
    gateway_key: str = Field(default="", repr=False, exclude=True)

    @classmethod
    def from_environment(cls):
        role = os.environ.get("OPENBEAR_INSTANCE_ROLE", "controller")
        if role != "managed":
            return cls()
        root = Path(os.environ.get("OPENBEAR_WORKSPACE", "/workspace")).expanduser()
        if not root.is_absolute() or root == Path("/"):
            raise ValueError("OPENBEAR_WORKSPACE must be an absolute dedicated directory")
        persisted = root / ".managed" / "identity.json"
        stored = json.loads(persisted.read_text()) if persisted.exists() else {}
        values = {}
        for name, env in (("instance_id", "OPENBEAR_INSTANCE_ID"), ("management_key", "OPENBEAR_MANAGEMENT_KEY")):
            supplied = os.environ.get(env, "")
            if supplied and stored.get(name) and supplied != stored[name]:
                raise ValueError("managed identity differs from persisted volume; explicit offline migration required")
            values[name] = supplied or stored.get(name, "")
        for name, env, default in (("auth_mode", "OPENBEAR_CHILD_AUTH", "local"),
                                   ("gateway_key", "OPENBEAR_GATEWAY_KEY", "")):
            supplied = os.environ.get(env)
            previous = stored.get(name, default)
            if stored and supplied is not None and supplied != previous:
                raise ValueError("managed authentication differs from persisted volume; explicit offline migration required")
            values[name] = previous if supplied is None else supplied
        return cls(enabled=True, workspace_root=str(root.resolve()), **values)

    def startup_errors(self) -> list[str]:
        if not self.enabled:
            return []
        errors = []
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", self.instance_id):
            errors.append("managed requires a valid OPENBEAR_INSTANCE_ID")
        if len(self.management_key) < 32 or any(ord(c) <= 32 or ord(c) >= 127 for c in self.management_key):
            errors.append("managed requires a strong management_key (at least 32 ASCII characters)")
        if self.auth_mode not in {"local", "gateway"}:
            errors.append("managed auth_mode must be local or gateway")
        if self.auth_mode == "gateway":
            if len(self.gateway_key) < 32 or any(ord(c) <= 32 or ord(c) >= 127 for c in self.gateway_key):
                errors.append("gateway mode requires a strong gateway_key (at least 32 ASCII characters)")
            if self.gateway_key == self.management_key:
                errors.append("gateway key must be independent of the management key")
        elif self.gateway_key:
            errors.append("local mode must not configure a gateway key")
        if self.auth_mode == "local" and not (Path(self.workspace_root) / ".managed" / "account.json").exists():
            if not os.environ.get("OPENBEAR_USERNAME", "").strip() or len(os.environ.get("OPENBEAR_PASSWORD", "")) < 12:
                errors.append("first managed startup requires OPENBEAR_USERNAME and a password of at least 12 characters")
        return errors

    def persist(self) -> bytes:
        errors = self.startup_errors()
        if errors:
            raise ValueError("; ".join(errors))
        root = Path(self.workspace_root)
        key_file = root / ".managed" / "identity.json"
        if key_file.exists():
            value = json.loads(key_file.read_text())
            if "auth_mode" not in value:
                value.update(auth_mode="local", gateway_key="")
                private_json(key_file, value)
        else:
            value = {name: getattr(self, name) for name in ("instance_id", "management_key", "auth_mode", "gateway_key")}
            value["webhook_pepper"] = secrets.token_hex(32)
            private_json(key_file, value)
        return bytes.fromhex(value["webhook_pepper"])


def persistent_paths(raw: dict, managed: ManagedConfig) -> dict:
    """Resolve configurable business storage roots inside the single volume."""
    root = Path(managed.workspace_root)
    for fixed in ("workspace", ".managed", "data", ".home"):
        candidate = (root / fixed).resolve()
        if not candidate.is_relative_to(root) or candidate == root:
            raise ValueError("managed persistence paths must remain inside workspace")
    for section, alias, field, suffix in (
        ("storage", "dbPath", "db_path", "data/openbear.db"),
        ("tools", "skillsDir", "skills_dir", "skills"),
        ("mcp", "installDir", "install_dir", "mcp-servers"),
        ("media", "downloadDir", "download_dir", "data/media/inbound"),
    ):
        obj = raw.setdefault(section, {})
        supplied = obj.get(alias, obj.get(field))
        expected = str(root / suffix)
        candidate = (root / str(supplied)).resolve() if supplied else Path(expected)
        if not candidate.is_relative_to(root) or candidate == root:
            raise ValueError("managed persistence paths must remain inside workspace")
        obj.pop(field, None)
        obj[alias] = str(candidate)
    return raw
