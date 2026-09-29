"""Claude-native thinking preservation across response, tool continuation and sender."""
from __future__ import annotations

import json

import httpx
import pytest

from app.agent.native_continuation import native_items_for_tool_calls, validate_model_context
from app.llm.anthropic import AnthropicBackend, _to_anthropic
from app.llm.base import aggregate
from app.llm.events import ToolCall
from tests.conftest import make_client, sse_response


THINKING = {"type": "thinking", "thinking": "", "signature": "SIG-one", "future": {"x": [1, 2]}}
REDACTED = {"type": "redacted_thinking", "data": "opaque-data", "future": "keep"}
SECOND = {"type": "thinking", "thinking": "second", "signature": "SIG-two", "other": 42}


def _event(name, **data):
    return [f"event: {name}", f"data: {json.dumps({'type': name, **data})}", ""]


def _stream_lines():
    lines = _event("content_block_start", index=0, content_block={
        "type": "thinking", "thinking": "", "signature": "", "future": THINKING["future"],
    })
    lines += _event("content_block_delta", index=0, delta={"type": "signature_delta", "signature": "SIG-"})
    lines += _event("content_block_delta", index=0, delta={"type": "signature_delta", "signature": "one"})
    lines += _event("content_block_stop", index=0)
    lines += _event("content_block_start", index=1, content_block=REDACTED)
    lines += _event("content_block_stop", index=1)
    lines += _event("content_block_start", index=2, content_block={
        "type": "thinking", "thinking": "", "signature": "", "other": 42,
    })
    lines += _event("content_block_delta", index=2, delta={"type": "thinking_delta", "thinking": "sec"})
    lines += _event("content_block_delta", index=2, delta={"type": "thinking_delta", "thinking": "ond"})
    lines += _event("content_block_delta", index=2, delta={"type": "signature_delta", "signature": "SIG-two"})
    lines += _event("content_block_stop", index=2)
    lines += _event("content_block_start", index=3, content_block={"type": "text", "text": ""})
    lines += _event("content_block_delta", index=3, delta={"type": "text_delta", "text": "answer"})
    lines += _event("content_block_stop", index=3)
    lines += _event("content_block_start", index=4, content_block={"type": "tool_use", "id": "t1", "name": "Read"})
    lines += _event("content_block_delta", index=4, delta={"type": "input_json_delta", "partial_json": '{"path":"x"}'})
    lines += _event("content_block_stop", index=4)
    lines += _event("message_delta", delta={"stop_reason": "tool_use"}, usage={"output_tokens": 1})
    return lines


@pytest.mark.parametrize("stream", [True, False])
async def test_native_thinking_mock_transport_capture_and_replay(stream):
    recorded = []
    def handler(req):
        payload = json.loads(req.content)
        recorded.append(payload)
        if len(recorded) == 1:
            if stream:
                return sse_response(_stream_lines())
            return httpx.Response(200, json={
                "content": [THINKING, REDACTED, SECOND, {"type": "text", "text": "answer"},
                            {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "x"}}],
                "stop_reason": "tool_use", "usage": {"input_tokens": 1, "output_tokens": 1},
            })
        if stream:
            return sse_response(_event("message_delta", delta={"stop_reason": "end_turn"}, usage={}))
        return httpx.Response(200, json={"content": [], "stop_reason": "end_turn", "usage": {}})

    client = make_client(handler)
    backend = AnthropicBackend(client, "https://x/v1", "k")
    try:
        question = [{"role": "user", "content": "q"}]
        if stream:
            events = [event async for event in backend.stream(question, model="claude")]
            assert [event.native_output_items for event in events if event.kind == "native_output_item"] == [[
                THINKING, REDACTED, SECOND, {"type": "text", "text": "answer"},
                {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "x"}},
            ]]
            # Fetch again using a fresh transport so the response cycle starts at call one.
            fresh_client = make_client(lambda req: sse_response(_stream_lines()))
            try:
                fresh = AnthropicBackend(fresh_client, "https://x/v1", "k")
                result = await aggregate(fresh.stream(question, model="claude"))
            finally:
                await fresh_client.close()
        else:
            result = await backend.complete(question, model="claude")
        assert result.native_output_items == [THINKING, REDACTED, SECOND, {"type": "text", "text": "answer"},
                                              {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "x"}}]
        assert result.reasoning == "second" and result.signature == "SIG-two"
        assert result.text == "answer" and result.finish_reason == "tool_calls"
        assert [call.id for call in result.tool_calls] == ["t1"]
        assistant = {"role": "assistant", "content": result.text, "reasoning": result.reasoning,
                     "signature": result.signature, "tool_calls": result.tool_calls,
                     "native_output_items": result.native_output_items}
        continuation = [*question, assistant, {"role": "tool", "tool_call_id": "t1", "content": "ok"}]
        assert validate_model_context(continuation)
        if stream:
            await aggregate(backend.stream(continuation, model="claude", think_level="off"))
        else:
            await backend.complete(continuation, model="claude", think_level="off")
        outbound = recorded[-1]
        blocks = outbound["messages"][1]["content"]
        assert blocks[:3] == [THINKING, REDACTED, SECOND]
        assert [b["type"] for b in blocks] == ["thinking", "redacted_thinking", "thinking", "text", "tool_use"]
        assert "thinking" not in outbound  # /think off cannot disable during a tool turn
        assert result.native_output_items == [THINKING, REDACTED, SECOND, {"type": "text", "text": "answer"},
                                              {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "x"}}]  # no mutation from cache injection
    finally:
        await client.close()


