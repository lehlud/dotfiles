"""One approved batch owns its containers; failures never turn into global engine cleanup."""
import json
import os
import pathlib
import shutil
import signal
import time
import tempfile
from .policy import OWNER
from .processes import capture, clean_environment
from .output import WorkloadOutput
from .workloads import projected_mounts, read_json, require_controls, verified_container


def private_client(directory, environment):
    """Preserve native connection/login data privately, excluding automatic payload proxies/plugins."""
    source = pathlib.Path(environment["HOME"]) / ".docker"
    target = directory / "docker"
    target.mkdir(mode=0o700)
    if (source / "config.json").is_file():
        metadata = (source / "config.json").lstat()
        if (source / "config.json").is_symlink() or metadata.st_size > 1048576:
            raise ValueError("Private Docker configuration must be a bounded regular file")
        data = json.loads((source / "config.json").read_text())
        data.pop("proxies", None)
        data.pop("cliPluginsExtraDirs", None)
        (target / "config.json").write_text(json.dumps(data))
    contexts = source / "contexts"
    if contexts.is_dir():
        total = 0
        for path in contexts.rglob("*"):
            if path.is_symlink():
                raise ValueError("Docker context copies cannot contain symlinks")
            relative = path.relative_to(source)
            destination = target / relative
            if path.is_dir():
                destination.mkdir(mode=0o700, parents=True, exist_ok=True)
            elif path.is_file():
                total += path.stat().st_size
                if total > 8388608:
                    raise ValueError("Private engine context exceeds its copy bound")
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
                destination.chmod(0o600)
    environment["DOCKER_CONFIG"] = str(target)
    override = directory / "containers.conf"
    override.write_text('[containers]\nenv=[]\nenv_host=false\nhttp_proxy=false\n[engine]\nhooks_dir=[]\n')
    environment["CONTAINERS_CONF_OVERRIDE"] = str(override)


def job_directory(job):
    root = pathlib.Path.home() / ".local" / "cache" / "pi-container-tools" / "jobs"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root / job


def cancellation_path(job):
    root = job_directory(job).parent / "cancelled"
    root.mkdir(mode=0o700, exist_ok=True)
    for entry in root.iterdir():
        if entry.is_file() and time.time() - entry.stat().st_mtime > 90000:
            entry.unlink(missing_ok=True)
    return root / job


def cleanup(engine, job, environment, cwd):
    """The random ownership label is the only deletion selector; never names supplied by a model."""
    result = capture(engine, ["ps", "--all", "--filter", "label=" + OWNER + "=" + job, "--format", "{{.ID}}"], environment, cwd)
    if result["exitCode"]:
        raise ValueError("Owned container cleanup could not query the engine")
    for target in result["stdout"].split():
        state = read_json(engine, ["container", "inspect", target], environment, cwd)[0]
        if (state.get("Config", {}).get("Labels") or {}).get(OWNER) != job:
            raise ValueError("Container ownership changed during cleanup")
        removed = capture(engine, ["rm", "--force", "--volumes", target], environment, cwd)
        if removed["exitCode"]:
            raise ValueError("Owned container cleanup failed")
    for category in ["network", "volume"]:
        found = capture(engine, [category, "ls", "--filter", "label=com.docker.compose.project=pi-" + job, "--format", "{{.Name}}"], environment, cwd)
        if found["exitCode"]:
            raise ValueError("Owned Compose resource cleanup could not query the engine")
        for name in found["stdout"].split():
            removed = capture(engine, [category, "rm", name], environment, cwd)
            if removed["exitCode"]:
                raise ValueError("Owned Compose resource cleanup failed")


def compose_provider(engine, environment):
    if engine.name != "podman":
        return
    candidates = [
        "/usr/libexec/docker/cli-plugins/docker-compose",
        "/usr/local/lib/docker/cli-plugins/docker-compose",
        "/usr/bin/docker-compose", "/usr/local/bin/docker-compose",
        "/usr/bin/podman-compose", "/usr/local/bin/podman-compose",
        "/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose",
    ]
    for name in candidates:
        path = pathlib.Path(name)
        if path.is_file() and os.access(path, os.X_OK) and not path.stat().st_mode & 0o022:
            environment["PODMAN_COMPOSE_PROVIDER"] = str(path.resolve())
            return
    raise ValueError("A trusted system Compose provider is missing; install one outside Pi, without exposing its engine socket")


