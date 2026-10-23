"""Access gateway lifecycle. The controller installs the gateway on a chosen
server, keeps its single-port control key private, and pushes account/route
changes automatically. Passwords exist only in pending delivery."""
from __future__ import annotations

import asyncio
import base64
import json
import platform
import secrets
import shlex
import time
from pathlib import Path, PurePosixPath

import aiohttp

from app.instances.contracts import InstanceError, origin
from app.logging import get_logger
from app.webhooks.repository import many, one

log = get_logger('instance_gateway')

DEFAULT_PORT = 18962
# Standard system locations: unlike /opt (often 0750 root), every distribution
# lets an unprivileged service user traverse these.
BIN = '/usr/local/lib/openbear-gateway/openbear-gateway'
CONFIG_DIR = '/etc/openbear-gateway'
STATE_DIR = '/var/lib/openbear-gateway'
SERVICE = 'openbear-gateway.service'
# Checked before anything is written, so an unsupported host is reported as such.
PREFLIGHT = '''[ "$(id -u)" = 0 ] || { echo "gateway-needs-root" >&2; exit 3; }
[ -d /run/systemd/system ] || { echo "gateway-needs-systemd" >&2; exit 3; }
command -v useradd >/dev/null 2>&1 || { echo "gateway-needs-useradd" >&2; exit 3; }'''
ROOT = Path(__file__).resolve().parents[2]


def now():
    return int(time.time()*1000)


def prepare(item, protected, *, enabled=True, account=None):
    """Caller holds the instance lock; never recreate an already ACKed password."""
    state = item.setdefault('gateway', {})
    state['mayBeEnabled'] = bool(state.get('mayBeEnabled') or state.get('appliedEnabled') or protected.get('gatewayPending', {}).get('enabled'))
    state.update(status='pending_sync', revision=int(state.get('revision', 0))+1,
                 appliedRevision=int(state.get('appliedRevision', 0)), enabled=enabled, error='')
    previous = protected.pop('gatewayPending', None)
    if previous and any(k in previous for k in ('username', 'password')):
        # An ACK may have been lost after the user changed the account. Resolve
        # this exact revision before the next one; never replay its account fields
        # under a NEW revision, including on route updates or revocation.
        protected['gatewayUnacked'] = previous
        protected.pop('gatewayAccount', None)
    if account:
        protected.setdefault('gatewayAccount', {}).update(account)
    protected.setdefault('businessKey', secrets.token_urlsafe(48))
    item['authMode'] = protected['authMode'] = 'gateway'


ARCHES = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}


def _unit(user):
    return f"""[Unit]
Description=OpenBear access gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={user}
Group={user}
WorkingDirectory={STATE_DIR}
ExecStart={BIN} --config {CONFIG_DIR}/gateway.json
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
# systemd creates it, hands it to User= and makes it writable at every start.
StateDirectory={PurePosixPath(STATE_DIR).name}
StateDirectoryMode=0700

[Install]
WantedBy=multi-user.target
"""


def _install_error(result):
    err = result['stderr']
    for marker, code in (('gateway-needs-root', 'gateway_install_needs_root'), ('gateway-needs-systemd', 'gateway_needs_systemd'),
                         ('gateway-needs-useradd', 'gateway_needs_useradd'), ('gateway-start-failed', 'gateway_start_failed')):
        if marker in err:
            if code == 'gateway_start_failed':
                log.warning('网关服务启动失败', 输出=err[-800:])
            return code
    # A non-root user whose sudo is missing or not passwordless.
    if 'sudo' in err and any(m in err for m in ('password', 'sudoers', 'a terminal is required', 'not found', 'not allowed')):
        return 'gateway_install_needs_root'
    log.warning('网关安装失败', 输出=err[-800:])
    return 'gateway_install_failed'


