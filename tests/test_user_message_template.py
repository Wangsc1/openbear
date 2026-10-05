from __future__ import annotations

import copy
from datetime import UTC, datetime

import pytest

from app.config import UserMessageTemplateConfig
from app.context import user_message_template as templates
from app.context.user_message_template import (
    DEFAULT_USER_MESSAGE_TEMPLATE,
    USER_MESSAGE_TEMPLATE_VARIABLES,
    append_user_message_suffix,
    build_message_variables,
    render_user_message_suffix,
    validate_user_message_template,
)
from app.memory.builtin import TemplateEngine

AT = datetime(2026, 10, 5, 17, 23, 1, tzinfo=UTC)


def test_variable_contract_and_timezone(monkeypatch):
    monkeypatch.setattr(templates.platform, "node", lambda: "test-host")
    monkeypatch.setattr(templates.platform, "system", lambda: "TestOS")
    attachments = [{"name": "a.png", "type": "image", "metadata": {"size": 10}}]
    conversation = {"id": "c1", "title": "测试", "folderPath": "projects/demo", "credentials": "not exported"}
    variables = build_message_variables(
        at=AT, source="webhook", message_id="m1", sent_at=datetime(2026, 10, 6, 1, 20),
        conversation=conversation, model="test/model", workspace="/work", attachments=attachments,
    )
    assert variables == {
        "time": {
            "now": "2026-10-06 01:23:01", "iso": "2026-10-06T01:23:01+08:00",
            "date": "2026-10-06", "clock": "01:23:01", "weekday": "Tuesday",
            "timezone": "Asia/Shanghai", "utcOffset": "+08:00", "timestamp": AT.timestamp(),
        },
        "message": {
            "id": "m1", "source": "webhook", "sentAt": "2026-10-06T01:20:00+08:00",
            "attachmentCount": 1, "attachments": attachments,
        },
        "conversation": {"id": "c1", "title": "测试", "folderPath": "projects/demo"},
        "runtimeInfo": {"model": "test/model", "host": "test-host", "os": "TestOS"},
        "folderWorkspaceDir": "/work",
    }
    variables["message"]["attachments"][0]["metadata"]["size"] = 999
    assert attachments[0]["metadata"]["size"] == 10
    assert "credentials" not in variables["conversation"]
    assert set(variables) == {"time", "message", "conversation", "runtimeInfo", "folderWorkspaceDir"}
    for path in USER_MESSAGE_TEMPLATE_VARIABLES:
        rendered = render_user_message_suffix({"template": f"[[ {path} ]]"}, variables)
        assert "ERROR" not in rendered


def test_one_clock_read_and_pure_retry_rendering(monkeypatch):
    class Clock(datetime):
        calls = 0

        @classmethod
        def now(cls, tz=None):
            cls.calls += 1
            return AT.astimezone(tz)

    monkeypatch.setattr(templates, "datetime", Clock)
    variables = build_message_variables()
    assert Clock.calls == 1
    assert variables["message"]["sentAt"] == variables["time"]["iso"]
    before = copy.deepcopy(variables)
    for _ in range(3):
        assert render_user_message_suffix(None, variables) == "[⏰ 当前时间: 2026-10-06 01:23:01 (Tuesday)]"
    assert Clock.calls == 1
    assert variables == before


def test_naive_datetime_is_beijing_and_datetime_types_are_explicit():
    variables = build_message_variables(at=datetime(2026, 10, 6, 1, 23, 1))
    assert variables["time"]["timestamp"] == AT.timestamp()
    assert variables["message"]["source"] == "web"
    assert variables["message"]["attachments"] == []
    with pytest.raises(TypeError, match="datetime"):
        build_message_variables(at="2026-10-06")
    with pytest.raises(TypeError, match="datetime"):
        build_message_variables(sent_at=0)


