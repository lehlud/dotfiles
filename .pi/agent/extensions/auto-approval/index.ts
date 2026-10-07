import { mkdtemp, realpath } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createBashToolDefinition, createPowerShellToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, createEditToolDefinition, createGrepToolDefinition,
  createFindToolDefinition, createLsToolDefinition, getAgentDir,
  type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { detectWorkspace, executeIsolated, sandboxHostPath, validateWorkspace } from "./isolation.ts";
import { reviewSummary, startReviewDisplay } from "./display.ts";
import { createApprovalRenderers } from "./renderers.ts";
import { buildReview, normalizeNetworkFlag, sandboxRequestSchema, type Request } from "./policy.ts";
import { assertSandboxReady, loadConfig } from "./config.ts";
import { reviewWithFallback, reviewerLabel, ReviewChainError } from "./reviews.ts";
import { removeSessionTemporaryDirectory } from "./temporary-storage.ts";
import { registerGoals } from "./goals.ts";
import { registerSide } from "./side.ts";
import { registerSteering } from "./steering.ts";
import { isWebTool, webTools } from "../web-research/index.ts";
import { resolveWebRuntime, reviewedWebRequest } from "../web-research/runtime.ts";
import { webExecutionPlan } from "../web-research/execute.ts";
import { writingCheckTool } from "../public-writing/index.ts";
import { preparePromptContext } from "./prompt-compression.ts";
import { checkActionSize } from "./review-context.ts";
import { credentialCommandTool } from "./credential-command.ts";
import { credentialProtectedPaths, credentialReviewPlan, executeWithCredentials, resolveCredentialPlan } from "./credential-access.ts";
import { gitTool } from "./git-command.ts";
import { executeWithGitConfig, validateGitRequest } from "./git-config.ts";
import { registerProviderRecovery } from "./provider-stream.ts";

const TOOL_NAME = "approved_action";
const factories = {
  read: createReadToolDefinition, bash: createBashToolDefinition,
  powershell: createPowerShellToolDefinition, edit: createEditToolDefinition,
  write: createWriteToolDefinition, grep: createGrepToolDefinition,
  find: createFindToolDefinition, ls: createLsToolDefinition,
  websearch: (_cwd: string) => webTools.websearch,
  webfetch: (_cwd: string) => webTools.webfetch,
  writing_check: (_cwd: string) => writingCheckTool,
  credential_exec: (_cwd: string) => credentialCommandTool,
  git: (_cwd: string) => gitTool,
};
type ToolName = keyof typeof factories;
const toolNames = Object.keys(factories) as ToolName[];
const configPath = join(getAgentDir(), "auto-approval.json");
const localConfigPath = join(getAgentDir(), "auto-approval.device.json");
const sourceDir = dirname(fileURLToPath(import.meta.url));
const definitions = Object.fromEntries(toolNames.map((name) => [name, factories[name](process.cwd())])) as Record<ToolName, ToolDefinition<any, any>>;
const parameters = Type.Union(toolNames.map((name) => Type.Object({
  tool: Type.Literal(name),
  arguments: definitions[name].parameters,
  goal: Type.String({ minLength: 1, maxLength: 4000, description: "Current concrete goal, tied to the real user's request." }),
  justification: Type.String({ minLength: 1, maxLength: 4000, description: "Why this exact action is needed now; explain side effects and scope." }),
  sandbox: Type.Optional(sandboxRequestSchema),
  ...(["bash", "powershell", "credential_exec"].includes(name) ? { network: Type.Optional(Type.Boolean({ description: "Request one-command network access (true) or explicitly stay offline (false). Independent approval is required before execution; expires when this action ends." })) } : {}),
}, { additionalProperties: false })));

// Resolve symlinks even for not-yet-created paths. Unexpected filesystem errors
// fail closed rather than letting a textual path check authorize an alias.
async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

