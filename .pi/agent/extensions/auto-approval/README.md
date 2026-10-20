# Pi Auto-Approval

For module ownership, lifecycle and development checks, see the [architecture guide](../README.md).

Every external agent action is reviewed by an independent model. Approved actions then run in a separate sandbox. Direct external tools, `!`/`!!`, nested external tool calls and a local execution fallback are blocked. Multiplex's internal `mailbox` transport is outside approval: the hook returns immediately without inspecting message content or contacting a reviewer. The Multiplex extension owns its session-bound delivery.

Built-in prompts, interface messages, source comments and extension documentation use English. Model replies and review explanations still follow the latest actual operator prompt's language. Multilingual regression inputs deliberately retain their original languages.

## Startup and status

Restart Pi after extension changes. `/auto-approval` shows reviewers, sandbox backend, working directory, detected workspace and complete configuration path.

The footer shows only the reviewer currently handling an action, with a spinner, while review is active. It clears after review or action completion; an unavailable configuration retains `approval: LOCKED`. Idle state, unused fallback models, thinking levels, action names and elapsed review times do not occupy the footer. Complete reviewer choices, fallback failures, timings and decisions remain in the activity log and audit.

Technical failures before independent review identify the failing preflight stage. The model display remains `—` because no reviewer was called. Web search and page fetch use an empty, read-only sandbox workspace without project mounts or project validation. They need no legacy skill files; private session `/tmp`, resource validation and independent network approval remain active.

`~/.pi/agent/auto-approval.json` is synchronized through the public dotfiles repository. It contains model and review settings and the sandbox backend, but no device paths or workspace permissions. Optional local paths and permissions belong in `auto-approval.device.json`, which Git excludes. With another `PI_CODING_AGENT_DIR`, both files live there. Configuration is reloaded for every action.

`reviewers` lists models in priority order: first `openai` with model ID `gpt-6-luna`, then the explicitly configured `openrouter` fallback `openai/gpt-6-luna`. Only listed reviewers are tried, independently of the working model. Missing authentication or models, unsupported thinking levels, transport errors and timeouts permit fallback. A valid denial ends review. Safety refusals and truncated or aborted model answers also block the action without trying another model. A complete request-bound `deny` remains binding even if the provider subsequently reports a transport failure. Fixed diagnostic categories replace raw provider errors that could contain credentials or prompt text. Invalid verdicts or verdicts belonging to another request block execution without fallback. Credentials remain private; `/login` configures each provider on each machine.

## Conversation features

