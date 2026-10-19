# Reconfigure an existing Lubox

Podman boxes can enable unprivileged bubblewrap and per-action resource
delegation without reinstalling their packages. Run the migration from the
**host terminal**, after saving work and leaving all sessions in that box:

```sh
lubox stop fedora1 --engine podman
lubox reconfigure fedora1 --engine podman --cgroup-limits
lubox start fedora1 --engine podman
lubox enter fedora1 --engine podman
```

`--cgroup-limits` includes `--bwrap`. For filesystem/network isolation without
aggregate resource limits, use `--bwrap` alone. Docker continues to support
`--bwrap`; cgroup delegation requires Podman.

Reconfiguration refuses running containers and never stops them itself. It
snapshots the stopped writable layer, creates an unstarted replacement from
that immutable image, and checks its configuration before switching names.
Installed packages remain in the snapshot. Existing named volumes and bind
mounts are reused; their contents are not copied into the snapshot image.
The original container and snapshot remain as backups. The replacement remains
stopped until the operator starts it. Cold start prepares the private delegation;
Pi discovers it automatically without another device configuration field.

The original Podman create record must match the inspected image and command.
Only supported options with explicit values are replayed. Unknown options,
implicit environment values, changed settings that cannot be reconstructed,
privileged containers and differing mounts fail before the name switch.
Changes made through `podman update` may therefore require manual migration.
No shell evaluates the recorded arguments. Migration never pulls images, adds
privileged mode or `CAP_SYS_ADMIN`, or reads the contents of host credential
files. Existing engine secret references are retained.

The command prints the snapshot, replacement and backup names. If preparation
fails, the source keeps its original name; diagnostic candidates and snapshots
may remain for inspection. If the final name switch fails, the original name
is restored only when it is unoccupied. No unrelated container is overwritten
or deleted. Do not concurrently rename, start or modify the source during
migration.

To roll back after a successful switch, stop the replacement from the host,
rename it to another unused name, and rename the printed original backup to
the original container name. Start it through Lubox. Do not use `rm --volumes`:
the original and replacement intentionally refer to the same mounted data.

Unit checks and an offline integration harness live in
`.pi/agent/extensions/auto-approval/development/test-lubox-reconfigure*.py`.
The integration harness uses only a locally available Lubox image and randomly
named test containers, a test volume, a synthetic engine secret and a temporary
bind directory. It checks both `--bwrap` and subsequent `--cgroup-limits`
migration, data and executable preservation, secret references and working
bwrap/cgroup delegation. It never stops or migrates the current box.
