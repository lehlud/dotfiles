# Pi Multiplex

`/multiplex <n>` starts a team of `n` equal working agents, currently 1–16 members. The visible agent counts as one member; `n - 1` additional Pi SDK sessions run concurrently. There is no lead agent or privileged messaging role. Names are single English words such as `otter`, `maple` or `comet`, selected using cryptographic randomness without replacement within each team. Different teams may reuse words; a name is a team-local address, not a globally unique identifier. All members start with the active conversation branch, system context, working model and thinking level.

The next actual user prompt and subsequent corrections reach every member. Members share the project workspace, use messageboxes to agree on task and file ownership, and exchange findings and reviews. The purpose is to parallelize independent work and improve review of complex results. Faster or better results are not guaranteed; agents must coordinate to avoid duplicate work and conflicts. Each active member incurs its own model usage.

- `/multiplex 4`: four members in total, including the visible member.
- `/multiplex` or `/multiplex status`: show names, team size and peer states.
- `/multiplex off` or `/multiplex 0`: stop the team and cancel peer work.
- Change the team size only while all members are idle.

The status bar shows `multiplex: n` once, before the goal when present, so team size remains visible on narrow terminals. Member names are shown in the live overview and `/multiplex status`. `/side` remains a separate explanatory conversation; side questions do not become team assignments.

## Watching the whole team

Multiplex opens a live overview with one row for every member, including the main transcript's member. Rows show whether an agent is ready, working, thinking, writing or running tools, together with a short preview of its streamed reply. Concurrent tool calls remain listed until each finishes. Streaming refreshes are coalesced over 80 ms; tool starts, completions and ready states update immediately. Approval explanations stay in the activity log.

All members' activity appears in the shared transcript under an automatically bound `Agent · name` header. Peer replies, tool calls, streaming tool output, results, failures and incoming messageboxes appear while peers work, rather than only when a final answer arrives. The main member's normal detailed transcript remains visible; its attributed activity records point there instead of repeating its output. Tool-output snapshots are coalesced to at most one per second per peer call. Long activity bodies are collapsed by default and expand with `ctrl+o`; individual activity previews are bounded to 64 KiB. The complete original output remains in the corresponding agent session. Tool argument previews copy only commands, paths, URLs and queries, not credential profiles or environment values.

These observations use rendered custom session entries. They are saved in the normal activity log, available to JSON/RPC consumers as `entry_appended` events, and never become model messages, peer messages, operator authorization or approval requests. There is no extra reviewer call or model turn for displaying activity. Final peer results still reach the main model through the separate peer-data channel without a duplicate visible answer. Member names come from the runtime session binding, never a claimed name in message text. Stopping, replacing or closing a team removes its live overview and subscriptions; saved log entries remain available.

## Messageboxes

The `mailbox` tool provides only these internal operations:

```json
{"operation":"peers"}
{"operation":"send","to":"otter","text":"I will handle parser.ts. Who can review its error paths?"}
{"operation":"send","to":"*","text":"Parser changes and local checks are complete; evidence is in the action log."}
{"operation":"inbox"}
```

`*` addresses every other member. Delivery and sequence numbers follow send order. Messages wake idle members and steer working members. A tool result confirms handoff, not processing by the receiving model. The inbox archive retains the last 128 received messages. Each message is limited to 16 KiB; each recipient can have up to 256 messages not yet observed in its model context. Full queues apply backpressure without partially accepting a broadcast. Message contents are neither edited nor submitted to a reviewer for approval. Auto-Approval returns immediately for `mailbox` without inspecting arguments or session services, creating an approval request or recording an approval audit. Multiplex alone owns sender binding, schema validation and delivery. Handoff is synchronous in memory and does not wait for another model's response. Pi may schedule internal messaging alongside a pending action review or sandbox command; external actions still run through their own serial approval/executor queue. A separate internal team ID prevents messages in an older transcript from acknowledging a new team's queue when word names are reused.

The extension binds the sender to the session and automatically fills `from`, `teamId`, `id` and `sequence` in the envelope and send receipt. The displayed `From` header uses this binding. A `from` tool argument is rejected; an identity claim inside `text` cannot override the actual sender. This authenticates the sending Pi session, not the truth of its message. Peer messages are explicitly peer data and never become actual user instructions or authorization. A member cannot configure the team or grant approvals to other members. A successful receipt confirms handoff; repeating the same status to seek another acknowledgement is unnecessary.

## Isolation, goals and lifecycle

Every external action by every member passes through the same Auto-Approval extension and mandatory sandbox executor. Network, additional path, Git configuration and credential permissions remain scoped to the reviewed action. Other external tools and nested external tool calls remain blocked. Internal messagebox operations are outside action review.

Members share project files but have independent conversation histories and private sandbox `/tmp` directories. Action decisions and result evidence transferred by the trusted broker remain separate from arbitrary message text. Action reviewers see peer denials as well; messages cannot override a denial. Evidence retains the original actor name, request ID and fingerprint so identical tool-call IDs from different sessions are not confused.

A shared `/goal` and feedback from its independent reviewer also reach peers. Completion review waits for ongoing peer work to settle. New peer work, messages or action results during goal review invalidate its older verdict; completion is reviewed again using current evidence. Goal review stays with the visible conversation and includes recorded peer action results; this grants the visible working agent no authority over peers. `/goal stop` also stops working peers when the visible member is already idle.

Exit, reload, session replacement or session-tree navigation stop the team and delete peer temporary data. Aborting the visible model run also stops the team. `/multiplex off` cancels work even when only peers are busy. Multiplex does not restart automatically after a session change. Peer transcripts live in memory; transferred results and decisions remain in the normal session log.

The launcher loads this extension separately. Startup links its SDK dependencies to Auto-Approval's pinned dependencies. Tests use synthetic providers in the `../auto-approval` integration package without contacting real model providers.

The compiled Pi loader can instantiate shared modules separately for each extension. Session services therefore use a process-wide registry keyed by session-manager identity so tool activation, goals and external-action evidence retain their bindings across loader copies. The regression suite also launches the installed compiled Pi through RPC with synthetic authentication and a local test provider. It checks actual peer delivery, automatically bound senders, rejection of forged `from` arguments, and continued blocking of direct external tools. A separate SDK test holds an external action reviewer open and verifies that a mailbox handoff completes before review is released. No reviewer is needed for internal messages. If the mailbox binding is unavailable, Multiplex itself reports that nothing was delivered and directs the model to report the runtime problem rather than retry or use `approved_action` for communication.
