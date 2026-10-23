"""Private input stays authentic; only public/audit projections are scrubbed."""
from __future__ import annotations

import asyncio
import base64
import dataclasses
import inspect
import json
from contextvars import ContextVar

from app.references import ReferenceMaterials

_AUDIT = ContextVar('instance_audit_filter', default=None)
_REFERENCE_AUTH = ContextVar('instance_reference_authority', default=None)


def allow_instance_material(material, conversation, bundle):
    operation = material.get('reference', {}).get('instanceOperation')
    if not operation:
        return True
    auth = _REFERENCE_AUTH.get()
    return bool(auth and auth[0] == conversation and auth[1] == operation and auth[2] is asyncio.current_task() and auth[3] == bundle)
SENSITIVE = {'password', 'privatekey', 'managementkey', 'reporttoken', 'businesskey', 'gatewayreporttoken', 'controlkey', 'apikey', 'api_key', 'accesskey', 'access_key', 'token', 'secret', 'authorization'}


def secret_values(value):
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower().replace('_', '') in {v.replace('_', '') for v in SENSITIVE} and isinstance(item, str) and item:
                found.append(item)
            else:
                found.extend(secret_values(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(secret_values(item))
    return found


class Scrubber:
    def __init__(self, values):
        # Too-short values would rewrite ordinary words, not hide a credential.
        self.values = sorted(set(v for value in values if value and len(value) >= 8 for v in (
            value, json.dumps(value, ensure_ascii=False)[1:-1], base64.b64encode(value.encode()).decode(),
            base64.urlsafe_b64encode(value.encode()).decode(), value.encode().hex())), key=len, reverse=True)

    def __call__(self, value, *, partial=False):
        if isinstance(value, str):
            for secret in self.values:
                value = value.replace(secret, '[protected]')
                if partial:
                    for n in range(min(len(secret)-1, len(value)), 0, -1):
                        if value.endswith(secret[:n]):
                            value = value[:-n] + '[protected]'
                            break
            return value
        if isinstance(value, dict):
            return {self(k) if isinstance(k, str) else k: self(v, partial=partial) for k, v in value.items()}
        if isinstance(value, list):
            return [self(v, partial=partial) for v in value]
        if isinstance(value, tuple):
            return tuple(self(v, partial=partial) for v in value)
        if dataclasses.is_dataclass(value):
            return dataclasses.replace(value, **{f.name: self(getattr(value, f.name), partial=partial) for f in dataclasses.fields(value)})
        return value


def audit(value):
    scrub = _AUDIT.get()
    return scrub(value) if scrub else value


class PublicRenderer:
    """Scope-local facade: cumulative text is filtered before Web frames exist."""
    def __init__(self, renderer, scrub):
        self._renderer, self._scrub = renderer, scrub

    def __getattr__(self, name):
        target = getattr(self._renderer, name)
        if not callable(target):
            return target
        if not inspect.iscoroutinefunction(target):
            def sync_call(*args, **kwargs):
                return target(*self._scrub(args), **self._scrub(kwargs))
            return sync_call
        async def call(*args, **kwargs):
            partial = name in {'on_delta', 'on_tool_progress', 'on_tool_update'}
            return await target(*self._scrub(args, partial=partial), **self._scrub(kwargs, partial=partial))
        return call


class PrivateOutputBackend:
    """Prevent model echoes entering public transcripts or context archives.

    Request messages are passed through unchanged (including real credentials).
    Only instance-bound output is buffered per physical call, so split tokens
    cannot leak a secret prefix through streaming. Credential-bearing tool
    arguments fail closed instead of executing masked/substituted credentials.
    """
    def __init__(self, backend, scrub):
        self.backend, self.scrub = backend, scrub

    def __getattr__(self, name):
        return getattr(self.backend, name)

    def calls(self, calls):
        output = []
        for call in calls or []:
            if self.scrub(call.arguments) != call.arguments:
                output.append(dataclasses.replace(call, name='ProtectedCredentialArgumentsRejected_UseInstanceControlDeliver', arguments='{}'))
            else:
                output.append(call)
        return output

    async def stream(self, messages, **options):
        events = [event async for event in self.backend.stream(messages, **options)]
        text = {kind: self.scrub(''.join(e.text for e in events if e.kind == kind)) for kind in ('content', 'reasoning')}
        emitted = set()
        for original in events:
            event = self.scrub(original)
            if event.kind in text:
                if event.kind in emitted:
                    event = dataclasses.replace(event, text='')
                else:
                    emitted.add(event.kind)
                    event = dataclasses.replace(event, text=text[event.kind])
            if original.kind == 'tool_call':
                event = dataclasses.replace(event, tool_calls=self.calls(original.tool_calls))
            yield event

    async def complete(self, messages, **options):
        result = await self.backend.complete(messages, **options)
        return dataclasses.replace(self.scrub(result), tool_calls=self.calls(result.tool_calls))


class Vault:
    def __init__(self, db):
        self.references = ReferenceMaterials(db)

    def seal(self, value):
        return self.references.cipher().encrypt(json.dumps(value, ensure_ascii=False).encode()).decode()

    def open(self, value):
        from cryptography.fernet import InvalidToken

        from app.instances.contracts import InstanceError
        try:
            return json.loads(self.references.cipher().decrypt(value.encode()))
        except (InvalidToken, ValueError):
            raise InstanceError('protected_storage_unavailable', 503) from None

    async def refresh(self, row, operation):
        from app.webhooks.repository import one
        old = await one(self.references.db.conn, 'SELECT protected_material FROM web_reference_bundles WHERE bundle_uuid=? AND conversation_uuid=?',
                        (operation['bundle'], operation['conversation_uuid']))
        if not old:
            raise ValueError('private_operation_material_missing')
        materials = json.loads(self.references.cipher().decrypt(old['protected_material'].encode()))
        material = json.loads(materials[0]['content'])
        material.update(self.open(row['protected']))
        material = self.deployment_material(material)
        return await self.bundle(material, operation['conversation_uuid'], operation['id'])

    @staticmethod
    def deployment_material(material):
        # The gateway is the only account authority. Pending account
        # passwords never enter model references.
        value = json.loads(json.dumps(material))
        for key in ('gatewayPending', 'gatewayUnacked', 'gatewayAccount'):
            value.pop(key, None)
        if value.get('authMode') == 'gateway':
            value.get('form', {}).get('account', {}).pop('password', None)
        return value

    async def bundle(self, material, conversation, op):
        material = self.deployment_material(material)
        ref = {'kind': 'secret', 'id': op, 'key': 'instance-operation:'+op,
               'label': '受保护实例部署档案', 'instanceOperation': op, 'sensitive': True, 'estimatedTokens': len(json.dumps(material)) // 3 + 1}
        return await self.references.save({'manifest': [ref], 'materials': [{'reference': ref, 'content': json.dumps(material, ensure_ascii=False)}]},
                                          conversation_uuid=conversation, op_id='instance:'+op)
