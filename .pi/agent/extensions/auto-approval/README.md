# Pi Auto-Approval

Every external action needs an independent verdict persisted before isolated execution.
Direct tools, `!`/`!!`, nested external calls and local host fallbacks are blocked.
[Remote work](../remote/README.md) uses reviewed SSH; only native operator UI consent
after failed remote bwrap permits remote-account mode. Local credential isolation remains
mandatory; unsupported required guarantees fail closed. See the [architecture guide](../README.md).

The gate checks safety, authorization and exact, directly evident unintended errors, not
preferred design, style, usefulness or work order. Normal scoped edits, tests/docs and
foreground validation are authorized by the corresponding task. Visible inline programs
need no exhaustive prerequisite inspection. Intentional negative tests/refactors are legitimate;
concrete secret access, harmful changes, uploads, deletion and gate interference need scrutiny.
Editorial rules apply only to explicit [writing_check](../public-writing/README.md).

## Startup and status

Restart through `~/.local/bin/pi` after source changes. `/auto-approval` reports reviewer,
backend, cwd, workspace and configuration paths. The footer shows only the active reviewer
and spinner, then clears; invalid configuration shows `approval: LOCKED`. Decisions, timings,
failures and models remain in the log/audit, without an idle approval widget. Pre-review
failures name their stage and show model `—`.

Built-in prose/code/docs are English; model replies/verdicts follow the latest actual user
prompt's own language. Multilingual fixtures remain multilingual.

| Configuration                    | Contents                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `~/.pi/agent/auto-approval.json` | Synced review-context settings/backend; no model choices, device paths or grants |
| `auto-approval.device.json`      | Optional Git-excluded executable paths, default views and credential bindings    |
| Model-selection state            | One operator-selected reviewer model/thinking pair, outside security config      |

`PI_CODING_AGENT_DIR` relocates these files. Settings reload per action unless approved writable
maintenance pins them until restart. [Reviewer selection](../model-selection/README.md) stays
live at turn boundaries; in-flight reviews retain their snapshot. Missing auth/models, unsupported
thinking, timeouts, invalid/truncated/cancelled verdicts and refusals block execution. Recovery
retries only the selected model; valid request-bound denials remain final even before transport
failure. Diagnostics omit raw provider data. `/login` configures private per-device credentials.

## Container jobs

[container_exec](../container-tools/README.md) uses Lubox's private engine bridge for reviewed
metadata, pulls, temporary capped containers and bounded Compose jobs. It exposes no socket or
bridge credential. Exact argv, roots, network and OCI budgets are reviewed together; unsupported
builder/tmp guarantees fail closed. No new profile/local cgroupRoot is needed for this route.

## Conversation features

[Conversations](../conversations/README.md) owns goals, continuation, steering and questions;
[Multiplex](../multiplex/README.md) owns equal peers, coordination and mail. Internal mailbox,
question tools bypass action review only for metadata, never external execution
or authorization. The gate returns immediately for mailbox without inspecting content/services
or creating an approval audit; messages may proceed alongside the serialized external-action queue.
Questions cannot answer themselves for users; self-assigned goals cannot replace unfinished goals
or enter genuine-user evidence. Pending questions replace the editor until resolved.

Every `set_goal` call instead runs its own mandatory independent goal-proposal approval through
the configured reviewer, including repeats/resumes. It must retain the user task's outcomes and
validation bar; approval is persisted before activation and grants no external permissions.

Multiplex enforces/pins assignment leases locally before review/execution. Reviewers see exact
actions, access and genuine user constraints/evidence, not names, team size, plans or assignments.
Coordination failures remain audited but are excluded from prior action denials. Peer data grants
no authority; actual ungated agents/execution remain prohibited.

## Automatic workspace detection

Use a project's Git root, otherwise cwd; a root at/above home is ignored. Commands retain cwd.
Home starts empty/read-only without requiring device configuration. Named local read/edit/write
requests infer exact file grants; shell actions request selected `sandbox.paths`. No whole-home/
ancestor mount is allowed. Optional `workspaceViews` supplies selected defaults.

For absent targets, request a write path with `create: file|directory`. Preparation pins the
existing parent; only persisted approval permits exclusive creation/mounting of that exact target,
without writable-parent access. Changed parents/late occupants abort. Failure removes only owned
empty scaffolding; useful outputs/successful empty files remain. Native home-file writes infer
file creation. This currently needs bwrap; nested missing parents require separate bounded actions.

