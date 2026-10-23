"""Prefix-binding recovery: isolated transport/runner and physical-call contracts."""
from __future__ import annotations

import asyncio
import copy
import json
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest

from app.agent.transcript_repair import repair_role_alternation
from app.agents.execution import AgentExecutor
from app.llm.anthropic import AnthropicBackend
from app.llm.base import OpenBearLLMError
from app.llm.events import StreamEvent, ToolCall, Usage
from app.llm.retry import RetryPolicy
from app.runtime.model_call import ModelCallDriver, PreparedRequest
from app.tools.base import ToolRegistry
from app.web_console.live_stream import _WebStreamRenderer
from tests.conftest import make_client, sse_response
from tests.test_controller_model_switch import (
    checkpoint as web_checkpoint,
)
from tests.test_controller_model_switch import (
    originals as web_originals,
)
from tests.test_controller_model_switch import (
    run as web_run,
)
from tests.test_controller_model_switch import (
    setup as web_setup,
)
from tests.test_rath_single_agent import env as shared_agent_env
from tests.test_runtime_model_call import FakeStream, fault
from tests.test_web_admin import web_env as web_env

agent_env = shared_agent_env

MISMATCH = ('Invalid `signature` in `thinking` block. The block is bound to a different '
            'conversation. Remove the block, or set '
            '`thinking.block_binding.prefix_mismatch_behavior` to "drop_block". '
            'The system prompt differs.')
OLD = {"type": "thinking", "thinking": "old reasoning", "signature": "old-signature"}
REDACTED = {"type": "redacted_thinking", "data": "old-ciphertext"}
TEXT = {"type": "text", "text": "already done", "citations": [{"type": "test"}]}
TOOL = {"type": "tool_use", "id": "done-call", "name": "Read", "input": {"path": "x"}}
NEW = {"type": "thinking", "thinking": "fresh reasoning", "signature": "fresh-signature"}


def history():
    return [{"role": "user", "content": "task"},
            {"role": "assistant", "content": "already done", "reasoning": "old reasoning",
             "signature": "old-signature", "native_output_items": [OLD, REDACTED, TEXT, TOOL],
             "tool_calls": [ToolCall("done-call", "Read", '{"path":"x"}')]},
            {"role": "tool", "tool_call_id": "done-call", "content": "completed effect"}]


@pytest.mark.asyncio
async def test_binding_recovery_is_once_and_preserves_fresh_native_and_billing():
    from app.runtime.thinking_recovery import strip_anthropic_thinking
    backend = FakeStream([[fault(MISMATCH, status=400)], [
        StreamEvent("reasoning", text="fresh reasoning", signature="fresh-signature"),
        StreamEvent("native_output_item", native_output_items=[NEW]),
        StreamEvent("usage", usage=Usage(input_tokens=3, output_tokens=2)),
        StreamEvent("content", text="recovered")]])
    backend.protocol = "anthropic"
    original = history()
    active = copy.deepcopy(original)
    settled, recovered = [], []

    def recover(outcome):
        nonlocal active
        assert settled == [outcome]  # settle failed physical request first
        recovered.append(outcome)
        active, changed = strip_anthropic_thinking(active)
        return changed

    response = await ModelCallDriver(RetryPolicy(max_retries=0)).call(
        lambda tail: PreparedRequest(backend, active + tail, {}), settled.append,
        recover_thinking=recover)
    assert response.response.text == "recovered" and response.native_replayable
    assert response.response.native_output_items == [NEW]
    assert response.response.signature == "fresh-signature"
    assert response.response.usage == Usage()
    assert (response.attempts, response.retries) == (2, 1)
    assert [o.status for o in settled] == ["error", "ok"]
    assert len({o.attempt_id for o in settled}) == 2
    assert settled[1].response.usage == Usage(input_tokens=3, output_tokens=2)
    assert active[1]["native_output_items"] == [TEXT, TOOL]
    assert not active[1].get("reasoning") and not active[1].get("signature")
    assert active[1]["tool_calls"] == original[1]["tool_calls"]
    assert active[0] == original[0] and active[2] == original[2]
    assert original == history() and recovered[0].request.messages == original


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", [[], [fault("transient", status=503)]])
async def test_second_binding_error_never_uses_normal_retry_budget(prefix):
    backend = FakeStream([*([prefix] if prefix else []), [fault(MISMATCH, status=400, retryable=True)],
                          [fault(MISMATCH, status=400, retryable=True)]])
    backend.protocol = "anthropic"
    settled, recovered = [], []
    with pytest.raises(OpenBearLLMError, match="bound to a different"):
        await ModelCallDriver(RetryPolicy(max_retries=4, base_delay_s=0)).call(
            lambda tail: PreparedRequest(backend, history() + tail, {}), settled.append,
            recover_thinking=lambda outcome: recovered.append(outcome) or True)
    assert len(recovered) == 1
    assert len(settled) == 2 + bool(prefix)


