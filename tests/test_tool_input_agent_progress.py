from __future__ import annotations

import asyncio
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from app.agents import live_state
from app.agents.control import AgentControlService
from app.agents.execution import AgentExecutor
from app.llm.base import OpenBearLLMError
from app.llm.events import StreamEvent, ToolCall, Usage
from app.tools.agents import _events_public, _task_public
from app.tools.base import Tool, ToolRegistry
from tests import test_rath_single_agent as agent_fixtures

env = agent_fixtures.env


async def test_agent_parameter_progress_stays_in_memory_and_finishes_cleanly(env):
    dao, task_uuid, agent = env
    observed = []

    class Backend:
        protocol = 'responses'

        async def stream(self, *args, **kwargs):
            for size in (0, 12010):
                yield StreamEvent(kind='tool_input', details={
                    'toolNames': ['Read'], 'receivedBytes': size,
                    'startedAtMs': 1000, 'updatedAtMs': 2000,
                    'elapsedMs': 1000, 'phase': 'generating'})
                task = await dao.get_task(task_uuid)
                observed.append((live_state.progress(task_uuid), task, _task_public(task, live_progress=True)))
            yield StreamEvent(kind='content', text='完成')
            yield StreamEvent(kind='finish', finish_reason='stop')

    runner = AgentExecutor(dao, task_uuid, agent=agent, backend=Backend(),
                           model='gpt', max_tokens=2048, tools=ToolRegistry())
    result = await runner.run()
    assert result['summary'] == '完成'
    progress, task, public = observed[-1]
    assert progress['toolInput']['receivedBytes'] == 12010
    assert progress['toolInput']['attemptId'] == progress['attemptId']
    assert 'arguments' not in progress['toolInput']
    # The task row keeps its stage status; the public view carries the live line.
    assert task.current_status == '模型调用中'
    assert public['currentStatus'].startswith('正在生成工具参数') and public['liveProgress'] == progress
    events = await dao.events(task_uuid)
    assert not any(e.kind == 'model_stream_progress' for e in events)
    assert not any(e.kind == 'tool_call_started' for e in events)
    assert (await dao.get_task(task_uuid)).status == 'completed'
    assert live_state.progress(task_uuid) is None


def _input_event(*, second=False, phase="generating"):
    return StreamEvent(kind="tool_input", details={
        "toolNames": ["Write" if second else "Read"],
        "receivedBytes": 9 if second else 12010,
        "startedAtMs": 5000 if second else 1000,
        "updatedAtMs": 6000 if second else 2000,
        "elapsedMs": 1000, "phase": phase,
    })


def _project_model_rows(requests):
    """Project real DAO/public event snapshots through the production JS reducer.

    ``requests`` is a list of ``(public_events, now_ms[, live_progress])``; every
    projection runs independently on its own parsed input inside one Node process.
    """
    node = shutil.which("node")
    if node is None:
        pytest.skip("Agent frontend integration requires Node.js")
    module = Path(__file__).parents[1] / "web/src/views/consoleView/agentPlanPresentation.js"
    script = f"""
        import {{compactAgentStepActivityLines, liveProgressEvent}} from {json.dumps(module.as_uri())};
        let input = ''; for await (const chunk of process.stdin) input += chunk;
        console.log(JSON.stringify(JSON.parse(input).map(({{events, nowMs, liveProgress}}) =>
          compactAgentStepActivityLines(events, {{nowMs, liveProgressLine: liveProgressEvent(liveProgress)}})
            .filter(line => line.processType === 'model'))));
    """
    payload = [{"events": request[0], "nowMs": request[1], "liveProgress": (request[2:] or [None])[0]}
               for request in requests]
    result = subprocess.run([node, "--input-type=module", "-e", script],
                            input=json.dumps(payload), text=True,
                            capture_output=True, check=True, timeout=20)
    rows = json.loads(result.stdout)
    assert len(rows) == len(requests)
    return rows


def _model_rows(events, *, now_ms=32000, live_progress=None):
    return _project_model_rows([(_events_public(events), now_ms, live_progress)])[0]


