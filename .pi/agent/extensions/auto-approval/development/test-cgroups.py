"""Exercise real kernel controllers in a disposable Podman container, never the running box."""

import argparse
import os
from pathlib import Path
import subprocess
import uuid


def checked(engine, *arguments, timeout=30):
    result = subprocess.run(
        [engine, *arguments], timeout=timeout,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if result.returncode:
        raise RuntimeError(f"{arguments[0]} failed ({result.returncode}): {result.stderr[:4000]}")

    return result.stdout


def validate(args):
    extension = Path(__file__).resolve().parent.parent
    extensions = extension.parent
    lubox = Path.home() / ".local/bin/lubox"
    name = "pi-cgroup-test-" + uuid.uuid4().hex
    image = checked(args.engine, "image", "inspect", "--format", "{{.Id}}", args.image).strip()
    uid, gid = str(os.getuid()), str(os.getgid())
    mounts = [
        f"type=bind,src={extensions},dst=/opt/pi-test/extensions,readonly",
        f"type=bind,src={Path(args.bun).resolve()},dst=/usr/local/bin/bun,readonly",
        f"type=bind,src={lubox},dst=/opt/pi-test/lubox,readonly",
    ]
    command = [
        "run", "--detach", "--pull", "never", "--name", name,
        "--network", "none", "--security-opt", "no-new-privileges",
        "--security-opt", "label=disable",
        "--security-opt", "unmask=/proc:/proc/*", "--cgroupns", "private",
        "--systemd", "always", "--userns", "keep-id", "--user", f"{uid}:{gid}",
        "--memory", "1g", "--cpus", "2", "--pids-limit", "512",
    ]
    for mount in mounts:
        command.extend(["--mount", mount])

    command.extend(["--entrypoint", "/bin/sh", image, "-c", "sleep 180"])
    try:
        checked(args.engine, *command)
        print(checked(args.engine, "exec", "--user", "0:0", name,
                      "python3", "/opt/pi-test/lubox", "__container-cgroups", uid, gid), flush=True)
        checked(args.engine, "stop", "--time", "1", name)
        checked(args.engine, "start", name)
        print(checked(args.engine, "exec", "--user", "0:0", name,
                      "python3", "/opt/pi-test/lubox", "__container-cgroups", uid, gid), flush=True)
        result = subprocess.run([
            args.engine, "exec", "--user", f"{uid}:{gid}",
            "--env", "HOME=/tmp", "--env", "PI_CGROUP_TEST_ROOT=/sys/fs/cgroup/pi-actions",
            "--workdir", "/opt/pi-test/extensions/auto-approval", name,
            "/usr/local/bin/bun", "test", "--timeout", "30000",
            "tests/cgroups-native.test.ts", "tests/cgroup-boundary.test.ts",
        ], timeout=150)
        if result.returncode:
            raise RuntimeError(f"Disposable controller validation failed ({result.returncode})")
    finally:
        checked(args.engine, "rm", "--force", name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", default="podman")
    parser.add_argument("--image", required=True, help="Existing local Lubox image; no pull")
    parser.add_argument("--bun", required=True, help="Native Linux Bun executable, not its launcher")
    validate(parser.parse_args())
