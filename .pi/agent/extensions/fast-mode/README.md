# Fast mode

`/fast` toggles faster processing for the current Pi session. `/fast on`, `/fast off` and
`/fast status` set or inspect it explicitly. The default is off. The status bar shows `fast`
while enabled, or `fast (unavailable)` when the current provider has no supported speed override.

OpenAI Responses, Codex Responses and Chat Completions requests use `service_tier: "priority"`,
the documented alias for Fast mode. OpenRouter sorts eligible providers by `throughput` for the
selected model. Existing provider allowlists, exclusions, privacy controls, ordered pins and
fallback settings remain intact; these restrictions can limit eligible routes. Neither mode
changes the selected model or reasoning effort. Other providers retain their existing behavior.

The setting applies to subsequent main-agent, Multiplex peer and side-conversation requests.
Already-running requests retain their submitted settings. Independent approval/completion reviews
keep their configured processing settings. Each session restores its own toggle from extension-owned
branch entries after reload or tree navigation; a fresh session starts off. The command is handled
locally and is not sent to the model as a user prompt. Peer requests consult the live parent setting.

Fast processing can increase billing or subscription usage. Provider/model/account availability
still applies; this is a speed preference, not a guarantee that the server supplies a faster tier.
Off removes this extension's override and restores the existing provider configuration.

This feature has no tools, sandbox grants or action-approval authority. It preserves normal provider
recovery, request hooks and the independent action gate. Request hooks live in the shared provider
library; the extension owns only operator commands, branch state and its status display.

Provider references: [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode),
[Codex speed](https://developers.openai.com/codex/speed),
[OpenRouter provider sorting](https://openrouter.ai/docs/guides/routing/provider-selection#provider-sorting).
