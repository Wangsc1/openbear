"""Real controller route install / ingress, plus volume maintenance exclusion."""
import json
import secrets
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from app.config import Config
from app.managed.maintenance import maintain
from app.managed.persistence import WorkspaceLock, workspace_mounted
from app.managed.settings import ManagedConfig
from app.services import Services
from tests.test_managed_runtime import runtime


async def test_controller_instance_routes_are_owner_only(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENBEAR_INSTANCE_ROLE", raising=False)
    monkeypatch.chdir(tmp_path)
    raw = {"telegram": {"botToken": secrets.token_urlsafe(24), "whitelistIds": [123]},
           "models": {"providers": {}, "primary": ""}, "memory": {}}
    path = tmp_path / "openbear.json"
    path.write_text(json.dumps(raw))
    monkeypatch.setenv("OPENBEAR_CONFIG", str(path))
    svc = Services(Config.model_validate(raw))
    await svc.db.connect()
    await svc.instances.start()
    assert "InstanceControl" in svc.tools.names()
    svc._rebuild_tools_and_context()
    assert "InstanceControl" in svc.tools.names()
    client = TestClient(TestServer(svc.web_admin.make_app()))
    await client.start_server()
    try:
        # No unauthenticated ingress remains: the controller pulls everything.
        for method, url in (("POST", "/api/instance-events/v1"), ("GET", "/api/instances"), ("GET", "/api/instance-servers"),
                            ("GET", "/api/instance-gateway"), ("GET", "/api/instance-servers/ssh-keys")):
            assert (await client.request(method, url, json={})).status in {401, 404}
        assert (await client.post("/api/auth/password/login", json={})).status == 404
        mode = await client.get("/api/auth/mode")
        assert await mode.json() == {"ok": True, "mode": "controller"}
        assert "X-OpenBear-Instance" not in mode.headers
    finally:
        await client.close()
        await svc.shutdown()


def test_mountinfo_exact_kernel_mount(monkeypatch, tmp_path):
    root = tmp_path / "with space"
    root.mkdir()
    escaped = str(root).replace(" ", r"\040")
    assert workspace_mounted(str(root), mountinfo=f"55 33 0:39 / {escaped} rw - ext4 /dev/sda rw\n")
    assert not workspace_mounted(str(root), mountinfo="33 1 0:39 / / rw - overlay overlay rw\n")
    assert not workspace_mounted(str(root), mountinfo=f"55 33 0:39 / {escaped}/nested rw - ext4 /dev/sda rw\n")
    assert not workspace_mounted("/", mountinfo="33 1 0:39 / / rw - overlay overlay rw\n")


async def test_mount_health_and_offline_maintenance(runtime):  # noqa: F811
    r = runtime
    status = await r.svc.managed_runtime.status()
    assert status["persistence"]["mounted"] is False
    assert "workspace_not_mounted" in status["health"]["issues"]
    new_key = secrets.token_urlsafe(32)
    with pytest.raises(RuntimeError, match="in use"):
        maintain(r.root, "rotate-identity", {"managementKey": new_key})
    # Shutdown-like exclusive lock release; no maintenance occurs against a live
    # actual service in this isolated fixture.
    r.svc.managed_runtime.workspace_lock.close()
    original_pepper = r.svc.managed_runtime.pepper
    maintain(r.root, "rotate-identity", {"managementKey": new_key})
    cfg = ManagedConfig.from_environment()
    assert cfg.management_key == new_key
    assert cfg.persist() == original_pepper
    password = secrets.token_urlsafe(24)
    maintain(r.root, "reset-account", {"username": "new-owner", "password": password})
    from app.managed.account import LocalAccount
    assert LocalAccount(str(r.root)).verify("new-owner", password)
