# Model selection

New sessions use the last working **model/thinking pair**. Native `/model`, `/thinking`
and cycling shortcuts save it. Resumed/forked/reloaded conversations keep their own
pair; it becomes the new-session default only when that conversation runs again.

`/reviewer` (or `/reviewer set`) opens a searchable model picker followed by supported
thinking levels. Search provider, ID or display name; arrows/Enter select, Escape
cancels without saving. Current choices are preselected. Browsing makes no model
request, changes no working model and interrupts nothing. Both confirmed choices are
saved together. The catalog includes authenticated providers; add others with `/login`.
RPC receives equivalent selection requests; headless callers can use:

```text
/reviewer status
/reviewer set openai/gpt-6-luna medium
/reviewer thinking high
```

One reviewer serves action, completion, editorial and prompt-compression checks.
`set` replaces its pair; omitted thinking retains the current level, or `off` if unset.
The catalog must support both choices. Authentication is rechecked at use and shown
in status. Outages retry only this model; denials, invalid verdicts, cancellation and
unavailability block execution. Selection changes cannot alter an in-flight verdict.

| Change                 | Takes effect                                                  |
| ---------------------- | ------------------------------------------------------------- |
| Working model/thinking | Next response/steering boundary                               |
| Reviewer while busy    | Next turn; all actions of a turn retain one snapshot          |
| Reviewer while idle    | Immediately                                                   |
| Fast mode              | Next provider request, including later reviewer lookup rounds |

Peers/subagents inherit changes at their boundaries without permission to change
defaults. Submitted calls are not cancelled. The footer groups model, thinking and
optional `fast`; fresh-session fast mode is off, with separate branch restoration.

Owner-only atomic `working.json` and `reviewer.json` files live in
`~/.pi/agent/state/model-selection/` (or `PI_CODING_AGENT_DIR`). They are Git-excluded,
protected from model actions and independently updated. Only operator commands change
reviewer choices. Invalid state blocks loading. Legacy `reviewers.json` migrates its
first active entry once; the single-selection file takes precedence.

`auto-approval.json` retains sandbox/context settings and rejects `reviewers`. A device
without reviewer state can start Pi and select one, but cannot complete independent
checks until then. Inspecting/changing preferences makes no model call.
