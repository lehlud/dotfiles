# Pi Multiplex

`/multiplex <n>` starts 1–16 equal agents: one terminal SDK session and n−1 concurrent
sessions, all in the shared feed. No leader. Cryptographically random English word names
are unique per team, reusable across teams. Members inherit branch/system/model/thinking,
receive all actual user prompts/corrections and share project files, not histories or `/tmp`.

The aim is independent parallel work and review, not more conversation. Send only needed
questions, blockers, conflicts, findings and evidenced deliverables to relevant peers;
broadcast only team-wide information. Avoid duplicate work/status/acknowledgements/polling.
Speed/quality are not guaranteed and each active member incurs model usage.

`TeamController` handles commands, peer creation/replacement and UI registration.
`TeamSession` owns delivery queues, parent service bindings, goal broadcasts and
quiescence. Stopping closes admissions synchronously before asynchronous peer cleanup.
`peer.ts` remains the explicit policy/tool composition root, using named construction options.

| Command                  | Effect                                  |
| ------------------------ | --------------------------------------- |
| `/multiplex <n>`         | Start/resize; resize only when all idle |
| `/multiplex [status]`    | Names, size, states                     |
| `/multiplex interrupt`   | Cancel everyone; pause running goal     |
| `/multiplex off` or `0`  | Stop team/work                          |
| `/multiplex-view <name>` | Individual feed                         |
| `/multiplex-view [all]`  | Shared feed (default)                   |

Footer size appears once before any goal. The aligned Agent/State/Activity table shows
all members regardless of view. Views change no sessions/context/routing: user input
still reaches everyone. `/side` questions remain explanatory, not assignments.

## Watching the whole team

Runtime-bound `Agent · name` headers/color identify replies, actions, output, failures and
diffs. Colors persist in records. Working/thinking/ready states stay in the table, without
reasoning in the feed. Streaming refresh coalesces over 80 ms; starts/completions/ready update
immediately. Native rows wholly replaced by feed records reserve zero height, preventing
bottom gaps. Guarded hooks support compiled/SDK loader copies, restore on reload/shutdown and
leave unknown layouts, unrelated text/errors and input dock intact.

A send appears once with sender/recipients/plain text; a broadcast is one entry. Incoming
receipts/raw JSON IDs are hidden; inbox queries show counts. Confirmed approved edits/writes
use padded native numbered diffs: red removals, green additions, word highlights; writes
show full frozen contents as additions. Ten-line previews expand normally. No host prereads
or success diffs for failed/denied actions; arbitrary shell writes do not fabricate diffs.
Approval explanations remain separate log entries.

Long text collapses with Ctrl+O; previews are bounded to 64 KiB. Tool snapshots coalesce to
one/second/call; originals stay in actor sessions. Arguments preview command/path/URL/query,
not credential profiles/environment. Custom activity emits RPC entry_appended; filtering
reserves no gaps and retains hidden actors. Observations never enter model/mail context or
authorize actions. Separate peer-data delivery shares final results without duplicate answers.
Reload restores activity/colors; stopping/replacing removes live table/timers/subscriptions.

## Agreeing work before actions

Before **any external action**, including initial ls/read, unanimously accept one split.
Any peer proposes mailbox plan; proposer auto-accepts, others accept that exact ID or withdraw
conflicts. Each name gets a distinct concrete task, resources and optional waiting:true.
Resources name owned files/subtrees or discovery/check scopes; overlap/duplicate tasks fail.
Assign shared discovery/expensive checks to one owner; insufficient context means others wait
for findings, not repeat investigation under cosmetic labels.

```json
{"operation":"plan","assignments":[{"name":"otter","task":"Inspect repository/roadmap once","resources":["discovery"]},{"name":"maple","task":"Wait for findings","resources":[],"waiting":true}]}
{"operation":"accept","planId":"proposed ID"}
{"operation":"withdraw","planId":"conflicting ID"}
```

Work within assigned scope, preserve edits, and update splits unanimously after current
actions finish. Plans coordinate locally, never grant mounts/authority or enter reviewer
assignment metadata. External work waits for agreement/non-waiting status; leases pin
assignments through review and recheck before execution. Closed teams cannot use old approvals.
Proposals/final acceptance wake needed planning; intermediate acceptance sends no acknowledgement
broadcast. peers and model requests supply coordination state without polling.