Example: named read/edit of `~/.local/bin/cmatrix`, or
`{"path":"/home/example/new-project","access":"write","create":"directory"}` for a new project.
Neither needs a device JSON edit; neighboring files need their own grants.

Active Pi/configuration/credential roots stay protected. Protected descendants are masked.
Hardlinks are allowed only when all inode links remain inside mounted unprotected paths; cross
read/write links fail. Bwrap permits system `/usr` symlinks, rejects other outward/protected links
and sockets. Dangling cache symlinks are harmless; missing targets are not mounted.

## Pi maintenance

Actual user-requested Pi setup/config/source work uses `sandbox.maintenance: true` and selected
paths. This permits reviewed source, launcher and public settings/models/approval/device edits,
formatting and tests, without a private-directory mount. It runs locally with `/remote` off;
the flag alone supplies no authority.

Credentials/login, session/audit/state, active executors, bridge secrets and kernel/runtime
controls remain excluded. Writable maintenance pins existing security settings after persisted
approval; restart activates changes. Model/reviewer selections retain live boundary behavior.
No source edit can bypass current review/isolation or activate an unreviewed executor.

## Tool display

Native renderers retain expandable reads and numbered edit diffs. Confirmed writes use the same
padded diff block, showing frozen full contents as green numbered additions, even for rewrites;
there is no claim to compare old contents. Both collapse after ten lines. Pending/denied/failed
writes show no successful additions. A compact executor confirmation keeps contents outside the
output budget; renderers read no host files. Shared feeds use these same confirmed diffs.

Tools without native renderers use three screen lines, bounded by width even for single-line
JSON; the configured expansion key (normally Ctrl+O) reveals stored output. Error previews retain
the reason. Long commands (over 300 characters/five lines) collapse. Presentation changes neither
model evidence nor execution. Approvals remain separate log entries, never prompt widgets.
Successful Bash text identical to structured output travels once with exit/timing metadata;
different/truncated structured output remains. Bounds, timeouts and cleanup are unchanged.

## Request additional sandbox access

Each `approved_action` supplies tool, unchanged selected-tool arguments, goal and justification.
Necessary access required by actual user intent needs no redundant confirmation, but is reviewed
with the whole action and expires afterward.

