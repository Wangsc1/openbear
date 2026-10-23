"""Lead-owned groups: proposal validation, approval diffs, creation and edits.

A group is a folder row whose parent is the lead's own folder, so members
inherit the project's directory context. The tree shows it under the lead
conversation instead; collab_groups owns that relationship.
"""
from __future__ import annotations

import difflib
import re
from pathlib import Path
from typing import Any

from app.collab import prompts
from app.collab.service import CollabError
from app.collab.store import (
    conversation_titles,
    dumps,
    loads,
    many,
    member_row,
    new_id,
    one,
)
from app.db.engine import now_ts

GROUP_TEXT_LIMIT = 20_000
MEMBER_LIMIT = 12
_KEY = re.compile(r"[^a-z0-9_-]+")


def _text(value: Any, limit: int = GROUP_TEXT_LIMIT) -> str:
    return str(value or "").strip()[:limit]


def _member_key(name: str, index: int, used: set[str]) -> str:
    base = _KEY.sub("-", name.lower()).strip("-")[:24] or f"member-{index + 1}"
    key, n = base, 2
    while key in used:
        key, n = f"{base}-{n}", n + 1
    used.add(key)
    return key


class GroupService:
    def __init__(self, db, host, requests) -> None:
        self.db, self.host, self.requests = db, host, requests
        host.collab_groups = self

    # ---- normalization ------------------------------------------------------
    def models(self) -> list[dict[str, Any]]:
        out = []
        for provider_key, provider in self.host.config.models.providers.items():
            if not provider.enabled:
                continue
            for model in provider.models:
                key = f"{provider_key}/{model.id}"
                out.append({"key": key, "label": model.name or key, "thinkingLevels": list(model.thinking_levels or []),
                            "defaultThinkingLevel": model.default_thinking_level, "supportsFast": bool(model.supports_fast)})
        return out

    def _member_config(self, raw: dict[str, Any], *, path: str, errors: list[dict[str, str]]) -> dict[str, Any]:
        model = _text(raw.get("model"), 200)
        if not self.host.config.models.resolve(model):
            errors.append({"path": f"{path}.model", "message": f"模型不存在或未启用：{model or '（空）'}"})
        levels = self.host._model_thinking_levels(model) if model else []
        think = _text(raw.get("thinkingLevel") or raw.get("think"), 40)
        if levels and think and think not in levels:
            errors.append({"path": f"{path}.thinkingLevel", "message": f"{model} 不支持思考强度 {think}（可选：{'、'.join(levels)}）"})
        if levels and not think:
            think = self.host._model_default_thinking_level(model)
        fast = bool(raw.get("fast"))
        if fast and model and not self.host._model_supports_fast(model):
            errors.append({"path": f"{path}.fast", "message": f"{model} 不支持 fast"})
        return {"model": model, "thinkingLevel": think if levels else "", "fast": fast}

    def normalize(self, raw: dict[str, Any], *, require_sections: bool = True, existing_keys: set[str] | None = None) -> tuple[dict[str, Any], list[dict[str, str]]]:
        errors: list[dict[str, str]] = []
        group_prompt = raw.get("prompt") if isinstance(raw.get("prompt"), dict) else {}
        value = {
            "name": _text(raw.get("name"), 60),
            "description": _text(raw.get("description"), 2000),
            "prompt": {key: _text(group_prompt.get(key)) for key, _label in prompts.GROUP_FIELDS},
            "workspaceDir": _text(raw.get("workspaceDir"), 1000),
            "members": [],
        }
        if not value["name"]:
            errors.append({"path": "name", "message": "小组名称必填"})
        if require_sections:
            for key, label in prompts.GROUP_FIELDS:
                if not value["prompt"][key]:
                    errors.append({"path": f"prompt.{key}", "message": f"小组提示词缺少「{label}」：成员没有全局视角，必须写清楚"})
        if value["workspaceDir"] and not value["workspaceDir"].startswith("/"):
            errors.append({"path": "workspaceDir", "message": "工作目录必须是绝对路径"})
        members = raw.get("members") if isinstance(raw.get("members"), list) else []
        if require_sections and not members:
            errors.append({"path": "members", "message": "至少需要一个成员"})
        if len(members) > MEMBER_LIMIT:
            errors.append({"path": "members", "message": f"成员不能超过 {MEMBER_LIMIT} 个"})
        used = set(existing_keys or ())
        for index, item in enumerate(members[:MEMBER_LIMIT]):
            item = item if isinstance(item, dict) else {}
            path = f"members[{index}]"
            name = _text(item.get("name"), 40)
            if not name:
                errors.append({"path": f"{path}.name", "message": "成员名称必填"})
            member_prompt = _text(item.get("prompt")) if isinstance(item.get("prompt"), str) else ""
            if require_sections and not member_prompt:
                errors.append({"path": f"{path}.prompt", "message": f"成员「{name or index + 1}」缺少提示词"})
            key = _text(item.get("memberKey"), 40) or _member_key(name, index, used)
            used.add(key)
            value["members"].append({"memberKey": key, "name": name, "prompt": member_prompt,
                                     **self._member_config(item, path=path, errors=errors)})
        names = [m["name"] for m in value["members"]]
        if len(names) != len(set(names)):
            errors.append({"path": "members", "message": "成员名称不能重复"})
        return value, errors

    @staticmethod
    def member_rules_text() -> str:
        return prompts.member_rules()

    def validate_answer(self, item: dict[str, Any], result: dict[str, Any]) -> list[dict[str, str]]:
        """Panel submissions may edit fields, never membership."""
        if not result.get("approved"):
            return []
        proposal = item.get("proposal") or {}
        submitted = result.get("proposal") or {}
        locked = [m.get("memberKey") for m in proposal.get("members") or []]
        keys = [m.get("memberKey") for m in submitted.get("members") or [] if isinstance(m, dict)]
        if keys != locked:
            return [{"path": "proposal.members", "message": "不能在面板里增加、删除或重排成员；不想要某个成员请否决并说明"}]
        if item.get("mode") == "remove_member":
            return []
        if item.get("mode") == "add_members":
            group_prompt = {key: "-" for key, _label in prompts.GROUP_FIELDS}
            _value, errors = self.normalize({"name": "-", "prompt": group_prompt, "members": submitted.get("members") or []})
        else:
            _value, errors = self.normalize(submitted)
        return errors

    # ---- approval diffs -----------------------------------------------------
    @staticmethod
    def _field_changes(prefix: str, before: dict, after: dict, labels: dict[str, str]) -> list[str]:
        out = []
        for key, label in labels.items():
            old, new = before.get(key), after.get(key)
            if old == new:
                continue
            if isinstance(old, str) and isinstance(new, str) and ("\n" in old or "\n" in new or len(old) + len(new) > 120):
                delta = "\n".join(line for line in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=0)
                                  if not line.startswith(("---", "+++", "@@")))
                out.append(f"{prefix}{label}：\n{delta}")
            else:
                out.append(f"{prefix}{label}：{old!r} → {new!r}")
        return out

    def diff(self, proposed: dict[str, Any], submitted: dict[str, Any]) -> list[str]:
        changes: list[str] = []
        changes += self._field_changes("小组", proposed, submitted, {"name": "名称", "description": "说明", "workspaceDir": "工作目录"})
        changes += self._field_changes("小组提示词·", proposed["prompt"], submitted["prompt"], dict(prompts.GROUP_FIELDS))
        before = {m["memberKey"]: m for m in proposed["members"]}
        for member in submitted["members"]:
            old = before.get(member["memberKey"])
            if old is None:
                continue
            label = f"成员「{old['name']}」"
            changes += self._field_changes(label, old, member, {"name": "名称", "model": "模型", "thinkingLevel": "思考强度",
                                                                "fast": "fast", "prompt": "提示词"})
        return changes

    @staticmethod
    def same_membership(proposed: dict[str, Any], submitted: dict[str, Any]) -> bool:
        return [m["memberKey"] for m in proposed["members"]] == [m["memberKey"] for m in submitted["members"]]

    # ---- records ----------------------------------------------------------
    async def group(self, group_uuid: str) -> dict[str, Any] | None:
        row = await one(self.db.conn, "SELECT * FROM collab_groups WHERE group_uuid=?", (group_uuid,))
        if row:
            row["prompt"] = loads(row["prompt_json"], {})
        return row

    async def members(self, group_uuid: str, *, include_removed: bool = False) -> list[dict[str, Any]]:
        rows = await many(self.db.conn, f"""SELECT m.*,w.model,w.title,w.archived_at,w.internal_chat_id FROM collab_members m
            JOIN web_conversations w USING(conversation_uuid) WHERE m.group_uuid=? {'' if include_removed else "AND m.status='active'"}
            ORDER BY m.sort,m.created_at""", (group_uuid,))
        for row in rows:
            prompt = loads(row["prompt_json"], "")
            row["prompt"] = prompt if isinstance(prompt, str) else ""
        return rows

    async def groups_for_lead(self, lead_uuid: str) -> list[dict[str, Any]]:
        return await many(self.db.conn, "SELECT * FROM collab_groups WHERE lead_conversation_uuid=? ORDER BY created_at", (lead_uuid,))

    async def member_prompt(self, conversation_uuid: str) -> tuple[str, str]:
        member = await member_row(self.db.conn, conversation_uuid)
        if not member:
            return "", ""
        group = await self.group(member["group_uuid"])
        members = await self.members(member["group_uuid"])
        current = next((m for m in members if m["conversation_uuid"] == conversation_uuid), None)
        if group is None or current is None:
            return "", ""
        title = (await conversation_titles(self.db.conn, [group["lead_conversation_uuid"]])).get(group["lead_conversation_uuid"], "主会话")
        return prompts.member_block(group, current, members, title), group["workspace_dir"]

    async def _session_config(self, conversation_uuid: str) -> dict[str, Any]:
        row = await one(self.db.conn, """SELECT w.model,s.thinking_level,s.fast_mode FROM web_conversations w
            LEFT JOIN sessions s ON s.chat_id=w.internal_chat_id WHERE w.conversation_uuid=?""", (conversation_uuid,))
        return {"model": row["model"], "thinkingLevel": row["thinking_level"] or "", "fast": bool(row["fast_mode"])} if row else {}

    async def public(self, group_uuid: str) -> dict[str, Any] | None:
        group = await self.group(group_uuid)
        if group is None:
            return None
        members = []
        for row in await self.members(group_uuid, include_removed=True):
            config = await self._session_config(row["conversation_uuid"])
            members.append({"conversationUuid": row["conversation_uuid"], "memberKey": row["member_key"], "name": row["name"],
                            "title": row["title"], "status": row["status"], "prompt": row["prompt"], **config})
        lead_title = (await conversation_titles(self.db.conn, [group["lead_conversation_uuid"]])).get(group["lead_conversation_uuid"], "")
        return {"groupId": group_uuid, "name": group["name"], "description": group["description"], "prompt": group["prompt"],
                "workspaceDir": group["workspace_dir"], "leadConversationUuid": group["lead_conversation_uuid"], "leadTitle": lead_title,
                "revision": group["revision"], "members": members, "memberRules": prompts.member_rules()}

    # ---- creation ---------------------------------------------------------
    def default_workspace(self, name: str) -> str:
        base = Path(str(getattr(self.host, "workspace_dir", "") or Path.cwd() / "workspace")) / "groups"
        slug = _KEY.sub("-", name.lower()).strip("-")[:32] or "group"
        return str(base / f"{slug}-{new_id()[:8]}")

    async def create(self, lead: dict[str, Any], value: dict[str, Any]) -> dict[str, Any]:
        owner = int(lead["owner_chat_id"])
        if await member_row(self.db.conn, lead["conversation_uuid"]):
            raise CollabError("nested_group_forbidden", "小组成员不能再创建小组")
        group_uuid = new_id()
        workspace = value["workspaceDir"] or self.default_workspace(value["name"])
        Path(workspace).mkdir(parents=True, exist_ok=True)
        ts = now_ts()
        async with self.db.write_transaction(label="collab-group-create") as conn:
            await conn.execute("""INSERT INTO collab_groups(group_uuid,owner_chat_id,lead_conversation_uuid,name,description,
                prompt_json,workspace_dir,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)""",
                (group_uuid, owner, lead["conversation_uuid"], value["name"], value["description"], dumps(value["prompt"]), workspace, ts, ts))
        for index, member in enumerate(value["members"]):
            await self._create_member(lead, group_uuid, member, sort=index)
        self.host._invalidate_tree_status(owner)
        await self._publish_tree(lead)
        return await self.public(group_uuid)

    async def _create_member(self, lead: dict[str, Any], group_uuid: str, member: dict[str, Any], *, sort: int) -> str:
        group = await self.group(group_uuid)
        conversation = await self.host._create_web_conversation(
            int(lead["owner_chat_id"]), title=f"{member['name']} · {group['name']}",
            folder_uuid=str(lead.get("folder_uuid") or ""),
            run_config={"main_model": member["model"], "main_thinking_level": member["thinkingLevel"],
                        "main_fast_mode": 1 if member["fast"] else 0},
            origin_kind="collab", origin_ref=group_uuid)
        ts = now_ts()
        async with self.db.write_transaction(label="collab-member-create") as conn:
            await conn.execute("""INSERT INTO collab_members(conversation_uuid,group_uuid,member_key,name,prompt_json,sort,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?)""", (conversation["conversation_uuid"], group_uuid, member["memberKey"], member["name"],
                                           dumps(member["prompt"]), sort, ts, ts))
        return conversation["conversation_uuid"]

    async def add_members(self, lead: dict[str, Any], group_uuid: str, members: list[dict[str, Any]]) -> dict[str, Any]:
        existing = await self.members(group_uuid, include_removed=True)
        for index, member in enumerate(members):
            await self._create_member(lead, group_uuid, member, sort=len(existing) + index)
        await self._refresh_all(group_uuid, reason="小组新增了成员")
        await self._publish_tree(lead)
        return await self.public(group_uuid)

    async def remove_member(self, lead: dict[str, Any], conversation_uuid: str, *, reason: str) -> dict[str, Any]:
        member = await member_row(self.db.conn, conversation_uuid)
        if not member or member["lead_conversation_uuid"] != lead["conversation_uuid"]:
            raise CollabError("member_not_found", "成员不存在或不属于你的小组")
        conversation = await self.requests.conversation(conversation_uuid)
        with_open = await many(self.db.conn, "SELECT request_uuid FROM collab_requests WHERE to_conversation_uuid=? AND state IN ('queued','delivered','working','needs_input')", (conversation_uuid,))
        for row in with_open:
            await self.requests.cancel(row["request_uuid"], reason="成员已被移除", by="system")
        if conversation:
            await self.host._stop_web_conversation(conversation, requested_by="collab", message="成员已移除")
        async with self.db.write_transaction(label="collab-member-remove") as conn:
            await conn.execute("UPDATE collab_members SET status='removed',updated_at=? WHERE conversation_uuid=?", (now_ts(), conversation_uuid))
            await conn.execute("UPDATE web_conversations SET archived_at=? WHERE conversation_uuid=?", (now_ts(), conversation_uuid))
        await self._refresh_all(member["group_uuid"], reason=f"成员「{member['name']}」已被移除（{reason}）")
        await self._publish_tree(lead)
        return await self.public(member["group_uuid"])

    async def restore_member(self, owner: int, conversation_uuid: str) -> dict[str, Any]:
        row = await one(self.db.conn, """SELECT m.*,g.owner_chat_id,g.lead_conversation_uuid FROM collab_members m JOIN collab_groups g USING(group_uuid)
            WHERE m.conversation_uuid=? AND m.status='removed'""", (conversation_uuid,))
        if not row or int(row["owner_chat_id"]) != int(owner):
            raise CollabError("member_not_found", "成员不存在")
        async with self.db.write_transaction(label="collab-member-restore") as conn:
            await conn.execute("UPDATE collab_members SET status='active',updated_at=? WHERE conversation_uuid=?", (now_ts(), conversation_uuid))
            await conn.execute("UPDATE web_conversations SET archived_at=0 WHERE conversation_uuid=?", (conversation_uuid,))
        await self._refresh_all(row["group_uuid"], reason=f"成员「{row['name']}」已恢复")
        await self.requests.add_note(row["lead_conversation_uuid"], "member_restored", f"老大恢复了成员「{row['name']}」。", group_uuid=row["group_uuid"])
        lead = await self.requests.conversation(row["lead_conversation_uuid"])
        if lead:
            await self._publish_tree(lead)
        return await self.public(row["group_uuid"])

    # ---- edits ------------------------------------------------------------
    async def update(self, group_uuid: str, value: dict[str, Any], *, actor: str, reason: str = "") -> tuple[dict[str, Any], list[str]]:
        """Apply group/member field edits. Membership changes are not edits."""
        group = await self.group(group_uuid)
        members = await self.members(group_uuid)
        current = await self.current_value(group_uuid)
        by_key = {m["member_key"]: m for m in members}
        submitted_keys = [m["memberKey"] for m in value["members"]]
        if submitted_keys and sorted(submitted_keys) != sorted(by_key):
            raise CollabError("membership_change_not_allowed", "这里只能修改字段，不能增减成员")
        changes = self.diff(current, {**value, "members": value["members"] or current["members"]})
        if not changes:
            return await self.public(group_uuid), []
        group_changed = any(not line.startswith("成员") for line in changes)
        ts = now_ts()
        async with self.db.write_transaction(label="collab-group-update") as conn:
            await conn.execute("""UPDATE collab_groups SET name=?,description=?,prompt_json=?,workspace_dir=?,revision=revision+1,updated_at=?
                WHERE group_uuid=?""", (value["name"], value["description"], dumps(value["prompt"]),
                                       value["workspaceDir"] or group["workspace_dir"], ts, group_uuid))
            for member in value["members"]:
                row = by_key[member["memberKey"]]
                await conn.execute("UPDATE collab_members SET name=?,prompt_json=?,revision=revision+1,updated_at=? WHERE conversation_uuid=?",
                                   (member["name"], dumps(member["prompt"]), ts, row["conversation_uuid"]))
        if value["workspaceDir"]:
            Path(value["workspaceDir"]).mkdir(parents=True, exist_ok=True)
        for member in value["members"]:
            row = by_key[member["memberKey"]]
            await self._apply_run_config(row, member)
        changed_members = {m["memberKey"] for m in value["members"]
                           if any(line.startswith(f"成员「{by_key[m['memberKey']]['name']}」") for line in changes)}
        for row in members:
            if group_changed or row["member_key"] in changed_members:
                await self._schedule_refresh(row["conversation_uuid"], f"你的设定被{actor}修改过：\n" + "\n".join(changes))
        lead = await self.requests.conversation(group["lead_conversation_uuid"])
        if actor == "老大":
            await self.requests.add_note(group["lead_conversation_uuid"], "group_edited",
                                         f"老大修改了小组「{group['name']}」：\n" + "\n".join(changes), group_uuid=group_uuid)
        if lead:
            await self._publish_tree(lead)
        return await self.public(group_uuid), changes

    async def current_value(self, group_uuid: str) -> dict[str, Any]:
        group = await self.group(group_uuid)
        members = []
        for row in await self.members(group_uuid):
            config = await self._session_config(row["conversation_uuid"])
            members.append({"memberKey": row["member_key"], "name": row["name"], "prompt": row["prompt"], **config})
        return {"name": group["name"], "description": group["description"], "prompt": group["prompt"],
                "workspaceDir": group["workspace_dir"], "members": members}

    async def _apply_run_config(self, row: dict[str, Any], member: dict[str, Any]) -> None:
        current = await self._session_config(row["conversation_uuid"])
        if current == {"model": member["model"], "thinkingLevel": member["thinkingLevel"], "fast": member["fast"]}:
            return
        async with self.db.write_transaction(label="collab-member-model") as conn:
            if current.get("model") != member["model"]:
                await conn.execute("UPDATE web_conversations SET model=?,updated_at=? WHERE conversation_uuid=?",
                                   (member["model"], now_ts(), row["conversation_uuid"]))
                await conn.execute("DELETE FROM controller_model_contexts WHERE chat_id=?", (int(row["internal_chat_id"]),))
            await conn.execute("UPDATE sessions SET thinking_level=?,fast_mode=?,updated_at=? WHERE chat_id=?",
                               (member["thinkingLevel"], 1 if member["fast"] else 0, now_ts(), int(row["internal_chat_id"])))

    async def _refresh_all(self, group_uuid: str, *, reason: str) -> None:
        for row in await self.members(group_uuid):
            await self._schedule_refresh(row["conversation_uuid"], reason)

    async def _schedule_refresh(self, conversation_uuid: str, reason: str) -> None:
        # The system prompt is frozen per session; clearing it makes the next
        # turn render the current group/member definition. The note explains why.
        async with self.db.write_transaction(label="collab-member-refresh") as conn:
            row = await one(conn, "SELECT internal_chat_id FROM web_conversations WHERE conversation_uuid=?", (conversation_uuid,))
            if row:
                await conn.execute("UPDATE sessions SET system_snapshot='' WHERE chat_id=?", (int(row["internal_chat_id"]),))
                await conn.execute("DELETE FROM controller_model_contexts WHERE chat_id=?", (int(row["internal_chat_id"]),))
        await self.requests.add_note(conversation_uuid, "member_refreshed", reason)

    async def _publish_tree(self, lead: dict[str, Any]) -> None:
        live = self.host._web_live_streams.get(lead["conversation_uuid"])
        if live is not None:
            await live.publish({"type": "collab_groups", "conversationUuid": lead["conversation_uuid"]}, persist=False)
        self.host._invalidate_tree_status(int(lead["owner_chat_id"]))

    # ---- tree helpers -------------------------------------------------------
    async def tree_for_owner(self, owner: int) -> dict[str, list[dict[str, Any]]]:
        """Lead conversation -> its groups with member rows (organization only)."""
        groups = await many(self.db.conn, "SELECT * FROM collab_groups WHERE owner_chat_id=? ORDER BY created_at", (owner,))
        out: dict[str, list[dict[str, Any]]] = {}
        for group in groups:
            members = await many(self.db.conn, """SELECT m.conversation_uuid,m.name,m.member_key,m.status,w.title FROM collab_members m
                JOIN web_conversations w USING(conversation_uuid) WHERE m.group_uuid=? ORDER BY m.sort,m.created_at""", (group["group_uuid"],))
            out.setdefault(group["lead_conversation_uuid"], []).append({
                "groupId": group["group_uuid"], "name": group["name"], "description": group["description"],
                "leadConversationUuid": group["lead_conversation_uuid"],
                "members": [{"conversationUuid": m["conversation_uuid"], "name": m["name"], "memberKey": m["member_key"],
                             "title": m["title"], "removed": m["status"] != "active"} for m in members],
            })
        return out


    async def follow_lead(self, lead_uuid: str, *, folder_uuid: str | None = None, archived_at: int | None = None) -> None:
        """Keep member conversations with their lead (folder context, archive state)."""
        groups = await self.groups_for_lead(lead_uuid)
        if not groups:
            return
        ids = [g["group_uuid"] for g in groups]
        marks = ",".join("?" for _ in ids)
        async with self.db.write_transaction(label="collab-follow-lead") as conn:
            if folder_uuid is not None:
                await conn.execute(f"""UPDATE web_conversations SET folder_uuid=? WHERE conversation_uuid IN
                    (SELECT conversation_uuid FROM collab_members WHERE group_uuid IN ({marks}))""", (folder_uuid, *ids))
            if archived_at is not None:
                await conn.execute(f"""UPDATE web_conversations SET archived_at=? WHERE conversation_uuid IN
                    (SELECT conversation_uuid FROM collab_members WHERE group_uuid IN ({marks}) AND status='active')""",
                    (archived_at, *ids))

    async def member_uuids_for_lead(self, lead_uuid: str) -> list[str]:
        rows = await many(self.db.conn, """SELECT m.conversation_uuid FROM collab_members m JOIN collab_groups g USING(group_uuid)
            WHERE g.lead_conversation_uuid=?""", (lead_uuid,))
        return [r["conversation_uuid"] for r in rows]

    async def forget_lead(self, lead_uuid: str) -> None:
        async with self.db.write_transaction(label="collab-forget-lead") as conn:
            await conn.execute("DELETE FROM collab_members WHERE group_uuid IN (SELECT group_uuid FROM collab_groups WHERE lead_conversation_uuid=?)", (lead_uuid,))
            await conn.execute("DELETE FROM collab_groups WHERE lead_conversation_uuid=?", (lead_uuid,))
            await conn.execute("DELETE FROM collab_notes WHERE conversation_uuid=?", (lead_uuid,))

    async def forget_member(self, conversation_uuid: str) -> None:
        async with self.db.write_transaction(label="collab-forget-member") as conn:
            await conn.execute("DELETE FROM collab_members WHERE conversation_uuid=?", (conversation_uuid,))
            await conn.execute("DELETE FROM collab_notes WHERE conversation_uuid=?", (conversation_uuid,))
