"""Offline Podman migration: preserve the source until a checked replacement exists."""

import copy
import secrets


class MigrationError(RuntimeError):
    pass


# Replay only explicit values; files and implicit host environment are not snapshots.
VALUE_OPTIONS = {
    "--name", "--hostname", "--label", "--env", "--mount", "--volume", "-v",
    "--device", "--workdir", "--secret", "--userns", "--user", "--group-add",
    "--network", "--security-opt", "--cap-add", "--cap-drop", "--systemd",
    "--cgroupns", "--memory", "--memory-swap", "--cpus", "--pids-limit",
    "--tmpfs", "--publish", "-p", "--entrypoint", "--restart", "--ulimit",
    "--stop-timeout", "--stop-signal", "--shm-size", "--log-driver", "--log-opt", "--pull",
}
MOUNT_FIELDS = (
    "Type", "Name", "Source", "Destination", "Driver", "Mode", "Options", "RW", "Propagation",
)


def creation_options(info):
    config = info.get("Config") or {}
    command = config.get("CreateCommand")
    payload = config.get("Cmd")
    if (
        not isinstance(command, list) or len(command) < 3
        or not all(isinstance(arg, str) for arg in command)
        or command[1] != "create" or not isinstance(payload, list) or not payload
        or not all(isinstance(arg, str) for arg in payload)
    ):
        raise MigrationError("Missing supported Podman create record; refusing to guess configuration")

    image_index = len(command) - len(payload) - 1
    images = {str(info.get("ImageName", "")), str(config.get("Image", "")), str(info.get("Image", ""))}
    image_names = {image.removeprefix("localhost/") for image in images}
    if (
        image_index < 2 or command[image_index + 1:] != payload
        or command[image_index].removeprefix("localhost/") not in image_names
    ):
        raise MigrationError("Create record does not match the inspected image and command")

    result = []
    index = 2
    while index < image_index:
        option, separator, value = command[index].partition("=")
        if option not in VALUE_OPTIONS:
            raise MigrationError("Unsupported create option; refusing an incomplete migration")

        index += 1
        if not separator:
            if index >= image_index:
                raise MigrationError("Incomplete create option")

            value = command[index]
            index += 1

        if option == "--env" and "=" not in value:
            raise MigrationError("Implicit host environment cannot be replayed safely")

        result.append((option, value))

    return result, payload


def replacement_arguments(info, image, candidate, cgroup_limits):
    host = info.get("HostConfig") or {}
    if host.get("Privileged") or host.get("AutoRemove"):
        raise MigrationError("Privileged or auto-removing containers cannot be migrated")

    options, payload = creation_options(info)
    args = ["create", "--pull=never", "--name", candidate]
    for option, value in options:
        if option in {"--name", "--pull", "--env", "--ulimit", "--stop-signal"}:
            continue

        if option == "--cap-add":
            if value.upper().removeprefix("CAP_") != "NET_RAW":
                raise MigrationError("Explicit non-root capabilities are incompatible with unprivileged bwrap")

            continue

        feature_labels = {"dev.lubox.bwrap", "dev.lubox.cgroup_limits"}
        if option == "--label" and value.split("=", 1)[0] in feature_labels:
            if value.startswith("dev.lubox.bwrap=") or cgroup_limits:
                continue

        if cgroup_limits and option in {"--systemd", "--cgroupns"}:
            continue

        args.extend([option, value])

    args.extend(frozen_runtime_options(info))
    args.extend(["--security-opt", "unmask=/proc:/proc/*", "--label", "dev.lubox.bwrap=true"])
    if cgroup_limits:
        args.extend(["--systemd=always", "--cgroupns=private", "--label", "dev.lubox.cgroup_limits=true"])

    return args + [image] + payload


def frozen_runtime_options(info):
    """Pin effective values, including defaults materialized during the first start."""
    config = info.get("Config") or {}
    args = []
    for entry in config.get("Env") or []:
        args.extend(["--env", entry])

    if config.get("StopSignal"):
        args.extend(["--stop-signal", config["StopSignal"]])

    for limit in (info.get("HostConfig") or {}).get("Ulimits") or []:
        name = limit["Name"].removeprefix("RLIMIT_").lower()
        args.extend(["--ulimit", f'{name}={limit["Soft"]}:{limit["Hard"]}'])

    return args


