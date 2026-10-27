# Remote workspaces

Pi and its model/reviewer connections remain local. `/remote` routes approved project operations
through SSH to one selected remote directory. No Pi installation, transcript, model credentials,
private SSH keys or login configuration is copied to the host. Reviewed request data and the small
Python worker are sent over SSH; the remote account can read that project data.

```text
/remote at69yvos@cip5b4.cip.cs.fau.de:flatscan-1shot
/remote status
/remote tunnels
/remote close <tunnel-id>
/remote off
```

`/remote` with no argument opens a target input. Relative folders, including `~/folder`, resolve
under the remote account's home, independently of Pi's local directory. The folder must already
exist. The resolved path and isolation mode appear in the selection result; the target appears in
the status bar. A session remembers its own selection. Settle or interrupt current work before
changing it. Returning to local work requires `/remote off`. Pi session storage, native path
completions and `@file` attachments remain local; ask the model to read remote files through the
approved project tools.

## Connection and isolation

The local transport requires Linux, native OpenSSH, working bwrap, a live `SSH_AUTH_SOCK` and a
previously trusted host key in `~/.ssh/known_hosts`. On macOS, run Pi inside Lubox. Verify unknown or
changed host keys outside Pi; this extension never silently accepts them. This first version uses
SSH port 22 and a literal `user@hostname:folder` target, without SSH aliases, jump hosts or config
expansion. IPv4 targets are supported; tunnel destinations can also use IPv6.

Authentication is public-key-only through the local SSH agent. Passwords, keyboard-interactive,
GSSAPI, private key files, config-supplied commands, shared project connections and agent forwarding
are disabled. Tunnels use a private control socket only for their own supervision. The SSH client runs in a separate local bwrap sandbox with a read-only agent socket
and the selected public host keys. It receives no API credential environment or Pi/home mounts.

The fixed metadata probe requires Linux and Python 3 on the remote host. It resolves the folder
and actually tries bwrap namespace creation. If that succeeds, project tools run inside remote
bwrap: system runtime files are read-only, the selected project is writable (read-only for review
subagents), `/tmp` is private and networking is disabled unless that action requests it.

If bwrap is absent or unusable, Pi reports the diagnostic and asks the operator **in its native UI**
whether to proceed with Auto-Approval and the remote account's normal permissions. Declining, an
unanswered dialog or headless mode cannot enable the exception. The confirmation applies to that
selected workspace in that session; it never enables local host execution. A later bwrap failure
does not silently switch modes. Select `/remote user@host:folder` again to probe and reconsider.

In confirmed account mode, the folder is a working directory, not a filesystem boundary. Shell
commands have the remote account's normal filesystem and network access. File tools retain their
workspace/private-tmp scope. Use `$TMPDIR` for private shell scratch files: absolute `/tmp` is the
remote account's shared directory. Project subprocesses start with a clean environment and do not source shell profiles. The host controls its kernel,
SSH server and output; its results are untrusted data, never authorization.

Explicit offline guarantees are rejected in account mode. Aggregate memory, CPU, PID and temporary
storage quotas are not implemented remotely and are rejected in both modes. Required guarantees
must not be dropped. Each operation has a deadline (at most 23 hours), an output bound (at most
16 MiB) and cancellation handling. Account-mode descendant cleanup is best effort; it is not an
OS process-containment guarantee.

## Approval and tools

Ordinary `approved_action` requests for `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`,
`powershell` and `git` use the remote root. The independent reviewer sees the exact action, pinned
host-key hash, remote identity/path, isolation mode, any operator fallback confirmation and
requested expansions. The verdict must be persisted before dispatch. A changed target invalidates
an outstanding approval. Multiplex members and subagents inherit the route; read-only review
subagents cannot execute remote shells or mutate files.

Use absolute remote paths or project-relative paths. Commands use installed remote system tools;
local `sandbox.tools`, extra mounts and executable-search-path bundles are not transferred.
Remote find/grep are bounded stdlib implementations, include hidden files and do not interpret
`.gitignore`. Edit replacements must match exactly once and cannot overlap; results use Pi's
normal numbered diff renderer. Large reads and searches must be split into bounded requests.

