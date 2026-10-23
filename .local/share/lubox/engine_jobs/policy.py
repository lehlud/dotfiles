"""Pure policy for temporary project jobs, never an unrestricted engine shell."""
import os
import math
import re
import uuid

OWNER = "io.pi.container-job"
DENIED = {
    "--privileged", "--device", "--device-cgroup-rule", "--cap-add", "--security-opt",
    "--runtime", "--hooks-dir", "--conmon", "--replace", "--volumes-from", "--use-api-socket",
    "--config", "--context", "--connection", "--url", "--identity", "--host",
    "--env-host", "--env-file", "--ssh", "--secret", "--secrets", "--cgroup-parent",
    "--pid", "--ipc", "--uts", "--userns", "--userns-mode", "--publish-all",
}
RUN_VALUES = {
    "--name", "--user", "-u", "--workdir", "-w", "--entrypoint", "--env", "-e",
    "--label", "-l", "--publish", "-p", "--volume", "-v", "--mount", "--hostname",
    "--add-host", "--network", "--net", "--memory", "-m", "--cpus", "--pids-limit",
    "--shm-size", "--stop-timeout", "--health-cmd", "--health-interval", "--health-timeout",
    "--health-retries", "--health-start-period", "--platform",
}
RUN_FLAGS = {"--rm", "--detach", "-d", "--init", "--read-only", "--no-healthcheck"}


def within(root, path):
    return path == root or path.startswith(root.rstrip("/") + "/")


def host_path(scope, value, writable=False):
    path = os.path.realpath(os.path.join(scope["cwd"], value))
    allowed = [root for root in scope["bindings"] if not writable or root not in scope.get("readOnlyBindings", [])]
    if not any(within(root, path) for root in allowed):
        raise ValueError("Engine file access exceeds the reviewed project/path grants")

    if any(within(entry["path"], path) for entry in scope["masked"]):
        raise ValueError("Engine access to protected operator files is excluded")

    if path not in scope["bindings"]:
        raise ValueError("Mount sources must be exact reviewed path roots; grant individual config files explicitly")
    if any(within(path, entry["path"]) for entry in scope["masked"]):
        raise ValueError("Container mounts cannot contain protected operator files; select a narrower project root")
    if any(character in path for character in [",", ":", "\n", "\r"]):
        raise ValueError("Unsupported mount source delimiter")

    return path


def option(arguments, index, values, flags):
    value = arguments[index]
    name, equal, supplied = value.partition("=")
    if name in DENIED:
        raise ValueError("Host privilege/configuration option is excluded: " + name)

    if name in flags and not equal:
        return name, None, index + 1

    if name not in values:
        raise ValueError("Unsupported engine option; use the documented project-job form: " + name)

    if equal:
        return name, supplied, index + 1

    if index + 1 >= len(arguments):
        raise ValueError("Engine option requires a value: " + name)

    return name, arguments[index + 1], index + 2


def binding(scope, value):
    pieces = value.split(":")
    if len(pieces) not in [2, 3] or not pieces[1].startswith("/"):
        raise ValueError("Use an explicit project bind source:absolute-container-target[:ro|rw]")

    mode = pieces[2] if len(pieces) == 3 else "rw"
    if mode not in ["ro", "rw"]:
        raise ValueError("Only ordinary read-only/read-write project binds are supported")

    source = host_path(scope, pieces[0], mode == "rw")
    return source + ":" + pieces[1] + ":" + mode


def mount(scope, value):
    fields = dict(part.split("=", 1) if "=" in part else (part, "true") for part in value.split(","))
    if fields.get("type", "bind") != "bind":
        raise ValueError("Only reviewed project bind mounts are accepted through --mount")

    if set(fields) - {"type", "source", "src", "destination", "dst", "target", "readonly", "ro"}:
        raise ValueError("Unsupported mount attributes")

    readonly = "readonly" in fields or "ro" in fields
    if not fields.get("source", fields.get("src")):
        raise ValueError("Bind mounts require an explicit reviewed source")
    source = host_path(scope, fields.get("source", fields.get("src", "")), not readonly)
    target = fields.get("target", fields.get("destination", fields.get("dst", "")))
    if not target.startswith("/") or any(character in source + target for character in [",", "\n"]):
        raise ValueError("Invalid bind mount target")

    return "type=bind,src=" + source + ",dst=" + target + (",readonly" if readonly else "")


def published_port(value, connected):
    if not connected or not re.fullmatch(r"127\.0\.0\.1:\d{1,5}:\d{1,5}(?:/tcp|/udp)?", value):
        raise ValueError("Published ports require network host approval and explicit 127.0.0.1:host:container binding")

    ports = value.split(":")[1:]
    if any(not 1 <= int(port.split("/")[0]) <= 65535 for port in ports):
        raise ValueError("Invalid published TCP/UDP port")

    return value


def literal_environment(value):
    key, equal, _value = value.partition("=")
    if not equal or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        raise ValueError("Container environment requires literal KEY=value; host environment forwarding is excluded")

    return value


