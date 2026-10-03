"""Real systemd in private Docker namespaces; never change the host cgroup mount.

The caller records creation intent and owns cleanup, including ambiguous starts.
There is no standalone preflight and no default image/tag or stored approval.
"""
import json
import os
import re
from pathlib import Path

EXEC_PATH = "/opt/testenv/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def start(name, *, image, network, mounts, labels, command, approved=False):
    if approved is not True:
        raise PermissionError("this invocation requires --approve-container-cgroup")
    require(bool(re.fullmatch(r"obrel-[a-f0-9]+-[ab]-[a-f0-9]+-container", name)), "unowned container name")
    require(bool(re.fullmatch(r"sha256:[a-f0-9]{64}", image)), "image must be a fixed Docker image ID")
    require(bool(labels.get("openbear.release.run")), "missing recovery ownership label")

    def cmd(args, label, timeout=60, check=True):
        return command(args, label, timeout=timeout, check=check)

    def exec_cmd(args, label, timeout=60, check=True):
        return cmd(["docker", "exec", "--env", f"PATH={EXEC_PATH}", name, *args], label, timeout, check)

    args = ["docker", "run", "--pull=never", "-dt", "--name", name, "--network", network,
            "--cgroupns=private", "--cpus", "2", "--memory", "4g", "--pids-limit", "1024",
            "--security-opt", "no-new-privileges", "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp"]
    for key, value in labels.items():
        args += ["--label", f"{key}={value}"]
    for source, target, writable in mounts:
        args += ["--mount", f"type=bind,src={source},dst={target}" + ("" if writable else ",readonly")]
    args += [image, "bash", "-c", "while [ ! -f /run/obrel-start ]; do sleep 0.1; done; exec /lib/systemd/systemd --system --log-target=console --log-color=false"]
    cmd(args, "runtime-create-container")  # Never replay on timeout/unknown result.
    info = json.loads(cmd(["docker", "inspect", name], "runtime-inspect-container").stdout)[0]
    pid, cid = info["State"]["Pid"], info["Id"]
    host = info["HostConfig"]
    require(info["Image"] == image, "container image identity mismatch")
    require(all(info["Config"]["Labels"].get(k) == v for k, v in labels.items()), "container ownership mismatch")
    require(host["CgroupnsMode"] == "private" and not host["Privileged"], "unsafe cgroup/privileged mode")
    require(host.get("PidMode") != "host" and host.get("NetworkMode") != "host", "unsafe host namespace")
    for ns in ("mnt", "cgroup", "pid", "net"):
        require(os.readlink(f"/proc/{pid}/ns/{ns}") != os.readlink(f"/proc/self/ns/{ns}"), f"shared {ns} namespace")
    scope = Path(f"/proc/{pid}/cgroup").read_text()
    require(cid in scope, "container cgroup scope not identified")
    visible = exec_cmd(["cat", "/proc/1/cgroup"], "runtime-container-cgroup").stdout.strip()
    require(visible == "0::/", "container cgroup root is not private")
    host_mount = cmd(["findmnt", "-n", "-o", "OPTIONS", "/sys/fs/cgroup"], "runtime-host-mount-before").stdout.strip()
    try:
        cmd(["nsenter", "--target", str(pid), "--mount", "--cgroup", "--root", "--wd", "--",
             "mount", "-o", "remount,rw", "/sys/fs/cgroup"], "runtime-private-cgroup-remount")
    finally:
        after = cmd(["findmnt", "-n", "-o", "OPTIONS", "/sys/fs/cgroup"], "runtime-host-mount-after").stdout.strip()
        require(after == host_mount, "hostMountUnchanged check failed")
    options = exec_cmd(["findmnt", "-n", "-o", "OPTIONS", "/sys/fs/cgroup"], "runtime-container-mount").stdout.strip()
    require("rw" in options.split(","), "container cgroup mount is not writable")
    exec_cmd(["touch", "/run/obrel-start"], "runtime-start-systemd")
    exec_cmd(["bash", "-c", 'for i in $(seq 1 400); do if [ "$(cat /proc/1/comm)" = systemd ] && [ -S /run/systemd/private ]; then exit 0; fi; sleep 0.1; done; exit 1'], "runtime-wait-systemd", timeout=50)
    state = exec_cmd(["systemctl", "is-system-running", "--wait"], "runtime-system-state", check=False)
    require(state.stdout.strip() in ("running", "degraded"), state.stdout + state.stderr)
    return {"container": name, "image": info["Image"], "pid1": "systemd", "systemState": state.stdout.strip(),
            "hostCgroupScope": scope.strip(), "containerCgroupRoot": visible, "hostMountUnchanged": True,
            "privileged": False, "securityOpt": host["SecurityOpt"]}
