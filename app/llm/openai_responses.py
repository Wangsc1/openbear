"""OpenAI Responses 协议 backend —— /v1/responses。

实测 SSE 事件名（Parrot 上游）：
  response.created / response.in_progress
  response.output_item.added / .done           ← function_call item 在这里
  response.content_part.added / .done
  response.output_text.delta / .done           ← 正文增量
  response.reasoning_summary_text.delta / .done ← 思考摘要增量
  response.completed                            ← usage 在这里
  response.incomplete                           ← usage + incomplete_details.reason（截断语义）

出：output_text.delta（正文）/ reasoning_summary_text.delta（思考）/ function_call item（工具）
入：input[] 数组；assistant 工具调用是 function_call item，工具结果是 function_call_output item
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.llm.base import (
    AgentResult,
    LLMBackend,
    Message,
    apply_fast_request_body,
    apply_provider_billing,
    fast_request_parts,
    merge_fast_request_headers,
    provider_billing_details,
)
from app.llm.client import HTTPClient
from app.llm.error_payloads import error_event, read_error
from app.llm.events import StreamEvent, ToolCall, Usage
from app.llm.multimodal import to_openai_responses_content
from app.logging import get_logger
from app.models.thinking import api_effort, normalize_think_level

log = get_logger("llm.responses")


def _normalize_service_tier(value: Any) -> str:
    tier = str(value or "").strip().lower()
    return tier if tier in {"auto", "priority"} else ""


def _is_gpt_model(model: str) -> bool:
    return str(model or "").strip().lower().startswith("gpt-")


def _to_responses_input(messages: list[Message]) -> list[dict[str, Any]]:
    """中性消息 → Responses input[]。"""
    out: list[dict[str, Any]] = []
    for m in messages:
        role = m["role"]
        if role == "system":
            continue  # 用 instructions 顶层传
        if role == "assistant":
            native_items = m.get("native_output_items") or []
            if native_items:
                # Responses output items are already canonical input items. Replaying
                # them verbatim preserves encrypted reasoning and the provider's
                # exact output order; serializing text/tool_calls again would create
                # duplicate assistant turns and break the continuation prefix.
                out.extend(dict(item) for item in native_items if isinstance(item, dict))
                continue
            if m.get("content"):
                out.append({
                    "role": "assistant",
                    "content": to_openai_responses_content(m.get("content"), output=True),
                })
            for i, tc in enumerate(m.get("tool_calls") or []):
                out.append({
                    "type": "function_call",
                    "call_id": tc.id or f"call_{i}",
                    "name": tc.name,
                    "arguments": tc.arguments or "{}",
                })
        elif role == "tool":
            out.append({
                "type": "function_call_output",
                "call_id": m.get("tool_call_id", ""),
                "output": m.get("content") or "",
            })
        else:  # user
            out.append({
                "role": "user",
                "content": to_openai_responses_content(m.get("content")),
            })
    return out


def _output_index(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _item_identity(item: dict[str, Any]) -> tuple[str, str] | None:
    kind = str(item.get("type") or "")
    ident = item.get("id") or (item.get("call_id") if kind == "function_call" else "")
    return (kind, str(ident)) if kind and ident else None


def _order_native_items(
    entries: list[dict[str, Any]],
    terminal_output: list[Any] | None = None,
) -> list[dict[str, Any]]:
    """Restore Responses output order from ``output_index`` without guessing.

    ``response.output_item.done`` events are allowed to finish out of order. Items
    with a known index occupy the indexed slots in ascending order; items with no
    index keep their arrival slot instead of being moved by type. A terminal
    ``response.output`` can supply an index only through an exact, unique
    type+id/call_id match. It is never used to add or rewrite items.
    """
    if not entries:
        return []
    positions: dict[tuple[str, str], list[int]] = {}
    for pos, raw in enumerate(terminal_output or []):
        identity = _item_identity(raw) if isinstance(raw, dict) else None
        if identity:
            positions.setdefault(identity, []).append(pos)
    used = {e["index"] for e in entries if e["index"] is not None}
    indexes: list[int | None] = []
    for entry in entries:
        index = entry["index"]
        if index is None:
            identity = _item_identity(entry["item"])
            found = positions.get(identity, []) if identity else []
            if len(found) == 1 and found[0] not in used:
                index = found[0]
                used.add(index)
        indexes.append(index)
    slots = [i for i, index in enumerate(indexes) if index is not None]
    ordered = [entry["item"] for entry in entries]
    for slot, source in zip(slots, sorted(slots, key=lambda i: indexes[i]), strict=True):
        ordered[slot] = entries[source]["item"]
    return ordered


def _to_responses_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """中性 schema → Responses flat function tools。

    Responses auto-normalizes an omitted strict flag into all-fields-required.
    Keep ordinary tool schemas non-strict so their optional parameters remain
    optional, while preserving an explicit strict choice from the definition.
    """
    if not tools:
        return None
    return [
        {"type": "function", "name": t["name"], "description": t.get("description", ""),
         "parameters": t.get("parameters", {"type": "object", "properties": {}}),
         "strict": t.get("strict", False)}
        for t in tools
    ]


def _usage_from(u: dict[str, Any]) -> Usage:
    input_details = u.get("input_tokens_details") or u.get("prompt_tokens_details") or {}
    cached = (
        input_details.get("cached_tokens")
        or input_details.get("cache_read_tokens")
        or u.get("cache_read_tokens")
        or u.get("cached_tokens")
        or 0
    )
    cache_write = (
        input_details.get("cache_creation_tokens")
        or input_details.get("cache_write_tokens")
        or u.get("cache_creation_tokens")
        or u.get("cache_write_tokens")
        or 0
    )
    input_total = u.get("input_tokens", 0) or 0
    output = u.get("output_tokens", 0) or 0
    # OpenAI-compatible usage totals include both cache reads and cache
    # creation when those detail fields are present. Keep Usage's input/cache
    # axes non-overlapping so context and cost do not count a cache write twice.
    input_uncached = max(0, input_total - cached - cache_write)
    return Usage(
        input_tokens=input_uncached,
        output_tokens=output,
        total_tokens=u.get("total_tokens", 0) or (input_uncached + output + cached + cache_write),
        cache_read_tokens=cached,
        cache_write_tokens=cache_write,
    )


class OpenAIResponsesBackend(LLMBackend):
    protocol = "responses"

    def __init__(self, client: HTTPClient, base_url: str, api_key: str) -> None:
        self._client = client
        self._base = base_url.rstrip("/")
        self._key = api_key

    def _headers(self, session_id: str | None = None, *, fast_headers: Any = None) -> dict[str, str]:
        h = {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}
        if session_id:
            h["session-id"] = session_id
        return merge_fast_request_headers(h, fast_headers)

    def build_payload(
        self,
        messages: list[Message],
        *,
        model: str,
        system: str = "",
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 8192,
        stream: bool = True,
        **opts: Any,
    ) -> dict[str, Any]:
        think_level = opts.get("think_level")
        session_id = opts.get("session_id")
        service_tier = opts.get("service_tier")
        payload: dict[str, Any] = {
            "model": model,
            "input": _to_responses_input(messages),
            "stream": stream,
            "max_output_tokens": max_tokens,
        }
        level = normalize_think_level(think_level) if think_level else None
        effort = api_effort(level) if level else None
        if effort:
            # Keep internal reasoning enabled without asking the provider to emit
            # fragmented, user-visible reasoning-summary deltas.
            payload["reasoning"] = {"effort": effort}
        normalized_service_tier = _normalize_service_tier(service_tier)
        if normalized_service_tier:
            payload["service_tier"] = normalized_service_tier
        if system:
            payload["instructions"] = system
        rtools = _to_responses_tools(tools)
        if rtools:
            payload["tools"] = rtools
            payload["tool_choice"] = "auto"
        if _is_gpt_model(model):
            # GPT family supports parallel function calling; request it explicitly
            # so providers/proxies do not default to serial tool calls.
            payload["parallel_tool_calls"] = True
        if session_id:
            # Responses 用 prompt_cache_key 做缓存亲和（对齐 parrot 约定）
            payload["prompt_cache_key"] = session_id
        if opts.get("native_continuation"):
            # Rath Agent keeps the durable transcript locally. Ask Responses for
            # opaque reasoning state so the next request can replay one canonical,
            # cacheable chain without relying on provider-side retention.
            payload["store"] = False
            payload["include"] = ["reasoning.encrypted_content"]
        fast_body, _ = fast_request_parts(opts.get("fast_request"))
        return apply_fast_request_body(payload, fast_body)

    async def stream(
        self, messages: list[Message], *, model: str, system: str = "",
        tools: list[dict[str, Any]] | None = None, max_tokens: int = 8192, **opts: Any,
    ) -> AsyncIterator[StreamEvent]:
        sid = opts.get("session_id")
        _, fast_headers = fast_request_parts(opts.get("fast_request"))
        payload = self.build_payload(
            messages,
            model=model,
            system=system,
            tools=tools,
            max_tokens=max_tokens,
            stream=True,
            think_level=opts.get("think_level"),
            session_id=sid,
            service_tier=opts.get("service_tier"),
            native_continuation=opts.get("native_continuation"),
            fast_request=opts.get("fast_request"),
        )
        url = f"{self._base}/responses"

        encrypted_reasoning: dict[str, str] = {}
        final_usage: Usage | None = None
        provider_billing: dict[str, Any] = {}
        stop = "stop"
        # Native items are ordered by output_index once the item set is known.
        # Text deltas, tool events and tool scheduling are still not delayed:
        # tool calls were already emitted only after the SSE stream ended.
        # Keep the same latest done payload for replay and tool execution,
        # including when native continuation is disabled. Entries retain their
        # first-completion slot so independent tool execution is not reordered.
        output_entries: list[dict[str, Any]] = []
        output_by_index: dict[int, dict[str, Any]] = {}
        added_indexes: dict[tuple[str, str], int] = {}
        terminal_output: list[Any] | None = None

        def flush_native() -> list[StreamEvent]:
            items = _order_native_items(output_entries, terminal_output) if opts.get("native_continuation") else []
            output_entries.clear()
            output_by_index.clear()
            return [StreamEvent(kind="native_output_item", native_output_items=[item]) for item in items]

        async for ev_name, data in self._client.post_sse(
            url,
            self._headers(sid, fast_headers=fast_headers),
            payload,
            protocol="responses",
            first_byte_timeout_s=opts.get("first_byte_timeout_s"),
            total_timeout_s=opts.get("total_timeout_s"),
        ):
            if ev_name == "__openbear_metrics__":
                yield StreamEvent(kind="metrics", connect_ms=int(data.get("connect_ms") or 0))
                continue
            t = data.get("type") or ev_name
            if t in ("response.completed", "response.incomplete", "response.failed"):
                resp = data.get("response") or {}
                if isinstance(resp.get("output"), list):
                    terminal_output = resp["output"]
                u = resp.get("usage") or {}
                terminal_billing = provider_billing_details(
                    resp.get("service_tier") or u.get("service_tier"),
                    u,
                )
                if terminal_billing:
                    provider_billing.update(terminal_billing)
                if u:
                    final_usage = _usage_from(u)
                if t == "response.incomplete":
                    # Responses 用 incomplete + incomplete_details.reason 表达「未正常收尾」，
                    # 而 Anthropic / Chat 用 max_tokens / length。不归一化的话 finish 会永远
                    # 停在 "stop"，Agent 层就会把「输出被截断」误判成「模型偶发没输出」。
                    details = resp.get("incomplete_details")
                    reason = str(details.get("reason") or "") if isinstance(details, dict) else ""
                    if reason == "max_output_tokens":
                        stop = "length"
                    elif reason:
                        stop = reason
                if t == "response.failed" or resp.get("status") == "failed":
                    # Failed Responses may still carry billable usage. Emit it
                    # before the normalized terminal error.
                    for native_event in flush_native():
                        yield native_event
                    if final_usage:
                        yield StreamEvent(
                            kind="usage",
                            usage=final_usage,
                            details=dict(provider_billing),
                        )
                        final_usage = None
                    parsed = read_error(data, event_name="response.failed")
                    if parsed:
                        yield parsed.stream_event()
                    else:
                        yield StreamEvent(kind="error", error="responses failed")
                    return
            err = error_event(data, event_name=ev_name)
            if err:
                for native_event in flush_native():
                    yield native_event
                yield err
                return
            if t == "response.output_text.delta":
                yield StreamEvent(kind="content", text=data.get("delta", ""))
            elif t == "response.reasoning_summary_text.delta":
                yield StreamEvent(kind="reasoning", text=data.get("delta", ""))
            elif t in {"response.output_item.added", "response.output_item.done"}:
                item = data.get("item") or {}
                if isinstance(item, dict) and item:
                    encrypted = item.get("encrypted_content")
                    if item.get("type") == "reasoning" and isinstance(encrypted, str) and encrypted:
                        # Added/done carry complete opaque values, not deltas.
                        # Keep each item's latest value; this display-only event
                        # must not enter readable reasoning or model history.
                        key = str(item.get("id") or data.get("output_index", 0))
                        encrypted_reasoning[key] = encrypted
                        yield StreamEvent(
                            kind="encrypted_reasoning",
                            text="\n\n".join(encrypted_reasoning.values()),
                        )
                    identity = _item_identity(item)
                    index = _output_index(data.get("output_index"))
                    if t != "response.output_item.done":
                        if identity and index is not None:
                            added_indexes[identity] = index
                        continue
                    if index is None and identity:
                        index = added_indexes.get(identity)
                    entry = output_by_index.get(index) if index is not None else None
                    if entry is not None:
                        entry["item"] = item  # repeated done for one output slot
                    else:
                        entry = {"item": item, "index": index}
                        output_entries.append(entry)
                        if index is not None:
                            output_by_index[index] = entry

        # Only native replay uses output_index ordering. Tools keep completion
        # order, but consume the same final payload rather than stale duplicates.
        calls = [
            ToolCall(
                id=item.get("call_id") or item.get("id", ""),
                name=item.get("name", ""),
                arguments=item.get("arguments", "") or "{}",
            )
            for entry in output_entries
            if (item := entry["item"]).get("type") == "function_call"
        ]
        for native_event in flush_native():
            yield native_event
        if final_usage:
            yield StreamEvent(
                kind="usage",
                usage=final_usage,
                details=dict(provider_billing),
            )
        if calls:
            stop = "tool_calls"
            yield StreamEvent(kind="tool_call", tool_calls=calls)
        yield StreamEvent(kind="finish", finish_reason=stop, details=dict(provider_billing))

    async def complete(
        self, messages: list[Message], *, model: str, system: str = "",
        tools: list[dict[str, Any]] | None = None, max_tokens: int = 8192, **opts: Any,
    ) -> AgentResult:
        sid = opts.get("session_id")
        _, fast_headers = fast_request_parts(opts.get("fast_request"))
        payload = self.build_payload(
            messages,
            model=model,
            system=system,
            tools=tools,
            max_tokens=max_tokens,
            stream=False,
            think_level=opts.get("think_level"),
            session_id=sid,
            service_tier=opts.get("service_tier"),
            native_continuation=opts.get("native_continuation"),
            fast_request=opts.get("fast_request"),
        )
        url = f"{self._base}/responses"
        data = await self._client.post_json(
            url,
            self._headers(sid, fast_headers=fast_headers),
            payload,
            protocol="responses",
            read_timeout_s=opts.get("read_timeout_s"),
        )
        parsed_error = read_error(data)
        if parsed_error:
            from app.llm.base import OpenBearLLMError
            error = OpenBearLLMError(
                parsed_error.message,
                **parsed_error.exception_kwargs(protocol="responses"),
            )
            u = data.get("usage") or {}
            error.usage = _usage_from(u)
            apply_provider_billing(
                error,
                provider_billing_details(data.get("service_tier") or u.get("service_tier"), u),
            )
            raise error
        result = AgentResult()
        output_items = [dict(item) for item in (data.get("output") or []) if isinstance(item, dict)]
        if opts.get("native_continuation"):
            result.native_output_items = output_items
        for item in output_items:
            it = item.get("type")
            if it == "message":
                for part in item.get("content") or []:
                    if part.get("type") in ("output_text", "text"):
                        result.text += part.get("text", "")
            elif it == "reasoning":
                for part in item.get("summary") or []:
                    if part.get("type") in ("summary_text", "text"):
                        result.reasoning += part.get("text", "")
            elif it == "function_call":
                result.tool_calls.append(ToolCall(
                    id=item.get("call_id") or item.get("id", ""),
                    name=item.get("name", ""),
                    arguments=item.get("arguments", "") or "{}",
                ))
        u = data.get("usage") or {}
        result.usage = _usage_from(u)
        apply_provider_billing(
            result,
            provider_billing_details(data.get("service_tier") or u.get("service_tier"), u),
        )
        result.finish_reason = "tool_calls" if result.tool_calls else "stop"
        return result
