"""Shared, model-free context-window selection for Controller and Agent runners.

The selector owns no permissions, persistence, or tool execution. Callers provide
trusted provenance and a complete request estimator; a soft target is never a
promise about a provider's tokenizer. Tool call/result shells remain paired;
seen result bodies may become history references under required-input pressure.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from PIL import Image

from app.agent.native_continuation import (
    sanitize_paired_messages,
    serialize_messages,
    validate_model_context,
)
from app.llm.base import Message
from app.utils import estimate_tokens

CONTEXT_META = "openbear_context_source"
PINNED_KINDS = frozenset({"human", "task", "cron", "control", "decision", "required_runtime", "legacy_handoff", "summary"})
_MEDIA_TYPES = frozenset({"image", "image_url", "input_image", "input_audio", "input_file", "audio"})
_IMAGE_TYPES = frozenset({"image", "image_url", "input_image"})
# User-visible inputs whose text survives as dialogue after their round leaves
# the execution window. Tool images and runtime snapshots are not dialogue.
_DIALOGUE_INPUT_KINDS = frozenset({"human", "task", "cron", "webhook", "control", "decision", "summary", "legacy_handoff"})
# Must equal app.references.BUNDLE_FIELD; importing it here would be circular.
_REFERENCE_BUNDLE = "openbear_reference_bundle"
# Enough base64 to reach the size header of PNG/GIF/WebP and of most JPEGs.
_IMAGE_HEAD_CHARS = 65_536
_IMAGE_DEFAULT_TOKENS = 1_600

WINDOW_SYSTEM_POLICY = """## Context window runtime
OpenBear's sliding window pins the current execution round's original user/task instructions, current controls and confirmation exchanges, their limited immediate assistant antecedents, and the latest runtime state. Older rounds' user messages, assistant replies, summaries and decisions are optional history retained only within the recent complete-batch budget. Older records may be outside the active window but remain retrievable where recorded. No model generates a new compaction summary, and no pre-compaction memory-writing checkpoint is required. These runtime facts replace older descriptions of automatic summary compaction in this system prompt; they do not change user instructions or authorization.
Continue directly when the available evidence is sufficient. Use History's execution source (Agent: AgentHistory, limited to your own instance) only for a concrete missing fact. Do not ask for established requirements again or bulk-write memory merely because the window changed. A proposed action is not an observed task state. A timed-out wait does not prove a tool or background operation stopped: establish its actual state before repeating an effect.
"""


class UnsafeWindowBoundary(ValueError):
    """The current protocol batch is not complete; nothing may be evicted."""


class ActiveContextUnavailable(ValueError):
    """The owning runner cannot locate its current input; do not evict on a guess."""


class RequiredContextTooLarge(ValueError):
    def __init__(self, estimated_tokens: int, input_ceiling: int) -> None:
        self.estimated_tokens = estimated_tokens
        self.input_ceiling = input_ceiling
        super().__init__(
            f"required_context_too_large: required input is estimated at {estimated_tokens} "
            f"tokens, above the safe input allowance {input_ceiling}; "
            "the configured compression threshold was not raised and instructions were not truncated; "
            "context compression could not fit the required input, so execution is blocked."
        )


def source_of(message: Message) -> dict[str, Any]:
    value = message.get(CONTEXT_META)
    return value if isinstance(value, dict) else {}


def mark_source(message: Message, *, kind: str = "execution", source_id: str = "", **metadata: Any) -> Message:
    """Attach runtime-owned provenance. Never infer authority from message text."""
    old = source_of(message)
    message[CONTEXT_META] = {
        **old, **metadata,
        "id": source_id or str(old.get("id") or uuid.uuid4()),
        "kind": kind,
    }
    return message


_NATIVE_KEYS = ("native_output_items", "reasoning", "signature")


def neutral_context(messages: list[Message]) -> list[Message]:
    """Start a fresh protocol chain without partially rewriting opaque turns."""
    result = copy.deepcopy(messages)
    for message in result:
        for key in _NATIVE_KEYS:
            message.pop(key, None)
    return result


def neutral_view(messages: list[Message]) -> list[Message]:
    """neutral_context() for read-only use: nested values are shared, never mutate them."""
    return [{key: value for key, value in message.items() if key not in _NATIVE_KEYS} for message in messages]


def sanitize_window_checkpoint(messages: list[Message]) -> tuple[list[Message], int]:
    """Keep interrupted-batch originals immutable; closed views are derivatives."""
    safe, dropped = sanitize_paired_messages(messages)
    originals = {source_of(message).get("id"): message for message in messages if source_of(message).get("id")}
    for message in safe:
        source = source_of(message)
        original = originals.get(source.get("id"))
        if original is None:
            continue
        old, new = serialize_messages(neutral_context([original, message]))
        old.pop(CONTEXT_META, None)
        new.pop(CONTEXT_META, None)
        if old != new:
            digest = hashlib.sha256(json.dumps(new, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            mark_source(message, kind=str(source.get("kind") or "execution"),
                        source_id=f"{source['id']}/closed:{digest}", derived_from=source["id"],
                        message_id=0, reference_only=False)
    return safe, dropped


def protocol_groups(messages: list[Message]) -> list[tuple[int, int]]:
    if not validate_model_context(messages):
        raise UnsafeWindowBoundary("unclosed_or_invalid_tool_batch")
    groups: list[tuple[int, int]] = []
    index = 0
    while index < len(messages):
        start = index
        message = messages[index]
        index += 1
        if message.get("role") == "assistant":
            index += len(message.get("tool_calls") or [])
        groups.append((start, index))
    return groups


def _image_tokens_for_size(width: int, height: int) -> int:
    # Claude's published downscale (1568px long edge, ~1.15MP) and px/750 rule.
    # Other providers differ; real usage calibration absorbs the remainder.
    scale = min(1.0, 1568 / max(width, height), (1_150_000 / (width * height)) ** 0.5)
    return max(1, int(width * height * scale * scale / 750))


@lru_cache(maxsize=4096)
def _inline_image_tokens(head: str) -> int:
    head = head[:len(head) - len(head) % 4]
    try:
        with Image.open(io.BytesIO(base64.b64decode(head))) as image:
            return _image_tokens_for_size(*image.size)
    except Exception:
        return _IMAGE_DEFAULT_TOKENS


@lru_cache(maxsize=4096)
def _file_image_tokens(path: str) -> int:
    try:
        with Image.open(path) as image:
            return _image_tokens_for_size(*image.size)
    except Exception:
        return _IMAGE_DEFAULT_TOKENS


def _media_tokens(block: dict[str, Any]) -> int:
    """A size-based guess for images; audio/files stay at 0 and unknown."""
    if block.get("type") not in _IMAGE_TYPES:
        return 0
    source = block.get("source")
    if isinstance(source, dict) and source.get("type") == "base64":
        return _inline_image_tokens(str(source.get("data") or "")[:_IMAGE_HEAD_CHARS])
    url = block.get("image_url")
    if isinstance(url, dict):
        url = url.get("url")
    if isinstance(url, str) and url.startswith("data:"):
        return _inline_image_tokens(url.partition(",")[2][:_IMAGE_HEAD_CHARS])
    if block.get("path"):
        return _file_image_tokens(str(block["path"]))
    return _IMAGE_DEFAULT_TOKENS


def _text_payload(value: Any) -> tuple[Any, bool, int]:
    if isinstance(value, dict):
        if isinstance(value.get("type"), str) and value["type"] in _MEDIA_TYPES:
            # Vision/audio cost is provider-dependent. Neither file bytes nor a
            # base64 string is a trustworthy token count.
            return {"type": "media_size_unknown"}, True, _media_tokens(value)
        out, unknown, media_tokens = {}, False, 0
        for key, item in value.items():
            if key == CONTEXT_META:
                continue
            out[key], media, tokens = _text_payload(item)
            unknown |= media
            media_tokens += tokens
        return out, unknown, media_tokens
    if isinstance(value, list):
        out, unknown, media_tokens = [], False, 0
        for item in value:
            clean, media, tokens = _text_payload(item)
            out.append(clean)
            unknown |= media
            media_tokens += tokens
        return out, unknown, media_tokens
    return value, False, 0


@dataclass(frozen=True)
class InputEstimate:
    tokens: int
    media_unknown: bool = False
    request_bytes: int = 0
    # Replayed thinking is billed differently from its visible summary and
    # signature, so a ratio measured with it does not transfer to text without it.
    reasoning: bool = False


_REASONING_TYPES = frozenset({"thinking", "redacted_thinking", "reasoning"})


def _replays_reasoning(payload: Any) -> bool:
    items = payload.get("messages", payload.get("input")) if isinstance(payload, dict) else None
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        if item.get("type") in _REASONING_TYPES or item.get("reasoning") or item.get("signature") \
                or item.get("reasoning_content"):
            return True
        for blocks in (item.get("content"), item.get("native_output_items")):
            if isinstance(blocks, list) and any(
                    isinstance(block, dict) and block.get("type") in _REASONING_TYPES for block in blocks):
                return True
    return False


def estimate_payload(payload: Any) -> InputEstimate:
    clean, media_unknown, media_tokens = _text_payload(payload)
    text = json.dumps(clean, ensure_ascii=False, separators=(",", ":"), default=str)
    request_bytes = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode())
    return InputEstimate(estimate_tokens(text) + media_tokens, media_unknown, request_bytes, _replays_reasoning(payload))


def estimate_request(
    messages: list[Message], *, system: str, tools: list[dict[str, Any]],
    backend: Any = None, model: str = "", max_tokens: int = 0,
    request_options: dict[str, Any] | None = None,
) -> InputEstimate:
    """Measure the production serializer when available, not Message.content."""
    build = getattr(backend, "build_payload", None)
    if callable(build):
        options = {"max_tokens": max_tokens or 8192, "stream": False,
                   **copy.deepcopy(request_options or {})}
        options.update(model=model, system=system, tools=tools)
        payload = build(messages, **options)
    else:
        payload = {"system": system, "tools": tools, "messages": serialize_messages(messages)}
    return estimate_payload(payload)


RETAIN_TOKENS_DEFAULT = 40_000
DIALOGUE_TOKENS_DEFAULT = 10_000


@dataclass(frozen=True)
class WindowPolicy:
    context_window: int
    trigger_tokens: int = 0
    trigger_ratio: float = 0.7
    # Message tokens only; system prompt and tool definitions are measured
    # separately. Execution records fill retain_tokens, older rounds keep their
    # visible dialogue within dialogue_tokens.
    retain_tokens: int = RETAIN_TOKENS_DEFAULT
    dialogue_tokens: int = DIALOGUE_TOKENS_DEFAULT
    # Request serialization/routing only; never reserve output against the
    # user-configured input compression threshold.
    max_output_tokens: int = 0
    tool_result_artifact_tokens: int = 16_000

    @property
    def threshold(self) -> int:
        # Explicit configuration is authoritative. Only an unset threshold uses
        # the context-window ratio; neither path deducts output capacity or an
        # additional hidden reserve, or caps the user's value to model metadata.
        return max(0, self.trigger_tokens or int(self.context_window * self.trigger_ratio))

    def target(self, attempt: int = 0) -> int:
        if not self.threshold:
            return 0
        return max(1, int(self.retain_tokens) >> max(0, attempt))

    def dialogue_target(self, attempt: int = 0) -> int:
        if not self.threshold:
            return 0
        return max(0, int(self.dialogue_tokens)) >> max(0, attempt)


def capped_trigger_tokens(trigger_tokens: int, context_window: int, trigger_ratio: float, cap: int) -> int:
    """The model's compaction threshold, lowered to ``cap`` when that is smaller (0 = no cap)."""
    threshold = WindowPolicy(context_window, trigger_tokens=trigger_tokens, trigger_ratio=trigger_ratio).threshold
    if cap <= 0:
        return threshold
    return min(threshold, cap) if threshold else cap


