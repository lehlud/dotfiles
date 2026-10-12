"""Operator startup installs wheels into an immutable platform/ABI-specific cache."""

import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import venv


def prepare():
    if sys.platform != "linux":
        raise RuntimeError("Run Pi web-research setup inside the Linux Lubox container")

    arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())

    if not arch:
        raise RuntimeError("Unsupported Python CPU architecture")

    source = Path(__file__).resolve().parent
    requirements = source / "requirements.txt"
    fingerprint = hashlib.sha256(requirements.read_bytes() + sys.version.encode()).hexdigest()
    base = Path.home() / ".local/cache/pi-web-research" / f"linux-{arch}"
    target = base / fingerprint

    base.mkdir(parents=True, exist_ok=True)

    if not (target / ".ready").is_file():
        with tempfile.TemporaryDirectory(prefix=".setup-", dir=base) as temporary:
            staging = Path(temporary)

            venv.create(staging / "venv", with_pip=True)
            subprocess.run([str(staging / "venv/bin/python"), "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", "--only-binary=:all:", "--target", str(staging / "dependencies"), "-r", str(requirements)], check=True)
            (staging / "dependencies/.ready").write_text(fingerprint)

            if not target.exists():
                (staging / "dependencies").rename(target)

    manifest = base / f".runtime-{os.getpid()}.json"

    manifest.write_text(json.dumps({"dependencies": str(target), "python": sys.version}))
    manifest.replace(base / "runtime.json")


if __name__ == "__main__":
    prepare()
