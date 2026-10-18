# Pi Conversations

For module ownership, lifecycle and development checks, see the [architecture guide](../README.md).

This extension owns conversation control: `/continue`, `/goal`, `/side` and steering. It has no executor and cannot approve actions. Action review uses a session service supplied by the goal controller; the actual conversation history remains the source of user instructions.

## Resume interrupted work

`/continue` resumes the current task from its existing conversation context, including the latest
corrections and constraints. Use it after an interrupted run or temporary provider outage. It takes
no arguments; send changes to the task as ordinary messages. A continuing outage still needs to be
resolved; the command does not change providers, authentication, cooldowns or action permissions.

A paused `/goal` resumes through the same controller and independent completion checks as
`/goal resume`. Ordinary tasks receive a hidden continuation instruction, with no synthetic user
prompt and no raw slash command in model context. The original operator prompts remain authoritative,
including their language and prior action denials. The command resets the local progress guard.

An active Multiplex team receives the continuation in every member's session, even when viewing one
member. Existing ownership and action review remain in force. Busy members, pending input and
concurrent continuation requests cannot start duplicate runs. If a provider failure stopped the
team, enable `/multiplex <n>` again before continuing as a team; `/continue` does not recreate peers.
An empty conversation needs a task before it can continue.

## Continue until the goal is verified

`/goal <objective>` sets or replaces the session objective, including while the model or its tools are active. It updates the footer immediately after validation and steers the existing run at its next safe boundary; it does not abort work or start a second run. Superseded completion checks cannot settle the replacement goal. When the model finishes its response, the configured reviewer checks completion using the answer and recorded results of approved actions. A claim by the working model alone is insufficient for code changes or runtime checks.

The goal and its current state appear in the bottom status bar, including during completion review and while paused. Team size, when present, appears once before the goal; approval status follows it only during action review. Long or multiline goals are shortened to one display line. Review counts and the full objective remain available through `/goal status`; they are omitted from the compact footer. Exit and session replacement clear the status, which can then be restored from the selected session.

When work remains, the working model receives the reviewer's reason and continues automatically. Only a positive review marks the goal complete. A negative goal verdict does not try another reviewer; fallbacks apply only to technical unavailability. Every external action still requires its own approval and sandbox execution.

- `/goal` or `/goal status` shows the objective, state, reason and review count.
- `/goal <objective>` replaces the tracked target without requiring a prior stop.
- `/goal resume` continues a paused goal, including during ongoing work.
- `/goal stop` is an explicit operator cancellation and never claims completion. Escape, Ctrl+C and exit remain available.

On resume, the model receives the saved objective and latest valid independent completion feedback. Pause reasons and interface hints such as `/goal resume` remain operator status information. Each model request during an active goal contains exactly one current goal control message; older control messages are removed only from that request context. The saved transcript, actual user text and other extensions' messages remain intact. This also applies to existing sessions.

Review failures, invalid verdicts and interrupted model runs pause the goal. Restart, reload or session replacement restore a saved incomplete goal as paused. It resumes only with `/goal resume`; session shutdown has deleted its private `/tmp`. Session-tree navigation adopts the selected branch's goal state without restarting it automatically.

The session log records the objective, review attempts, deciding model, request ID, evidence fingerprint and usage. The original `/goal` instruction remains an operator instruction for action reviewers even when subsequent model turns have no new user prompt. Later user corrections still apply. Goals have no fixed turn count or total runtime limit; model costs can accumulate until verification or interruption.

## Agent-assigned goals

Working models can call `set_goal({goal: "..."})` directly. This changes session metadata only and
requires no action approval. The target appears in the same footer and uses the same independent
completion reviewer. Agents need an existing real operator task; a self-assigned target grants no
additional authority. It is stored with `source: "agent"`, excluded from operator-prompt history and
`operatorGoal` authorization, and labeled as self-assigned in model and completion-review context.
Legacy goals retain operator provenance.

An agent cannot replace an active operator goal or switch an unfinished agent goal to an easier
target. Repeating the same agent target is idempotent while running and resumes it when paused,
preserving its ID, check count and reviewer feedback. Only the operator can replace an unfinished
target, stop it, or impose new scope. Every external operation still needs `approved_action`.

Multiplex members share this session target. Any member can use the internal tool through the
parent controller; no peer gains authority over another. The shared completion snapshot waits for
all peer work and unread deliveries, including for agent-assigned goals. Interrupts and session
changes invalidate pending setters; a late tool cannot recreate a cancelled goal.

## Corrections during ongoing work

Operator input mode is captured from Pi's actual input event and bound to the accepted user entry
by its branch ID and content hash. It is not inferred from a `steering:` prefix, model summaries,
tool output or peer letters. Multiplex forwards the same operator mode to every peer, including
queued input; a peer's busy state cannot reclassify a new operator task as a correction.

Action reviews receive `userPromptInfo.inputKind` and `taskContext`. A recorded steering frame keeps
the original task and every later operator correction in chronological order, even beyond the
ordinary recent-prompt window. Pinning the task must not drop an older restriction and resurrect
broader permission. Large retained prompts use the existing compression cache and authoritative
original-lookup tools; capacity failures still fail closed rather than silently omitting constraints.
An active `/goal` remains a separate explicit objective.

