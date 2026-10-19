"""Test Lubox launch construction without starting or changing any real container."""

import importlib.machinery
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock
import sys


loader = importlib.machinery.SourceFileLoader("lubox_under_test", str(Path.home() / ".local/bin/lubox"))
spec = importlib.util.spec_from_loader(loader.name, loader)
lubox = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = lubox
loader.exec_module(lubox)


def manager(engine="podman"):
    instance = lubox.ContainerManager.__new__(lubox.ContainerManager)
    instance.engine = SimpleNamespace(name=engine, run=Mock(), ensure_ready=Mock())
    instance.ident = SimpleNamespace(uid=1000, gid=1000)
    instance.socket_forward_plan = Mock(return_value=SimpleNamespace(groups=(), gpg_home=None))
    for name in ("warn_unforwarded_sockets", "seed_socket_forward_config", "sync_container_lubox", "ensure_runtime_mount_files"):
        setattr(instance, name, Mock())
    instance.create_labels = Mock(return_value={})
    instance.create_env = Mock(return_value=[])
    for name in ("linux_session_mount_args", "create_mount_args", "create_secret_args"):
        setattr(instance, name, Mock(return_value=[]))
    instance.create_engine_identity_args = Mock(return_value=["--user", "1000:1000"])
    return instance


class CgroupLaunchTests(TestCase):
    def test_opt_in_keeps_the_normal_user_and_private_namespace(self):
        instance = manager()
        args = instance.create_args("test", "image", "base", False, Path("/tmp/mount"), "/bin/bash", bwrap=True, cgroup_limits=True)
        self.assertIn("--systemd=always", args)
        self.assertIn("--cgroupns=private", args)
        self.assertIn("dev.lubox.cgroup_limits=true", args)
        self.assertEqual(args[args.index("--user") + 1], "1000:1000")
        self.assertNotIn("--privileged", args)
        self.assertNotIn("SYS_ADMIN", args)
        self.assertNotIn("--cap-add", args)

    def test_default_launch_does_not_request_delegation(self):
        args = manager().create_args("test", "image", "base", False, Path("/tmp/mount"), "/bin/bash", bwrap=True)
        self.assertNotIn("--systemd=always", args)

    def test_unsupported_combinations_fail_without_an_engine_call(self):
        for engine, bwrap in (("docker", True), ("podman", False)):
            instance = manager(engine)
            with self.assertRaises(lubox.LuboxError):
                instance.create("test", "image", True, False, bwrap=bwrap, cgroup_limits=True)
            instance.engine.run.assert_not_called()

    def test_running_boxes_are_never_migrated(self):
        instance = manager()
        instance.require_container = Mock(return_value={"State": {"Running": True}})
        instance.hostexec_enabled = Mock(return_value=False)
        instance.ssh_agent_enabled = Mock(return_value=False)
        instance.gpg_agent_enabled = Mock(return_value=False)
        instance.prepare_cgroup_limits = Mock()
        instance.start("test", start_server=False, announce=False)
        instance.prepare_cgroup_limits.assert_not_called()
        instance.engine.run.assert_not_called()

    def test_cold_start_prepares_delegation_before_returning(self):
        instance = manager()
        info = {"State": {"Running": False}}
        instance.require_container = Mock(return_value=info)
        instance.hostexec_enabled = Mock(return_value=False)
        instance.ssh_agent_enabled = Mock(return_value=False)
        instance.gpg_agent_enabled = Mock(return_value=False)
        instance.prepare_cgroup_limits = Mock()
        instance.start("test", start_server=False, announce=False)
        instance.engine.run.assert_called_once()
        instance.prepare_cgroup_limits.assert_called_once_with("test", info)


if __name__ == "__main__":
    main()
