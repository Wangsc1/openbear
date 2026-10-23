"""Next-message suggestions offered above the Web composer after a turn."""
from __future__ import annotations

import json
import re
from typing import Any

from app.conversation_titles import render_naming_transcript, select_naming_turns

DEFAULT_SUGGESTION_PROMPT = (
    "你在为 AI 助手控制台预测：用户读完助手最新的回复后，最可能在输入框里输入并发送的下一条消息。\n"
    "先看用户最近说的话和他最初的请求。要预测的是他自己会打出来的话，而不是你认为他应该做的事；"
    "检验标准是用户看到时会觉得“我正想这么说”。\n"
    "常见情况：助手给出了几个选项，就给出用户最可能选的那个；助手问要不要继续，就给出肯定的答复；"
    "任务已经完成且下一步很明确，就给出那一步；助手报告了问题，就让它去修；用户也可能就回复里的某个具体内容追问。\n"
    "要求：\n"
    "- 每条都是用户对助手说的话（让它做事、追问，或答复它的问题），不是用户的自言自语；沿用用户的语言、称呼和说话风格。\n"
    "- 具体优先：“跑一下前端测试”好过“继续”。\n"
    "- 每条一句话，通常 4 到 30 个字，不超过 60 个字；各条是不同的下一步，不要把同一个意思换种说法凑数；"
    "按可能性从高到低排列，第一条是用户最可能说的。\n"
    "- 对话里“（在交互面板中回答）”开头的是用户在确认面板里的选择和补充，“（系统：……）”是系统通知，"
    "都不是用户打字的样子，不要模仿，也不要把系统通知当成用户说的话。\n"
    "不要写：评价或客套（“不错”“谢谢”）；助手的口吻（“我来……”“让我……”）；用户从未提过的新想法；"
    "泛泛的问题；多句话、列表、编号或引号。\n"
    "下一步不明显时（例如刚出错、助手理解错了用户的意思、需要用户自己判断），宁可少给或不给。\n"
    "只输出一个 JSON 字符串数组，例如 [\"跑一下前端测试\", \"手机端也看一下\"]；没有合适的就输出 []。"
)
SUGGESTION_MAX_CHARS = 80
TRANSCRIPT_MAX_TURNS = 6
TRANSCRIPT_MAX_CHARS = 24_000
_NOTIFICATION_PREFIX = "<task-notification>"
_RUNTIME_PREFIX = "<openbear-"
_STOPPED_TEXT = "⏹ 已停止"
_LIST_MARKER = re.compile(r"^\s*(?:[-*•·]|\d+\s*[.)）、．:：]|[（(]\d+[）)])\s*")
_QUOTES = "\"'“”‘’「」『』`"
_ASSISTANT_VOICE = re.compile(r"^(?:我来|让我|我会|我将|我先|好的[，,]\s*我|下面我)")
_META = re.compile(r"^(?:无|没有|暂无|none|null|n/?a|\[\s*\])[。.!！]?$", re.IGNORECASE)
# Pure pleasantries only; "好的，提交吧" carries an instruction and stays.
_PLEASANTRY = re.compile(
    r"^(?:谢谢(?:你|啦|了)?|多谢|感谢|辛苦(?:了|啦)?|不错|很好|挺好|太好了|太棒了|很棒|完美|厉害|牛|nice|great|thanks?(?: you)?)"
    r"[\s，,。.!！~～]*$",
    re.IGNORECASE,
)


def _notification_text(content: str) -> str:
    body = content[len(_NOTIFICATION_PREFIX):].split("</task-notification>", 1)[0]
    try:
        summary = str(json.loads(body).get("summary") or "").strip()
    except (ValueError, AttributeError):
        summary = ""
    return f"（系统：后台 Agent 任务结束通知{'：' + summary if summary else ''}）"


