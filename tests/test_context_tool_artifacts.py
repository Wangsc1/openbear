"""Compression-only lossless tool offload; isolated persistence, no live models."""
from __future__ import annotations

import copy
import hashlib
import json
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.agent.native_continuation import validate_model_context
from app.config import Config, ContextManagementConfig
from app.context.runtime import ContextManager
from app.context.store import ContextOwner, WindowStore
from app.context.strategies import ModelSummaryStrategy
from app.context.tool_artifacts import externalize_tool_results
from app.context.window import RequiredContextTooLarge, WindowPolicy, mark_source, source_of
from app.db.engine import DB
from app.llm.base import AgentResult
from app.llm.events import ToolCall
from app.tools.base import ToolRegistry, ToolRuntimeContext
from app.tools.file_state import FileStateStore
from app.tools.files import register_file_tools
from app.utils import estimate_tokens
from tests.test_context_strategies import SUMMARY
from tests.test_context_window import batch, human

READ = [{"name": "Read", "description": "Read local files", "parameters": {"type": "object"}}]
TEXT = "head:\r\n" + ("完整工具原文\t证据\n" * 3000) + "tail:\r\n"


def rewrite(messages, directory, threshold=1000):
    return externalize_tool_results(messages, artifact_dir=directory, threshold_tokens=threshold)


def artifact(message):
    return Path(source_of(message)["tool_result_artifact"])


def test_full_original_preview_provenance_and_idempotent_reuse(tmp_path):
    messages = [human(), *batch(1, text=TEXT)]
    before = copy.deepcopy(messages)
    result, detail = rewrite(messages, tmp_path)
    assert messages == before
    assert validate_model_context(result)
    assert result[:-1] == messages[:-1]  # Includes unchanged assistant calls.
    path = artifact(result[-1])
    assert path.name == hashlib.sha256(TEXT.encode()).hexdigest() + ".txt"
    assert path.read_bytes() == TEXT.encode()  # No universal-newline conversion.
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    preview = result[-1]["content"]
    assert 2400 < len(preview) < 4000
    assert "tool=Read" in preview and str(len(TEXT)) in preview
    assert str(estimate_tokens(TEXT)) in preview and str(path) in preview
    assert "Read" in preview and "offset and limit" in preview
    assert "--- head preview ---" in preview and "--- tail preview ---" in preview
    assert TEXT[:1200] in preview and TEXT[-1200:] in preview
    assert source_of(result[-1])["derived_from"] == source_of(messages[-1])["id"]
    assert source_of(result[-1])["id"] != source_of(messages[-1])["id"]
    assert detail == {"externalizedToolResults": 1, "toolResultTokensSaved": estimate_tokens(TEXT) - estimate_tokens(preview)}
    stamp = path.stat().st_mtime_ns
    again, other = rewrite(messages, tmp_path)
    assert again == result and other == detail
    assert path.stat().st_mtime_ns == stamp and len(list(tmp_path.iterdir())) == 1
    derived, skipped = rewrite(result, tmp_path)
    assert derived == result and skipped["externalizedToolResults"] == 0


@pytest.mark.parametrize("threshold", [0, estimate_tokens(TEXT), estimate_tokens(TEXT) + 1])
def test_disabled_and_exact_threshold_leave_originals(tmp_path, threshold):
    messages = [human(), *batch(1, text=TEXT)]
    result, detail = rewrite(messages, tmp_path / "no-files", threshold)
    assert result == messages and detail["externalizedToolResults"] == 0
    assert not (tmp_path / "no-files").exists()