| Field                   | Scope                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tools`                 | Selected local bundles/original launchers, validated public runtimes; private mutable state                     |
| `paths`                 | Absolute read/write file/directory grants; resolved symlinks visible in review; optional absent-target `create` |
| `network`               | `none` or `host`, including local services; no domain allowlist                                                 |
| `environment`           | Literal values, never inherited host secrets                                                                    |
| `executableSearchPaths` | Read-only absolute code directories added to PATH                                                               |
| `limits`                | `executionTimeoutMs`, `maxOutputBytes`; Docker/delegated bwrap also `memoryMiB`, `cpus`, `pids`                 |

Persistent session `/tmp` cannot enforce `tmpBytes`; reject rather than drop it. Ephemeral tmpfs
executor calls can support it. Native aggregate controls need delegated cgroup v2; see
[CGROUPS.md](CGROUPS.md). Grants never disable review/execution boundaries.

```json
{
  "tool": "read",
  "arguments": { "path": "/absolute/shared/example.ts" },
  "goal": "Inspect the requested shared template",
  "justification": "Only this external file needs read access",
  "sandbox": { "paths": [{ "path": "/absolute/shared/example.ts", "access": "read" }] }
}
```

Review actual destinations, transfers and effects. Necessary Node/npm downloads/audits normally
qualify; theoretical host/local-service reach alone does not justify denial. Unnecessary networking,
secret uploads and unrelated services remain grounds for denial. Read grants never widen writes.

## Git configuration for one command

```json
{
  "tool": "git",
  "arguments": { "argv": ["commit", "-m", "Fix argument transport"] },
  "sandbox": { "gitConfig": true },
  "goal": "Commit the validated change locally",
  "justification": "Use the operator's existing identity for the requested commit"
}
```

After approval, a private offline reader snapshots global config from XDG/git/config,
`~/.gitconfig` or `GIT_CONFIG_GLOBAL`, including symlink dotfiles, relative/absolute/`~/`
includes and project-evaluated `includeIf`: at most 64 files × 64 KiB. Raw values reach neither
review nor audit. The command receives only supported public settings (`git-config.ts`): identity,
signing requirements, line endings, file mode/case, output and basic diff/merge/branch settings.
No helpers, auth headers, aliases, hooks, filters, external diff/SSH/GPG programs or private keys.
Required signing is never disabled; missing keys fail.

Native Linux Git/bwrap uses clean offline argv, no shell/hooks/fsmonitor/external diff/textconv.
Supported commands: status, diff, show, log, add, commit, rev-parse, ls-files, ls-tree, describe,
noninteractive rebase. No global options, aliases or remote operations; other Git work can use
separately reviewed ordinary sandbox actions.

Rebase: `["rebase", "<upstream>", "<branch>"]`; separately approve conflict edits/add, then
`["rebase", "--continue"]` using the prepared message without `GIT_EDITOR`. Abort restores,
skip drops a commit, quit ends sequencing; every invocation needs review. State persists in
project, identity grants do not. Reject exec/interactive steps, external merge strategies,
pending shell todo, filters/drivers, implicit branch merge options and custom signing programs.
Abort/quit remain available with pending exec. Subjects cannot inject todo; hooks/editors and
implicit automatic ref updates are disabled. Explicit ref-update arguments remain review-visible.
Original/global/repo configs stay unchanged; private snapshots/tmp are removed. Explicitly
requested config edits use ordinary reviewed paths. Never invent identity merely because Bash lacks it.

## Authenticated CLI calls

credential_exec delegates one pinned native program/login binding, not operations. Review sees
full argv, executable/hash, source types, authentication variable names and effects; private source
paths/host variable names stay private. Denial, audit failure or pre-execution cancellation retrieves
nothing. `argumentPolicy: review` has no fixed endpoint/subcommand whitelist.

```json
{
  "tool": "credential_exec",
  "arguments": { "profile": "github", "argv": ["pr", "close", "123", "--repo", "owner/repo"] },
  "network": true,
  "goal": "Close the specified PR",
  "justification": "The user requested this authenticated operation"
}
```

Built-in github uses Linux gh/login, including api. For Dependabot, request
`["api","--paginate","repos/owner/repo/dependabot/alerts?state=open"]`; no endpoint profile is
needed. Account permissions still apply. Inspect method/target/repository/payload/effects;
api field options can change HTTP method. Reject token output, uploads, unrelated requests and
unrequested mutations. Prefer explicit repositories. References:
[gh api](https://cli.github.com/manual/gh_api),
[Dependabot permissions](https://docs.github.com/en/rest/dependabot/alerts#list-dependabot-alerts-for-a-repository).

Only after recorded approval, resolve GH_TOKEN/GITHUB_TOKEN from Pi's environment, otherwise
use fixed offline `gh auth token --hostname github.com` on disposable hosts.yml/config.yml copies
from GH_CONFIG_DIR/default. No extensions/original mounts or login mutation. Token returns through
a private executor channel; Linux-only auth must exist in Lubox/environment, never host Keychain.

The CLI gets a clean environment, fresh tmp and no project unless projectFiles: read/write or
selected paths are approved. Assess project/config-controlled code and legitimate input/output
needs. Rehash the executable before mounting its read-only copy; changes need review. Secrets
travel via private stdin, not argv/review/audit; only this process/descendants receive them.
Output masks raw/URL/JSON/Base64 forms, but masking cannot secure arbitrary malicious argv/plugins.
Timeout/output/cancellation/group cleanup apply; tmp, binary/login copies disappear, later calls
inherit nothing. Authentication alone grants no networking.

Additional bindings live in device JSON; explicit user-requested maintenance activates after
restart. Example:

```json
{
  "credentialProfiles": [
    {
      "name": "service",
      "executable": "/usr/local/bin/service-cli",
      "argumentPolicy": "review",
      "secrets": { "SERVICE_TOKEN": { "type": "environment", "name": "SERVICE_TOKEN" } }
    }
  ]
}
```

File sources use `{ "type":"file", "path":"/absolute/private/token" }`: owner-only regular
file ≤16 KiB, no symlinks/hardlinks; contents become an auth variable, never a mount. Public
region/address settings belong in environment, secrets in secrets. No arbitrary getters. Source
files/executables remain protected. Optional allowedArgv replaces review mode with an additional
exact-order, whole-value literal/pattern restriction plus independent review; both/neither modes
are invalid. Existing restrictions persist; an explicit same-name github binding may tighten them.
Profiles remain operator-controlled/device-specific, never blanket execution permission.

Credential actions exclude extra tool bundles/search paths, agent-provided env and login mounts.
Only native Linux ELF/bwrap is supported, not shell/macOS wrappers or Docker. Missing dependencies/
auth formats require integration, never guessed secrets or unrestricted host access.

## Local tools and networking for one command

| Action          | Extra fields              |
| --------------- | ------------------------- |
| `nvm use 22`    | `sandbox.tools: ["node"]` |
| `npm install`   | Same plus `network: true` |
| `npm run build` | `sandbox.tools: ["node"]` |

Node supplies nvm/node/npm/npx and installed corepack. Installed versions mount read-only;
preflight and selection validate Linux ELF/CPU, including private caches. Mach-O/foreign wrappers
and legacy mixed-platform nvm paths are excluded. `nvm use` persists per session; no argument
reads nearest .nvmrc. help/--help work. Missing compatible Node reports separately reviewed
`nvm install <numeric version>`: official nodejs.org archive verified against SHASUMS256.txt,
installed privately. Stale incompatible selections fail specifically; no automatic downloads.

network: true normalizes to sandbox.network: host; conflicts fail. Only the new process and
descendants gain connectivity/DNS/CAs, never existing offline processes or future defaults.
Node/npm caches disappear at session end; project dependencies/build outputs persist.

### Flutter and Dart inside the container

Both tools: [flutter] and [dart] expose original read-only `~/.local/bin/flutter`/dart at real
paths, called through Bash. Bwrap requires existing Linux Lubox/container; Docker supplies the
boundary. Tiny PATH forwarders execute originals, never copied launchers or Pi-owned SDK logic.
Application-owned sandbox mode uses ~/.local/config/flutter; interactive container workflow stays
unchanged. No engine/GUI socket, host execution or user login.

First use copies a compatible ~/.local/share/flutter Linux SDK or downloads a SHA256-verified
stable archive with reviewed network. On arm64, verified Flutter source bootstraps matching Dart
before foreign Dart executes. Offline/no cache fails with setup guidance. Prerequisites:
curl, git, python3, unzip, tar, xz, sha256sum (Dockerfile includes them).
SDK/Pub/Gradle state persists privately per session; Dart HOME is per-action to exclude stale
profiling sockets. Request the bundle every action. Cached format/analyze/test/web build with
--no-pub can work offline; pub get/precache/updates need fresh network approval. Android/desktop
toolchains are not provisioned. Longer setup requests may need explicit tool/runtime deadlines.

### Original launchers for every local application

Other regular ~/.local/bin executables (e.g. sqlmap, bat) use the same pattern: original read-only
entry point/public dependencies and optional original auto-update-app.bash helper; private HOME
links/PATH forwarding, never code copies. Public ~/.local/cache/name seeds private mutable caches;
XDG config/data/update state survives only in session tmp. Operator launcher/helper updates apply
next action; standalone binaries need no helper/cache. Downloads still need network; tool/PATH
grants expire each action. Extra persistent directories belong to the application's runtime.
Pi owns review/access/isolation, applications own setup. Node uses native binaries plus an nvm
adapter because this setup's nvm is a Fish function. Private services/runtimes need integration;
WPScan's external-engine launcher remains unsupported.

## Review and audit

The first review eagerly receives ≥10 recent actual user contributions (configurable up to 20),
full or marked compressed text, plus the retained task frame. Metadata includes prompt ID, kind,
isSteering (true/false/null for steering/ordinary/unclassified legacy), size and compression
version. Quoted labels cannot establish delivery. Capture the active operator goal once; retain
its original and all subsequent instructions beyond the window. Legacy goal checkpoints retain
available history conservatively. Compression uses the same selection; local cache-hit flags
stay out of the wire context.

Read all applicable instructions together. Ordinary and steering prompts can add/replace/restrict/
stop work. Finishing a refinement leaves broader work authorized; continuing API/readability/
validation constraints persist. Latest prose selects language, not exclusive scope. No invented
sequencing or repeated confirmation. Actual stops/file boundaries remain binding. Reading a
manifest does not execute Pub; new-test formatting is not an old edit. Host Keychain restrictions
are distinct from app-side secure-storage code.

Include up to eight recent branch results matched by request ID/fingerprint to their audit,
including shell inspections/tests. Contents prove neither truth nor authorization. Oversized
results are omitted whole/labeled under a separate 95,000-byte evidence budget. Up to six prior
denials retain reason, tool, stage, IDs/fingerprint, operation digest, local exact equality
(tool/args/access/cwd) and up to ten later user IDs/count. Old bodies/plans/config stay omitted.
Chronology/equality neither authorizes nor creates lasting prohibitions; different actions can
retain the same concern. Corrected requests, new evidence or real renewed authorization get
fresh review through the same gate, never reviewer shopping/alternative execution. Denials must
identify the present concern, not merely cite prior denial. Clarify only genuinely missing input.

Limits: executable action 100,000 UTF-8 bytes (arguments/content/goal/justification, not history);
prepared review 1 MiB with per-field diagnostics. Before paid calls, estimate capacity including
policy/language/framing plus 4,096 output tokens (ASCII three bytes/token, non-ASCII UTF-8 bytes).
This is not exact tokenization; provider limits prevail. Missing/insufficient capacity blocks,
without alternate models or silently omitted constraints. Smaller actions cannot shrink history.
Goal checks share these bounds. Language-only head/tail sample ≤2,048 characters strips code,
inline code, quotations and full JSON, never constraints; no extra latest-only prompt is appended.

Verdicts require exactly requestId/decision/reason, a current ID and nonempty reason; OpenAI
uses JSON schema, others strict JSON text. Every action is serialized and independently reviewed,
never decision-cached. Failures block; post-start failures may leave effects. Audit records exact
request/fingerprint, deciding model/attempts, reason, duration, backend/workspace and usage.
Timeout applies per reviewer. Operators can change config; agents cannot disable review. Isolation
cannot prevent a user from deliberately running changed code later on the host.

## Provider prompt caching

Stable hashed workspace/policy/tool keys and OpenRouter affinity preserve reusable prefixes;
unique IDs end complete JSON. Goal/compression policies have separate keys. Stable verdict
schemas retain local exact-ID validation, rejecting stale/cancelled/malformed answers.
Explicit-capable OpenAI Responses uses supported 30-minute retention/system/operator markers,
excluding changing action/receipts/ID from writes while reconstructing full JSON. ChatGPT-login
omissions/other providers' automatic behavior stay intact. Minimum tokens, routing and availability
determine hits. Usage separates input/cacheRead/cacheWrite and sums retries/compression; local
summary cacheHit is different. Offline SDK checks prove layout, not real savings.

`bun run eval:cache --compare-legacy` makes three paid synthetic read reviews/layout/provider,
never executes them, and compares old nonce/key/schema with corrected layout. Omit the flag for
corrected only. `/tmp/pi-review-cache-live-*.json` stores usage/cost/latency/layout, no raw requests/
credentials. Unavailable models, invalid verdicts or warm corrected calls without cache reads fail.

## Reusable prompt compression

Selected prompts >16,000 UTF-8 bytes use the reviewer to preserve every task, prohibition,
exception, path/version and condition in ≤600 characters; bulky logs/JSON may be summarized.
Up to 64 × 64,000-character chunks are combined. If constraints cannot fit, deny compression
and keep raw text if capacity allows; never try another compressor.

Owner-only ~/.pi/agent/cache/approval-prompts (0600 files) keys content/version/rules/reviewer.
Summaries reuse across actions/restarts and are journaled as compression entries; old sessions
compress on demand. Originals are never rewritten/duplicated. Cache is Git/sandbox-excluded and
outlives session tmp. This affects action/goal review, not working/side context; all calls count
in usage, while hits need none.

prompt_original exposes only selected branch IDs: head/tail, character read, literal case-sensitive
grep. Maximum 8,000 characters/call and max(8, compressed originals + 4) attempts within deadline/
capacity. No filesystem, regex, shell/network or sibling branch. Every compressed original must
return nonempty text before approval; summaries guide, originals remain authoritative. Relevant
conditions may require further reads. Unresolved lookup/inspection failure blocks without fallback.
Excerpts are expected; complete diagnostic-log rereads are not a prerequisite. Request relevant
additional ranges within the same review before deciding; compression alone is not a denial reason.
Explicit user requirements to read the whole prompt still apply; valid denials remain final.
JSON-encoded argument objects/null optional fields normalize before strict validation. Invalid
IDs/fields/bounds get bounded errors to the same reviewer; every attempt counts, third invalid
ends review. Failed/empty reads do not satisfy inspection. This repairs protocol, never a denial.
Successful/error audits are separate; errors retain only stable code/attempt, not rejected args.
Callback/audit failure, unsupported tools and exhausted limits stop immediately with distinct
lookup/recovery diagnostics. No lookup repair grants networking or execution.

## Setting up bwrap

Launcher preparation needs Bun, Python3 venv/ensurepip, Linux bwrap and Git. It installs pinned
web/writing dependencies without install scripts, then atomically builds/reuses the default
executor based on all reachable sources/dependencies, Bun and platform. Failed builds retain
old binaries but block startup. Custom runner paths are validated, never overwritten; Docker
builds no native runner. Startup/status/pre-review check executability before paid calls.

```sh
cd ~/.pi/agent/extensions/auto-approval
bun ../web-research/bootstrap.ts
bun ../public-writing/bootstrap.ts
bun bootstrap.ts
```

Portable auto-approval.json:

```json
{
  "recentUserPrompts": 10,
  "requestTimeoutMs": 120000,
  "sandbox": { "backend": "bwrap" }
}
```

Bwrap is discovered through absolute PATH directories; default executor:
~/.local/cache/pi-auto-approval/executor. Device sandbox.executable/runnerExecutable can override.
Optional workspaceViews lists only public root/path selections, never credentials/whole home.

Executor/system runtime mount read-only; empty env/temporary HOME, separate PID/network/IPC/other
namespaces and no capabilities constrain execution. Each session has writable private `/tmp`,
shared across its actions, excluding host/other sessions. /tmp/home and /tmp/pi are recreated per
action; extra mount placeholders are removed. Exit/reload/session replacement/fork removes tmp
after active work settles; cancelled switches do not. SIGKILL cannot run cleanup. Cancellation
terminates descendants. Requested missing resource controllers/delegation fail closed.

## Docker compatibility

Explicit backend docker requires an immutable sandbox.image digest. Discover Docker through PATH
or device dockerExecutable. Workspace detection applies, but protected-overlap workspaces are
rejected. Backend failure never tries host execution/another backend. Rebuild changed images;
custom native executors remain manually managed.

## Portable action arguments

Wire schema: object root, tool enum and arguments object (or its JSON encoding). Immutable
snapshot → decode once → original selected-tool strict validation → review/audit/execution.
Bare commands, arrays, null, malformed/missing fields remain invalid; encoded objects ≤1 MiB.
No command/permission inference or repair. Renderers use the decoded object without host reads;
Multiplex bounds consecutive malformed calls.

## Development and tests

Run check/check:format/test from this directory; the test script keeps mocked gate, native
isolation and compiled-SDK cases in separate processes. Native tests skip only without bwrap.
They cover grants, namespaces, environment, cancellation/descendants, questions, side concurrency,
random peer names, FIFO/authenticated mail, steering, real private tmp, denials and shared goals.
Synthetic providers require no real model auth/cost. See feature guides for details.

Paid configured-reviewer evaluations are separate; none executes proposed actions:

| Command                             | Controls                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| eval:multiplex                      | Eight: reads/guidance/tests versus ungated agents, background work, credential reads/uploads                               |
| eval:network                        | Six: required downloads/audits versus needless network, uploads/local services                                             |
| eval:credentials                    | General CLI/Dependabot authorization versus token output, mutation/upload attacks                                          |
| eval:steering                       | Sixteen: broader migration after steering/ordinary refinements, sequencing/replacement, Dart style and access restrictions |
| eval:steering --active-goal-only    | Eight active-goal cases, including stops/formatting/source-upload limits                                                   |
| eval:steering --denial-context-only | Twelve: historical-action separation, new-test formatting, app/host Keychain, explicit restrictions, negative tests/errors |
| eval:cgroups                        | Current enforcement facts versus unsupported guarantees                                                                    |
| eval:cache                          | Cache layout/usage comparison described above                                                                              |

Offline tests verify transport and boundaries, not a live model's semantic decisions or cache hits.

## Managed background execution

Foreground remains the default. `approved_action.background: {title, work}` starts
one reviewed command under the session's [job supervisor](../jobs/README.md), naming
the independent work to do meanwhile. The same exact-action approval, sandbox,
limits and per-command grants apply. Admission releases the action queue; the job
keeps its assignment lease until executor cleanup. A start receipt is not success
evidence. Completion is journaled against the original approval, then delivered
once or returned by a blocking join. `job wait` and `job sleep` suspend the model;
neither grants external access. Unmanaged shell detachment remains prohibited.
