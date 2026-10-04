"""Error-triggered media recovery and stable subsequent request prefixes."""

from __future__ import annotations

import base64
import copy
import json
from pathlib import Path

import pytest

from app.agent.loop import Agent
from app.agent.native_continuation import serialize_messages, validate_model_context
from app.agents.execution import AgentExecutor
from app.context.media_recovery import reference_historical_media
from app.context.window import WindowPolicy, mark_source, neutral_context, source_of
from app.db.dao import MessageDAO
from app.llm.anthropic import AnthropicBackend
from app.llm.error_classify import CONTEXT_OVERFLOW, RATE_LIMIT, classify_error
from app.llm.error_payloads import read_error
from app.llm.events import StreamEvent, ToolCall
from app.llm.openai_chat import OpenAIChatBackend
from app.llm.openai_responses import OpenAIResponsesBackend
from app.tools.base import ToolRegistry
from tests.test_agent_loop import RecordRenderer
from tests.test_agent_window_runtime import env as agent_fixture
from tests.test_context_strategies import env as env
from tests.test_context_window import batch, human

agent_env = agent_fixture
ERROR = {
    "type": "error",
    "error": {"message": "upstream rejected request: message too big", "code": "message_too_big"},
}


def image(tmp_path, name, size=8000):
    path = tmp_path / name
    path.write_bytes(b"x" * size)
    return {"type": "image", "path": str(path), "mime_type": "image/png", "name": name}


def attachment(tmp_path, index, *, size=8000, count=1, browser=False):
    return mark_source(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": f"Original attachment request {index}"},
                *[image(tmp_path, f"{index}-{i}.png", size) for i in range(count)],
            ],
        },
        kind="execution" if browser else "human",
        source_id=f"attachment-{index}",
        **({"tool_name": "Browser"} if browser else {}),
    )


def count_images(messages):
    return sum(
        b.get("type") == "image"
        for m in messages
        if isinstance(m.get("content"), list)
        for b in m["content"]
    )


def opaque_assistant():
    return mark_source(
        {
            "role": "assistant",
            "content": "Noted",
            "reasoning": "original reasoning",
            "signature": "original signature",
            "native_output_items": [
                {"type": "reasoning", "id": "rs-old", "encrypted_content": "DO_NOT_REWRITE_BASE64"},
                {
                    "type": "message",
                    "id": "msg-old",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Noted"}],
                },
            ],
        },
        kind="execution",
        source_id="native-old",
    )


@pytest.mark.parametrize("protocol", ["chat", "responses", "anthropic"])
@pytest.mark.parametrize("strategy", ["sliding_window", "model_summary"])
async def test_normal_large_requests_never_rewrite_images_or_emit_compaction(
    env, tmp_path, protocol, strategy
):
    env.selected["strategy"] = strategy
    cls = {
        "chat": OpenAIChatBackend,
        "responses": OpenAIResponsesBackend,
        "anthropic": AnthropicBackend,
    }[protocol]
    env.manager.backend = cls(None, "http://not-called.invalid", "test")
    env.manager.policy = WindowPolicy(128000, trigger_tokens=100000)
    messages = [human(), *[attachment(tmp_path, i, size=4_000_000, browser=True) for i in range(3)]]
    original = copy.deepcopy(messages)
    result = await env.manager.prepare(messages, system="", tools=[])
    version = env.manager.window_version
    assert result == original and env.manager.last_estimate.request_bytes > 12 * 1024 * 1024
    for _ in range(2):
        result = await env.manager.prepare(result, system="", tools=[])
        assert result == original and env.manager.window_version == version
    result = await env.manager.prepare(result + [attachment(tmp_path, 4)], system="", tools=[])
    assert result[:-1] == original and count_images(result) == 4
    assert env.events == [] and env.calls == []
    assert not list((tmp_path / "tool_artifacts").rglob("*"))


