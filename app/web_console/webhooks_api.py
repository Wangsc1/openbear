"""Conversation-local context properties and Webhook HTTP wiring exports."""
from __future__ import annotations

import json

from aiohttp import web

from app.context.prompt_policy import FLAGS, folder_policy, policy, write_json
from app.web_console.core import _WEB_SESSION_KEY


class WebhookPropertiesMixin:
    async def _conversation_properties(self, row):
        local = await self._local_conversation_prompt_policy(row['conversation_uuid'])
        folders = await self._tree_context_folders(row['owner_chat_id'])
        inherited, inherited_source = folder_policy(row['folder_uuid'], folders)
        own = bool(local['text'].strip())
        effective = local if own else inherited
        source = '' if own else inherited_source
        inherited_path = self._tree_folder_path_text(inherited_source, folders) if inherited_source else '未设置'
        return {'properties': {
            'contextMode': 'override' if own else 'inherit', 'contextText': local['text'],
            **{key: local[key] for key in (*FLAGS, 'toolNames')},
            'inheritedContext': inherited['text'], 'effectiveContext': effective['text'], 'sourceFolderId': source,
            'promptPolicy': {'local': local, 'inherited': inherited, 'effective': effective,
                'sourceFolderId': source, 'sourcePath': '当前会话' if own else inherited_path,
                'inheritedSourcePath': inherited_path},
        }}

    async def handle_api_conversation_properties(self, request):
        row = await self._conversation_row(request[_WEB_SESSION_KEY].chat_id, request.match_info['conversation_uuid'], require=True)
        payload = await self._conversation_properties(row)
        payload['runConfig'] = await self._conversation_run_config_public(row['owner_chat_id'], row['conversation_uuid'])
        return web.json_response(payload, headers={'Cache-Control': 'no-store'})

    async def _conversation_policy_from_body(self, row, body):
        try:
            if not isinstance(body, dict) or set(body) - {'contextMode', 'contextText', 'updateSnapshots', *FLAGS, 'toolNames'}:
                raise ValueError('未知会话属性字段')
            if 'contextMode' in body and body['contextMode'] not in ('inherit', 'override'):
                raise ValueError('未知上下文模式')
            if 'updateSnapshots' in body and type(body['updateSnapshots']) is not bool:
                raise ValueError('更新快照选项必须是布尔值')
            previous = await self._local_conversation_prompt_policy(row['conversation_uuid'])
            text = body.get('contextText', previous['text'])
            if body.get('contextMode') == 'inherit':
                text = ''
            value = policy({**previous, **{k: body[k] for k in (*FLAGS, 'toolNames') if k in body}}, text=text)
            await self._validate_prompt_policy(value, previous=previous, conversation_uuid=row['conversation_uuid'])
            return value
        except ValueError as exc:
            raise web.HTTPUnprocessableEntity(text=json.dumps({'code': 'invalid_context_properties', 'message': str(exc)}, ensure_ascii=False), content_type='application/json') from exc

    async def _conversation_policy_impact(self, row, value):
        conv = row['conversation_uuid']
        effective = await self._resolved_prompt_policy(conv, local=value)
        workspace, _ = await self._tree_effective_folder_values(row['owner_chat_id'], row['folder_uuid'])
        # Include a saved-but-not-applied policy so the same draft can later be
        # explicitly applied; text equality does not imply active-policy equality.
        active = await self._active_prompt_policy(conv)
        changed = effective != active
        running = bool(self._web_starting_turns.get(conv)) or await self._web_conversation_has_active_runtime(row)
        return {'rows': [{**row, 'new_values': (workspace, effective['text']), 'new_policy': effective}] if changed else [],
            'affectedCount': int(changed), 'updatableCount': int(changed and not running),
            'runningCount': int(changed and running), 'archivedCount': int(changed and bool(row['archived_at'])),
            'cacheInvalidated': changed}

    async def handle_api_conversation_properties_impact(self, request):
        row = await self._conversation_row(request[_WEB_SESSION_KEY].chat_id, request.match_info['conversation_uuid'], require=True)
        value = await self._conversation_policy_from_body(row, await self._json_body(request))
        impact = await self._conversation_policy_impact(row, value)
        return web.json_response({'ok': True, **self._tree_public_impact(impact)}, headers={'Cache-Control': 'no-store'})

    async def handle_api_conversation_properties_put(self, request):
        row = await self._conversation_row(request[_WEB_SESSION_KEY].chat_id, request.match_info['conversation_uuid'], require=True)
        body = await self._json_body(request)
        async with self._conversation_tree_lock:
            value = await self._conversation_policy_from_body(row, body)
            impact = await self._conversation_policy_impact(row, value)

            async def mutate(conn):
                await write_json(conn, 'conversation_context:' + row['conversation_uuid'], {
                    'contextMode': 'override' if value['text'].strip() else 'inherit',
                    'contextText': value['text'], **{k: value[k] for k in (*FLAGS, 'toolNames')},
                })

            result = await self._tree_apply_snapshot_updates_locked(impact, update_snapshots=body.get('updateSnapshots') is True, mutate=mutate)
        return web.json_response({**await self._conversation_properties(row), **self._tree_public_impact(impact), **result}, headers={'Cache-Control': 'no-store'})