@pytest.mark.parametrize("mode,task_status,model_statuses,calls", [
    ("success", "completed", ["success"], 1),
    ("failed", "failed", ["failed"], 1),
    ("cancel", "cancelled", ["failed"], 1),
    ("recovered", "completed", ["failed", "success"], 2),
    ("retry_success", "completed", ["success"], 2),
    ("retry_failed", "failed", ["failed"], 2),
    ("retry_recovered", "completed", ["failed", "success"], 3),
    ("retry_cancelled", "cancelled", ["failed"], 1),
    ("two_calls", "completed", ["success", "success"], 2),
])
async def test_agent_parameter_lifecycle_real_events(env, mode, task_status, model_statuses, calls):
    dao, task_uuid, agent = env

    live_snapshots = []

    class Backend:
        protocol = "responses"
        calls = 0

        async def stream(self, *args, **kwargs):
            self.calls += 1
            n = self.calls
            yield StreamEvent(kind="usage", usage=Usage(input_tokens=5, output_tokens=2))
            yield _input_event(second=n > 1)
            live_snapshots.append((n, _events_public(await dao.events(task_uuid, limit=1000)),
                                   live_state.progress(task_uuid)))
            if mode == "cancel":
                raise asyncio.CancelledError("synthetic transport cancellation")
            if mode == "failed" or (mode == "retry_failed" and n == 2):
                raise OpenBearLLMError("synthetic fatal", status=400, retryable=False)
            if mode.startswith("retry_") and n == 1:
                raise OpenBearLLMError("synthetic transient", status=503, retryable=True)
            if (mode in {"recovered", "two_calls"} and n == 1) or (mode == "retry_recovered" and n == 2):
                yield _input_event(second=n > 1, phase="ready")
                yield StreamEvent(kind="tool_call", tool_calls=[ToolCall(
                    id="fake-read", name="Read", arguments='{"path":"synthetic"}')])
                if mode != "two_calls":
                    raise OpenBearLLMError("transient after complete tool", status=503, retryable=True)
                yield StreamEvent(kind="finish", finish_reason="tool_calls")
            else:
                yield StreamEvent(kind="content", text="完成")
                yield StreamEvent(kind="finish", finish_reason="stop")

    tools = ToolRegistry()
    executed = []
    tool_boundary_snapshots = []

    async def fake_read(args):
        executed.append(args)
        # Snapshot here, project and assert outside dispatch so tool-error
        # conversion cannot accidentally swallow a failing test assertion.
        tool_boundary_snapshots.append(_events_public(await dao.events(task_uuid)))
        return "synthetic read result; no filesystem operation"

    tools.register(Tool(name="Read", description="fake read", parameters={"type": "object"},
                        handler=fake_read, visibility={"agent"}, read_only=True))
    backend = Backend()
    runner = AgentExecutor(dao, task_uuid, agent=agent, backend=backend,
                           model="gpt", max_tokens=2048, tools=tools,
                           max_retries=1, retry_backoff_s=0,
                           retry_cancel_check=(lambda: True) if mode == "retry_cancelled" else None)
    # Capture current_status at the physical-call return, before the outer task
    # completion overwrites it. Retry metadata must not reopen '模型调用中'.
    statuses_after_call = []
    original_call = runner._call_model

    async def call(*args, **kwargs):
        try:
            return await original_call(*args, **kwargs)
        finally:
            statuses_after_call.append((await dao.get_task(task_uuid)).current_status)

    runner._call_model = call
    manager = AgentControlService(dao)

    async def factory(_):
        await runner.run()

    try:
        await manager.start(task_uuid, 123, factory)
    except asyncio.CancelledError:
        assert mode in {"cancel", "retry_cancelled"}
    task = await dao.get_task(task_uuid)
    events = await dao.events(task_uuid, limit=1000)
    snapshot = _task_public(task, include_output=True)
    assert snapshot["status"] == task_status
    assert backend.calls == task.model_call_count == calls
    assert task.input_tokens == 5 * calls
    assert task.output_tokens == 2 * calls
    assert "模型调用中" not in statuses_after_call
    assert len(executed) == (1 if mode in {"recovered", "retry_recovered", "two_calls"} else 0)

    starts = [e for e in events if e.kind == "model_call_started"]
    assert len({e.detail["attemptId"] for e in starts}) == calls
    assert not any(e.kind == "model_stream_progress" for e in events)
    assert [progress["toolInput"]["attemptId"] for _, _, progress in live_snapshots] == \
        [s.detail["attemptId"] for s in starts][:len(live_snapshots)]
    assert live_state.progress(task_uuid) is None
    assert _task_public(task, live_progress=True)["liveProgress"] is False
    assert "liveProgress" not in _task_public(task, include_output=True)
    interrupted = [e for e in events if e.kind == "model_stream_interrupted"]
    if mode not in {"success", "two_calls"}:
        assert interrupted
        assert interrupted[0].detail["attemptId"] == starts[0].detail["attemptId"]
        assert interrupted[0].detail["status"] == ("cancelled" if mode == "cancel" else "error")
    retry_prefix = None
    if mode.startswith("retry_") and calls > 1:
        retry_prefix = next((snapshot, 32000, progress) for n, snapshot, progress in live_snapshots if n == 2)

    # One Node process projects every snapshot this case needs.
    public_events = _events_public(events)
    projected = _project_model_rows([
        *((snapshot, 32000) for snapshot in tool_boundary_snapshots),
        *([retry_prefix] if retry_prefix is not None else []),
        (public_events, 32000),
        (public_events, 92000),
    ])
    tool_boundary_rows = [row for rows in projected[:len(tool_boundary_snapshots)] for row in rows]
    assert all(row["modelStatus"] != "running" for row in tool_boundary_rows)
    assert all(not row.get("detail", {}).get("toolInput") for row in tool_boundary_rows)
    if retry_prefix is not None:
        rows = projected[len(tool_boundary_snapshots)]
        assert len(rows) == 1
        assert "9 B" in rows[0]["modelStatusText"]
        assert "12.01 kB" not in rows[0]["modelStatusText"]

    rows, later_rows = projected[-2:]
    assert [row["modelStatus"] for row in rows] == model_statuses
    assert all(not row.get("detail", {}).get("toolInput") for row in rows)
    assert all("正在重试" not in row["modelStatusText"] for row in rows)
    assert later_rows == rows
    if mode in {"recovered", "retry_recovered"}:
        assert "完整工具调用已恢复" in rows[0]["modelStatusText"]
        assert rows[0]["detail"]["reason"]


