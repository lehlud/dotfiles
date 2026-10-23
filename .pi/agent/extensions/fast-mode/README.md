# Fast mode

`/fast` toggles speed preference; `/fast on|off|status` sets or inspects it.
Fresh sessions start off; reload and branch navigation restore that branch's setting.
The footer adds `fast` beside model/thinking only while enabled. Commands stay local.

| Route                                               | Override                                |
| --------------------------------------------------- | --------------------------------------- |
| OpenAI Responses, Codex Responses, Chat Completions | `service_tier: "priority"`              |
| OpenRouter                                          | Sort eligible providers by `throughput` |
| Unsupported providers/models                        | None                                    |

The preference applies before the next request by the main model, peers, subagents,
side chats, and action/completion/editorial/compression reviewers, including later
original-prompt lookup rounds. Submitted requests retain their settings; peers consult
the live parent preference. Model, reasoning, cache options, privacy controls,
allowlists, exclusions, ordered pins and fallback rules remain unchanged. Off restores
the existing provider configuration. Denials remain final.

Availability and billing still depend on provider/model/account; this preference can
increase cost and cannot guarantee faster service. It grants no tools, permissions or
approval authority. The extension owns commands, branch state and display; shared
provider hooks and the review client apply the override while preserving recovery.

References: [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode),
[Codex speed](https://developers.openai.com/codex/speed),
[OpenRouter sorting](https://openrouter.ai/docs/guides/routing/provider-selection#provider-sorting).
