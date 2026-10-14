"""Select an official stable Linux archive without trusting arbitrary manifest URLs."""
import json
from pathlib import Path
import re
import sys

def select_release(manifest, architecture):
    if architecture not in ("x64", "arm64"):
        raise SystemExit(f"Unsupported Flutter Linux architecture: {architecture}")

    # A verified x64 bundle supplies Flutter source for the arm64 Dart bootstrap
    # when the release has no Linux arm64 bundle.
    candidates = (architecture, "x64") if architecture == "arm64" else (architecture,)
    stable = manifest["current_release"]["stable"]

    for candidate in candidates:
        for entry in manifest["releases"]:
            if entry["hash"] != stable:
                continue

            if entry.get("dart_sdk_arch", "x64") == candidate:
                return entry

    raise SystemExit(f"No official stable Flutter Linux SDK for {architecture}")


manifest = json.loads(Path(sys.argv[1]).read_text())
release = select_release(manifest, sys.argv[2])

archive, checksum = release["archive"], release["sha256"]

if not re.fullmatch(r"stable/linux/flutter_linux_[A-Za-z0-9._+-]+\.tar\.xz", archive):
    raise SystemExit("Invalid official Flutter archive path")

if not re.fullmatch(r"[0-9a-f]{64}", checksum):
    raise SystemExit("Invalid official Flutter archive checksum")

print(archive)
print(checksum)