@pytest.mark.asyncio
@pytest.mark.parametrize("event", [StreamEvent("content", text="text"),
    StreamEvent("reasoning", text="think"), StreamEvent("reasoning", signature="signature"),
    StreamEvent("encrypted_reasoning", text="opaque"), StreamEvent("tool_input"),
    StreamEvent("tool_call", tool_calls=[ToolCall("id", "Read", "{}")]),
    StreamEvent("native_output_item", native_output_items=[REDACTED]), StreamEvent("output_started")])
async def test_binding_error_after_any_output_cannot_recover_or_return_tools(event):
    backend = FakeStream([[event, fault(MISMATCH, status=400, retryable=True)]])
    backend.protocol = "anthropic"
    recovered, settled = [], []
    with pytest.raises(OpenBearLLMError):
        await ModelCallDriver(RetryPolicy(max_retries=4, base_delay_s=0)).call(
            lambda tail: PreparedRequest(backend, history(), {}), settled.append,
            recover_thinking=lambda o: recovered.append(o) or True)
    assert len(settled) == 1 and not recovered


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol,message,status", [
    ("anthropic", "Invalid `signature` in `thinking` block.", 400),
    ("anthropic", "Unable to decrypt thinking signature", 400),
    ("anthropic", "invalid request", 400), ("anthropic", MISMATCH, 401),
    ("responses", MISMATCH, 400), ("chat", MISMATCH, 400)])
async def test_unrelated_errors_are_not_binding_recovery(protocol, message, status):
    backend = FakeStream([[fault(message, status=status)]])
    backend.protocol = protocol
    recovered = []
    with pytest.raises(OpenBearLLMError):
        await ModelCallDriver(RetryPolicy(max_retries=0)).call(
            lambda tail: PreparedRequest(backend, history(), {}), lambda o: None,
            recover_thinking=lambda o: recovered.append(o) or True)
    assert not recovered and len(backend.seen) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [ValueError("checkpoint failed"), asyncio.CancelledError(),
                                    OpenBearLLMError("local callback failed", status=503, retryable=True)])
async def test_binding_callback_failure_is_local_and_never_retried(failure):
    backend = FakeStream([[fault(MISMATCH, status=400)]])
    backend.protocol = "anthropic"
    settled = []

    def recover(outcome):
        raise failure

    with pytest.raises(type(failure)):
        await ModelCallDriver(RetryPolicy(max_retries=4, base_delay_s=0)).call(
            lambda tail: PreparedRequest(backend, history(), {}), settled.append,
            recover_thinking=recover)
    assert len(settled) == len(backend.seen) == 1

# These tests use the production HTTPClient and Anthropic serializer/parser.
# Only the network boundary is replaced; no backend returns synthetic success.
def canonical(value):
    if isinstance(value, dict):
        value = {key: canonical(item) for key, item in value.items() if key != "cache_control"}
        # Anthropic accepts shorthand text and a one-element text block list
        # equivalently; moving cache breakpoints changes only this wire spelling.
        if "role" in value and isinstance(value.get("content"), str):
            value["content"] = [{"type": "text", "text": value["content"]}]
        return value
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def event(name, **data):
    return [f"event: {name}", f"data: {json.dumps({'type': name, **data})}", ""]