@pytest.mark.parametrize("strategy", ["sliding_window", "model_summary"])
async def test_recovery_references_all_old_batches_preserves_latest_native_and_history(
    env, tmp_path, strategy
):
    env.selected["strategy"] = strategy
    env.manager.backend = OpenAIResponsesBackend(None, "http://not-called.invalid", "test")
    env.manager.policy = WindowPolicy(128000, trigger_tokens=100000)
    messages = [
        human("Keep the exact task."),
        attachment(tmp_path, 1),
        opaque_assistant(),
        *batch(1),
        attachment(tmp_path, 2, browser=True),
        attachment(tmp_path, 3, count=2),
    ]
    messages = await env.manager.prepare(messages, system="", tools=[])
    original = copy.deepcopy(messages)
    env.manager.media_overflow = True
    result = await env.manager.prepare(messages, system="", tools=[])
    version = env.manager.window_version
    assert messages == original and len(result) == len(original)
    assert count_images(result) == 2 and result[-1] == original[-1]
    assert result[2] == original[2] and validate_model_context(result)
    assert source_of(result[1])["kind"] == "human"
    assert result[1]["content"][0] == original[1]["content"][0]
    assert "local file:" in result[1]["content"][1]["text"]
    assert env.events == [] and env.calls == []
    for index in (1, 2):
        event = await env.store.event_payload(f"attachment-{index}")
        assert event["payload"]["content"][1]["type"] == "image"
    assert await env.store.restore_messages() == neutral_context(result)
    payload = env.manager.backend.build_payload(
        result, model="test", system=env.manager.system, tools=[], native_continuation=True
    )
    for _ in range(3):
        again = await env.manager.prepare(result, system="", tools=[])
        assert again == result and env.manager.window_version == version
        assert (
            env.manager.backend.build_payload(
                again, model="test", system=env.manager.system, tools=[], native_continuation=True
            )
            == payload
        )
    next_messages = result + [attachment(tmp_path, 4)]
    assert await env.manager.prepare(next_messages, system="", tools=[]) == next_messages
    assert count_images(next_messages) == 3
    assert (tmp_path / "1-0.png").read_bytes() == b"x" * 8000


def test_inline_attachment_formats_saved_once_and_never_scan_reasoning_or_text(tmp_path):
    raw = base64.b64encode(b"original binary media").decode()
    blocks = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": raw}},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + raw}},
        {
            "type": "input_file",
            "filename": "source.pdf",
            "file_data": "data:application/pdf;base64," + raw,
        },
        {"type": "input_audio", "input_audio": {"format": "mp3", "data": raw}},
    ]
    messages = [
        mark_source(
            {"role": "user", "content": [{"type": "text", "text": raw}, *blocks]},
            kind="human",
            source_id="old",
        ),
        opaque_assistant(),
        attachment(tmp_path, "latest", count=2),
    ]
    original = copy.deepcopy(messages)
    result, count = reference_historical_media(messages, artifact_dir=tmp_path / "saved")
    assert count == 4 and messages == original
    assert result[0]["content"][0] == original[0]["content"][0]
    assert result[1:] == original[1:]
    assert len(list((tmp_path / "saved").iterdir())) == 3
    assert all(p.read_bytes() == b"original binary media" for p in (tmp_path / "saved").iterdir())
    assert reference_historical_media(result, artifact_dir=tmp_path / "saved") == (result, 0)
    assert reference_historical_media(messages, artifact_dir=tmp_path / "saved") == (result, 4)


def test_missing_file_and_last_batch_are_not_replaced_with_invented_paths(tmp_path):
    old = mark_source(
        {"role": "user", "content": [{"type": "image", "path": str(tmp_path / "missing.png")}]},
        kind="human",
        source_id="missing",
    )
    messages = [old, attachment(tmp_path, "latest", count=2)]
    assert reference_historical_media(messages, artifact_dir=tmp_path / "saved") == (messages, 0)
    assert not (tmp_path / "saved").exists()


@pytest.mark.parametrize("status", [0, 400, 413])
def test_size_error_reaches_recovery_but_not_rate_limit(status):
    assert classify_error(ERROR["error"]["message"], status) == CONTEXT_OVERFLOW
    assert classify_error("message_too_big; tokens per minute limit", 429) == RATE_LIMIT
    event = read_error(
        {
            **ERROR,
            "error": {
                **ERROR["error"],
                "details": {"root_cause": {"classification": "format", "status": status or 400}},
            },
        }
    )
    assert event.reason == CONTEXT_OVERFLOW and not event.retryable


