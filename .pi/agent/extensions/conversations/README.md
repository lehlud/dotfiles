# Pi Conversations

This extension owns continuation, goals, steering, questions, side chats and progress
tracking. It cannot execute or approve actions. Actual user history remains authoritative;
review context is supplied through the session service. See the [architecture guide](../README.md).

`GoalController` owns commands, activation and cancellation. `goal-state.ts` restores
checkpoints and independent feedback; `GoalCompletion` owns one evidence snapshot,
stale-result checks and completion auditing. It returns a decision to the controller
and cannot activate a goal or grant execution permission.

## Queueing a prompt

While busy, **Tab** queues a nonempty draft as a native follow-up after the current reply;
**Enter** steers at the next model boundary. Existing pending-message display, history,
pasted-text expansion, dequeue and follow-up shortcuts remain. Tab completes when idle or
with an open completion menu; **Shift+Tab** completes while busy. Slash commands keep native
dispatch. Queued input is ordinary operator input, not steering or approval bypass.
Questions keep their own Tab controls; finishing them restores the normal draft/history.
Session changes/shutdown restore the preceding editor. RPC/print keyboard handling is unchanged.

## Clarification questions during a run

`ask_user` accepts 1–3 questions: short `header`, `question`, optional `options` with
`label`/optional `description`. IDs return immediately; continue independent work. Ask
necessary decisions only, never secrets; withdraw obsolete questions. Silence/dismissal
is not permission or an answer. Do not poll.

Pending questions replace the prompt editor until answered, discarded or withdrawn.
Arrows/Enter select; Tab enters free text; Ctrl+X discards one, with discard-all for several.
Ctrl+O expands full descriptions; Escape still interrupts. Existing drafts are preserved,
never submitted as answers. Blank lines separate questions/options/guidance; accent marks
selection, muted text marks descriptions. Narrow terminals show compact selected details.

`user_questions` lists owned questions or withdraws `ids` with `operation: withdraw`.
Identical pending questions reuse IDs. Limits: 12 pending, 128 retained; session journaling
restores state on reload/branch selection and rejects stale-session callbacks.
Answers become genuine operator steering, quoting the question; answer prose sets language.
Dismissal is a notification, not an invented user answer. Neither tool needs action review
or grants external access. Multiplex shares the panel and broadcasts answers/dismissals to
all members regardless of view; runtime-bound requesters cannot withdraw others' questions.

RPC/command interface: `/questions`, `/questions answer <id> <text>`,
`/questions discard <id|all>`. The editor itself requires TUI mode.

## Resume interrupted work

`/continue` takes no arguments and resumes saved work with current corrections/constraints.
It sends a hidden instruction, never a synthetic user prompt or raw slash command. Existing
operator intent/language and action concerns remain; the local progress guard resets.
Paused goals use the `/goal resume` controller and independent checks. It changes no provider,
login or action permissions; explicit resume may trigger the bounded early availability probe
in [Provider Recovery](../provider-recovery/README.md).

Active Multiplex receives continuation in every session, including in individual views.
Busy members/pending input/concurrent requests cannot start duplicate runs. A failed team
must be recreated with `/multiplex <n>`; continuation does not recreate peers. Empty history
needs a task first.

## Continue until the goal is verified

