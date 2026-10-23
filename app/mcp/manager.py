"""MCPManager: lifecycle, registration metadata, permission and calls."""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

from app.config import Config, MCPServerConfig
from app.interaction_data import explicit_authorization
from app.logging import get_logger
from app.mcp.audit import record_audit
from app.mcp.client import MCPClient
from app.mcp.exposure import (
    MCPExposureApprovals,
    MCPExposureNotAuthorized,
    digest,
    exposure_summary,
)
from app.mcp.output import format_mcp_result, redact_text_secrets
from app.mcp.permissions import (
    agent_access_reason,
    build_tool_meta,
    can_call_without_prompt,
    is_agent_context,
    is_tool_allowed,
    summarize_arguments,
)
from app.mcp.types import MCPManagerState, MCPServerState, MCPToolMeta
from app.tools.base import ToolRuntimeContext

log = get_logger("mcp")


class MCPAgentAccessRevoked(RuntimeError):
    pass


class MCPManager:
    def __init__(
        self,
        config: Config,
        *,
        interactions: Any = None,
        db: Any = None,
        approval_updater: Callable[[str, str], Awaitable[Any]] | None = None,
        tools_changed_callback: Callable[[], Awaitable[Any]] | None = None,
        exposure_approvals: MCPExposureApprovals | None = None,
    ) -> None:
        self.config = config
        self.mcp_config = config.mcp
        self.exposure_approvals = exposure_approvals or MCPExposureApprovals()
        self.interactions = interactions
        self.db = db
        self.approval_updater = approval_updater
        self.tools_changed_callback = tools_changed_callback
        self._clients: dict[str, MCPClient] = {}
        self._states: dict[str, MCPServerState] = {}
        self._tools: dict[str, MCPToolMeta] = {}
        self._all_tools: list[MCPToolMeta] = []
        self._prompts: dict[str, list[dict[str, Any]]] = {}
        self._server_instructions: dict[str, str] = {}
        # (conversation, server, original tool). Grants are cleared on every MCP
        # config generation change, so they can never authorize a replacement server.
        self._conversation_grants: set[tuple[str, str, str]] = set()
        self._registry_lock = asyncio.Lock()
        self._refresh_locks: dict[str, asyncio.Lock] = {}
        self._call_lifecycle_lock = asyncio.Lock()
        self._active_calls: dict[str, int] = {}
        self._draining_servers: set[str] = set()
        self._started = False
        self._closed = False
        self._startup_tasks: set[asyncio.Task[None]] = set()
        self._startup_generation = 0
        self._lifecycle_lock = asyncio.Lock()
        self._close_task: asyncio.Task[None] | None = None
        self._prepared_managers: set[MCPManager] = set()

    async def start(
        self, *, defer_optional: bool = False, startup_ready: asyncio.Event | None = None,
    ) -> None:
        """Start required dependencies now; optionally defer others until core readiness.

        The default still waits for every server, including during hot reload.
        Deferred connections and their publication callbacks belong to this manager
        and are joined on close or before a replacement generation is committed.
        """
        if self._started:
            return
        if self._closed:
            raise RuntimeError("mcp_manager_closed")
        self._started = True
        self._closed = False
        if not self.mcp_config.enabled:
            log.info("mcp.disabled")
            return
        tasks = []
        for server_key, server_config in self.mcp_config.servers.items():
            self._states[server_key] = MCPServerState(
                key=server_key,
                transport=server_config.transport,
                status="pending" if server_config.enabled else "disabled",
                required=server_config.required,
                approval=_server_approval(self.mcp_config, server_config),
            )
            if not server_config.enabled:
                continue
            deferred = defer_optional and not server_config.required
            task = asyncio.create_task(
                self._start_optional(server_key, server_config, startup_ready)
                if deferred else self._start_one(server_key, server_config),
                name=f"mcp-start-{server_key}",
            )
            self._startup_tasks.add(task)
            task.add_done_callback(self._startup_tasks.discard)
            if not deferred:
                tasks.append(task)
        if not tasks:
            return
        try:
            results = await asyncio.gather(*tasks, return_exceptions=True)
        except asyncio.CancelledError:
            await self.close()
            raise
        # A concurrent close can cancel individual connections without cancelling
        # the caller's gather. Do not report that interrupted startup as success.
        if any(isinstance(item, asyncio.CancelledError) for item in results):
            await self.close()
            raise asyncio.CancelledError
        required_errors = [str(item) for item in results if isinstance(item, Exception)]
        if required_errors:
            # Required server startup may fail after other MCP child processes have
            # already connected.  Clean them here because Services.startup/main may
            # not reach normal shutdown on startup exceptions.
            await self.close()
            raise RuntimeError("; ".join(required_errors))

    async def _start_optional(
        self, server_key: str, server_config: MCPServerConfig,
        startup_ready: asyncio.Event | None,
    ) -> None:
        generation = self._startup_generation
        try:
            if startup_ready is not None:
                await startup_ready.wait()
            if self._closed or generation != self._startup_generation:
                return
            await self._start_one(server_key, server_config)
            if (not self._closed and generation == self._startup_generation
                    and server_key in self._clients and self.tools_changed_callback is not None):
                await self.tools_changed_callback()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Observe background publication errors after core startup returned.
            log.warning("mcp.tools.publish_failed", server=server_key, error=_short_error(exc))
            await record_audit(self.db, "mcp.tools.publish_failed", detail={"server": server_key, "error": _short_error(exc)})

    async def _start_one(self, server_key: str, server_config: MCPServerConfig) -> None:
        generation = self._startup_generation
        state = self._states[server_key] = MCPServerState(
            key=server_key,
            transport=server_config.transport,
            status="pending",
            required=server_config.required,
            approval=_server_approval(self.mcp_config, server_config),
        )
        log.info("mcp.server.starting", server=server_key, transport=server_config.transport, required=server_config.required)
        client = None
        completed = False
        try:
            client = MCPClient(server_key, server_config.model_copy(update={
                "tool_call_timeout_s": server_config.tool_call_timeout_s or self.mcp_config.tool_call_timeout_s,
            }))
            client.set_notification_handler(
                lambda method, params, key=server_key: self._handle_server_notification(key, method, params)
            )
            connect_timeout_s = float(server_config.connect_timeout_s or self.mcp_config.startup_timeout_s)
            client_connect_timeout_s = float(server_config.connect_timeout_s or 20)
            await asyncio.wait_for(
                client.connect(),
                timeout=_connect_outer_timeout(connect_timeout_s, client_connect_timeout_s, server_config),
            )
            raw_tools = await asyncio.wait_for(client.list_tools(), timeout=connect_timeout_s)
            raw_prompts = await self._list_prompts(client, timeout_s=connect_timeout_s)
            async with self._registry_lock:
                if self._closed or generation != self._startup_generation:
                    raise asyncio.CancelledError
                used = set(self._tools.keys())
                discovered = []
                for raw_tool in raw_tools:
                    meta = build_tool_meta(
                        self.mcp_config,
                        server_config,
                        server_key=server_key,
                        raw_tool=raw_tool,
                        used_names=used,
                    )
                    discovered.append(meta)
                    if meta.filtered:
                        log.info(
                            "mcp.tool.filtered",
                            server=server_key,
                            tool=raw_tool.name,
                            public=meta.public_name,
                            reason=meta.filter_reason,
                        )
                # Publish complete discovery together with the callable client.
                await self._gate_exposure(server_key, discovered, state)
                visible = sum(not meta.filtered for meta in discovered)
                self._all_tools.extend(discovered)
                self._tools.update({meta.public_name: meta for meta in discovered if not meta.filtered})
                self._prompts[server_key] = raw_prompts
                if client.instructions:
                    self._server_instructions[server_key] = client.instructions
                self._clients[server_key] = client
                state.tool_count = visible
                state.last_connected_at = time.time()
            log.info("mcp.server.connected", server=server_key, transport=server_config.transport, tools=visible, prompts=len(raw_prompts))
            log.info("mcp.tools.discovered", server=server_key, total=len(raw_tools), visible=visible)
            if raw_prompts:
                log.info("mcp.prompts.discovered", server=server_key, total=len(raw_prompts))
            await record_audit(self.db, "mcp.server.started", detail={"server": server_key, "transport": server_config.transport, "tools": visible, "prompts": len(raw_prompts)})
            completed = True
        except asyncio.CancelledError:
            state.status = "stopped"
            state.tool_count = 0
            raise
        except Exception as exc:
            err = _short_error(exc)
            state.status = "failed"
            state.tool_count = 0
            state.error = err
            state.last_failed_at = time.time()
            log.warning("mcp.server.failed", server=server_key, transport=server_config.transport, required=server_config.required, error=err)
            await record_audit(self.db, "mcp.server.failed", detail={"server": server_key, "transport": server_config.transport, "error": err})
            if server_config.required:
                raise RuntimeError(f"required MCP server {server_key} failed: {err}") from exc
        finally:
            if client is not None and not completed:
                if self._clients.get(server_key) is client:
                    self._clients.pop(server_key)
                    self._tools = {name: meta for name, meta in self._tools.items() if meta.server_key != server_key}
                    self._all_tools = [meta for meta in self._all_tools if meta.server_key != server_key]
                    self._prompts.pop(server_key, None)
                    self._server_instructions.pop(server_key, None)
                # CancelledError is not an Exception. Clients cancelled before
                # entering _clients also own transports that must be closed.
                await _wait_for_cleanup(asyncio.create_task(
                    _close_clients([(server_key, client)]), name=f"mcp-start-cleanup-{server_key}",
                ))

    async def _list_prompts(self, client: MCPClient, *, timeout_s: float) -> list[dict[str, Any]]:
        """Best-effort prompt discovery for management UI.

        Prompts are not registered as callable OpenBear tools, but showing them in
        /mcp makes servers like Ponytail understandable.  Missing prompt support is
        normal for many MCP servers, so failures are ignored.
        """
        try:
            return await asyncio.wait_for(
                client.list_prompts(),
                timeout=max(1.0, float(timeout_s or 1)),
            )
        except Exception:
            return []

    async def _handle_server_notification(
        self,
        server_key: str,
        method: str,
        params: dict[str, Any],
    ) -> None:
        del params
        if self._closed or method != "notifications/tools/list_changed":
            return
        try:
            await self.refresh_server_tools(server_key)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("mcp.tools.refresh_failed", server=server_key, error=_short_error(exc))
            await record_audit(self.db, "mcp.tools.refresh_failed", detail={"server": server_key, "error": _short_error(exc)})

    async def refresh_server_tools(self, server_key: str) -> dict[str, Any]:
        """Rediscover all pages on the existing connection and publish atomically.

        Manual refresh and tools/list_changed share this path. Failed discovery
        leaves the previous descriptions, schemas and other services intact.
        """
        async with self._refresh_locks.setdefault(server_key, asyncio.Lock()):
            if server_key not in self.mcp_config.servers:
                raise ValueError("mcp_server_not_found")
            client = self._clients.get(server_key)
            if client is None:
                raise ValueError("mcp_server_not_connected")
            if not await self._begin_server_call(server_key):
                raise ValueError("mcp_server_draining")
            try:
                cfg = self.mcp_config.servers[server_key]
                raw_tools = await asyncio.wait_for(client.list_tools(), timeout=float(cfg.connect_timeout_s or self.mcp_config.startup_timeout_s))
                async with self._registry_lock:
                    if self._closed or self._clients.get(server_key) is not client:
                        raise ValueError("mcp_refresh_superseded")
                    cfg = self.mcp_config.servers[server_key]
                    previous_all, previous_tools = self._all_tools, self._tools
                    old = [m for m in self._all_tools if m.server_key == server_key]
                    retained = [m for m in self._all_tools if m.server_key != server_key]
                    old_names = {m.original_tool_name: m.public_name for m in old}
                    used = {m.public_name for m in retained} | set(old_names.values())
                    replacements = []
                    for raw in raw_tools:
                        meta = build_tool_meta(self.mcp_config, cfg, server_key=server_key, raw_tool=raw, used_names=used)
                        if raw.name in old_names:
                            meta.public_name = old_names[raw.name]
                            allowed, reason = is_tool_allowed(self.mcp_config, cfg, server_key=server_key, raw_tool_name=raw.name, public_tool_name=meta.public_name)
                            meta.enabled = allowed
                            meta.filtered, meta.filter_reason = not allowed, reason
                        replacements.append(meta)
                    state = self._states.get(server_key)
                    previous_state = state.model_copy(deep=True) if state is not None else None
                    if state is not None:
                        await self._gate_exposure(server_key, replacements, state)
                    changed = old != replacements
                    by_server = {key: [m for m in retained if m.server_key == key] for key in self.mcp_config.servers}
                    by_server[server_key] = replacements
                    self._all_tools = [m for rows in by_server.values() for m in rows]
                    self._tools = {m.public_name: m for m in self._all_tools if not m.filtered}
                    state = self._states.get(server_key)
                    if state is not None:
                        state.tool_count = sum(not m.filtered for m in replacements)
                published = self._all_tools
                try:
                    if self.tools_changed_callback is not None:
                        await self.tools_changed_callback()
                except Exception:
                    async with self._registry_lock:
                        if self._clients.get(server_key) is client and self._all_tools is published:
                            self._all_tools, self._tools = previous_all, previous_tools
                            if previous_state is not None:
                                self._states[server_key] = previous_state
                    raise
                await record_audit(self.db, "mcp.tools.list_changed", detail={"server": server_key, "total": len(replacements), "changed": changed})
                return {"ok": True, "server": server_key, "changed": changed, "totalTools": len(replacements)}
            finally:
                await self._end_server_call(server_key)

    async def _gate_exposure(self, key: str, tools: list[MCPToolMeta], state: MCPServerState) -> None:
        row = exposure_summary(self.mcp_config, key, tools)
        approved = await self.exposure_approvals.is_approved(self.mcp_config, key, row["fingerprint"])
        pending = row["exceeded"] and not approved
        state.status = "awaiting_confirmation" if pending else "connected"
        state.enabled_tool_count = row["enabledTools"]
        state.total_tool_count = row["totalTools"]
        state.definition_bytes = row["definitionBytes"]
        state.exposure_fingerprint = row["fingerprint"]
        for meta in tools:
            if meta.enabled:
                meta.filtered = bool(pending)
                meta.filter_reason = "awaiting_confirmation" if pending else "allowed"
        state.tool_count = sum(not meta.filtered for meta in tools)

    def exposure_warnings(self) -> list[dict[str, Any]]:
        rows = []
        for key in self.mcp_config.servers:
            tools = [meta for meta in self._all_tools if meta.server_key == key]
            if tools:
                row = exposure_summary(self.mcp_config, key, tools)
                if row["exceeded"]:
                    rows.append(row)
        return rows

    async def apply_exposure_approvals(self) -> None:
        async with self._registry_lock:
            for key, state in self._states.items():
                if key in self._clients:
                    await self._gate_exposure(key, [m for m in self._all_tools if m.server_key == key], state)
            self._tools = {m.public_name: m for m in self._all_tools if not m.filtered}

    def agent_tool_unavailable_reason(self, public_name: str) -> str:
        meta = next((m for m in self._all_tools if m.public_name == public_name), None)
        if meta is None:
            return "mcp_tool_not_found"
        cfg = self.mcp_config.servers.get(meta.server_key)
        if cfg is None:
            return "mcp_server_not_found"
        reason = agent_access_reason(cfg, meta.original_tool_name)
        if reason:
            return reason
        allowed, reason = is_tool_allowed(self.mcp_config, cfg, server_key=meta.server_key, raw_tool_name=meta.original_tool_name, public_tool_name=public_name)
        if not allowed:
            return reason
        if meta.filtered:
            return meta.filter_reason or "mcp_tool_filtered"
        if meta.approval == "deny":
            return "approval_deny"
        if meta.server_key not in self._clients or self._closed:
            return "mcp_server_not_connected"
        if meta.server_key in self._draining_servers:
            return "mcp_server_draining"
        return ""

    def agent_tools(self) -> list[MCPToolMeta]:
        return [meta for meta in self.available_tools() if not self.agent_tool_unavailable_reason(meta.public_name)]

    @staticmethod
    def connection_config(config: Config) -> dict[str, Any]:
        data = config.mcp.model_dump(mode="json", by_alias=True)
        for server in data["servers"].values():
            server.pop("agentAccess", None)
        return data

    def access_only_change(self, config: Config) -> bool:
        return self.connection_config(self.config) == self.connection_config(config)

    async def apply_agent_access_config(self, config: Config) -> None:
        if not self.access_only_change(config):
            raise ValueError("mcp_non_access_config_changed")
        async with self._registry_lock:
            self.config = config
            self.mcp_config = config.mcp
        # Clients, main-session grants and in-flight calls are untouched.

    async def _cancel_startup_tasks(self) -> None:
        self._startup_generation += 1
        tasks = list(self._startup_tasks)
        for task in tasks:
            if not task.done() and not task.cancelling():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._startup_tasks.difference_update(tasks)
        for state in self._states.values():
            if state.status == "pending":
                state.status = "stopped"

    async def close(self) -> None:
        # _closed rejects publication immediately; all callers still wait for the
        # same cleanup, including callers cancelled while shutdown is in progress.
        self._closed = True
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close_resources(), name="mcp-manager-close")
        await _wait_for_cleanup(self._close_task)

    async def _close_resources(self) -> None:
        async with self._lifecycle_lock:
            await self._cancel_startup_tasks()
            prepared = list(self._prepared_managers)
            if prepared:
                await asyncio.gather(*(manager.close() for manager in prepared))
                self._prepared_managers.difference_update(prepared)
            clients = list(self._clients.items())
            self._clients.clear()
            await _close_clients(clients, db=self.db)
            for server_key, _client in clients:
                state = self._states.get(server_key)
                if state is not None:
                    state.status = "stopped"

    async def prepare_reload(self, config: Config, *, exposure_confirmation: Callable[..., Awaitable[dict[str, Any]]] | None = None) -> tuple[Callable[[], Awaitable[None]], Callable[[], Awaitable[None]]]:
        """Prepare a hot reload and return ``(commit, abort)`` callbacks.

        The current manager is left untouched while this method starts new MCP
        servers and discovers tools.  Call ``commit`` only after other runtime state
        is ready to switch.  If preparation raises, old clients/tools are still
        active.  If a prepared reload is superseded before commit, call ``abort`` to
        close the fresh-but-unused clients.
        """
        if self._closed:
            raise RuntimeError("mcp_manager_closed")
        if exposure_confirmation is None and self.access_only_change(config) and self.config.mcp != config.mcp:
            async def commit_access() -> None:
                async with self._lifecycle_lock:
                    if self._closed:
                        raise RuntimeError("mcp_manager_closed")
                    await self.apply_agent_access_config(config)

            async def abort_access() -> None:
                return None

            return commit_access, abort_access
        if not config.mcp.enabled:
            if exposure_confirmation is not None:
                answer = await exposure_confirmation([], digest(config.mcp.model_dump(mode="json")))
                if not explicit_authorization(answer):
                    raise MCPExposureNotAuthorized(answer)
            async def commit_disabled() -> None:
                async with self._lifecycle_lock:
                    if self._closed:
                        raise RuntimeError("mcp_manager_closed")
                    await _wait_for_cleanup(asyncio.create_task(self._cancel_startup_tasks()))
                    if self._closed:
                        raise RuntimeError("mcp_manager_closed")
                    old_clients = list(self._clients.items())
                    self.config = config
                    self.mcp_config = config.mcp
                    self._clients = {}
                    self._tools = {}
                    self._all_tools = []
                    self._prompts = {}
                    self._server_instructions = {}
                    self._conversation_grants.clear()
                    self._states = {
                        key: MCPServerState(
                            key=key,
                            transport=cfg.transport,
                            status="disabled",
                            required=cfg.required,
                            approval=_server_approval(config.mcp, cfg),
                        )
                        for key, cfg in config.mcp.servers.items()
                    }
                    self._started = True
                    await _wait_for_cleanup(asyncio.create_task(_close_clients(old_clients, db=self.db)))
                    await record_audit(self.db, "mcp.reload.disabled", detail={"servers": len(config.mcp.servers)})

            async def abort_disabled() -> None:
                return None

            return commit_disabled, abort_disabled

        fresh = MCPManager(
            config,
            interactions=self.interactions,
            db=self.db,
            approval_updater=self.approval_updater,
            exposure_approvals=self.exposure_approvals,
        )
        self._prepared_managers.add(fresh)

        async def abort_fresh() -> None:
            try:
                await fresh.close()
            finally:
                self._prepared_managers.discard(fresh)

        try:
            await fresh.start()
            if exposure_confirmation is not None:
                rows = fresh.exposure_warnings()
                answer = await exposure_confirmation(rows, digest(config.mcp.model_dump(mode="json")))
                if not explicit_authorization(answer):
                    raise MCPExposureNotAuthorized(answer)
                if rows != fresh.exposure_warnings():
                    raise MCPExposureNotAuthorized({"status": "error", "error": "mcp_tools_changed_during_confirmation"})
                await self.exposure_approvals.approve(rows)
                await fresh.apply_exposure_approvals()
            if self._closed:
                raise RuntimeError("mcp_manager_closed")
        except (asyncio.CancelledError, Exception):
            await abort_fresh()
            raise

        # Optional servers are allowed to fail during a cold start, but an atomic hot
        # reload must not replace an already-healthy server with a failed generation.
        def check_replacements() -> None:
            failed_replacements = sorted(
                key
                for key, state in fresh._states.items()
                if state.status == "failed" and key in self._clients
            )
            if failed_replacements:
                joined = ", ".join(failed_replacements)
                raise RuntimeError(f"MCP reload would replace healthy server(s) with failed generation: {joined}")

        try:
            check_replacements()
        except Exception:
            await abort_fresh()
            raise

        async def commit_fresh() -> None:
            try:
                async with self._lifecycle_lock:
                    if self._closed:
                        raise RuntimeError("mcp_manager_closed")
                    if fresh not in self._prepared_managers or fresh._closed:
                        raise RuntimeError("mcp_reload_superseded")
                    # A deferred old server may have become healthy since prepare.
                    check_replacements()
                    # Preparation leaves current connections untouched. Only the
                    # commit boundary retires gate waiters, discovery and callbacks.
                    await _wait_for_cleanup(asyncio.create_task(self._cancel_startup_tasks()))
                    if self._closed:
                        raise RuntimeError("mcp_manager_closed")
                    if fresh not in self._prepared_managers or fresh._closed:
                        raise RuntimeError("mcp_reload_superseded")
                    check_replacements()
                    old_clients = list(self._clients.items())
                    self.config = config
                    self.mcp_config = config.mcp
                    self._clients = fresh._clients
                    for server_key, client in self._clients.items():
                        client.set_notification_handler(
                            lambda method, params, key=server_key: self._handle_server_notification(key, method, params)
                        )
                    self._states = fresh._states
                    self._tools = fresh._tools
                    self._all_tools = fresh._all_tools
                    self._prompts = fresh._prompts
                    self._server_instructions = fresh._server_instructions
                    # Grants only authorize the exact config/transport generation.
                    self._conversation_grants.clear()
                    self._started = fresh._started
                    # Ownership moved; abort/close of the temporary manager must
                    # not close the adopted clients.
                    fresh._clients = {}
                    self._prepared_managers.discard(fresh)
                    await _wait_for_cleanup(asyncio.create_task(_close_clients(old_clients, db=self.db)))
                    await record_audit(self.db, "mcp.reload.completed", detail={"servers": len(config.mcp.servers), "tools": len(self._tools)})
            except (asyncio.CancelledError, Exception):
                await abort_fresh()
                raise

        return commit_fresh, abort_fresh

    async def reload(self, config: Config) -> None:
        """Hot-reload MCP servers/tools for a new runtime config."""
        commit, _abort = await self.prepare_reload(config)
        await commit()

    def status_snapshot(self) -> MCPManagerState:
        """Return configured servers in deterministic config order.

        Connection tasks complete asynchronously, so ``_states`` insertion order is
        runtime timing rather than user configuration order.  Build the snapshot
        from the config keys first and append only unexpected runtime states after.
        """
        states = dict(self._states)
        for key, client in self._clients.items():
            fatal = getattr(getattr(client, "transport", None), "fatal_error", "")
            if fatal and key in states:
                states[key].status = "failed"
                states[key].error = str(fatal)
        ordered: list[MCPServerState] = []
        configured_keys: set[str] = set()
        for key, cfg in self.mcp_config.servers.items():
            configured_keys.add(key)
            ordered.append(states.get(key) or MCPServerState(
                key=key,
                transport=cfg.transport,
                status="disabled" if not self.mcp_config.enabled or not cfg.enabled else "pending",
                required=cfg.required,
                approval=_server_approval(self.mcp_config, cfg),
            ))
        ordered.extend(state for key, state in states.items() if key not in configured_keys)
        return MCPManagerState(enabled=self.mcp_config.enabled, servers=ordered)

    def available_tools(self) -> list[MCPToolMeta]:
        return list(self._tools.values())

    def all_tools_snapshot(self) -> list[MCPToolMeta]:
        return list(self._all_tools)

    def prompts_snapshot(self) -> dict[str, list[dict[str, Any]]]:
        return {key: [dict(item) for item in items] for key, items in self._prompts.items()}

    def server_instructions_snapshot(self) -> list[dict[str, str]]:
        return [
            {"server": key, "instructions": value}
            for key, value in self._server_instructions.items()
            if value.strip() and self._states.get(key) and self._states[key].status == "connected"
        ]

    async def begin_server_uninstall(self, server_key: str) -> tuple[bool, int]:
        """Reserve a server for uninstall without interrupting an active call."""
        async with self._call_lifecycle_lock:
            active = self._active_calls.get(server_key, 0)
            if active or server_key in self._draining_servers:
                return False, active
            self._draining_servers.add(server_key)
            return True, 0

    async def end_server_uninstall(self, server_key: str) -> None:
        async with self._call_lifecycle_lock:
            self._draining_servers.discard(server_key)

    async def _begin_server_call(self, server_key: str) -> bool:
        async with self._call_lifecycle_lock:
            if server_key in self._draining_servers:
                return False
            self._active_calls[server_key] = self._active_calls.get(server_key, 0) + 1
            return True

    async def _end_server_call(self, server_key: str) -> None:
        async with self._call_lifecycle_lock:
            active = self._active_calls.get(server_key, 0)
            if active <= 1:
                self._active_calls.pop(server_key, None)
            else:
                self._active_calls[server_key] = active - 1

    async def call_tool(self, public_tool_name: str, arguments: dict[str, Any], context: ToolRuntimeContext, *, expected_identity: tuple[str, str] | None = None) -> str:
        meta = self._tools.get(public_tool_name)
        if meta is None or (expected_identity is not None and expected_identity != (meta.server_key, meta.original_tool_name)):
            return _json({"status": "error", "error": "mcp_tool_not_found", "tool": public_tool_name})
        client = self._clients.get(meta.server_key)
        if client is None:
            return _json({"status": "error", "error": "mcp_server_not_connected", "server": meta.server_key})
        if not await self._begin_server_call(meta.server_key):
            return _json({"status": "error", "error": "mcp_server_draining", "server": meta.server_key})
        try:
            return await self._call_tool_reserved(meta, client, arguments, context)
        finally:
            await self._end_server_call(meta.server_key)

    async def _call_tool_reserved(
        self,
        meta: MCPToolMeta,
        client: MCPClient,
        arguments: dict[str, Any],
        context: ToolRuntimeContext,
    ) -> str:
        if is_agent_context(context):
            reason = self.agent_tool_unavailable_reason(meta.public_name)
            if reason:
                return _json({"status": "needs_openbear_control", "error": reason, "reason": reason,
                              "tool": meta.public_name, "message": "MCP Agent access is unavailable; the call was not sent."})
        persist_trust = False
        allowed, reason = can_call_without_prompt(meta, context)
        # Explicit deny is authoritative. A conversation grant can only satisfy an
        # otherwise-confirmable ask policy, and only for this exact tool.
        if (
            not allowed
            and reason in {"confirmation_required", "needs_openbear_control"}
            and self._has_conversation_grant(meta, context)
        ):
            allowed, reason = True, "allowed_by_conversation_grant"
        if not allowed:
            if reason == "confirmation_required":
                confirmation: dict[str, Any] = {}
                decision = await self._confirm_call(meta, arguments, context, feedback=confirmation)
                if decision in {"conversation", "always"}:
                    self._grant_conversation(meta, context)
                persist_trust = decision == "always"
                if decision == "amendments_required":
                    return _json({"status": "amendments_required", "outcome": "not_started", "confirmation": confirmation})
                if decision not in {"once", "conversation", "always"}:
                    log.info("mcp.tool.confirm_denied", server=meta.server_key, tool=meta.original_tool_name)
                    await record_audit(self.db, "mcp.tool.denied", actor=_actor(context), chat_id=context.chat_id, detail={"server": meta.server_key, "tool": meta.original_tool_name, "reason": "user_denied"})
                    return _json({"status": "denied", "error": "mcp_tool_call_denied", "server": meta.server_key, "tool": meta.original_tool_name, "confirmation": confirmation, "message": "原操作未执行；如用户提交了文字意见，请先按原文调整，不要把选项单独当成授权。"})
            elif reason == "needs_openbear_control":
                return _json({
                    "status": "needs_openbear_control",
                    "reason": "mcp_tool_requires_openbear_control",
                    "error": "mcp_tool_requires_openbear_control",
                    "message": "MCP tool 需要 OpenBear 主控确认或显式授权，子 Agent/后台上下文不会弹交互确认。",
                    "server": meta.server_key,
                    "tool": meta.original_tool_name,
                    "risk": meta.risk,
                    "approval": meta.approval,
                })
            else:
                await record_audit(self.db, "mcp.tool.denied", actor=_actor(context), chat_id=context.chat_id, detail={"server": meta.server_key, "tool": meta.original_tool_name, "reason": reason})
                return _json({
                    "status": "denied",
                    "error": "mcp_tool_call_denied",
                    "reason": reason,
                    "server": meta.server_key,
                    "tool": meta.original_tool_name,
                    "risk": meta.risk,
                    "approval": meta.approval,
                })
        server_config = self.mcp_config.servers.get(meta.server_key)
        if server_config is None:
            return _json({"status": "error", "error": "mcp_server_not_configured", "server": meta.server_key})
        timeout_s = float(server_config.tool_call_timeout_s or self.mcp_config.tool_call_timeout_s)
        try:
            log.info("mcp.tool.called", server=meta.server_key, tool=meta.original_tool_name, public=meta.public_name, risk=meta.risk)
            raw_result = await asyncio.wait_for(
                self._send_tool(client, meta, arguments, context),
                # Transport owns the deadline; this is only a stuck-client watchdog.
                timeout=timeout_s + 1,
            )
            rendered = format_mcp_result(raw_result, meta, self.mcp_config)
            await record_audit(self.db, "mcp.tool.called", actor=_actor(context), chat_id=context.chat_id, detail={"server": meta.server_key, "tool": meta.original_tool_name, "risk": meta.risk, "resultChars": len(rendered)})
            if persist_trust:
                await self._persist_server_trust(meta, context)
            return rendered
        except MCPAgentAccessRevoked as exc:
            return _json({"status": "needs_openbear_control", "error": str(exc), "reason": str(exc), "tool": meta.public_name})
        except TimeoutError:
            log.warning("mcp.tool.timeout", server=meta.server_key, tool=meta.original_tool_name)
            await record_audit(self.db, "mcp.tool.failed", actor=_actor(context), chat_id=context.chat_id, detail={"server": meta.server_key, "tool": meta.original_tool_name, "error": "timeout"})
            return _json({
                "status": "error", "error": "mcp_tool_timeout", "outcome": "unknown",
                "server": meta.server_key, "tool": meta.original_tool_name,
                "transportTimeoutSeconds": timeout_s,
                "detail": "OpenBear MCP transport deadline exceeded. Tool timeout arguments cannot extend this limit; remote execution may still be running. Check the outcome before retrying.",
            })
        except Exception as exc:
            err = _short_error(exc)
            log.warning("mcp.tool.failed", server=meta.server_key, tool=meta.original_tool_name, error=err)
            await record_audit(self.db, "mcp.tool.failed", actor=_actor(context), chat_id=context.chat_id, detail={"server": meta.server_key, "tool": meta.original_tool_name, "error": err})
            return _json({"status": "error", "error": "mcp_tool_failed", "server": meta.server_key, "tool": meta.original_tool_name, "detail": err})

    async def _send_tool(self, client: MCPClient, meta: MCPToolMeta, arguments: dict[str, Any], context: ToolRuntimeContext):
        if is_agent_context(context):
            reason = self.agent_tool_unavailable_reason(meta.public_name)
            if reason:
                raise MCPAgentAccessRevoked(reason)
        return await client.call_tool(meta.original_tool_name, arguments or {})

    async def _confirm_call(self, meta: MCPToolMeta, arguments: dict[str, Any], context: ToolRuntimeContext, *, feedback: dict[str, Any] | None = None) -> str:
        if not (context.source == "web" and context.web_confirm is not None):
            return "deny"
        log.info("mcp.tool.confirm_requested", server=meta.server_key, tool=meta.original_tool_name, risk=meta.risk, source=context.source)
        body = (
            f"MCP server: {meta.server_key}\n"
            f"Tool: {meta.original_tool_name}\n"
            f"Risk: {meta.risk}\n"
            f"Approval: {meta.approval}\n"
            f"Arguments 摘要:\n{summarize_arguments(arguments)}"
        )
        payload = {
            "action": "select",
            "_sourceTool": "MCP",
            "_requiresAuthorization": True,
            # The argument summary can contain private user data. Do not mirror
            # MCP permission prompts to Telegram, even when answers are simple.
            "sensitive": True,
            "title": "确认执行 MCP 工具",
            "body": body,
            "type": "warning",
            "options": [
                {"label": "仅本次允许", "value": "once"},
                {"label": "当前会话允许", "value": "conversation"},
                {"label": "始终信任此 MCP", "value": "always"},
            ],
            "defaultValues": ["once"],
            "confirmText": "执行",
            "cancelText": "拒绝",
            "timeoutSeconds": 600,
        }
        result = await context.web_confirm(payload)
        if feedback is not None:
            feedback.update(result)
        if result.get("decision") == "confirm_with_changes" and result.get("authorizationGranted") is True:
            return "amendments_required"
        decision = "deny"
        if (result.get("status", "answered") == "answered"
                and not bool(result.get("cancelled"))
                and not str(result.get("text") or "").strip()
                and result.get("decision") != "feedback"
                and result.get("authorizationGranted") is not False):
            values = result.get("selectedValues")
            if isinstance(values, list) and len(values) == 1:
                candidate = str(values[0] or "").strip().lower()
                if candidate in {"once", "conversation", "always"}:
                    decision = candidate
            # Compatibility with older/binary confirmation callbacks used by
            # integrations and tests while the Web UI moves to select mode.
            elif explicit_authorization(result):
                decision = "once"
        if decision != "deny":
            log.info("mcp.tool.confirm_approved", server=meta.server_key, tool=meta.original_tool_name, scope=decision)
            await record_audit(self.db, "mcp.tool.approved", actor=_actor(context), chat_id=context.chat_id, detail={"server": meta.server_key, "tool": meta.original_tool_name, "risk": meta.risk, "scope": decision})
        return decision

    @staticmethod
    def _conversation_key(context: ToolRuntimeContext) -> str:
        return str(context.conversation_uuid or context.session_uuid or "").strip()

    def _has_conversation_grant(self, meta: MCPToolMeta, context: ToolRuntimeContext) -> bool:
        key = self._conversation_key(context)
        grant = (key, meta.server_key, meta.original_tool_name)
        return bool(key and grant in self._conversation_grants)

    def _grant_conversation(self, meta: MCPToolMeta, context: ToolRuntimeContext) -> None:
        key = self._conversation_key(context)
        if key:
            self._conversation_grants.add((key, meta.server_key, meta.original_tool_name))

    async def _persist_server_trust(self, meta: MCPToolMeta, context: ToolRuntimeContext) -> None:
        if self.approval_updater is None:
            log.warning("mcp.tool.trust_persist_unavailable", server=meta.server_key)
            return
        try:
            await self.approval_updater(meta.server_key, "allow")
            await record_audit(self.db, "mcp.server.approval.updated", actor=_actor(context), chat_id=context.chat_id, detail={"server": meta.server_key, "approval": "allow", "source": "confirmation"})
        except Exception as exc:
            log.warning("mcp.tool.trust_persist_failed", server=meta.server_key, error=_short_error(exc))
            await record_audit(self.db, "mcp.server.approval.update_failed", actor=_actor(context), chat_id=context.chat_id, detail={"server": meta.server_key, "approval": "allow", "source": "confirmation", "error": _short_error(exc)})