async def test_controller_persists_native_before_retry_and_does_not_replay_tools(env, tmp_path):
    requests = []
    checkpoints = []
    effects = []
    dao = MessageDAO(env.db)
    await env.db.conn.execute("INSERT INTO sessions(chat_id,session_uuid) VALUES(7,'session')")
    await env.db.conn.commit()
    identity = dict(
        conversation_uuid="conversation",
        session_id="session",
        protocol="responses",
        model="test",
        model_label="p/test",
    )

    class Persister:
        async def save_native_context(self, *, messages):
            checkpoints.append(copy.deepcopy(messages))
            await dao.save_controller_model_context(
                7, **identity, state={"version": 1, "messages": serialize_messages(messages)}
            )

        async def save_assistant(self, **kwargs):
            pass

        async def save_tool_result(self, *args, **kwargs):
            pass

    class Backend(OpenAIResponsesBackend):
        async def stream(self, messages, **options):
            requests.append(copy.deepcopy(messages))
            if len(requests) == 1:
                yield read_error(ERROR).stream_event()
            elif len(requests) == 2:
                stored = await dao.load_controller_model_context(7, **identity)
                assert stored is not None, (
                    "Native checkpoint must match the actual retry window revision"
                )
                assert count_images(stored["messages"]) == 2
                assert checkpoints and count_images(checkpoints[-1]) == 2
                assert any(
                    m.get("native_output_items") == opaque_assistant()["native_output_items"]
                    for m in checkpoints[-1]
                )
                yield StreamEvent(kind="tool_call", tool_calls=[ToolCall("once", "Probe", "{}")])
                yield StreamEvent(kind="finish", finish_reason="tool_calls")
            else:
                yield StreamEvent(kind="content", text="Recovered")
                yield StreamEvent(kind="finish", finish_reason="stop")

    backend = Backend(None, "http://not-called.invalid", "test")
    env.manager.backend = backend
    env.manager.policy = WindowPolicy(128000, trigger_tokens=100000)
    tools = ToolRegistry()

    async def probe(_):
        effects.append("once")
        return "done"

    tools.add("Probe", "single effect", {"type": "object"}, probe)
    messages = [
        human(),
        attachment(tmp_path, 1),
        opaque_assistant(),
        attachment(tmp_path, 2, count=2),
    ]
    result = await Agent(backend, tools).run(
        messages,
        RecordRenderer(),
        model="test",
        system="",
        window_runtime=env.manager,
        max_tokens=1024,
        persister=Persister(),
    )
    assert result.text == "Recovered" and len(requests) == 3 and effects == ["once"]
    assert count_images(requests[0]) == 3 and count_images(requests[1]) == 2
    assert requests[2][: len(requests[1])] == requests[1]
    assert env.events == []


@pytest.mark.parametrize("old_media", [False, True])
async def test_controller_rejects_unrecoverable_size_once_without_text_compression(
    env, tmp_path, old_media
):
    calls = []

    class Backend(OpenAIResponsesBackend):
        async def stream(self, messages, **options):
            calls.append(copy.deepcopy(messages))
            yield read_error(ERROR).stream_event()

    backend = Backend(None, "http://not-called.invalid", "test")
    env.manager.backend = backend
    env.manager.policy = WindowPolicy(128000, trigger_tokens=100000)
    messages = [
        human("Never discard this task."),
        *([attachment(tmp_path, 1)] if old_media else []),
        attachment(tmp_path, 2, count=2),
    ]
    renderer = RecordRenderer()
    result = await Agent(backend, ToolRegistry()).run(
        messages,
        renderer,
        model="test",
        system="",
        window_runtime=env.manager,
        max_tokens=1024,
    )
    assert len(calls) == (2 if old_media else 1)
    assert result.model_fail and env.events == [] and env.calls == []
    assert "message too big" in renderer.failed and "最新一批附件" in renderer.failed
    assert "正在压缩" not in renderer.failed
    assert count_images(calls[-1]) == 2 and "Never discard this task." in str(calls[-1])


@pytest.mark.parametrize("reject_again", [False, True])
async def test_independent_agent_recovery_is_once_per_failed_request(
    agent_env, tmp_path, monkeypatch, reject_again
):
    _, dao, task_id, agent = agent_env
    requests = []

    class Backend(OpenAIResponsesBackend):
        async def stream(self, messages, **options):
            requests.append(copy.deepcopy(messages))
            if len(requests) == 1 or reject_again:
                yield read_error(ERROR).stream_event()
            else:
                checkpoint = await dao.task_model_context(task_id)
                assert count_images(checkpoint["state"]["messages"]) == 2
                yield StreamEvent(kind="content", text="Recovered")
                yield StreamEvent(kind="finish", finish_reason="stop")

    runner = AgentExecutor(
        dao,
        task_id,
        agent=agent,
        backend=Backend(None, "http://not-called.invalid", "test"),
        model="test",
        max_tokens=1024,
        tools=ToolRegistry(),
        context_window=128000,
        rollover_trigger_tokens=100000,
    )

    async def original_context():
        return [
            human(),
            attachment(tmp_path, 1),
            opaque_assistant(),
            attachment(tmp_path, 2, count=2),
        ]

    monkeypatch.setattr(runner, "_round_context_messages", original_context)
    result = await runner.run()
    assert len(requests) == 2 and count_images(requests[0]) == 3 and count_images(requests[1]) == 2
    assert any(
        m.get("native_output_items") == opaque_assistant()["native_output_items"]
        for m in requests[1]
    )
    if reject_again:
        assert result["status"] == "needs_openbear_control"
        assert result["detail"]["reason"] == "agent_media_payload_too_large"
    else:
        assert result["summary"] == "Recovered"