def wire_response(payload, blocks):
    stop = "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"
    if not payload.get("stream"):
        return httpx.Response(200, json={"content": blocks, "stop_reason": stop,
                                        "usage": {"input_tokens": 11, "output_tokens": 5}})
    lines = event("message_start", message={"usage": {"input_tokens": 11}})
    for index, block in enumerate(blocks):
        initial = copy.deepcopy(block)
        deltas = []
        if block["type"] == "text":
            initial["text"] = ""
            deltas = [{"type": "text_delta", "text": block["text"]}]
        elif block["type"] == "thinking":
            initial.update(thinking="", signature="")
            deltas = [{"type": "thinking_delta", "thinking": block["thinking"]},
                      {"type": "signature_delta", "signature": block["signature"]}]
        lines += event("content_block_start", index=index, content_block=initial)
        for delta in deltas:
            lines += event("content_block_delta", index=index, delta=delta)
        lines += event("content_block_stop", index=index)
    lines += event("message_delta", delta={"stop_reason": stop}, usage={"output_tokens": 5})
    lines += event("message_stop")
    return sse_response(lines)


class StrictBindingTransport:
    """Bind issued opaque blocks to system/tools/all preceding wire messages."""
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.requests = []
        self.bound = {}
        self.rejections = 0

    def prefix(self, payload, messages):
        return canonical({"system": payload.get("system"), "tools": payload.get("tools"),
                          "messages": messages})

    def __call__(self, request):
        payload = json.loads(request.content)
        self.requests.append(copy.deepcopy(payload))
        assert "thinking-binding" not in request.headers.get("anthropic-beta", "")
        assert "input_transformations" not in payload
        for index, message in enumerate(payload["messages"]):
            for block in message.get("content", []) if isinstance(message.get("content"), list) else []:
                if block.get("type") not in {"thinking", "redacted_thinking"}:
                    continue
                token = block.get("signature") or block.get("data")
                if self.bound[token] != self.prefix(payload, payload["messages"][:index]):
                    self.rejections += 1
                    return httpx.Response(400, json={"type": "error", "error": {
                        "type": "invalid_request_error", "message": MISMATCH}})
        blocks = self.outputs.pop(0)
        for block in blocks:
            if block["type"] in {"thinking", "redacted_thinking"}:
                token = block.get("signature") or block.get("data")
                self.bound[token] = self.prefix(payload, payload["messages"])
        return wire_response(payload, blocks)


def all_blocks(payload):
    return [b for m in payload["messages"] for b in m.get("content", [])
            if isinstance(b, dict)]