@pytest.mark.parametrize("name,arguments,confirmation,protected", [
    ("UserInteraction", "{}", False, True),
    ("OpenBearControl", '{"action":"restart"}', False, True),
    ("OpenBearControl", '{"action":"status"}', True, True),
    ("OpenBearControl", '{"action":"status"}', False, False),
    ("Agent", "{}", False, True), ("AgentContinue", "{}", False, True),
    ("AgentWait", "{}", False, True), ("AgentMessage", "{}", False, True),
    ("AgentPlanDecision", "{}", False, True),
])
def test_latest_batch_decisions_and_orchestration(tmp_path, name, arguments, confirmation, protected):
    tool_batch = batch(9, name=name, text=json.dumps({"confirmation": {}, "content": TEXT}) if confirmation else TEXT)
    tool_batch[0]["tool_calls"][0].arguments = arguments
    messages = [human(TEXT), mark_source({"role": "assistant", "content": TEXT}), *tool_batch]
    before = copy.deepcopy(messages)
    result, detail = rewrite(messages, tmp_path)
    assert messages == before and result[:-1] == messages[:-1]
    assert detail["externalizedToolResults"] == int(not protected)
    assert (result[-1] == messages[-1]) == protected
    assert validate_model_context(result)


def test_only_tool_bodies_and_pinned_results_not_rewritten(tmp_path):
    messages = [human(TEXT), *batch(1, text=TEXT)]
    mark_source(messages[-1], kind="decision")
    result, detail = rewrite(messages, tmp_path)
    assert result == messages and not detail["externalizedToolResults"]


def test_structured_text_preserves_nontext_blocks_and_json_original(tmp_path):
    messages = [human(), *batch(1)]
    blocks = [{"type": "text", "text": TEXT}, {"type": "image", "path": "/original/image.png"}]
    messages[-1]["content"] = blocks
    before = copy.deepcopy(messages)
    result, detail = rewrite(messages, tmp_path)
    assert messages == before and detail["externalizedToolResults"] == 1
    assert json.loads(artifact(result[-1]).read_bytes()) == blocks
    assert result[-1]["content"][1] == blocks[1]
    assert "JSON content blocks" in result[-1]["content"][0]["text"]
    assert validate_model_context(result)


@pytest.mark.parametrize("owner_kind", ["controller", "agent"])
async def test_read_can_reach_private_artifact_for_both_owner_scopes(tmp_path, owner_kind):
    result, _ = rewrite([human(), *batch(1, text=TEXT)], tmp_path / "data" / "tool_artifacts" / "owner")
    registry = ToolRegistry()
    register_file_tools(registry, store=FileStateStore())
    assert "Read" in registry.names(scope="agent" if owner_kind == "agent" else "main")
    context = ToolRuntimeContext(source="agent:test" if owner_kind == "agent" else "main", task_uuid="own-task" if owner_kind == "agent" else "")
    text = await registry.dispatch("Read", json.dumps({"path": str(artifact(result[-1])), "offset": 100, "limit": 2}), context=context)
    assert "完整工具原文" in text and "error:" not in text


@pytest.mark.parametrize("owner_kind", ["controller", "agent"])
@pytest.mark.parametrize("structured", [False, True])
async def test_long_line_has_lossless_read_safe_view_and_reuses_both_files(tmp_path, owner_kind, structured):
    long_text = "first marker:" + "长行原文\\\"\t" * 10000 + ":last marker"
    messages = [human(), *batch(1, text=long_text)]
    if structured:
        messages[-1]["content"] = [{"type": "text", "text": long_text}]
    before = copy.deepcopy(messages)
    result, _ = rewrite(messages, tmp_path)
    raw_path = artifact(result[-1])
    read_path = Path(source_of(result[-1])["tool_result_read_path"])
    assert raw_path != read_path and read_path.suffix == ".jsonl"
    expected = json.dumps(messages[-1]["content"], ensure_ascii=False, separators=(",", ":")) if structured else long_text
    assert raw_path.read_bytes() == expected.encode()
    lines = read_path.read_text().splitlines()
    assert "".join(json.loads(line) for line in lines) == expected
    assert max(len(line.encode()) for line in lines) < 16000
    registry = ToolRegistry()
    register_file_tools(registry, store=FileStateStore())
    context = ToolRuntimeContext(source="agent:test" if owner_kind == "agent" else "main", task_uuid="task" if owner_kind == "agent" else "")
    first = await registry.dispatch("Read", json.dumps({"path": str(read_path), "offset": 0, "limit": 1}), context=context)
    last = await registry.dispatch("Read", json.dumps({"path": str(read_path), "offset": len(lines) - 1, "limit": 1}), context=context)
    assert "first marker" in first and "last marker" in last
    assert lines[0] in first and lines[-1] in last and "error:" not in first + last
    stamps = {path: path.stat().st_mtime_ns for path in (raw_path, read_path)}
    again, _ = rewrite(messages, tmp_path)
    assert again == result and messages == before
    assert {path: path.stat().st_mtime_ns for path in stamps} == stamps
    assert len(list(tmp_path.iterdir())) == 2