@dataclass(frozen=True)
class WindowSelection:
    messages: list[Message]
    kept_groups: tuple[int, ...]
    removed_groups: tuple[int, ...]
    required_groups: tuple[int, ...]
    estimate: InputEstimate
    soft_target_exceeded: bool
    referenced_results: int = 0
    # Removed groups whose user-visible text is still in the window.
    dialogue_groups: tuple[int, ...] = ()

    @property
    def changed(self) -> bool:
        return bool(self.removed_groups or self.referenced_results)


def _decision_exchange(call: Any, group: list[Message]) -> bool:
    """Keep decisions, not every read-only control-plane inspection.

    Older successful gated calls did not return their confirmation object. Keep
    all non-query/unknown actions conservatively, including cancellations and
    feedback. Only the known query forms may be treated as ordinary evidence.
    """
    name = call.get("name") if isinstance(call, dict) else call.name
    if name == "UserInteraction":
        return True
    if name != "OpenBearControl":
        return False
    call_id = call.get("id") if isinstance(call, dict) else call.id
    for message in group[1:]:
        if message.get("tool_call_id") != call_id:
            continue
        try:
            result = json.loads(message.get("content") or "{}")
        except (ValueError, TypeError):
            result = {}
        if isinstance(result, dict) and isinstance(result.get("confirmation"), dict):
            return True
    arguments = call.get("arguments") if isinstance(call, dict) else call.arguments
    try:
        arguments = json.loads(arguments) if isinstance(arguments, str) else arguments
    except (ValueError, TypeError):
        return True
    if not isinstance(arguments, dict):
        return True
    action = str(arguments.get("action") or "").strip().lower()
    if action in {"status", "models", "mcp_status", "skills_status"}:
        return False
    if action == "think":
        args = arguments.get("args") or {}
        if isinstance(args, dict) and not (args.get("level") or args.get("thinkLevel") or args.get("value")):
            return False
    return True