@pytest.mark.parametrize("change", ["system", "tools", "none"])
async def test_http_web_runner_recovers_and_next_turn_keeps_fresh_thinking(
    web_env, monkeypatch, tmp_path, change,
):
    x = await web_setup(web_env, monkeypatch, tmp_path, "anthropic")
    transport = StrictBindingTransport([
        [OLD, REDACTED, TEXT, {**TOOL, "name": "ReadMarker", "input": {}}],
        [{"type": "text", "text": "initial done"}],
        [NEW, {"type": "text", "text": "recovered done"}],
        [{"type": "text", "text": "continued done"}],
    ])
    client = make_client(transport)
    backend = AnthropicBackend(client, "https://mock.invalid/v1", "fixture")
    x.env.server.llm_factory = SimpleNamespace(
        backend_for=lambda _: (backend, "model-a", 8192), context_window=lambda _: 128000)
    try:
        await web_run(x)
        assert transport.rejections == 0 and len(transport.requests) == 2
        assert OLD in all_blocks(transport.requests[1]) and REDACTED in all_blocks(transport.requests[1])
        original_rows = await web_originals(x)
        original_checkpoint = await web_checkpoint(x)
        assert "old-signature" in str(original_checkpoint)
        if change == "system":
            # Change only the active prompt snapshot in this tmp_path database;
            # the server deliberately freezes the builder result per session.
            await x.env.db.conn.execute("UPDATE sessions SET system_snapshot=? WHERE chat_id=?",
                ("Updated system instructions, preserve all completed effects.", x.chat))
            await x.env.db.conn.commit()
        elif change == "tools":
            async def extra(args):
                raise AssertionError("extra tool must not execute")
            x.env.server.tools.add("Extra", "new schema", {"type": "object", "properties": {}}, extra)
        await web_run(x, "next task")
        assert transport.rejections == (change != "none")
        checkpoint = await web_checkpoint(x)
        assert "fresh-signature" in str(checkpoint)
        assert ("old-signature" in str(checkpoint)) == (change == "none")
        rows = await web_originals(x)
        assert rows[:len(original_rows)] == original_rows  # editor/original transcript is untouched
        await web_run(x, "continue again")
        assert transport.rejections == (change != "none")
        last = all_blocks(transport.requests[-1])
        assert NEW in last
        assert x.executions == ["read"]
        assert next(b for b in last if b["type"] == "tool_use")["id"] == "done-call"
        if change != "none":
            before, after = transport.requests[2:4]
            expected = copy.deepcopy(before)
            for m in expected["messages"]:
                if isinstance(m["content"], list):
                    m["content"] = [b for b in m["content"] if b["type"] not in {"thinking", "redacted_thinking"}]
            assert canonical(after) == canonical(expected)
        cur = await x.env.db.conn.execute("SELECT * FROM model_calls WHERE chat_id=? ORDER BY id", (x.chat,))
        calls = [dict(row) for row in await cur.fetchall()]
        assert len(calls) == len(transport.requests) == 4 + (change != "none")
        assert len({row["attempt_id"] for row in calls}) == len(calls)
        assert sum(row["input_tokens"] for row in calls) == 44
        assert sum(row["output_tokens"] for row in calls) == 20
        assert sum(row["status"] == "error" for row in calls) == (change != "none")
        # Runtime notice is durably published as a visible Web timeline event.
        cur = await x.env.db.conn.execute("SELECT payload_json FROM web_event_frames WHERE internal_chat_id=?", (x.chat,))
        notices = [json.loads(row[0]) for row in await cur.fetchall()]
        recovery_notices = [e for e in notices if e.get("runtimeNotice") and "旧思考" in e.get("text", "")]
        assert len(recovery_notices) == (change != "none")
    finally:
        await client.close()