@pytest.mark.parametrize("strategy", ["sliding_window", "model_summary"])
@pytest.mark.parametrize("owner_kind", ["controller", "agent"])
async def test_real_runtime_both_strategies_archive_original_and_latest_reference(tmp_path, strategy, owner_kind):
    db = DB(str(tmp_path / "test.db"))
    await db.connect()
    try:
        owner = (ContextOwner.controller(chat_id=1, session_uuid="test") if owner_kind == "controller"
                 else ContextOwner.agent(task_uuid="task", agent_session_uuid="instance"))
        store = WindowStore(db, owner)
        cfg = Config.model_validate({"models": {"primary": "p/test", "providers": {"p": {
            "baseUrl": "http://not-called.invalid", "protocol": "chat", "apiKey": "fake", "models": [{"id": "test"}]}}},
            "agent": {"keepRecentMessages": 2}, "memory": {}})
        calls = []
        class Backend:
            protocol = "chat"
            async def complete(self, messages, **kwargs):
                calls.append(copy.deepcopy(messages))
                return AgentResult(text=SUMMARY)
        backend = Backend()
        events = []
        async def rotated(detail):
            events.append(detail)
        async def choose():
            return strategy
        manager = ContextManager(store, WindowPolicy(100_000, trigger_tokens=10000, tool_result_artifact_tokens=1000),
            backend=backend, model="test", strategy_resolver=choose, on_rotated=rotated,
            strategies={"model_summary": ModelSummaryStrategy(cfg, SimpleNamespace(backend_for=lambda _: (backend, "test", 2048)), "p/test")})
        messages = [human("Exact task: do not deploy"), *batch(0), *batch(1, text=TEXT)]
        before = copy.deepcopy(messages)
        result = await manager.prepare(messages, system="bounded", tools=READ)
        assert messages == before and validate_model_context(result)
        assert result[-2]["tool_calls"] == messages[-2]["tool_calls"]
        assert result[-2]["content"] == messages[-2]["content"] and artifact(result[-1]).read_bytes() == TEXT.encode()
        assert events[0]["externalizedToolResults"] == 1 and events[0]["toolResultTokensSaved"] > 10000
        assert events[0]["afterEstimateTokens"] < 10000
        original = await store.event_payload(source_of(messages[-1])["id"])
        assert original["payload"]["content"] == TEXT
        generated = await store.event_payload(source_of(result[-1])["id"])
        assert generated["payload"]["content"] == result[-1]["content"]
        assert len(calls) == int(strategy == "model_summary")
        if calls:
            assert "Exact task" in calls[0][0]["content"]
        assert await store.restore_messages() == result
        # Recompression reuses the same content-addressed file, even from originals.
        path = artifact(result[-1])
        stamp = path.stat().st_mtime_ns
        again = await manager.prepare(messages, system="bounded", tools=READ, force=True)
        assert artifact(again[-1]) == path and path.stat().st_mtime_ns == stamp
    finally:
        await db.close()


@pytest.mark.parametrize("force,threshold,read,externalized", [
    (False, 1000, True, False), (True, 1000, True, True),
    (True, 0, True, False), (True, 1000, False, False),
])
async def test_runtime_only_during_compression_and_with_actual_read_grant(tmp_path, force, threshold, read, externalized):
    db = DB(str(tmp_path / "test.db"))
    await db.connect()
    try:
        manager = ContextManager(WindowStore(db, ContextOwner.agent(task_uuid="task")),
            WindowPolicy(200_000, trigger_tokens=100000, tool_result_artifact_tokens=threshold), backend=None, model="test")
        messages = [human(), *batch(1, text=TEXT)]
        before = copy.deepcopy(messages)
        result = await manager.prepare(messages, system="bounded", tools=READ if read else [], force=force)
        assert messages == before
        assert bool(source_of(result[-1]).get("tool_result_artifact")) == externalized
        assert (tmp_path / "tool_artifacts").exists() == externalized
    finally:
        await db.close()


