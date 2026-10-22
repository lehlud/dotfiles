# Model selection

New sessions restore the last selected working model **and its thinking level** as one pair.
Native `/model`, `/thinking`, model cycling and thinking shortcuts update that preference.
Resuming, forking or reloading a conversation preserves its own selection; restoring an old
conversation does not silently replace the default for new sessions.
Once that conversation actually runs again, its working pair becomes the last used preference.

`/reviewer` opens a searchable model selector for the reviewer, followed by its supported
thinking levels. Search by provider, model ID or display name; use arrows and Enter to select.
The current choices are preselected. Escape at either step cancels without saving anything.
Browsing does not change the working model, start a provider request or interrupt ongoing work.
Once both choices are confirmed, the preference is saved and follows the existing turn-boundary rules.

The selector uses the loaded model catalog for providers with configured authentication, like
the working-model selector. Use `/login` to add providers. RPC clients receive equivalent native
selection requests; headless invocations can use the explicit commands below.

`/reviewer set` opens the same selector. `/reviewer status` prints the selected pair.
Explicit model IDs and thinking levels remain supported:

```text
/reviewer status
/reviewer set openai/gpt-6-luna medium
/reviewer thinking high
```

There is exactly one reviewer, shared by action, completion, editorial and prompt-compression
reviews. `set` replaces its model/thinking pair. Supply the thinking level explicitly when
changing to a model with different capabilities; otherwise the current level is retained,
or `off` when no reviewer exists. Selections must exist in the catalog and support that level.
Authentication is checked again at use time, and unavailable authentication is shown in status.

Provider outages use the existing bounded retries and cooldown for the selected model.
They never select another model. Denials, invalid verdicts, cancellations and unavailable
reviewers block execution. Changing the reviewer cannot replace an in-flight check's selection
or retroactively change a verdict.

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
`PI_CODING_AGENT_DIR`. `working.json` and `reviewer.json` each store one pair.
Atomic, owner-only files keep concurrent working/reviewer updates independent.
They persist across restarts, are excluded from Git and are protected from model actions with
the rest of the agent directory. Only operator commands change review choices.
Invalid saved state blocks loading rather than selecting a different reviewer.
Existing `reviewers.json` lists migrate once by retaining their first, previously active entry.
The new single selection takes precedence; the legacy file is not updated.

`auto-approval.json` retains sandbox and review-context settings and rejects `reviewers`.
On a device without saved reviewer state, Pi starts so `/reviewer set` can configure it;
independent checks cannot succeed until a reviewer is selected. Other devices need their own
initial selection. No model request is needed to change or inspect preferences.
