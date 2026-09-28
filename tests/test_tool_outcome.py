"""Tool dispatch keeps execution facts independent of model-facing text."""
from __future__ import annotations

import asyncio
import json

import pytest

from app.runtime.tool_result import ToolOutcome
from app.tools.base import ToolRegistry, ToolRuntimeContext, current_tool_context
from app.tools.truncate import truncate_tool_result


def registry(handler, **options):
    reg = ToolRegistry()
    reg.add("example", "example", {"type": "object"}, handler, **options)
    return reg


async def test_legacy_text_never_guesses_business_status_or_side_effects():
    async def handler(args):
        return args["text"]

    reg = registry(handler)
    context = ToolRuntimeContext(execution_id="exec-1", run_id="run-1")
    for text in ('error: denied', '{"status":"failed","effect_state":"not_started"}', 'ok'):
        outcome = await reg.dispatch_outcome("example", '{"text": ' + json.dumps(text) + '}', context=context)
        assert outcome.content == text
        assert (outcome.status, outcome.effect_state, outcome.business_success) == ("completed", "reported", None)
        assert context.tool_outcome is outcome
        assert (context.execution_id, context.run_id) == ("exec-1", "run-1")
    assert await reg.dispatch("example", '{"text":"error: denied"}', context=context) == "error: denied"
    assert context.tool_outcome.status == "completed"


async def test_explicit_denial_and_unknown_survive_dispatch_without_mutating_handler_result():
    provided = ToolOutcome("access denied", "denied", "not_started", False,
                           metadata={"reason": "policy"})

    async def handler(args):
        return provided if args.get("deny") else ToolOutcome(
            "uncertain", "unknown", "unknown", None, metadata={"receipt": "pending"},
        )

    reg = registry(handler)
    ctx = ToolRuntimeContext()
    denied = await reg.dispatch_outcome("example", '{"deny":true}', context=ctx)
    assert denied is not provided
    assert (denied.content, denied.status, denied.effect_state, denied.business_success) == (
        "access denied", "denied", "not_started", False,
    )
    assert denied.metadata == {"reason": "policy"}
    assert provided.images == []
    unknown = await reg.dispatch_outcome("example", "{}", context=ctx)
    assert (unknown.status, unknown.effect_state, unknown.business_success) == ("unknown", "unknown", None)
    assert unknown.metadata == {"receipt": "pending"}
    assert ctx.tool_outcome is unknown
    assert await reg.dispatch("example", '{"deny":true}') == "access denied"


async def test_framework_errors_are_not_started_and_keep_exact_compatibility_text():
    async def handler(args):
        raise AssertionError("must not execute")

    reg = registry(handler)
    context = ToolRuntimeContext(tool_outcome=ToolOutcome("stale"))
    unknown = await reg.dispatch_outcome("missing", "{}", context=context)
    assert unknown.content == await reg.dispatch("missing", "{}") == "error: 未知工具: missing"
    assert (unknown.status, unknown.effect_state) == ("failed", "not_started")
    assert context.tool_outcome is unknown
    malformed = await reg.dispatch_outcome("example", '{"broken":', context=context)
    assert malformed.content.startswith("error: 工具参数不是合法 JSON:")
    assert malformed.content == await reg.dispatch("example", '{"broken":')
    assert (malformed.status, malformed.effect_state) == ("failed", "not_started")
    for raw in ("[]", "```json\n[1,2]\n```"):
        invalid = await reg.dispatch_outcome("example", raw, context=context)
        assert invalid.content == "error: 工具参数必须是 JSON 对象"
        assert (invalid.status, invalid.effect_state) == ("failed", "not_started")
    assert context.tool_outcome is invalid


async def test_arguments_repair_and_blank_arguments_remain_compatible():
    async def handler(args):
        return str(args.get("x", "empty"))

    reg = registry(handler)
    assert (await reg.dispatch_outcome("example", '```json\n{"x": 7}\n```')).content == "7"
    assert await reg.dispatch("example", 'prefix {"x":8} suffix') == "8"
    assert (await reg.dispatch_outcome("example", "")).content == "empty"


async def test_handler_exception_has_unknown_effect_and_legacy_error_text():
    async def handler(args):
        raise ValueError("after effect")

    reg = registry(handler)
    ctx = ToolRuntimeContext()
    outcome = await reg.dispatch_outcome("example", "{}", context=ctx)
    assert outcome.content == "error: 工具 example 执行失败: ValueError: after effect"
    assert (outcome.status, outcome.effect_state, outcome.business_success) == ("failed", "unknown", None)
    assert ctx.tool_outcome is outcome
    assert await reg.dispatch("example", "{}") == outcome.content


@pytest.mark.parametrize("structured", [False, True])
async def test_cancellation_propagates_and_owner_can_read_actual_outcome(structured):
    entered = asyncio.Event()
    ctx = ToolRuntimeContext()

    async def handler(args):
        entered.set()
        await asyncio.Future()

    reg = registry(handler)
    task = asyncio.create_task(
        reg.dispatch_outcome("example", "{}", context=ctx) if structured
        else reg.dispatch("example", "{}", context=ctx)
    )
    await entered.wait()
    task.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        assert ctx.tool_outcome is not None
        assert (ctx.tool_outcome.status, ctx.tool_outcome.effect_state) == ("cancelled", "unknown")
        assert ctx.tool_outcome.business_success is None


