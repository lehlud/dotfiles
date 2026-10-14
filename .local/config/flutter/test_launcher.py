"""Verify real launchers without invoking a container engine or changing operator state."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class LauncherTests(unittest.TestCase):
    def run_launcher(self, name):
        launchers = Path(__file__).resolve().parents[2] / "bin"

        with tempfile.TemporaryDirectory(prefix="flutter-launcher-") as directory:
            root = Path(directory)
            sdk = root / "sdk"
            (sdk / ".git").mkdir(parents=True)
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
            result = subprocess.run(
                [str(launchers / name), "--version"],
                cwd=root,
                env={
                    "PATH": "/usr/bin:/bin",
                    "HOME": str(root),
                    "FLUTTER_SDK_DIR": str(sdk),
                    "FLUTTER_CONTAINER_RUNTIME": str(runtime),
                    "FLUTTER_CONTAINERFILE": str(Path(__file__).with_name("Containerfile")),
                    "MOCK_LOG": str(log),
                },
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)

            return [json.loads(line) for line in log.read_text().splitlines()]

    def test_flutter_retains_its_default_container_workflow(self):
        calls = self.run_launcher("flutter")

        self.assertTrue(any(call[0] == "build" for call in calls))
        self.assertEqual(calls[-1][0:2], ["run", "--rm"])
        self.assertEqual(calls[-1][-2:], ["flutter", "--version"])

    def test_dart_finds_its_sibling_launcher_with_a_private_home(self):
        calls = self.run_launcher("dart")

        self.assertEqual(calls[-1][-2:], ["dart", "--version"])


if __name__ == "__main__":
    unittest.main()
