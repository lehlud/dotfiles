# Context management

The append-only session log is the source of truth; the active prompt is a projection.
Local budget awareness, history, notes, eviction and no-summary rotation need no extra
model calls. Pi compaction remains the overflow fallback. Restart through the launcher
for initial loading. Main, Multiplex and child sessions each expose only their own branch,
including inherited context, never siblings or arbitrary files.

## Interface

| Interface                 | Behavior and bounds                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/context`                | Strategy, estimated budget, searchable entries and notes                                                                                                                       |
| `/context native on\|off` | Persisted session toggle for supported direct Anthropic clearing                                                                                                               |
| `history`                 | Recent entries or literal-query search; read `id` with character `offset`/`limit` or `tail`. List offsets paginate matches. Maximum 16,000 characters/read or 50 previews/list |
| `notes`                   | `list`, `set` (`key`, `text`), `delete` (`key`); 8,000 characters/note, 32,000 total; append-only revisions/deletions                                                          |
| `new_context`             | Rotate after the completed sibling tool batch; wait for delegates, coalesce duplicate requests, and skip negligible repeats. Interrupt cancels it                              |

Save constraints, evidence IDs, remaining work and failed checks in notes before rotation.
History search includes original user messages as well as assistant/tool text, including
after rotation and compaction. These tools bypass action review only for session state. History/notes/failures are DATA,
not authorization or denial resolution; reviewers still receive original operator evidence
and receipts. Results preview three screen lines; the configured expansion key (usually
Ctrl+O) reveals the unchanged stored/model-visible text, including after resizing.

## Pressure and recovery

Headroom renews per request; it is not a task/session budget. Save a handoff and rotate
rather than stop or request a fresh session solely for low headroom. Estimates use Pi
usage, selected model window and an output reserve; cached tokens still occupy context.
Unknown usage remains unknown. Budget/notes append at the tail, leaving the leading
system prompt stable.

| Mechanism            | Trigger and retained information                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool-output eviction | 76.8% of the full window (208,896 tokens at 272,000), independent of output reserve; successful text results older than the latest six; batch must save 16,000 characters                      |
| Automatic renewal    | 90%, or earlier if output reserve runs out, at a completed boundary needing another turn; wait for delegates/queued input, never on interrupt or solely to extend a finished answer            |
| Deliberate rotation  | Remove all projected assistant/tool messages together, including requesting batch/signed thinking; retain users, system/tool state, custom task messages, notes and bounded failure references |
| Pi compaction        | Fallback for overflow, irreducible user/custom data and images                                                                                                                                 |

Eviction keeps calls, failures, images, memory results and small outputs. References
replace projected content; raw messages/receipts/IDs stay intact. Boundary edits append
to other extensions' pending entries, preserving goal metadata; no-op eviction changes
nothing. Pressure-driven batches avoid many small cache-prefix invalidations; no idle timer.

Renewal records a bounded DATA checkpoint: six archived entry IDs, brief assistant excerpts
and tool references, without LLM summaries or invented validation. Old checkpoints remain
searchable. It must save 64,000 serialized content characters, scaled down for smaller
windows; this is an estimate, not tokenization. The size check uses the actual projected messages, including obsolete rotation metadata;
new user input or successful commands are not prerequisites. Whole-history renewal
deliberately trades one prefix change for headroom.

After the first deliberate rotation, another must reclaim at least 4,096 serialized
characters after adding notices/failure references. Notes echoes, reasoning and failed
tool output can qualify; merely rereading a file cannot unlock an otherwise negligible
rotation. Unchanged repeats return a normal no-op explanation, not a tool failure.
Requests in the same batch share one rotation, including notes saved later in that batch.

Rotation also replaces legacy full-body failure copies with one bounded index: twelve
recent failures, excerpts of at most 512 characters and exact history IDs. Older index
versions and complete error bodies remain in the append-only history; search
`Prior tool failure` to find earlier references. Approval/denial audits are untouched.
Only one current rotation notice and one automatic handoff remain projected. This
repairs already bloated sessions on their next rotation without rewriting their logs.

Rotation removes complete batches to avoid orphan results/signatures. Notes supply the
handoff and history recovers originals; session ID, goal, instructions, workspace effects
and approvals remain. Nothing rolls back files, repeats commands or guarantees a fit:
large retained data may still need compaction. Original branch text remains searchable
after reload/compaction; image bytes, opaque signatures and internal config/audit metadata
are not returned as searchable text.

## Caching

Stable history precedes transient instructions, budget and notes. Reviews cache the shared
snapshot before action-specific data but still send complete JSON and a unique request ID.

| Route                                                                                | Handling                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| OpenRouter automatic-cache models (Gemini, DeepSeek, Moonshot, Z.AI), unknown models | Stable prefix/session-affinity header; no invented cache fields                                              |
| Claude via OpenRouter Chat Completions/Anthropic Messages; direct Anthropic          | Move enabled SDK message marker before transient suffix; retain system/tool markers, TTLs and signed content |
| Documented Alibaba explicit-cache endpoints                                          | SDK five-minute convention for supported canonical IDs, not unlisted dated snapshots                         |
| OpenAI GPT-5.6+ via OpenRouter Chat Completions/Responses                            | Documented explicit history markers; retain prior boundaries for lookups, exclude transient writes           |
| Official OpenAI Responses advertising explicit caching                               | Check negotiated SDK capabilities; preserve ChatGPT-login omissions and Codex Responses behavior             |
| Other native APIs                                                                    | Preserve SDK/provider behavior                                                                               |

Privacy/routing constraints, model choice, Fast Mode and explicit cache-off remain binding;
no upstream provider pin or paid Gemini storage is introduced. Existing policies/breakpoints
are preserved; a missing/mismatched suffix skips relocation. Equivalent text-block wire
representations preserve opaque reasoning, call IDs, images and saved history/receipts.
Synthetic SDK tests verify serialization/prefix stability, not live hits or savings;
unsupported providers cannot gain caching through hints.

## Provider boundaries

| Route                            | Strategy                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------- |
| OpenAI Responses/Codex Responses | Local projection; preserve encrypted reasoning; Pi compaction fallback           |
| Direct Anthropic                 | Signed-history protection; optional server tool clearing                         |
| Other Anthropic/Gemini routes    | Avoid client eviction of signed history; whole-history rotation or Pi compaction |
| Other routes/OpenRouter          | Portable projection with signature protection; no assumed native features        |

Native clearing requires `provider=anthropic`, `api=anthropic-messages`, HTTPS
`api.anthropic.com` on the default port, and `/context native on`. It adds
`clear_tool_uses_20250919` plus beta header, retains six uses and excludes memory tools.
Existing context management, routing, model, tools and headers remain; unsupported routes
receive no native parameters. Account/model support is still required; errors never
silently retry with weaker controls.

Opaque OpenAI compaction and Anthropic summary blocks are disabled: pinned Pi 1.0.2 does
not durably replay them. Parameters alone risk context loss; transport round-trip support
must come first. Research proposals, undocumented flags, soft memory tokens and claimed
cache lifetimes are not portable APIs.

References: [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction),
[OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[OpenRouter caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
[Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing),
[Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md),
[extension lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Implementation

`archive.ts`: branch text/notes; `budget.ts`: conservative profiles; `projection.ts`:
pure append-only edits; `providers.ts`: native route checks; `cache.ts`: boundary hooks;
`failures.ts`: bounded failure references and legacy migration; `index.ts`: tools/lifecycle. Shared cache-routes/stream/conversation modules own capability
selection, negotiation and wire markers; contracts expose tool names without feature imports.