async def test_images_and_truncated_structured_content_preserve_other_fields():
    original = ToolOutcome("A" * 12000 + "END", "failed", "unknown", False,
                           images=[{"path": "from-handler.png"}], metadata={"code": "E1"})

    async def handler(args):
        current_tool_context().tool_images.append({"path": "from-context.png", "type": "image"})
        return original

    reg = registry(handler)
    ctx = ToolRuntimeContext(tool_images=[{"path": "prior.png"}])
    result = await reg.dispatch_outcome("example", "{}", context=ctx, max_chars=5000)
    assert result.content == truncate_tool_result(original.content, 5000)
    assert len(result.content) <= 5000 and "截断" in result.content
    assert (result.status, result.effect_state, result.business_success) == ("failed", "unknown", False)
    assert result.metadata == {"code": "E1"}
    assert result.images == [{"path": "from-handler.png"}, {"path": "from-context.png", "type": "image"}]
    assert ctx.tool_images == [{"path": "prior.png"}, {"path": "from-context.png", "type": "image"}]
    assert original.content == "A" * 12000 + "END" and original.images == [{"path": "from-handler.png"}]
    assert ctx.tool_outcome is result


async def test_legacy_images_remain_separate_from_text_and_use_per_call_delta():
    async def handler(args):
        current_tool_context().tool_images.append({"path": args["path"], "type": "image"})
        return "image saved"

    reg = registry(handler)
    ctx = ToolRuntimeContext()
    first = await reg.dispatch_outcome("example", '{"path":"one.png"}', context=ctx)
    second = await reg.dispatch_outcome("example", '{"path":"two.png"}', context=ctx)
    assert first.images == [{"path": "one.png", "type": "image"}]
    assert second.images == [{"path": "two.png", "type": "image"}]
    assert ctx.tool_images == first.images + second.images
    assert second.content == "image saved"


async def test_preserve_result_and_original_user_answer_exempt_both_result_types():
    text = "Z" * 12000

    async def handler(args):
        if args.get("user"):
            current_tool_context().preserve_user_answer = True
        return ToolOutcome(text, "completed", "reported", None) if args.get("structured") else text

    reg = registry(handler)
    ctx = ToolRuntimeContext(preserve_user_answer=True)
    for structured in (False, True):
        outcome = await reg.dispatch_outcome(
            "example", '{"structured":' + str(structured).lower() + '}', context=ctx, max_chars=500,
        )
        assert len(outcome.content) <= 500  # stale preserve flag is reset each call
        preserved = await reg.dispatch_outcome(
            "example", '{"structured":' + str(structured).lower() + ',"user":true}',
            context=ctx, max_chars=500,
        )
        assert preserved.content == text
    keep = registry(handler, preserve_result=True)
    assert (await keep.dispatch_outcome("example", '{"structured":true}', max_chars=500)).content == text
    assert await keep.dispatch("example", "{}", max_chars=500) == text


async def test_contextvar_reset_on_success_exception_and_nested_dispatch():
    sentinel = current_tool_context()
    outer_ctx = ToolRuntimeContext(tool_call_id="outer")
    inner_ctx = ToolRuntimeContext(tool_call_id="inner")

    async def inner(args):
        assert current_tool_context() is inner_ctx
        return "inner"

    inner_reg = registry(inner)

    async def outer(args):
        assert current_tool_context() is outer_ctx
        assert await inner_reg.dispatch("example", "{}", context=inner_ctx) == "inner"
        assert current_tool_context() is outer_ctx
        if args.get("raise"):
            raise RuntimeError("failed")
        return "outer"

    reg = registry(outer)
    assert await reg.dispatch("example", "{}", context=outer_ctx) == "outer"
    assert current_tool_context() is sentinel
    assert (await reg.dispatch_outcome("example", '{"raise":true}', context=outer_ctx)).status == "failed"
    assert current_tool_context() is sentinel


async def test_concurrent_calls_never_cross_contexts_and_reset_each_outcome():
    started = 0
    both_started = asyncio.Event()
    contexts = [ToolRuntimeContext(tool_call_id="one"), ToolRuntimeContext(tool_call_id="two")]

    async def handler(args):
        nonlocal started
        ctx = current_tool_context()
        assert ctx.tool_outcome is None
        assert ctx.tool_call_id == args["id"]
        started += 1
        if started == 2:
            both_started.set()
        await both_started.wait()
        assert current_tool_context() is ctx
        return ToolOutcome(args["id"], "completed", "reported", True)

    reg = registry(handler)
    sentinel = current_tool_context()
    outcomes = await asyncio.gather(*(
        reg.dispatch_outcome("example", '{"id":"' + ctx.tool_call_id + '"}', context=ctx)
        for ctx in contexts
    ))
    assert [o.content for o in outcomes] == ["one", "two"]
    assert all(ctx.tool_outcome is o for ctx, o in zip(contexts, outcomes))
    assert current_tool_context() is sentinel
    await reg.dispatch_outcome("example", '{"id":"one"}', context=contexts[0])
    assert contexts[1].tool_outcome is outcomes[1]


async def test_declared_metadata_is_conservative_and_not_added_to_model_schema():
    async def handler(args):
        return "ok"

    reg = registry(handler)
    tool = reg._tools["example"]
    assert (tool.read_only, tool.concurrent_safe, tool.effect_scope) == (False, False, "unknown")
    assert set(reg.schemas()[0]) == {"name", "description", "parameters"}
    opted = registry(handler, read_only=True, concurrent_safe=True, effect_scope="local")
    tool = opted._tools["example"]
    assert (tool.read_only, tool.concurrent_safe, tool.effect_scope) == (True, True, "local")