@pytest.mark.parametrize("next_kind", ["content", "reasoning"])
async def test_parameter_to_text_phase_is_not_throttled(env, next_kind):
    dao, task_uuid, agent = env

    class Backend:
        protocol = "responses"

        async def stream(self, *args, **kwargs):
            yield _input_event()
            # Empty content/signature fragments do not end parameter generation.
            yield StreamEvent(kind=next_kind, text="")
            assert live_state.progress(task_uuid).get("toolInput")
            events_before = await dao.events(task_uuid)
            yield StreamEvent(kind=next_kind, text="字")
            switched = live_state.progress(task_uuid)
            assert not switched.get("toolInput")
            assert switched["textChars" if next_kind == "content" else "reasoningChars"] == 1
            assert switched["attemptId"]
            assert _task_public(await dao.get_task(task_uuid))["currentStatus"].startswith("模型流式输出中")
            rows = _model_rows(await dao.events(task_uuid), live_progress=switched)
            assert "流式输出中" in rows[-1]["modelStatusText"]
            yield StreamEvent(kind=next_kind, text="二")
            # Tiny text fragments do not refresh the pushed progress either.
            assert live_state.progress(task_uuid) == switched
            assert [e.seq for e in await dao.events(task_uuid)] == [e.seq for e in events_before]
            yield StreamEvent(kind="content", text="完成")
            yield StreamEvent(kind="finish", finish_reason="stop")

    runner = AgentExecutor(dao, task_uuid, agent=agent, backend=Backend(),
                           model="gpt", max_tokens=2048, tools=ToolRegistry())
    await runner.run()
    assert (await dao.get_task(task_uuid)).status == "completed"
