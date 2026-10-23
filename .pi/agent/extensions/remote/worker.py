"""Fixed remote entrypoint; assembled with the adjacent credential-free helpers."""
import json
import os
import shutil
import signal
import stat
import subprocess
import sys

from .protocol import PROTOCOL, UUID
from .processes import launch, collect, cancel, kill_group
from .commands import tool


def probe(folder):
    home = os.path.expanduser("~")
    relative = folder[2:] if folder.startswith("~/") else folder
    root = home if folder == "~" else os.path.realpath(os.path.join(home, relative))
    if not os.path.isdir(root):
        raise ValueError("Remote workspace must already be a directory")

    executable = shutil.which("bwrap")
    reason, isolated = "bwrap is not installed", False
    if executable:
        arguments = [
            executable, "--unshare-all", "--die-with-parent", "--new-session",
            "--ro-bind", "/", "/", "--", "/usr/bin/true",
        ]
        try:
            result = subprocess.run(arguments, capture_output=True, timeout=10)
            isolated = result.returncode == 0
            reason = result.stderr.decode("utf-8", "replace")[:600]
        except (OSError, subprocess.TimeoutExpired) as error:
            reason = str(error)[:600]

    return {"root": root, "system": os.uname().sysname, "sandbox": isolated, "reason": reason}


def private_session(identifier):
    if not UUID.fullmatch(identifier):
        raise ValueError("Invalid remote session identity")

    base = "/tmp/pi-remote-%s-%s" % (os.getuid(), identifier)
    for path in [base, base + "/tmp", base + "/jobs"]:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            info = os.lstat(path)
            if (
                not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o700
            ):
                raise ValueError("Remote temporary storage identity/permissions changed")

    return base


def sandbox_argv(root, temporary, read_only, network, env, code):
    args = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL"]
    for path in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]:
        if os.path.exists(path):
            args += ["--ro-bind", path, path]

    binding = "--ro-bind" if read_only else "--bind"
    args += [
        "--proc", "/proc", "--dev", "/dev", "--bind", temporary, "/tmp",
        binding, root, root, "--chdir", root, "--clearenv",
    ]
    if network == "host":
        args += ["--share-net"]

    for key, value in env.items():
        args += ["--setenv", key, value]

    return args + [sys.executable, "-I", "-B", "-c", code, "inside"]


def execution_settings(payload):
    settings = payload["request"].get("sandbox", {})
    limits = settings.get("limits", {})
    if any(key in limits for key in ["memoryMiB", "cpus", "pids", "tmpBytes"]):
        raise ValueError("Required remote aggregate quotas cannot be enforced")

    if payload["isolation"] == "confirmed-account" and settings.get("network") == "none":
        raise ValueError("Required offline execution cannot be enforced in remote-account mode")

    requested_timeout = payload["request"]["arguments"].get("timeout", 120) * 1000
    timeout = limits.get("executionTimeoutMs", requested_timeout) / 1000
    budget = limits.get("maxOutputBytes", 1048576)
    if not 0 < timeout <= 82800 or not 1024 <= budget <= 16777216:
        raise ValueError("Invalid remote time/output limits")

    if payload["isolation"] not in ["bwrap", "confirmed-account"]:
        raise ValueError("Invalid remote isolation mode")

    temporary = private_session(payload["session"]) + "/tmp"
    isolated = payload["isolation"] == "bwrap"
    os.makedirs(temporary + "/home", mode=0o700, exist_ok=True)
    home = "/tmp/home" if isolated else temporary + "/home"
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": home,
        "TMPDIR": "/tmp" if isolated else temporary, "LANG": "C.UTF-8",
    }
    env.update(settings.get("environment", {}))

    return settings, timeout, budget, temporary, isolated, env


def execute(payload, code):
    root, action = payload["root"], payload["action"]
    if os.path.realpath(root) != root or not os.path.isdir(root):
        raise ValueError("Selected remote directory changed; reconnect explicitly")

    if not UUID.fullmatch(action):
        raise ValueError("Invalid action identity")

    settings, timeout, budget, temporary, isolated, env = execution_settings(payload)
    internal = {
        **payload, "operation": "tool", "budget": budget, "timeout": timeout,
        "temporary": "/tmp" if isolated else temporary,
    }
    argv = [sys.executable, "-I", "-B", "-c", code, "inside"]
    if isolated:
        argv = sandbox_argv(
            root, temporary, payload.get("readOnly", False),
            settings.get("network", "none"), env, code,
        )

    receipt = private_session(payload["session"]) + "/jobs/" + action
    child = launch(argv, env=env, cwd=root, receipt=receipt)

    def interrupted(_signum, _frame):
        kill_group(child.pid)
        raise InterruptedError("Remote session interrupted")

    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        status, output = collect(
            child, json.dumps(internal).encode(), timeout, budget * 6 + 65536, True,
        )
        if status:
            detail = output.decode("utf-8", "replace")[:500]
            raise ValueError("Remote action failed (%s); inspect state: %s" % (status, detail))

        answer = json.loads(output)
        if answer.get("protocol") != PROTOCOL or "value" not in answer:
            raise ValueError(answer.get("error", "Invalid inner worker reply"))

        os.unlink(receipt)
        return answer["value"]
    finally:
        # Also stop background children that outlived the reviewed foreground command.
        kill_group(child.pid)


def main(payload):
    operation = payload.get("operation")
    if operation == "probe":
        return probe(payload["folder"])

    if operation == "execute":
        return execute(payload, sys.argv[1])

    if operation == "tool" and sys.argv[1] == "inside":
        return tool(payload)

    if operation == "cancel":
        return cancel(private_session(payload["session"]), payload["action"])

    if operation == "cleanup":
        base = private_session(payload["session"])
        for identifier in os.listdir(base + "/jobs"):
            cancel(base, identifier)

        shutil.rmtree(base)
        return {"cleaned": True}

    raise ValueError("Unknown remote worker operation")


def run():
    try:
        raw = sys.stdin.buffer.read(1048577)
        if len(raw) > 1048576:
            raise ValueError("Remote input limit exceeded")

        value = main(json.loads(raw))
        print(json.dumps({"protocol": PROTOCOL, "value": value}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"protocol": PROTOCOL, "error": str(error)[:1000]}))