@pytest.mark.parametrize("mode", ["stream", "complete"])
@pytest.mark.parametrize("change", ["system", "tools", "prefix", "none"])
async def test_http_agent_continue_persists_recovery_without_reexecuting_tools(agent_env, monkeypatch, mode, change):
    dao, tid, agent = agent_env
    fresh_tool = {"type": "tool_use", "id": "fresh-call", "name": "Read", "input": {"path": "y"}}
    transport = StrictBindingTransport([[OLD, REDACTED, TEXT, TOOL],
                                       [NEW, fresh_tool], [{"type": "text", "text": "finished"}]])
    client = make_client(transport)
    backend = AnthropicBackend(client, "https://mock.invalid/v1", "fixture")
    if mode == "complete":
        backend.stream = None
    reg, effects, calls = ToolRegistry(), [], []

    async def read(args):
        effects.append(args["path"])
        return "effect completed: " + args["path"]

    reg.add("Read", "read file", {"type": "object", "properties": {"path": {"type": "string"}}}, read)

    def runner(agent, session_id=""):
        return AgentExecutor(dao, tid, agent=agent, backend=backend, model="claude", model_label="test/claude",
            max_tokens=4096, tools=reg, model_call_limit=1, session_id=session_id,
            think_level="high", plan_protocol_enabled=False, on_model_call=calls.append)

    try:
        first = runner(agent)
        assert (await first.run())["status"] == "needs_openbear_control"
        assert effects == ["x"]
        saved = await dao.task_model_context(tid)
        assert "old-signature" in str(saved)
        artifacts_before = [(a.id, a.content) for a in await dao.artifacts(tid)]
        cur = await dao.db.conn.execute("SELECT event_id,payload_json,fingerprint FROM context_execution_events ORDER BY seq")
        originals = [tuple(row) for row in await cur.fetchall()]
        if change == "system":
            agent = replace(agent, system_prompt=agent.system_prompt + "\nUpdated instructions.")
        elif change == "tools":
            reg.add("Read", "updated description", {"type": "object", "properties": {"path": {"type": "string"}}}, read)
        elif change == "prefix":
            view = AgentExecutor._context_request_view
            def changed_view(self, messages, retry_tail=None):
                return repair_role_alternation([{"role": "user", "content": "request-local prefix update"},
                                               *view(self, messages, retry_tail)])
            monkeypatch.setattr(AgentExecutor, "_context_request_view", changed_view)
        second = runner(agent, first.session_id)
        assert (await second.run_continue("continue remaining work"))["status"] == "needs_openbear_control"
        assert effects == ["x", "y"]
        saved = await dao.task_model_context(tid)
        assert "fresh-signature" in str(saved)
        assert ("old-signature" in str(saved)) == (change == "none")
        assert transport.rejections == (change != "none")
        cur = await dao.db.conn.execute("SELECT event_id,payload_json,fingerprint FROM context_execution_events ORDER BY seq")
        assert [tuple(row) for row in await cur.fetchall()][:len(originals)] == originals
        artifacts_after = {a.id: a.content for a in await dao.artifacts(tid)}
        assert all(artifacts_after[key] == value for key, value in artifacts_before)
        # Reload a new executor from the durable checkpoint, not the local list.
        third = runner(agent, first.session_id)
        result = await third.run_continue("finish using the completed effects")
        assert result["summary"] == "finished"
        assert effects == ["x", "y"] and transport.rejections == (change != "none")
        last = all_blocks(transport.requests[-1])
        assert NEW in last and (OLD in last) == (change == "none")
        assert next(b for b in last if b["type"] == "text" and b["text"] == TEXT["text"]) == TEXT
        assert [b["id"] for b in last if b["type"] == "tool_use"] == ["done-call", "fresh-call"]
        assert {b["tool_use_id"] for b in last if b["type"] == "tool_result"} == {"done-call", "fresh-call"}
        assert len(calls) == len(transport.requests) == 3 + (change != "none")
        assert len({c["attemptId"] for c in calls}) == len(calls)
        task = await dao.get_task(tid)
        assert task.model_call_count == len(calls) and task.input_tokens == 33 and task.output_tokens == 15
        events = await dao.events(tid)
        notices = [e for e in events if e.kind == "model_thinking_prefix_recovered"]
        assert len(notices) == (change != "none")
        assert all("旧思考" in e.summary and "old-signature" not in str(e.detail) for e in notices)
    finally:
        await client.close()


@pytest.mark.parametrize("mode", ["stream", "complete"])
@pytest.mark.parametrize("diagnosis", ["official", "code", "gateway"])
async def test_http_explicit_diagnoses_have_identical_bounded_recovery(mode, diagnosis):
    from app.runtime.thinking_recovery import strip_anthropic_thinking
    payloads, settled, recovered = [], [], []
    active = history()
    if diagnosis == "gateway":
        error = {"error": {"message": "gateway rejected", "details": {"root_cause": {
            "status": 400, "classification": "invalid_request_error", "code": "prefix_binding_mismatch",
            "message": "prefix rejected", "retryable": True}, "attempts": []}}}
    else:
        error = {"type": "error", "error": {"type": "prefix_binding_mismatch" if diagnosis == "code" else "invalid_request_error",
                                           "message": "prefix rejected" if diagnosis == "code" else MISMATCH}}

    def handler(request):
        payload = json.loads(request.content)
        payloads.append(payload)
        if len(payloads) == 1:
            return httpx.Response(400, json=error)
        return wire_response(payload, [NEW, {"type": "text", "text": "success"}])

    client = make_client(handler)
    backend = AnthropicBackend(client, "https://mock.invalid/v1", "fixture")

    def recover(outcome):
        nonlocal active
        recovered.append(outcome)
        active, changed = strip_anthropic_thinking(active)
        return changed

    try:
        result = await ModelCallDriver(RetryPolicy(max_retries=0)).call(
            lambda tail: PreparedRequest(backend, active + tail, {"model": "claude", "think_level": "high"},
                                         metadata={"mode": mode}), settled.append, recover_thinking=recover)
        assert result.response.text == "success" and result.response.native_output_items == [NEW, {"type": "text", "text": "success"}]
        assert result.native_replayable and len(recovered) == 1
        assert [o.status for o in settled] == ["error", "ok"]
        assert OLD in all_blocks(payloads[0]) and OLD not in all_blocks(payloads[1])
        assert TEXT in canonical(all_blocks(payloads[1])) and TOOL in canonical(all_blocks(payloads[1]))
    finally:
        await client.close()


