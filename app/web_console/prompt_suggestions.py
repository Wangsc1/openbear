"""Web conversation next-message suggestions; prompt and parsing live in app.prompt_suggestions."""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from aiohttp import web

from app.db.dao import MessageDAO
from app.logging import get_logger
from app.prompt_suggestions import (
    DEFAULT_SUGGESTION_PROMPT,
    TRANSCRIPT_MAX_TURNS,
    parse_suggestions,
    render_suggestion_request,
    stored_suggestions,
    suggestion_turns,
)

log = get_logger(__name__)

_EMPTY = "{}"


class WebAdminPromptSuggestionsMixin:
    def _prompt_suggestions_public(self, row: dict[str, Any] | None) -> dict[str, Any]:
        if not row or not self.config.agent.prompt_suggestions_enabled:
            return {"turnUuid": "", "items": []}
        data = stored_suggestions(row.get("prompt_suggestions_json"))
        return {"turnUuid": data.get("turnUuid", ""), "items": data.get("items", [])}

    async def _publish_prompt_suggestions(self, conversation_uuid: str, payload: dict[str, Any]) -> None:
        live = self._web_live_streams.get(conversation_uuid)
        if live is not None:
            await live.publish({"type": "prompt_suggestions", **payload}, persist=False)

    async def _clear_prompt_suggestions(self, conversation_uuid: str) -> None:
        """Drop the stored suggestions and any generation still running for them."""
        task = self._web_prompt_suggestion_tasks.pop(conversation_uuid, None)
        if task is not None and not task.done():
            task.cancel()
        cur = await self.db.conn.execute(
            "UPDATE web_conversations SET prompt_suggestions_json=? WHERE conversation_uuid=? AND prompt_suggestions_json!=?",
            (_EMPTY, conversation_uuid, _EMPTY),
        )
        await self.db.conn.commit()
        if int(cur.rowcount or 0) > 0:
            await self._publish_prompt_suggestions(conversation_uuid, {"turnUuid": "", "items": []})

    def _start_prompt_suggestion_task(self, conversation: dict[str, Any], root_turn_uuid: str) -> None:
        conv_uuid = str(conversation.get("conversation_uuid") or "")
        if not conv_uuid or not root_turn_uuid or not self.config.agent.prompt_suggestions_enabled:
            return
        previous = self._web_prompt_suggestion_tasks.pop(conv_uuid, None)
        if previous is not None and not previous.done():
            previous.cancel()
        task = asyncio.create_task(
            self._generate_prompt_suggestions(dict(conversation), root_turn_uuid),
            name=f"web-prompt-suggestions-{conv_uuid[:8]}",
        )
        self._web_prompt_suggestion_tasks[conv_uuid] = task

        def _done(finished: asyncio.Task) -> None:
            if self._web_prompt_suggestion_tasks.get(conv_uuid) is finished:
                self._web_prompt_suggestion_tasks.pop(conv_uuid, None)
            if not finished.cancelled() and finished.exception() is not None:
                log.warning("生成下一句推荐失败", 会话=conv_uuid, 错误=repr(finished.exception()))

        task.add_done_callback(_done)

    async def _prompt_suggestion_rows(self, chat_id: int) -> list[dict[str, Any]]:
        # Bound the read to the user rows of the most recent turns.
        cur = await self.db.conn.execute(
            """SELECT id, COALESCE(NULLIF(run_root_turn_uuid,''), turn_uuid) AS root FROM messages
               WHERE chat_id=? AND role='user' AND COALESCE(task_uuid,'')='' AND COALESCE(agent_session_uuid,'')=''
               ORDER BY id DESC LIMIT 200""",
            (chat_id,),
        )
        roots: list[str] = []
        start = 0
        for row in await cur.fetchall():
            root = str(row["root"] or f"message:{row['id']}")
            if root not in roots:
                if len(roots) > TRANSCRIPT_MAX_TURNS:
                    break
                roots.append(root)
            start = int(row["id"])
        if not start:
            return []
        cur = await self.db.conn.execute(
            """SELECT id, role, name, content, turn_uuid, run_root_turn_uuid FROM messages
               WHERE chat_id=? AND id>=? AND COALESCE(task_uuid,'')='' AND COALESCE(agent_session_uuid,'')=''
                 AND (role IN ('user','assistant') OR (role='tool' AND name='UserInteraction'))
               ORDER BY id""",
            (chat_id, start),
        )
        return [dict(row) for row in await cur.fetchall()]

    async def _generate_prompt_suggestions(self, row: dict[str, Any], root_turn_uuid: str) -> list[str]:
        from app.references import reference_display_text

        conv_uuid = str(row.get("conversation_uuid") or "")
        chat_id = int(row.get("internal_chat_id") or 0)
        config = self.config
        settings = config.agent
        count = int(settings.suggestion_count or 3)
        turns = suggestion_turns(await self._prompt_suggestion_rows(chat_id), reference_display_text)
        request_text = render_suggestion_request(turns, count) if turns else ""
        if not request_text or self.llm_factory is None:
            return []
        prompt = str(settings.suggestion_prompt or "").strip() or DEFAULT_SUGGESTION_PROMPT
        candidates = self._conversation_title_candidates(
            config, row, prompt=prompt, transcript=request_text,
            configured=list(config.models.suggestion_models or []),
        )
        if settings.suggestion_follow_conversation_model:
            main = (str(row.get("model") or "") or str(getattr(self.model_selection, "current", "") or "")
                    or str(config.models.primary or ""))
            if main and config.models.resolve(main) is not None:
                candidates = list(dict.fromkeys([main, *candidates]))
        timeout_s = float(settings.suggestion_timeout_s or 30.0)
        messages = MessageDAO(self.db)
        session_uuid = await messages.get_or_create_session_uuid(chat_id)
        items: list[str] = []
        for label in candidates:
            resolved = config.models.resolve(label)
            if resolved is None:
                continue
            try:
                backend, model, _maximum = self.llm_factory.backend_for(label)
            except Exception:
                continue
            model_definition = resolved[1]
            output_tokens = min(
                max(1, int(model_definition.max_tokens or 1)),
                2048 if (model_definition.reasoning or model_definition.thinking_levels) else 512,
            )
            started = time.monotonic()
            response = None
            try:
                async with asyncio.timeout(timeout_s):
                    response = await backend.complete(
                        [{"role": "user", "content": request_text}],
                        model=model,
                        system=prompt,
                        max_tokens=output_tokens,
                        read_timeout_s=timeout_s,
                    )
                call: dict[str, Any] = {
                    "status": "ok",
                    "usage": response.usage,
                    "totalTimeMs": int((time.monotonic() - started) * 1000),
                    "outputTokens": int(response.usage.output_tokens or 0),
                    "serviceTier": response.service_tier,
                    "providerCostUsd": response.provider_cost_usd,
                }
            except Exception as exc:
                call = {
                    "status": "error",
                    "totalTimeMs": int((time.monotonic() - started) * 1000),
                    "errorType": type(exc).__name__,
                    "serviceTier": getattr(exc, "service_tier", ""),
                    "providerCostUsd": getattr(exc, "provider_cost_usd", None),
                }
            await self._persist_web_model_call_delta(
                messages,
                chat_id,
                session_uuid=session_uuid,
                call=call,
                model_cost=model_definition.cost,
                model_label=label,
                protocol=str(getattr(backend, "protocol", "")),
                think_level="off",
                call_kind="prompt_suggestion",
            )
            if response is None:
                continue
            # An answered request that yields nothing usable means "no obvious next step".
            items = parse_suggestions(response.text, count)
            break
        if not items:
            return []
        payload = {"turnUuid": root_turn_uuid, "items": items, "createdAtMs": int(time.time() * 1000)}
        # A run that started meanwhile has already marked the row running and
        # cleared it; never resurrect suggestions for an older turn.
        cur = await self.db.conn.execute(
            "UPDATE web_conversations SET prompt_suggestions_json=? WHERE conversation_uuid=? AND COALESCE(status,'')!='running'",
            (json.dumps(payload, ensure_ascii=False), conv_uuid),
        )
        await self.db.conn.commit()
        if int(cur.rowcount or 0) <= 0:
            return []
        await self._publish_prompt_suggestions(conv_uuid, {"turnUuid": root_turn_uuid, "items": items})
        return items

    async def handle_api_conversation_prompt_suggestions_dismiss(self, request: web.Request) -> web.Response:
        row = await self._conversation_from_request(request)
        await self._clear_prompt_suggestions(str(row["conversation_uuid"]))
        return web.json_response({"ok": True})