def without_runtime_annotations(annotations):
    result = dict(annotations or {})
    # OCI runtime emits these on start from the separately checked stop settings.
    for key in (
        "io.container.manager", "org.opencontainers.image.stopSignal",
        "org.systemd.property.KillSignal", "org.systemd.property.TimeoutStopUSec",
    ):
        result.pop(key, None)

    return result


def preserved_configuration(info):
    config = copy.deepcopy(info.get("Config") or {})
    for key in ("CreateCommand", "Image", "SystemdMode"):
        config.pop(key, None)

    labels = config.get("Labels") or {}
    for key in ("dev.lubox.bwrap", "dev.lubox.cgroup_limits"):
        labels.pop(key, None)

    config["Labels"] = labels
    config["Env"] = sorted(config.get("Env") or [])
    config["Annotations"] = without_runtime_annotations(config.get("Annotations"))
    host = copy.deepcopy(info.get("HostConfig") or {})
    host["Annotations"] = without_runtime_annotations(host.get("Annotations"))
    for key in ("CgroupMode", "SecurityOpt"):
        host.pop(key, None)

    # Podman regenerates the log location for each container identity.
    if isinstance(host.get("LogConfig"), dict):
        host["LogConfig"].pop("Path", None)

    if host.get("Binds"):
        host["Binds"] = sorted(host["Binds"])

    if host.get("Ulimits"):
        host["Ulimits"] = sorted(host["Ulimits"], key=lambda limit: limit["Name"])

    host["CapAdd"] = [
        cap for cap in host.get("CapAdd") or [] if cap.removeprefix("CAP_") != "NET_RAW"
    ]
    mounts = [
        {key: mount.get(key) for key in MOUNT_FIELDS}
        for mount in info.get("Mounts") or []
    ]
    mounts.sort(key=lambda mount: mount["Destination"])
    return {"Config": config, "HostConfig": host, "Mounts": mounts}


def verify_replacement(source, replacement, cgroup_limits):
    expected = preserved_configuration(source)
    actual = preserved_configuration(replacement)
    differences = []
    for section in expected:
        if section == "Mounts":
            if expected[section] != actual[section]:
                differences.append(section)

            continue

        for key in expected[section].keys() | actual[section].keys():
            if expected[section].get(key) != actual[section].get(key):
                differences.append(f"{section}.{key}")

    if differences:
        fields = ", ".join(sorted(differences))
        raise MigrationError(f"Replacement differs in {fields}; original remains unchanged")

    labels = (replacement.get("Config") or {}).get("Labels") or {}
    previous_labels = (source.get("Config") or {}).get("Labels") or {}
    expected_limits = "true" if cgroup_limits else previous_labels.get("dev.lubox.cgroup_limits")
    if labels.get("dev.lubox.bwrap") != "true" or labels.get("dev.lubox.cgroup_limits") != expected_limits:
        raise MigrationError("Replacement feature labels differ from the requested change")

    host = replacement.get("HostConfig") or {}
    if any(cap.removeprefix("CAP_") == "NET_RAW" for cap in host.get("CapAdd") or []):
        raise MigrationError("Replacement retains an explicit non-root NET_RAW capability")

    security = host.get("SecurityOpt") or []
    original_security = (source.get("HostConfig") or {}).get("SecurityOpt") or []
    # Podman omits unmask directives from SecurityOpt; compare all retained policies.
    expected_security = {value for value in original_security if not value.startswith("unmask=")}
    actual_security = {value for value in security if not value.startswith("unmask=")}
    if actual_security != expected_security:
        raise MigrationError("Replacement security options differ from the requested bwrap change")

    expected_namespace = "private" if cgroup_limits else (source.get("HostConfig") or {}).get("CgroupMode")
    if host.get("CgroupMode") != expected_namespace:
        raise MigrationError("Replacement cgroup namespace differs from the requested change")

    expected_systemd = True if cgroup_limits else (source.get("Config") or {}).get("SystemdMode")
    if (replacement.get("Config") or {}).get("SystemdMode") != expected_systemd:
        raise MigrationError("Replacement systemd mount preparation differs from the requested change")


