"""Deployment delivery and fixed-target command execution for a bound operation."""
from __future__ import annotations

import fnmatch
import io
import json
import re
import shlex
import tarfile
from pathlib import Path, PurePosixPath

from app.instances.contracts import InstanceError

ROOT = Path(__file__).resolve().parents[2]
# Mirrors .dockerignore: only distributable inputs; never config, data or secrets.
BUILD_INPUTS = ('Dockerfile', 'pyproject.toml', 'uv.lock', 'README.md', 'app', 'prompts', 'web/dist',
                'scripts/container-entrypoint.sh')
EXCLUDED = ('*/__pycache__', '*/__pycache__/*', '*.pyc')


def _source_context():
    """Same-version build context; web/dist is shipped prebuilt so no Node build runs remotely."""
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        for name in BUILD_INPUTS:
            path = ROOT / name
            if not path.exists():
                if name == 'web/dist':
                    raise InstanceError('web_dist_missing', 409)
                continue
            def keep(info):
                return None if any(fnmatch.fnmatch(info.name, p) for p in EXCLUDED) else info
            archive.add(path, arcname=name, filter=keep)
    return stream.getvalue()


def container_name(item):
    """Named after the data directory (e.g. /opt/openbear-node -> openbear-node),
    which is unique per server; never after the login account."""
    base = re.sub(r'[^a-z0-9_.-]+', '-', PurePosixPath(item['workspacePath']).name.lower()).strip('-.')[:60]
    return base if base.startswith('openbear') else 'openbear-' + (base or 'instance')


def compose(row, protected, item, image):
    environment = {'OPENBEAR_INSTANCE_ROLE': 'managed', 'OPENBEAR_INSTANCE_ID': row['id'],
                   'OPENBEAR_MANAGEMENT_KEY': protected['managementKey'], 'OPENBEAR_WORKSPACE': '/workspace',
                   'OPENBEAR_CHILD_AUTH': 'gateway', 'OPENBEAR_GATEWAY_KEY': protected['businessKey']}
    # Compose interpolates "$"; escape so credentials reach the container unchanged.
    environment = {k: v.replace('$', '$$') for k, v in environment.items()}
    bind = '127.0.0.1' if item['managementUrl'].startswith(('http://127.0.0.1:', 'http://localhost:')) else '0.0.0.0'
    return {'services': {'openbear': {'image': image, 'container_name': container_name(item),
                'restart': 'unless-stopped', 'environment': environment, 'ports': [f'{bind}:{item["port"]}:18961'],
                'volumes': [{'type': 'bind', 'source': item['workspacePath'], 'target': '/workspace'}],
                'security_opt': ['no-new-privileges:true']}}}


def deployment_archive(row, protected, item, params):
    """Generate real secrets in memory, never in model arguments or tool output."""
    from app import installed_version
    image = params.get('image') or item.get('image') or f'openbear:{installed_version()}'
    if not isinstance(image, str) or len(image) > 512 or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._:/@-]*', image):
        raise InstanceError('invalid_image', 409)
    if not protected.get('businessKey'):
        raise InstanceError('gateway_sync_required_before_new_deployment', 409)
    files = {'compose.json': json.dumps(compose(row, protected, item, image), ensure_ascii=False).encode()}
    if params.get('source', not item.get('image')):
        files['source.tar.gz'] = _source_context()
    initialize = params.get('initialize', True)
    if type(initialize) is not bool:
        raise InstanceError('invalid_initialize_scope')
    if initialize:
        from pydantic import ValidationError

        from app.config import Config
        initial = protected.get('initialConfig') or {}
        bootstrap = {'models': initial.get('models') or {'providers': {}, 'primary': ''}, 'memory': {'provider': 'builtin'},
                     'web': {'enabled': True, 'host': '0.0.0.0', 'port': 18961}}
        try:
            Config.model_validate(bootstrap)
        except (ValidationError, ValueError, TypeError):
            raise InstanceError('invalid_initial_config', 409) from None
        files['bootstrap.json'] = json.dumps(bootstrap, ensure_ascii=False).encode()
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.mode, info.size = 0o600, len(content)
            archive.addfile(info, io.BytesIO(content))
    # Beside the data directory, not inside it: the data directory is mounted
    # into the container and must not carry the build context.
    data = PurePosixPath(item['workspacePath'])
    directory = str(data.parent / ('.deploy-' + data.name))
    command = f'umask 077; mkdir -p {shlex.quote(directory)} && tar -xf - -C {shlex.quote(directory)}'
    if 'source.tar.gz' in files:
        command += f' && rm -rf {shlex.quote(directory + "/source")} && mkdir -p {shlex.quote(directory + "/source")} && tar -xzf {shlex.quote(directory + "/source.tar.gz")} -C {shlex.quote(directory + "/source")}'
    if initialize:
        target = shlex.quote(item['workspacePath'] + '/openbear.json')
        command += (f' && mkdir -p {shlex.quote(item["workspacePath"])} && '
                    f'if [ ! -e {target} ]; then (set -C; cat {shlex.quote(directory + "/bootstrap.json")} > {target}); fi')
    return command, stream.getvalue(), directory, image


async def perform(service, ctx, action, params):
    op = await service.authority(ctx, expected_revision=params.get('revision'))
    async with service.lock(op['instance_id']):
        op = await service.authority(ctx, expected_revision=params.get('revision'))
        row = await service.row(op['owner'], op['instance_id'])
        item = service.public(row)
        target = await service.servers.target(op['owner'], item['serverId'])
        if action == 'deliver':
            protected = service.vault.open(row['protected'])
            command, content, directory, image = deployment_archive(row, protected, item, params)
            result = await service.servers.run(target, command, stdin=content, timeout=300)
            if result['ok']:
                latest = await service.row(op['owner'], op['instance_id'])
                public = service.public(latest)
                public['image'] = image
                async with service.db.write_transaction(label='instance-deployment-archive') as conn:
                    await conn.execute('UPDATE managed_instances SET public_json=? WHERE id=?', (json.dumps(public), row['id']))
            built = '' if not params.get('source', not item.get('image')) else f'；同版本源码在 {directory}/source，可用 docker build -t {image} {directory}/source 构建'
            return {**result, 'directory': directory, 'compose': directory + '/compose.json', 'image': image,
                    'note': f'已交付 compose.json（含实例凭证，不要打印）{built}。数据目录仅在缺少 openbear.json 时写入初始配置。'
                            f'然后执行 docker compose -f {directory}/compose.json up -d，再用 verify 核验。不删除已有数据目录。'}
        command = params.get('command')
        timeout = params.get('timeoutSeconds', 120)
        if not isinstance(command, str) or not command.strip() or len(command) > 32000 or type(timeout) is not int or not 1 <= timeout <= 600:
            raise InstanceError('invalid_remote_command')
        sudo = params.get('sudo', False)
        if type(sudo) is not bool:
            raise InstanceError('invalid_sudo_scope')
        if not isinstance(params.get('description', ''), str):
            raise InstanceError('invalid_remote_command')
        return await service.servers.run(target, command, timeout=timeout, sudo=sudo)
