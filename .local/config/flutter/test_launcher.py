"""Verify real launchers without invoking a container engine or changing operator state."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class LauncherTests(unittest.TestCase):
    def run_launcher(self, name, *, runs=1, legacy_key=False):
        launchers = Path(__file__).resolve().parents[2] / "bin"

        with tempfile.TemporaryDirectory(prefix="flutter-launcher-") as directory:
            root = Path(directory)
            sdk = root / "sdk"
            (sdk / ".git").mkdir(parents=True)
            host_cache = sdk / "bin/cache"
            host_cache.mkdir(parents=True)
            (host_cache / "host-artifact").write_text("arm64")
            containerfile = Path(__file__).with_name("Containerfile")
            if legacy_key:
                state = root / ".cache/flutter-container"
                state.mkdir(parents=True)
                digest = hashlib.sha256(containerfile.read_bytes()).hexdigest()
                (state / "build.key").write_text(f"{digest}\n{os.getuid()}\n{os.getgid()}\n")
                (state / "configured").touch()
            runtime = root / "podman"
            log = root / "calls.jsonl"
            runtime.write_text('''#!/usr/bin/python3
import json
import os
from pathlib import Path
import sys

with Path(os.environ["MOCK_LOG"]).open("a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
''')
            runtime.chmod(0o755)
            for _ in range(runs):
                result = subprocess.run(
                    [str(launchers / name), "--version"],
                    cwd=root,
                    env={
                        "PATH": "/usr/bin:/bin",
                        "HOME": str(root),
                        "FLUTTER_SDK_DIR": str(sdk),
                        "FLUTTER_CONTAINER_RUNTIME": str(runtime),
                        "FLUTTER_CONTAINERFILE": str(containerfile),
                        "MOCK_LOG": str(log),
                    },
                    capture_output=True,
                    text=True,
                )

                self.assertEqual(result.returncode, 0, result.stderr)

            self.assertEqual((host_cache / "host-artifact").read_text(), "arm64")

            return [json.loads(line) for line in log.read_text().splitlines()]

    def test_flutter_retains_its_default_container_workflow(self):
        calls = self.run_launcher("flutter")

        self.assertTrue(any(call[0] == "build" for call in calls))
        self.assertEqual(calls[-1][0:2], ["run", "--rm"])
        self.assertEqual(calls[-1][-2:], ["flutter", "--version"])

    def test_dart_finds_its_sibling_launcher_with_a_private_home(self):
        calls = self.run_launcher("dart")

        self.assertEqual(calls[-1][-2:], ["dart", "--version"])

    def test_legacy_image_is_rebuilt_once_and_uses_an_isolated_amd64_cache(self):
        calls = self.run_launcher("flutter", runs=2, legacy_key=True)
        builds = [call for call in calls if call[0] == "build"]
        self.assertEqual(len(builds), 1)
        runs = [call for call in calls if call[0] == "run"]
        self.assertEqual(len(runs), 3)  # Setup, first invocation, second invocation.
        for call in builds + runs:
            self.assertEqual(call[call.index("--platform") + 1], "linux/amd64")
        for call in runs:
            mounts = [call[i + 1] for i, arg in enumerate(call) if arg == "--volume"]
            self.assertTrue(any(mount.endswith(
                "/sdk-cache-linux-amd64:/home/flutter/flutter/bin/cache"
            ) for mount in mounts))


if __name__ == "__main__":
    unittest.main()
