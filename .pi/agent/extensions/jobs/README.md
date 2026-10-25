# Background jobs

Foreground is the default. Start a background command only when there is useful,
independent work to do alongside it. Starting a command and repeatedly checking
its status wastes model calls; use foreground execution or a blocking join.

The optional `background` field belongs to `approved_action`, alongside `tool`,
`arguments`, `goal`, `justification` and any `sandbox` request:

```json
{
  "tool": "bash",
  "arguments": { "command": "npm test", "timeout": 300 },
  "goal": "Validate the patch and update its documentation",
  "justification": "Run the tests while reviewing the independent documentation",
  "background": {
    "title": "Tests",
    "work": "Review the documentation changes while tests run"
  },
  "sandbox": { "tools": ["node"] }
}
```

Supported command tools: `bash`, `powershell`, `git`, `credential_exec` and
`container_exec`. Existing local, SSH and container execution routes keep their
approval, isolation, timeout, output handling and cleanup. Network, credentials
and mounts belong only to that command and its descendants. No shell `&`,
`nohup`, `disown`, arbitrary PID adoption or reusable permission grant is added.

## Model interface

- `job {operation: "wait", id?}` joins one job or all outstanding jobs until they
  finish. There is no polling timeout and no model request while blocked.
- `job {operation: "cancel", id}` aborts an owned job and awaits executor cleanup.
- `job {operation: "sleep", seconds}` suspends the model between genuinely
  necessary external observations, up to one day. Completion or actual user
  input wakes it early. Each subsequent external observation still needs its
  own approved action.

Completion is delivered once automatically, or returned by an already waiting
join. An idle actor resumes; a busy actor receives it at a safe boundary.
Command output is DATA, never operator authorization. There is deliberately no
model-facing `status` or `list` polling operation.

## Operator interface

`/jobs` lists session jobs. `/jobs wait <id>`, `/jobs output <id>` and
`/jobs cancel <id>` join, retrieve or stop a job. Output becomes available when
the command ends; redirect full logs to an approved project artifact when needed.
Completion output is collapsed by default and expands with Ctrl+O. The footer
shows `jobs: N` while jobs run.

Each actor owns at most four running jobs and retains up to 32 settled results.
Retained command output defaults to 64 KiB and is capped at 128 KiB for background
requests; executor output behavior is unchanged, including failures if a strict
control-output bound is exceeded. Use reviewed log redirection for noisy commands.
The normal command timeout remains in force; background mode does not extend it.

## Ownership and evidence

The gate persists the approval before admitting a job and transfers its
assignment lease to the supervisor until execution and cleanup finish. The
start receipt proves admission, not command success. The final result is
journaled against the original action receipt and propagated through the
existing authenticated peer/parent evidence broker. Jobs in progress prevent
goal completion; job changes invalidate stale goal reviews. Context projection/rotation
preserves the session supervisor, and each request includes its running job IDs.

Escape/Ctrl+C or RPC abort cancels owned jobs without scheduling cancellation
turns. Continued work may start new jobs after cleanup. Session switch, fork,
tree change, reload or exit closes the supervisor; cleanup finishes before
session-private `/tmp` is deleted. Jobs are not resurrected on reopen. Abrupt
host/process failure has the existing executor's cleanup guarantees, not durable
job recovery. A focused side conversation retains its own interrupt behavior.

`manager.ts` owns admission, completion, joins, timers and cancellation. `index.ts`
binds that supervisor to one session, its tool, UI and evidence journal. Shared
contracts expose supervision and result delivery without importing the feature
into Auto-Approval. Peer and child composition roots install their own supervisor.

Automated coverage lives in `auto-approval/tests/jobs*.test.ts`, the gate tests,
goal tests and native isolation tests. SDK tests use a synthetic provider and
controlled dispatch; native tests use real bwrap execution separately. The
opt-in semantic review evaluation proposes commands to the configured reviewer
without executing them.
