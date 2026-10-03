"""Attempt-scoped telemetry capability, never an ingress/admin credential."""
from __future__ import annotations

import hashlib
import hmac

from app.webhooks.contracts import WebhookError
from app.webhooks.repository import one


def issue(s,attempt,expires):
    text=f'{attempt}:{expires}'
    return str(expires)+'.'+hmac.new(s.pepper,('telemetry:'+text).encode(),hashlib.sha256).hexdigest()


async def authenticate(s,attempt,token):
    try:
        expiry=int(token.split('.')[0])
        if expiry<=s.clock() or not hmac.compare_digest(token,issue(s,attempt,expiry)): raise ValueError()
    except (ValueError,AttributeError): raise WebhookError('invalid_capability',status=403) from None
    a=await one(s.db.conn,"SELECT j.*,t.attempt_id FROM webhook_stage_attempts t JOIN webhook_stage_jobs j USING(job_id) WHERE t.attempt_id=? AND t.state='running' AND j.state='running' AND j.execution_fence=t.execution_fence",(attempt,))
    if not a: raise WebhookError('capability_expired',status=403)
    return a


def environment(s,attempt,timeout):
    if not s.host: return {}
    host=s.host.config.web.host
    host='127.0.0.1' if host in ('0.0.0.0','') else '[::1]' if host=='::' else host
    return {'OPENBEAR_TELEMETRY_URL':f'http://{host}:{s.host.config.web.port}/webhook/attempts/{attempt}/telemetry','OPENBEAR_TELEMETRY_TOKEN':issue(s,attempt,s.clock()+int(timeout*1000)+30000)}