Review intent includes recorded operator delivery mode and the current task frame. Steering is
evaluated alongside the original task, while later replacements, stops and restrictions take
precedence. This metadata contains no team topology or assignment information. See the
[Conversations documentation](../conversations/README.md#corrections-during-ongoing-work) for capture,
retention, compression and legacy-session behavior.

`/goal`, `/side` and steering reminders belong to the separate [Conversations extension](../conversations/README.md). [`/multiplex <n>`](../multiplex/README.md) starts concurrent equal peers. Their internal messageboxes require no reviewer or approval request. They can be scheduled alongside pending reviews and commands, while this extension's own queue still serializes external review and execution. Every external action by every member continues to use this approval and sandbox path. Action review is independent of team topology: it receives the exact operation, sandbox access, actual operator instructions and relevant action evidence, without member names, team size, accepted plans or assignment metadata. Multiplex enforces coordination locally before review and keeps the assignment pinned until execution ends. Local coordination preflight failures remain in the session audit but are excluded from previous action-review denials. Peer messages do not become operator authorization. Actual ungated execution and other material security concerns remain grounds for denial; valid denials never trigger another model in search of approval. Genuine operator prompts are preserved, including any instructions about teamwork.

`bun run eval:multiplex` runs eight review-only semantic cases against the configured reviewers: bounded reads (including an earlier mistaken delegation denial), build guidance and foreground tests should be approved; actual ungated agents, detached commands, credential reads and source uploads should be denied. Pi reviewer authentication must be available on the current machine. No proposed action is executed.

## Automatic workspace detection

- A project repository uses its Git root as the workspace. Actions still run in their original working directory.
- Without a project repository, the current directory is used.
- A Git root at or above the home directory is ignored. An uninitialized project under home therefore receives no access to all dotfiles.

Pi started directly in home requires a restricted `sandbox.workspaceViews` entry in `auto-approval.device.json`. The local setup lists individual public, versioned dotfiles. Unversioned files, credentials and active approval code are not mounted. This view permits edits to mounted files but no new files in their read-only parent directories. Ordinary project work needs no local allowlist.

Workspaces inside the active Pi installation, approval configuration or known credential directories remain blocked. Protected files inside otherwise permitted bwrap workspaces are masked. Hardlinks are allowed when every link to the inode stays inside mounted, unprotected paths, supporting Cargo artifacts between `release` and `release/deps`. bwrap allows symlinks into the already read-only system `/usr`, such as a virtualenv's Python. Other outward links, links into protected directories and Unix sockets are rejected. Dangling build-cache symlinks do not block the workspace; missing targets are not mounted.

## Tool display

`approved_action` uses the selected tool's original Pi renderer. Reads retain expandable output, syntax highlighting and truncation notices. Edits show the standard diff with line numbers from the actual sandbox result. Writes, Bash and other tools keep their normal presentation. Approval decisions appear as separate entries in the activity log; no approval widget remains above the input prompt.

Tools without a native result renderer, including authenticated commands and
local Git commands, use a shared three-screen-line preview. Long single-line
JSON is bounded by terminal width, not just newline count. The configured
expansion key (normally Ctrl+O) reveals the complete stored output. The same
preview covers generic error diagnostics; their initial reason remains visible.
Original results, receipts and model-visible evidence are unchanged.

Edit previews read no host files before approval. The diff appears after approved execution and survives expansion and session restoration. Denials and execution failures are displayed as such.

## Request additional sandbox access

When a user task needs additional access, the working model adds `sandbox` to the concrete `approved_action` request. The reviewer assesses the entire action and access expansion against the actual user request. An obvious requirement needs no additional chat confirmation. Approval applies only to this execution; the next action starts with default permissions again.

Supported dimensions:

- `tools`: individually selected local bundles such as `"node"` or `"sqlmap"`. Runtime mounts are validated; caches and updates stay in private session `/tmp`.
- `paths`: existing absolute file or directory paths with `access: "read"` or `"write"`. Symlinks are resolved before review so the reviewer sees actual mounts.
- `network`: `"none"` or `"host"`. Host networking also reaches local services. The exact command and possible data transfers are reviewed.
- `environment`: explicit literal values. Host environment variables and secrets are not inherited automatically.
- `executableSearchPaths`: additional absolute tool directories, mounted read-only and added to the search path.
- `limits`: `executionTimeoutMs` and `maxOutputBytes`; Docker and properly delegated native bwrap also support `memoryMiB`, `cpus` and `pids`. Persistent session `/tmp` is filesystem-backed and cannot enforce `tmpBytes`; such requests are rejected. `tmpBytes` remains available for individual executor calls using ephemeral tmpfs. Native aggregate limits require a configured writable cgroup v2 delegation; missing delegation fails closed.

Necessary `nvm install` downloads, `npm install` project dependencies and `npm audit` registry queries should be approved when they match the user task. Review considers concrete destinations, data transfers and effects. The theoretical reachability of other hosts or local services through `network: host` is insufficient by itself to deny an action; the backend provides no domain allowlist. Unnecessary networking, credential uploads and unrelated local-service access remain grounds for denial. Every call is reviewed separately.

Example of a necessary external read:

```json
{
  "tool": "read",
  "arguments": { "path": "/absolute/shared/example.ts" },
  "goal": "Inspect the shared template specified by the user",
  "justification": "The template is outside the project; only read access to this file is needed.",
  "sandbox": {
    "paths": [{ "path": "/absolute/shared/example.ts", "access": "read" }]
  }
}
```

Requested access appears beside the normal tool display and is logged with its resolved plan. Long shell commands start collapsed; `ctrl+o` shows the complete command. Review and execution always use the unchanged original. Additional read mounts do not expand existing write permissions. Hardlinks between writable and read-only mounts are rejected. Active approval code, configuration, known credential directories and the entire home remain protected. No request can disable the executor or independent review.

Successful Bash output duplicated by the SDK in both text content and structured output is transported once, alongside the structured exit status and timing metadata. This avoids charging the same payload twice against `maxOutputBytes`; the bounded transport, timeout and process cleanup are unchanged. Different or truncated structured output is preserved.

## Provider availability

The [Provider Recovery extension](../provider-recovery/README.md) manages retries and cooldowns for working models. Reviewers and compressors share the same availability service; valid denials remain final.

## Git configuration for one command

For a local commit using the existing operator identity, the model uses the argv-based `git` operation and requests `sandbox.gitConfig: true`:

```json
{
  "tool": "git",
  "arguments": { "argv": ["commit", "-m", "Fix AArch64 indirect-call argument transport"] },
  "sandbox": { "gitConfig": true },
  "goal": "Commit the validated change locally",
  "justification": "The user requires local commits; this commit needs their existing Git identity."
}
```

Each invocation needs separate approval. Review context contains the scope and lifetime of access, not configuration values. Only after recorded approval does the gate read existing global configuration: `$XDG_CONFIG_HOME/git/config`, `~/.gitconfig` or an explicit `GIT_CONFIG_GLOBAL`. Regular files, symlink-based dotfiles and relative, absolute and `~/` includes are supported. Git evaluates `includeIf` against the current project. Each action allows up to 64 files of at most 64 KiB each. A fixed private offline reader receives only read-only snapshots and a read-only project view; raw data enters neither model context nor audit.

The actual Git process receives only a read-only copy of supported public settings: identity, signing requirements, line endings, file mode, case handling, output format and basic diff, merge and branch settings. Credential helpers, HTTP authorization headers, aliases, hooks, filters, external diff/SSH/GPG programs and other executable settings are not delegated. Private signing keys are not delegated either; required signing is not silently disabled. `git-config.ts` lists all supported keys.

This path uses native Linux Git inside bwrap with a clean environment, no networking and no shell. Hooks, filesystem monitoring and external diff calls are disabled. Supported commands are `status`, `diff`, `show`, `log`, `add`, `commit`, `rev-parse`, `ls-files`, `ls-tree`, `describe` and noninteractive `rebase`. Global Git options, aliases, external text conversion and remote operations are excluded; other history-changing commands remain unsupported by this route. Other Git operations can still be requested as separately reviewed ordinary sandbox actions.

For an authorized rebase, use the same interface with `"arguments": { "argv": ["rebase", "<upstream-commit>", "<branch>"] }` and `"sandbox": { "gitConfig": true }`. After separately reviewed conflict edits and `git add`, request `["rebase", "--continue"]`. The executor accepts the prepared commit message without an editor; do not request `GIT_EDITOR`. `["rebase", "--abort"]` restores the pre-rebase state and `["rebase", "--skip"]` drops the conflicting commit. Every invocation still requires its own approval. Rebase state persists in the project between calls; the identity grant does not.

The Git-only rebase route rejects `--exec`, interactive sequence editing, external merge strategies and pending `exec` steps in an existing todo list. Repository filter programs, custom merge drivers, implicit branch merge options and custom signing executables also prevent execution through this route. Use a separately reviewed tool workflow when these are required. Hooks and sequence editors are disabled, commit subjects cannot inject generated todo instructions, and configured automatic updates to other branch refs are disabled. Explicit rebase arguments, including any request to update other refs, remain visible to the reviewer. Existing signing requirements are preserved; unavailable signing keys cause failure. Recovery with `--abort` or `--quit` remains possible when the pending todo contains shell steps.

Global originals and local repository configuration remain unchanged. The Git call receives its own temporary filesystem; private snapshots are removed afterward. Subsequent Bash or Git actions do not automatically inherit configuration. Requested configuration changes remain possible through explicitly reviewed ordinary `sandbox.paths` read/write permissions.

## Authenticated CLI calls

`credential_exec` delegates an operator-configured program and credential binding to one reviewed CLI invocation. The binding specifies the native executable and credential sources; it grants no operation by itself. With `argumentPolicy: "review"`, the reviewer decides on the complete command. No per-subcommand allowlist is maintained. Review considers the user request, all arguments, selected profile, executable name and hash, and service effects. Private source paths and original host-variable names stay in the gate; reviewers see source type and CLI authentication variable names. A denial retrieves no credentials. Failed audit logging or cancellation before execution also prevents retrieval.

Example of a PR closure explicitly requested by the user:

```json
{
  "tool": "credential_exec",
  "arguments": {
    "profile": "github",
    "argv": ["pr", "close", "123", "--repo", "owner/repo"]
  },
  "network": true,
  "goal": "Close the specified PR",
  "justification": "The user requested this PR closure; their GitHub authentication is needed."
}
```

The built-in `github` profile binds system-installed native Linux `gh` to existing authentication. It uses the same general review mode as other CLIs. `gh api`, new subcommands and additional options can therefore reach independent review without gate changes for each API endpoint. Repository, method, target, payload and effects must match the actual user request. The reviewer must reject token output, credential uploads, unrelated actions and unrequested changes. Explicit repository targets avoid unnecessary project access.

For example, request Dependabot alerts with `arguments: {"profile":"github","argv":["api","--paginate","repos/stuck-lehnert/sortsys/dependabot/alerts?state=open"]}` and `network: true`; `goal` and `justification` describe the actual audit task. No new endpoint profile is needed. GitHub authentication must itself have Dependabot read permissions; the sandbox does not expand account permissions. `gh api` field options can change the HTTP method, so review considers all arguments rather than just `api` or `GET`. See the [CLI documentation](https://cli.github.com/manual/gh_api) and [Dependabot permissions](https://docs.github.com/en/rest/dependabot/alerts#list-dependabot-alerts-for-a-repository).

Only after recorded approval is `GH_TOKEN` or `GITHUB_TOKEN` retrieved from Pi's process environment. If neither exists, a separate offline sandbox call runs only `gh auth token --hostname github.com`. It receives private copies of `hosts.yml` and, if present, `config.yml` from `GH_CONFIG_DIR` or the standard gh configuration directory. gh can migrate the copies; originals are neither mounted nor changed. Extensions and other files are not copied. The token exits only through the private executor channel to the gate. Authentication stored exclusively in macOS Keychain is unavailable inside Linux: authenticate gh inside Lubox or start Pi with a suitable token. There is no host or Keychain fallback.

The actual CLI invocation receives no added shell, inherited host environment or shared session `/tmp` data. Without explicit file access, project files are not mounted. `sandbox.projectFiles: "read"` or `"write"` requests the current project view with those permissions and current working directory. `sandbox.paths` requests selected files/directories instead or additionally, such as a readable comment file. Both are reviewed with the command; credential sources and gate code remain protected. Private CLI configuration or project code can enable execution and must be considered when it poses a concrete risk. The reviewed executable is rehashed before execution and mounted as a read-only copy; an intervening update requires another review. Only this invocation and its descendants receive selected authentication variables. Tokens travel through a private stdin protocol and appear in neither process arguments nor review context or audit. Ordinary CLI output masks selected token values and their URL, JSON and Base64 forms. Output limits, timeout, cancellation and process-group cleanup still apply. The private temporary filesystem, executable copy and login copies are removed afterward. Subsequent ordinary actions receive no credentials.

Additional program/credential bindings are configured once outside Pi in `auto-approval.device.json`. A review profile contains no token values or list of service operations: only the executable, sources and `argumentPolicy: "review"`. New commands need action review rather than new operator configuration. This example represents a separately installed trusted service CLI:

```json
{
  "credentialProfiles": [
    {
      "name": "service",
      "executable": "/usr/local/bin/service-cli",
      "argumentPolicy": "review",
      "secrets": {
        "SERVICE_TOKEN": { "type": "environment", "name": "SERVICE_TOKEN" }
      }
    }
  ]
}
```

Alternatively, `{"type":"file","path":"/absolute/private/token"}` references a regular owner-only file of at most 16 KiB with no symlink or hardlinks. Its contents become an authentication variable; the file is not mounted. Optional `environment` values are public settings such as region or service address. Secrets always belong in `secrets`. Arbitrary credential-getter commands are unsupported. File sources and profile executables are additionally protected during ordinary sandbox actions.

Instead of `argumentPolicy: "review"`, an operator can configure an additional `allowedArgv` restriction. Every sequence must cover all arguments in exact order; `literal` matches exactly and `pattern` must match an entire individual value. Existing `allowedArgv` profiles retain their restriction and still require independent action review. Both modes together, or neither mode, are rejected. Operators select trusted executables and suitable credential sources. In review mode, the reviewer limits the concrete command's targets and effects. Even trusted CLIs can start programs, transfer data or transform secrets through arguments; these effects must be reviewed. A profile is not blanket permission for shell/interpreter, plugin, debug or credential-output commands. Output masking cannot replace a trusted CLI or argument review: malicious programs could encode or transmit secrets differently. The executable receives the token's actual service permissions, so every concrete effect needs authorization.

Profiles remain device-specific, are loaded per action and can be changed only by the operator. An explicit same-name profile can replace `github`, for example to impose additional argument restrictions. File access must be requested and reviewed each time. Additional tool bundles, search paths, agent-controlled environment variables and login-directory mounts are excluded. Networking is independent of authentication and requested per invocation; without a network flag, credential calls remain offline. This path currently supports only native Linux ELF executables with bwrap; shell/macOS wrappers and Docker are rejected before model review. Tools receive only configured authentication variables and explicitly approved files. Other authentication formats or missing runtime dependencies still require operator integration; no secret source is guessed and no unrestricted host view is granted.

## Local tools and networking for one command

`sandbox.tools: ["node"]` gives an action `nvm`, `node`, `npm`, `npx` and, when installed, `corepack`. Existing Node versions are mounted read-only. Before approval, the extension checks each version's ELF header and CPU architecture; the sandbox checks them again on selection, including private caches. In a home directory shared from macOS, Mach-O binaries, foreign architectures and their shell wrappers are excluded, including older nvm directories without platform separation. The macOS nvm launcher is not passed through.

`nvm use 22` selects a compatible Linux version; subsequent Node actions in the same session retain that selection. Without a version argument, `nvm use` reads the nearest `.nvmrc`. `nvm help` and `nvm --help` show supported commands. If Linux Node is missing, the sandbox reports the necessary `nvm install 22` request with separately reviewed `network: true`; nothing downloads automatically. Stale selections pointing only to incompatible files produce a specific error. Request the tool bundle again for each action needing it.

For example, use three independently reviewed shell actions:

| Command         | Additional `approved_action` fields               |
| --------------- | ------------------------------------------------- |
| `nvm use 22`    | `"sandbox": {"tools": ["node"]}`                  |
| `npm install`   | `"sandbox": {"tools": ["node"]}, "network": true` |
| `npm run build` | `"sandbox": {"tools": ["node"]}`                  |

The shell flag `network: true` requests network access only for the newly started command and its descendants. Independent review checks it alongside the exact command before startup. The extension translates the flag to `sandbox.network: "host"`; conflicting declarations are rejected. Without a request, each action starts in its own network namespace without host networking. An approved network command changes neither existing processes' namespaces nor subsequent defaults. DNS configuration and public CA certificates are also mounted read-only only for this invocation.

`nvm install <numeric version>` downloads the official Linux distribution from nodejs.org, verifies SHA256 against `SHASUMS256.txt` and installs it into private `/tmp`. It also requires a network request. npm caches and newly installed Node versions disappear at session end; project dependencies and build results remain in the project.

### Flutter and Dart inside the container

Use `sandbox.tools: ["flutter"]` or `["dart"]` with the existing `bash` action. Both names
select the same bundle and expose both commands. With bwrap, Pi must already run inside Lubox
or another Linux container. The Docker backend supplies that container boundary directly.
Pi mounts the actual `~/.local/bin/flutter` and `~/.local/bin/dart` launchers read-only at their
original paths. Small PATH forwarders execute those files directly; no launcher code is copied
into Pi. Their explicit sandbox mode prepares and runs a Linux SDK inside the existing container.
The launchers own SDK preparation under `~/.local/config/flutter`; normal interactive invocation
continues using their Docker/Podman workflow. No engine socket, host execution, GUI socket or
user login is passed to the sandbox command.

```json
{
  "tool": "bash",
  "arguments": { "command": "flutter pub get", "timeout": 850 },
  "goal": "Install dependencies for the requested Flutter project",
  "justification": "Download its declared packages and prepare the private Linux SDK",
  "sandbox": {
    "tools": ["flutter"],
    "limits": { "executionTimeoutMs": 900000 }
  },
  "network": true
}
```

The independent reviewer approves the exact command and network request before execution.
First use copies a compatible Linux SDK from `~/.local/share/flutter` read-only, or downloads the
official stable Linux archive into private session storage and verifies its published SHA256.
On Linux arm64, an x64-only archive supplies verified Flutter source; its official bootstrap
replaces foreign Dart with the matching Linux arm64 runtime before any Dart executes.
No compatible cached SDK while offline produces an actionable setup error. Installation checks
container prerequisites (`curl`, `git`, `python3`, `unzip`, `tar`, `xz`, `sha256sum`) before downloading.
Lubox's existing system tools serve bwrap; the supplied Dockerfile installs the core prerequisites.

SDK, pub and Gradle caches survive separately approved actions in the same session and disappear
with its private temporary storage. Dart's HOME stays per-action so profiling sockets do not leak
into later actions. Include the bundle on every action that needs it. Commands such as
`dart format`, `flutter analyze --no-pub`, `flutter test --no-pub` and `flutter build web --no-pub`
can run offline once their dependencies and artifacts are cached. Package downloads, precaching
and SDK updates need another reviewed `network: true` action. Android and Linux desktop builds
also need their platform toolchains in the container; this core integration does not provision them.

### Original launchers for every local application

Other regular executable launchers from `~/.local/bin` can be requested by name, such as
`sandbox.tools: ["sqlmap"]` or `["bat"]`. Pi mounts the selected original launcher read-only at
its real path and forwards PATH calls to that executable. It never copies launcher code into Pi
or replaces it with an application implementation. The original `auto-update-app.bash` helper is
also mounted read-only when installed. HOME compatibility links point to those exact files;
these links live only in the current action's private HOME.

Public `~/.local/cache/<name>` code is mounted read-only and seeds a private cache copy. Standard cache,
XDG configuration and `.local/share` application data survive in session-private storage; installation updates
modify only that state. Changes made by the operator to the original launcher/helper are picked
up on the next approved action without reusing stale code copies. An existing cache works offline;
all downloads still need separately approved networking. Tool access and its PATH entries expire
when the action ends. Other files created directly in action HOME are temporary; applications
that need additional persistent directories declare them in their own sandbox runtime. Standalone executables require neither a cache nor an update helper.

This is the integration rule for additional local applications: use the original read-only
entry point, declare only its necessary public dependencies, and keep mutable state private.
Application-specific sandbox behavior belongs to that application's runtime, as with Flutter;
Pi owns access, review and process isolation. The Node bundle supplies native installed runtime
executables and an nvm adapter; this setup's nvm is a Fish function, not a `~/.local/bin` launcher.
Tools needing additional private files, services or runtimes require further integration.
The current WPScan launcher needs external engine access and remains unsupported.

To assess existing code, reviewers receive text results of previously approved actions from the same session branch: reads, file searches and shell output from commands such as `cat`, `sed`, `git diff` or tests. Tool results must match their approval record, request ID and fingerprint. Contents and output are evidence, never user instructions. At most eight recent results are included. Results exceeding the context budget are omitted in full and explicitly identified.

The first reviewer request eagerly includes at least the latest ten available actual user contributions in chronological order. `recentUserPrompts` can expand this window up to twenty; older configurations below ten use ten. `userPromptInfo` identifies each prompt's ID, recorded input kind, explicit `isSteering` flag, original size, `compressed` status and compression version. Compression-cache hits remain in the local audit rather than changing the review context. Small prompts appear in full in `userPrompts`; large ones may appear as cached summaries. No lookup is needed to receive those texts or summaries. The most recent recorded task and every subsequent instruction are retained beyond that window, including when the latest continuation lacks delivery metadata. The active operator goal and current action remain complete.

Each prompt has an `isSteering` flag: `true` for authenticated steering input, `false` for authenticated ordinary input or captured operator commands, and `null` for legacy prompts without reliable delivery metadata. Compression leaves this flag intact. Labels inside quoted text, assistant messages and peer claims cannot establish it.

When an operator goal is active, the envelope begins with `operatorGoal` and `taskContext`, before the recent prompts and proposed action. Selection retains the captured goal and all subsequent user instructions even beyond ten inputs; legacy checkpoints without a captured goal conservatively retain the available user history. Compression uses that same selection. Each action snapshots the active goal once and records it in its audit so its actual review scope can be inspected later.

Input delivery does not determine semantic priority. Ordinary non-steering prompts and steering prompts can both add refinements or subtasks to an earlier goal. The reviewer considers all applicable user instructions to identify the broader authorized objective; a recorded task anchor is delivery metadata and does not select the only semantic goal. Completing an additive refinement leaves the remaining original work authorized without another user prompt. Actions implementing another requested feature, test, documentation change or code-quality improvement can advance that goal even when they have no connection to the latest refinement.

Finite corrections and continuing constraints have different lifetimes. Finishing "make this field optional" does not end the broader migration or discharge "preserve API contracts". The reviewer does not impose implementation ordering unless the user explicitly requests it. Audited results may supply completion evidence; assistant claims cannot create authorization or override a restriction. Explicit stops, task replacements, file boundaries and withdrawn permissions remain binding. The latest prompt's prose selects the verdict language, not its exclusive task scope.

Review applies restrictions to the exact operation: reading a manifest does not execute Pub, and reading a test does not format it. A restriction on formatting-only hunks does not prohibit functional fixes elsewhere in the same file. Quoted reviewer scope opinions do not cancel the operator's broader task; explicit user-adopted restrictions still apply.

Up to six earlier denials retain reason, request ID, fingerprint, tool, technical failure stage and the number of actual operator contributions received afterward. This count describes chronology, not automatic invalidation. Prior reviewer opinions do not create user prohibitions; still-applicable material concerns must be assessed for the exact present action. Old action bodies, configuration and sandbox plans are marked omitted and remain in the local audit. An earlier large command therefore cannot block a later small read. Additional reviewed tool evidence has its own 95,000 UTF-8 byte budget and is considered even with large user contributions.

Each executable action retains the executor's 100,000 UTF-8 byte limit. Oversized actions are explicitly reported before paid review. This limit covers serialized command or file content, tool arguments, goal and justification; user history and review evidence do not count toward it.

The language reference inside the complete review envelope uses at most the head and tail of 2,048 characters of the original latest prompt's own prose, including after compression. Code blocks, inline code, Markdown quotations and complete JSON blocks are removed only from this language sample. It sets explanation language without replacing user constraints. There is no extra final message repeating only the latest correction.

Prepared reviews have a 1 MiB limit rather than the earlier 100,000 bytes. Errors report total size and major field sizes; a smaller command does not reduce accumulated user context. Before every provider call, the registered model window is checked, including policy, language metadata, 4,096 output tokens and message framing reserve. The estimate uses three bytes per token for ASCII JSON and UTF-8 byte counts for non-ASCII. It is not exact tokenization; the provider enforces its actual limit. A model with missing or estimated insufficient capacity is unavailable for that request; only then may a configured fallback take over before a model decision. User instructions and actions are not shortened to fit, and valid denials remain final. `/goal` reviews use the same rules.

## Provider prompt caching

Review requests use a stable, hashed routing key for each workspace, policy and tool set.
OpenRouter receives that key as its session-affinity header. Each unique action ID appears
at the end of the complete review JSON. Changing the action or reusing a saved prompt summary
does not change the shared prefix. Goal reviews and prompt
compression use the same client, with separate keys for their policies.

The OpenAI verdict schema stays identical between requests. The local parser still requires
the returned ID to match the exact pending request, and malformed, stale or cancelled verdicts
cannot authorize execution. Every action receives an independent review; decisions are never
cached.

For OpenAI Responses models advertising explicit caching, the client requests the SDK's
supported 30-minute retention and marks the system instructions and shared operator context.
Explicit mode keeps changing actions, receipts and request IDs outside cache writes. The
wire text still reconstructs the complete original review JSON. SDK omissions for ChatGPT
login remain intact; other providers retain their automatic caching behavior. Provider token
minimums, cache availability and routing still determine actual hits.

Reported usage retains separate `input`, `cacheRead` and `cacheWrite` counts, including retry
and compression costs. These provider token counters are distinct from the local summary
cache's `cacheHit` flag. Offline SDK tests verify the request layout and usage mapping;
they do not measure live provider cache savings.

Run `bun run eval:cache --compare-legacy` in this extension directory for a live comparison
using the configured reviewers and existing Pi login. It submits three synthetic read-action
reviews per layout and provider, with no action execution. Legacy mode replays the old nonce
placement, per-action routing key and changing output schema through the current client.
The report under `/tmp/pi-review-cache-live-*.json` contains token usage, SDK cost estimates,
latency and cache-layout checks, without credentials or raw requests. A run fails if a provider
is unavailable, a verdict is invalid or warm corrected requests report no cache reads. Model
calls incur normal provider charges. Omitting `--compare-legacy` tests only the corrected layout.

## Reusable prompt compression

For selected user prompts larger than 16,000 UTF-8 bytes, the configured small reviewer compresses the prompt before the actual review. It must preserve tasks, prohibitions, exceptions, paths, versions and conditions while summarizing bulky logs or JSON. Summaries allow at most 600 characters. Large prompts are processed in up to 64 sections of at most 64,000 characters each, then combined. If necessary constraints cannot fit, compression is denied and the raw prompt is retained if it fits the review budget. A compression denial never tries another compressor.

Summaries are privately saved under `~/.pi/agent/cache/approval-prompts/`, or the corresponding alternative agent directory. Directories are owner-only and files have mode 0600. Cache keys include original contents, version, compression rules and configured reviewers. Identical prompts are reused on later actions or after restart without recompression. Sessions also contain `auto-approval-prompt-compression` entries. Raw prompts are not rewritten; older chats without compression entries are compressed on demand at their next required review. The cache contains summaries, not extra originals, and is excluded from Git and action sandboxes. It persists independently of temporary session `/tmp`.

For compressed prompts, the reviewer receives only the `prompt_original` tool. It reads the original from the selected session branch using its prompt ID: `head`, `tail`, `read` with character offset, or literal case-sensitive `grep`. Each call returns at most 8,000 characters; each reviewer gets a lookup budget of the larger of eight or the number of compressed originals plus four. This accommodates every selected original and bounded follow-up reads under the existing context limits and per-reviewer deadline. File paths, shell commands, regexes, networking and other branches' originals are inaccessible. Lookups are recorded. Before approval, every compressed original must have supplied text at least once; reviewers must inspect further for relevant conditions. The original remains authoritative and the summary is only a guide. Model denials remain final; unresolved lookup failures or approval without required original inspection block execution without fallback.

The original reader accepts a JSON-encoded argument object and optional fields sent as `null` as equivalent wire encodings; required fields, selected prompt IDs, operation names and bounds still undergo strict validation. Other fields and filesystem paths are rejected. Invalid arguments, unknown prompt IDs and out-of-range reads return a bounded error to the same reviewer so it can correct the lookup. Every attempted read consumes the per-reviewer lookup budget. The third invalid read ends the review; the existing deadline and capacity checks still apply. A failed or empty read never satisfies required original inspection. This is protocol repair before a verdict, not a retry of a denied action or a switch to another reviewer.

Successful reads and repair errors have separate audit entries. Error entries contain only a stable code and attempt number, without rejected argument contents. Audit/display callback failures, unsupported tools and exhausted limits stop execution immediately without fallback. The surfaced failure now distinguishes those conditions from provider-recovery audit failures instead of reporting all of them as an original-prompt lookup error. Flutter/Dart downloads still require their own approved network scope; the original-reader repair grants no connectivity or execution access.

Compression and subsequent review turns contribute to displayed tokens and costs. Cache hits need no compression call. The feature applies to action approval and `/goal` reviews; working models and `/side` retain their existing context.

## Setting up bwrap

`~/.local/bin/pi` requires Bun and Python 3 with `venv`/`ensurepip` for startup preparation. It prepares [Web Research](../web-research/README.md) and [Public Writing](../public-writing/README.md) and installs pinned dependencies with install scripts disabled. On Linux it builds the default executor when missing or when `runner.ts`, its web/writing modules and dependencies, Bun version or platform change. Unchanged installations are reused. Failed builds block startup while retaining the existing executor. Binary replacement is atomic so existing Pi sandboxes can continue.

Linux additionally requires Bubblewrap and Git. The sandbox uses the standalone executor and system programs under `/usr`. Custom `sandbox.runnerExecutable` paths are validated but never built or overwritten. Docker does not build a native executor.

Native executables are checked at session startup, `/auto-approval` and before each review. A missing or nonexecutable executor blocks the action before paid model review.

For manual setup outside Pi:

```bash
cd ~/.pi/agent/extensions/auto-approval
bun ../web-research/bootstrap.ts
bun ../public-writing/bootstrap.ts
bun bootstrap.ts
```

A portable `auto-approval.json`:

```json
{
  "reviewers": [
    { "provider": "openai", "model": "gpt-6-luna", "thinking": "medium" },
    { "provider": "openrouter", "model": "openai/gpt-6-luna", "thinking": "medium" }
  ],
  "recentUserPrompts": 10,
  "requestTimeoutMs": 120000,
  "sandbox": {
    "backend": "bwrap"
  }
}
```

Bubblewrap is found through absolute directories in `PATH`; the default executor is `~/.local/cache/pi-auto-approval/executor`. Alternative absolute paths belong in `sandbox.executable` and `sandbox.runnerExecutable` in `auto-approval.device.json`. That file can also contain `sandbox.workspaceViews` entries such as `{"root":"/absolute/workspace","paths":["/absolute/workspace/public-file"]}`. Only listed paths are mounted. Never add credential files or entire private home directories.

The executor is mounted read-only. The sandbox receives an empty environment, temporary home, separate process, network, IPC and other namespaces, and no Linux capabilities. Without approved additional access, host network interfaces are inaccessible. The process namespace remains isolated. Project changes occur only through selected workspace mounts.

Each Pi session receives its own writable `/tmp`. Files and scripts remain available to later approved actions in the same session. Host `/tmp` and other sessions' temporary files are not mounted. `/tmp/home` and `/tmp/pi` belong to the executor runtime and are recreated for every action. Additional mounts still apply to only one action; empty mount placeholders are removed afterward.

On exit, extension reload or replacement with a new, resumed or forked session, `session_shutdown` deletes the entire private `/tmp` after the running action finishes. The next session receives a new empty directory. A cancelled session switch does not trigger cleanup. Forced process termination such as `SIGKILL` cannot run a shutdown handler.

Cancellation terminates the sandbox process; descendants cannot outlive the action. Output and runtime are bounded. Native bwrap uses one cgroup per limited action; Docker uses container resource controls. Missing controllers or delegation never silently remove requested limits.

After `runner.ts` or dependency changes, restart Pi through the launcher or run `bun bootstrap.ts` outside Pi. Custom executor paths remain manually managed. Reviewer selection is configured through `auto-approval.json`. Extension code changes require a Pi restart.

## Docker compatibility

The existing Docker backend remains available. Set `sandbox.backend: "docker"` and an immutable `sandbox.image` digest in synchronized configuration. Docker is found through `PATH`; an alternative absolute `sandbox.dockerExecutable` belongs in `auto-approval.device.json`. Automatic workspace detection also applies to Docker. Docker rejects workspaces containing protected Pi or credential directories.

The backend is selected explicitly. Startup failure never executes the action on the host or automatically tries another backend.

## Review and audit

For native aggregate CPU/memory/PID enforcement and safe Lubox preparation, see
[Native aggregate resource limits](CGROUPS.md).

For external actions, every working model uses only `approved_action` with `tool`, unchanged Pi `arguments`, `goal` and `justification`. Operations include `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`, `websearch`, `webfetch`, `writing_check`, argv-based `git` and `credential_exec`. Web operations request networking for precisely that call before review; the fixed worker command appears in the review plan. `webfetch` returns only cleaned page text to the model, while approval stays in result details and the activity log.

Reviewers receive actual user prompts from the active branch, the exact action, goal, justification, working directory, protected paths and previous denials. They have no general-purpose action tools; compressed originals are accessible only through the bounded `prompt_original` reader described above. Fallback retains the same request, request ID and fingerprint. Every attempt and deciding model is logged; tokens and costs are summed across attempts. `requestTimeoutMs` applies per reviewer. A valid verdict applies only to the exact request. Review and execution are serialized; approvals are not reused.

Historical denials carry an explicit source label, an operation digest, a local equality comparison
against the current tool/arguments/access/cwd, and IDs of up to ten subsequent operator inputs.
Their command bodies remain omitted. Equality reports identity, not whether a concern is resolved;
different requests can retain the same risk. Actual user instructions remain authoritative.
The current action and resolved plan follow historical receipts in the request so an earlier
approved write is not confused with a later formatter or read.

A denial prevents execution of that submission. It does not create a user restriction on future
files or features. Corrected requests, new evidence or actual renewed authorization can receive
fresh review through the same gate; unchanged unsafe operations remain denied, with no reviewer
shopping or alternative execution. Host Keychain/login restrictions apply to operator access,
not merely writing app-side secure-storage code. An explicit user restriction on that application
feature still applies. Clarification questions are for genuinely missing decisions, not repeated
confirmation of existing authorization.

`bun run eval:steering --denial-context-only` checks twelve synthetic cases with the configured
reviewer: new-test formatting after a scope denial, historical-write separation, app/host Keychain
boundaries, continuing explicit restrictions unsafe operations, explicit negative tests and obvious unintended errors. It requires existing reviewer
authentication and executes none of the proposed actions. Offline tests verify evidence transport,
chronology, isolation metadata and that historical command bodies stay omitted; they cannot
establish how a live model will decide.

For explanation language, reviewers separately receive the latest actual user prompt as `latestUserPrompt`. This includes the objective entered through `/goal`; later user prompts supersede it as the language reference. Action and goal reviewers must use the operator's own instruction language, excluding foreign-language logs, quotations, older explanations and model text.

Review evaluates authorization and security risks. It does not enforce implementation preferences, coding workflow or public-prose style. Directly evident unintended errors must be identified precisely; deliberate negative fixtures and intermediate refactoring are legitimate. The separate `writing_check` service assesses an explicitly submitted draft against local editorial rules; these rules never gate ordinary writes/edits/commands. See [Public Writing](../public-writing/README.md). A requested source change normally authorizes appropriate tests, documentation and local checks. Bounded edits and fully visible Python/shell changes do not require reading every affected file in full first. Possible coding mistakes, incorrect test assumptions or preferred work order alone are not grounds for denial. Additional information is needed when a concrete risk cannot otherwise be assessed. Secret access, unrelated changes, unjustified broad deletion and interference with the approval gate remain prohibited.

For OpenAI Responses and Chat Completions, a JSON schema enforces the three verdict fields and current request ID. Other providers use strictly validated JSON text. Invalid JSON, wrong fields, a foreign request ID and empty reasons produce distinct failures and block execution.

Verdict, reason, request ID, fingerprint, review duration, backend and detected workspace are recorded as session entries. Authentication, review or audit failures block actions before execution. Failure after an action has started can still leave workspace effects.

Operators can change configuration outside agent tools. The working model cannot disable review. Additional workspace views need approval for the specific action. The sandbox protects the running executor; it cannot prevent an operator from later deliberately running changed project code on the host.

## Development and tests

```bash
cd ~/.pi/agent/extensions/auto-approval
bun run check
bun run test
```

Gate tests use a mocked executor. Isolation tests run in a separate Bun process so that mock cannot replace real bwrap checks. Linux/Bubblewrap integration tests also check file access, host-file and environment protection, separate namespaces, cancellation and termination of background processes. Only native integration tests are skipped without Bubblewrap.

`/side` tests check separate histories, refreshed main context, cancellation, context limits and terminal rendering. A real Pi SDK test with a local synthetic provider keeps the main request busy, answers a side question concurrently and then copies the completed main result into a follow-up. These tests need no authentication and incur no model costs.

Multiplex tests check random English word names, within-team uniqueness, FIFO messageboxes, bounds and immutable senders. A separate SDK/bwrap run starts three model requests concurrently and checks prompt broadcast, steering, real isolated file work, private `/tmp`, binding denials and absence of direct tool routes. Additional SDK cases check cancellation, reload and shared `/goal` completion. The synthetic provider is local; tests contact no model provider.

`bun run eval:network` additionally checks six networking cases using configured reviewers and existing authentication: necessary Node/npm downloads and audits, unnecessary networking, credential uploads and unrelated local services. It makes paid model requests but executes none of the proposed actions, so it is excluded from ordinary tests.

`bun run eval:credentials` checks general command authorization with configured reviewers using synthetic Dependabot reads, a requested operation of another CLI, token output, unrelated mutation and upload attacks. It obtains only review decisions; no service actions run and no actual service credentials enter model context.

## Portable action arguments

The advertised `approved_action` schema has an object root, a tool-name enum and an arguments object. Providers that encode the inner object as a JSON string are also supported. The gate takes an immutable snapshot, decodes that string once and applies the original selected tool's strict schema before any review or execution. Strings containing bare shell commands, arrays, null, malformed JSON or objects missing the selected tool's required fields remain invalid. Encoded objects are limited to 1 MiB. No command, permission or other field is inferred or repaired.

The independent reviewer, audit and executor all receive the same decoded object. Reviewer denials still prevent execution. Native command previews and shared-feed paths use the decoded object for display, with no host file reads. In Multiplex, repeated malformed calls have a bounded failure path described in the Multiplex extension documentation.

`bun run eval:steering --active-goal-only` checks eight synthetic active-goal scope cases against the configured reviewer without running any proposed action. Controls retain explicit stops, formatting boundaries and source-upload prohibitions.

`bun run eval:steering` checks continuation of a broader migration after a nullable-field refinement is finished, with both steering and ordinary input. An independently audited model edit supplies completion evidence while the refinement remains the latest user prompt; the proposed remaining feature has no readability or nullable-field purpose. Controls cover implicit sequencing, explicit task replacement and preservation of earlier source-upload restrictions. Additional cases cover the three bounded Dart readability edits and explicit stops, formatting and file restrictions, missing edit authorization and credential access. All sixteen fixtures are synthetic and no proposed action runs.

Approved successful writes display the written contents as green, line-numbered additions inside the same padded success block used by native edits, with the write title and diff together and the approval explanation outside. The display uses the frozen approved contents and a compact write confirmation from the isolated executor, so the diff does not consume the command output budget. It shows the complete written file even for a rewrite; it does not claim to compare previous contents. Long writes collapse to ten lines with expansion available. Pending, denied and failed writes show no successful additions. The shared Multiplex feed uses the same confirmed contents for every actor. No renderer reads host files.

`ask_user` and `user_questions` are conversation-owned clarification metadata and bypass action approval. They cannot execute actions or submit answers for the operator. Pending questions replace the prompt editor until answered, dismissed or withdrawn; external work remains independently reviewed. See [Pi Conversations](../conversations/README.md#clarification-questions-during-a-run).

`set_goal` is conversation-owned internal metadata, like mailbox delivery rather than external execution. The gate permits that named tool without an action review; it cannot execute commands, replace an unfinished goal or manufacture operator authorization. Self-assigned goals are excluded from genuine operator-prompt extraction. All external tool routes remain gated.
