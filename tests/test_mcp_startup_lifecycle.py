"""Deferred MCP lifecycle tests: private stub peers and a temporary audit DB only."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import aiosqlite
import pytest

from app.config import Config
from app.mcp.manager import MCPManager
from app.mcp.registry import register_mcp_tools
from app.mcp.types import MCPRawTool
from app.tools.base import ToolRegistry


def config(*, required: bool = False, command: str = "optional", enabled: bool = True) -> Config:
    servers = {
        "optional": {
            "transport": "stdio", "command": command, "connectTimeoutS": 30,
            "approval": "allow", "agentAccess": {"mode": "all"},
        },
        "disabled": {"transport": "stdio", "command": "disabled", "enabled": False},
    }
    if required:
        servers["required"] = {
            "transport": "stdio", "command": "required", "required": True,
            "connectTimeoutS": 30,
        }
    return Config.model_validate({
        "telegram": {"botToken": "test", "whitelistIds": [1]},
        "models": {"providers": {}, "primary": ""},
        "memory": {"provider": "builtin"},
        "mcp": {"enabled": enabled, "allowTools": ["*"], "servers": servers},
    })


class Peer:
    def __init__(self):
        self.entered = {stage: asyncio.Event() for stage in ("connect", "tools", "prompts", "close")}
        self.release = {stage: asyncio.Event() for stage in self.entered}
        for event in self.release.values():
            event.set()
        self.fail_at = ""
        self.ignore_connect_cancel = False
        self.cancelled = asyncio.Event()
        self.clients = []

    async def step(self, stage):
        self.entered[stage].set()
        try:
            await self.release[stage].wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            if stage != "connect" or not self.ignore_connect_cancel:
                raise
        if self.fail_at == stage:
            raise RuntimeError(f"stub {stage} failed")


@pytest.fixture
async def env(monkeypatch):
    peers = {}
    managers = []
    baseline = set(asyncio.all_tasks())

    def peer(command="optional"):
        return peers.setdefault(command, Peer())

    class StubClient:
        def __init__(self, server_key, server_config):
            self.peer = peer(server_config.command)
            self.peer.clients.append(self)
            self.command = server_config.command
            self.instructions = f"instructions for {self.command}"
            self.closed = False
            self.close_calls = 0
            self.reader = None

        def set_notification_handler(self, handler):
            self.handler = handler

        async def connect(self):
            # Model a transport worker created before initialize finishes.
            self.reader = asyncio.create_task(asyncio.Event().wait(), name="stub-mcp-reader")
            await self.peer.step("connect")

        async def list_tools(self):
            await self.peer.step("tools")
            return [MCPRawTool(name=f"read_{self.command}")]

        async def list_prompts(self):
            await self.peer.step("prompts")
            return [{"name": self.command}]

        async def close(self):
            self.close_calls += 1
            await self.peer.step("close")
            if self.reader is not None:
                self.reader.cancel()
                await asyncio.gather(self.reader, return_exceptions=True)
            self.closed = True

    monkeypatch.setattr("app.mcp.manager.MCPClient", StubClient)

    def manager(cfg=None, **kwargs):
        result = MCPManager(cfg or config(), **kwargs)
        managers.append(result)
        return result

    try:
        yield SimpleNamespace(peer=peer, manager=manager)
    finally:
        for item in peers.values():
            item.release["close"].set()
        for item in managers:
            await asyncio.wait_for(item.close(), 2)
            assert not item._clients
            assert not item._startup_tasks
            assert not item._prepared_managers
        for item in peers.values():
            for client in item.clients:
                assert client.closed
                assert client.close_calls == 1
                assert client.reader is None or client.reader.done()
        leaked = [task for task in asyncio.all_tasks() - baseline
                  if task is not asyncio.current_task() and not task.done()]
        assert not leaked, f"MCP lifecycle leaked tasks: {leaked}"


async def reached(event):
    await asyncio.wait_for(event.wait(), 1)


async def settled(manager):
    # Snapshot the lifecycle tasks before releasing external resources in tests.
    tasks = list(manager._startup_tasks)
    if tasks:
        await asyncio.wait_for(asyncio.gather(*tasks), 1)


def states(manager):
    return {state.key: state for state in manager.status_snapshot().servers}


@pytest.mark.parametrize("stage", ["connect", "tools", "prompts"])
async def test_optional_does_not_block_start_or_publish_before_complete_discovery(env, stage):
    gate = asyncio.Event()
    peer = env.peer()
    peer.release[stage].clear()
    registry = ToolRegistry()
    published = asyncio.Event()

    async def publish():
        register_mcp_tools(registry, manager)
        published.set()

    manager = env.manager(tools_changed_callback=publish)
    await asyncio.wait_for(manager.start(defer_optional=True, startup_ready=gate), 1)
    await asyncio.sleep(0)
    assert states(manager)["optional"].status == "pending"
    assert states(manager)["disabled"].status == "disabled"
    assert not peer.clients, "gate must guard construction as well as connect"
    assert not manager.available_tools()
    assert not registry.names()

    gate.set()
    await reached(peer.entered[stage])
    assert states(manager)["optional"].status == "pending"
    assert not manager.available_tools()
    assert not published.is_set()
    peer.release[stage].set()
    await reached(published)
    await settled(manager)
    assert states(manager)["optional"].status == "connected"
    assert states(manager)["optional"].tool_count == 1
    assert "mcp__optional__read_optional" in registry.names()
    for scope in ("main", "agent"):
        assert [tool["name"] for tool in registry.schemas(scope=scope)] == ["mcp__optional__read_optional"]
    assert manager.prompts_snapshot() == {"optional": [{"name": "optional"}]}
    assert manager.server_instructions_snapshot() == [
        {"server": "optional", "instructions": "instructions for optional"},
    ]


async def test_required_still_waits_and_is_not_held_by_optional_gate(env):
    gate = asyncio.Event()
    required = env.peer("required")
    required.release["tools"].clear()
    manager = env.manager(config(required=True))
    start = asyncio.create_task(manager.start(defer_optional=True, startup_ready=gate))
    await reached(required.entered["tools"])
    assert not start.done()
    assert not env.peer().clients
    required.release["tools"].set()
    await asyncio.wait_for(start, 1)
    assert states(manager)["required"].status == "connected"
    assert states(manager)["optional"].status == "pending"
    assert [tool.server_key for tool in manager.available_tools()] == ["required"]


@pytest.mark.parametrize("stage", ["connect", "tools", "prompts"])
async def test_default_start_still_waits_for_optional_and_ignores_gate(env, stage):
    peer = env.peer()
    peer.release[stage].clear()
    published = []

    async def publish():
        published.append(True)

    manager = env.manager(tools_changed_callback=publish)
    start = asyncio.create_task(manager.start(startup_ready=asyncio.Event()))
    await reached(peer.entered[stage])
    assert not start.done()
    peer.release[stage].set()
    await asyncio.wait_for(start, 1)
    assert states(manager)["optional"].status == "connected"
    assert published == [], "default startup retains caller-owned registration"


@pytest.mark.parametrize("stage", ["connect", "tools"])
async def test_optional_failure_is_recorded_without_background_exception(env, tmp_path, stage):
    peer = env.peer()
    peer.fail_at = stage
    published = []

    async def publish():
        published.append(True)

    conn = await aiosqlite.connect(tmp_path / "audit.db")
    thread = conn._thread
    try:
        await conn.execute("CREATE TABLE audit_logs (kind TEXT, actor TEXT, chat_id INTEGER, ip TEXT, detail_json TEXT, created_at INTEGER)")
        manager = env.manager(db=SimpleNamespace(conn=conn), tools_changed_callback=publish)
        await manager.start(defer_optional=True)
        await settled(manager)
        state = states(manager)["optional"]
        assert state.status == "failed"
        assert f"stub {stage} failed" in state.error
        assert state.last_failed_at is not None
        assert not manager.available_tools()
        assert published == []
        assert peer.clients[0].closed
        async with conn.execute("SELECT kind, detail_json FROM audit_logs") as cursor:
            rows = await cursor.fetchall()
        assert any(kind == "mcp.server.failed" and "optional" in detail for kind, detail in rows)
        await manager.close()
    finally:
        await conn.close()
    assert not thread.is_alive(), "temporary audit DB worker must also be joined"


@pytest.mark.parametrize("gate_open", [False, True])
async def test_required_failure_closes_pending_or_connecting_optional(env, gate_open):
    peer = env.peer()
    peer.release["connect"].clear()
    required = env.peer("required")
    required.release["connect"].clear()
    required.fail_at = "connect"
    gate = asyncio.Event()
    if gate_open:
        gate.set()
    manager = env.manager(config(required=True))
    start = asyncio.create_task(manager.start(defer_optional=True, startup_ready=gate))
    await reached(required.entered["connect"])
    if gate_open:
        await reached(peer.entered["connect"])
    required.release["connect"].set()
    with pytest.raises(RuntimeError, match="required MCP server required failed"):
        await asyncio.wait_for(start, 1)
    assert manager._closed
    assert not manager._startup_tasks
    assert not manager._clients
    assert states(manager)["required"].status == "failed"
    assert states(manager)["optional"].status == "stopped"
    assert all(client.closed for client in peer.clients + required.clients)
    gate.set()
    await asyncio.sleep(0)
    assert len(peer.clients) == int(gate_open)


@pytest.mark.parametrize("stage", ["gate", "connect", "tools", "prompts", "callback"])
async def test_close_cancels_owned_connection_and_callback_work(env, stage):
    gate = asyncio.Event()
    peer = env.peer()
    callback_entered = asyncio.Event()
    callback_cancelled = asyncio.Event()
    publications = []

    async def publish():
        callback_entered.set()
        try:
            if stage == "callback":
                await asyncio.Event().wait()
            publications.append(True)
        except asyncio.CancelledError:
            callback_cancelled.set()
            raise

    if stage in peer.release:
        peer.release[stage].clear()
    manager = env.manager(tools_changed_callback=publish)
    await manager.start(defer_optional=True, startup_ready=gate)
    if stage != "gate":
        gate.set()
        await reached(callback_entered if stage == "callback" else peer.entered[stage])
    await asyncio.wait_for(manager.close(), 1)
    assert not manager._startup_tasks
    assert not manager._clients
    assert states(manager)["optional"].status == "stopped"
    assert all(client.closed for client in peer.clients)
    gate.set()
    for event in peer.release.values():
        event.set()
    await asyncio.sleep(0)
    assert publications == [], "shutdown must not be followed by tool re-registration"
    if stage == "callback":
        assert callback_cancelled.is_set()


async def test_concurrent_close_and_repeated_cancellation_join_partial_client_cleanup(env):
    peer = env.peer()
    peer.release["connect"].clear()
    peer.release["close"].clear()
    manager = env.manager()
    await manager.start(defer_optional=True)
    await reached(peer.entered["connect"])
    first = asyncio.create_task(manager.close())
    await reached(peer.entered["close"])
    first.cancel()
    await asyncio.sleep(0)
    second = asyncio.create_task(manager.close())
    first.cancel()
    await asyncio.sleep(0)
    assert not first.done()
    assert not second.done()
    peer.release["close"].set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(first, 1)
    await asyncio.wait_for(second, 1)
    assert peer.clients[0].closed
    assert peer.clients[0].close_calls == 1


@pytest.mark.parametrize("action", ["cancel_start", "close"])
async def test_interrupted_default_start_closes_unpublished_clients(env, action):
    peer = env.peer()
    peer.release["connect"].clear()
    manager = env.manager()
    start = asyncio.create_task(manager.start())
    await reached(peer.entered["connect"])
    if action == "cancel_start":
        start.cancel()
    else:
        await asyncio.wait_for(manager.close(), 1)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(start, 1)
    assert peer.clients[0].closed
    assert not manager._startup_tasks


@pytest.mark.parametrize("disabled", [False, True])
@pytest.mark.parametrize("stage", ["gate", "connect"])
async def test_reload_retires_deferred_generation_only_at_commit(env, disabled, stage):
    gate = asyncio.Event()
    peer = env.peer()
    peer.release["connect"].clear()
    # Simulate a transport that returns from connect while processing cancellation.
    peer.ignore_connect_cancel = True
    publications = []

    async def publish():
        publications.append(True)

    manager = env.manager(tools_changed_callback=publish)
    await manager.start(defer_optional=True, startup_ready=gate)
    if stage == "connect":
        gate.set()
        await reached(peer.entered["connect"])
    commit, abort = await manager.prepare_reload(config(command="replacement", enabled=not disabled))
    assert states(manager)["optional"].status == "pending"
    assert not peer.cancelled.is_set(), "preparation must not mutate the active generation"
    await asyncio.wait_for(commit(), 1)
    assert not manager._startup_tasks
    assert all(client.closed for client in peer.clients)
    gate.set()
    peer.release["connect"].set()
    await asyncio.sleep(0)
    assert publications == []
    assert [tool.original_tool_name for tool in manager.available_tools()] == ([] if disabled else ["read_replacement"])
    # Abort after transfer must not close the adopted generation.
    await abort()
    if not disabled:
        assert not env.peer("replacement").clients[0].closed


async def test_reload_preparation_still_waits_for_optional_and_abort_preserves_gate_waiter(env):
    gate = asyncio.Event()
    manager = env.manager()
    await manager.start(defer_optional=True, startup_ready=gate)
    replacement = env.peer("replacement")
    replacement.release["tools"].clear()
    prepare = asyncio.create_task(manager.prepare_reload(config(command="replacement")))
    await reached(replacement.entered["tools"])
    assert not prepare.done(), "hot reload must not inherit deferred cold-start semantics"
    replacement.release["tools"].set()
    _commit, abort = await asyncio.wait_for(prepare, 1)
    await abort()
    assert replacement.clients[0].closed
    assert states(manager)["optional"].status == "pending"
    gate.set()
    await settled(manager)
    assert states(manager)["optional"].status == "connected"


@pytest.mark.parametrize("prepared", [False, True])
async def test_close_owns_preparing_and_prepared_reload_clients_and_prevents_reopen(env, prepared):
    manager = env.manager()
    await manager.start(defer_optional=True, startup_ready=asyncio.Event())
    replacement = env.peer("replacement")
    if not prepared:
        replacement.release["connect"].clear()
    prepare = asyncio.create_task(manager.prepare_reload(config(command="replacement")))
    await reached(replacement.entered["connect"])
    if prepared:
        commit, abort = await asyncio.wait_for(prepare, 1)
    await asyncio.wait_for(manager.close(), 1)
    assert replacement.clients[0].closed
    assert not manager._prepared_managers
    if prepared:
        with pytest.raises(RuntimeError, match="mcp_manager_closed"):
            await commit()
        await abort()
    else:
        with pytest.raises((asyncio.CancelledError, RuntimeError)):
            await asyncio.wait_for(prepare, 1)
    assert manager._closed
    assert not manager._clients


async def test_reload_rechecks_optional_that_became_healthy_after_preparation(env):
    gate = asyncio.Event()
    manager = env.manager()
    await manager.start(defer_optional=True, startup_ready=gate)
    replacement = env.peer("replacement")
    replacement.fail_at = "connect"
    commit, abort = await manager.prepare_reload(config(command="replacement"))
    gate.set()
    await settled(manager)
    assert states(manager)["optional"].status == "connected"
    with pytest.raises(RuntimeError, match="replace healthy server"):
        await commit()
    assert [tool.original_tool_name for tool in manager.available_tools()] == ["read_optional"]
    assert not env.peer().clients[0].closed
    await abort()


async def test_abort_racing_commit_cannot_adopt_closed_replacement(env):
    peer = env.peer()
    peer.release["connect"].clear()
    peer.release["close"].clear()
    manager = env.manager()
    await manager.start(defer_optional=True)
    await reached(peer.entered["connect"])
    commit, abort = await manager.prepare_reload(config(command="replacement"))
    committing = asyncio.create_task(commit())
    await reached(peer.entered["close"])
    await abort()
    peer.release["close"].set()
    with pytest.raises(RuntimeError, match="mcp_reload_superseded"):
        await asyncio.wait_for(committing, 1)
    assert not manager._clients
    assert not manager.available_tools()


async def test_close_racing_reload_commit_cannot_reopen_manager(env):
    peer = env.peer()
    peer.release["connect"].clear()
    peer.release["close"].clear()
    manager = env.manager()
    await manager.start(defer_optional=True)
    await reached(peer.entered["connect"])
    commit, _abort = await manager.prepare_reload(config(command="replacement"))
    committing = asyncio.create_task(commit())
    await reached(peer.entered["close"])
    closing = asyncio.create_task(manager.close())
    await asyncio.sleep(0)
    assert manager._closed
    peer.release["close"].set()
    with pytest.raises(RuntimeError, match="mcp_manager_closed"):
        await asyncio.wait_for(committing, 1)
    await asyncio.wait_for(closing, 1)
    assert not manager._clients
    assert env.peer("replacement").clients[0].closed
