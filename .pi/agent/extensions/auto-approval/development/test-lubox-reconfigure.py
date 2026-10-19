"""Unit checks for stopped-only, configuration-preserving Podman migration."""

import copy
import importlib.util
import runpy
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock


path = Path.home() / ".local/share/lubox/podman_reconfigure.py"
spec = importlib.util.spec_from_file_location("migration", path)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def source():
    return {
        "Id": "a" * 64, "Name": "lubox-gunter-test", "ImageName": "localhost/example:latest",
        "State": {"Status": "exited", "Running": False},
        "Config": {
            "Image": "localhost/example:latest", "Cmd": ["sleep", "180"],
            "Labels": {"dev.lubox": "1", "dev.lubox.name": "test"},
            "Env": ["CUSTOM=value", "HOME=/home/test"], "User": "1000:1000",
            "CreateCommand": [
                "podman", "create", "--name", "lubox-gunter-test",
                "--hostname", "original", "--user", "1000:1000",
                "--env", "CUSTOM=value", "--mount", "type=volume,src=data,dst=/data",
                "--cap-add", "NET_RAW", "example:latest", "sleep", "180",
            ],
        },
        "HostConfig": {"SecurityOpt": ["label=disable"], "CapAdd": ["NET_RAW"], "CgroupMode": "private"},
        "Mounts": [{
            "Type": "volume", "Name": "data", "Source": "/volumes/data", "Destination": "/data", "RW": True,
        }],
    }


def replacement(info):
    result = copy.deepcopy(info)
    result["Id"] = "b" * 64
    result["State"] = {"Running": False, "Status": "created"}
    result["Config"]["Image"] = "sha256:" + "c" * 64
    result["Config"]["SystemdMode"] = True
    result["Config"]["Labels"].update({"dev.lubox.bwrap": "true", "dev.lubox.cgroup_limits": "true"})
    result["HostConfig"]["CapAdd"] = []
    result["HostConfig"]["SecurityOpt"].append("unmask=/proc:/proc/*")
    return result


def manager(info):
    engine = SimpleNamespace(run=Mock(return_value=SimpleNamespace(stdout="sha256:" + "c" * 64)))
    return SimpleNamespace(
        engine=engine, require_container=Mock(return_value=info),
        labels_from_info=lambda current: current["Config"]["Labels"],
        running_from_info=lambda current: current["State"]["Running"],
    )