Web research, editorial checks and `credential_exec` remain local. Remote project files cannot
be mounted into a local credential action; no automatic project mirror exists. For a Git command,
`sandbox.gitConfig: true` can disclose supported **public** local identity/settings to the selected
remote host after independent approval. The private configuration reader still requires the
existing local bwrap Git route. Credential helpers, login tokens, hooks and aliases are excluded;
the public temporary config is removed after the command.

## Port forwarding

Use `approved_action` with `tool: remote_tunnel`, `sandbox.network: host` and explicit arguments:

```json
{
  "operation": "open",
  "direction": "local",
  "port": 8080,
  "destinationHost": "127.0.0.1",
  "destinationPort": 3000,
  "lifetimeSeconds": 3600
}
```

A local forward listens on local `127.0.0.1:8080` and connects from the remote host to its
`127.0.0.1:3000`. A remote forward listens on remote loopback and connects from the local Pi host
to the explicit destination. The review must account for access to services on either side.
The requested remote loopback bind remains subject to that host's SSH server policy.

Listeners use unprivileged ports and lifetimes from 10 seconds to 23 hours (default one hour).
No wildcard binds, SOCKS, Unix-socket or agent forwarding are exposed. `operation: list` reports
owned tunnels; `operation: close` takes an `id`. An agent can close only its own tunnels; the
operator can close any with `/remote close`. Native Escape/Ctrl-C, session changes and shutdown
close all tunnels. They are not restored after restart. Startup waits for OpenSSH to confirm
forwarding success; remote banner text cannot fake that confirmation.

## Reconnection and temporary data

Each action uses a fresh SSH connection. A remote daily process-lifetime limit does not terminate
the local Pi session: the next approved action reconnects. Dropped connections, output overflow
and cancellation can leave an uncertain action outcome. Pi never automatically replays a command
or write; inspect current state and submit a freshly reviewed action instead.

Each actor gets its own UUID-scoped remote temporary directory. Its cleanup address is persisted
before the first action, including for crash recovery. Quit/session changes cancel owned process
groups and remove temporary data while the host is reachable. If it is unavailable, Pi warns and
retains a cleanup receipt; later approved connections retry only that cleanup. `/remote status`
reports pending receipts. An unreachable host cannot be guaranteed clean immediately. Local SSH
scratch files and tunnels are cleaned independently of remote availability.

## FAU CIP workstation pools

```text
/cip flatscan-1shot
/cip /proj/ciptmp/at69yvos/oneshotscan-training
/remote status
/remote off
```