## Messageboxes

```json
{"operation":"peers"}
{"operation":"send","to":"otter","text":"Parser tests are ready; please review error paths.","wake":true}
{"operation":"send","to":"*","text":"Shared checks passed; evidence is in the action log."}
{"operation":"inbox"}
```

`*` addresses other members. Synchronous in-memory handoff confirms delivery, not processing,
and proceeds alongside review/execution. Routine sends start no turn; busy recipients see
messages at safe boundaries, idle ones on next work. wake:true is for actionable requests,
findings/deliverables and dependency-ready reports, never status/receipts. Let finished peers rest.

Limits: 16 KiB/message, 256 unobserved/recipient, 128 received in archive. Full queues apply
backpressure without partial broadcast. Runtime fills from/teamId/id/sequence; forged from
arguments fail, prose claims cannot change sender. Old team IDs cannot acknowledge new queues
with reused names. Authenticity proves session origin, not truth. Unedited/unreviewed peer DATA
is never operator instruction, permission, execution proof or denial override. Members cannot
resize teams/grant approvals. Missing bindings report nondelivery, not a reason to use
approved_action or retry communication. Auto-Approval returns immediately without examining
mail arguments/services, creating review requests or audits.

Actual operator input broadcasts independently of view/backpressure, including idle/compaction
boundaries. Compacting peers retain input until done without replaying actions; shutdown cancels
late starts. Busy state cannot reclassify the user's delivery mode.

## Isolation, goals and lifecycle

Each external action uses mandatory review/isolation; grants for network/path/Git/credentials
remain per-action, direct/nested routes blocked. Broker-transferred results/decisions retain actor,
request ID and fingerprint, separate from arbitrary letters; reviewers see relevant peer denials.
This prevents equal tool-call IDs across sessions confusing evidence.

Running goals recover unread mail eventfully when any member settles, once per new batch and
only for recipients with unobserved data. Outside goals passive mail stays passive. Settled
checkpoints use shared mailbox/action progress, not final-reply counts, without polling. Paused/
stopped/closed teams never revive. Shared goals/feedback reach all peers; permissible set_goal
requires independent goal-proposal approval before creating self-assigned metadata, never
authority/replacement. Peer calls use the same parent-owned gate; mailbox messages cannot approve
a goal. Completion waits for peer work/mail;
new work/messages/results invalidate older verdicts. No member gains power over another.

Escape, Ctrl+C, RPC abort, /goal stop, off, reload, exit and session replacement/tree navigation
cancel all peers/descendants/queued starts even with idle terminal actor or individual view.
Goals pause for explicit resume. RPC observation reads no unrelated commands and detaches on
reload/shutdown. Teams never restore automatically. Peer transcripts stay in memory; transferred
results/decisions/activity persist. Shutdown removes peer temporary data.

## Failed model requests and malformed actions

Any member's model failure closes team/mail/leases, cancels peers and pauses goals. Partial
failed replies are not completed results. Failure records once; cleanup precedes a new team,
including during plan acceptance, preventing missing-member deadlocks. Checkpoints cannot revive it.
Three consecutive malformed approved_action calls by one member also stop the team. Count SDK/
strict preflight failures; valid requests reset, reviewer denials/command failures do not count.
Encoded argument objects decode before strict review; bare commands are never repaired/executed.
Resolve problems, recreate `/multiplex <n>`, then explicitly resume goals. Provider refusals
are final, never rephrased/rerouted to evade safeguards.

Each member's Conversations progress guard warns then stops the team for unchanged inspections,
including while others work/wait. This is separate from approval and does not censor mail.
See [guard details](../conversations/README.md#repeated-inspections-without-new-evidence).

The launcher loads Multiplex separately with shared pinned SDK links. Process-wide registries
preserve bindings across compiled loader copies. Synthetic provider/compiled-Pi RPC tests cover
concurrent prompts/steering, authenticated FIFO/forgery checks, real isolated files/private tmp,
direct-route denial, interrupt/reload/goals, and mail while an external review is held. No real
model auth is needed. See the [architecture guide](../README.md).
