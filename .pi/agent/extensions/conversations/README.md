# Pi Conversations

This extension owns conversation control: `/goal`, `/side` and steering. It has no executor and cannot approve actions. Action review uses a session service supplied by the goal controller; the actual conversation history remains the source of user instructions.

## Continue until the goal is verified

`/goal <objective>` starts the current working model with a concrete objective. When the model finishes its response, the configured reviewer checks completion using the answer and recorded results of approved actions. A claim by the working model alone is insufficient for code changes or runtime checks.

The goal and its current state appear in the bottom status bar, including during completion review and while paused. Team size, when present, appears once before the goal; approval status follows it only during action review. Long or multiline goals are shortened to one display line. Review counts and the full objective remain available through `/goal status`; they are omitted from the compact footer. Exit and session replacement clear the status, which can then be restored from the selected session.

When work remains, the working model receives the reviewer's reason and continues automatically. Only a positive review marks the goal complete. A negative goal verdict does not try another reviewer; fallbacks apply only to technical unavailability. Every external action still requires its own approval and sandbox execution.

- `/goal` or `/goal status` shows the objective, state, reason and review count.
- `/goal resume` continues a paused goal.
- `/goal stop` is an explicit operator cancellation and never claims completion. Escape, Ctrl+C and exit remain available.

On resume, the model receives the saved objective and latest valid independent completion feedback. Pause reasons and interface hints such as `/goal resume` remain operator status information. Each model request during an active goal contains exactly one current goal control message; older control messages are removed only from that request context. The saved transcript, actual user text and other extensions' messages remain intact. This also applies to existing sessions.

Review failures, invalid verdicts and interrupted model runs pause the goal. Restart, reload or session replacement restore a saved incomplete goal as paused. It resumes only with `/goal resume`; session shutdown has deleted its private `/tmp`. Session-tree navigation adopts the selected branch's goal state without restarting it automatically.

The session log records the objective, review attempts, deciding model, request ID, evidence fingerprint and usage. The original `/goal` instruction remains an operator instruction for action reviewers even when subsequent model turns have no new user prompt. Later user corrections still apply. Goals have no fixed turn count or total runtime limit; model costs can accumulate until verification or interruption.

## Corrections during ongoing work

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