class MigrationTests(TestCase):
    def test_replay_changes_only_explicit_prerequisites(self):
        args = migration.replacement_arguments(source(), "snapshot", "candidate", True)
        self.assertEqual(args[-3:], ["snapshot", "sleep", "180"])
        self.assertIn("--pull=never", args)
        self.assertIn("--systemd=always", args)
        self.assertIn("--cgroupns=private", args)
        for value in ("original", "1000:1000", "CUSTOM=value", "type=volume,src=data,dst=/data"):
            self.assertIn(value, args)

        self.assertNotIn("--cap-add", args)
        self.assertNotIn("--privileged", args)

    def test_unknown_options_and_implicit_environment_fail_before_snapshot(self):
        for options in (["--env-file", "/changed"], ["--env", "CUSTOM"], ["--replace=true"]):
            info = source()
            info["Config"]["CreateCommand"][2:2] = options
            instance = manager(info)
            with self.assertRaises(migration.MigrationError):
                migration.reconfigure(instance, "test", True)

            instance.engine.run.assert_not_called()

    def test_running_and_foreign_sources_are_never_stopped_or_snapshotted(self):
        for mutate in (
            lambda info: info["State"].update(Running=True),
            lambda info: info["Config"]["Labels"].update({"dev.lubox.name": "other"}),
            lambda info: info["HostConfig"].update(Privileged=True),
            lambda info: info["Config"]["CreateCommand"].insert(0, "unexpected"),
        ):
            info = source()
            mutate(info)
            instance = manager(info)
            with self.assertRaises(migration.MigrationError):
                migration.reconfigure(instance, "test", True)

            instance.engine.run.assert_not_called()

    def test_updated_settings_volumes_and_security_cannot_be_silently_lost(self):
        info = source()
        migrated = replacement(info)
        migration.verify_replacement(info, migrated, True)
        for mutate in (
            lambda current: current["Config"]["Env"].append("INJECTED=1"),
            lambda current: current["Mounts"][0].update(Name="new-empty-volume"),
            lambda current: current["HostConfig"].update(Memory=123),
            lambda current: current["HostConfig"]["SecurityOpt"].append("seccomp=unconfined"),
            lambda current: current["HostConfig"].update(CgroupMode="host"),
            lambda current: current["HostConfig"].update(CapAdd=["NET_RAW"]),
            lambda current: current["Config"].update(SystemdMode=False),
            lambda current: current["Config"]["Labels"].update({"dev.lubox.cgroup_limits": "false"}),
        ):
            changed = copy.deepcopy(migrated)
            mutate(changed)
            with self.assertRaises(migration.MigrationError):
                migration.verify_replacement(info, changed, True)

    def test_a_started_or_replaced_source_cannot_be_switched(self):
        for mutate in (lambda info: info.update(Id="other"), lambda info: info["State"].update(Running=True)):
            info = source()
            mutate(info)
            instance = manager(info)
            with self.assertRaises(migration.MigrationError):
                migration.switch_names(instance, "test", "a" * 64, "b" * 64, "backup")

            instance.engine.run.assert_not_called()

    def test_failed_final_rename_restores_original_name_without_deleting_anything(self):
        info = source()
        instance = manager(info)
        instance.engine.inspect_container = Mock(side_effect=[replacement(info), None])
        instance.engine.run.side_effect = [None, RuntimeError("rename failed"), None]
        with self.assertRaises(migration.MigrationError):
            migration.switch_names(instance, "test", info["Id"], "b" * 64, "backup")

        self.assertEqual([call.args[0][0] for call in instance.engine.run.call_args_list], ["rename"] * 3)
        self.assertEqual(instance.engine.run.call_args.args[0], ["rename", info["Id"], info["Name"]])

    def test_ambiguous_name_failure_never_removes_or_overwrites_another_container(self):
        info = source()
        instance = manager(info)
        instance.engine.inspect_container = Mock(side_effect=[replacement(info), {"Id": "other"}])
        instance.engine.run.side_effect = [None, RuntimeError("rename failed")]
        with self.assertRaises(migration.MigrationError):
            migration.switch_names(instance, "test", info["Id"], "b" * 64, "backup")

        self.assertEqual(instance.engine.run.call_count, 2)

    def test_replacement_validation_failure_cannot_rename_the_source(self):
        info = source()
        instance = manager(info)
        changed = replacement(info)
        changed["HostConfig"]["Memory"] = 123
        instance.engine.inspect_container = Mock(return_value=changed)
        with self.assertRaises(migration.MigrationError):
            migration.reconfigure(instance, "test", True)

        commands = [call.args[0][0] for call in instance.engine.run.call_args_list]
        self.assertEqual(commands, ["commit", "image", "create"])

    def test_replacement_started_by_someone_else_cannot_be_switched(self):
        info = source()
        instance = manager(info)
        changed = replacement(info)
        changed["State"]["Running"] = True
        instance.engine.inspect_container = Mock(return_value=changed)
        with self.assertRaises(migration.MigrationError):
            migration.switch_names(instance, "test", info["Id"], changed["Id"], "backup")

        instance.engine.run.assert_not_called()

    def test_cli_accepts_resource_delegation_without_requiring_a_redundant_flag(self):
        namespace = runpy.run_path(str(Path.home() / ".local/bin/lubox"))
        arguments = namespace["build_parser"]().parse_args([
            "reconfigure", "test", "--engine", "podman", "--cgroup-limits",
        ])
        self.assertTrue(arguments.cgroup_limits)
        self.assertFalse(arguments.bwrap)

    def test_docker_limit_requests_fail_without_changing_a_container(self):
        namespace = runpy.run_path(str(Path.home() / ".local/bin/lubox"))
        instance = namespace["ContainerManager"].__new__(namespace["ContainerManager"])
        instance.engine = SimpleNamespace(name="docker", run=Mock())
        with self.assertRaises(namespace["LuboxError"]):
            instance.reconfigure("test", cgroup_limits=True)

        instance.engine.run.assert_not_called()

    def test_existing_docker_bwrap_migration_still_uses_its_original_implementation(self):
        namespace = runpy.run_path(str(Path.home() / ".local/bin/lubox"))
        instance = namespace["ContainerManager"].__new__(namespace["ContainerManager"])
        instance.engine = SimpleNamespace(name="docker", run=Mock())
        instance.reconfigure_bwrap = Mock()
        instance.reconfigure("test")
        instance.reconfigure_bwrap.assert_called_once_with("test")
        instance.engine.run.assert_not_called()


if __name__ == "__main__":
    main()
