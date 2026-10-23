"""Real controller/managed HTTP name round-trips; no changes to shared fixtures."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

import pytest
from pydantic import ValidationError

from app.instances.contracts import Account, relay_path
from tests.test_instance_control_integration import linked_instances  # noqa: F401


async def relay(e, method, path, body=None):
    response = await e.parent_client.post(e.base + '/request', cookies=e.cookie,
                                         json={'method': method, 'path': path, 'body': body})
    value = await response.json()
    assert response.status == 200, value
    assert value['status'] == 200, value
    assert value['data']['ok'], value
    return value['data']


async def test_real_child_chinese_skills_and_filenames_round_trip(linked_instances):  # noqa: F811
    e = linked_instances
    name = '中文技能'
    content = '---\nname: 中文技能\ndescription: Isolated relay fixture\n---\n仅测试资料。\n'
    await relay(e, 'PUT', '/api/managed/v1/files/skills/'+name+'/SKILL.md', {'content': content})
    for suffix in (name, quote(name, safe='')):
        detail = await relay(e, 'GET', '/api/skills/'+suffix)
        assert detail['item']['name'] == name and detail['item']['content'] == content
    await relay(e, 'PATCH', '/api/skills/'+quote(name, safe='')+'/enabled', {'enabled': False})
    assert name in e.child.config.tools.disabled_skills
    relative = name+'/空 格+冒号:资料.txt'
    installed = await relay(e, 'PUT', '/api/managed/v1/files/skills/'+quote(relative, safe='/'), {'content': '原样持久化'})
    assert installed['path'] == relative
    assert (Path(e.child.config.tools.skills_dir)/relative).read_text() == '原样持久化'
    mcp_relative = '中文目录/配置.json'
    installed = await relay(e, 'PUT', '/api/managed/v1/files/mcp/'+quote(mcp_relative, safe='/'), {'content': '{}'})
    assert installed['path'] == mcp_relative
    assert (Path(e.child.config.mcp.install_dir)/mcp_relative).read_text() == '{}'


async def test_real_child_chinese_channel_and_encoded_opaque_model_id(linked_instances):  # noqa: F811
    e = linked_instances
    # Config supports Chinese provider keys; the existing channel mutation helper
    # separately restricts new provider names. Do not change that business policy.
    provider = '中文渠道'
    await relay(e, 'PATCH', '/api/managed/v1/config', {'models': {'providers': {
        provider: {'baseUrl': 'http://127.0.0.1:9', 'apiKey': 'isolated-fixture-key', 'protocol': 'chat', 'models': [{'id': '模型:v1'}]}}}})
    for suffix in (provider, quote(provider, safe='')):
        detail = await relay(e, 'GET', '/api/channels/'+suffix)
        assert detail['provider']['name'] == provider
        assert detail['provider']['models'][0]['id'] == '模型:v1'
    await relay(e, 'PATCH', '/api/managed/v1/config', {'models': {'providers': {provider: {'enabled': False}}}})
    assert not (await relay(e, 'GET', '/api/channels/'+provider))['provider']['enabled']
    identity = '模型:v1+quant@fixture'
    await relay(e, 'POST', '/api/channels/test/models', {'id': identity, 'name': 'before'})
    await relay(e, 'PATCH', '/api/channels/test/models/'+identity, {'name': 'raw name updated'})
    # encodeURIComponent-style names must be decoded exactly once. In particular
    # '+' stays '+', not the query/form convention's space.
    await relay(e, 'PATCH', '/api/channels/test/models/'+quote(identity, safe=''), {'name': 'encoded name updated'})
    detail = await relay(e, 'GET', '/api/channels/test')
    target = next(model for model in detail['provider']['models'] if model['id'] == identity)
    assert target['name'] == 'encoded name updated'
    await relay(e, 'DELETE', '/api/channels/test/models/'+quote(identity, safe=''))
    assert not any(model.id == identity for model in e.child.config.models.providers['test'].models)


async def test_real_http_relay_still_rejects_encoding_and_route_bypasses(linked_instances):  # noqa: F811
    e = linked_instances
    forbidden = [
        ('GET', 'https://evil.example/api/skills'), ('GET', '//evil.example/api/skills'),
        ('GET', '/api/instances'), ('GET', '/api/auth/session'), ('POST', '/api/system/restart'),
        ('GET', '/api/skills?host=evil'), ('GET', '/api/skills#fragment'),
        ('GET', '/api/skills/name%3fhost=evil'), ('GET', '/api/skills/name%23fragment'),
        ('GET', '/api/skills/../instances'), ('GET', '/api/skills/%2e%2e/instances'),
        ('GET', '/api/skills/%252e%252e'), ('GET', '/api/skills/%25E4%25B8%25AD'),
        ('GET', '/api/skills/%'), ('GET', '/api/skills/%2'), ('GET', '/api/skills/%GG'),
        ('GET', '/api/skills/%ff'), ('GET', '/api/skills/%c0%af'), ('GET', '/api/skills/%00'),
        ('GET', '/api/skills/a\\b'), ('GET', '/api/skills/a%5cb'), ('GET', '/api/skills//x'),
        ('GET', '/api/skills/a%2fb'), ('PUT', '/api/managed/v1/files/skills/a%2fb/SKILL.md'),
        ('PATCH', '/api/channels/test/models/a%252fb'), ('PATCH', '/api/channels/test/models/a%2f..%2fb'),
        ('PATCH', '/api/channels/test/models/%2fapi%2fauth'), ('PATCH', '/api/channels/test/models/a%2f%2fb'),
        ('PATCH', '/api/settings/{setting}'), ('PATCH', '/api/settings/managed.enabled'),
        ('POST', '/api/channels/test/unsupported'), ('DELETE', '/api/skills/reload'),
    ]
    for method, path in forbidden:
        response = await e.parent_client.post(e.base+'/request', cookies=e.cookie,
            json={'method': method, 'path': path, 'body': {}})
        assert response.status == 403, (method, path, await response.text())
        assert (await response.json())['error'] == 'relay_route_forbidden'


@pytest.mark.parametrize('path', [
    '/api/skills/中文', '/api/skills/%E4%B8%AD%E6%96%87',
    '/api/channels/test/models/vendor%2f模型%3av1%2bquant',
    '/api/managed/v1/files/skills/中文/空%20格%2B资料.txt',
])
def test_normalization_is_stable(path):
    method = 'PUT' if '/files/' in path else 'PATCH' if '/models/' in path else 'GET'
    canonical = relay_path(method, path)
    assert canonical.isascii()
    assert relay_path(method, canonical) == canonical


# The gateway owns the account and accepts any non-empty password; the UI only advises.
@pytest.mark.parametrize('length,valid', [(0, False), (1, True), (9, True), (1024, True), (1025, False)])
def test_account_password_matches_gateway_limits(length, valid):
    if valid:
        assert len(Account(username='owner', password='x'*length).password) == length
    else:
        with pytest.raises(ValidationError):
            Account(username='owner', password='x'*length)
