"""aiohttp management and exact public ingress routes."""
from __future__ import annotations

import contextlib
import json
import sqlite3

from aiohttp import web
from pydantic import ValidationError

from app.webhooks import queries
from app.webhooks.contracts import EndpointConfig, WebhookError
from app.webhooks.repository import one
from app.webhooks.scripts import environment

PUBLIC_ROUTES=frozenset({'webhook_ingress','webhook_producer_receipt','webhook_script_telemetry'})


def install(app,host):
    from app.web_console.core import _WEB_SESSION_KEY
    def service():
        s=getattr(host,'webhooks',None)
        if s is None: raise WebhookError('webhook_service_unavailable',status=503,retryable=True)
        return s
    def owner(r):
        session=r.get(_WEB_SESSION_KEY)
        if session is None: raise WebhookError('authentication_required',status=401)
        return int(session.chat_id)
    async def body(r):
        try:
            value=await r.json()
            if not isinstance(value,dict): raise ValueError()
            return value
        except (ValueError,UnicodeError): raise WebhookError('invalid_json') from None
    def eid(r): return r.match_info.get('endpoint_id')
    def wrap(fn):
        async def handler(r):
            outcome='rejected'
            try:
                result=await fn(r)
                outcome='duplicate' if isinstance(result,dict) and result.get('duplicate') else 'accepted'
                if isinstance(result,web.StreamResponse): return result
                status=201 if r.method=='POST' and r.path=='/api/webhooks' else 202 if r.match_info.route.name=='webhook_ingress' else 200
                return web.json_response(result,status=status,headers={'Cache-Control':'no-store'})
            except WebhookError as exc:
                headers={'Cache-Control':'no-store'}
                if exc.status==429: headers['Retry-After']=str(exc.payload['details'].get('retryAfter',1))
                return web.json_response(exc.payload,status=exc.status,headers=headers)
            except (ValidationError,TypeError,ValueError) as exc: return web.json_response(WebhookError('invalid_parameters',str(exc)).payload,status=422,headers={'Cache-Control':'no-store'})
            except (sqlite3.Error,TimeoutError): return web.json_response(WebhookError('storage_unavailable',status=503,retryable=True).payload,status=503,headers={'Cache-Control':'no-store'})
            finally:
                if r.match_info.route.name=='webhook_ingress':
                    from app.webhooks.observability import count
                    with contextlib.suppress(Exception):
                        await count(service(),'webhook_http_requests',endpoint_id=eid(r),labels={'outcome':outcome})
        return handler
    def bearer(r):
        auth=r.headers.get('Authorization',''); return auth[7:] if auth.startswith('Bearer ') else ''
    async def ingress(r):
        s=service(); key=bearer(r); await s.authenticate(s.db.conn,eid(r),key); maximum=s.config.ingress.max_body_bytes
        if r.content_length is not None and r.content_length>maximum: raise WebhookError('body_too_large',status=413)
        chunks=bytearray()
        async for chunk in r.content.iter_chunked(65536):
            if len(chunks)+len(chunk)>maximum: raise WebhookError('body_too_large',status=413)
            chunks.extend(chunk)
        return await s.receive(eid(r),key,r.content_type,bytes(chunks),list(r.query.items()),r.headers.get('Idempotency-Key'))
    async def producer_receipt(r):
        s=service(); await s.authenticate(s.db.conn,eid(r),bearer(r))
        e=await one(s.db.conn,'SELECT acceptance_json FROM webhook_events WHERE endpoint_id=? AND event_id=?',(eid(r),r.match_info['event_id']))
        if not e: raise WebhookError('not_found',status=404)
        return json.loads(e['acceptance_json'])
    async def script_telemetry(r):
        from app.webhooks.capabilities import authenticate
        from app.webhooks.telemetry import observe
        s=service(); a=await authenticate(s,r.match_info['attempt_id'],bearer(r))
        return await observe(s,a['endpoint_id'],await body(r),source='script',event_id=a['event_id'],assignment_id=a['assignment_id'],attempt_id=a['attempt_id'])
    async def telemetry(r):
        from app.webhooks.telemetry import observe
        s=service(); data=await body(r); await s.endpoint_row(s.db.conn,data.get('endpointId'),owner(r),deleted=True)
        saved=await one(s.db.conn,'SELECT * FROM webhook_telemetry_operations WHERE endpoint_id=? AND operation_id=?',(data['endpointId'],data.get('operationId')))
        if not saved or not saved['payload_json']: raise WebhookError('observation_not_retryable',status=409)
        return await observe(s,data['endpointId'],json.loads(saved['payload_json']),source=saved['source'],event_id=saved['event_id'],assignment_id=saved['assignment_id'],attempt_id=saved['stage_attempt_id'],action_id=saved['runtime_action_id'],revalidate=True)
    async def listing(r): return await service().list(owner(r),dict(r.query))
    async def create(r): return await service().create(owner(r),await body(r))
    async def get(r): return await service().get(owner(r),eid(r))
    async def credential(r): return await service().web_credential(owner(r),eid(r))
    async def update(r): return await service().update(owner(r),eid(r),await body(r))
    async def control_handler(r): return await service().control(owner(r),eid(r),await body(r))
    async def delete_impact(r): return await service().prepare(owner(r),eid(r),'delete',await body(r))
    async def delete(r): return await service().control(owner(r),eid(r),await body(r),action='delete')
    async def rotate(r):
        data=await body(r); s=service()
        return await s.prepare(owner(r),eid(r),'rotate_key',data) if data.get('prepare') else await s.control(owner(r),eid(r),data,action='rotate_key')
    async def env(r):
        owner(r); s=service()
        return {'runtimes':await environment(s.config.scripts),'defaultCwd':s.config.scripts.default_cwd,'publicBaseUrl':s.config.public_base_url or host.config.web.custom_url,'publicReachability':'unverified','defaults':EndpointConfig().wire(),'limits':s.config.wire()}
    async def targets(r): return await queries.targets(service(),owner(r),dict(r.query))
    async def events(r): return await queries.events(service(),owner(r),{**dict(r.query),**({'endpointId':eid(r)} if eid(r) else {})})
    async def event(r): return await queries.detail(service(),owner(r),r.match_info['event_id'])
    async def statistics(r): return await queries.statistics(service(),owner(r),dict(r.query))
    async def wait_list(r): return await queries.wait_list(service(),owner(r),dict(r.query))
    async def retry(r):
        from app.webhooks.recovery import retry
        return await retry(service(),owner(r),r.match_info['event_id'],await body(r))
    async def verify(r):
        from app.webhooks.recovery import verify
        return await verify(service(),owner(r),r.match_info['event_id'],await body(r))
    async def wait_control(r):
        from app.webhooks.recovery import wait_control
        return await wait_control(service(),owner(r),r.match_info['wait_id'],await body(r))
    async def rebind(r):
        from app.webhooks.recovery import rebind
        return await rebind(service(),owner(r),eid(r),await body(r))
    async def recover(r):
        from app.webhooks.recovery import recover_assignment
        return await recover_assignment(service(),owner(r),r.match_info['assignment_id'],await body(r))
    async def notify_retry(r):
        from app.webhooks.notifications import retry
        return await retry(service(),owner(r),r.match_info['assignment_id'],await body(r))
    routes=[web.post('/webhook/{endpoint_id}',wrap(ingress),name='webhook_ingress'),web.get('/webhook/{endpoint_id}/events/{event_id}',wrap(producer_receipt),name='webhook_producer_receipt'),web.post('/webhook/attempts/{attempt_id}/telemetry',wrap(script_telemetry),name='webhook_script_telemetry')]
    for method,path,fn in [('GET','',listing),('POST','',create),('GET','/environment',env),('GET','/targets',targets),('GET','/events',events),('GET','/events/{event_id}',event),('POST','/events/{event_id}/retry',retry),('POST','/events/{event_id}/verify',verify),('GET','/waits',wait_list),('POST','/waits/{wait_id}/control',wait_control),('GET','/statistics',statistics),('POST','/telemetry',telemetry),('POST','/assignments/{assignment_id}/recover',recover),('POST','/assignments/{assignment_id}/notification/retry',notify_retry),('GET','/{endpoint_id}',get),('PATCH','/{endpoint_id}',update),('DELETE','/{endpoint_id}',delete),('POST','/{endpoint_id}/control',control_handler),('POST','/{endpoint_id}/delete-impact',delete_impact),('GET','/{endpoint_id}/credentials/current',credential),('POST','/{endpoint_id}/credentials/rotate',rotate),('POST','/{endpoint_id}/rebind',rebind),('GET','/{endpoint_id}/events',events)]:
        routes.append(web.route(method,'/api/webhooks'+path,wrap(fn)))
    app.add_routes(routes)