def required_context_groups(
    messages: list[Message], bounds: list[tuple[int, int]], *, preserve_summary: bool = True,
) -> set[int]:
    """Model-summary preservation policy. Do not relax it for sliding windows."""
    pinned = PINNED_KINDS if preserve_summary else PINNED_KINDS - {"summary"}
    required: set[int] = set()
    human: list[int] = []
    for index, (start, end) in enumerate(bounds):
        group = messages[start:end]
        kinds = {source_of(message).get("kind") for message in group}
        if kinds & pinned:
            required.add(index)
        if kinds & {"human", "task", "cron", "control"}:
            human.append(index)
        for call in group[0].get("tool_calls") or []:
            if _decision_exchange(call, group):
                required.add(index)
    # Preserve the original antecedent, not an inferred meaning of a short reply.
    for index in human:
        for previous in range(index - 1, -1, -1):
            first = messages[bounds[previous][0]]
            if source_of(first).get("kind") in {"human", "task", "cron", "control"}:
                break
            if first.get("role") == "assistant" and not first.get("tool_calls") and first.get("content"):
                required.add(previous)
    return required


def sliding_required_context_groups(
    messages: list[Message], bounds: list[tuple[int, int]], *,
    active_task_uuid: str = "", active_run_root_turn_uuid: str = "",
    latest_batches: int = 0,
) -> set[int]:
    """Current execution only, using trusted provenance rather than text/role guesses.

    Agent task identity takes precedence over the parent root: Continue creates a
    new task even within that root. Legacy unscoped execution units may inherit
    the preceding input's scope, never a later/new task's identity. If no identity
    can be resolved, a single unscoped input may anchor its execution suffix.
    Multiple unscoped inputs are ambiguous: fail instead of dropping a possibly
    current instruction or turning all historical inputs into lifetime pins.
    """
    # Scheduled instructions are task inputs, while retaining their distinct
    # trusted origin (not a new live human message).
    input_kinds = {"human", "task", "cron", "control", "decision"}
    primary_kinds = {"human", "task", "cron"}
    target = active_task_uuid or active_run_root_turn_uuid
    agent = bool(active_task_uuid)
    kinds: list[set[str]] = []
    identities: list[str] = []
    inherited = ""
    for start, end in bounds:
        sources = [source_of(m) for m in messages[start:end]]
        group_kinds = {str(s.get("kind") or "") for s in sources}
        # Legacy Agent checkpoints labelled real structured controls as task
        # inputs. Their trusted runtime type identifies feedback, without text
        # parsing or rewriting an archived source.
        if any((m.get("_openbear_runtime") or {}).get("kind") == "agent_control"
               for m in messages[start:end] if isinstance(m.get("_openbear_runtime"), dict)):
            group_kinds.add("control")
        kinds.append(group_kinds)
        explicit = next((str(s.get("task_uuid") or "") if agent else
                         str(s.get("run_root_turn_uuid") or s.get("turn_uuid") or "")
                         for s in sources if (s.get("task_uuid") if agent else
                                             s.get("run_root_turn_uuid") or s.get("turn_uuid"))), "")
        if group_kinds & primary_kinds:
            inherited = explicit
        identities.append(explicit or inherited)

    anchors = [i for i, ks in enumerate(kinds) if ks & input_kinds and target and identities[i] == target]
    fallback = None
    if not anchors:
        # No authoritative match: only unscoped inputs may be adopted when the
        # caller supplies an active id. Explicitly old tasks remain old.
        candidates = [i for i, ks in enumerate(kinds) if ks & primary_kinds
                      and (not target or not identities[i])]
        if not candidates:
            candidates = [i for i, ks in enumerate(kinds) if ks & input_kinds
                          and (not target or not identities[i])]
        if candidates:
            fallback = candidates[-1]
            if not target and identities[fallback]:
                target = identities[fallback]
                anchors = [i for i, ks in enumerate(kinds) if ks & input_kinds and identities[i] == target]
                fallback = None
            else:
                if len(candidates) > 1:
                    raise ActiveContextUnavailable("ambiguous_legacy_execution_inputs; original_context_preserved")
                anchors = [i for i in range(fallback, len(bounds)) if kinds[i] & input_kinds
                           and (not target or not identities[i])]

    if target and not anchors and any(ks & input_kinds for ks in kinds):
        raise ActiveContextUnavailable("active_execution_input_missing; original_context_preserved")

    def current(index: int) -> bool:
        return bool(target and identities[index] == target) or bool(
            fallback is not None and index >= fallback and not identities[index]
        )

    required = {i for i, ks in enumerate(kinds) if "required_runtime" in ks}
    required.update(anchors)
    for i, (start, end) in enumerate(bounds):
        group = messages[start:end]
        if current(i) and any(_decision_exchange(call, group) for call in group[0].get("tool_calls") or []):
            required.add(i)
    # No positional antecedent pin: the message before an input is not reliably
    # what it answers. Earlier visible dialogue is retained as its own layer.
    batches = [i for i, (start, _end) in enumerate(bounds)
               if current(i) and messages[start].get("tool_calls")]
    if latest_batches > 0 and batches:
        # The recent-batch floor belongs to this same resolved execution scope.
        # Old tools before a long dialogue must not pin that entire old suffix.
        start = batches[-latest_batches] if len(batches) >= latest_batches else batches[0]
        required.update(i for i in range(start, len(bounds)) if current(i))
    return required


