# Reviewed container jobs

`container_exec` runs exact Docker/Podman argv through Lubox's private host bridge after
Auto-Approval. Neither the agent shell nor an application container receives an engine socket,
host-exec token, operator API keys or host environment. This feature currently requires Pi inside
Linux Lubox with its host bridge and native bwrap transport available. Restart Pi through
`~/.local/bin/pi` after installation; no Lubox restart or new device configuration is needed.

Use `approved_action` with `tool: "container_exec"`, optional `engine: "auto" | "docker" | "podman"`,
and either `argv` or a sequential `commands` batch. Arguments exclude the executable name.
For example:

```json
{
  "tool": "container_exec",
  "arguments": {
    "argv": ["run", "--rm", "node:22", "sh", "-c", "npm ci && npm run build"]
  },
  "sandbox": {
    "projectFiles": "write",
    "network": "host",
    "limits": { "memoryMiB": 4096, "cpus": 2, "pids": 128, "executionTimeoutMs": 600000 }
  },
  "goal": "Build the requested project",
  "justification": "Install its locked dependencies and verify the production build in a temporary SDK container"
}
```

File access is opt-in: `projectFiles: read/write` or selected `paths` grants. Selected bind sources
must be exact granted roots. No mount may contain protected operator files; use a narrower root.
Rootless Podman preserves the operator UID mapping for project writes. Runs mount grants at their original paths and use the project working directory unless overridden.
Literal `sandbox.environment` values go only into application containers. No host environment
variables are inherited. Network access belongs to this action; offline jobs cannot pull images.
Published ports require network approval and explicit `127.0.0.1:host:container` mappings.

`maxOutputBytes` caps retained workload text, not execution. Oversized logs show a bounded
head/tail preview with truncation metadata and the actual exit status; deadlines, cancellation
and cleanup still apply. Redirect full logs to an explicitly writable artifact path when needed.
Internal engine identity/control responses retain strict overflow rejection.

Supported operations:

- Read-only engine metadata: version, info, ps, images and image inspection/history.
- Image pulls with network approval.
- Temporary `run` containers; subsequent exec/logs/inspect/stop/rm/wait target only logical names
  created earlier in the same batch. Use `run --name test -d ...` for a temporary service.
- A bounded Compose subset using one flattened YAML file and prebuilt images. Use a `commands`
  batch for `compose up -d`, `compose exec -T service ...`, and optional `compose down --volumes`.
  Config/ps/logs/pull/start/stop/restart are also supported. The service configuration is parsed
  as data inside a read-only projection and frozen for review. There are no host shell evaluations,
  implicit host environment values, includes, external resources or custom drivers. Extra service
  fields are rejected explicitly. Ports use the same loopback rule. Named volumes/networks are
  temporary and isolated under a random project name. One-off `compose run` is unavailable.

Compose accepts `--env-file /dev/null` as empty input and honors literal
`COMPOSE_DISABLE_ENV_FILE=true|1` for the default `.env`. Explicit env files still need grants.
`config --no-interpolate` preserves variable expressions. These flags do not expand the supported
Compose subset or allow image builds, external resources or ungranted file reads.

Every job gets a random ownership ID. An explicit cancellation tombstone prevents late startup even when an older host bridge does not
propagate socket closure. Tombstones expire after 25 hours. Cleanup runs on success, failure and interruption and can
remove only resources owned by that job. Cleanup failure is reported; it does not grant permission
to retry an uncertain action. Image pulls and authorized project writes can persist. No system
prune, machine management, privileged containers, host namespaces, devices, engine-socket mounts
or operations on preexisting containers are exposed. The running Lubox container is never a target.

Memory, CPU and PID budgets are divided across the job's maximum workload count, so parallel
services share the total budget. Native engine capability checks and stopped-container inspection
must verify the controls before startup. Defaults are 2048 MiB, 2 CPUs and 256 PIDs total, with
a two-minute deadline. These bounds apply to application workloads, not the shared daemon/control
plane. Required aggregate temporary-storage bounds are unsupported and rejected. Daemon image
builds are also rejected because builder quotas cannot be verified; perform application builds,
Clippy, typechecking and tests in an appropriate SDK image instead.

For ordinary bwrap actions, `/sys/fs/cgroup/pi-actions` is discovered automatically when Lubox has
delegated it. `sandbox.cgroupRoot` is only a custom override. Auto-Approval cannot create kernel
delegation, but the container-job route enforces workload caps through the engine without requiring
that local delegation. When `/remote` is active, this tool still uses the local operator engine;
remote project mounts are rejected rather than silently mirrored.
