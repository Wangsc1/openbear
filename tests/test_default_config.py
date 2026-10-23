"""Default configuration stays usable without adding new keys to user files."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from app.admin.settings import parse_setting_value, safe_settings_payload
from app.config_store import ConfigStore
from app.settings.specs import SPECS

ROOT = Path(__file__).resolve().parents[1]


def _raw_config(minimal=False):
    raw = json.loads((ROOT / "openbear.json.example").read_text())
    if minimal:
        raw = {key: raw[key] for key in ("telegram", "models")}
        raw["memory"] = {}
    return raw


def _store(tmp_path, raw):
    path = tmp_path / "openbear.json"
    path.write_text(json.dumps(raw, ensure_ascii=False))
    return ConfigStore(path)


@pytest.mark.parametrize("minimal", [False, True], ids=["public-example", "required-fields-only"])
async def test_defaults_load_without_materializing_new_keys(tmp_path, minimal):
    store = _store(tmp_path, _raw_config(minimal))
    original = store.path.read_bytes()
    config = await store.load_config()

    assert not config.validate_for_startup()
    assert config.agent.naming_max_retries == 3 and config.agent.naming_timeout_s == 30.0
    assert config.memory.provider == "builtin"
    assert not config.mcp.enabled and not config.browser.enabled
    assert store.path.read_bytes() == original and store.revision == 0

    payload = safe_settings_payload(config.model_dump(by_alias=True))
    assert payload["values"]["agent.namingMaxRetries"] == 3
    assert payload["values"]["agent.namingTimeoutS"] == 30.0
    for path in SPECS:
        parse_setting_value(path, payload["values"][path])


async def test_saving_one_new_default_does_not_freeze_other_defaults(tmp_path):
    original = _raw_config(minimal=True)
    store = _store(tmp_path, original)
    config = await store.update_path("agent.namingMaxRetries", 5)
    expected = copy.deepcopy(original)
    expected["agent"] = {"namingMaxRetries": 5}
    assert json.loads(store.path.read_text()) == expected
    assert config.agent.naming_timeout_s == 30.0 and config.agent.naming_max_turns == 8

    await store.update_path("ui.showTurnStats", False)
    expected["ui"] = {"showTurnStats": False}
    assert json.loads(store.path.read_text()) == expected
    reloaded = await store.load_config()
    assert reloaded.agent.naming_max_retries == 5
    assert not reloaded.ui.show_turn_stats


async def test_removed_progress_reminder_key_still_loads(tmp_path):
    raw = _raw_config(minimal=True)
    raw["agent"] = {"progressReminder": {"enabled": False, "minutes": 2}, "namingMaxRetries": 4}
    store = _store(tmp_path, raw)
    original = store.path.read_bytes()
    config = await store.load_config()
    assert config.agent.naming_max_retries == 4 and not hasattr(config.agent, "progress_reminder")
    assert store.path.read_bytes() == original
