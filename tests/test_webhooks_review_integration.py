"""Cross-package boundaries through real producer intake; no product test mode."""
import pytest

from app.webhooks.repository import one
from tests.test_web_admin import _login_cookie
from tests.test_webhooks_backend import env, create, accept


@pytest.mark.parametrize('content_type,body', [
    ('application/json', b'{"x":Infinity}'),
    ('application/json', b'{"x":"\\ud800"}'),
    ('text/plain', b'\xed\xa0\x80'),
])
async def test_producer_rejects_unrepresentable_material_before_acceptance(env, content_type, body):
    c=await create(env)
    response=await env.client.post('/webhook/'+c['endpoint']['id'],data=body,headers={
        'Authorization':'Bearer '+c['credential']['key'],'Content-Type':content_type,
    })
    result=await response.json()
    assert response.status==422 and result['code']=='invalid_body'
    assert not env.s.confirmations
    assert (await one(env.db.conn,'SELECT COUNT(*) n FROM webhook_events'))['n']==0


async def test_admin_impact_and_endpoint_count_include_terminal_review(env):
    c=await create(env); e=c['endpoint']; event=await accept(env,c,key='known-old')
    async with env.db.webhook_transaction() as conn:
        await conn.execute("UPDATE webhook_events SET route_state='terminal',terminal_at_ms=?,review_required=1 WHERE event_id=?",
            (env.s.clock(),event['eventId']))
    cookies={'openbear_web_session':await _login_cookie(env)}
    response=await env.client.post('/api/webhooks/'+e['id']+'/delete-impact',cookies=cookies,json={
        'stopRunning':False,'expectedControlRevision':0,
    })
    prepared=await response.json()
    assert response.status==200 and prepared['impact']['pendingEvents']==1
    response=await env.client.get('/api/webhooks/'+e['id'],cookies=cookies)
    current=await response.json()
    assert current['endpoint']['pendingEvents']==1
