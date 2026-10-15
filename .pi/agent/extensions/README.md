# Pi extensions

Each feature has one SDK entry point (`index.ts`). The launcher loads these entry points explicitly;
`shared/` is a library, not an extension. Feature controllers own session state. Pure contracts and
review infrastructure never import a feature entry point.

| Module            | Responsibility                                                                              | Main entry                   |
| ----------------- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| Auto-Approval     | Authorize and execute one exact operation in mandatory isolation                            | `auto-approval/index.ts`     |
| Conversations     | Goals, completion checks, steering, side conversations, progress detection                  | `conversations/index.ts`     |
| Multiplex         | Equal peer sessions, coordination, authenticated mailboxes, shared activity                 | `multiplex/index.ts`         |
| Provider recovery | Attach bounded transport recovery to the working model                                      | `provider-recovery/index.ts` |
| Code quality      | Standing multilingual code readability rules on every working-model request                 | `code-quality/index.ts`      |
| Public writing    | Frozen editorial policy and an independently reviewed prose receipt                         | `public-writing/index.ts`    |
| Web research      | DDGS queries and public URL text extraction through the isolated worker                     | `web-research/index.ts`      |
| Shared library    | Settings, immutable action contracts, provider transport, review evidence, session services | `shared/`                    |

## Boundaries

- `shared/` imports only other shared modules and pinned third-party libraries. It has no feature
  dependencies, action executor or default action-approval policy.
- Conversations uses shared settings and the verdict client for completion checks. It supplies its
  own completion policy; it cannot authorize actions. Side conversations also consume the public
  writing rule data, without registering the public writing extension.
- Multiplex's `peer.ts` is the explicit composition root for child sessions. It attaches Auto-Approval,
  public writing, code quality, progress detection and steering to each child. Other Multiplex modules use shared
  contracts, not approval internals.
- Code quality has no feature dependencies, tools or reviewer. Its transient context instruction
  reaches every working-model request without changing the saved transcript or authorization.
- Auto-Approval consumes public writing and web tool definitions. It owns action policy, preflight,
  verdict persistence and isolated execution. Neither a provider retry nor a completion verdict can
  bypass this action pipeline.
- The isolated `runner.ts` imports only tool definitions and their sandbox-side implementations.
  Host credential resolution, host settings loading and action review are excluded from its graph.

`auto-approval/tests/architecture.test.ts` enforces these import boundaries, rejects runtime cycles,
and checks native executor fingerprint and Docker build coverage. Type-only contract references
are allowed. The shared test harness remains under `auto-approval/tests/` so SDK versions, native
fixtures and Bun module mocks have one pinned dependency installation.

## Action pipeline

`index.ts` registers SDK hooks and the tool. `tool-catalog.ts` owns the portable wire schema and the
strict selected-tool validator. `ActionSession` serializes the entire action and owns private session
storage. `ActionRun` preserves this sequence:

1. Acquire the current team assignment lease, when Multiplex is active.
2. Snapshot and validate the exact request; normalize requested network scope.
3. Load settings and validate sandbox paths, tools, workspace and protected storage.
4. Build bounded operator evidence and request an independent verdict.
5. Persist the exact verdict before any approved operation executes.
6. Recheck the lease and cancellation, then execute in mandatory isolation.
7. Release the lease and finish review presentation on every exit path.

`prepare-action.ts` performs preflight. `sandbox-plan.ts` describes the reviewed scope without
resolving credentials. `review-display.ts` owns review callbacks and presentation. `sandbox/` separates
workspace discovery and grants, inode boundary checks, temporary mount scaffolding, pure backend
argument builders and process execution. Local applications execute original read-only
`~/.local/bin` entry points and necessary public helpers; Pi never copies those launchers or
implements their application behavior. Caches/state remain private, and application-owned sandbox
modes prepare platform runtimes where needed. The small `isolation.ts` facade keeps test doubles and
callers on one stable interface.

## State and lifecycle

The goal controller owns goal transitions and persistence. `goal-review.ts` captures and checks one
completion snapshot; the controller discards a verdict superseded by operator input or peer work.
The team controller owns startup, global cancellation and peer cleanup. Mailbox, coordination and
activity modules own their respective state.

Session services and provider availability retain their existing `Symbol.for` registry keys.
Compiled Pi loads extensions through independent module caches, so replacing these registries with
module-local singletons would split session identity. The registry contains extension-owned
callbacks only; it is never a model-facing tool.

Bootstrap installs pinned dependencies and links the shared SDK into companion modules before loading
runtime settings. Frozen executors include every reachable local runtime source in their fingerprint.
No running Pi session is restarted by source changes. Start a new Pi process through the launcher to
pick them up; session-private temporary artifacts must be regenerated after shutdown or reload.

## Development

Run from `auto-approval/`:

```sh
bun run check
bun run check:format
bun run test
```

The test script deliberately uses separate Bun processes. Extension tests mock the sandbox facade;
putting native or compiled-Pi tests in that same process would replace real isolation with a mock.
The 15-second default test bound accommodates native process startup; integration cases with explicit
longer bounds retain them. Provider fixtures use synthetic authentication and do not contact live
models. Live reviewer evaluations remain separate, operator-configured commands.

Web research and public writing keep their own type checks and tests. The Python worker has a separate
`unittest` suite. Docker sources and build context are checked statically; an actual Docker build
requires the operator's container engine and pinned image availability.

Use `bun run format` for the shared TypeScript, JSON and Markdown style. Prettier normalizes
syntax first; the syntax-aware layout pass then separates setup, effects and exits and inserts a
blank line after completed control-flow constructs, including nested control flow. Callback and
closure endings, class bodies and object/collection literals do not trigger brace-only spacing;
normal formatter layout applies between arguments, properties and closing delimiters. Standalone
declarations still use semantic separation.
Connected `else`, `catch`, `finally` and `do`/`while` clauses stay attached. Leading comments remain
with their statements; literal prompt text is never rewritten. `bun run check:format` applies the
same pipeline without writing. Python and shell sources use equivalent logical block spacing.
A completed control-flow construct at the end of a file also keeps its trailing blank line. Use
`git -c core.whitespace=-blank-at-eof diff --check` to allow that deliberate layout while still
checking trailing spaces and other whitespace errors.

Add behavior tests in the appropriate existing suite, and update architecture checks when
deliberately adding a dependency.