@pytest.mark.parametrize("block", [REDACTED, OLD, {"type": "text", "text": "body"}, TOOL])
async def test_http_sse_error_after_block_start_never_strips_active_context(block):
    calls, recovered, settled = [], [], []

    def handler(request):
        calls.append(request)
        return sse_response(event("content_block_start", index=0, content_block=block)
            + event("error", error={"type": "invalid_request_error", "message": MISMATCH, "status": 400}))

    client = make_client(handler)
    backend = AnthropicBackend(client, "https://mock.invalid/v1", "fixture")
    try:
        with pytest.raises(OpenBearLLMError):
            await ModelCallDriver(RetryPolicy(max_retries=3, base_delay_s=0)).call(
                lambda tail: PreparedRequest(backend, history(), {"model": "claude"}), settled.append,
                recover_thinking=lambda o: recovered.append(o) or True)
        assert len(calls) == len(settled) == 1 and not recovered
        assert settled[0].output_started and settled[0].error.status == 400
    finally:
        await client.close()


async def test_ordinary_retry_after_recovery_cannot_reset_binding_limit():
    backend = FakeStream([[fault(MISMATCH, status=400)], [fault("overloaded", status=503)],
                          [fault(MISMATCH, status=400, retryable=True)]])
    backend.protocol = "anthropic"
    settled, recovered = [], []
    with pytest.raises(OpenBearLLMError, match="bound to a different"):
        await ModelCallDriver(RetryPolicy(max_retries=4, base_delay_s=0)).call(
            lambda tail: PreparedRequest(backend, history() + tail, {}), settled.append,
            recover_thinking=lambda o: recovered.append(o) or True)
    assert len(settled) == 3 and len(recovered) == 1


@pytest.mark.parametrize("cancel_via", ["flag", "control"])
async def test_recovery_retry_honors_cancellation_after_checkpoint(cancel_via):
    from app.llm.retry import RetryCancelledError
    backend = FakeStream([[fault(MISMATCH, status=400)]])
    backend.protocol = "anthropic"
    settled, recovered = [], []
    with pytest.raises(RetryCancelledError):
        await ModelCallDriver(RetryPolicy(max_retries=4)).call(
            lambda tail: PreparedRequest(backend, history(), {}), settled.append,
            recover_thinking=lambda o: recovered.append(o) or True,
            cancel_check=lambda: cancel_via == "flag",
            control_check=lambda wait_id: "cancel" if cancel_via == "control" else "")
    assert len(settled) == len(backend.seen) == len(recovered) == 1