def _tool_result_reference(message: Message, call: Any, *, agent: bool) -> Message | None:
    """A derived request view, never a rewrite of the archived execution event.

    Owners archive and bind sources before selection. Without a durable source
    identity there is no honest retrieval locator, so keep the body intact.
    """
    source = source_of(message)
    event_id = str(source.get("id") or "")
    if (not event_id or source.get("tool_result_reference")
            or source.get("kind") in PINNED_KINDS | {"runtime"}):
        return None
    name = str(call.get("name") if isinstance(call, dict) else call.name)
    body = message.get("content")
    text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False, separators=(",", ":"), default=str)
    history = "AgentHistory" if agent else "History"
    arguments = {"action": "read_event", "eventId": event_id}
    if not agent:
        arguments["source"] = "execution"
    content = (
        f"[Historical tool result referenced: tool={name}; tool_call_id={message.get('tool_call_id')}; "
        f"original size={len(text)} characters / {len(text.encode())} UTF-8 bytes. "
        "The model has already seen this result. Its original body remains in execution history; "
        f"retrieve with {history}({json.dumps(arguments, ensure_ascii=False, separators=(',', ':'))}). "
        "Follow nextOffset if hasMore. This reference is not the result body.]"
    )
    # A tiny result is more useful and cheaper than its retrieval instructions.
    if len(content) >= len(text):
        return None
    result = copy.deepcopy(message)
    result["content"] = content
    digest = hashlib.sha256(content.encode()).hexdigest()
    mark_source(result, kind=str(source.get("kind") or "execution"),
                source_id=f"{event_id}/tool-reference:{digest}", derived_from=event_id,
                message_id=0, reference_only=False, tool_result_reference=True)
    return result