class Gateway:
    def __init__(self, service):
        self.service = service
        self.sync_task = None

    @property
    def servers(self):
        return self.service.servers

    async def config(self):
        row = await one(self.service.db.conn, 'SELECT * FROM instance_gateway WHERE id=1')
        value = json.loads(row['public_json']) if row else {}
        for key, default in (('enabled', False), ('publicUrl', ''), ('serverId', ''), ('port', DEFAULT_PORT),
                             ('status', 'disabled'), ('error', ''), ('checkedAtMs', None), ('eventSeq', 0),
                             ('clientIp', {'source': 'auto', 'trustedProxies': []}), ('observed', None), ('version', '')):
            value.setdefault(key, default)
        return value, self.service.vault.open(row['protected']) if row else {}

    async def store(self, value, private):
        async with self.service.db.write_transaction(label='instance-gateway-config') as conn:
            await conn.execute('INSERT INTO instance_gateway VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET public_json=excluded.public_json,protected=excluded.protected',
                               (json.dumps(value), self.service.vault.seal(private)))

    @staticmethod
    def control_url(value, private):
        """The controller manages the gateway at server address + port, never through
        the user-facing address (which may be a domain behind someone else's proxy)."""
        return private.get('controlUrl', '')

    async def call(self, value, private, method, path, body=None):
        url = self.control_url(value, private)
        if not private.get('controlKey') or not url:
            raise InstanceError('gateway_not_configured', 409)
        try:
            async with self.service.http.request(method, url+path, headers={'Authorization': 'Bearer '+private['controlKey']},
                    json=body, allow_redirects=False, timeout=aiohttp.ClientTimeout(total=10)) as response:
                raw = bytearray()
                async for chunk in response.content.iter_chunked(16384):
                    raw.extend(chunk)
                    if len(raw) > 2*1024*1024:
                        raise InstanceError('gateway_response_too_large', 502)
                if response.status != 200:
                    raise InstanceError('gateway_http_'+str(response.status), 502)
                data = json.loads(raw)
                if not isinstance(data, dict) or data.get('ok') is not True:
                    raise InstanceError('gateway_invalid_response', 502)
                return data
        except (aiohttp.ClientError, TimeoutError, ValueError, UnicodeError):
            raise InstanceError('gateway_unreachable', 502) from None

    # ----- public API -----
    @staticmethod
    def public_config(value, private):
        return {'ok': True, **{k: v for k, v in value.items() if not k.startswith('_') and k != 'eventSeq'},
                'connected': value['enabled'] and value['status'] == 'connected'}

    async def get(self, *, refresh=True):
        self.service.require_controller()
        async with self.service.lock('gateway-config'):
            value, private = await self.config()
            if refresh and value['enabled']:
                await self._refresh(value, private)
                await self.store(value, private)
            return self.public_config(value, private)

    async def _refresh(self, value, private):
        try:
            result = await self.call(value, private, 'GET', '/control/v1/status')
            value.update(status='connected', error='', checkedAtMs=now(), observed=result.get('clientIpObserved'),
                         clientIp=result.get('clientIp') or value['clientIp'])
            await self._account_names(result)
            return result
        except InstanceError as exc:
            value.update(status='unreachable', error=exc.error, checkedAtMs=now())
            return None

    async def _account_names(self, result):
        # The gateway owns current account names, including self-renames.
        for entry in result.get('instances') or []:
            if not isinstance(entry, dict) or not isinstance(entry.get('id'), str) or not isinstance(entry.get('username'), str):
                continue
            lock = self.service.lock(entry['id'])
            if lock.locked():
                continue
            async with lock:
                row = await one(self.service.db.conn, 'SELECT * FROM managed_instances WHERE id=?', (entry['id'],))
                if not row:
                    continue
                item = json.loads(row['public_json'])
                state = item.get('gateway', {})
                if state.get('appliedRevision') != entry.get('revision') or item.get('account', {}).get('username') == entry['username']:
                    continue
                item['account'] = {'username': entry['username']}
                async with self.service.db.write_transaction(label='gateway-current-account') as conn:
                    await conn.execute('UPDATE managed_instances SET public_json=? WHERE id=?', (json.dumps(item), row['id']))

    async def check_port(self, owner, server_id, port):
        value, _ = await self.config()
        if value['enabled'] and value['serverId'] == server_id and value['port'] == port:
            return {'ok': True, 'free': True, 'current': True}
        return await self.servers.port(owner, server_id, port)

    async def suggest(self, owner, server_id, port):
        ip = await self.servers.public_ip(owner, server_id)
        return {'ok': True, 'publicIp': ip, 'publicUrl': f'http://{ip}:{port}' if ip else ''}

    async def enable(self, owner, data):
        """Install or update the gateway on a server and start it. One port, auto key."""
        self.service.require_controller()
        if set(data) - {'serverId', 'port', 'publicUrl'}:
            raise InstanceError('invalid_gateway_configuration')
        server_id, port, public_url = data.get('serverId'), data.get('port'), data.get('publicUrl')
        if not isinstance(server_id, str) or type(port) is not int or not 1 <= port <= 65535 or not isinstance(public_url, str):
            raise InstanceError('invalid_gateway_configuration')
        public_url = origin(public_url)
        async with self.service.lock('gateway-config'):
            value, private = await self.config()
            moving = value['enabled'] and (value['serverId'] != server_id or value['port'] != port)
            if moving and await self._has_instances():
                raise InstanceError('gateway_move_with_instances', 409)
            if not (value['enabled'] and value['serverId'] == server_id and value['port'] == port):
                check = await self.servers.port(owner, server_id, port)
                if check.get('free') is False:
                    raise InstanceError('gateway_port_in_use', 409)
            target = await self.servers.target(owner, server_id)
            host = '127.0.0.1' if target.get('local') else target['host']
            control = origin(f'http://{host}:{port}' if ':' not in host else f'http://[{host}]:{port}')
            key = private.get('controlKey') if not moving and private.get('controlKey') else secrets.token_urlsafe(48)
            await self._install(target, port, public_url, key)
            value.update(enabled=True, serverId=server_id, port=port, publicUrl=public_url, status='starting', error='', checkedAtMs=now())
            private.update(controlKey=key, controlUrl=control)
            await self.store(value, private)
            for _ in range(20):
                if await self._refresh(value, private):
                    break
                await asyncio.sleep(0.5)
            await self.store(value, private)
            if value['status'] != 'connected':
                raise InstanceError(value['error'] or 'gateway_unreachable', 502)
        await self.sync_all()
        return self.public_config(*(await self.config()))

    async def _has_instances(self):
        return bool(await one(self.service.db.conn, "SELECT 1 FROM managed_instances WHERE auth_mode='gateway' AND status!='archived' LIMIT 1"))

    async def _install(self, target, port, public_url, key):
        if target.get('local'):
            arch = ARCHES.get(platform.machine().lower())
        else:
            arch = ARCHES.get((await self.servers.run(target, 'uname -m', timeout=30))['stdout'].strip())
        if not arch:
            raise InstanceError('gateway_architecture_unsupported', 409)
        binary = ROOT / 'gateway/bin' / f'openbear-gateway-linux-{arch}'
        if not binary.is_file():
            raise InstanceError('gateway_binary_missing', 409)
        config = {'listen': f'0.0.0.0:{port}', 'publicUrl': public_url, 'stateDir': STATE_DIR, 'controlKey': key}
        files = {'openbear-gateway': binary.read_bytes(), 'gateway.json': json.dumps(config, indent=2).encode(),
                 SERVICE: _unit('openbear-gateway').encode()}
        encoded = {name: base64.b64encode(content).decode() for name, content in files.items()}
        # One idempotent script: keeps existing state (accounts, sessions), replaces
        # binary/config/unit, restarts only the gateway service.
        script = f'''set -e
umask 077
{PREFLIGHT}
nologin=$(command -v nologin || echo /bin/false)
id openbear-gateway >/dev/null 2>&1 || useradd --system --user-group --home-dir {STATE_DIR} --no-create-home --shell "$nologin" openbear-gateway
install -d -m 0755 $(dirname {BIN})
install -d -m 0750 -o root -g openbear-gateway {CONFIG_DIR}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
'''
        for name, data in encoded.items():
            script += f"printf '%s' {shlex.quote(data)} | base64 -d > \"$tmp/{name}\"\n"
        script += f'''install -m 0755 "$tmp/openbear-gateway" {BIN}
install -m 0600 -o openbear-gateway -g openbear-gateway "$tmp/gateway.json" {CONFIG_DIR}/gateway.json
install -m 0644 "$tmp/{SERVICE}" /etc/systemd/system/{SERVICE}
systemctl daemon-reload
systemctl enable {SERVICE} >/dev/null 2>&1
systemctl restart {SERVICE}
# A unit that cannot start keeps restarting; report it instead of a later
# connection failure that points at ports and firewalls.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.5
  [ "$(systemctl show -p NRestarts --value {SERVICE})" = "0" ] && systemctl is-active --quiet {SERVICE} && [ $_ -ge 4 ] && exit 0
done
echo "gateway-start-failed" >&2
journalctl -u {SERVICE} -n 5 --no-pager >&2 || true
exit 3
'''
        result = await self.servers.run(target, 'sh -s', stdin=script.encode(), timeout=180, root=True)
        if not result['ok']:
            raise InstanceError(_install_error(result), 502)

    async def disable(self, owner):
        """Stop the gateway service. Accounts and sessions stay in its state directory."""
        self.service.require_controller()
        async with self.service.lock('gateway-config'):
            value, private = await self.config()
            if not value['enabled']:
                return self.public_config(value, private)
            target = await self.servers.target(owner, value['serverId'])
            result = await self.servers.run(target, f'systemctl disable --now {SERVICE}', timeout=60, root=True)
            if not result['ok']:
                raise InstanceError('gateway_stop_failed', 502)
            value.update(enabled=False, status='disabled', error='', checkedAtMs=now())
            await self.store(value, private)
            return self.public_config(value, private)

    async def set_public_url(self, owner, public_url):
        value, _ = await self.config()
        if not value['enabled']:
            raise InstanceError('gateway_not_enabled', 409)
        return await self.enable(owner, {'serverId': value['serverId'], 'port': value['port'], 'publicUrl': public_url})

    async def set_client_ip(self, data):
        if set(data) - {'trustedProxies'} or not isinstance(data.get('trustedProxies'), list):
            raise InstanceError('invalid_gateway_client_ip')
        body = {'source': 'header' if data['trustedProxies'] else 'auto', 'trustedProxies': data['trustedProxies']}
        async with self.service.lock('gateway-config'):
            value, private = await self.config()
            ack = await self.call(value, private, 'PUT', '/control/v1/client-ip', body)
            value['clientIp'] = ack.get('clientIp') or body
            await self.store(value, private)
            return self.public_config(value, private)

    # ----- instance sync -----
    def schedule_sync(self):
        """Account/route changes reach the gateway without a manual sync button."""
        if self.sync_task and not self.sync_task.done():
            return
        self.sync_task = asyncio.create_task(self.sync_all(), name='gateway-sync')

    async def sync_all(self):
        rows = await many(self.service.db.conn, "SELECT id,owner FROM managed_instances WHERE auth_mode='gateway'")
        for row in rows:
            try:
                await self.sync(row['owner'], row['id'])
            except Exception:
                pass  # The pending state is kept and retried by the monitor.

    async def pull_events(self):
        from app.instances.events import ingest_gateway
        async with self.service.lock('gateway-events'):
            value, private = await self.config()
            if not value['enabled']:
                return
            result = await self.call(value, private, 'GET', f'/control/v1/events?after={int(value["eventSeq"])}')
            handled = await ingest_gateway(self.service, result.get('items') or [])
            if handled > value['eventSeq']:
                async with self.service.lock('gateway-config'):
                    value, private = await self.config()
                    value['eventSeq'] = max(value['eventSeq'], handled)
                    await self.store(value, private)

    async def persist(self, row, item, protected, *, archived=False):
        async with self.service.db.write_transaction(label='instance-gateway-state') as conn:
            await conn.execute("UPDATE managed_instances SET public_json=?,protected=?,auth_mode=?,revision=revision+1,status=CASE WHEN ? THEN ? ELSE status END WHERE id=?",
                (json.dumps(item), self.service.vault.seal(protected), 'gateway', archived, 'archived', row['id']))

    async def sync(self, owner, identity, *, expected_revision=None):
        self.service.require_controller()
        async with self.service.lock('gateway-config'):
            value, private = await self.config()
        return await self._sync(owner, identity, value, private, expected_revision=expected_revision)

    async def apply(self, value, private, identity, body):
        ack = await self.call(value, private, 'PUT', '/control/v1/instances/'+identity, body)
        if ack.get('id') != identity or ack.get('revision') != body['revision'] or ack.get('enabled') is not body['enabled'] or not isinstance(ack.get('username'), str) or not ack['username']:
            raise InstanceError('gateway_ack_mismatch', 502)
        return ack

    async def _sync(self, owner, identity, value, private, *, expected_revision=None):
        async with self.service.lock(identity):
            row = await self.service.row(owner, identity, active=False)
            if expected_revision is not None and row['revision'] != expected_revision:
                raise InstanceError('instance_changed_after_confirmation', 409)
            item, protected = json.loads(row['public_json']), self.service.vault.open(row['protected'])
            state = item.setdefault('gateway', {})
            if state.get('status') == 'synced' and state.get('appliedRevision') == state.get('revision'):
                return {'ok': True, 'synced': True, **await self.service.get(owner, identity)}
            try:
                if not value['enabled']:
                    raise InstanceError('gateway_not_enabled', 409)
                if not item.get('managementUrl'):
                    raise InstanceError('instance_address_pending', 409)
                unresolved = protected.get('gatewayUnacked')
                if unresolved:
                    ack = await self.apply(value, private, identity, unresolved)
                    state.update(appliedRevision=ack['revision'], appliedEnabled=ack['enabled'], mayBeEnabled=ack['enabled'])
                    item['account'] = {'username': ack['username']}
                    protected.pop('gatewayUnacked', None)
                    await self.persist(row, item, protected)
                body = protected.get('gatewayPending')
                if body is None:
                    body = {'revision': state['revision'], 'upstream': item['managementUrl'], 'businessKey': protected['businessKey'],
                            'enabled': state['enabled'], **protected.get('gatewayAccount', {})}
                    protected['gatewayPending'] = body
                if state.get('appliedRevision', 0) == 0 and (not body.get('username') or not body.get('password')):
                    raise InstanceError('gateway_initial_account_required', 409)
                # Persist exact revision/body before I/O. A lost ACK retries the same
                # payload; after ACK account fields are never replayed on later revisions.
                state['mayBeEnabled'] = bool(state.get('mayBeEnabled') or body['enabled'])
                await self.persist(row, item, protected)
                ack = await self.apply(value, private, identity, body)
                state.update(status='synced', appliedRevision=body['revision'], appliedEnabled=body['enabled'], mayBeEnabled=body['enabled'], error='', syncedAtMs=now())
                item['account'] = {'username': ack['username']}
                protected.pop('gatewayPending', None)
                protected.pop('gatewayAccount', None)
                archived = bool(item.get('archivePending') and not ack['enabled'])
                if archived:
                    item.pop('archivePending', None)
                await self.persist(row, item, protected, archived=archived)
                if archived:
                    async with self.service.db.write_transaction(label='gateway-archive-notifications') as conn:
                        await conn.execute("UPDATE instance_notifications SET status='suppressed',updated_ms=? WHERE instance_id=? AND status='pending'", (now(), identity))
                return {'ok': True, 'synced': True, **await self.service.get(owner, identity)}
            except InstanceError as exc:
                state.update(status='pending_sync', error=exc.error)
                await self.persist(row, item, protected)
                return {'ok': True, 'synced': False, 'error': exc.error, **await self.service.get(owner, identity)}

    async def probe(self, row):
        """Ask the gateway to reach the instance the way a browser request would."""
        value, private = await self.config()
        item = json.loads(row['public_json'])
        state = item.get('gateway', {})
        if not value['enabled'] or state.get('status') != 'synced' or not state.get('appliedEnabled'):
            return {'ok': False, 'error': 'gateway_sync_required'}
        try:
            data = await self.call(value, private, 'GET', '/control/v1/instances/'+row['id']+'/probe')
        except InstanceError as exc:
            return {'ok': False, 'error': exc.error}
        child = data.get('status') if isinstance(data.get('status'), dict) else {}
        ok = data.get('id') == row['id'] and data.get('revision') == state.get('appliedRevision') and data.get('reachable') is True
        return {'ok': ok, 'error': '' if ok else 'gateway_route_unverified',
                'status': {k: child.get(k) for k in ('ok', 'instanceId', 'ready', 'health', 'persistence', 'version')}}
