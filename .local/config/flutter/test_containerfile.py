"""Exercise the container identity step without modifying real users or groups."""
from pathlib import Path
import subprocess
import tempfile
import unittest


class ContainerIdentityTests(unittest.TestCase):
    def run_identity(self, existing_gid):
        source = Path(__file__).with_name("Containerfile").read_text()
        step = source.split('RUN if ! getent group', 1)[1].split('\n\nUSER ', 1)[0]
        command = 'if ! getent group' + step.replace('\\\n', '')

        with tempfile.TemporaryDirectory(prefix="flutter-identity-") as directory:
            root = Path(directory)
            script = '''#!/usr/bin/python3
from pathlib import Path
import os
import sys
name = Path(sys.argv[0]).name
with open(os.environ["MOCK_LOG"], "a") as log:
    log.write(name + " " + " ".join(sys.argv[1:]) + "\\n")
if name == "getent":
    sys.exit(0 if os.environ["EXISTING_GID"] == sys.argv[-1] else 2)
'''
            for name in ["getent", "groupadd", "useradd", "chown"]:
                file = root / name
                file.write_text(script)
                file.chmod(0o755)

            log = root / "operations"
            result = subprocess.run(
                ["/bin/sh", "-c", command],
                env={
                    "PATH": str(root) + ":/usr/bin:/bin",
                    "USER_UID": "501",
                    "USER_GID": "20",
                    "USERNAME": "flutter",
                    "ANDROID_HOME": "/opt/android-sdk",
                    "EXISTING_GID": existing_gid,
                    "MOCK_LOG": str(log),
                },
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)

            return log.read_text().splitlines()

    def test_macos_gid_reuses_existing_fedora_group(self):
        calls = self.run_identity("20")

        self.assertFalse(any(call.startswith("groupadd ") for call in calls))
        self.assertIn("useradd --uid 501 --gid 20 -m flutter", calls)
        self.assertIn("chown -R 501:20 /opt/android-sdk /usr/local", calls)

    def test_absent_gid_creates_group_before_user(self):
        calls = self.run_identity("")

        self.assertEqual(calls[1], "groupadd --gid 20 flutter")
        self.assertEqual(calls[2], "useradd --uid 501 --gid 20 -m flutter")


if __name__ == "__main__":
    unittest.main()
