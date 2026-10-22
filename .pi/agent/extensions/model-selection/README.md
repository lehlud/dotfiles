# Model selection

New sessions restore the last selected working model **and its thinking level** as one pair.
Native `/model`, `/thinking`, model cycling and thinking shortcuts update that preference.
Resuming, forking or reloading a conversation preserves its own selection; restoring an old
conversation does not silently replace the default for new sessions.
Once that conversation actually runs again, its working pair becomes the last used preference.

`/reviewer` opens a searchable model selector for the primary reviewer, followed by its supported
thinking levels. Search by provider, model ID or display name; use arrows and Enter to select.
The current choices are preselected. Escape at either step cancels without saving anything.
Browsing does not change the working model, start a provider request or interrupt ongoing work.
Once both choices are confirmed, the preference is saved and follows the existing turn-boundary rules.

The selector uses the loaded model catalog for providers with configured authentication, like
the working-model selector. Use `/login` to add providers. RPC clients receive equivalent native
selection requests; headless invocations can use the explicit commands below.

`/reviewer add` opens the same flow for a new fallback; `/reviewer edit 2` edits the second entry.
`/reviewer set` also opens the primary selector. `/reviewer list` prints the current chain.
Explicit model IDs and thinking levels remain supported:

```text
/reviewer list
/reviewer add
/reviewer edit 2
/reviewer set openai/gpt-6-luna medium
/reviewer add openrouter/deepseek/deepseek-v4.1-flash-1017 medium
/reviewer thinking high
/reviewer thinking low 2
/reviewer move 2 1
/reviewer remove 2
```

Indices start at one. `set` replaces the primary and preserves fallbacks; `add` appends a fallback.
Supply the thinking level explicitly when changing to a model with different capabilities.
The level defaults to the current primary's level, or `off` when no primary exists.
Selections must exist in the model catalog and support the requested thinking level.
Authentication is checked again at use time. Unavailable authentication is shown in the list;
it does not prevent preparing a fallback before login. The final reviewer cannot be removed.

The ordered chain is shared by action, completion, editorial and prompt-compression reviews.
A denial remains final. Changing the list cannot replace a reviewer during an in-flight check,
or retroactively change a verdict. Fallbacks still serve availability failures only.

While the agent works, native model/thinking changes take effect for its next model response,
at the same boundary used to insert steering. Reviewer changes are queued for the next turn;
all actions of a turn retain its reviewer snapshot. Changes made while idle apply immediately.
Peers and subagents inherit these preferences at their own boundaries without gaining commands
or permission to change global defaults. Already-started requests are not cancelled.

`/fast on` and `/fast off` apply directly before the next provider request, including later
reviewer lookup rounds. A request already submitted retains its settings. The footer displays
model, thinking level and `fast` together; inactive fast mode adds no label or status row.
Fast mode still starts off in a fresh session and restores its own conversation branch state.

Preferences live under `~/.pi/agent/state/model-selection/`, or the corresponding
`PI_CODING_AGENT_DIR`. `working.json` stores one pair; `reviewers.json` stores the ordered
chain. Atomic, owner-only files keep concurrent working/reviewer updates independent.
They persist across restarts, are excluded from Git and are protected from model actions with
the rest of the agent directory. Only operator commands change review choices.
Invalid saved state blocks loading rather than selecting a different reviewer.

`auto-approval.json` retains sandbox and review-context settings and rejects `reviewers`.
On a device without saved reviewer state, Pi starts so `/reviewer set` can configure it;
independent checks cannot succeed until a reviewer is selected. Other devices need their own
initial selection. No model request is needed to change or inspect preferences.
