"""Narrow Anthropic prefix-binding compatibility, never signature repair."""
from __future__ import annotations

import copy

from app.llm.base import Message, OpenBearLLMError

THINKING_RECOVERY_NOTICE = (
    "上游拒绝复用与当前对话前缀不兼容的旧思考；已从活动上下文撤下旧思考，准备重试一次。"
    "正文、工具调用与已完成结果保留，原始历史未删除。"
)


def is_anthropic_prefix_mismatch(error: OpenBearLLMError, *, protocol: str) -> bool:
    """Require a diagnosed prefix mismatch, not just invalid/decryption signatures.

    Do not infer from local system/tools changes, arbitrary 400s, or nested
    historical gateway attempts. Only the effective 400 root cause qualifies.
    """
    if protocol != "anthropic" or (error.upstream_status or error.status) != 400:
        return False
    if (error.reason in {"auth", "auth_permanent", "billing"}
            or error.transport_status in {401, 403} or error.status in {401, 403}):
        return False
    if "prefix_binding_mismatch" in (
        error.reason, error.root_cause.get("code"), error.root_cause.get("classification"),
    ):
        return True
    text = error.message.lower().replace("`", "")
    return ("invalid signature in thinking block" in text
            and "the block is bound to a different conversation" in text)


def strip_anthropic_thinking(messages: list[Message]) -> tuple[list[Message], bool]:
    """Return an active-context derivative; never mutate transcript/source blocks.

    Errors do not reliably map wire block indices (merged users/role bridges) to
    source messages. Use the documented request-wide thinking removal fallback,
    retaining every non-thinking native item verbatim, including text/tool IDs.
    No permanent suppression: fresh thinking from the recovery is replayable.
    """
    result = copy.deepcopy(messages)
    changed = False
    for message in result:
        if message.get("role") != "assistant":
            continue
        native = message.get("native_output_items") or []
        kept = [item for item in native if not (
            isinstance(item, dict) and item.get("type") in {"thinking", "redacted_thinking"})]
        if len(kept) != len(native) or message.get("signature"):
            changed = True
            if "native_output_items" in message:
                message["native_output_items"] = kept
            message.pop("reasoning", None)
            message.pop("signature", None)
    return result, changed