def test_existing_engine_syntax_and_no_python_format():
    template = """{literal JSON: true}
@if message.attachmentCount > 0 && conversation.title
[[ conversation.title ]] / [[ runtimeInfo.model || 'unknown' ]]
@each attachment in message.attachments
[[ attachment.name ]] ([[ message.attachments.length ]])
@endeach
@else
no attachments
@endif
@raw
[[ unknown.literal ]] {unchanged}
@endraw
[[ helpers.join(['a', 'b'], ',') ]] [[ ', '.join(['x', 'y']) ]]
"""
    variables = build_message_variables(at=AT, conversation={"title": "Hello"}, attachments=[{"name": "one.png"}])
    actual = render_user_message_suffix({"template": template}, variables)
    assert actual == TemplateEngine().render(template, variables).strip()
    assert actual == "{literal JSON: true}\nHello / unknown\none.png (1)\n[[ unknown.literal ]] {unchanged}\na,b x, y"
    assert render_user_message_suffix({"template": "{time.now}"}, variables) == "{time.now}"


@pytest.mark.parametrize("template", [
    "[[ unknown ]]", "[[ tools.allowlist ]]", "[[ credentials ]]", "[[ time.missing ]]",
    "[[ runtimeInfo.secret ]]", "[[ conversation['missing'] ]]", "[[ time[message.id] ]]",
    "[[ time.now.typo ]]", "[[ message.attachments.typo ]]", "[[ helpers.typo ]]",
    "[[ message.__class__ ]]", "[[ __import__('os') ]]", "[[ (lambda: 1)() ]]",
    "[[ time.now + ]]", "[[ ]]", "[[ time.now", "time.now ]]",
    "@if time.now\nx", "@else\nx", "@endif", "@endeach", "@endraw",
    "@if time.now\n@else\n@else\n@endif", "@each item message.attachments\n@endeach",
    "@each item in message.attachments\n@endif", "@raw\nx", "@if ",
    "@if False\n[[ missing ]]\n@endif",  # Even inactive branches are validated.
    "@each item in message.attachments\n[[ unknown ]]\n@endeach",
    "@each item in message.attachments\n[[ item.name ]]\n@endeach\n[[ item.name ]]",
    "@each time in message.attachments\n@endeach",
])
def test_validation_rejects_syntax_and_unsupported_variables(template):
    with pytest.raises(ValueError):
        validate_user_message_template(template)


@pytest.mark.parametrize("template", ["", " \n\t", "@if False\nno\n@endif"])
def test_blank_template_or_empty_render_has_no_suffix(template):
    assert render_user_message_suffix({"template": template}, build_message_variables(at=AT)) == ""


def test_disabled_settings_never_render_or_validate():
    assert render_user_message_suffix({"enabled": False, "template": "[[ invalid ]]"}, {}) == ""
    assert render_user_message_suffix(UserMessageTemplateConfig(enabled=False), {}) == ""
    assert UserMessageTemplateConfig().template == DEFAULT_USER_MESSAGE_TEMPLATE


def test_render_errors_are_errors_not_model_visible_placeholders():
    with pytest.raises(ValueError, match="渲染失败"):
        render_user_message_suffix({"template": "[[ 1 / 0 ]]"}, build_message_variables(at=AT))


@pytest.mark.parametrize(("content", "suffix", "expected"), [
    ("hello", "tail", "hello\n\ntail"), ("hello", "", "hello"), ("", "tail", "tail"),
    ("", "", ""), ([], "tail", [{"type": "text", "text": "tail"}]), ([], "", []),
    ([{"type": "text", "text": "hello"}], "tail", [{"type": "text", "text": "hello\n\ntail"}]),
    ([{"type": "text", "text": ""}], "tail", [{"type": "text", "text": "tail"}]),
])
def test_append_content_types(content, suffix, expected):
    before = copy.deepcopy(content)
    actual = append_user_message_suffix(content, suffix)
    assert actual == expected
    assert content == before
    if isinstance(content, list):
        assert actual is not content


@pytest.mark.parametrize("suffix", ["", "tail"])
def test_append_multimodal_clones_nested_blocks_and_preserves_order(suffix):
    content = [
        {"type": "text", "text": "hello"},
        {"type": "image", "source": {"type": "base64", "data": "image-data"}},
        {"type": "audio", "source": {"data": "audio-data"}},
    ]
    before = copy.deepcopy(content)
    actual = append_user_message_suffix(content, suffix)
    assert actual[:3] == content
    if suffix:
        assert actual[3:] == [{"type": "text", "text": suffix}]
    else:
        assert len(actual) == 3
    actual[1]["source"]["data"] = "changed"
    assert content == before