const LOCK_MESSAGE = "Auto-Approval: direct and alternative tools are blocked. Use approved_action with the exact action, goal, and justification. A denied action must not be bypassed.";

export default function autoApproval(pi: ExtensionAPI) {
  registerProviderRecovery(pi);
  const operatorGoal = registerGoals(pi);
  registerSteering(pi, operatorGoal);
  registerSide(pi);
  // Serialize review AND execution, not just the model requests. No shared approval
  // flag, reusable token, bypass environment variable, or agent-callable off switch.
  let queue: Promise<unknown> = Promise.resolve();
  let temporaryDirectory: Promise<string> | undefined;
  const sessionTemporaryDirectory = () => temporaryDirectory ??= mkdtemp(join(tmpdir(), "pi-auto-approval-tmp-"));
  const activeDisplays = new Set<() => number>();
  pi.on("session_shutdown", async () => {
    for (const stop of activeDisplays) stop();
    activeDisplays.clear();
    await queue;
    const previousTemporaryDirectory = temporaryDirectory;
    temporaryDirectory = undefined;
    if (previousTemporaryDirectory) await removeSessionTemporaryDirectory(await previousTemporaryDirectory);
  });
  const protectedPaths = [
    sourceDir, getAgentDir(), join(homedir(), ".docker"), join(homedir(), ".ssh"), join(homedir(), ".aws"),
    join(homedir(), ".gnupg"), join(homedir(), ".codex"), join(homedir(), ".claude"), join(homedir(), ".config", "gh"),
    join(homedir(), ".local", "cache", "pi"),
    join(homedir(), ".local", "cache", "pi-web-research"),
    join(homedir(), ".local", "bin", "pi"),
    join(homedir(), ".local", "bin", "auto-update-app.bash"),
    process.execPath,
  ];
  const protectedRoots = Promise.all(protectedPaths.map(canonicalPath));
  // Catch now to avoid an unhandled rejection; awaiting below still fails closed.
  void protectedRoots.catch(() => {});

  function lock(ctx: ExtensionContext) {
    pi.setActiveTools([TOOL_NAME]);
    // Clear a widget left by an older version after /reload.
    ctx.ui.setWidget("auto-approval", undefined);
    ctx.ui.setStatus("auto-approval", "approval: on");
  }
  pi.on("session_start", async (_event, ctx) => {
    lock(ctx);
    try {
      const config = await loadConfig(getAgentDir());
      await assertSandboxReady(config);
      ctx.ui.setStatus("auto-approval", `approval: ${config.reviewers.map(reviewerLabel).join(" → ")}`);
    } catch (error) {
      ctx.ui.setStatus("auto-approval", "approval: LOCKED (configuration/runtime unavailable)");
      ctx.ui.notify(`Auto-Approval LOCKED: ${String(error)}`, "error");
    }
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    lock(ctx);
    return { message: {
      customType: "auto-approval-policy", display: false,
      content: `Auto-Approval and its isolated executor are mandatory. No host operations are permitted. Actions run in an ephemeral sandbox, offline by default, with only authorized mounts writable. When the real user task requires access beyond the defaults, request it in approved_action.sandbox: paths with read/write access, network host, literal environment, executableSearchPaths or limits. Explain necessity; the reviewer evaluates the complete action and expansion together. Permissions expire at the end of that action. /tmp is writable and private to the current Pi session. Files there persist across approved actions and are deleted on quit, reload, or session replacement. /tmp/home and /tmp/pi are per-action runtime directories. Persistent /tmp does not support tmpBytes limits. Never change the operator configuration or bypass isolation. Pi code, credentials, container sockets, and host process namespace are protected. For local Git commands, use tool git with arguments {argv} and sandbox.gitConfig: true when the task needs the existing author identity or public global Git settings. This argv-only offline route shares those settings read-only for one approved command; never invent identity or modify repository config just because ordinary bash has no identity. Helpers, auth headers, aliases, hooks and private keys are excluded. Explicit user-requested configuration edits can still use normal read/write path grants. For necessary authenticated service operations, use tool credential_exec with arguments {profile, argv}; request network: true when connectivity is necessary. This separate argv-only route delegates an operator-owned login to one pinned CLI after approval; never read/mount login files or pass secrets through bash. The built-in github profile binds trusted native gh to its existing login. It has no fixed subcommand list: request any task-required gh operation with its exact complete argv (including API methods, destinations and payload). The independent reviewer decides each command; profile selection alone authorizes nothing. Prefer explicit repository targets. For current-project access request sandbox.projectFiles: read/write, or selected sandbox.paths; without them no project files are exposed. Network access is a separate per-action request. Other profiles require operator configuration in auto-approval.device.json outside Pi. Credential actions always get fresh temporary storage; project/file accesses require explicit reviewed scope. An unavailable native Linux login must be repaired outside Pi; no macOS Keychain or host execution fallback. If isolation or workspace authorization fails, tell the user the exact config path and required operator change; NEVER use a local fallback. The workspace is detected automatically from the current directory or project Git root; a Git root at or above the home directory is ignored. The shared config is ~/.pi/agent/auto-approval.json; optional device paths and restricted home workspaceViews belong in ~/.pi/agent/auto-approval.device.json. /auto-approval shows both paths and the detected workspace. Use ONLY approved_action for every operation, including reads and file mutations. Supply the exact tool arguments, your current goal, and why the action is necessary now. An independent reviewer checks actual recent user prompts against the action. Rejections return their reason. Resolve the concern or ask the user; never retry through another tool, nested agent, shell escape, modified gate, or background process. There is no agent-accessible disable or manual bypass.`,
    } };
  });
  pi.on("tool_call", async (event) => {
    if (event.toolName !== TOOL_NAME || event.parentToolCallId) return { block: true, reason: LOCK_MESSAGE };
  });
  pi.on("user_bash", async () => ({ result: {
    output: "Auto-Approval: !/!! and direct user/RPC shell execution are blocked. Ask the agent to submit a justified approved_action instead.",
    exitCode: 1, cancelled: false, truncated: false,
  } }));
  pi.registerCommand("auto-approval", {
    description: "Show mandatory approval configuration (edit auto-approval.json to change the reviewer)",
    handler: async (_args, ctx) => {
      try {
        const config = await loadConfig(getAgentDir());
        await assertSandboxReady(config);
        ctx.ui.notify(`Auto-Approval ON\nReviewers (priority order):\n${config.reviewers.map((item, i) => `${i + 1}. ${reviewerLabel(item)}`).join("\n")}\nSandbox: ${config.sandbox.backend ?? "docker"}\nWorkspace: ${(await detectWorkspace(ctx.cwd)).path} (automatic; home-level Git roots ignored)\nCurrent directory: ${ctx.cwd}\nConfig: ${configPath}\nDevice paths/views/credential profiles (optional): ${localConfigPath}\nChanges take effect on the next action. No bypass/off command.`, "info");
      } catch (error) { ctx.ui.notify(`Auto-Approval LOCKED: ${String(error)}\nConfig: ${configPath}\nDevice paths/views/credential profiles (optional): ${localConfigPath}`, "error"); }
    },
  });
  pi.registerTool({
    name: TOOL_NAME, label: "Reviewed action", exposure: "model-only", executionMode: "sequential",
    description: "Submit one exact operation for independent approval and, only if approved, immediate execution. websearch uses DDGS (query, optional maxResults/region/timeLimit); webfetch reads one URL as clean plain text (url, optional maxChars/offset). Web operations request per-action network access before review. writing_check semantically reviews public prose in its original language (text, audience public/operator, optional format/context); it runs offline, and a denial reports editorial findings. Optional sandbox requests additional paths/read-write rights, network, literal environment variables, executable search paths, local tools or limits for this action only; explain necessity in justification. Use sandbox.tools: [node] for nvm/node/npm/npx or [sqlmap] for the local sqlmap launcher. Installed code stays read-only; version choices, caches and auto-updates persist only in session-private /tmp. Include tools on each action that needs them. npm install or tool downloads require the shell flag network: true (or sandbox.network: host), independently reviewed before execution. Network permission applies only to this new process and its descendants; existing processes stay isolated. The reviewer checks every expansion against the real user request. No blanket approvals. credential_exec delegates an operator-owned program/login binding to one pinned native CLI: arguments {profile, argv}. Request network: true for needed connectivity. The built-in github profile supplies native gh and its existing login for independently reviewed complete argv, including gh api. No fixed subcommand list substitutes for review. API destinations, methods, payloads and service effects must match the real user task. Credentials are resolved only after approval, never shown to the agent, and only this isolated argv-only command receives them. It has no shared /tmp; request sandbox.projectFiles: read/write or selected sandbox.paths when the command needs files. Other profiles must be configured outside Pi in auto-approval.device.json. For local Git commits with the operator identity, use tool git, arguments {argv: [commit, ...]}, sandbox.gitConfig: true. This separately reviewed offline route shares supported public global settings read-only for one command, excluding credentials, helpers, aliases and external executable settings. Every operation needs goal and justification. arguments follows the selected tool's schema.",
    promptSnippet: "Request independent approval and execution of one operation",
    parameters,
    ...createApprovalRenderers(definitions),
    async execute(id, raw, signal, onUpdate, ctx) {
      const run = async () => {
        let usage;
        let executionStarted = false;
        let phase = "request validation";
        let stopDisplay: (() => number) | undefined;
        let reviewDurationMs = 0;
        let reviewer = "—";
        let decisionSummary = "";
        const finishDisplay = () => {
          if (stopDisplay) {
            reviewDurationMs += stopDisplay();
            activeDisplays.delete(stopDisplay);
            stopDisplay = undefined;
          }
        };
        let audit: Record<string, unknown> = { toolCallId: id, decision: "deny" };
        try {
          signal?.throwIfAborted();
          // Snapshot and validate inside execute as well as at Pi's tool boundary.
          // Other event handlers cannot mutate arguments after they were reviewed.
          const snapshot = structuredClone(raw) as Request;
          const validRequest: boolean = Check(parameters, snapshot);
          if (!validRequest || !snapshot.goal.trim() || !snapshot.justification.trim()) throw new Error("Invalid action, goal, or justification");
          const request = reviewedWebRequest(normalizeNetworkFlag(snapshot));
          checkActionSize(request);
          phase = "sandbox configuration";
          const config = await loadConfig(getAgentDir());
          await assertSandboxReady(config);
          const name = request.tool as ToolName;
          // Private built-in definitions: never resolve a same-name extension/MCP
          // override, never expose ctx.executeTool(), and never use commandPrefix.
          const tool = factories[name](ctx.cwd) as ToolDefinition<any, any>;
          if (!Check(tool.parameters, request.arguments)) throw new Error("Invalid underlying tool arguments");
          validateGitRequest(request, config);
          const credential = name === "credential_exec";
          if (!credential && request.sandbox?.projectFiles !== undefined) throw new Error("projectFiles is available only to credential_exec");
          phase = "credential profile validation";
          const credentialPlan = credential ? await resolveCredentialPlan(request, config) : undefined;
          const activeProtectedPaths = [...protectedPaths, ...credentialProtectedPaths(config)];
          const privateTmp = credential || name === "git" ? undefined : await sessionTemporaryDirectory();
          phase = "workspace validation";
          const mode = isWebTool(name) ? "web" : credential && !request.sandbox?.projectFiles ? "credential" : "project";
          const workspace = await validateWorkspace(ctx.cwd, config.sandbox, activeProtectedPaths, request.sandbox, privateTmp, mode);
          if (isWebTool(name) && config.sandbox.backend === "bwrap") {
            phase = "web runtime preparation";
            workspace.webRuntime = await resolveWebRuntime();
          }
          if (name === "write" || name === "edit") {
            phase = "protected path validation";
            const path = await canonicalPath(sandboxHostPath(workspace, String(request.arguments.path)));
            const roots = [...await protectedRoots, ...await Promise.all(credentialProtectedPaths(config).map(canonicalPath))];
            if (roots.some((p) => path === p || path.startsWith(`${p}/`))) throw new Error("The agent cannot modify Pi installation, approval code, configuration, or credentials");
          }
          const sandboxPlan = { workspace: workspace.path, bindings: workspace.bindings, readOnlyBindings: workspace.readOnlyBindings ?? [], executableSearchPaths: workspace.searchPaths ?? [], localTools: workspace.localTools ?? [], gitConfiguration: request.sandbox?.gitConfig === true ? { scope: "supported public global Git settings and author identity", readOnly: true, lifetime: "one Git command", originalsMounted: false, credentials: false } : undefined, credentials: credentialPlan ? credentialReviewPlan(credentialPlan, workspace.bindings.length > 0) : undefined, webRuntime: isWebTool(name) ? { ...(workspace.webRuntime ?? { imageBundled: true }), readOnly: true, execution: webExecutionPlan(request) } : undefined, localToolStorage: workspace.localTools?.length ? { path: "/tmp/pi-tools", lifetime: "Pi session", updates: "private copies only" } : undefined, temporaryStorage: { path: "/tmp", lifetime: credential || name === "git" ? "one action" : "Pi session", private: true }, requested: request.sandbox ?? {}, backend: config.sandbox.backend ?? "docker" };
          phase = "prompt compression";
          const branch = ctx.sessionManager.getBranch();
          const prepared = await preparePromptContext(branch, config, ctx.modelRegistry, getAgentDir(), {
            start(label) { onUpdate?.({ content: [{ type: "text", text: `Prompt compression · ${label}` }], details: { phase: "compressing" } }); },
            saved(record) {
              if (!branch.some((entry) => entry.type === "custom" && entry.customType === "auto-approval-prompt-compression" && (entry.data as any)?.promptId === record.promptId && (entry.data as any)?.text === record.text)) pi.appendEntry("auto-approval-prompt-compression", record);
            },
            failed(attempt) { pi.appendEntry("auto-approval-compressor-failure", { toolCallId: id, attempt }); },
          }, signal, operatorGoal());
          phase = "review context preparation";
          const review = buildReview(request, branch, config, ctx.cwd, [...protectedPaths, "[Additional operator-owned credential sources and executables: privately protected]"], sandboxPlan, operatorGoal(), prepared);
          audit = { ...audit, action: request, reviewer: config, promptContext: prepared.records.map(({ original: _original, ...record }) => record), workspace: workspace.path, cwd: isWebTool(name) || credential ? ctx.cwd : workspace.cwd, executionCwd: workspace.cwd, backend: config.sandbox.backend ?? "docker", sandboxPlan, requestId: review.requestId, fingerprint: review.fingerprint };
          phase = "independent review";
          reviewer = config.reviewers.map(reviewerLabel).join(" → ");
          const checked = await reviewWithFallback(config, ctx.modelRegistry, review, {
            retry(event) {
              pi.appendEntry("auto-approval-provider-retry", { toolCallId: id, requestId: review.requestId, ...event });
              onUpdate?.({ content: [{ type: "text", text: `Provider recovery · ${event.provider}/${event.model} · ${event.retry}/${event.maxRetries} · ${event.delayMs / 1000}s` }], details: { phase: "reviewing", retry: event } });
            },
            start(candidate) {
              reviewer = reviewerLabel(candidate);
              stopDisplay = startReviewDisplay(ctx, reviewer, name).stop;
              activeDisplays.add(stopDisplay);
              onUpdate?.({ content: [{ type: "text", text: `⠋ Auto-Approval · ${reviewer} · ${name}` }], details: { phase: "reviewing", reviewer } });
            },
            finish: finishDisplay,
            failed(attempt) {
              pi.appendEntry("auto-approval-reviewer-failure", { toolCallId: id, requestId: review.requestId, fingerprint: review.fingerprint, attempt });
              const text = `Reviewer unavailable · ${reviewerLabel(attempt)}\n${attempt.reason}`;
              onUpdate?.({ content: [{ type: "text", text }], details: { phase: "reviewing", reviewer, attempt } });
            },
            lookup(request) {
              pi.appendEntry("auto-approval-prompt-lookup", { requestId: review.requestId, fingerprint: review.fingerprint, request });
              onUpdate?.({ content: [{ type: "text", text: `Reviewer original prompt · ${request.operation} · ${request.promptId.slice(0, 12)}` }], details: { phase: "reviewing", reviewer, promptLookup: request } });
            },
          }, signal);
          usage = checked.usage;
          const verdict = checked.verdict;
          signal?.throwIfAborted();
          audit = { ...audit, ...verdict, selectedReviewer: checked.selectedReviewer, reviewAttempts: checked.attempts, promptLookups: checked.promptLookups, reviewDurationMs };
          decisionSummary = reviewSummary(verdict.decision === "approve", verdict.reason, reviewDurationMs, reviewer);
          // Record the exact decision before execution; audit failure blocks execution.
          pi.appendEntry("auto-approval-review", audit);
          onUpdate?.({ content: [{ type: "text", text: decisionSummary }], details: audit });
          if (verdict.decision === "deny") return {
            content: [{ type: "text" as const, text: decisionSummary }],
            details: audit, usage, isError: true,
          };
          ctx.ui.setStatus("auto-approval", `approved: ${name}`);
          executionStarted = true;
          if (credentialPlan) {
            const result = await executeWithCredentials(request, credentialPlan, config, signal, workspace);
            return { ...result, content: [{ type: "text" as const, text: decisionSummary }, ...result.content], details: { approval: audit, result: result.details }, usage };
          }
          if (isWebTool(name)) {
            const result = await executeIsolated(request, workspace, config.sandbox, signal);
            return { ...result, details: { approval: audit, approvalSummary: decisionSummary, result: result.details }, usage };
          }
          const result = request.sandbox?.gitConfig === true ? await executeWithGitConfig(request, workspace, config, signal) : await executeIsolated(request, workspace, config.sandbox, signal);
          return { ...result, content: [{ type: "text" as const, text: decisionSummary }, ...result.content], details: { approval: audit, result: result.details }, usage };
        } catch (error) {
          finishDisplay();
          if (error instanceof ReviewChainError) {
            usage = error.usage;
            audit = { ...audit, reviewAttempts: error.attempts };
          }
          const reason = error instanceof Error ? error.message : String(error);
          if (executionStarted) {
            const failure = { approval: audit, executionError: reason };
            try { pi.appendEntry("auto-approval-execution-error", failure); } catch { /* report the execution failure anyway */ }
            return { content: [{ type: "text" as const, text: `${decisionSummary}\nApproved action failed; it may have had side effects: ${reason}` }], details: failure, usage, isError: true };
          }
          audit = { ...audit, decision: "deny", reason, reviewDurationMs, technicalFailure: true, technicalStage: phase };
          decisionSummary = reviewSummary(false, `Blocked during ${phase}; nothing executed: ${reason}`, reviewDurationMs, reviewer);
          try { pi.appendEntry("auto-approval-review", audit); } catch { /* still fail closed */ }
          return { content: [{ type: "text" as const, text: decisionSummary }], details: audit, usage, isError: true };
        } finally {
          finishDisplay();
          ctx.ui.setStatus("auto-approval", "approval: on");
        }
      };
      const result = queue.then(run, run);
      queue = result.then(() => undefined, () => undefined);
      return await result;
    },
  });
}