def _projection(message: Message, tag: str) -> Message:
    """A derived copy with its own source identity; request overlays keyed by
    the original identity (reference bodies) no longer apply to it."""
    source = source_of(message)
    event_id = str(source.get("id") or "")
    body = {key: value for key, value in message.items() if key != CONTEXT_META}
    digest = hashlib.sha256(json.dumps(
        serialize_messages([body]), ensure_ascii=False, sort_keys=True, default=str,
    ).encode()).hexdigest()
    result = {**body, CONTEXT_META: dict(source)}
    return mark_source(result, kind=str(source.get("kind") or "execution"),
                       source_id=f"{event_id}/{tag}:{digest}", derived_from=event_id,
                       message_id=0, reference_only=False, dialogue_projection=True)


def _reference_marker(message: Message) -> Message:
    """An earlier round keeps the reference links it was written with, not the bodies."""
    if (message.get("role") != "user" or not message.get(_REFERENCE_BUNDLE)
            or not source_of(message).get("id")):
        return message
    return _projection({key: value for key, value in message.items() if key != _REFERENCE_BUNDLE},
                       "reference-marker")


def _dialogue_items(group: list[Message]) -> list[Message]:
    """The user-visible part of a removed group: inputs, assistant text and
    confirmation exchanges. Tool calls and results are execution records."""
    first = group[0]
    source = source_of(first)
    if source.get("dialogue_projection"):
        return list(group)
    if first.get("role") == "user":
        return [first] if source.get("kind") in _DIALOGUE_INPUT_KINDS else []
    if first.get("role") != "assistant":
        return []
    if not first.get("tool_calls"):
        return [first] if first.get("content") else []
    calls = [call for call in first["tool_calls"] if _decision_exchange(call, group)]
    if len(calls) == len(first["tool_calls"]):
        return list(group)
    if not source.get("id") or (not first.get("content") and not calls):
        return []
    shell = {key: value for key, value in first.items() if key != "tool_calls"}
    if calls:
        shell["tool_calls"] = calls
    ids = {str(call.get("id") if isinstance(call, dict) else call.id) for call in calls}
    return [_projection(shell, "dialogue"), *(m for m in group[1:] if str(m.get("tool_call_id")) in ids)]


