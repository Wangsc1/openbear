"""Fixed-target management transport to an instance."""
from __future__ import annotations

import json

import aiohttp
from yarl import URL

from app.instances.contracts import InstanceError, relay_path
from app.instances.security import Scrubber, secret_values

MAX_RESPONSE = 2 * 1024 * 1024


async def request(service, row, method, path, body=None, *, raw_path=False):
    item = json.loads(row['public_json'])
    credentials = service.vault.open(row['protected'])
    if not raw_path:
        path = relay_path(method, path)
    headers = {'Authorization': 'Bearer ' + credentials['managementKey']}
    # relay_path produces a canonical encoded path. Preserve encoded slashes in
    # opaque model IDs: aiohttp routes them as one segment, then decodes match_info.
    url = URL(item['managementUrl'] + path, encoded=True)
    try:
        # Never trust proxy env or ambient cookies; no redirect receives a key.
        async with service.http.request(method, url, json=body if body is not None else None,
                                        headers=headers, allow_redirects=False) as response:
            if 300 <= response.status < 400:
                raise InstanceError('child_redirect_rejected', 502)
            raw = bytearray()
            async for chunk in response.content.iter_chunked(65536):
                raw.extend(chunk)
                if len(raw) > MAX_RESPONSE:
                    raise InstanceError('child_response_too_large', 502)
            try:
                data = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                raise InstanceError('child_invalid_response', 502) from None
            scrub = Scrubber(secret_values(credentials))
            # Keys must not leak even if a malicious child reflects the bearer.
            return response.status, scrub(data)
    except (TimeoutError, aiohttp.ClientError):
        raise InstanceError('child_unreachable', 502) from None


def child_evidence(data, identity):
    data = data if isinstance(data, dict) else {}
    correct = data.get('ok') is True and data.get('instanceId') == identity
    health = data.get('health') if isinstance(data.get('health'), dict) else {}
    persistence = data.get('persistence') if isinstance(data.get('persistence'), dict) else {}
    return {'identity': correct, 'ready': correct and data.get('ready') is True,
            'health': {'status': str(health.get('status', 'unknown'))[:80], 'issues': health.get('issues', [])} if correct else {'status': 'unknown', 'issues': []},
            'persistence': bool(correct and persistence.get('root') == '/workspace' and persistence.get('mounted') is True
                and all(str(persistence.get(k, '')).startswith('/workspace/') and '..' not in str(persistence.get(k, '')).split('/') for k in ('dbPath', 'workspacePath')))}


async def probe(service, row):
    """Instance identity/health directly, plus the same request through the gateway."""
    import asyncio

    async def direct():
        try:
            status, data = await request(service, row, 'GET', '/api/managed/v1/status', raw_path=True)
            return {'httpStatus': status, 'error': '', **child_evidence(data if status == 200 else None, row['id'])}
        except InstanceError as exc:
            return {'httpStatus': None, 'error': exc.error, **child_evidence(None, row['id'])}
    observed, gateway = await asyncio.gather(direct(), service.gateway.probe(row))
    check = {k: observed[k] for k in ('identity', 'ready', 'persistence', 'health')}
    check.update(publicRoute=bool(gateway['ok']), gateway=gateway, error=observed['error'] or gateway.get('error', ''))
    if not check['error'] and not all(check[k] for k in ('identity', 'ready', 'persistence')):
        check['error'] = 'identity_readiness_or_persistence_unverified'
    check['ok'] = all(check[k] for k in ('identity', 'ready', 'persistence', 'publicRoute')) and check['health']['status'] == 'healthy'
    return Scrubber(secret_values(service.vault.open(row['protected'])))(check)
