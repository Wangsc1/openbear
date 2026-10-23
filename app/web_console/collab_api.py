"""Web API for conversation requests and lead-owned groups."""
from __future__ import annotations

from aiohttp import web

from app.collab.service import CollabError
from app.web_console.core import _WEB_SESSION_KEY, WebSession


class WebAdminCollabMixin:
    async def _collab_owned_group(self, request: web.Request) -> dict:
        session: WebSession = request[_WEB_SESSION_KEY]
        group = await self.collab_groups.group(str(request.match_info.get("group_uuid") or ""))
        if group is None or int(group["owner_chat_id"]) != int(session.chat_id):
            raise web.HTTPNotFound(text="group_not_found")
        return group

    async def handle_api_collab_group(self, request: web.Request) -> web.Response:
        group = await self._collab_owned_group(request)
        return web.json_response({"ok": True, "group": await self.collab_groups.public(group["group_uuid"]),
                                  "models": self.collab_groups.models()})

    async def handle_api_collab_group_update(self, request: web.Request) -> web.Response:
        session: WebSession = request[_WEB_SESSION_KEY]
        group = await self._collab_owned_group(request)
        body = await self._json_body(request)
        if int(body.get("revision") or 0) != int(group["revision"]):
            return web.json_response({"ok": False, "error": "revision_conflict", "message": "小组设定已被修改，请刷新后再保存"}, status=409)
        value, errors = self.collab_groups.normalize(body.get("group") if isinstance(body.get("group"), dict) else {})
        if errors:
            return web.json_response({"ok": False, "error": "invalid_group", "details": errors, "message": errors[0]["message"]}, status=422)
        try:
            result, changes = await self.collab_groups.update(group["group_uuid"], value, actor="老大")
        except CollabError as exc:
            return web.json_response(exc.payload(), status=400)
        await self.audit("collab.group.update", actor="web", chat_id=session.chat_id, ip=request.remote or "",
                         detail={"groupId": group["group_uuid"], "changes": len(changes)})
        return web.json_response({"ok": True, "group": result, "changes": changes})

    async def handle_api_collab_member_restore(self, request: web.Request) -> web.Response:
        session: WebSession = request[_WEB_SESSION_KEY]
        try:
            result = await self.collab_groups.restore_member(int(session.chat_id), str(request.match_info.get("conversation_uuid") or ""))
        except CollabError as exc:
            return web.json_response(exc.payload(), status=404)
        return web.json_response({"ok": True, "group": result})

    async def handle_api_conversation_collab(self, request: web.Request) -> web.Response:
        row = await self._conversation_from_request(request)
        conv = str(row["conversation_uuid"])
        requests = await self.collab.list_public(conv)
        groups = [await self.collab_groups.public(g["group_uuid"]) for g in await self.collab_groups.groups_for_lead(conv)]
        member = None
        from app.collab.store import member_row
        found = await member_row(self.db.conn, conv)
        if found:
            member = {"groupId": found["group_uuid"], "groupName": found["group_name"], "name": found["name"],
                      "leadConversationUuid": found["lead_conversation_uuid"]}
        return web.json_response({"ok": True, **requests, "groups": groups, "member": member})

    async def handle_api_collab_request(self, request: web.Request) -> web.Response:
        session: WebSession = request[_WEB_SESSION_KEY]
        detail = await self.collab.detail_public(int(session.chat_id), str(request.match_info.get("request_uuid") or ""))
        if detail is None:
            return web.json_response({"ok": False, "error": "request_not_found"}, status=404)
        return web.json_response({"ok": True, "request": detail})

    async def handle_api_collab_request_cancel(self, request: web.Request) -> web.Response:
        session: WebSession = request[_WEB_SESSION_KEY]
        detail = await self.collab.detail_public(int(session.chat_id), str(request.match_info.get("request_uuid") or ""))
        if detail is None:
            return web.json_response({"ok": False, "error": "request_not_found"}, status=404)
        done = await self.collab.cancel(detail["requestId"], reason="老大取消了这个请求", by="human")
        await self.audit("collab.request.cancel", actor="web", chat_id=session.chat_id, ip=request.remote or "",
                         detail={"requestId": detail["requestId"], "cancelled": done})
        return web.json_response({"ok": done})
