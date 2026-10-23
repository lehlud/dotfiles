# Subagents

Subagents are a niche delegation tool. **Work alone by default**, including ordinary
exploration, implementation, tests and self-review. Spawn/resurrect only for explicit
operator requests for subagents, additional parallel agents or an independent second
opinion. Ordinary reviews, complexity, continuation and Multiplex membership do not qualify.
Scope first and state the independent question/benefit; start one and reuse it. Multiple
agents need an explicit multiple-agent request. If unsure, continue alone without asking.
`usage-policy.ts` supplies this rule each request without altering history; the tool repeats
it. This is guidance, not a new authorization gate. Initial loading requires a new launcher
process, not `/reload` if the extension was absent.

| Operation         | Purpose                                                         |
| ----------------- | --------------------------------------------------------------- |
| `spawn`           | `task`, optional `mode`, `timeoutSeconds`                       |
| `list` / `status` | All children / one `id`                                         |
| `send`            | `id`, `text`; wake idle or steer running work                   |
| `wait`            | Await settlement, up to 30 seconds                              |
| `kill`            | Abort ID, including review/execution; delete private tmp        |
| `resurrect`       | Explicitly reopen killed ID/history, optional `text`; fresh tmp |

```json
{
  "operation": "spawn",
  "mode": "review",
  "task": "Review src/parser.ts for concrete defects. Read only; report file/line evidence."
}
```

The runtime assigns a random English name and opaque ID. Children use `parent_mailbox`
with `{ "text": "..." }`; no chosen sender/recipient, peer messages, nested agents or direct
user questions. The parent handles questions. Messages bypass action review as DATA, never
authorization. Actionable notes/final replies reach the parent immediately; finals wake it.
Avoid acknowledgements/status loops; use automatic replies or `wait`.

Default `review` allows approved reads/searches/listings, public web reads and prose checks.
Execution, edits/writes, credentials and writable grants fail before paid review; mounts are
read-only. `work` permits execution/tests/implementation with independent review per action
and explicit ownership in the shared workspace. Separate model context is not a blind review:
inherited conversation includes prior conclusions. Reports grant no action/completion approval.

## Display and lifecycle

`/subagents` shows status; `/subagents kill <id>` stops one; `/subagents log <id|name>` shows
bounded activity on the current branch. The table shows starting/running/idle. Notes/finals
use a header plus one preview line, expandable as Markdown with Ctrl+O. Routine successes
stay out of the feed; failures and confirmed edit/write diffs remain. Activity records retain
24,000 characters each, diffs 48,000; model delivery remains immediate.

Limits: four live children including idle, 32 retained IDs per parent. Default lifetime is
10 minutes including idle, configurable 10 seconds–30 minutes. Expiry stops without respawn.
Answered children remain idle until sent work/killed.

Escape, Ctrl+C, RPC abort, session replacement and shutdown cancel all children and queued
starts/deliveries before aborting model/isolation work. Continuing/restoring the parent never
automatically resurrects them. Multiplex descendants retain their parent's action lease and
stop with the team. Cancellation cannot roll back already-written project files.

Private checkpoints under `~/.pi/agent/subagents/<parent-session-hash>/` retain history/SDK
session ID through resurrection/reload, scoped to the owning parent session/branch. Resurrection
synchronizes actual new user instructions/relevant denials; delegated task text never becomes
user authorization. Checkpoints exclude `/tmp`; recheck artifacts after fresh storage.

## Context and cache reuse

Children inherit conversation/shared instructions, adding a later role section. Their different
tools (`parent_mailbox` instead of `subagent`) limit exact-prefix reuse. Shared cache-affinity
passes a parent's OpenAI hint only on the same provider/API/model at a verified official endpoint;
Multiplex does likewise. Explicit custom keys/cache-off and unsupported routes remain unchanged.
Hints persist outside the transcript through checkpoint reload; action reviews keep a separate path.

SDK identity, headers, WebSocket state, response chains, cancellation and storage stay separate.
A body cache hint cannot reproduce gateway session-header routing, extend retention or guarantee
GPU cache hits/savings. Synthetic tests verify hints, retained instructions, distinct capabilities/
identities and resurrection, not live cache efficiency.

References: [OpenAI harness](https://openai.com/index/gpt-5-6-frontier-intelligence-efficiency/),
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Codex client](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs),
[Day 12 announcement](https://x.com/thsottiaux/status/2111244596131111253).
Server retention/routing improvements cannot be recreated by a client key alone.

`child.ts` composes sessions; `controller.ts` owns lifecycle/mail/state, `store.ts` checkpoints,
`context.ts` safe inheritance, `presentation.ts` the feed. Shared transport serves Multiplex too.
Auto-Approval recognizes internal metadata and read-only restrictions, not spawning/orchestration.
See the [architecture guide](../README.md).
