from __future__ import annotations

from types import SimpleNamespace

from app.config import Config
from app.services import Services


async def test_services_initial_and_hot_updated_context_share_current_template(tmp_path, monkeypatch):
    # Only construct in an isolated directory; never start DB, workers or network services.
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OPENBEAR_CONFIG", str(tmp_path / "config.json"))
    config = Config.model_validate({
        "telegram": {"botToken": "test-token", "whitelistIds": [1]},
        "models": {"providers": {}, "primary": "test/model"},
        "memory": {},
        "storage": {"dbPath": str(tmp_path / "test.db")},
        "userMessageTemplate": {"template": "initial [[ folderWorkspaceDir ]]"},
    })
    services = Services(config, SimpleNamespace())
    monkeypatch.setattr(services, "_schedule_browser_validation", lambda: None)
    try:
        initial_context = services.context
        assert initial_context._user_message_template is config.user_message_template
        initial_message = initial_context.wrap_user("hello")
        assert initial_message["content"] == f"hello\n\ninitial {tmp_path / 'workspace'}"

        for settings, expected in (
            ({"enabled": False}, "hello"),
            ({"template": "changed [[ message.source ]]"}, "hello\n\nchanged web"),
            ({"template": ""}, "hello"),
        ):
            updated = Config.model_validate({**config.model_dump(by_alias=True), "userMessageTemplate": settings})
            services.apply_config(updated)
            assert services.context._user_message_template is updated.user_message_template
            assert services.context.wrap_user("hello")["content"] == expected
            assert services.context is not initial_context
        # Existing messages and a running turn's old builder keep their original snapshot.
        assert initial_context.wrap_user("hello") == initial_message
        assert not (tmp_path / "test.db").exists()
        assert not (tmp_path / "config.json").exists()
    finally:
        await services.browser.close()
        await services.mcp.close()
        await services.http.close()
        await services.mem.close()
