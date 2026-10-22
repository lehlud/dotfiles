# Fast mode

`/fast` toggles faster processing for the current Pi session. `/fast on`, `/fast off` and
`/fast status` set or inspect it explicitly. The default is off. The status bar shows `fast`
beside the selected model and thinking level while enabled, and nothing while disabled.
The toggle also applies while a run is active: its next provider request uses the new preference.
Unsupported working models receive no speed override; compatible reviewers still receive theirs.

OpenAI Responses, Codex Responses and Chat Completions requests use `service_tier: "priority"`,
the documented alias for Fast mode. OpenRouter sorts eligible providers by `throughput` for the
selected model. Existing provider allowlists, exclusions, privacy controls, ordered pins and
fallback settings remain intact; these restrictions can limit eligible routes. Neither mode
changes the selected model or reasoning effort. Other providers retain their existing behavior.

The setting applies to subsequent main-agent, Multiplex peer, subagent and side-conversation
requests, and to independent action, public-writing and goal-completion reviews. Prompt
compression and original-prompt lookup requests through the reviewer use it too. Each review
candidate uses its own provider/API route; model choice, thinking level, verdict constraints,
cache options and fallback rules are preserved. An explicit denial remains final.
Already-submitted requests retain their speed settings; later reviewer lookup rounds consult
the live session preference. Each session restores its own toggle from extension-owned
branch entries after reload or tree navigation; a fresh session starts off. The command is handled
locally and is not sent to the model as a user prompt. Peer requests consult the live parent setting.

Fast processing can increase billing or subscription usage. Provider/model/account availability
still applies; this is a speed preference, not a guarantee that the server supplies a faster tier.
Off removes this extension's override and restores the existing provider configuration.

This feature has no tools, sandbox grants or action-approval authority. It preserves normal provider
recovery, request hooks and the independent action gate. Request hooks live in the shared provider
library; the shared review client composes the same speed preference after its verdict-schema
and cache transforms. The extension owns only operator commands, branch state and its status display.

Provider references: [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode),
[Codex speed](https://developers.openai.com/codex/speed),
[OpenRouter provider sorting](https://openrouter.ai/docs/guides/routing/provider-selection#provider-sorting).