def own_name(job, name):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", name):
        raise ValueError("Invalid logical container name")

    return "pi-" + job + "-" + name


def run_command(arguments, job, scope, connected, limits, aliases):
    result, index, named, user, mounts, detached = ["run"], 1, False, False, [], False
    while index < len(arguments) and arguments[index].startswith("-"):
        name, value, index = option(arguments, index, RUN_VALUES, RUN_FLAGS)
        if value is None:
            if name in ["--detach", "-d"]:
                detached = True
            elif name != "--rm":
                result.append(name)
            continue

        if name == "--name":
            if value in aliases:
                raise ValueError("Each container needs a unique logical name within the job")
            aliases[value] = own_name(job, value)
            value, named = aliases[value], True
        elif name in ["--user", "-u"]:
            user = True
        elif name in ["--env", "-e"]:
            value = literal_environment(value)
        elif name in ["--label", "-l"] and value.split("=", 1)[0].startswith("io.pi."):
            raise ValueError("Engine ownership labels are reserved")
        elif name in ["--volume", "-v"]:
            value = binding(scope, value)
            source, target, mode = value.split(":")
            mounts.append({"source": source, "target": target, "readOnly": mode == "ro"})
            continue
        elif name == "--mount":
            value = mount(scope, value)
            fields = dict(part.split("=", 1) if "=" in part else (part, "true") for part in value.split(","))
            mounts.append({"source": fields["src"], "target": fields["dst"], "readOnly": "readonly" in fields})
            continue
        elif name in ["--publish", "-p"]:
            value = published_port(value, connected)
        elif name in ["--network", "--net"]:
            if value not in ["none", "bridge"] or (value == "bridge" and not connected):
                raise ValueError("Only offline or connected job networking is supported")
            continue
        elif name in ["--memory", "-m", "--cpus", "--pids-limit"]:
            raise ValueError("Supply workload budgets through sandbox.limits, not duplicate CLI flags")

        result += [name, value]

    if index >= len(arguments) or arguments[index] == "-":
        raise ValueError("Container run requires an image and argv, without host stdin")

    if not named:
        result += ["--name", own_name(job, "run-" + str(len(aliases)))]
    if not user:
        result += ["--user", str(scope["uid"]) + ":" + str(scope["gid"])]

    result += ["--label", OWNER + "=" + job, "--network", "bridge" if connected else "none"]
    result += ["--memory", str(limits["memoryMiB"]) + "m", "--memory-swap", str(limits["memoryMiB"]) + "m", "--cpus", str(limits["cpus"]), "--pids-limit", str(limits["pids"])]
    result += ["--env", "HOME=/tmp/pi-home"]
    image_reference(arguments[index])
    return {"argv": result + arguments[index:], "mounts": mounts, "imageIndex": len(result), "detached": detached}