Delivery mode does not determine semantic priority. Steering can add details, replace the task,
withdraw permission or stop work; later explicit restrictions and cancellations override earlier
scope. Reviewers consider the original task and applicable corrections together. The latest actual
prompt remains the language reference. Saved metadata survives continuation, reload and branch
selection. Older input without reliable metadata stays unclassified; no legacy role is invented.

A user message queued as steering supplements the ongoing task. Subsequent model requests remind the model to apply the correction and continue the remaining main work and validation. For ordinary tasks, the original request is recalled as quoted text of up to 4,000 characters; longer requests are explicitly labeled as excerpts. An active `/goal` remains the authoritative objective.

Actual user messages and their saved history remain unchanged. The reminder appears once in model context, is not stored as an additional user message and grants no tool permission. It applies only to the current task and resets on a new task or session. Explicit cancellation or task replacement remains possible. Follow-up messages are not automatically treated as steering.

Ordinary tasks receive this reminder without additional model turns or completion reviews. For `/goal`, the independent reviewer still checks the entire task, including subsequent corrections. Completing an intermediate correction is insufficient while main work remains.

## Side conversations with `/side`

`/side` opens a temporary conversation about the main conversation's contents. `/side <question>` immediately starts the first question. It works while the main model is busy without pausing it or switching sessions. The active goal, approved commands and private session `/tmp` remain in place. The window shows whether the main conversation is working or ready.

Before each side question, a fresh text snapshot is copied from the main conversation's current compacted context. It includes user and model text, tool calls and outputs, and summaries. Follow-up questions can therefore see work completed since the side chat opened. The side chat has its own in-memory history; its questions and answers are not written to the main history and grant the main model no additional assignments.

The side chat uses the model and thinking setting active when it opens. It has no file, shell or web tools and cannot make changes. It can explain existing results and answer questions about them. New work belongs in the main conversation.

- Enter sends a side question; subsequent questions remain in the same side chat.
- During a response, Escape cancels only the side request. Otherwise Escape closes the window. Ctrl+C or `/back` closes it immediately.
- PgUp/PgDn scroll through side history.
- `/new` inside the window clears only side history; the next question copies fresh main context.

Closing, session replacement or reload ends the side chat. It is not saved as a session file. Nested `/side` is rejected. This feature requires the interactive terminal interface.

The snapshot contains at most 40 complete text items and 24,000 UTF-8 bytes, or less for small model windows. Original task context and recent items are preferred; the window counts omitted items. Images and hidden main-model reasoning are not copied. A side question allows up to 8,000 characters; a response allows at most 4,096 tokens and three minutes. When conversation capacity is exhausted, Pi requests a fresh side history. The complete main history remains intact. Displayed side tokens and costs use provider-reported values and remain separate from main usage.

The behavior follows the [official Codex description of `/side`](https://learn.chatgpt.com/docs/developer-commands#start-a-side-chat-with-side).

## Loading and dependencies

The Pi launcher loads this extension independently of Auto-Approval. Startup links `node_modules` to Auto-Approval's pinned SDK dependencies. Regression tests currently run in the shared `../auto-approval` integration package: `bun run check` and `bun run test`.

## Repeated inspections without new evidence

A local progress guard observes completed approved actions separately from action approval. It does not ask the approval reviewer to assess productivity. Four consecutive inspection results containing only already observed evidence add one transient reminder to the working model's context. At eight repetitions the runtime aborts the run and pauses a running goal with completion explicitly unconfirmed. Automatic goal continuations do not reset that budget. A peer reaching the limit stops the whole Multiplex team, closes action leases and cancels its other members.

The guard recognizes read/search/list/web tools and conservative batches of ordinary shell inspection commands, such as Git status/diff/log, checksums, file excerpts and tool lookup. For shell batches it tracks hashes of output lines, catching reordered commands and subsets of earlier output. For other inspection tools it retains argument identity and the complete output hash, so new source targets and reordered file contents are fresh evidence. Approval display text, durations and reviewer prose are excluded; webpage-only tools retain their complete page text. No shell command is executed, rewritten or granted permission by this detector.

New evidence clears the repetition count. Writes, edits, builds and other actions outside the conservative inspection set reset the cache; they are not subject to a fixed work budget. Actual operator input, explicit `/goal resume` and session changes also reset it. Mailbox chatter neither counts as evidence nor requests approval. Warnings and halts are recorded with counts and reasons, while output hashes remain in bounded session-local memory (at most 4,096 entries and 64 KiB processed per observation).

This is a bounded heuristic for unchanged inspection loops, not a proof of semantic progress or a universal loop detector. Complex shell programs and large results are excluded. Legitimate repeated monitoring can trigger a pause; use a bounded foreground wait or provide new operator guidance rather than repeatedly re-establishing the same baseline. The pause creates no denial, completion claim, fallback model or exception to sandbox/action approval.