def interaction_answer_text(content: str) -> str:
    """Render the user's own words from a stored UserInteraction result."""
    try:
        data = json.loads(content or "")
    except ValueError:
        return ""
    if not isinstance(data, dict) or data.get("cancelled") or str(data.get("status") or "") != "answered":
        return ""
    parts: list[str] = []
    labels = [str(item) for item in data.get("selectedLabels") or [] if str(item or "").strip()]
    if labels:
        parts.append("选择：" + "、".join(labels))
    elif data.get("action") == "confirm" and data.get("label"):
        parts.append(f"点击：{data['label']}")
    if str(data.get("value") or "").strip():
        parts.append(f"填写：{str(data['value']).strip()}")
    for answer in data.get("answers") or []:
        if not isinstance(answer, dict):
            continue
        chosen = "、".join(str(item) for item in answer.get("selectedValues") or [] if str(item or "").strip())
        text = str(answer.get("text") or "").strip()
        if chosen or text:
            parts.append(f"{answer.get('questionId') or '回答'}：{'；'.join(item for item in (chosen, text) if item)}")
    if str(data.get("text") or "").strip():
        parts.append(f"补充：{str(data['text']).strip()}")
    return f"（在交互面板中回答）{'；'.join(parts)}" if parts else ""


def suggestion_turns(rows: list[dict[str, Any]], display_text=lambda text: text) -> list[dict[str, str]]:
    """Group controller rows into turns of user words and the final visible reply.

    ``rows`` are main-controller messages in id order with role, name, content,
    turn_uuid and run_root_turn_uuid. Interaction answers count as user words;
    only the last assistant text of a turn is its reply.
    """
    turns: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for row in rows:
        role = str(row.get("role") or "")
        content = str(row.get("content") or "")
        root = str(row.get("run_root_turn_uuid") or row.get("turn_uuid") or "")
        if role == "user":
            if content.startswith(_RUNTIME_PREFIX):
                continue
            key = root or f"message:{row.get('id')}"
            if key not in turns:
                turns[key] = {"user": [], "assistant": ""}
                order.append(key)
            text = _notification_text(content) if content.startswith(_NOTIFICATION_PREFIX) else display_text(content).strip()
            if text:
                turns[key]["user"].append(text)
        elif root not in turns:
            continue
        elif role == "tool" and row.get("name") == "UserInteraction":
            text = interaction_answer_text(content)
            if text:
                turns[root]["user"].append(text)
        elif role == "assistant":
            text = display_text(content).strip()
            if text and text != _STOPPED_TEXT:
                turns[root]["assistant"] = text
    return [
        {"user": "\n\n".join(turns[key]["user"]), "assistant": turns[key]["assistant"]}
        for key in order if turns[key]["user"] and turns[key]["assistant"]
    ]


def render_suggestion_request(turns: list[dict[str, str]], count: int) -> str:
    selected = select_naming_turns(turns, max_turns=TRANSCRIPT_MAX_TURNS, max_chars=TRANSCRIPT_MAX_CHARS)
    transcript = render_naming_transcript(selected)
    if not transcript:
        return ""
    return (
        f"以下是最近的对话，越往下越新：\n\n{transcript}\n\n"
        f"请预测用户接下来最可能发送的消息，最多 {max(1, int(count))} 条。"
    )


def _clean_item(value: Any) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = _LIST_MARKER.sub("", text).strip().strip(_QUOTES).strip()
    return text


def parse_suggestions(text: str, count: int) -> list[str]:
    raw = str(text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[\w-]*\s*|\s*```$", "", raw).strip()
    items: list[Any] | None = None
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
        except ValueError:
            parsed = None
        if isinstance(parsed, list):
            items = parsed
    if items is None:
        items = raw.splitlines()
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        if isinstance(item, dict):
            item = item.get("text") or item.get("message") or ""
        cleaned = _clean_item(item)
        if (not cleaned or len(cleaned) > SUGGESTION_MAX_CHARS or _META.match(cleaned)
                or _ASSISTANT_VOICE.match(cleaned) or _PLEASANTRY.match(cleaned)):
            continue
        key = re.sub(r"[\s\W_]+", "", cleaned.lower())
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
        if len(out) >= max(1, int(count)):
            break
    return out


def stored_suggestions(raw: Any) -> dict[str, Any]:
    """Decode the per-conversation column; anything malformed means none."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    items = [str(item) for item in data.get("items") or [] if str(item or "").strip()]
    if not items:
        return {}
    return {"turnUuid": str(data.get("turnUuid") or ""), "items": items, "createdAtMs": int(data.get("createdAtMs") or 0)}