`/cip` takes one workspace path, with the same home-relative/absolute semantics as `/remote`.
It uses the username cached by the actual `~/.local/bin/faucip`, asking if absent.
The same launcher supplies host capabilities through its `--list-tsv` interface; Pi keeps no
second host catalog. The [official room index](https://wwwcip.informatik.uni-erlangen.de/cipPools/roomIndex.de.html)
is the catalog's source. The initial random workstation counts toward the four-node limit.

CIP connections use **public-key authentication through the local SSH agent only**.
First-seen CIP keys are accepted automatically into the local, device-owned
`~/.pi/agent/cip-known-hosts`; existing pins are never replaced. Other domains keep `/remote`'s
explicit trust requirement. Operator `~/.ssh/known_hosts` entries take precedence. Both modes
re-read public trust for each preparation, so adding a key no longer requires restarting Pi.
Agent forwarding, passwords and GSSAPI remain disabled.

The model requests capabilities through independently reviewed `approved_action` calls:

```json
{
  "tool": "cip_nodes",
  "arguments": { "operation": "acquire", "gpuModel": "3070", "minRamGiB": 32 },
  "goal": "Train the requested model",
  "justification": "Use a free workstation with the required GPU"
}
```

Other operations are `list` and `release` (with `node`, e.g. `cip-2`). Acquisition accepts
`gpu`, `gpuModel` (case-insensitive substring), `minRamGiB`, `minCores`, and an optional exact
`host`. Prefer capability requests so replacements can retain the requirement. An allocation
returns a stable slot ID and current physical host. Concurrent requests cannot exceed four
allocated workstations. Release an unused initial slot if all four slots need specific GPUs.
These allocations are scheduler state, not exclusive reservations against other CIP users.

Commands choose a slot using `sandbox.cip.node`:

```json
{
  "tool": "bash",
  "arguments": { "command": "python -m training --resume", "timeout": 3600 },
  "sandbox": { "cip": { "node": "cip-2" } },
  "goal": "Continue training",
  "justification": "Resume from the last verified shared checkpoint"
}
```

Use supervised background jobs for independent parallel runs, with distinct shared output
directories. Join the jobs when no independent work remains; never detach shell/SSH processes.

File tools select a random allocated workstation and use the same workspace path. Home and
`/proj/ciptmp` are shared across nodes, including disk and file-count quotas. Pi runs `cip-quota`
during discovery and action preparation and supplies the output to the model/reviewer. Check
again before large downloads/builds/checkpoints; keep only necessary artifacts. For an existing
canonical dataset/venv/cache directory outside the workspace, request `sandbox.paths` with
`read` or `write`. With bwrap, mounts stay limited to the workspace and these reviewed paths;
GPU nodes additionally receive their NVIDIA devices. `/tmp` remains private and node-local.

The worker checks local logins before execution and approximately every two seconds while a
command runs. It uses logind seat/type information to distinguish local users from SSH sessions,
then local utmp terminals, falling back conservatively if those observations fail. A local login
terminates only the owned process group: TERM first allows a short checkpoint flush, followed
by forced cleanup. It does not interfere with the logged-in user or another user's processes.
Idle nodes are checked before their next operation rather than polled by the model.

After a confirmed login interruption, Pi finds a free replacement matching the saved capability
request and keeps the slot ID. If none is found within the bounded search, the slot is dropped.
The model receives a steering-style **data** notice for either outcome, with unmet capabilities
retained for a later acquisition attempt. Use a blocking job sleep if waiting is useful; avoid
repeated model/status polling. An empty pool remains a remote workspace and never falls back to
local execution. Old tunnel connections close when a slot is replaced or released.

Only the workstation mapping migrates. **A process does not survive migration or the CIP
24-hour lifetime limit.** Commands are bounded to 23 hours. Store periodic checkpoints and logs
on shared storage; inspect them and obtain fresh command approval to resume. Arbitrary failures
and uncertain SSH outcomes are never automatically replayed or treated as proof that work stopped.

If a CIP host cannot run bwrap, the existing UI asks for account-mode consent for the selected
account's bounded CIP pool. There is no silent fallback. Required offline or aggregate resource
guarantees still block when the remote backend cannot enforce them. Pool metadata persists with
the session; cleanup receipts retain each actor's actual host, including after migration.

## Implementation and validation

`controller.ts` owns session selection and lifecycle; `selection.ts` owns operator consent.
`operations.ts` prepares the reviewed execution plan. `ssh.ts` owns the fixed, sandboxed SSH client;
`host-keys.ts` refreshes public trust and implements CIP first-use trust.
`cip-pool.ts`, `cip-inventory.ts` and `cip-state.ts` own scheduling, capabilities and persistence.
`client.ts` carries request JSON on stdin without shell interpolation or replay. The static worker
bundle crosses the login shell as Base64, preserving quotes/backslashes under shells such as Fish. `tunnels.ts` supervises
bounded forwarding. The adjacent Python files separate process IO, scoped file operations, search,
command dispatch and the worker entrypoint. They use explicit imports and are bundled as an in-memory package so
nothing must be installed on the remote host.

The shared contracts/session bindings expose no model-facing execution bypass. Auto-Approval
retains its usual review/audit ordering and protects the remote implementation from project edits.
The test suite covers consent, stale selections, route inheritance, approval ordering, files,
bounds, cleanup, public Git identity and tunnel ownership. Real SSH metadata and forwarding can
be checked independently without executing unsandboxed project operations.