async def _wait_for_cleanup(task: asyncio.Task[None]) -> None:
    """Join owned resource cleanup even under repeated caller cancellation."""
    cancelled = None
    try:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError as exc:
                if task.cancelled():
                    raise
                cancelled = exc
        task.result()
    finally:
        if cancelled is not None:
            raise cancelled


async def _close_clients(clients: list[tuple[str, MCPClient]], *, db: Any = None) -> None:
    for server_key, client in clients:
        try:
            await client.close()
        except Exception as exc:
            log.warning("mcp.server.close_failed", server=server_key, error=_short_error(exc))
        log.info("mcp.server.stopped", server=server_key)
        await record_audit(db, "mcp.server.stopped", detail={"server": server_key})


def _server_approval(mcp_config: Any, server_config: MCPServerConfig) -> str:
    value = str(server_config.approval or getattr(mcp_config, "default_approval", "ask") or "ask").strip().lower()
    return value if value in {"allow", "ask", "deny"} else "ask"


def _connect_outer_timeout(connect_timeout_s: float, client_connect_timeout_s: float, server_config: MCPServerConfig) -> float:
    if str(getattr(server_config, "transport", "") or "") == "stdio" and str(getattr(server_config, "stdio_mode", "auto") or "auto") == "auto":
        # Auto stdio may retry initialize once with Content-Length framing after a
        # newline-json timeout.  The manager-level timeout must allow both attempts.
        return max(connect_timeout_s, client_connect_timeout_s * 2 + 1.0)
    return connect_timeout_s


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)


def _short_error(exc: Exception) -> str:
    text = redact_text_secrets(f"{type(exc).__name__}: {exc}")
    return text[:1200]


def _actor(context: ToolRuntimeContext) -> str:
    if context.agent_session_uuid or context.agent_key:
        return f"agent:{context.agent_key or context.agent_session_uuid}"
    return context.source or "chat"