class Job:
    def __init__(self, engine, request, plan):
        self.engine, self.request, self.plan = engine, request, plan
        self.directory = job_directory(request["job"])
        self.directory.mkdir(mode=0o700)
        self.environment = clean_environment()
        self.cwd = request["workspace"]["cwd"]
        self.output = WorkloadOutput(request.get("limits", {}).get("maxOutputBytes", 1048576))
        self.deadline = time.monotonic() + request.get("limits", {}).get("executionTimeoutMs", 120000) / 1000
        self.results = []
        self.mutated = False
        self.rootless = False
        try:
            private_client(self.directory, self.environment)
        except BaseException:
            shutil.rmtree(self.directory)
            raise

    def call(self, arguments, control=False):
        if cancellation_path(self.request["job"]).exists():
            raise InterruptedError("Container job cancelled; no automatic replay")
        timeout = min(15 if control else 82800, max(0.01, self.deadline - time.monotonic()))
        result = capture(self.engine, arguments, self.environment, self.cwd, timeout,
                         output=None if control else self.output)
        if cancellation_path(self.request["job"]).exists():
            raise InterruptedError("Container job cancelled during engine operation")
        return result

    def run(self, command, index):
        argv = command["argv"]
        position = command["imageIndex"]
        flags = argv[1:position]
        self.mutated = True
        cidfile = self.directory / ("container-" + str(index))
        flags += projected_mounts(self.request["workspace"], self.directory, command.get("mounts", []))
        flags += ["--cidfile", str(cidfile), "--security-opt", "no-new-privileges"]
        if self.request["workspace"]["bindings"] and not any(flag in flags for flag in ["-w", "--workdir"]):
            flags += ["--workdir", self.cwd]
        for key, value in self.request.get("environment", {}).items():
            flags += ["--env", key + "=" + value]
        if self.engine.name == "podman":
            if self.rootless:
                flags += ["--userns=keep-id"]
            flags += ["--http-proxy=false", "--env-host=false", "--security-opt", "label=disable"]
        if "tmpBytes" in self.plan["perContainerLimits"]:
            flags += ["--tmpfs", "/tmp:rw,mode=1777,size=" + str(self.plan["perContainerLimits"]["tmpBytes"])]
        flags += ["--pull", "missing" if self.request.get("network") == "host" else "never"]
        created = self.call(["create", *flags, *argv[position:]])
        if created["exitCode"]:
            return created
        target = cidfile.read_text().strip()
        target = verified_container(self.engine, target, self.request["job"], self.plan["perContainerLimits"], self.environment, self.cwd, self.request["workspace"])
        result = self.call(["start", *([] if command["detached"] else ["--attach"]), target])
        return result

    def compose(self, command, index):
        compose_provider(self.engine, self.environment)
        path = self.directory / ("compose-" + str(index) + ".json")
        config = json.loads(json.dumps(command["config"]))
        if self.engine.name == "podman" and self.rootless:
            for service in config["services"].values():
                service["userns_mode"] = "keep-id"
        path.write_text(json.dumps(config))
        empty = self.directory / "empty.env"
        empty.touch(mode=0o600, exist_ok=True)
        prefix = ["compose", "--file", str(path), "--project-directory", self.cwd,
                  "--project-name", "pi-" + self.request["job"], "--env-file", str(empty)]
        arguments = command["arguments"]
        if arguments[0] in ["up", "start", "restart", "pull"]:
            self.mutated = True
        if arguments[0] == "up":
            prepared = self.call([*prefix, "create", "--no-build"])
            if prepared["exitCode"]:
                return prepared
        if arguments[0] in ["up", "start", "restart", "exec"]:
            containers = self.call([*prefix, "ps", "--all", "--quiet"], True)
            if containers["exitCode"]:
                return containers
            if not containers["stdout"].split():
                raise ValueError("Start the job's declared Compose services before using them")
            for target in containers["stdout"].split():
                verified_container(self.engine, target, self.request["job"], self.plan["perContainerLimits"], self.environment, self.cwd, self.request["workspace"])
        return self.call([*prefix, *arguments])

    def owned(self, arguments):
        # Resolve the reserved name once, then pass its immutable ID to the native CLI.
        aliases = [value for value in arguments[1:] if value.startswith("pi-" + self.request["job"] + "-")]
        if len(aliases) != 1:
            raise ValueError("Ambiguous owned container target")
        target = verified_container(self.engine, aliases[0], self.request["job"], self.plan["perContainerLimits"], self.environment, self.cwd, self.request["workspace"])
        argv = [target if value == aliases[0] else value for value in arguments]
        return self.call(argv)

    def execute(self):
        if self.plan["workloadCount"]:
            self.rootless = require_controls(self.engine, self.environment, self.cwd)
        for index, command in enumerate(self.plan["commands"]):
            if command["kind"] == "run":
                result = self.run(command, index)
            elif command["kind"] == "compose":
                result = self.compose(command, index)
            elif command["kind"] == "owned":
                result = self.owned(command["argv"])
            else:
                argv = command["argv"]
                if argv[:2] == ["compose", "version"]:
                    compose_provider(self.engine, self.environment)
                result = self.call(argv)
            self.output.append((result["stdout"] + result["stderr"]).encode())
            self.results.append(result)
            if result["exitCode"]:
                break
        output, output_details = self.output.finish()
        status = self.results[-1]["exitCode"] if self.results else 0
        return {"content": [{"type": "text", "text": output}], "isError": bool(status),
                "details": {"exitCode": status, "commands": len(self.results), **output_details}}

    def close(self):
        if self.mutated:
            cleanup(self.engine, self.request["job"], self.environment, self.cwd)
        shutil.rmtree(self.directory)


def execute_job(engine, request, plan):
    job = None
    signals = [signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGALRM]

    def interrupted(_signal, _frame):
        raise InterruptedError("Container job interrupted; no automatic replay")

    for number in signals:
        signal.signal(number, interrupted)
    signal.alarm(max(1, int(request.get("limits", {}).get("executionTimeoutMs", 120000) / 1000)))
    try:
        if cancellation_path(request["job"]).exists():
            raise InterruptedError("Container job was cancelled before dispatch")
        job = Job(engine, request, plan)
        return job.execute()
    finally:
        signal.alarm(0)
        for number in signals:
            signal.signal(number, signal.SIG_IGN)
        if job is not None:
            job.close()


def cancel_job(engine, request):
    """A tombstone also stops an in-flight create before it can start a late workload."""
    marker = cancellation_path(request["job"])
    marker.touch(mode=0o600, exist_ok=True)
    environment = clean_environment()
    with tempfile.TemporaryDirectory(prefix="pi-engine-cancel-") as temporary:
        private_client(pathlib.Path(temporary), environment)
        cleanup(engine, request["job"], environment, str(pathlib.Path.home()))
    return {"cancelled": True, "job": request["job"]}
