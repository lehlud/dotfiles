# Pi extensions

Each feature has one launcher-loaded `index.ts` and owns its session state. `shared/`
is a library, not an extension; its contracts/infrastructure never import feature code.

| Module                                             | Responsibility                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| [Auto-Approval](auto-approval/README.md)           | Exact-action review, audit and isolated execution                    |
| [Conversations](conversations/README.md)           | Goals, continuation, steering, questions, side chats, progress guard |
| [Multiplex](multiplex/README.md)                   | Equal peers, coordination, authenticated mailboxes, shared feed      |
| [Subagents](subagents/README.md)                   | Bounded delegates, parent mailbox, review mode, kill/resurrection    |
| [Context management](context-management/README.md) | Budgets, history, notes, eviction and rotation                       |
| [Fast mode](fast-mode/README.md)                   | Session speed preference for working/review requests                 |
| [Model selection](model-selection/README.md)       | Persistent model/thinking pairs and live selections                  |
| [Provider recovery](provider-recovery/README.md)   | Bounded retries and availability tracking                            |
| [Code quality](code-quality/README.md)             | Standing multilingual readability instruction                        |
| [Public writing](public-writing/README.md)         | Frozen editorial rules and explicit draft checks                     |
| [Web research](web-research/README.md)             | DDGS and public-page text extraction                                 |
| [Remote](remote/README.md)                         | Operator-selected SSH workspace and bounded forwarding               |
| [Container tools](container-tools/README.md)       | Reviewed Docker/Podman workloads through a private bridge            |
| `shared/`                                          | Settings, contracts, provider/review transport and session services  |

## Boundaries

- Feature controllers own lifecycle. Completion reviews cannot authorize actions;
  context projections, metadata and presentation cannot create authorization.
  Conversations independently reviews model-proposed goals before activation, sharing operator
  evidence preparation with completion checks. Goal approval grants no external permissions.
- `multiplex/peer.ts` and `subagents/child.ts` are explicit composition roots. Each
  child gets its own gate, policies and session storage; shared child transport,
  provider setup, names and cancellation serve both without reverse imports.
  `shared/session/headless-session.ts` owns SDK setup and startup cleanup;
  `inherit.ts` binds live parent preferences/task data. Tool lists, role policies,
  action leases and peer/parent routing remain explicit in the composition roots.
- Model selection snapshots reviewers at turn boundaries. Fast-mode hooks apply to
  working, peer, child, side and review requests without changing policy or grants.
- Context management owns separate projections per actor; original evidence remains
  append-only. Code-quality instructions are transient and change no saved history.
- Auto-Approval consumes web/writing tool definitions and owns action authorization.
  The sandbox runner imports only tool definitions/implementations, never host
  credential resolution, settings loading or review code.
- Shared presentation bounds expandable output; subagent presentation hides routine
  successes while retaining activity records and confirmed diffs. Cache-affinity hints
  never share transport identity or alter retention.

`auto-approval/tests/architecture.test.ts` checks imports, runtime cycles, executor
fingerprints and Docker build coverage. Type-only contract references are allowed.
The shared test harness/dependencies remain under `auto-approval/`.

## Action pipeline

`index.ts` registers hooks/tools; `tool-catalog.ts` owns the portable schema and strict
selected-tool validator. `ActionSession` serializes actions and owns private storage.
`ActionRun` preserves this order:

1. Acquire any Multiplex assignment lease.
2. Snapshot/validate the exact request and normalize networking.
3. Preflight settings, paths, tools, workspace and protected storage.
4. Build bounded operator evidence and obtain an independent verdict.
5. Persist that verdict before execution.
6. Recheck lease/cancellation; execute within the reviewed local/remote boundary.
7. Release the lease and finish presentation on every exit.

`prepare-action.ts` handles preflight; `sandbox-plan.ts` describes scope without resolving
credentials; `review-display.ts` handles callbacks. `sandbox/` separates discovery,
grants, inode checks, temporary mounts, backend arguments and execution; `isolation.ts`
is the stable facade. Local apps execute original read-only launchers/helpers, not Pi
copies. Application runtimes own setup; mutable caches/state remain private.

## Lifecycle

Goal controllers discard completion snapshots superseded by user input or peer work.
Team controllers own startup, global cancellation and cleanup; mailbox/coordination/
activity modules own their respective state. Session services and availability retain
`Symbol.for` registries: compiled Pi loads extensions through separate module caches,
so module-local replacements would split identity. Registries contain internal callbacks,
not model-facing execution tools.

Bootstrap installs pinned dependencies and SDK links before settings load. Executor
fingerprints cover every reachable runtime source. Source changes never restart running
Pi; start a new process through the launcher. Shutdown/reload removes private `/tmp`.
Home work uses narrow grants; requested [Pi maintenance](auto-approval/README.md#pi-maintenance)
excludes private runtime/credentials and pins security settings until restart.

## Development

From `auto-approval/`:

```sh
bun run check
bun run check:format
bun run test
```

Keep the test script's separate Bun processes: extension mocks must not replace native
isolation in integration tests. Default timeout is 15 seconds; explicit longer bounds
remain. Synthetic providers need no real credentials. Live reviewer evaluations are
separate opt-in commands. Web/writing have their own checks; the Python worker uses
`unittest`. Static Docker checks do not prove a live image build.

`bun run format` applies Prettier, then syntax-aware semantic grouping. Add a blank line
after completed control flow before another statement; keep consecutive closing
braces/delimiters and attached `else/catch/finally/do-while` together. Callback, class,
object/collection and argument endings alone require no gap. Separate declarations by
meaning; keep leading comments attached. Prompt literals remain untouched. Python/shell
use equivalent grouping. `check:format` checks the same pipeline without writing.
A completed top-level control construct retains its final blank line; use
`git -c core.whitespace=-blank-at-eof diff --check` for the intended layout.
Add behavior tests to existing suites; update architecture checks for deliberate dependencies.