async def test_cancel_during_recovery_request_accounts_both_physical_attempts_once():
    reached = asyncio.Event()
    class Backend:
        protocol = "anthropic"
        calls = 0
        async def stream(self, messages, **options):
            self.calls += 1
            if self.calls == 1:
                yield fault(MISMATCH, status=400)
                return
            yield StreamEvent("usage", usage=Usage(input_tokens=9, output_tokens=2))
            yield StreamEvent("reasoning", text="fresh partial")
            reached.set()
            await asyncio.sleep(100)
    backend = Backend()
    settled, recovered = [], []
    task = asyncio.create_task(ModelCallDriver(RetryPolicy(max_retries=0)).call(
        lambda tail: PreparedRequest(backend, history(), {}), settled.append,
        recover_thinking=lambda o: recovered.append(o) or True))
    await asyncio.wait_for(reached.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(recovered) == 1 and backend.calls == 2
    assert [o.status for o in settled] == ["error", "cancelled"]
    assert settled[1].response.usage.input_tokens == 9 and settled[1].response.reasoning == "fresh partial"
    assert len({o.attempt_id for o in settled}) == 2


def test_cleanup_legacy_signature_and_never_mutates_unsigned_or_native_text_items():
    from app.runtime.thinking_recovery import strip_anthropic_thinking
    messages = [{"role": "assistant", "content": "legacy", "reasoning": "", "signature": "empty-thinking-sig"},
                {"role": "assistant", "content": "readable", "reasoning": "unsigned"},
                {"role": "assistant", "content": "already done", "native_output_items": [TEXT]}]
    clean, changed = strip_anthropic_thinking(messages)
    assert changed and clean[0] == {"role": "assistant", "content": "legacy"}
    assert clean[1:] == messages[1:] and messages[0]["signature"] == "empty-thinking-sig"
    assert strip_anthropic_thinking(clean) == (clean, False)


async def test_http_web_second_400_stops_but_clean_checkpoint_survives_next_turn(web_env, monkeypatch, tmp_path):
    x = await web_setup(web_env, monkeypatch, tmp_path, "anthropic")
    transport = StrictBindingTransport([
        [OLD, REDACTED, TEXT, {**TOOL, "name": "ReadMarker", "input": {}}],
        [{"type": "text", "text": "initial done"}],
        [NEW, {"type": "text", "text": "later done"}],
    ])
    second_rejection = True

    def handler(request):
        if second_rejection and len(transport.requests) == 3:
            transport.requests.append(json.loads(request.content))
            # Even a mislabelled retryable envelope cannot bypass the limit.
            return httpx.Response(400, json={"error": {"message": MISMATCH, "details": {
                "root_cause": {"status": 400, "classification": "prefix_binding_mismatch", "retryable": True},
                "attempts": []}}})
        return transport(request)

    client = make_client(handler)
    backend = AnthropicBackend(client, "https://mock.invalid/v1", "fixture")
    x.env.server.llm_factory = SimpleNamespace(
        backend_for=lambda _: (backend, "model-a", 8192), context_window=lambda _: 128000)
    try:
        await web_run(x)
        original_rows = await web_originals(x)
        await x.env.db.conn.execute("UPDATE sessions SET system_snapshot=? WHERE chat_id=?", ("Updated system", x.chat))
        await x.env.db.conn.commit()
        x.turns += 1
        row = await x.env.server._conversation_row(123, x.uuid, require=True)
        live = x.env.server._live_for(row)
        turn = f"switch-test-{x.turns}"
        await live.publish({"type": "accepted", "turnUuid": turn})
        assert await x.env.server._run_web_turn(x.chat, "next task", _WebStreamRenderer(live),
            conversation=row, root_turn_uuid=turn) is False
        assert len(transport.requests) == 4 and transport.rejections == 1
        clean = await web_checkpoint(x)
        assert "old-signature" not in str(clean) and "done-call" in str(clean)
        assert (await web_originals(x))[:len(original_rows)] == original_rows
        cur = await x.env.db.conn.execute("SELECT status FROM model_calls WHERE chat_id=? ORDER BY id", (x.chat,))
        assert [row[0] for row in await cur.fetchall()] == ["ok", "ok", "error", "error"]
        second_rejection = False
        await web_run(x, "try continuing saved active state")
        assert len(transport.requests) == 5 and transport.rejections == 1
        assert OLD not in all_blocks(transport.requests[-1])
        assert "fresh-signature" in str(await web_checkpoint(x))
        assert x.executions == ["read"]
    finally:
        await client.close()
