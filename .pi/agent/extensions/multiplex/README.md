# Pi Multiplex

`/multiplex <n>` starts a team of `n` equal working agents, currently 1–16 members. The visible agent counts as one member; `n - 1` additional Pi SDK sessions run concurrently. There is no lead agent or privileged messaging role. Names are single English words such as `otter`, `maple` or `comet`, selected using cryptographic randomness without replacement within each team. Different teams may reuse words; a name is a team-local address, not a globally unique identifier. All members start with the active conversation branch, system context, working model and thinking level.

The next actual user prompt and subsequent corrections reach every member. Members share the project workspace, use messageboxes to agree on task and file ownership, and exchange findings and reviews. The purpose is to parallelize independent work and improve review of complex results. Faster or better results are not guaranteed; agents must coordinate to avoid duplicate work and conflicts. Each active member incurs its own model usage.

- `/multiplex 4`: four members in total, including the visible member.
- `/multiplex` or `/multiplex status`: show names, team size and peer states.
- `/multiplex off` or `/multiplex 0`: stop the team and cancel peer work.
- Change the team size only while all members are idle.

The status bar shows `multiplex: n` and the visible member's name. During a `/goal`, the team size also appears at the start of the goal status so it remains visible on narrow terminals. Peer answers appear with their sender in the activity log. `/side` remains a separate explanatory conversation; side questions do not become team assignments.

## Messageboxes

The `mailbox` tool provides only these internal operations:

```json
{"operation":"peers"}
{"operation":"send","to":"otter","text":"I will handle parser.ts. Who can review its error paths?"}
{"operation":"send","to":"*","text":"Parser changes and local checks are complete; evidence is in the action log."}
{"operation":"inbox"}
```

`*` addresses every other member. Delivery and sequence numbers follow send order. Messages wake idle members and steer working members. A tool result confirms handoff, not processing by the receiving model. The inbox archive retains the last 128 received messages. Each message is limited to 16 KiB; each recipient can have up to 256 messages not yet observed in its model context. Full queues apply backpressure without partially accepting a broadcast. Message contents are neither edited nor submitted to a reviewer for approval. A separate internal team ID prevents messages in an older transcript from acknowledging a new team's queue when word names are reused.

The extension binds the sender to the session and automatically fills `from`, `teamId`, `id` and `sequence` in the envelope and send receipt. The displayed `From` header uses this binding. A `from` tool argument is rejected; an identity claim inside `text` cannot override the actual sender. This authenticates the sending Pi session, not the truth of its message. Peer messages are explicitly peer data and never become actual user instructions or authorization. A member cannot configure the team or grant approvals to other members. A successful receipt confirms handoff; repeating the same status to seek another acknowledgement is unnecessary.

## Isolation, goals and lifecycle

Every external action by every member passes through the same Auto-Approval extension and mandatory sandbox executor. Network, additional path, Git configuration and credential permissions remain scoped to the reviewed action. Other tools and nested tool calls remain blocked. Only internal messagebox operations bypass action review.

Members share project files but have independent conversation histories and private sandbox `/tmp` directories. Action decisions and result evidence transferred by the trusted broker remain separate from arbitrary message text. Action reviewers see peer denials as well; messages cannot override a denial. Evidence retains the original actor name, request ID and fingerprint so identical tool-call IDs from different sessions are not confused.

A shared `/goal` and feedback from its independent reviewer also reach peers. Completion review waits for ongoing peer work to settle. New peer work, messages or action results during goal review invalidate its older verdict; completion is reviewed again using current evidence. Goal review stays with the visible conversation and includes recorded peer action results; this grants the visible working agent no authority over peers. `/goal stop` also stops working peers when the visible member is already idle.

Exit, reload, session replacement or session-tree navigation stop the team and delete peer temporary data. Aborting the visible model run also stops the team. `/multiplex off` cancels work even when only peers are busy. Multiplex does not restart automatically after a session change. Peer transcripts live in memory; transferred results and decisions remain in the normal session log.

The launcher loads this extension separately. Startup links its SDK dependencies to Auto-Approval's pinned dependencies. Tests use synthetic providers in the `../auto-approval` integration package without contacting real model providers.

The compiled Pi loader can instantiate shared modules separately for each extension. Session services therefore use a process-wide registry keyed by session-manager identity so the gate and mailbox share the same live binding across loader copies. The regression suite also launches the installed compiled Pi through RPC with synthetic authentication and a local test provider. It checks actual peer delivery, automatically bound senders, rejection of forged `from` arguments, and continued blocking of direct external tools. No reviewer is needed for internal messages. If the mailbox binding is unavailable, the gate explicitly reports that nothing was delivered and directs the model to report the runtime problem rather than retry or use `approved_action` for communication.