async def test_required_inputs_still_overflow_after_tool_offload(tmp_path):
    db = DB(str(tmp_path / "test.db"))
    await db.connect()
    try:
        manager = ContextManager(WindowStore(db, ContextOwner.agent(task_uuid="task")),
            WindowPolicy(100000, trigger_tokens=5000, tool_result_artifact_tokens=1000), backend=None, model="test")
        messages = [human(TEXT), *batch(1, text=TEXT)]
        before = copy.deepcopy(messages)
        with pytest.raises(RequiredContextTooLarge):
            await manager.prepare(messages, system="bounded", tools=READ)
        assert messages == before and len(list((tmp_path / "tool_artifacts").rglob("*.txt"))) == 1
        assert await manager.store.restore_messages() is None
    finally:
        await db.close()


async def test_offload_precedes_history_fallback_for_remaining_pins(tmp_path):
    db = DB(str(tmp_path / "fallback.db"))
    await db.connect()
    try:
        events = []
        async def rotated(detail):
            events.append(detail)
        manager = ContextManager(WindowStore(db, ContextOwner.controller(chat_id=1, session_uuid="test")),
            WindowPolicy(100000, trigger_tokens=16000, tool_result_artifact_tokens=5000),
            backend=None, model="test", active_run_root_turn_uuid="active", on_rotated=rotated)
        messages = [human("Do not deploy", "original-task")]
        # The recent-batch floor pins this parallel batch; each body stays under
        # the offload threshold, so only the History fallback can shrink it.
        calls = [ToolCall(f"parallel-{n}", "Read", "{}") for n in range(5)]
        messages += [mark_source({"role": "assistant", "content": "Read five bounded files.", "tool_calls": calls}),
                     *[mark_source({"role": "tool", "tool_call_id": call.id, "name": "Read", "content": "证" * 4000})
                       for call in calls]]
        messages += batch(99, text=TEXT)
        for message in messages:
            mark_source(message, kind=source_of(message)["kind"], run_root_turn_uuid="active")
        before = copy.deepcopy(messages)
        result = await manager.prepare(messages, system="bounded", tools=READ)
        assert messages == before and validate_model_context(result)
        assert events[0]["externalizedToolResults"] == 1
        assert events[0]["referencedToolResults"] > 0
        assert artifact(result[-1]).read_bytes() == TEXT.encode()
        assert all(not source_of(m).get("tool_result_reference") for m in result[-2:])
    finally:
        await db.close()


async def test_runtime_does_not_mutate_unbound_caller_messages(tmp_path):
    db = DB(str(tmp_path / "unbound.db"))
    await db.connect()
    try:
        manager = ContextManager(WindowStore(db, ContextOwner.agent(task_uuid="task")),
            WindowPolicy(100000, trigger_tokens=10000, tool_result_artifact_tokens=1000), backend=None, model="test")
        messages = [{"role": "user", "content": "Do not deploy"},
                    {"role": "assistant", "content": None, "tool_calls": [ToolCall("call", "Read", "{}")]},
                    {"role": "tool", "tool_call_id": "call", "content": TEXT}]
        before = copy.deepcopy(messages)
        result = await manager.prepare(messages, system="bounded", tools=READ)
        assert messages == before and validate_model_context(result)
        assert artifact(result[-1]).read_bytes() == TEXT.encode()
    finally:
        await db.close()


def test_config_alias_default_and_negative_rejected():
    assert ContextManagementConfig().tool_result_artifact_tokens == 16000
    assert ContextManagementConfig(toolResultArtifactTokens=0).tool_result_artifact_tokens == 0
    assert ContextManagementConfig(tool_result_artifact_tokens=9000).model_dump(by_alias=True)["toolResultArtifactTokens"] == 9000
    with pytest.raises(ValueError):
        ContextManagementConfig(toolResultArtifactTokens=-1)
