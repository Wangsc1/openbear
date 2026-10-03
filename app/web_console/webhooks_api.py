"""Conversation-local context properties and Webhook HTTP wiring exports."""
from __future__ import annotations

import json

from aiohttp import web

from app.web_console.core import _WEB_SESSION_KEY
from app.webhooks.repository import one


class WebhookPropertiesMixin:
    async def _conversation_properties(self,row):
        key='conversation_context:'+row['conversation_uuid']
        stored=await one(self.db.conn,'SELECT value FROM app_state WHERE key=?',(key,))
        config=json.loads(stored['value']) if stored else {'contextMode':'inherit','contextText':''}
        _,inherited=await self._tree_effective_folder_values(row['owner_chat_id'],row['folder_uuid'])
        return {'properties':{**config,'inheritedContext':inherited,'sourceFolderId':row['folder_uuid'],'effectiveContext':config['contextText'] if config['contextMode']=='override' else inherited}}

    async def handle_api_conversation_properties(self,request):
        row=await self._conversation_row(request[_WEB_SESSION_KEY].chat_id,request.match_info['conversation_uuid'],require=True)
        payload=await self._conversation_properties(row)
        # Property dialogs need settings, not the conversation's operation timeline
        # or model/tool-call ledger. Reuse the same lightweight save snapshot.
        payload['runConfig']=await self._conversation_run_config_public(row['owner_chat_id'],row['conversation_uuid'])
        return web.json_response(payload,headers={'Cache-Control':'no-store'})

    async def handle_api_conversation_properties_put(self,request):
        row=await self._conversation_row(request[_WEB_SESSION_KEY].chat_id,request.match_info['conversation_uuid'],require=True)
        body=await self._json_body(request)
        if set(body)-{'contextMode','contextText'} or body.get('contextMode') not in ('inherit','override') or not isinstance(body.get('contextText',''),str) or len(body.get('contextText',''))>100000:
            return web.json_response({'code':'invalid_context_properties','message':'上下文需选择继承或覆盖，文本最长100000字符','retryable':False,'details':{}},status=422)
        value=json.dumps({'contextMode':body['contextMode'],'contextText':body.get('contextText','')},ensure_ascii=False)
        async with self.operation_locks.chat(row['internal_chat_id'],'conversation_properties'):
            await self.db.conn.execute('INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',('conversation_context:'+row['conversation_uuid'],value))
            await self.db.conn.commit()
        return web.json_response(await self._conversation_properties(row),headers={'Cache-Control':'no-store'})
