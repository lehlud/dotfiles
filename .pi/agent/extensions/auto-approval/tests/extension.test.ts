import { test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, mkdtemp, writeFile, readFile, rm, access, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(tmpdir(), "pi-approval-test-"));
const agentRoot = await mkdtemp(join(tmpdir(), "pi-approval-agent-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let validatedScopes: any[] = [];
let executedRequests: any[] = [];
let temporaryStores: string[] = [];
process.env.PI_CODING_AGENT_DIR = agentRoot;
// Test-only module mock. Production has one mandatory Docker executor and no
// injection flag or local execution backend. Unit tests exercise the gate.
mock.module("../isolation.ts", () => ({
  detectWorkspace: async (cwd: string) => ({ path: cwd, cwd }),
  sandboxHostPath: (workspace: { cwd: string }, path: string) => resolve(workspace.cwd, path),
  validateWorkspace: async (cwd: string, _config: unknown, _protected: unknown, scope: unknown, temporaryDirectory: string) => {
    validatedScopes.push(structuredClone(scope));
    temporaryStores.push(temporaryDirectory);
    return { path: cwd, cwd, bindings: [cwd], masked: [], temporaryDirectory };
  },
  executeIsolated: async (request: any, workspace: { path: string }, _config: unknown, signal?: AbortSignal) => {
    const cwd = workspace.path;
    executedRequests.push(structuredClone(request));
    const factories: any = { bash: createBashToolDefinition, read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition };
    return await factories[request.tool](cwd).execute("test-only", request.arguments, signal, undefined, ctx);
  },
}));
const { default: extension } = await import("../index.ts");
const configPath = join(agentRoot, "auto-approval.json");
const localConfigPath = join(agentRoot, "auto-approval.device.json");
const config = { reviewers: [{ provider: "openai", model: "gpt-6-luna", thinking: "medium" }], recentUserPrompts: 6, requestTimeoutMs: 120000, sandbox: { backend: "docker", image: `sha256:${"a".repeat(64)}` } };
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let mode: "approve" | "deny" | "invalid" | "error" | "mismatch" = "approve";
let requested: any[];
let hooks: Record<string, Function>;
let actions: Record<string, ToolDefinition<any, any>>;
let entries: any[];
let active: string[];
let auditFails: boolean;
let responseHook: (() => void) | undefined;
let widgets: string[][];
let statuses: string[];
let ctx: ExtensionToolContext;

beforeEach(async () => {
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(localConfigPath, JSON.stringify({ sandbox: { dockerExecutable: "/usr/bin/docker" } }));
  mode = "approve"; requested = []; hooks = {}; actions = {}; active = []; auditFails = false; responseHook = undefined; widgets = []; statuses = [];
  validatedScopes = []; executedRequests = []; temporaryStores = [];
  entries = [{ type: "message", message: { role: "user", content: "Run a harmless smoke test in the temporary working directory. Do not change any approval settings." } }];
  const pi = {
    on: (name: string, callback: Function) => { hooks[name] = callback; },
    registerTool: (tool: ToolDefinition<any, any>) => { actions[tool.name] = tool; },
    registerCommand: () => {},
    setActiveTools: (names: string[]) => { active = names; },
    appendEntry: (customType: string, data: unknown) => {
      if (auditFails) throw new Error("Audit unavailable");
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;
  ctx = {
    cwd: root,
    ui: { setStatus: (_key: string, text: string) => statuses.push(text), setWidget: (_key: string, lines: string[]) => widgets.push(lines), notify: () => {} },
    sessionManager: { getBranch: () => entries, getSessionId: () => "test-session", getSessionFile: () => undefined },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id, api: "openai-responses", reasoning: true, thinkingLevelMap: { medium: "medium", low: "low" } }),
      hasConfiguredAuth: () => true,
      streamSimple: (model: any, context: any, options: any) => {
        const data = JSON.parse(context.messages[0].content);
        requested.push({ model, context, options, data });
        return { result: async () => {
          responseHook?.();
          return {
            stopReason: mode === "error" ? "error" : "stop", usage,
            content: [{ type: "text", text: mode === "invalid" ? "not JSON" : JSON.stringify({
              requestId: mode === "mismatch" ? "another-action" : data.requestId,
              decision: mode === "deny" ? "deny" : "approve", reason: mode === "deny" ? "Nicht vom Nutzer gewollt" : "Passt zur Aufgabe",
            }) }],
          };
        } };
      },
    },
  } as unknown as ExtensionToolContext;
  extension(pi);
});
afterEach(async () => { await hooks.session_shutdown?.(); });
afterAll(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
  await rm(agentRoot, { recursive: true, force: true });
});
const call = (args: any, signal?: AbortSignal) => actions.approved_action.execute("call", args, signal, undefined, ctx);
const bash = (command: string) => ({ tool: "bash", arguments: { command }, goal: "Smoke test", justification: "Harmless isolated test" });
const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };

test("only approved_action is active on session start and before each run", async () => {
  await hooks.session_start({}, ctx); expect(active).toEqual(["approved_action"]);
  await hooks.before_agent_start({}, ctx); expect(active).toEqual(["approved_action"]);
  expect(actions.approved_action.exposure).toBe("model-only");
});

test("a missing native executor locks startup and blocks before any paid review", async () => {
  await writeFile(configPath, JSON.stringify({ ...config, sandbox: { backend: "bwrap" } }));
  const missing = join(agentRoot, "missing-executor");
  await writeFile(localConfigPath, JSON.stringify({ sandbox: { executable: process.execPath, runnerExecutable: missing } }));
  await hooks.session_start({}, ctx);
  expect(statuses.some((status) => status.includes("LOCKED"))).toBe(true);
  const result = await call(bash("touch must-not-run"));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain(`Sandbox executable unavailable: ${missing}`);
  expect(requested).toHaveLength(0);
  expect(executedRequests).toHaveLength(0);
  expect(await exists(join(root, "must-not-run"))).toBe(false);
});

test("private temporary storage is reused and removed on quit, reload and session replacement", async () => {
  let previous: string | undefined;
  for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
    expect((await call(bash("printf first"))).isError).not.toBe(true);
    expect((await call(bash("printf second"))).isError).not.toBe(true);
    const current = temporaryStores.at(-1)!;
    expect(current === temporaryStores.at(-2)).toBe(true);
    expect(current === previous).toBe(false);
    expect(await exists(current)).toBe(true);
    expect(requested.at(-1).data.sandboxPlan.temporaryStorage).toEqual({ path: "/tmp", lifetime: "Pi session", private: true });
    await writeFile(join(current, "cleanup-fixture"), "temporary");
    const blocked = join(current, "inaccessible-directory");
    await mkdir(blocked); await writeFile(join(blocked, "fixture"), "temporary");
    await chmod(blocked, 0o000);
    const externalMode = (await stat(root)).mode;
    await symlink(root, join(current, "external-link"));
    await hooks.session_shutdown({ reason });
    expect(await exists(current)).toBe(false);
    expect(await exists(root)).toBe(true);
    expect((await stat(root)).mode).toBe(externalMode);
    previous = current;
  }
});
test("every direct, unknown, nested, MCP, and codemode route is blocked", async () => {
  for (const toolName of ["bash", "powershell", "read", "edit", "write", "codemode", "tool_search", "mcp_exec", "subagent", "arbitrary"]) {
    expect((await hooks.tool_call({ toolName }, ctx)).block).toBe(true);
  }
  expect((await hooks.tool_call({ toolName: "approved_action", parentToolCallId: "parent" }, ctx)).block).toBe(true);
  expect(await hooks.tool_call({ toolName: "approved_action" }, ctx)).toBeUndefined();
});
test("user !/!! and RPC shell interception never executes", async () => {
  const result = await hooks.user_bash({ command: "touch bypass" }, ctx);
  expect(result.result.exitCode).toBe(1);
  expect(await exists(join(root, "bypass"))).toBe(false);
});
test("approved action executes exactly its reviewed command and reports reviewer usage", async () => {
  const result = await call(bash("printf approval-ok"));
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(JSON.stringify(result.content)).toContain("approval-ok");
  expect(requested[0].data.action.arguments.command).toBe("printf approval-ok");
  expect(requested[0].model.id).toBe("gpt-6-luna");
  expect(requested[0].options.reasoning).toBe("medium");
  expect(requested[0].context.tools).toBeUndefined();
  const payload = requested[0].options.onPayload({ input: "review-context" }, requested[0].model);
  expect(payload.text.format.schema.properties.requestId.enum).toEqual([requested[0].data.requestId]);
  expect(result.usage).toEqual(usage);
  expect(entries.at(-1).data.decision).toBe("approve");
});
test("denial returns reason without executing", async () => {
  mode = "deny";
  const result = await call(bash("touch denied-sentinel"));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("Nicht vom Nutzer gewollt");
  expect(await exists(join(root, "denied-sentinel"))).toBe(false);
});
test("sandbox expansion is reviewed with the action, executed exactly, and never retained", async () => {
  const sandbox = { paths: [{ path: "/tmp/shared-source", access: "read" }], network: "host", environment: { BUILD_MODE: "test" }, limits: { executionTimeoutMs: 900000 } };
  const args = { ...bash("printf scoped"), sandbox };
  responseHook = () => { args.sandbox.paths[0].path = "/tmp/changed-after-review"; };
  const result = await call(args);
  expect(result.isError).not.toBe(true);
  expect(requested[0].data.action.sandbox.paths[0].path).toBe("/tmp/shared-source");
  expect(validatedScopes[0].paths[0].path).toBe("/tmp/shared-source");
  expect(executedRequests[0].sandbox.paths[0].path).toBe("/tmp/shared-source");
  expect(result.details.approval.sandboxPlan.requested.network).toBe("host");
  responseHook = undefined;
  await call(bash("printf default"));
  expect(validatedScopes[1]).toBeUndefined(); expect(executedRequests[1].sandbox).toBeUndefined();
});
test("denied sandbox requests and forged disable switches never execute", async () => {
  mode = "deny";
  expect((await call({ ...bash("printf denied"), sandbox: { network: "host" } })).isError).toBe(true);
  expect(executedRequests).toHaveLength(0);
  mode = "approve";
  const reviewed = requested.length;
  expect((await call({ ...bash("printf bypass"), sandbox: { isolation: false } })).isError).toBe(true);
  expect(requested).toHaveLength(reviewed); expect(executedRequests).toHaveLength(0);
});
test("invalid, errored, or mismatched verdicts fail closed", async () => {
  for (const variant of ["invalid", "error", "mismatch"] as const) {
    mode = variant;
    const result = await call(bash(`touch ${variant}-sentinel`));
    expect(result.isError).toBe(true);
    expect(await exists(join(root, `${variant}-sentinel`))).toBe(false);
  }
});
test("missing and invalid config fail closed without reviewer or execution", async () => {
  await rm(configPath);
  expect((await call(bash("touch missing-config"))).isError).toBe(true);
  await writeFile(configPath, '{"enabled":false}');
  expect((await call(bash("touch invalid-config"))).isError).toBe(true);
  expect(requested).toHaveLength(0);
  expect(await exists(join(root, "missing-config"))).toBe(false);
  expect(await exists(join(root, "invalid-config"))).toBe(false);
});
test("config is hot-read; reviewer is replaceable without a restart", async () => {
  await writeFile(configPath, JSON.stringify({ ...config, reviewers: [{ provider: "replacement-provider", model: "replacement-model", thinking: "low" }] }));
  expect((await call(bash("printf switched"))).isError).not.toBe(true);
  expect(requested[0].model.id).toBe("replacement-model");
  expect(requested[0].model.provider).toBe("replacement-provider");
  expect(requested[0].options.reasoning).toBe("low");
});
test("unknown tools and blank goals cannot enter execution", async () => {
  for (const invalid of [{ ...bash("true"), tool: "subagent" }, { ...bash("true"), goal: " " }, { ...bash("true"), justification: "" }, { ...bash("true"), arguments: {} }]) {
    expect((await call(invalid)).isError).toBe(true);
  }
  expect(requested).toHaveLength(0);
});
test("file mutations are reviewed too", async () => {
  mode = "deny";
  const result = await call({ tool: "write", arguments: { path: "denied.txt", content: "bad" }, goal: "Test", justification: "Test" });
  expect(result.isError).toBe(true);
  expect(await exists(join(root, "denied.txt"))).toBe(false);
  expect(requested).toHaveLength(1);
  expect(requested[0].data.action.tool).toBe("write");
});
test("direct attempts to modify approval configuration cannot even ask for approval", async () => {
  for (const path of [configPath, localConfigPath]) {
    const original = await readFile(path, "utf8");
    expect((await call({ tool: "write", arguments: { path, content: "{}" }, goal: "Disable gate", justification: "Bypass" })).isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe(original);
  }
  expect(requested).toHaveLength(0);
});
test("invalid local restrictions block before review and execution", async () => {
  await writeFile(localConfigPath, '{"sandbox":{"workspaceViews":"invalid"}}');
  const result = await call(bash("touch invalid-local-config"));
  expect(result.isError).toBe(true);
  expect(requested).toHaveLength(0); expect(executedRequests).toHaveLength(0);
  expect(await exists(join(root, "invalid-local-config"))).toBe(false);
});
test("no cached approval; the same action is reviewed on every call", async () => {
  await call(bash("printf once")); mode = "deny";
  expect((await call(bash("printf once"))).isError).toBe(true);
  expect(requested).toHaveLength(2);
  expect(requested[0].data.requestId).not.toBe(requested[1].data.requestId);
});
test("cancellation after review still prevents execution", async () => {
  const controller = new AbortController();
  responseHook = () => controller.abort();
  expect((await call(bash("touch cancelled"), controller.signal)).isError).toBe(true);
  expect(await exists(join(root, "cancelled"))).toBe(false);
});
test("audit failure prevents even approved execution", async () => {
  auditFails = true;
  expect((await call(bash("touch unaudited"))).isError).toBe(true);
  expect(await exists(join(root, "unaudited"))).toBe(false);
});
test("missing reviewer and missing auth fail closed", async () => {
  ctx.modelRegistry.find = () => undefined;
  expect((await call(bash("touch missing-model"))).isError).toBe(true);
  ctx.modelRegistry.find = (() => ({ id: "test", reasoning: true })) as any;
  ctx.modelRegistry.hasConfiguredAuth = () => false;
  expect((await call(bash("touch missing-auth"))).isError).toBe(true);
  expect(requested).toHaveLength(0);
});
test("OpenRouter session cannot replace the configured direct OpenAI reviewer", async () => {
  ctx.model = { provider: "openrouter", id: "openai/gpt-6.1-sol" } as any;
  ctx.modelRegistry.hasConfiguredAuth = (model) => model.provider === "openrouter";
  const result = await call(bash("touch missing-direct-openai-auth"));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("openai/gpt-6-luna");
  expect(JSON.stringify(result.content)).toContain("/login and select openai");
  expect(requested).toHaveLength(0); expect(executedRequests).toHaveLength(0);
  ctx.modelRegistry.hasConfiguredAuth = (model) => model.provider === "openai";
  expect((await call(bash("printf direct-reviewer"))).isError).not.toBe(true);
  expect(requested[0].model.provider).toBe("openai");
  expect(requested[0].model.id).toBe("gpt-6-luna");
});
const fallback = { provider: "openrouter", model: "openai/gpt-6-luna", thinking: "medium" };
const chainConfig = { ...config, reviewers: [...config.reviewers, fallback] };
test("explicit authenticated fallback is executed once and audited with the original request", async () => {
  await writeFile(configPath, JSON.stringify(chainConfig));
  ctx.modelRegistry.hasConfiguredAuth = (model) => model.provider === "openrouter";
  const result = await call(bash("printf explicit-fallback"));
  expect(result.isError).not.toBe(true); expect(executedRequests).toHaveLength(1);
  const audit = result.details.approval;
  expect(audit.selectedReviewer).toEqual(fallback);
  expect(audit.reviewAttempts.map((attempt: any) => attempt.status)).toEqual(["failed", "approve"]);
  const failure = entries.find((entry) => entry.customType === "auto-approval-reviewer-failure");
  expect(failure.data.requestId).toBe(audit.requestId); expect(failure.data.fingerprint).toBe(audit.fingerprint);
  expect(requested[0].model.provider).toBe("openrouter"); expect(requested[0].model.id).toBe("openai/gpt-6-luna");
  ctx.modelRegistry.hasConfiguredAuth = () => true;
  await call(bash("printf back-to-priority-one"));
  expect(requested[1].model.provider).toBe("openai");
});
test("technical fallback keeps an immutable action and includes billed usage from both attempts", async () => {
  await writeFile(configPath, JSON.stringify(chainConfig));
  const args = bash("printf immutable-fallback-action");
  responseHook = () => {
    mode = requested.at(-1).model.provider === "openai" ? "error" : "approve";
    args.arguments.command = "touch mutated-fallback-action";
  };
  const result = await call(args);
  expect(result.isError).not.toBe(true); expect(executedRequests).toHaveLength(1);
  expect(requested.map((request) => request.data.action.arguments.command)).toEqual(["printf immutable-fallback-action", "printf immutable-fallback-action"]);
  expect(requested[0].data.requestId).toBe(requested[1].data.requestId);
  expect(result.usage?.totalTokens).toBe(40); expect(result.details.approval.selectedReviewer).toEqual(fallback);
  expect(await exists(join(root, "mutated-fallback-action"))).toBe(false);
});
test("valid primary and fallback denials are final and never execute", async () => {
  await writeFile(configPath, JSON.stringify(chainConfig)); mode = "deny";
  expect((await call(bash("touch denied-chain"))).isError).toBe(true);
  expect(requested).toHaveLength(1); expect(executedRequests).toHaveLength(0);
  responseHook = () => { mode = requested.at(-1).model.provider === "openai" ? "error" : "deny"; };
  const result = await call(bash("touch fallback-denied-chain"));
  expect(result.isError).toBe(true); expect(result.details.selectedReviewer).toEqual(fallback);
  expect(result.details.decision).toBe("deny"); expect(result.details.technicalFailure).toBeUndefined();
  expect(executedRequests).toHaveLength(0);
});
test("invalid verdicts and cancellation never use the configured fallback", async () => {
  await writeFile(configPath, JSON.stringify(chainConfig)); mode = "mismatch";
  const invalid = await call(bash("touch wrong-verdict-chain"));
  expect(invalid.isError).toBe(true); expect(requested).toHaveLength(1);
  expect(invalid.details.reviewAttempts[0].status).toBe("invalid");
  const controller = new AbortController(); responseHook = () => controller.abort();
  expect((await call(bash("touch cancelled-chain"), controller.signal)).isError).toBe(true);
  expect(requested).toHaveLength(2); expect(executedRequests).toHaveLength(0);
});
test("failure audit errors block the fallback and all exhausted reviewers block execution", async () => {
  await writeFile(configPath, JSON.stringify(chainConfig));
  ctx.modelRegistry.hasConfiguredAuth = () => false; auditFails = true;
  expect((await call(bash("touch failed-fallback-audit"))).isError).toBe(true);
  expect(requested).toHaveLength(0); expect(executedRequests).toHaveLength(0);
  auditFails = false;
  const result = await call(bash("touch exhausted-reviewers"));
  expect(result.isError).toBe(true); expect(result.details.reviewAttempts).toHaveLength(2);
  expect(result.details.technicalFailure).toBe(true); expect(executedRequests).toHaveLength(0);
});
test("review plus execution is serialized for concurrent calls", async () => {
  const results = await Promise.all([call(bash("printf first >> order.txt")), call(bash("printf second >> order.txt"))]);
  expect(results.every((r) => !r.isError), JSON.stringify(results)).toBe(true);
  expect(await readFile(join(root, "order.txt"), "utf8")).toBe("firstsecond");
  expect(requested).toHaveLength(2);
});

test("symlink aliases cannot write approval configuration", async () => {
  const alias = join(root, "config-alias.json");
  await symlink(configPath, alias);
  const result = await call({ tool: "write", arguments: { path: alias, content: "{}" }, goal: "Disable", justification: "Bypass via alias" });
  expect(result.isError).toBe(true);
  expect(requested).toHaveLength(0);
  expect(JSON.parse(await readFile(configPath, "utf8")).reviewers[0].model).toBe("gpt-6-luna");
});

test("approved writes and edits are independently reviewed", async () => {
  const base = { goal: "Smoke test", justification: "Create a temporary test file" };
  expect((await call({ ...base, tool: "write", arguments: { path: "allowed.txt", content: "before" } })).isError).not.toBe(true);
  expect((await call({ ...base, tool: "edit", arguments: { path: "allowed.txt", edits: [{ oldText: "before", newText: "after" }] } })).isError).not.toBe(true);
  expect(await readFile(join(root, "allowed.txt"), "utf8")).toBe("after");
  expect(requested.map((r) => r.data.action.tool)).toEqual(["write", "edit"]);
});

test("reviewed argument snapshot cannot be mutated during review", async () => {
  const args = bash("printf original-snapshot");
  responseHook = () => { args.arguments.command = "touch mutated-command"; };
  const result = await call(args);
  expect(JSON.stringify(result.content)).toContain("original-snapshot");
  expect(await exists(join(root, "mutated-command"))).toBe(false);
});

test("approval and denial reasons, durations, and reviewer are visible and persisted", async () => {
  const approval = await call(bash("printf transparent"));
  expect(JSON.stringify(approval.content)).toContain("Passt zur Aufgabe");
  expect(widgets.at(-1)?.join("\n")).toContain("Passt zur Aufgabe");
  expect(statuses.some((s) => s.includes("⠋") && s.includes("gpt-6-luna"))).toBe(true);
  expect(typeof approval.details.approval.reviewDurationMs).toBe("number");
  mode = "deny";
  const denial = await call(bash("printf denied"));
  expect(JSON.stringify(denial.content)).toContain("Nicht vom Nutzer gewollt");
  expect(widgets.at(-1)?.join("\n")).toContain("Nicht vom Nutzer gewollt");
  expect(typeof denial.details.reviewDurationMs).toBe("number");
  expect(requested[0].context.systemPrompt).toContain("LAST actual user prompt");
  expect(requested[0].context.systemPrompt).toContain("ONE short sentence");
});
