# Native aggregate resource limits

Native bwrap actions can use `memoryMiB`, `cpus` and `pids` through a delegated
cgroup v2 subtree. Bubblewrap still supplies filesystem, process and network
isolation. No container engine or controller mount is passed to the action.

Each limited action gets a new child cgroup. A fixed launcher attaches itself
before executing bwrap. The executor writes and reads back `memory.max`,
`memory.swap.max=0`, `memory.oom.group=1`, `cpu.max` and `pids.max` as requested.
The limits cover the action and descendants together; PID accounting includes
threads. CPU quota is a bandwidth limit, not a wall-clock deadline or CPU pinning.
Existing execution timeouts and output limits remain separate.
Choose action budgets with headroom for Pi and concurrent work: ancestor/container
limits and host memory are still shared. This feature is not a global admission scheduler.

Preflight checks a real, user-owned cgroup v2 directory with enabled controllers
and no directly attached processes. After review, the executor rechecks the
directory identity and requested controls. Ordinary directories cannot imitate
enforcement. Controller files, aliases and ancestor mounts are rejected before
review and again before execution. Cancellation and normal completion kill and
drain only the newly created action cgroup, then remove it. Pi's own runtime and
concurrent actions are outside that child's limits and cleanup.

The executor never enables parent controllers, moves Pi, changes a container's
limits, changes operator configuration or falls back to unrestricted execution.
Delegation must already exist. A required limit without delegation fails closed.
Resource budgets belong to each action request and are independently reviewed.
They do not grant kernel permissions or prepare the host's delegation.
For bwrap, Pi automatically inspects `/sys/fs/cgroup/pi-actions`, the standard
Lubox delegation. An optional device-owned `sandbox.cgroupRoot` overrides that
path for other operator-provided delegations. An invalid override fails closed;
it never silently selects another root. Action arguments and environment
variables cannot select the root.
Persistent session `/tmp` still does not support a `tmpBytes` cap; disk quotas are
not implemented by this extension.

## Prepare a new Lubox environment

The Lubox integration currently supports Podman with cgroup v2 and delegated
`cpu`, `memory` and `pids` controllers. From the **host terminal**, create and start
a separate box:

```sh
lubox create pi-limits --engine podman --bwrap --cgroup-limits
lubox start pi-limits --engine podman
lubox enter pi-limits --engine podman
```

Lubox uses a private writable cgroup namespace. During a cold start, before user
sessions begin, a root initialization command places the container runtime in
`/sys/fs/cgroup/pi-actions/lubox-runtime` and delegates only the `pi-actions`
subtree to the ordinary user. The normal container user stays unchanged; no
privileged mode, `CAP_SYS_ADMIN`, additional user capabilities or engine socket
is required. Container-root membership files and limit controls stay unchanged.
Later exec sessions join the runtime leaf. The subtree is recreated after a
container restart.

Keep `backend: "bwrap"` in the shared configuration. No additional Pi path
configuration is needed for this Lubox setup. Restart Pi through its normal
launcher. The model requests budgets such as `memoryMiB: 1024`, `cpus: 1` and
`pids: 64` per action; independent approval still applies to each request.

This does not migrate or restart an existing box. Read-only cgroup mounts in an
already running Lubox cannot be repaired by an action inside that sandbox.
The existing box and its writable filesystem remain intact; installed packages
in that writable layer are not automatically copied to a newly created box.
On other Linux environments, an operator can provide an equivalent private
delegation with the trusted runtime in a sibling leaf of the action cgroups.
If its path differs from `/sys/fs/cgroup/pi-actions`, merge
`"cgroupRoot": "/absolute/delegated/path"` into the existing `sandbox` object in
`~/.pi/agent/auto-approval.device.json`, preserving other device settings.

## Verification

Unit and boundary checks are part of `bun run test`. Real controller tests run
in a separate disposable container with an already installed Lubox image and a
native Linux Bun executable:

```sh
python3 development/test-cgroups.py \
  --image localhost/lubox/fedora1:latest \
  --bun /absolute/path/to/linux/bun
python3 development/test-lubox-cgroups.py
```

The harness pins the local image ID, disables networking, mounts only test code
and Bun read-only, applies outer container limits, and removes only its own
randomly named container. It checks actual aggregate OOM handling, PID exhaustion,
CPU throttling, cancellation, concurrent-action separation, hidden controls and
changed-plan rejection, including automatic root discovery without device
configuration and delegation after restarting its own disposable container.
Invalid explicit overrides are rejected even when the standard root is usable.
It never stops or reconfigures the running Lubox.

The implementation follows the kernel's [cgroup v2 delegation and controller
documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
and Podman's [systemd container mode](https://docs.podman.io/en/latest/markdown/podman-run.1.html#systemd-true--false--always).
