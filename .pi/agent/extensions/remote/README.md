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

## Implementation and validation

`controller.ts` owns session selection and lifecycle; `selection.ts` owns operator consent.
`operations.ts` prepares the reviewed execution plan. `ssh.ts` owns the fixed, sandboxed SSH client;
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
