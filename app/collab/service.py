"""Cross-conversation request lifecycle.

A request is durable; a receiver turn is an ordinary Web turn started the same
way Webhook assignments start one. The sender keeps its root run and waits
through the AgentWait wake edge; results travel back through the existing
restart-safe web_task_notifications outbox, so an ended sender turn is resumed
by the same post-turn worker that delivers Agent results.
"""
from __future__ import annotations

import asyncio
import contextlib
import uuid
from typing import Any

from app.collab import prompts
from app.collab.store import (
    MAX_CHAIN_DEPTH,
    MAX_INPUT_ROUNDS,
    MAX_REQUESTS_PER_TARGET,
    OPEN_STATES,
    STATE_LABELS,
    TERMINAL_STATES,
    add_event,
    conversation_titles,
    dumps,
    loads,
    many,
    member_row,
    new_id,
    now_ms,
    one,
    public_request,
)
from app.logging import get_logger

log = get_logger("collab")


class CollabError(Exception):
    def __init__(self, code: str, message: str = "", **details: Any) -> None:
        super().__init__(code)
        self.code, self.message, self.details = code, message or code, details

    def payload(self) -> dict[str, Any]:
        return {"ok": False, "error": self.code, "message": self.message, **self.details}


class CollabService:
    def __init__(self, db, host) -> None:
        self.db = db
        self.host = host
        host.collab = self
        self.active: dict[str, str] = {}  # receiver conversation -> request in its running turn
        self._held_results: dict[str, str] = {}
        self._wake = asyncio.Event()
        self._worker: asyncio.Task | None = None
        self._closing = False

    # ---- lifecycle -------------------------------------------------------
    async def start(self) -> None:
        self._closing = False
        # A receiver turn does not survive a restart. Re-deliver its request
        # (the receiver context records what already happened) rather than
        # leaving the sender waiting forever.
        async with self.db.write_transaction(label="collab-recover") as conn:
            await conn.execute("UPDATE collab_requests SET state='queued',updated_at_ms=? WHERE state IN ('delivered','working')", (now_ms(),))
        self._worker = asyncio.create_task(self._run(), name="collab-dispatch")
        self._wake.set()

    async def stop(self) -> None:
        self._closing = True
        self._wake.set()
        if self._worker is not None:
            self._worker.cancel()
            with contextlib.suppress(BaseException):
                await self._worker
            self._worker = None

    def wake(self) -> None:
        self._wake.set()

    async def _run(self) -> None:
        from app.lifecycle import wait_for_startup
        await wait_for_startup(self.host)
        while not self._closing:
            self._wake.clear()
            try:
                await self.dispatch()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("跨会话请求调度失败")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=2.0)

    # ---- queries -----------------------------------------------------------
    async def conversation(self, conversation_uuid: str) -> dict[str, Any] | None:
        return await one(self.db.conn, "SELECT * FROM web_conversations WHERE conversation_uuid=?", (conversation_uuid,))

    async def request(self, request_uuid: str) -> dict[str, Any] | None:
        return await one(self.db.conn, "SELECT * FROM collab_requests WHERE request_uuid=?", (request_uuid,))

    async def open_for_sender(self, conversation_uuid: str, root_turn_uuid: str = "") -> list[dict[str, Any]]:
        sql = f"SELECT * FROM collab_requests WHERE from_conversation_uuid=? AND state IN ({','.join('?' for _ in OPEN_STATES)})"
        params: tuple = (conversation_uuid, *OPEN_STATES)
        if root_turn_uuid:
            sql += " AND from_root_turn_uuid=?"
            params += (root_turn_uuid,)
        return await many(self.db.conn, sql + " ORDER BY created_at_ms", params)

    async def awaiting_sender(self, conversation_uuid: str, root_turn_uuid: str = "") -> list[dict[str, Any]]:
        """Requests the sender is still waiting for (needs_input is the sender's turn to act)."""
        return [row for row in await self.open_for_sender(conversation_uuid, root_turn_uuid) if row["state"] != "needs_input"]

    async def list_public(self, conversation_uuid: str, *, limit: int = 50) -> dict[str, Any]:
        rows = await many(self.db.conn, """SELECT * FROM collab_requests WHERE from_conversation_uuid=? OR to_conversation_uuid=?
            ORDER BY created_at_ms DESC LIMIT ?""", (conversation_uuid, conversation_uuid, limit))
        titles = await conversation_titles(self.db.conn, [r["from_conversation_uuid"] for r in rows] + [r["to_conversation_uuid"] for r in rows])
        incoming = [public_request(r, titles=titles) for r in rows if r["to_conversation_uuid"] == conversation_uuid]
        for item in incoming:
            item["turnOutcomes"] = await self._turn_outcomes(item["requestId"])
        return {
            "outgoing": [public_request(r, titles=titles) for r in rows if r["from_conversation_uuid"] == conversation_uuid],
            "incoming": incoming,
        }

    async def _turn_outcomes(self, request_uuid: str) -> dict[str, str]:
        """How each receiver turn of a request ended: a turn closed by needs_input keeps that outcome."""
        events = await many(self.db.conn, "SELECT kind,body FROM collab_request_events WHERE request_uuid=? ORDER BY id", (request_uuid,))
        out: dict[str, str] = {}
        turn = ""
        for event in events:
            if event["kind"] == "delivered":
                turn = event["body"] or ""
            elif event["kind"] == "needs_input" and turn:
                out[turn] = "needs_input"
        return out

    async def detail_public(self, owner: int, request_uuid: str) -> dict[str, Any] | None:
        row = await self.request(request_uuid)
        if not row or int(row["owner_chat_id"]) != int(owner):
            return None
        titles = await conversation_titles(self.db.conn, [row["from_conversation_uuid"], row["to_conversation_uuid"]])
        events = await many(self.db.conn, "SELECT kind,body,created_at_ms FROM collab_request_events WHERE request_uuid=? ORDER BY id", (request_uuid,))
        return {**public_request(row, titles=titles), "body": row["body"], "resultText": row["result_text"], "note": row["note"],
                "events": [{"kind": e["kind"], "body": e["body"], "atMs": e["created_at_ms"]} for e in events]}

    # ---- sending -----------------------------------------------------------
    async def _allowed_target(self, sender: dict[str, Any], target: dict[str, Any]) -> None:
        if int(sender["owner_chat_id"]) != int(target["owner_chat_id"]):
            raise CollabError("target_not_found", "目标会话不存在")
        if target["conversation_uuid"] == sender["conversation_uuid"]:
            raise CollabError("self_request", "不能给自己发请求")
        member = await member_row(self.db.conn, sender["conversation_uuid"])
        target_member = await member_row(self.db.conn, target["conversation_uuid"])
        if member:
            # Members reach only their lead and their own group.
            if target["conversation_uuid"] == member["lead_conversation_uuid"]:
                return
            if target_member and target_member["group_uuid"] == member["group_uuid"]:
                return
            raise CollabError("target_outside_group", "成员只能联系本组主会话和本组成员；组外会话请通过主会话联系")
        if target_member:
            if target_member["lead_conversation_uuid"] == sender["conversation_uuid"]:
                return
            raise CollabError("target_is_other_group_member", "这是其他主会话的小组成员，只能由它的主会话联系")

    async def _would_deadlock(self, sender_uuid: str, target_uuid: str) -> bool:
        """True if the target is (transitively) waiting for the sender."""
        seen, frontier = {target_uuid}, [target_uuid]
        while frontier:
            current = frontier.pop()
            rows = await many(self.db.conn, """SELECT to_conversation_uuid FROM collab_requests
                WHERE from_conversation_uuid=? AND state IN ('queued','delivered','working')""", (current,))
            for row in rows:
                nxt = row["to_conversation_uuid"]
                if nxt == sender_uuid:
                    return True
                if nxt not in seen:
                    seen.add(nxt)
                    frontier.append(nxt)
        return False

    async def send(self, *, sender_uuid: str, root_turn_uuid: str, target_uuid: str, title: str, body: str,
                   parent_request: str = "", tool_call_id: str = "") -> dict[str, Any]:
        sender = await self.conversation(sender_uuid)
        target = await self.conversation(target_uuid)
        if not sender:
            raise CollabError("sender_not_found")
        if not target:
            raise CollabError("target_not_found", "目标会话不存在")
        await self._allowed_target(sender, target)
        if await self._would_deadlock(sender_uuid, target_uuid):
            raise CollabError("wait_cycle", "对方（直接或间接）正在等待你，再给它发请求会互相卡死。"
                              "请改用 ConversationRequest(action=respond, outcome=needs_input) 把问题回给上游。")
        parent = await self.request(parent_request) if parent_request else None
        chain = loads(parent["chain_json"], []) if parent else []
        chain = [*chain, sender_uuid]
        if target_uuid in chain:
            raise CollabError("request_loop", "目标已在本次请求链上，拒绝循环转发")
        if len(chain) > MAX_CHAIN_DEPTH:
            raise CollabError("chain_too_deep", f"请求链超过 {MAX_CHAIN_DEPTH} 层")
        count = await one(self.db.conn, """SELECT COUNT(*) n FROM collab_requests WHERE from_conversation_uuid=?
            AND from_root_turn_uuid=? AND to_conversation_uuid=?""", (sender_uuid, root_turn_uuid, target_uuid))
        if root_turn_uuid and int(count["n"]) >= MAX_REQUESTS_PER_TARGET:
            raise CollabError("request_limit", f"本任务发给该会话的请求已达 {MAX_REQUESTS_PER_TARGET} 个上限；请整理现状向上汇报，不要当作通过")
        member = await member_row(self.db.conn, target_uuid)
        request_uuid = new_id()
        ts = now_ms()
        async with self.db.write_transaction(label="collab-send") as conn:
            await conn.execute("""INSERT INTO collab_requests(request_uuid,owner_chat_id,from_conversation_uuid,from_root_turn_uuid,
                from_tool_call_id,to_conversation_uuid,group_uuid,parent_request_uuid,chain_json,title,body,
                state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)""",
                (request_uuid, int(sender["owner_chat_id"]), sender_uuid, root_turn_uuid, tool_call_id, target_uuid,
                 member["group_uuid"] if member else (await member_row(conn, sender_uuid) or {}).get("group_uuid", ""),
                 parent_request, dumps(chain), title, body, ts, ts))
            await add_event(conn, request_uuid, "sent", body)
        self.wake()
        await self._publish_change(sender_uuid, target_uuid)
        return {"requestId": request_uuid, "state": "queued", "stateLabel": STATE_LABELS["queued"]}

    async def supply(self, *, sender_uuid: str, request_uuid: str, text: str) -> dict[str, Any]:
        row = await self.request(request_uuid)
        if not row or row["from_conversation_uuid"] != sender_uuid:
            raise CollabError("request_not_found", "请求不存在或不属于你")
        if row["state"] != "needs_input":
            raise CollabError("not_waiting_input", f"请求当前状态是{STATE_LABELS.get(row['state'])}，不需要补充")
        async with self.db.write_transaction(label="collab-supply") as conn:
            await conn.execute("""UPDATE collab_requests SET state='queued',pending_input=?,question='',updated_at_ms=?
                WHERE request_uuid=? AND state='needs_input'""", (text, now_ms(), request_uuid))
            await add_event(conn, request_uuid, "input", text)
        self.wake()
        await self._publish_change(sender_uuid, row["to_conversation_uuid"])
        return {"requestId": request_uuid, "state": "queued", "stateLabel": STATE_LABELS["queued"]}

    async def cancel(self, request_uuid: str, *, reason: str, by: str = "sender", stop_receiver: bool = True) -> bool:
        row = await self.request(request_uuid)
        if not row or row["state"] in TERMINAL_STATES:
            return False
        async with self.db.write_transaction(label="collab-cancel") as conn:
            changed = await conn.execute(f"""UPDATE collab_requests SET state='cancelled',note=?,updated_at_ms=?,finished_at_ms=?
                WHERE request_uuid=? AND state IN ({','.join('?' for _ in OPEN_STATES)})""",
                (reason, now_ms(), now_ms(), request_uuid, *OPEN_STATES))
            if changed.rowcount != 1:
                return False
            await add_event(conn, request_uuid, "cancelled", reason)
        if stop_receiver and self.active.get(row["to_conversation_uuid"]) == request_uuid:
            target = await self.conversation(row["to_conversation_uuid"])
            if target:
                with contextlib.suppress(Exception):
                    await self.host._stop_web_conversation(target, requested_by="collab", message="请求方已取消")
        if by != "sender":
            await self._notify_sender(await self.request(request_uuid))
        await self._publish_change(row["from_conversation_uuid"], row["to_conversation_uuid"])
        return True

    async def on_conversation_stopped(self, conversation_uuid: str) -> None:
        """Human stop: cancel what this conversation sent and what it was handling."""
        for row in await self.open_for_sender(conversation_uuid):
            await self.cancel(row["request_uuid"], reason="发起方已被老大停止", by="sender")
        request_uuid = self.active.pop(conversation_uuid, "")
        if request_uuid:
            await self.cancel(request_uuid, reason="处理方已被老大停止", by="receiver", stop_receiver=False)

    # ---- receiver side -----------------------------------------------------
    async def declare(self, *, receiver_uuid: str, outcome: str, text: str, request_uuid: str = "") -> dict[str, Any]:
        active = self.active.get(receiver_uuid, "")
        if not active or (request_uuid and request_uuid != active):
            raise CollabError("no_active_request", "本轮不是在处理其他会话的请求，无需 respond")
        if outcome == "needs_input" and not text.strip():
            raise CollabError("question_required", "needs_input 必须写清楚缺什么")
        async with self.db.write_transaction(label="collab-declare") as conn:
            await conn.execute("UPDATE collab_requests SET declaration_json=?,updated_at_ms=? WHERE request_uuid=?",
                               (dumps({"outcome": outcome, "text": text}), now_ms(), active))
        return {"requestId": active, "declared": outcome, "message": "已记录；结束本轮后会把结果交给请求方。"}

    async def dispatch(self) -> None:
        rows = await many(self.db.conn, "SELECT * FROM collab_requests WHERE state='queued' ORDER BY created_at_ms")
        for row in rows:
            if row["to_conversation_uuid"] in self.active:
                continue
            target = await self.conversation(row["to_conversation_uuid"])
            if not target:
                await self._finish(row, "failed", note="目标会话不存在")
                continue
            if await self._busy(target):
                continue
            await self._start(row, target)

    async def _busy(self, row: dict[str, Any]) -> bool:
        conv = str(row["conversation_uuid"])
        if self.host._web_starting_turns.get(conv):
            return True
        state = await self.host._web_active_round_info(conv, int(row["internal_chat_id"]))
        return bool(state.get("active"))

    async def _start(self, row: dict[str, Any], target: dict[str, Any]) -> None:
        from app.web_console.live_stream import _WebStreamRenderer
        host = self.host
        chat_id = int(target["internal_chat_id"])
        async with host.operation_locks.try_chat(chat_id, "collab_request") as acquired:
            if not acquired or await self._busy(target):
                return
            fresh = await self.request(row["request_uuid"])
            if not fresh or fresh["state"] != "queued":
                return
            sender = await self.conversation(row["from_conversation_uuid"])
            sender_title = str((sender or {}).get("title") or "另一个会话")
            supply = fresh["pending_input"]
            text = prompts.delivery_text(fresh, sender_title=sender_title, supply=supply)
            root = str(uuid.uuid4())
            message_uuid = f"collab-{fresh['request_uuid'][:8]}-{now_ms()}"
            async with self.db.write_transaction(label="collab-deliver") as conn:
                await conn.execute("""UPDATE collab_requests SET state='delivered',pending_input='',target_root_turn_uuid=?,
                    declaration_json='',delivered_at_ms=CASE WHEN delivered_at_ms=0 THEN ? ELSE delivered_at_ms END,updated_at_ms=?
                    WHERE request_uuid=? AND state='queued'""", (root, now_ms(), now_ms(), fresh["request_uuid"]))
                await add_event(conn, fresh["request_uuid"], "delivered", root)
            self.active[target["conversation_uuid"]] = fresh["request_uuid"]
            host._web_stop_markers.pop(target["conversation_uuid"], None)
            live = host._live_for(target)
            renderer = _WebStreamRenderer(live=live, artifact_rewriter=host._web_assistant_artifact_rewriter(target, turn_uuid=root))
            card = await self.card(fresh, sender_title=sender_title, supply=bool(supply))
            await live.publish({"type": "accepted", "chatId": chat_id, "turnUuid": root, "runUuid": root,
                                "source": "collab", "collabRequestId": fresh["request_uuid"], "taskNotificationSilent": True})
            await live.publish({"type": "user", "turnUuid": root, "messageUuid": message_uuid, "text": text,
                                "source": "collab", "collabRequestId": fresh["request_uuid"], "collabCard": card})
            task = asyncio.create_task(host._run_web_turn(chat_id, text, renderer, conversation=target, root_turn_uuid=root,
                                                          user_op_id="msg:" + message_uuid, collab_request_id=fresh["request_uuid"]),
                                       name="collab-request:" + fresh["request_uuid"][:8])
            host.runs.register(chat_id, task)
            task.add_done_callback(lambda done, conv=target["conversation_uuid"], rid=fresh["request_uuid"]:
                                   asyncio.get_running_loop().create_task(self._after_turn(conv, rid, done)))
        await self._publish_change(row["from_conversation_uuid"], row["to_conversation_uuid"])

    async def card(self, row: dict[str, Any], *, sender_title: str = "", supply: bool = False) -> dict[str, Any]:
        if not sender_title:
            sender_title = (await conversation_titles(self.db.conn, [row["from_conversation_uuid"]])).get(row["from_conversation_uuid"], "")
        return {"requestId": row["request_uuid"], "turnUuid": row.get("target_root_turn_uuid") or "", "title": row["title"],
                "fromConversationUuid": row["from_conversation_uuid"], "fromTitle": sender_title, "supply": supply}

    async def mark_working(self, request_uuid: str) -> None:
        async with self.db.write_transaction(label="collab-working") as conn:
            await conn.execute("UPDATE collab_requests SET state='working',updated_at_ms=? WHERE request_uuid=? AND state='delivered'", (now_ms(), request_uuid))
        row = await self.request(request_uuid)
        if row:
            await self._publish_change(row["from_conversation_uuid"], row["to_conversation_uuid"])

    async def _after_turn(self, conversation_uuid: str, request_uuid: str, task: asyncio.Task) -> None:
        if self.active.get(conversation_uuid) == request_uuid:
            self.active.pop(conversation_uuid, None)
        try:
            row = await self.request(request_uuid)
            if not row or row["state"] in TERMINAL_STATES:
                if row and row["state"] == "cancelled":
                    final = await self._final_text(row)
                    if final:
                        async with self.db.write_transaction(label="collab-late") as conn:
                            await conn.execute("UPDATE collab_requests SET late_result_json=? WHERE request_uuid=?", (dumps({"text": final}), request_uuid))
                            await add_event(conn, request_uuid, "late", final[:2000])
                return
            if self._closing:
                return
            succeeded = not task.cancelled() and task.exception() is None and bool(task.result())
            declaration = loads(row["declaration_json"], {})
            final = await self._final_text(row)
            if task.cancelled():
                await self._finish(row, "cancelled", note="处理方的本轮被停止", text=final)
            elif not succeeded:
                await self._finish(row, "failed", note="处理方的本轮运行失败", text=final)
            elif declaration.get("outcome") == "needs_input":
                if int(row["input_rounds"]) >= MAX_INPUT_ROUNDS:
                    await self._finish(row, "limit_reached", note=f"补充材料已达 {MAX_INPUT_ROUNDS} 次上限，未得出结论", text=final)
                else:
                    await self._needs_input(row, declaration.get("text") or final)
            elif declaration.get("outcome") == "rejected":
                await self._finish(row, "rejected", note=declaration.get("text") or "", text=final)
            else:
                await self._finish(row, "completed", note=declaration.get("text") or "", text=final)
        except Exception:
            log.exception("跨会话请求收尾失败", request=request_uuid)
        finally:
            self.wake()

    def hold_result(self, request_uuid: str, text: str) -> None:
        """Keep the body written before a declaration reminder; the reply after it is only a closing line."""
        if text.strip():
            self._held_results[request_uuid] = text

    async def _final_text(self, row: dict[str, Any]) -> str:
        held = self._held_results.pop(row["request_uuid"], "")
        target = await self.conversation(row["to_conversation_uuid"])
        if not target or not row["target_root_turn_uuid"]:
            return held
        texts = [str(r["content"]) for r in await many(self.db.conn, """SELECT content FROM messages WHERE chat_id=? AND run_root_turn_uuid=?
            AND COALESCE(task_uuid,'')='' AND role='assistant' AND content IS NOT NULL AND content!='' ORDER BY id DESC LIMIT 2""",
            (int(target["internal_chat_id"]), row["target_root_turn_uuid"])) if isinstance(r["content"], str)]
        latest = texts[0] if texts else ""
        # A reply written before the declaration, then a one-line sign-off: the reply is the answer.
        if len(texts) > 1 and len(latest.strip()) < min(160, len(texts[1].strip()) / 3):
            latest = texts[1]
        if held and latest.strip() != held.strip():
            return held + ("\n\n" + latest if latest else "")
        return latest or held

    async def _needs_input(self, row: dict[str, Any], question: str) -> None:
        async with self.db.write_transaction(label="collab-needs-input") as conn:
            await conn.execute("""UPDATE collab_requests SET state='needs_input',question=?,input_rounds=input_rounds+1,updated_at_ms=?
                WHERE request_uuid=?""", (question, now_ms(), row["request_uuid"]))
            await add_event(conn, row["request_uuid"], "needs_input", question)
        await self._notify_sender(await self.request(row["request_uuid"]))

    async def _finish(self, row: dict[str, Any], state: str, *, note: str = "", text: str = "") -> None:
        changed = 0
        async with self.db.write_transaction(label="collab-finish") as conn:
            cur = await conn.execute(f"""UPDATE collab_requests SET state=?,note=?,result_text=?,
                updated_at_ms=?,finished_at_ms=? WHERE request_uuid=? AND state IN ({','.join('?' for _ in OPEN_STATES)})""",
                (state, note, text, now_ms(), now_ms(), row["request_uuid"], *OPEN_STATES))
            changed = cur.rowcount
            if changed:
                await add_event(conn, row["request_uuid"], "result", note or STATE_LABELS[state])
        if changed:
            await self._notify_sender(await self.request(row["request_uuid"]))

    async def _notify_sender(self, row: dict[str, Any] | None) -> None:
        if not row:
            return
        sender = await self.conversation(row["from_conversation_uuid"])
        if not sender:
            return
        titles = await conversation_titles(self.db.conn, [row["to_conversation_uuid"]])
        receiver_title = titles.get(row["to_conversation_uuid"], "另一个会话")
        label = STATE_LABELS.get(row["state"], row["state"])
        payload = {
            "kind": "task-notification-collab",
            "notificationKey": f"collab:{row['request_uuid']}:{row['state']}:{row['input_rounds']}",
            "taskUuid": "collab:" + row["request_uuid"],
            "collabRequestId": row["request_uuid"],
            "status": "completed",
            "collabState": row["state"],
            "rootTurnUuid": row["from_root_turn_uuid"],
            "summary": f"会话「{receiver_title}」：{row['title']} · {label}",
            "title": row["title"],
            "content": prompts.result_text(row, receiver_title=receiver_title, state_label=label),
        }
        await self.host._schedule_web_task_notification(sender, payload)
        await self._publish_change(row["from_conversation_uuid"], row["to_conversation_uuid"])

    async def _publish_change(self, *conversation_uuids: str) -> None:
        for conv in {c for c in conversation_uuids if c}:
            live = self.host._web_live_streams.get(conv)
            if live is not None:
                with contextlib.suppress(Exception):
                    await live.publish({"type": "collab_requests", "conversationUuid": conv}, persist=False)
        with contextlib.suppress(Exception):
            self.host._invalidate_tree_status()

    # ---- notes for the next model boundary ---------------------------------
    async def add_note(self, conversation_uuid: str, kind: str, body: str, *, group_uuid: str = "") -> None:
        async with self.db.write_transaction(label="collab-note") as conn:
            await conn.execute("INSERT INTO collab_notes(conversation_uuid,group_uuid,kind,body,created_at_ms) VALUES(?,?,?,?,?)",
                               (conversation_uuid, group_uuid, kind, body, now_ms()))
        conv = await self.conversation(conversation_uuid)
        if conv is not None:
            wake = self.host._web_controller_wake_events.get(conversation_uuid)
            if wake is not None:
                wake.set()

    async def take_notes(self, conversation_uuid: str) -> list[dict[str, Any]]:
        async with self.db.write_transaction(label="collab-take-notes") as conn:
            rows = await many(conn, "SELECT * FROM collab_notes WHERE conversation_uuid=? AND delivered_at_ms=0 ORDER BY id", (conversation_uuid,))
            if rows:
                await conn.execute(f"UPDATE collab_notes SET delivered_at_ms=? WHERE id IN ({','.join('?' for _ in rows)})",
                                   (now_ms(), *[r["id"] for r in rows]))
        return rows

    async def silent_conversation(self, conversation_uuid: str, payload: dict[str, Any]) -> bool:
        if not conversation_uuid:
            return False
        if payload.get("source") == "collab" or conversation_uuid in self.active:
            return True
        return await member_row(self.db.conn, conversation_uuid) is not None

    async def has_notes(self, conversation_uuid: str) -> bool:
        return await one(self.db.conn, "SELECT 1 FROM collab_notes WHERE conversation_uuid=? AND delivered_at_ms=0 LIMIT 1", (conversation_uuid,)) is not None
