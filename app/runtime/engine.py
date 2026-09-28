"""The single model/tool advancement loop for controllers and delegated tasks.

Hosts implement policy and IO at named boundaries, never another execution loop.
A model final is only a candidate: the host may consume new input, wait for work,
or enforce a completion gate before returning a terminal decision.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from app.llm.events import ToolCall
from app.runtime.lifecycle import current_session


@dataclass(frozen=True, slots=True)
class RuntimeDecision:
    done: bool = False
    value: Any = None

    @classmethod
    def complete(cls, value: Any) -> RuntimeDecision:
        return cls(True, value)

    @classmethod
    def continue_(cls) -> RuntimeDecision:
        return cls()


@dataclass(slots=True)
class ToolBatch:
    calls: list[ToolCall]
    decision: RuntimeDecision | None = None


class ExecutionHost(Protocol):
    async def before_model(self) -> RuntimeDecision | None: ...
    async def call_model(self) -> RuntimeDecision | None: ...
    def tool_calls(self) -> list[ToolCall]: ...
    async def accept_tools(self, calls: list[ToolCall], *, resumed: bool = False) -> ToolBatch: ...
    async def execute_tool(self, call: ToolCall) -> RuntimeDecision | None: ...
    async def after_tools(self, *, resumed: bool = False) -> RuntimeDecision | None: ...
    async def finish_response(self) -> RuntimeDecision: ...


class ExecutionRuntime:
    async def run(self, host: ExecutionHost, *, pending_tools: list[ToolCall] | None = None) -> Any:
        session = current_session()
        resumed = bool(pending_tools)
        calls = list(pending_tools or [])
        while True:
            if not resumed:
                if session:
                    await session.phase("preparing_model")
                decision = await host.before_model()
                if decision is not None and decision.done:
                    return decision.value
                if session:
                    await session.phase("model")
                decision = await host.call_model()
                if decision is not None and decision.done:
                    return decision.value
                calls = host.tool_calls()
            if calls:
                batch = await host.accept_tools(calls, resumed=resumed)
                if batch.decision is not None and batch.decision.done:
                    return batch.decision.value
                for call in batch.calls:
                    if session:
                        await session.phase("tool")
                        session.tool_action_id = await session.start_tool(call)
                    decision = await host.execute_tool(call)
                    if decision is not None and decision.done:
                        return decision.value
                decision = await host.after_tools(resumed=resumed)
                if decision is not None and decision.done:
                    return decision.value
                resumed = False
                continue
            if session:
                await session.phase("finishing")
            decision = await host.finish_response()
            if decision.done:
                return decision.value
