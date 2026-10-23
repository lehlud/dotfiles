"""Mount projections and pre-start verification for owned OCI workloads."""
import json
import os
import re
from .policy import OWNER, within
from .processes import capture


def read_json(engine, arguments, environment, cwd):
    result = capture(engine, arguments, environment, cwd)
    if result["exitCode"]:
        raise ValueError("Engine capability/identity check failed: " + result["stderr"][-600:])
    return json.loads(result["stdout"])


def require_controls(engine, environment, cwd):
    data = read_json(engine, ["info", "--format", "{{json .}}"], environment, cwd)
    if engine.name == "podman":
        host = data.get("host", {})
        controllers = set(host.get("cgroupControllers", []))
        if host.get("cgroupVersion") != "v2" or not {"cpu", "memory", "pids"} <= controllers:
            raise ValueError("The operator engine has no verified memory/CPU/PID workload controls")
    elif not all(data.get(key) for key in ["MemoryLimit", "CpuCfsQuota", "PidsLimit"]):
        raise ValueError("The Docker daemon does not report required workload controls")
    return bool(data.get("host", {}).get("security", {}).get("rootless", False))


def projected_mounts(scope, directory, additional=None):
    mounts = []
    projections = [{"source": path, "target": path, "readOnly": path in scope.get("readOnlyBindings", [])}
                   for path in scope["bindings"]]
    projections += additional or []
    for entry in projections:
        source, target = entry["source"], entry["target"]
        if not os.path.exists(source) or os.path.realpath(source) != source:
            raise ValueError("Reviewed engine bind changed or is missing")
        mounts += ["--mount", "type=bind,src=" + source + ",dst=" + target + (",readonly" if entry["readOnly"] else "")]
    return mounts


def container_state(engine, target, environment, cwd):
    data = read_json(engine, ["container", "inspect", target], environment, cwd)
    if not isinstance(data, list) or len(data) != 1:
        raise ValueError("Engine returned an ambiguous container identity")
    return data[0]


def verified_container(engine, target, job, limits, environment, cwd, scope):
    state = container_state(engine, target, environment, cwd)
    labels = state.get("Config", {}).get("Labels") or {}
    host = state.get("HostConfig") or {}
    if labels.get(OWNER) != job or host.get("Privileged"):
        raise ValueError("Container is not an unprivileged resource owned by this job")
    if host.get("Memory") != limits["memoryMiB"] * 1048576 or host.get("PidsLimit") != limits["pids"]:
        raise ValueError("Engine did not install the reviewed memory/PID controls")
    if host.get("MemorySwap") != limits["memoryMiB"] * 1048576:
        raise ValueError("Engine did not disable workload swap beyond the memory budget")
    for mount in state.get("Mounts", []):
        if mount.get("Type") == "bind":
            source = os.path.realpath(mount["Source"])
            if source not in scope["bindings"]:
                raise ValueError("Engine added an unreviewed host bind mount")
            if source in scope.get("readOnlyBindings", []) and mount.get("RW", False):
                raise ValueError("Engine widened a read-only project grant")
    if host.get("Devices") or host.get("CapAdd") or host.get("VolumesFrom"):
        raise ValueError("Engine added unreviewed host privileges")
    nano, period, quota = host.get("NanoCpus", 0), host.get("CpuPeriod", 0), host.get("CpuQuota", 0)
    cpus = nano / 1000000000 if nano else quota / period if period and quota > 0 else 0
    if not 0 < cpus <= limits["cpus"] + 0.00000001:
        raise ValueError("Engine did not install the reviewed CPU quota")
    for key in ["PidMode", "IpcMode", "UTSMode", "UsernsMode"]:
        if host.get(key) == "host":
            raise ValueError("Engine unexpectedly shared a host namespace")
    identifier = state.get("Id", state.get("ID", ""))
    if not re.fullmatch(r"[a-f0-9]{12,64}", identifier):
        raise ValueError("Invalid engine container identity")
    return identifier