def stopped_source(manager, name, identity):
    info = manager.require_container(name)
    if info.get("Id") != identity or manager.running_from_info(info):
        raise MigrationError("Source identity or stopped state changed; no automatic stop is permitted")

    return info


def create_replacement(manager, source, name, snapshot, candidate, cgroup_limits):
    identity = source["Id"]
    stopped_source(manager, name, identity)
    manager.engine.run(["commit", "--pause=false", identity, snapshot])
    image = manager.engine.run(["image", "inspect", "--format", "{{.Id}}", snapshot]).stdout.strip()
    digest = image.removeprefix("sha256:")
    if len(digest) != 64 or not all(char in "0123456789abcdef" for char in digest):
        raise MigrationError("Snapshot image identity is invalid; source remains unchanged")

    stopped_source(manager, name, identity)
    arguments = replacement_arguments(source, image, candidate, cgroup_limits)
    try:
        manager.engine.run(arguments)
    except Exception:
        raise MigrationError("Replacement creation failed; source and snapshot are retained") from None

    replacement = manager.engine.inspect_container(candidate, required=True)
    if (
        not replacement or manager.running_from_info(replacement)
        or replacement.get("State", {}).get("Status") != "created"
    ):
        raise MigrationError("Replacement must exist and remain unstarted")

    verify_replacement(source, replacement, cgroup_limits)
    return replacement["Id"]


def switch_names(manager, name, identity, replacement, backup):
    source = stopped_source(manager, name, identity)
    candidate = manager.engine.inspect_container(replacement, required=True)
    if (
        not candidate or candidate.get("Id") != replacement
        or manager.running_from_info(candidate)
        or candidate.get("State", {}).get("Status") != "created"
    ):
        raise MigrationError("Replacement identity or stopped state changed before the name switch")

    cname = source.get("Name", "").lstrip("/")
    if not cname:
        raise MigrationError("Source container name is unavailable")

    manager.engine.run(["rename", identity, backup])
    try:
        manager.engine.run(["rename", replacement, cname])
    except Exception:
        if manager.engine.inspect_container(cname, required=False) is None:
            manager.engine.run(["rename", identity, cname])

        raise MigrationError("Name switch failed; original and replacement are retained") from None


def reconfigure(manager, name, cgroup_limits):
    source = manager.require_container(name)
    labels = manager.labels_from_info(source)
    if labels.get("dev.lubox") != "1" or labels.get("dev.lubox.name") != name:
        raise MigrationError("Only the matching Lubox-managed container can be migrated")

    status = source.get("State", {}).get("Status")
    if manager.running_from_info(source) or status not in {"exited", "created"}:
        raise MigrationError(
            "Save sessions and stop this container from the host before reconfiguring; nothing was stopped"
        )

    nonce = secrets.token_hex(4)
    cname = source.get("Name", "").lstrip("/")
    candidate = f"{cname}-reconfigure-{nonce}"
    backup = f"{cname}-before-reconfigure-{nonce}"
    snapshot = f"lubox/{name}:before-reconfigure-{nonce}"
    # Reject unsupported configuration before creating even the snapshot.
    replacement_arguments(source, snapshot, candidate, cgroup_limits)
    print(f"lubox: source remains stopped; snapshot {snapshot}; replacement {candidate}", flush=True)
    replacement = create_replacement(manager, source, name, snapshot, candidate, cgroup_limits)
    switch_names(manager, name, source["Id"], replacement, backup)
    print(f"lubox: original stopped container retained as {backup}")
    print(f"lubox: filesystem snapshot retained as {snapshot}")
    print(f"lubox: replacement remains stopped; run `lubox start {name} --engine podman` from the host")
