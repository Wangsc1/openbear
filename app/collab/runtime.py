"""Per-turn wiring: member tool view, waits on requests, boundary notes, confirm routing."""
from __future__ import annotations

import json
from typing import Any

from app.collab.store import member_row, now_ms

# Removed from a member's model view and refused at dispatch.
MEMBER_DENIED_TOOLS = frozenset({"UserInteraction", "Cron", "Webhook", "ConversationGroup"})


class MemberToolRegistry:
    """Hide and refuse lead-only tools for a group member, in schema and dispatch."""

    def __init__(self, registry: Any) -> None:
        self.registry = registry
        self.file_state = getattr(registry, "file_state", None)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.registry, name)

    def schemas(self, scope=None):
        return [s for s in self.registry.schemas(scope=scope)
                if s.get("name", s.get("function", {}).get("name")) not in MEMBER_DENIED_TOOLS]

    def names(self, scope=None, source=None):
        return [n for n in self.registry.names(scope=scope, source=source) if n not in MEMBER_DENIED_TOOLS]

    def summaries(self, scope=None, source=None):
        return {k: v for k, v in self.registry.summaries(scope=scope, source=source).items() if k not in MEMBER_DENIED_TOOLS}

    async def dispatch(self, name, arguments, **kwargs):
        if name in MEMBER_DENIED_TOOLS:
            from app.runtime.tool_result import ToolOutcome
            from app.tools.base import current_tool_context
            context = kwargs.get("context") or current_tool_context()
            result = ToolOutcome(f"error: 小组成员不能使用 {name}；需要老大处理的事请交给主会话。", "failed", "not_started")
            context.tool_outcome = result
            return result.content
        return await self.registry.dispatch(name, arguments, **kwargs)


def filter_member_prompt_params(params: dict[str, Any]) -> dict[str, Any]:
    from app.context.builder import _mcp_tool_groups, build_system_prompt_params
    out = dict(params)
    for name in ("toolNames", "builtinToolNames", "mcpToolNames"):
        out[name] = [n for n in out.get(name, []) if n not in MEMBER_DENIED_TOOLS]
    for name in ("toolSummaries", "builtinToolSummaries", "mcpToolSummaries"):
        out[name] = {n: d for n, d in out.get(name, {}).items() if n not in MEMBER_DENIED_TOOLS}
    servers = {group["server"] for group in _mcp_tool_groups(out["mcpToolNames"])}
    filtered = build_system_prompt_params(
        tool_names=out["toolNames"], tool_summaries=out["toolSummaries"],
        builtin_tool_names=out["builtinToolNames"], builtin_tool_summaries=out["builtinToolSummaries"],
        mcp_tool_names=out["mcpToolNames"], mcp_tool_summaries=out["mcpToolSummaries"],
        mcp_server_instructions=[i for i in out.get("mcpServerInstructions", []) if i.get("server") in servers])
    for key in ("tools", "mcpToolGroups", "mcpServerInstructions"):
        out[key] = filtered[key]
    return out


def notes_message(rows: list[dict[str, Any]]) -> str:
    lines = ["<collab-runtime-notes internal=\"true\">", "系统同步的协作事实（不是新的用户消息）："]
    for row in rows:
        lines.append(f"- {row['body']}")
    lines.append("</collab-runtime-notes>")
    return "\n".join(lines)


