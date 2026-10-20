# Context management

This extension separates the append-only session log from the model's active
view. It supplies budget awareness, searchable original history, working notes,
pressure-driven tool-output eviction and deliberate no-summary rotation. Pi's
ordinary compaction remains enabled as a fallback. No additional model call is
needed for local projection, retrieval or rotation.

Start a new process through `~/.local/bin/pi` to load this extension initially.
The main model, Multiplex members and subagents get separate instances. Each
instance can inspect only its own session branch, including inherited context;
it cannot browse other sessions or arbitrary filesystem paths.

## Interface

- `/context` reports the selected model's strategy, estimated budget, searchable
  entry count and note count. `/context native on|off` controls the optional
  direct Anthropic strategy for this session. The setting survives reload.
- `history` lists recent original entries or searches with a literal `query`.
  Read an `id` using character `offset` and `limit`, or `tail: true`.
  List offsets paginate matching entries; read offsets index the original text.
  Reads return at most 16,000 characters; listings at most 50 short previews.
- `notes` supports `list`, `set` (`key`, `text`) and `delete` (`key`). Notes are
  model-authored working memory, limited to 8,000 characters per note and
  32,000 in total. Record constraints, evidence IDs, remaining work and failed
  validation before rotation. Revisions and deletions are append-only.
- `new_context` schedules rotation at the next completed tool-batch boundary,
  after sibling tool calls have finished. It refuses while delegates are busy
  and refuses another rotation without new user input or successful external
  work. Interrupting the run cancels pending rotation.

These three tools manipulate only session state and bypass action review.
Every external operation still goes through Auto-Approval. Retrieved history,
notes and copied failures are DATA: none creates new operator authorization or
resolves a prior denial. Reviewers continue to receive the original operator
evidence and action receipts from the unmodified log.

## Projection and recovery

Budget estimates use Pi's context usage and the selected model's window, with
an explicit output reserve. Cached input still occupies the context window.
Unknown usage stays unknown. Budget/notes are added at the request tail; the
extension does not rewrite the leading system prompt each turn.

Above 75% of the usable budget, portable eviction considers successful text
tool results older than the latest six. It keeps calls, failures, images,
memory-tool results and small outputs. A batch must save at least 16,000
characters before any edits are committed. References replace output content
in the active projection; raw messages, receipts and IDs remain unchanged.
Eviction is pressure-driven, not an idle timer. It can invalidate a cached
prefix, so the extension avoids many small edits and makes no cache-hit claim.

Rotation omits **all** projected assistant/tool messages together, including
the requesting batch and signed thinking. It retains real user messages,
system/tool state, custom task messages, current notes and prior failures.
Removing complete batches prevents orphan tool results and stale signatures.
There is no LLM-generated handoff: notes carry the model's deliberate handoff,
and `history` can recover originals. Session identity, goal, workspace changes
and prior approval decisions are retained. Rotation does not roll back files,
repeat commands, erase history or promise that the remaining context fits:
large user/custom messages can still require ordinary compaction.

Original text remains searchable after ordinary compaction and reload. Only
the current branch is exposed, never sibling branches. Image bytes and opaque
thinking signatures stay in the raw log but are not returned as searchable
text. Internal configuration/audit metadata is not exposed through history.

## Provider boundaries

| Route                                 | Strategy                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| OpenAI Responses / Codex Responses    | Local tool-output projection; preserve encrypted reasoning blocks; ordinary Pi compaction fallback     |
| Direct Anthropic                      | Signed-history protection by default; optional server tool clearing via `/context native on`           |
| Anthropic/Gemini through other routes | Avoid client eviction when signed history is present; explicit whole-history rotation or Pi compaction |
| Other routes, including OpenRouter    | Portable projection with signature protection; no assumed native provider features                     |

The optional Anthropic route requires `provider=anthropic`,
`api=anthropic-messages`, and HTTPS `api.anthropic.com` on the default port.
It adds `clear_tool_uses_20250919` and its beta header, retaining six tool uses
and excluding the memory tools. Existing `context_management`, routing, model,
tools and other headers are preserved. Unsupported routes receive no native
parameters. This beta is opt-in; account/model support must exist upstream.
Provider failures retain ordinary error handling; there is no silent retry
with weaker context controls.

OpenAI's native compaction requires durable replay of returned compaction
items. The pinned Pi 1.0.2 Responses normalizer handles reasoning items but
does not persist/replay compaction items. Merely adding a request parameter
would risk losing context, so native opaque compaction is **not enabled**.
The same limitation prevents enabling Anthropic's summary-compaction blocks.
These require a transport-level round-trip implementation before activation.

Verified protocol references:

- [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [Anthropic Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [Pi extension lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

Research proposals, undocumented Codex flags, soft memory tokens and specific
cache lifetimes are not treated as portable production APIs. The protocol
tests use the actual pinned SDK with synthetic providers; they do not prove
live-provider beta availability or cache savings.

## Implementation

`archive.ts` exposes branch-scoped text and note reconstruction. `budget.ts`
selects conservative profiles. `projection.ts` plans pure append-only edits;
`providers.ts` limits native request changes to an explicit supported route.
`index.ts` registers the tools and lifecycle hooks. Shared contracts expose
tool names without pulling this extension into the approval policy.
