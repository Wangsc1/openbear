"""Responses repeated-done execution/replay consistency through the real Agent."""
from __future__ import annotations

import json

import httpx
import pytest

from app.agent.loop import Agent
from app.llm.client import HTTPClient
from app.llm.openai_responses import OpenAIResponsesBackend
from app.tools.base import ToolRegistry


def _event(name, data):
    return f"event: {name}\ndata: {json.dumps(data)}\n\n".encode()


def _item_event(phase, item, index=None):
    name = f"response.output_item.{phase}"
    data = {"type": name, "item": item}
    if index is not None:
        data["output_index"] = index
    return _event(name, data)


def _completed():
    return _event("response.completed", {
        "type": "response.completed", "response": {"status": "completed", "usage": {}},
    })


class _ResponseStream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.finished = False

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk
        self.finished = True


class _NativeModeBackend(OpenAIResponsesBackend):
    """Select the native option without replacing the real adapter or Agent."""

    def __init__(self, client, native_continuation):
        super().__init__(client, "https://responses.test/v1", "test-key")
        self.native_continuation = native_continuation
        self.emitted_calls = []
        self.native_items = []

    async def stream(self, messages, **options):
        options["native_continuation"] = self.native_continuation
        async for event in super().stream(messages, **options):
            if event.kind == "tool_call":
                self.emitted_calls.extend(event.tool_calls)
            elif event.kind == "native_output_item":
                self.native_items.extend(event.native_output_items)
            yield event


class _Renderer:
    async def on_status(self, status):
        pass

    async def on_tool(self, tool_line):
        pass

    async def on_delta(self, full_text, reasoning=""):
        pass

    async def finalize(self, full_text, reasoning=""):
        pass

    async def cut(self):
        pass

    async def finalize_notice(self, notice):
        pytest.fail(f"Unexpected notice: {notice}")

    async def fail(self, error):
        pytest.fail(f"Unexpected Agent error: {error}")


@pytest.mark.parametrize("native_continuation", [True, False])
@pytest.mark.parametrize("index_source", ["done", "added"])
@pytest.mark.parametrize("update", ["identical", "arguments", "name"])
async def test_repeated_done_executes_and_replays_latest_call(
    native_continuation, index_source, update,
):
    older = {
        "type": "function_call", "id": "fc_repeated", "call_id": "call_repeated",
        "name": "echo", "arguments": '{"x":"old"}', "status": "completed",
    }
    latest = dict(older)
    if update == "arguments":
        latest["arguments"] = '{"x":"new"}'
    elif update == "name":
        latest["name"] = "echo_latest"

    chunks = []
    if index_source == "added":
        chunks.append(_item_event("added", {**older, "status": "in_progress"}, 0))
    index = 0 if index_source == "done" else None
    chunks.extend([_item_event("done", older, index), _item_event("done", latest, index), _completed()])
    first_stream = _ResponseStream(chunks)
    final_message = {
        "type": "message", "id": "msg_final", "role": "assistant", "status": "completed",
        "content": [{"type": "output_text", "text": "finished", "annotations": []}],
    }
    final_body = b"".join([
        _event("response.output_text.delta", {
            "type": "response.output_text.delta", "output_index": 0, "item_id": "msg_final",
            "content_index": 0, "delta": "finished",
        }),
        _item_event("done", final_message, 0),
        _completed(),
    ])
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        assert len(bodies) <= 2
        headers = {"content-type": "text/event-stream"}
        if len(bodies) == 1:
            return httpx.Response(200, stream=first_stream, headers=headers)
        return httpx.Response(200, content=final_body, headers=headers)

    executed = []
    tools = ToolRegistry()

    def echo_tool(name):
        async def run(args):
            executed.append((name, dict(args), first_stream.finished))
            return f"{name}:{args['x']}"
        return run

    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    for name in ("echo", "echo_latest"):
        tools.add(name, name, schema, echo_tool(name))

    client = HTTPClient()
    await client.close()
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    backend = _NativeModeBackend(client, native_continuation)
    try:
        result = await Agent(backend, tools, max_retries=0).run(
            [{"role": "user", "content": "run"}], _Renderer(), model="gpt-test",
        )
    finally:
        await client.close()

    expected_args = json.loads(latest["arguments"])
    assert result.text == "finished" and result.tools_used == [latest["name"]]
    # One invocation, only after the SSE stream ends, using the final done payload.
    assert executed == [(latest["name"], expected_args, True)]
    assert len(backend.emitted_calls) == 1
    emitted = backend.emitted_calls[0]
    assert (emitted.id, emitted.name, json.loads(emitted.arguments)) == (
        latest["call_id"], latest["name"], expected_args,
    )
    assert len(bodies) == 2
    replay = bodies[1]["input"]
    calls = [item for item in replay if item.get("type") == "function_call"]
    outputs = [item for item in replay if item.get("type") == "function_call_output"]
    assert len(calls) == len(outputs) == 1
    assert (calls[0]["call_id"], calls[0]["name"], json.loads(calls[0]["arguments"])) == (
        emitted.id, executed[0][0], executed[0][1],
    )
    assert outputs[0] == {
        "type": "function_call_output", "call_id": emitted.id,
        "output": f"{latest['name']}:{expected_args['x']}",
    }
    assert replay.index(calls[0]) < replay.index(outputs[0])
    if native_continuation:
        assert calls == [latest]
        assert bodies[0]["store"] is False
    else:
        assert backend.native_items == []
        assert "store" not in bodies[0]
