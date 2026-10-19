"""Migrate only randomly named offline Podman fixtures, never the current Lubox."""

import argparse
import importlib.machinery
import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile
import uuid


loader = importlib.machinery.SourceFileLoader("lubox_migration_test", str(Path.home() / ".local/bin/lubox"))
spec = importlib.util.spec_from_loader(loader.name, loader)
lubox = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = lubox
loader.exec_module(lubox)


def check(condition, message):
    if not condition:
        raise AssertionError(message)


class FixtureEngine(lubox.Engine):
    def run(self, arguments, **options):
        options.setdefault("timeout", 60)
        return super().run(arguments, **options)


def validate(args):
    nonce = uuid.uuid4().hex
    name = "migration-test-" + nonce
    cname = lubox.container_name(name)
    label = "dev.lubox.migration-test=" + nonce
    volume = "pi-migration-test-" + nonce
    secret = "pi-migration-secret-" + nonce
    engine = FixtureEngine("podman", shutil.which("podman"))
    image = engine.run(["image", "inspect", "--format", "{{.Id}}", args.image]).stdout.strip()
    instance = lubox.ContainerManager.__new__(lubox.ContainerManager)
    instance.engine = engine
    fixture = Path(tempfile.mkdtemp(prefix=".lubox-migration-test-", dir=Path.home()))
    try:
        engine.run(["volume", "create", volume])
        engine.run(["secret", "create", secret, "-"], input_data=b"fixture-only-secret")
        create_fixture(engine, image, name, cname, label, volume, secret, fixture)
        original, digest = prepare_original(instance, name)
        verify_running_refusal(instance, name, original)
        engine.run(["stop", "--time", "1", original])
        for cgroup_limits in (False, True):
            migrated = migrate_and_start(instance, name, cgroup_limits)
            verify_runtime(engine, migrated, digest, cgroup_limits)
            engine.run(["stop", "--time", "1", migrated])

        print(
            "PASS: running refusal, repeated offline migration, stopped backups, root layer, "
            "package hash, named volume, bind mount, synthetic secret, bwrap and cgroup delegation",
            flush=True,
        )
    finally:
        cleanup(engine, label, name, volume, secret)
        shutil.rmtree(fixture)


def prepare_original(instance, name):
    identity = instance.require_container(name)["Id"]
    engine = instance.engine
    engine.run(["start", identity])
    markers = (
        "printf root-retained > /opt/migration-marker; "
        "printf volume-retained > /data/marker; "
        "printf bind-retained > /project/marker"
    )
    engine.run(["exec", "--user", "0:0", identity, "/bin/sh", "-c", markers])
    digest = engine.run(["exec", identity, "sha256sum", "/usr/bin/python3"]).stdout
    return identity, digest


def verify_running_refusal(instance, name, identity):
    try:
        instance.reconfigure(name, cgroup_limits=True)
    except lubox.LuboxError:
        pass
    else:
        raise AssertionError("Running fixture migration was not refused")

    check(instance.require_container(name)["Id"] == identity, "Running source changed")


def migrate_and_start(instance, name, cgroup_limits):
    original = instance.require_container(name)["Id"]
    instance.reconfigure(name, cgroup_limits=cgroup_limits)
    migrated = instance.require_container(name)
    check(migrated["Id"] != original, "Replacement identity did not change")
    check(not instance.running_from_info(migrated), "Replacement was started automatically")
    backup = instance.engine.inspect_container(original, required=True)
    check(not instance.running_from_info(backup), "Backup is not stopped")
    instance.engine.run(["start", migrated["Id"]])
    return migrated["Id"]


def create_fixture(engine, image, name, cname, label, volume, secret, fixture):
    uid, gid = lubox.os.getuid(), lubox.os.getgid()
    engine.run([
        "create", "--pull=never", "--name", cname, "--hostname", "migration-original",
        "--label", "dev.lubox=1", "--label", "dev.lubox.name=" + name, "--label", label,
        "--network", "none", "--security-opt", "label=disable", "--security-opt", "unmask=/proc:/proc/*",
        "--userns", "keep-id", "--user", f"{uid}:{gid}", "--env", "MIGRATION_TEST=retained",
        "--memory", "1g", "--cpus", "2", "--pids-limit", "512",
        "--mount", f"type=bind,src={fixture},dst=/project",
        "--mount", f"type=bind,src={Path.home() / '.local/bin/lubox'},dst=/opt/pi-test/lubox,readonly",
        "--volume", volume + ":/data",
        "--secret", f"{secret},target=/run/secrets/fixture,uid={uid},gid={gid},mode=0400",
        image, "/bin/sh", "-c", "sleep 240",
    ])


def verify_runtime(engine, identity, digest, cgroup_limits):
    uid, gid = lubox.os.getuid(), lubox.os.getgid()
    if cgroup_limits:
        engine.run([
            "exec", "--user", "0:0", identity, "python3", "/opt/pi-test/lubox",
            "__container-cgroups", str(uid), str(gid),
        ])

    installed = engine.run(["exec", identity, "sha256sum", "/usr/bin/python3"]).stdout
    check(installed == digest, "Installed executable changed")
    user = engine.run([
        "exec", identity, "/bin/sh", "-c", 'test "$MIGRATION_TEST" = retained && id -u',
    ]).stdout.strip()
    check(user == str(uid), "Identity or environment changed")
    data = engine.run([
        "exec", identity, "cat", "/opt/migration-marker", "/data/marker", "/project/marker",
    ]).stdout
    check(data == "root-retainedvolume-retainedbind-retained", "Migration lost persistent data")
    token = engine.run(["exec", identity, "cat", "/run/secrets/fixture"]).stdout
    check(token == "fixture-only-secret", "Synthetic secret binding changed")
    engine.run(["exec", identity, "/usr/bin/bwrap", "--unshare-all", "--ro-bind", "/usr", "/usr",
                "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib64", "/lib64",
                "--symlink", "usr/lib", "/lib", "--proc", "/proc", "--dev", "/dev", "--", "/bin/true"])
    if cgroup_limits:
        check_memory_controller(engine, identity)


def check_memory_controller(engine, identity):
    code = """from pathlib import Path
root = Path('/sys/fs/cgroup/pi-actions')
action = root / 'fixture-action'
action.mkdir()
try:
    (action / 'memory.max').write_text('134217728')
    assert (action / 'memory.max').read_text().strip() == '134217728'
finally:
    action.rmdir()
"""
    engine.run(["exec", identity, "python3", "-c", code])


def cleanup(engine, label, name, volume, secret):
    identities = engine.run([
        "ps", "--all", "--filter", "label=" + label, "--format", "{{.ID}}",
    ], check=False).stdout.split()
    if identities:
        engine.run(["rm", "--force"] + identities)

    images = engine.run([
        "images", "--filter", f"reference=lubox/{name}:before-reconfigure-*", "--format", "{{.ID}}",
    ], check=False).stdout.split()
    if images:
        engine.run(["rmi"] + images)

    engine.run(["volume", "rm", volume], check=False)
    engine.run(["secret", "rm", secret], check=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Existing local Lubox image; no pull or build")
    validate(parser.parse_args())