def resource_limits(request, count):
    supplied = request.get("limits", {})
    if "tmpBytes" in supplied:
        raise ValueError("The engine cannot guarantee an aggregate temporary-storage cap; required limits cannot be dropped")
    values = {"memoryMiB": 2048, "cpus": 2, "pids": 256, **supplied}
    for key, minimum, maximum in [("memoryMiB", 64, 65536), ("cpus", 0.1, 64), ("pids", 16, 65536)]:
        value = values[key]
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not minimum <= value <= maximum:
            raise ValueError("Invalid container workload budget: " + key)

    if not count:
        if any(key in supplied for key in ["memoryMiB", "cpus", "pids", "tmpBytes"]):
            raise ValueError("Engine metadata/preparation has no private workload cgroup; required aggregate quotas cannot be applied")
        return values

    values["memoryMiB"] = int(values["memoryMiB"] // count)
    values["cpus"] = math.floor(values["cpus"] / count * 100000) / 100000
    values["pids"] = int(values["pids"] // count)
    if values["memoryMiB"] < 6 or values["cpus"] < 0.01 or values["pids"] < 1:
        raise ValueError("Budget is too small for the job's maximum container count")

    if "tmpBytes" in values:
        values["tmpBytes"] = int(values["tmpBytes"] // count)
    return values


def scoped_target(arguments, aliases, verb):
    if len(arguments) < 2:
        raise ValueError("Container operation requires a job-owned logical name")

    index, result = 1, [verb]
    if verb == "exec":
        while index < len(arguments) and arguments[index].startswith("-"):
            name, value, index = option(arguments, index, {"--user", "-u", "--workdir", "-w", "--env", "-e"}, {"-i"})
            if name == "-i":
                raise ValueError("Interactive host input is unavailable; supply complete container argv")
            if name in ["--env", "-e"]:
                literal_environment(value)
            result += [name, value]

    if index >= len(arguments) or arguments[index] not in aliases:
        raise ValueError("Mutating/inspecting existing containers is excluded; use this batch's own logical names")

    result.append(aliases[arguments[index]])
    if verb == "exec":
        if index + 1 == len(arguments):
            raise ValueError("Container exec requires an explicit command")
        result += arguments[index + 1:]
    elif index + 1 != len(arguments):
        raise ValueError("Use one explicit owned container target per operation")

    return result


def image_reference(value):
    transports = {"dir", "docker", "docker-archive", "oci", "oci-archive", "containers-storage", "ostree", "sif"}
    if value.partition(":")[0] in transports:
        raise ValueError("Host image/archive transports are excluded; use a registry image or cached image ID")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*(?::[0-9]{1,5})?(?:/[a-z0-9][a-z0-9_.-]*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-fA-F0-9]{64})?", value):
        raise ValueError("Use an ordinary registry image reference or cached image ID")
    return value


def metadata_command(arguments):
    if arguments in [["--version"], ["--help"]]:
        return arguments
    verb, start = arguments[0], 1
    if verb in ["version", "info", "ps", "images"]:
        pass
    elif len(arguments) > 1 and arguments[:2] in [
        ["compose", "version"], ["image", "ls"], ["image", "inspect"], ["image", "history"],
        ["container", "ls"], ["network", "ls"], ["volume", "ls"],
    ]:
        verb, start = " ".join(arguments[:2]), 2
    else:
        return None
    values, flags = {"--format", "-f"}, {"--help"}
    if verb in ["ps", "images", "image ls", "container ls", "network ls", "volume ls"]:
        values |= {"--filter"}
        if verb not in ["network ls", "volume ls"]:
            values |= {"-f"}
        flags |= {"--all", "-a", "--quiet", "-q", "--no-trunc", "--digests"}
    if verb in ["ps", "container ls"]:
        values |= {"--last", "-n"}
        flags |= {"--size", "-s", "--latest", "-l"}
    if verb == "image history":
        flags |= {"--quiet", "-q", "--no-trunc", "--human", "-H"}
    if verb == "compose version":
        values, flags = set(), {"--short", "--help"}
    result, index = arguments[:start], start
    while index < len(arguments):
        if arguments[index].startswith("-"):
            name, value, index = option(arguments, index, values, flags)
            result += [name + "=" + value] if value is not None else [name]
        elif verb in ["image inspect", "image history", "images", "image ls"]:
            result.append(image_reference(arguments[index]))
            index += 1
        else:
            raise ValueError("Unexpected metadata argument")
    return result


def prepare_job(request):
    job = request["job"]
    if str(uuid.UUID(job)) != job:
        raise ValueError("Invalid engine job identity")

    commands = request["commands"]
    if not isinstance(commands, list) or not 1 <= len(commands) <= 16:
        raise ValueError("A container job needs one to sixteen complete argv commands")
    if any(not isinstance(argv, list) or not argv or len(argv) > 96 or
           any(not isinstance(value, str) or "\x00" in value or len(value) > 16384 for value in argv)
           for argv in commands):
        raise ValueError("Invalid container argv")

    scope, connected = request["workspace"], request.get("network") == "host"
    if request.get("network", "none") not in ["none", "host"]:
        raise ValueError("Invalid engine network mode")
    for root in scope["bindings"]:
        host_path(scope, root)
    for key, value in request.get("environment", {}).items():
        literal_environment(key + "=" + value)
    count = sum(1 for argv in commands if argv[0] == "run")
    count += len({name for item in request.get("compose", {}).values()
                  if item["arguments"][0] not in ["config", "version"]
                  for name in item["config"].get("services", {})})
    limits = resource_limits(request, count)
    aliases, normalized = {}, []
    for index, arguments in enumerate(commands):
        metadata = metadata_command(arguments)
        if metadata is not None:
            normalized.append({"kind": "metadata", "argv": metadata})
        elif arguments[0] == "run":
            if not any(value == "--name" or value.startswith("--name=") for value in arguments):
                arguments = ["run", "--name", "run-" + str(index), *arguments[1:]]
            normalized.append({"kind": "run", **run_command(arguments, job, scope, connected, limits, aliases)})
        elif arguments[0] == "build":
            raise ValueError("Daemon image builds lack verified aggregate quotas; run build/test commands in a budgeted SDK container")
        elif arguments[0] == "pull":
            if not connected or len(arguments) != 2 or arguments[1].startswith("-"):
                raise ValueError("Image pull requires one image and explicit network host approval")
            image_reference(arguments[1])
            normalized.append({"kind": "pull", "argv": arguments})
        elif arguments[0] in ["exec", "logs", "inspect", "stop", "rm", "wait"]:
            normalized.append({"kind": "owned", "argv": scoped_target(arguments, aliases, arguments[0])})
        elif arguments[0] == "compose":
            from .compose import prepare_compose
            manifest = request.get("compose", {}).get(str(index))
            if not manifest:
                raise ValueError("Compose requires the gate's frozen, scoped configuration")
            normalized.append(prepare_compose(manifest, request, limits))
        else:
            raise ValueError("This engine operation is not a bounded project job; host/machine/system administration is excluded")

    return {"commands": normalized, "workloadCount": count, "perContainerLimits": limits}