def test_sender_empty_thinking_fallback_and_completed_off_boundary():
    prior = {"role": "assistant", "content": "done", "reasoning": "", "signature": "signed-empty"}
    assert _to_anthropic([prior])[0]["content"] == [
        {"type": "thinking", "thinking": "", "signature": "signed-empty"},
        {"type": "text", "text": "done"},
    ]
    assert _to_anthropic([prior], include_thinking=False)[0]["content"] == [
        {"type": "text", "text": "done"},
    ]
    backend = AnthropicBackend(make_client(lambda r: httpx.Response(200)), "https://x/v1", "k")
    completed = [prior, {"role": "user", "content": "next"}]
    payload = backend.build_payload(completed, model="claude", think_level="off")
    assert payload["thinking"] == {"type": "disabled"}
    assert not any(b.get("type") == "thinking" for b in payload["messages"][0]["content"])
    # A signed native-only tail must never acquire cache_control inside its blocks.
    signed_tail = backend.build_payload([{"role": "assistant", "content": "",
                                          "native_output_items": [THINKING, REDACTED]}], model="claude")
    assert signed_tail["messages"][0]["content"] == [THINKING, REDACTED]


def test_tool_turn_preserves_all_calls_and_prior_thinking_on_off():
    calls = [ToolCall("a", "Read", "{}"), ToolCall("b", "Read", "{}")]
    first = {"role": "assistant", "content": "", "tool_calls": calls,
             "native_output_items": [THINKING, REDACTED]}
    later = {"role": "assistant", "content": "", "tool_calls": [ToolCall("c", "Read", "{}")],
             "native_output_items": [SECOND]}
    messages = [{"role": "assistant", "content": "old", "native_output_items": [SECOND]},
                {"role": "user", "content": "new"}, first,
                {"role": "tool", "tool_call_id": "a", "content": "A"},
                {"role": "tool", "tool_call_id": "b", "content": "B"}, later,
                {"role": "tool", "tool_call_id": "c", "content": "C"}]
    backend = AnthropicBackend(make_client(lambda r: httpx.Response(200)), "https://x/v1", "k")
    payload = backend.build_payload(messages, model="claude", think_level="off")
    assert "thinking" not in payload
    assert payload["messages"][0]["content"] == [{"type": "text", "text": "old"}]
    assert payload["messages"][2]["content"][:2] == [THINKING, REDACTED]
    assert payload["messages"][4]["content"][0] == SECOND
    assert [b["tool_use_id"] for b in payload["messages"][3]["content"]] == ["a", "b"]
    # Legacy neutral signature also survives if the active tool turn has no native items.
    legacy = [{"role": "user", "content": "q"},
              {"role": "assistant", "content": "", "reasoning": "", "signature": "empty-sig",
               "tool_calls": [ToolCall("t", "Read", "{}")]},
              {"role": "tool", "tool_call_id": "t", "content": "ok"}]
    legacy_payload = backend.build_payload(legacy, model="claude", think_level="off")
    assert legacy_payload["messages"][1]["content"][0] == {
        "type": "thinking", "thinking": "", "signature": "empty-sig"}
    assert "thinking" not in legacy_payload


def test_native_continuation_all_anthropic_blocks_require_complete_tool_set():
    items = [THINKING, REDACTED, SECOND]
    emitted = [ToolCall("a", "Read", "{}"), ToolCall("b", "Read", "{}")]
    assert native_items_for_tool_calls(items, emitted, emitted, has_content=True, has_reasoning=True) == items
    assert native_items_for_tool_calls(items, emitted, emitted[:1], has_content=True, has_reasoning=True) == []
    assert native_items_for_tool_calls(items, [], [], has_content=True, has_reasoning=False) == items
    assert native_items_for_tool_calls([*items, {"type": "unknown"}], emitted, emitted,
                                       has_content=True, has_reasoning=True) == []
    assert native_items_for_tool_calls([*items, {"type": "message"}], emitted, emitted,
                                       has_content=True, has_reasoning=True) == []
    closed = [{"role": "assistant", "content": "text", "tool_calls": emitted,
               "native_output_items": items},
              {"role": "tool", "tool_call_id": "a", "content": "A"},
              {"role": "tool", "tool_call_id": "b", "content": "B"}]
    assert validate_model_context(closed)
    assert not validate_model_context(closed[:-1])  # validation must not relax closure
