"""One local owner, scrypt password verifier, existing revocable host-only sessions."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from pathlib import Path

from app.managed.settings import private_json


def password_hash(password: str, salt: str) -> str:
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=32768, r=8, p=1,
                          maxmem=64 * 1024 * 1024, dklen=32).hex()


class LocalAccount:
    def __init__(self, root: str):
        self.path = Path(root) / ".managed" / "account.json"
        if not self.path.exists():
            username = os.environ.get("OPENBEAR_USERNAME", "").strip()
            password = os.environ.get("OPENBEAR_PASSWORD", "")
            self._validate(username, password)
            salt = secrets.token_hex(16)
            private_json(self.path, {"username": username, "salt": salt,
                                     "hash": password_hash(password, salt), "algorithm": "scrypt-v1"})
        self.value = json.loads(self.path.read_text())
        if self.value.get("algorithm") != "scrypt-v1":
            raise ValueError("unsupported managed password verifier")
        # Seeds are only used on first creation and never retained in child env.
        os.environ.pop("OPENBEAR_USERNAME", None)
        os.environ.pop("OPENBEAR_PASSWORD", None)

    @staticmethod
    def _validate(username: str, password: str):
        if not 1 <= len(username) <= 128 or any(ord(c) < 32 for c in username):
            raise ValueError("username must be 1..128 printable characters")
        if not 12 <= len(password) <= 1024:
            raise ValueError("password must be 12..1024 characters")

    def verify(self, username: str, password: str) -> bool:
        if len(password) > 1024 or len(username) > 128:
            return False
        derived = password_hash(password, self.value["salt"])
        return hmac.compare_digest(derived, self.value["hash"]) & hmac.compare_digest(
            username.encode(), self.value["username"].encode())

    def change(self, username: str, password: str):
        self._validate(username, password)
        salt = secrets.token_hex(16)
        value = {"username": username, "salt": salt, "hash": password_hash(password, salt), "algorithm": "scrypt-v1"}
        private_json(self.path, value)
        self.value = value
