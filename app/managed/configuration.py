"""Business config writes retain the existing validation/apply hooks and backups."""
from __future__ import annotations

import copy

from app.config import Config
from app.config_store import ConfigStore

BUSINESS_FIELDS = frozenset({
    "models", "memory", "agent", "userMessageTemplate", "contextManagement", "tools",
    "agents", "rath", "web", "ui", "media", "mcp", "browser", "webhooks", "logLevel",
})


def business_config(config: Config) -> dict:
    value = config.model_dump(by_alias=True)
    return {key: data for key, data in value.items() if key in BUSINESS_FIELDS}


def merge_patch(raw: dict, patch: dict):
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(raw.get(key), dict):
            merge_patch(raw[key], value)
        else:
            raw[key] = copy.deepcopy(value)


class ManagedConfigStore(ConfigStore):
    def __init__(self, path, config):
        super().__init__(path)
        self.initial = config

    def _write_atomic(self, raw):
        if "managed" in raw or raw.get("telegram"):
            raise ValueError("role and Telegram settings cannot be changed in managed mode")
        config = Config.model_validate(raw)
        a, b = self.initial, config
        if (a.storage.db_path, a.tools.skills_dir, a.mcp.install_dir, a.media.download_dir,
            a.web.enabled, a.web.host, a.web.port) != (
            b.storage.db_path, b.tools.skills_dir, b.mcp.install_dir, b.media.download_dir,
            b.web.enabled, b.web.host, b.web.port):
            raise ValueError("managed persistence roots and listener are immutable at runtime")
        super()._write_atomic(raw)
