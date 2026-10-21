# Subagents

The working model can delegate bounded tasks through `subagent`. Each child runs
in its own Pi session, uses the parent's selected model/provider and has its own
Auto-Approval gate, sandbox and private temporary directory. The workspace is
shared. Assign explicit file ownership for implementation work.

Work alone by default. Spawning or resurrection requires an explicit operator
request for subagents, additional parallel agents or an independent second
opinion. A normal review request, task complexity, generic continuation or
Multiplex membership does not request more agents. Scope the work directly
first, then state the specific independent question and expected benefit before
an allowed spawn. Start one agent and reuse it; multiple agents require an
explicit request for multiple agents. Routine exploration, implementation,
tests and self-review stay with the working model. When uncertain, continue
alone rather than asking for delegation permission.

`usage-policy.ts` supplies this standing instruction on every main/member model
request, replacing obsolete copies without writing to the transcript. The tool
description also leads with the same restriction. This is model guidance, not
an automatic interpretation of user intent or a new runtime approval gate.

Start a new Pi process through `~/.local/bin/pi` to load this extension for the
first time. Existing processes started without it need a restart, not `/reload`.

| Operation         | Purpose                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `spawn`           | Start a child with `task`, optional `mode` and `timeoutSeconds`             |
| `list` / `status` | Read all children, or one `id`                                              |
| `send`            | Deliver `text` to an idle or running child by `id`                          |
| `wait`            | Wait up to 30 seconds for a child to become idle or stop                    |
| `kill`            | Abort a child by `id`, including pending review and execution               |
| `resurrect`       | Explicitly reopen a killed ID from its checkpoint; optionally supply `text` |

For example, a model may call:

```json
{
  "operation": "spawn",
  "mode": "review",
  "task": "Review src/parser.ts for concrete correctness defects. Read only; report file/line evidence."
}
```

The result includes a random English name and an opaque ID. Names and sender
identity come from the runtime. Children use `parent_mailbox` with `{ "text": "..." }`;
they cannot choose a sender or recipient, message other children, spawn more
agents or ask the user directly. The parent handles user questions. Both message
directions bypass action review and carry agent DATA, never user authorization.
Actionable mailbox notes appear immediately; final replies wake the parent.
Avoid acknowledgements, status loops and polling. Use automatic replies or `wait`.

The default `review` mode permits approved read/find/grep/ls, public web reads
and explicit prose checks. Command execution, edits, writes, credential execution
and writable path grants are blocked before paid review. Project/granted mounts
are also read-only at the sandbox boundary. Use `work` for command execution,
tests and implementation; every external action still needs its own independent
approval. A separate model session can provide an independent review, but it
inherits conversation context, including earlier conclusions; it is not a blind
review. Reports neither authorize actions nor replace completion verification.

The parent can use `/subagents` to see status and `/subagents kill <id>` to stop
one child. The compact activity table shows `starting`, `running` and `idle`.
Notes and final reports occupy a header and one preview line by default;
Ctrl+O expands the recorded text as Markdown. Routine successful actions stay
out of the feed. Failures remain visible and confirmed edits/writes retain
their regular file diffs. `/subagents log <id|name>` shows recorded activity,
including hidden action results, on the current branch. Reports and action
output are bounded to 24,000 characters per record; diffs to 48,000 characters.
The model still receives actionable notes and final reports immediately.
An answered child remains idle until sent more work or killed. Up to four children can be
live per parent, including idle sessions. A parent retains at most 32 IDs.
Lifetime is ten minutes by default, including idle time, configurable from
10 seconds to 30 minutes. Expiry stops the child, without automatic respawn.

Escape, Ctrl+C, RPC abort, session replacement and shutdown stop all children.
Cancellation invalidates queued deliveries before aborting model calls and
isolated work. Neither continuing the parent nor restoring history resurrects
children automatically. In Multiplex, every member may delegate within its
existing action lease; team interruption also stops its descendants.

Checkpoints are private files under `~/.pi/agent/subagents/<parent-session-hash>/`.
They preserve history and the SDK session ID across resurrection and extension
reload. IDs are valid only in their owning parent session/branch. New actual
operator instructions and relevant denials are synchronized on resurrection;
delegated task text is never converted into a user message. Checkpoints contain
conversation state, not private `/tmp` data. Killing a child deletes its private
temporary files; resurrection starts fresh storage and must recheck artifacts.
Cancellation does not roll back project files already written before the abort.

## Context and cache reuse

Children inherit the parent's conversation and shared instructions. Their role
is added as a later system section rather than changing the shared instructions.
Their executable capabilities remain restricted: a child has `parent_mailbox`
instead of `subagent`. These different tool declarations limit exact prefix
reuse, even when the instructions match.

`shared/providers/cache-affinity.ts` passes the parent's existing
`prompt_cache_key` hint to children using the same OpenAI provider, API and
model on a verified official endpoint. Multiplex members inherit the same
hint. Explicit custom keys and disabled caching are preserved; unsupported
routes receive no new parameters. The hint is persisted outside the model
transcript and survives checkpoint reload. Independent action reviews retain
their separate request path and policy.

Every child keeps its own SDK session ID, transport headers, WebSocket state,
response chain, cancellation and private storage. In particular, Codex's
ChatGPT gateway can derive affinity from the session header; sharing a body
hint alone does not reproduce that routing. Cache retention and service-tier
settings are unchanged. This is a best-effort hint, not a shared GPU cache,
a guaranteed cache hit or a measured usage saving.

OpenAI's [harness explanation](https://openai.com/index/gpt-5-6-frontier-intelligence-efficiency/)
describes append-only history and deterministic tool definitions. Its
[prompt caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching)
explains exact prefix requirements and provider-controlled routing/retention.
[Codex's client implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)
separates cache keys from lifecycle identity and gateway session headers.
The [Day 12 announcement](https://x.com/thsottiaux/status/2111244596131111253)
also describes server-side retention and routing improvements; this extension
cannot reproduce those by changing a cache key. Local SDK tests use synthetic
provider responses and verify request hints, retained instructions, distinct
capabilities/identities and resurrection. They do not measure live cache hits.

The child composition root is `child.ts`; `controller.ts` owns lifecycle, mailbox
routing and state transitions. `store.ts` owns private checkpoints, `context.ts`
safe context forking/operator synchronization, and `presentation.ts` the feed.
The shared child-session transport also serves Multiplex, so queued delivery,
compaction and late-start cancellation have one implementation. Auto-Approval
only recognizes internal metadata tools and enforces the read-only action scope;
it does not own spawning or session orchestration.