async def bind_turn(host, ctx, *, conversation: dict[str, Any], root_turn_uuid: str, collab_request_id: str,
                    human_text: str, user_source: str) -> dict[str, Any]:
    """Return member identity for this turn and record human words for the lead."""
    service = getattr(host, "collab", None)
    if service is None:
        return {}
    conv_uuid = str(conversation.get("conversation_uuid") or "")
    member = await member_row(host.db.conn, conv_uuid)
    if collab_request_id:
        await service.mark_working(collab_request_id)
    if member:
        original_confirm = ctx.web_confirm

        async def lead_confirm(payload: dict[str, Any]) -> dict[str, Any]:
            # A member never asks the human. A tool-owned gate is shown in the
            # lead conversation; only the human there can approve it.
            lead = await service.conversation(member["lead_conversation_uuid"])
            if lead is None or original_confirm is None:
                return {"status": "error", "confirmed": False, "error": "lead_unavailable"}
            forwarded = dict(payload)
            forwarded["title"] = f"[{member['group_name']} · {member['name']}] {payload.get('title') or '请确认'}"
            forwarded["body"] = (f"小组成员「{member['name']}」请求执行需要老大确认的操作。主会话不能代为批准。\n\n"
                                 + str(payload.get("body") or ""))
            return await host._web_confirm(lead["conversation_uuid"], forwarded)

        ctx.web_confirm = lead_confirm if original_confirm is not None else None
        if not collab_request_id and user_source in {"web", "telegram"} and human_text.strip():
            await service.add_note(member["lead_conversation_uuid"],
                                   "member_human_message",
                                   f"老大在成员「{member['name']}」（{member['group_name']}）的会话里直接说：{human_text.strip()[:2000]}",
                                   group_uuid=member["group_uuid"])
    return {"member": member}


def bind_finish(host, ctx, *, collab_request_id: str) -> None:
    """A receiver that ends without declaring an outcome is asked once to declare it."""
    service = getattr(host, "collab", None)
    if service is None or not collab_request_id:
        return
    original = ctx.finish_policy
    reminded = {"done": False}

    async def finish(text: str) -> dict[str, Any]:
        decision = await original(text) if original else {"action": "close"}
        if decision.get("action") != "close" or reminded["done"]:
            return decision
        row = await service.request(collab_request_id)
        if not row or row["state"] not in {"delivered", "working"} or row.get("declaration_json"):
            return decision
        reminded["done"] = True
        service.hold_result(collab_request_id, text)
        return {"action": "continue", "message": (
            "<collab-request-protocol internal=\"true\">你在处理另一个会话的请求，但还没有声明结果。"
            "调用 ConversationRequest(action=respond) 声明 outcome：completed（附一句说明）、"
            "needs_input（写清缺什么）或 rejected（写明原因）。上面的正文已作为结果保留，声明后不必重写。"
            "</collab-request-protocol>")}

    ctx.finish_policy = finish


async def wait_requests(host, *, conversation_uuid: str, root_turn_uuid: str) -> list[dict[str, Any]]:
    service = getattr(host, "collab", None)
    if service is None or not conversation_uuid:
        return []
    return await service.awaiting_sender(conversation_uuid, root_turn_uuid)


def wait_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    from app.collab.store import STATE_LABELS
    return {
        "waiting": len(rows),
        "requests": [{"requestId": r["request_uuid"], "title": r["title"], "state": r["state"],
                      "stateLabel": STATE_LABELS.get(r["state"], r["state"])} for r in rows],
    }


async def wait_status_text(host, rows: list[dict[str, Any]], *, agents_running: int) -> str:
    """Name who the controller is waiting on; Agents keep their existing wording."""
    if not rows:
        return ""
    from app.collab.store import conversation_titles
    titles = await conversation_titles(host.db.conn, [r["to_conversation_uuid"] for r in rows])
    names = list(dict.fromkeys(titles.get(r["to_conversation_uuid"]) or "另一个会话" for r in rows))
    who = "、".join(f"「{name}」" for name in names[:3]) + (f" 等 {len(names)} 个会话" if len(names) > 3 else "")
    return f"等待{who}" + (f"，以及 {agents_running} 个 Agent" if agents_running else "")


def request_payload_marker(payload: dict[str, Any]) -> bool:
    return str(payload.get("kind") or "") == "task-notification-collab"


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


__all__ = ["MEMBER_DENIED_TOOLS", "MemberToolRegistry", "bind_finish", "bind_turn", "filter_member_prompt_params", "notes_message",
           "request_payload_marker", "wait_requests", "wait_status_text", "wait_summary", "now_ms"]