| Command                   | Effect                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/goal <objective>`       | Set/replace even during work; update footer and steer at the next safe boundary, without aborting or duplicating runs    |
| `/goal` or `/goal status` | Objective, state, reason and review count                                                                                |
| `/goal resume`            | Resume a paused goal, including during ongoing work                                                                      |
| `/goal stop`              | Operator cancellation, never completion; interrupts remain available                                                     |
| `/goal drop`              | Remove target/verification/automatic goal continuation without stopping model, team or children; absent goal is harmless |

After a response, the configured reviewer checks the whole goal and applicable later
constraints against answers and recorded approved results. Code/runtime completion needs
concrete evidence, not working-model claims. An actionable negative verdict feeds missing
work back for continuation. Positive review removes the goal/footer/current instruction;
historical evidence remains. A denial never tries another reviewer; technical unavailability
uses the configured model's recovery only. External actions retain separate approval.

Completion requires boolean `blocked`: false for actionable work; true only when no useful
authorized work remains without named external input/change. True pauses as `Goal waiting`
once, without another work/review loop; resume after resolving it. Missing/contradictory
metadata pauses verification. This flag belongs only to completion, not action/compression
verdicts. Neither a blocker nor a goal verdict clears an action denial.

One current goal instruction appears per request; obsolete runtime copies are filtered,
not deleted from saved history. Resume includes objective and latest valid review feedback,
not UI commands/pause hints. Superseded checks cannot settle replacements. Dropping persists
and cannot be undone by resume; main/peer/child instructions update next request. Review
failure, invalid verdict or interrupted work pauses. Restart/reload/branch selection restores
unfinished/stopped goals paused, never auto-running; session shutdown deletes private `/tmp`.

The compact footer shows team size once, shortened single-line goal/state and approval only
during review; full text/counts remain in status. Shutdown clears it. Audits retain objective,
reviewer, request ID, fingerprint, attempts and usage. Operator goals remain authorization
through automatic continuation, subject to later corrections. No fixed turn/runtime cap
limits goal costs; interruption remains available.

## Agent-assigned goals

Every `set_goal({goal: "..."})` call requires independent approval before changing metadata,
including repeats and resumes. The configured reviewer checks the full user task: omitted
outcomes, weaker validation or trivial substitute goals are rejected. Only an explicitly requested
bounded target may become a subgoal. This goal-integrity check does not impose implementation
preferences on ordinary action approval. Operator `/goal` commands remain authoritative.

Approval and its exact request/fingerprint are recorded before activation. Denial, invalid output,
missing reviewer access, audit failure, cancellation or changed instructions leave the goal
unchanged. Completion is still reviewed separately using the same footer/checks.
An existing real operator task is required. `source: agent` labels the
self-assigned target as DATA, excludes it from genuine-user history/`operatorGoal`, and grants
no authority. Legacy goals retain operator provenance.

Agents cannot replace an active operator goal or simplify an unfinished agent target.
Repeating the same target is idempotent when running, resumes when paused, and retains ID,
checks and feedback. Only operators replace unfinished targets, stop them or impose scope.
Multiplex shares the target through the parent controller without peer privilege. Completion
waits for peer work/unread deliveries. Interrupt/session changes invalidate late setters.
After an operator stop/drop, an agent cannot recreate tracking from old instructions alone.
Later actual user instructions are reviewed in context rather than treated as automatic permission.

`bun run eval:goal-proposals` in `../auto-approval` runs five paid, review-only cases against
the configured reviewer: faithful/full and explicitly bounded targets, trivial substitutes,
weakened validation and invented user permission. No goal or external action is applied.

## Corrections during ongoing work

Actual Pi input events bind delivery mode to branch entry ID/content hash, never quoted
`steering:` labels, summaries, outputs or peer letters. Multiplex preserves the mode even
across busy/queued delivery. Legacy inputs remain unclassified.

Reviewers receive `userPromptInfo.inputKind`, tri-state `isSteering` and `taskContext`.
The retained task plus every later instruction may exceed the recent-prompt window; compression
keeps original lookup available and capacity failures fail closed. An active operator goal
remains explicit. Delivery mode alone sets no priority: ordinary/steering input can add,
replace, restrict or cancel work. Consider all applicable instructions; latest actual prose
sets verdict language.

Steering reminds the model to apply corrections and continue remaining work/validation.
Ordinary-task reminders quote up to 4,000 characters of the request, labeling excerpts;
active goals retain their objective. The transient reminder appears once, changes no user
history/permissions, resets on a new task/session and adds no model turns or completion
checks. Follow-ups are not automatically steering. Goal review still covers the whole task,
not merely the intermediate correction.

## Side conversations with `/side`

`/side [question]` opens a temporary TUI chat while main work continues. Each question copies
fresh text from current main context: users, replies, tool calls/results and summaries.
Separate in-memory side history neither assigns main work nor changes goals, approvals or
private `/tmp`. Model/thinking are captured on open; no files, shell, web or mutations are
available. The window shows main working/ready state.

Enter sends; PgUp/PgDn scroll. Escape cancels a running side response, otherwise closes;
Ctrl+C or `/back` closes immediately. `/new` clears side history before the next snapshot.
While the side panel has focus, these keys leave main/Multiplex/subagent work running.
Submitting during a reply preserves the next draft; it does not queue another request.
Rejected input stays editable. Short terminal layouts prioritize the composer and cursor.
Close/reload/session replacement discards the chat, including pending startup;
nested `/side` is rejected. Failed/cancelled responses are excluded from side history.

Limits: 40 complete text items/24,000 UTF-8 snapshot bytes (less for small windows), preferring
original task/recent text and counting omissions; no images or hidden reasoning. Questions:
8,000 characters. Responses: 4,096 tokens/three minutes. Exhaustion requests fresh side
history without altering main history; provider-reported side usage is counted separately.
See the [Codex interface reference](https://learn.chatgpt.com/docs/developer-commands#start-a-side-chat-with-side).

## Repeated inspections without new evidence

A local guard, separate from approval, warns after four unchanged inspections and aborts at
eight, pausing goals with completion unconfirmed. Automatic goal continuation does not reset
it; a spinning peer stops the team and invalidates leases. Mailbox chatter is not evidence.

Read/search/list/web and conservative shell inspection batches are tracked. Shell output-line
hashes catch reorderings/subsets; other tools use argument identity plus complete output hash,
so new targets/reordered source are fresh. Approval prose/timing are excluded; page-only output
is retained. This detector executes/rewrites/authorizes nothing.

New evidence, non-inspection work (edits/builds), actual user input, explicit resume and session
changes reset it. Counts/reasons are logged; hashes stay bounded in memory (4,096 entries,
64 KiB/observation). Complex programs/large outputs are excluded. This heuristic can pause
legitimate monitoring: prefer bounded foreground waits/new guidance. It creates no denial,
completion, fallback model or sandbox exception.

## Loading and dependencies

The launcher loads Conversations separately; startup links the shared pinned SDK.
Run `bun run check` and `bun run test` in `../auto-approval`.
