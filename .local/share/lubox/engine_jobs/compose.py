"""Reconstruct the supported Compose subset; never pass unknown host-facing fields through."""
import copy
import re
from .policy import OWNER, binding, host_path, published_port, image_reference

SERVICE_FIELDS = {
    "image", "command", "entrypoint", "environment", "user", "working_dir", "hostname",
    "volumes", "ports", "expose", "networks", "depends_on", "healthcheck", "labels",
    "read_only", "init", "stop_grace_period", "stop_signal", "profiles", "restart",
}
VERBS = {
    "config": ({}, {"--quiet", "-q", "--services", "--images", "--volumes"}),
    "pull": ({}, {"--quiet", "-q"}),
    "up": ({"--wait-timeout": True}, {"-d", "--detach", "--wait"}),
    "exec": ({"--user": True, "-u": True, "--workdir": True, "-w": True, "--env": True, "-e": True}, {"-T"}),
    "ps": ({}, {"--all", "-a", "--quiet", "-q"}),
    "logs": ({"--tail": True}, {"--no-color", "--timestamps"}),
    "down": ({}, {"--volumes", "-v"}),
    "stop": ({}, set()),
    "start": ({}, set()),
    "restart": ({}, set()),
}


def escape_environment(value):
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, list):
        return [escape_environment(item) for item in value]
    if isinstance(value, dict):
        return {key: escape_environment(item) for key, item in value.items()}
    return value


def project_volume(volume, scope, names):
    if isinstance(volume, str):
        parts = volume.split(":")
        if len(parts) == 1 and parts[0].startswith("/"):
            return volume
        if parts[0].startswith("/"):
            return binding(scope, volume)
        if parts[0] in names and len(parts) in [2, 3] and (len(parts) == 2 or parts[2] in ["ro", "rw"]):
            return volume
        raise ValueError("Compose mounts require declared job-local volumes or exact granted paths")
    if not isinstance(volume, dict) or set(volume) - {"type", "source", "target", "read_only"}:
        raise ValueError("Unsupported Compose mount attributes")
    if volume.get("type") == "bind":
        source = host_path(scope, volume["source"], not volume.get("read_only", False))
        return binding(scope, source + ":" + volume["target"] + (":ro" if volume.get("read_only") else ":rw"))
    if volume.get("type") == "volume" and volume.get("source") in names:
        return volume
    raise ValueError("Unsupported Compose mount type")


def command_arguments(arguments, services, connected):
    from .policy import literal_environment, option
    if not arguments or arguments[0] not in VERBS:
        raise ValueError("Use Compose config/pull/up/exec/ps/logs/down/stop/start/restart; one-off run and builds are excluded")
    verb = arguments[0]
    if verb == "pull" and not connected:
        raise ValueError("Image pull requires explicit network approval")
    values, flags = VERBS[verb]
    result, index = [verb], 1
    while index < len(arguments) and arguments[index].startswith("-"):
        name, value, index = option(arguments, index, values, flags)
        if value is not None:
            if name in ["--env", "-e"]:
                literal_environment(value)
            elif name in ["--wait-timeout", "--tail"] and not re.fullmatch(r"\d{1,6}", value):
                raise ValueError("Expected a bounded numeric Compose option")
            result += [name, value]
        else:
            result.append(name)
    remaining = arguments[index:]
    if verb == "exec":
        if len(remaining) < 2 or remaining[0] not in services:
            raise ValueError("Compose exec requires a declared job service and complete argv")
        result += remaining
    else:
        if any(name not in services for name in remaining):
            raise ValueError("Compose targets must be declared job services")
        result += remaining
    if verb == "up":
        if not any(flag in result for flag in ["--detach", "-d", "--wait"]):
            raise ValueError("Use Compose up -d or --wait within a bounded batch")
        result += ["--no-build", "--no-recreate"]
    return result


def prepare_compose(manifest, request, limits):
    config = copy.deepcopy(manifest["config"])
    scope, connected = request["workspace"], request.get("network") == "host"
    if set(config) - {"name", "version", "services", "volumes", "networks"}:
        raise ValueError("Flatten Compose includes/extensions; secret/config sources and unknown root fields are excluded")
    config.pop("name", None)
    config.pop("version", None)
    services = config.get("services")
    if not isinstance(services, dict) or not 1 <= len(services) <= 16:
        raise ValueError("Compose needs one to sixteen explicit services")
    for category in ["volumes", "networks"]:
        for name, value in (config.get(category) or {}).items():
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", name) or value not in [None, {}]:
                raise ValueError("Only ordinary job-local networks/volumes are supported; existing resources and drivers are excluded")
    networks = config.setdefault("networks", {})
    networks.setdefault("default", {})
    for name in networks:
        networks[name] = {"internal": not connected}
    for name, service in services.items():
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", name):
            raise ValueError("Invalid Compose service name")
        if not isinstance(service, dict) or set(service) - SERVICE_FIELDS:
            raise ValueError("Unsupported Compose service fields; host privileges, image builds and external resource controls are excluded")
        if not isinstance(service.get("image"), str) or service["image"].startswith("-"):
            raise ValueError("Each Compose service requires a prebuilt image")
        image_reference(service["image"])
        if service.get("restart", "no") != "no":
            raise ValueError("Temporary jobs cannot install restart policies")
        service["volumes"] = [project_volume(value, scope, config.get("volumes", {})) for value in service.get("volumes", [])]
        if any(not isinstance(port, str) for port in service.get("ports", [])):
            raise ValueError("Use explicit loopback host:container port strings")
        service["ports"] = [published_port(port, connected) for port in service.get("ports", [])]
        labels = service.get("labels") or {}
        if not isinstance(labels, dict) or any(key.startswith(("io.pi.", "com.docker.compose.")) for key in labels):
            raise ValueError("Compose labels require a mapping without reserved ownership labels")
        service["labels"] = {**labels, OWNER: request["job"]}
        service.update(mem_limit=str(limits["memoryMiB"]) + "m", memswap_limit=str(limits["memoryMiB"]) + "m",
                       cpus=limits["cpus"], pids_limit=limits["pids"], security_opt=["no-new-privileges:true"])
        service["pull_policy"] = "missing" if connected else "never"
        service.setdefault("user", str(scope["uid"]) + ":" + str(scope["gid"]))
    arguments = command_arguments(manifest["arguments"], services, connected)
    return {"kind": "compose", "config": escape_environment(config), "arguments": arguments}