def select_window(
    messages: list[Message], *, estimate: Callable[[list[Message]], InputEstimate],
    target: int, input_ceiling: int = 0, latest_batches: int = 2, dialogue_target: int = 0,
    active_task_uuid: str = "", active_run_root_turn_uuid: str = "",
) -> WindowSelection:
    """Pin active execution inputs, retain recent contiguous complete batches,
    then the visible dialogue of earlier groups.

    Both budgets count message tokens only; the system prompt and tool
    definitions are measured as the empty-request base. Runtime state must first
    be refreshed by the owner. Summary compression has its own unchanged
    preservation policy, not this sliding-window policy.
    """
    clean = neutral_context(messages)
    bounds = protocol_groups(clean)
    if not bounds:
        return WindowSelection([], (), (), (), estimate([]), False)
    required = sliding_required_context_groups(
        clean, bounds, active_task_uuid=active_task_uuid,
        active_run_root_turn_uuid=active_run_root_turn_uuid, latest_batches=latest_batches,
    )
    required.add(len(bounds) - 1)
    for index, (start, end) in enumerate(bounds):
        if index not in required and end - start == 1:
            clean[start] = _reference_marker(clean[start])

    def assemble(indices: set[int]) -> list[Message]:
        return [message for i in sorted(indices) for message in clean[bounds[i][0]:bounds[i][1]]]

    kept = set(required)
    minimum = estimate(assemble(required))
    referenced = 0
    if input_ceiling and minimum.tokens > input_ceiling:
        # A required batch keeps its assistant text/calls and protocol shell,
        # not an irrevocable pin on every parallel result's body. The same escape
        # hatch applies to the seen batch in the recent-batch floor. A later tool
        # batch proves a subsequent model turn; user/control arrivals alone do
        # not prove the model has consumed the previous results. Conservatively
        # keep the newest batch intact even if there is a final assistant reply.
        batches = [i for i, (start, _end) in enumerate(bounds) if clean[start].get("tool_calls")]
        newest = batches[-1] if batches else -1
        for index in sorted(required):
            if minimum.tokens <= input_ceiling:
                break
            start, end = bounds[index]
            if index >= newest or not clean[start].get("tool_calls"):
                continue
            group = clean[start:end]
            calls = {str(call.get("id") if isinstance(call, dict) else call.id): call
                     for call in group[0]["tool_calls"]}
            for position in range(start + 1, end):
                call = calls[str(clean[position].get("tool_call_id"))]
                if _decision_exchange(call, group):
                    continue
                replacement = _tool_result_reference(clean[position], call, agent=bool(active_task_uuid))
                if replacement is None:
                    continue
                original = clean[position]
                clean[position] = replacement
                reduced = estimate(assemble(required))
                if reduced.tokens >= minimum.tokens:
                    clean[position] = original
                    continue
                minimum = reduced
                referenced += 1
                if minimum.tokens <= input_ceiling:
                    break
        if minimum.tokens > input_ceiling:
            raise RequiredContextTooLarge(minimum.tokens, input_ceiling)
    # Per-group estimates provide a linear preliminary selection. The exact
    # selected request is then serialized as a whole, including system/tools.
    base = estimate([]).tokens
    ceiling = base + target if target else 0
    if input_ceiling:
        ceiling = min(ceiling, input_ceiling) if ceiling else input_ceiling
    sizes = [max(0, estimate(clean[a:b]).tokens - base) for a, b in bounds]
    rough = minimum.tokens
    added: list[int] = []
    for index in reversed(range(len(bounds))):
        if index in kept:
            continue
        if ceiling and rough + sizes[index] > ceiling:
            break
        kept.add(index)
        added.append(index)
        rough += sizes[index]
    selected = assemble(kept)
    measured = estimate(selected)
    while added and ceiling and measured.tokens > max(ceiling, minimum.tokens):
        kept.remove(added.pop())
        selected = assemble(kept)
        measured = estimate(selected)
    execution = measured

    dialogue: dict[int, list[Message]] = {}
    if dialogue_target:
        limit = execution.tokens + dialogue_target
        if input_ceiling:
            limit = min(limit, input_ceiling)
        rough = execution.tokens
        for index in reversed(range(len(bounds))):
            if index in kept:
                continue
            items = _dialogue_items(clean[bounds[index][0]:bounds[index][1]])
            if not items:
                continue
            size = max(0, estimate(items).tokens - base)
            if rough + size > limit:
                break
            dialogue[index] = items
            rough += size

    def with_dialogue() -> list[Message]:
        return [message for i in sorted(kept | set(dialogue))
                for message in (dialogue[i] if i in dialogue else clean[bounds[i][0]:bounds[i][1]])]

    if dialogue:
        selected = with_dialogue()
        measured = estimate(selected)
        while dialogue and input_ceiling and measured.tokens > input_ceiling:
            del dialogue[min(dialogue)]
            selected = with_dialogue()
            measured = estimate(selected)
    if input_ceiling and measured.tokens > input_ceiling:
        raise RequiredContextTooLarge(measured.tokens, input_ceiling)
    if not validate_model_context(selected):
        raise UnsafeWindowBoundary("selected_context_not_closed")
    return WindowSelection(
        selected, tuple(sorted(kept)), tuple(sorted(set(range(len(bounds))) - kept)),
        tuple(sorted(required)), measured, bool(target and execution.tokens - base > target), referenced,
        tuple(sorted(dialogue)),
    )
