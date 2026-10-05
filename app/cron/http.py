"""Authenticated Cron management; no public ingress or test execution route."""
import sqlite3

from aiohttp import web
from pydantic import ValidationError

from app.cron.contracts import CronError
from app.webhooks.contracts import WebhookError
from app.webhooks.scripts import environment


def install(app, host):
    from app.web_console.core import _WEB_SESSION_KEY

    def service():
        value = getattr(host, 'cron', None)
        if value is None: raise CronError('cron_unavailable', status=503)
        return value

    def owner(request):
        session = request.get(_WEB_SESSION_KEY)
        if session is None: raise CronError('authentication_required', status=401)
        return int(session.chat_id)

    async def body(request):
        data = await request.json()
        if not isinstance(data, dict): raise CronError('invalid_json')
        return data

    def wrap(fn):
        async def handler(request):
            try:
                result = await fn(request, owner(request))
                return web.json_response(result, headers={'Cache-Control': 'no-store'})
            except (CronError, WebhookError) as exc:
                return web.json_response(exc.payload, status=exc.status)
            except (ValidationError, TypeError, ValueError, OverflowError) as exc:
                return web.json_response({'code': 'invalid_parameters', 'message': str(exc)}, status=422)
            except sqlite3.Error:
                return web.json_response({'code': 'storage_unavailable', 'message': '存储暂不可用'}, status=503)
        return handler

    async def listing(r, o): return await service().list(o, dict(r.query))
    async def calendar(r, o): return await service().calendar(o, dict(r.query))
    async def create(r, o): return await service().save(o, await body(r))
    async def get(r, o): return await service().get(o, r.match_info['job_id'])
    async def update(r, o): return await service().save(o, await body(r), r.match_info['job_id'])
    async def control(r, o): return await service().set_enabled(o, r.match_info['job_id'], await body(r))
    async def run(r, o): return await service().run(o, r.match_info['job_id'], await body(r))
    async def prepare(r, o): return await service().delete_impact(o, r.match_info['job_id'], await body(r))
    async def delete(r, o): return await service().delete(o, r.match_info['job_id'], await body(r))
    async def runs(r, o): return await service().runs(o, dict(r.query))
    async def run_detail(r, o): return await service().get_run(o, r.match_info['run_id'])
    async def stop(r, o): return await service().stop(o, r.match_info['run_id'], await body(r))
    async def folders(r, o): return await service().folders(o)
    async def env(r, o):
        s = service()
        return {'runtimes': await environment(s.script_environment), 'defaultCwd': s.script_environment.default_cwd}
    async def statistics(r, o): return await service().statistics(o, dict(r.query))
    async def preview(r, o): return service().preview(await body(r))

    for method, path, handler in [
        ('GET', '/jobs', listing), ('POST', '/jobs', create), ('GET', '/folders', folders),
        ('GET', '/calendar', calendar),
        ('GET', '/environment', env), ('POST', '/preview-next', preview), ('GET', '/statistics', statistics),
        ('GET', '/runs', runs), ('GET', '/runs/{run_id}', run_detail), ('POST', '/runs/{run_id}/stop', stop),
        ('GET', '/jobs/{job_id}', get), ('PATCH', '/jobs/{job_id}', update), ('DELETE', '/jobs/{job_id}', delete),
        ('POST', '/jobs/{job_id}/control', control), ('POST', '/jobs/{job_id}/run', run),
        ('POST', '/jobs/{job_id}/delete-impact', prepare),
    ]:
        app.router.add_route(method, '/api/cron'+path, wrap(handler))
