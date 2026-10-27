import { writeConfigFixture } from "./config-fixture.ts";
import { Check } from "typebox/value";
import { test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import {
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  chmod,
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  rm,
  access,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { writingCheckTool } from "../../public-writing/index.ts";
import { Coordination } from "../../multiplex/coordination.ts";
import { JobManager } from "../../jobs/manager.ts";
import { reviewedReceipts } from "../../shared/review/receipts.ts";
import { registerCipTools } from "../../shared/session/cip-tools.ts";
import { sessionServices } from "../../shared/session/services.ts";

const root = await mkdtemp(join(tmpdir(), "pi-approval-test-"));
const agentRoot = await mkdtemp(join(tmpdir(), "pi-approval-agent-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let validatedScopes: any[] = [];
let executedRequests: any[] = [];
let temporaryStores: string[] = [];
let executionGate: ((request: any, signal?: AbortSignal) => Promise<void>) | undefined;
let workspaceValidationFails = false;
let simulatedExecution:
  | { content: { type: string; text: string }[]; details: { exitCode: number } }
  | undefined;

process.env.PI_CODING_AGENT_DIR = agentRoot;
// Test-only module mock. Production has one mandatory Docker executor and no
// injection flag or local execution backend. Unit tests exercise the gate.
mock.module("../isolation.ts", () => ({
  detectWorkspace: async (cwd: string) => ({ path: cwd, cwd }),
  sandboxHostPath: (workspace: { cwd: string }, path: string) => resolve(workspace.cwd, path),
  validateWorkspace: async (
    cwd: string,
    _config: unknown,
    _protected: unknown,
    scope: unknown,
    temporaryDirectory: string,
    mode = "project",
  ) => {
    validatedScopes.push(structuredClone(scope));
    temporaryStores.push(temporaryDirectory);

    if (mode === "project" && workspaceValidationFails)
      throw new Error(
        "ENOENT: no such file or directory, lstat '/Users/gunter/.agents/skills/avoid-wikipedia-ai-writing-signs/SKILL.md'",
      );

    return mode !== "project"
      ? {
          path: "/workspace",
          cwd: "/workspace",
          bindings: (scope as any)?.paths?.map((entry: any) => entry.path) ?? [],
          masked: [],
          temporaryDirectory,
        }
      : {
          path: cwd,
          cwd,
          bindings: [cwd],
          readOnlyBindings: (scope as any)?.projectFiles === "read" ? [cwd] : [],
          masked: [],
          temporaryDirectory,
        };
  },

  executeIsolated: async (
    request: any,
    workspace: { path: string },
    _config: unknown,
    signal?: AbortSignal,
    privateCredentialInput?: any,
    privateGitReader?: any,
  ) => {
    const cwd = workspace.path;

    executedRequests.push(structuredClone(request));
    await executionGate?.(request, signal);

    if (simulatedExecution) return structuredClone(simulatedExecution);

    if (request.tool === "git")
      return {
        content: [
          {
            type: "text",
            text: privateGitReader
              ? "user.name\nSynthetic identity\0user.email\nsynthetic@example.invalid\0credential.helper\nprivate-synthetic-token\0"
              : "Synthetic commit completed",
          },
        ],
        details: { exitCode: 0 },
      };

    if (request.tool === "credential_exec") {
      expect(privateCredentialInput.environment.SERVICE_TOKEN).toBe(
        "synthetic-auth-only-after-review",
      );

      return {
        content: [{ type: "text", text: "authenticated result" }],
        details: { exitCode: 0 },
      };
    }

    if (["websearch", "webfetch"].includes(request.tool))
      return {
        content: [{ type: "text", text: "Readable public page." }],
        details: { finalUrl: "https://example.com/", hasMore: false },
      };

    if (request.tool === "writing_check")
      return writingCheckTool.execute("test-only", request.arguments, signal, undefined, ctx);

    const factories: any = {
      bash: createBashToolDefinition,
      read: createReadToolDefinition,
      write: createWriteToolDefinition,
      edit: createEditToolDefinition,
    };

    return await factories[request.tool](cwd).execute(
      "test-only",
      request.arguments,
      signal,
      undefined,
      ctx,
    );
  },
}));

const { default: extension } = await import("../index.ts");
const configPath = join(agentRoot, "auto-approval.json");
const localConfigPath = join(agentRoot, "auto-approval.device.json");
const config = {
  reviewer: { provider: "openai", model: "gpt-6-luna", thinking: "medium" },
  recentUserPrompts: 6,
  requestTimeoutMs: 120000,
  sandbox: { backend: "docker", image: `sha256:${"a".repeat(64)}` },
};
const usage = {
  input: 10,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let mode: "approve" | "deny" | "invalid" | "error" | "mismatch" = "approve";
let requested: any[];
let hooks: Record<string, Function>;
let actions: Record<string, ToolDefinition<any, any>>;
let extensionPi: ExtensionAPI;
let entries: any[];
let active: string[];
let auditFails: boolean;
let responseHook: (() => void) | undefined;
let widgets: (string[] | undefined)[];
let statuses: string[];
let currentApprovalStatus: string | undefined;
let ctx: ExtensionToolContext;

beforeEach(async () => {
  await writeConfigFixture(configPath, JSON.stringify(config));
  await writeFile(
    localConfigPath,
    JSON.stringify({ sandbox: { dockerExecutable: "/usr/bin/docker" } }),
  );
  mode = "approve";
  requested = [];
  hooks = {};
  actions = {};
  active = [];
  auditFails = false;
  responseHook = undefined;
  widgets = [];
  statuses = [];
  currentApprovalStatus = undefined;
  validatedScopes = [];
  executedRequests = [];
  temporaryStores = [];
  workspaceValidationFails = false;
  simulatedExecution = undefined;
  executionGate = undefined;
  entries = [
    {
      type: "message",
      message: {
        role: "user",
        content:
          "Run a harmless smoke test in the temporary working directory. Do not change any approval settings.",
      },
    },
  ];

  const pi = {
    on: (name: string, callback: Function) => {
      const previous = hooks[name];

      hooks[name] = previous
        ? async (...args: any[]) => {
            await previous(...args);

            return callback(...args);
          }
        : callback;
    },

    registerTool: (tool: ToolDefinition<any, any>) => {
      actions[tool.name] = tool;
    },

    registerCommand: () => {},
    getAllTools: () => Object.values(actions),

    setActiveTools: (names: string[]) => {
      active = names;
    },

    appendEntry: (customType: string, data: unknown) => {
      if (auditFails) throw new Error("Audit unavailable");

      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;

  ctx = {
    cwd: root,
    ui: {
      setStatus: (_key: string, text?: string) => {
        currentApprovalStatus = text;

        if (text) statuses.push(text);
      },

      setWidget: (_key: string, lines?: string[]) => widgets.push(lines),
      notify: () => {},
    },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
    modelRegistry: {
      find: (provider: string, id: string) => ({
        provider,
        id,
        api: "openai-responses",
        contextWindow: 272000,
        maxTokens: 128000,
        reasoning: true,
        thinkingLevelMap: { medium: "medium", low: "low" },
      }),
      hasConfiguredAuth: () => true,
      streamSimple: (model: any, context: any, options: any) => {
        const data = JSON.parse(context.messages[0].content);

        requested.push({ model, context, options, data });

        return {
          result: async () => {
            responseHook?.();

            if (
              mode === "approve" &&
              context.tools?.length &&
              !context.messages.some((message: any) => message.role === "toolResult")
            )
              return {
                stopReason: "toolUse",
                usage,
                content: [
                  ...new Set(
                    data.userPromptInfo
                      .filter((info: any) => info.compressed)
                      .map((info: any) => info.promptId),
                  ),
                ].map((promptId, i) => ({
                  type: "toolCall",
                  id: `lookup-${i}`,
                  name: "prompt_original",
                  arguments: { promptId, operation: "head", limit: 1000 },
                })),
              };

            return {
              stopReason: mode === "error" ? "error" : "stop",
              usage,
              content: [
                {
                  type: "text",
                  text:
                    mode === "invalid"
                      ? "not JSON"
                      : JSON.stringify({
                          requestId: mode === "mismatch" ? "another-action" : data.requestId,
                          decision: mode === "deny" ? "deny" : "approve",
                          reason:
                            mode === "deny" ? "Nicht vom Nutzer gewollt" : "Passt zur Aufgabe",
                        }),
                },
              ],
            };
          },
        };
      },
    },
  } as unknown as ExtensionToolContext;
  extensionPi = pi;
  extension(pi);
});

afterEach(async () => {
  await hooks.session_shutdown?.({}, ctx);
});

afterAll(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

  await rm(root, { recursive: true, force: true });
  await rm(agentRoot, { recursive: true, force: true });
});

const call = (args: any, signal?: AbortSignal) =>
  actions.approved_action.execute("call", args, signal, undefined, ctx);
const bash = (command: string) => ({
  tool: "bash",
  arguments: { command },
  goal: "Smoke test",
  justification: "Harmless isolated test",
});

test("action reviews, prompt compression and original lookups inherit the session fast preference", async () => {
  let fast = true;

  sessionServices(ctx).fastMode = () => fast;
  entries[0].message.content += "\nFAST-APPROVAL-FIXTURE\n" + "Bounded diagnostic.\n".repeat(1500);

  const result = await call(bash("printf fast-approval"));

  expect(result.isError).not.toBe(true);
  expect(requested.some((request) => request.data.originalPromptChunk)).toBe(true);
  expect(
    requested.some((request) =>
      request.context.messages.some((entry: any) => entry.role === "toolResult"),
    ),
  ).toBe(true);

  for (const request of requested) {
    const payload = request.options.onPayload(
      { model: request.model.id, service_tier: "auto" },
      request.model,
    );

    expect(payload.service_tier).toBe("priority");
  }

  const before = requested.length;

  fast = false;
  expect(
    requested[0].options.onPayload({ model: requested[0].model.id }, requested[0].model)
      .service_tier,
  ).toBe("priority");
  await call(bash("printf normal-approval"));

  for (const request of requested.slice(before)) {
    const payload = request.options.onPayload(
      { model: request.model.id, service_tier: "auto" },
      request.model,
    );

    expect(payload.service_tier).toBe("auto");
  }
});

test("review-mode delegation rejects mutation before review and advertises only read-only project mounts", async () => {
  await writeFile(join(root, "sample.txt"), "Read-only review fixture\n");
  sessionServices(ctx).delegationMode = "review";

  try {
    const denied = await call(bash("touch forbidden"));

    expect(JSON.stringify(denied)).toContain("Read-only review");
    expect(executedRequests).toHaveLength(0);

    const read = await call({
      tool: "read",
      arguments: { path: "sample.txt" },
      goal: "Inspect authorized source",
      justification: "Independent review",
    });

    expect(read.isError).not.toBe(true);
    expect(executedRequests).toHaveLength(1);
    expect(requested).toHaveLength(1);
    expect(requested[0].data.sandboxPlan.readOnlyBindings).toContain(root);
  } finally {
    sessionServices(ctx).delegationMode = undefined;
  }
});

const exists = async (path: string) => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

const credentialAction = () => ({
  tool: "credential_exec",
  arguments: { profile: "service", argv: ["inspect"] },
  network: true,
  goal: "Inspect authenticated service",
  justification: "User requested this authenticated operation",
});
const gitAction = () => ({
  tool: "git",
  arguments: { argv: ["commit", "-m", "Synthetic change"] },
  sandbox: { gitConfig: true },
  goal: "Commit the requested change",
  justification: "Use the existing operator identity for this exact local commit",
});

test("mailbox bypasses approval entirely while external actions still require review", async () => {
  const inaccessible = {
    get sessionManager() {
      throw new Error("Approval must not inspect mailbox sessions");
    },
  };

  expect(hooks.tool_call({ toolName: "mailbox" }, inaccessible)).toBeUndefined();
  expect(hooks.tool_call({ toolName: "set_goal" }, inaccessible)).toBeUndefined();
  expect(hooks.tool_call({ toolName: "ask_user" }, inaccessible)).toBeUndefined();
  expect(hooks.tool_call({ toolName: "user_questions" }, inaccessible)).toBeUndefined();
  expect(
    hooks.tool_call({ toolName: "mailbox", parentToolCallId: "nested" }, inaccessible),
  ).toBeUndefined();
  expect(requested).toEqual([]);

  const shared: unknown[] = [];

  sessionServices(ctx).mailbox = {
    name: "agent-fixture",
    active: () => true,
    audit: (data) => shared.push(data),
  };
  await hooks.session_start({}, ctx);
  expect(active).toEqual(["approved_action", "mailbox"]);
  expect(await hooks.tool_call({ toolName: "mailbox" }, ctx)).toBeUndefined();
  expect(requested).toEqual([]);
  mode = "deny";
  expect((await call(bash("touch denied-with-peers"))).isError).toBe(true);
  expect(requested).toHaveLength(1);
  expect(executedRequests).toEqual([]);
  expect((shared[0] as any).multiplexAgent).toBe("agent-fixture");
  expect((shared[0] as any).decision).toBe("deny");
  sessionServices(ctx).mailbox!.active = () => false;
  expect(hooks.tool_call({ toolName: "mailbox" }, ctx)).toBeUndefined();
});

async function configureGitFixture() {
  await writeConfigFixture(
    configPath,
    JSON.stringify({ ...config, sandbox: { backend: "bwrap" } }),
  );
  await writeFile(
    localConfigPath,
    JSON.stringify({
      sandbox: { executable: process.execPath, runnerExecutable: process.execPath },
    }),
  );
}

test("a denied Git configuration grant or failed audit never reads configs or starts the private getter", async () => {
  await configureGitFixture();
  mode = "deny";

  const denied = await call(gitAction());

  expect(denied.isError).toBe(true);
  expect(denied.details.reason).toBe("Nicht vom Nutzer gewollt");
  expect(executedRequests).toEqual([]);

  const plan = requested[0].data.sandboxPlan;

  expect(plan.gitConfiguration.readOnly).toBe(true);
  expect(plan.gitConfiguration.originalsMounted).toBe(false);
  expect(plan.temporaryStorage.lifetime).toBe("one action");
  expect(JSON.stringify(requested)).not.toContain("Synthetic identity");
  mode = "approve";
  auditFails = true;
  expect((await call(gitAction())).isError).toBe(true);
  expect(executedRequests).toEqual([]);
});

test("approved Git settings are read after the decision and later actions receive no grant", async () => {
  await configureGitFixture();

  const path = join(root, "synthetic.global.gitconfig"),
    previous = process.env.GIT_CONFIG_GLOBAL;

  await writeFile(path, "[user]\nname = Synthetic identity\nemail = synthetic@example.invalid\n");
  process.env.GIT_CONFIG_GLOBAL = path;

  try {
    responseHook = () => expect(executedRequests).toEqual([]);

    const result = await call(gitAction());

    expect(result.isError).not.toBe(true);
    expect(executedRequests.map((item) => item.arguments.argv[0])).toEqual([
      "config",
      "config",
      "commit",
    ]);
    expect(
      entries.some(
        (entry) => entry.customType === "auto-approval-review" && entry.data.decision === "approve",
      ),
    ).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("Synthetic identity");
    expect(JSON.stringify(entries)).not.toContain("private-synthetic-token");
    responseHook = undefined;
    expect((await call(bash("printf later"))).isError).not.toBe(true);
    expect(executedRequests.at(-1).sandbox?.gitConfig).toBeUndefined();
    expect(await readFile(path, "utf8")).toContain("Synthetic identity");
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});

test("rebase reaches independent review and a denial executes nothing", async () => {
  await configureGitFixture();
  mode = "deny";

  const request = {
    ...gitAction(),
    arguments: { argv: ["rebase", "synthetic-upstream", "lkl/rush"] },
    goal: "Rebase the user-selected local branch",
    justification: "The user requested this local rebase with their existing identity",
  };
  const denied = await call(request);

  expect(denied.isError).toBe(true);
  expect(requested).toHaveLength(1);
  expect(requested[0].data).toMatchObject({ action: { arguments: request.arguments } });
  expect(executedRequests).toEqual([]);
});

test("Git configuration cannot be attached to bash or hidden in unknown private executor input", async () => {
  await configureGitFixture();

  for (const request of [
    { ...bash("env"), sandbox: { gitConfig: true } },
    { ...gitAction(), gitConfigReader: { home: "/private", xdg: "/private" } },
    { ...gitAction(), arguments: { argv: ["push"] } },
  ])
    expect((await call(request)).isError).toBe(true);

  expect(requested).toEqual([]);
  expect(executedRequests).toEqual([]);
});

test("GitHub API calls reach independent review without an endpoint exception; denial never resolves credentials", async () => {
  await configureGitFixture();
  await writeFile(
    localConfigPath,
    JSON.stringify({
      sandbox: { executable: process.execPath, runnerExecutable: process.execPath },
      credentialProfiles: [
        {
          name: "github",
          executable: process.execPath,
          argumentPolicy: "review",
          secrets: { GH_TOKEN: { type: "file", path: join(agentRoot, "must-not-read") } },
        },
      ],
    }),
  );
  mode = "deny";

  const argv = ["api", "--paginate", "repos/stuck-lehnert/sortsys/dependabot/alerts?state=open"];
  const request = { ...credentialAction(), arguments: { profile: "github", argv } };
  const result = await call(request);

  expect(result.isError).toBe(true);
  expect(result.details.reason).toBe("Nicht vom Nutzer gewollt");
  expect(requested[0].data.action.arguments.argv).toEqual(argv);
  expect(requested[0].data.sandboxPlan.credentials.argumentPolicy).toBe("review");
  expect(requested[0].data.sandboxPlan.credentials.operatorArgumentMatch).toBeUndefined();
  expect(executedRequests).toEqual([]);
});

test("general review-mode credentials and project access are scoped and cannot skip denial or audit", async () => {
  const secretPath = join(agentRoot, "review-mode-token");

  await writeFile(secretPath, "synthetic-auth-only-after-review", { mode: 0o600 });
  await configureCredentialFixture(secretPath);
  await writeFile(
    localConfigPath,
    JSON.stringify({
      sandbox: { executable: process.execPath, runnerExecutable: process.execPath },
      credentialProfiles: [
        {
          name: "service",
          executable: process.execPath,
          argumentPolicy: "review",
          secrets: { SERVICE_TOKEN: { type: "file", path: secretPath } },
        },
      ],
    }),
  );

  const request = {
    ...credentialAction(),
    arguments: { profile: "service", argv: ["a-new-operation", "--file", join(root, "body.txt")] },
    sandbox: { projectFiles: "read" },
  };

  mode = "deny";
  expect((await call(request)).isError).toBe(true);
  expect(executedRequests).toEqual([]);
  mode = "approve";
  auditFails = true;
  expect((await call(request)).isError).toBe(true);
  expect(executedRequests).toEqual([]);
  auditFails = false;

  const result = await call(request);

  expect(result.isError).not.toBe(true);

  const plan = requested.at(-1).data.sandboxPlan;

  expect(plan.credentials.argumentPolicy).toBe("review");
  expect(plan.credentials.projectFiles).toBe(true);
  expect(plan.bindings).toEqual([root]);
  expect(plan.readOnlyBindings).toEqual([root]);
  expect(executedRequests.at(-1).arguments.argv).toEqual(request.arguments.argv);
  expect(JSON.stringify(entries)).not.toContain("synthetic-auth-only-after-review");
  expect((await call({ ...bash("env"), sandbox: { projectFiles: "read" } })).isError).toBe(true);
});

async function configureCredentialFixture(secretPath: string) {
  await writeConfigFixture(
    configPath,
    JSON.stringify({ ...config, sandbox: { backend: "bwrap" } }),
  );
  await writeFile(
    localConfigPath,
    JSON.stringify({
      sandbox: { executable: process.execPath, runnerExecutable: process.execPath },
      credentialProfiles: [
        {
          name: "service",
          executable: process.execPath,
          allowedArgv: [[{ literal: "inspect" }]],
          secrets: { SERVICE_TOKEN: { type: "file", path: secretPath } },
        },
      ],
    }),
  );
}

test("a denied credential action does not read its secret or run its credential getter", async () => {
  await configureCredentialFixture(join(agentRoot, "missing-credential"));
  mode = "deny";

  const result = await call(credentialAction());

  expect(result.isError).toBe(true);
  expect(executedRequests).toHaveLength(0);
  expect(result.details.reason).toBe("Nicht vom Nutzer gewollt");
  expect(requested[0].data.sandboxPlan.credentials.profile).toBe("service");
  expect(requested[0].data.sandboxPlan.bindings).toEqual([]);
  expect(requested[0].data.sandboxPlan.temporaryStorage.lifetime).toBe("one action");
});

test("approved credential input is private, argv is snapshotted, and later actions receive no grant", async () => {
  const path = join(agentRoot, "synthetic-credential");

  await writeFile(path, "synthetic-auth-only-after-review", { mode: 0o600 });
  await configureCredentialFixture(path);

  const action = credentialAction();

  responseHook = () => {
    action.arguments.argv[0] = "auth-token";
  };

  const result = await call(action);

  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(executedRequests[0].arguments.argv).toEqual(["inspect"]);
  expect(JSON.stringify(requested.map((item) => item.data))).not.toContain(
    "synthetic-auth-only-after-review",
  );
  expect(JSON.stringify(entries)).not.toContain("synthetic-auth-only-after-review");
  expect(JSON.stringify(result)).not.toContain("synthetic-auth-only-after-review");
  responseHook = undefined;
  await call(bash("printf ordinary"));
  expect(executedRequests[1].tool).toBe("bash");
  expect(executedRequests[1].sandbox).toBeUndefined();
});

test("failed audit and abort before credential execution never resolve secrets", async () => {
  await configureCredentialFixture(join(agentRoot, "missing-credential"));
  auditFails = true;
  expect((await call(credentialAction())).isError).toBe(true);
  expect(executedRequests).toHaveLength(0);
  auditFails = false;

  const controller = new AbortController();

  responseHook = () => controller.abort();
  expect((await call(credentialAction(), controller.signal)).isError).toBe(true);
  expect(executedRequests).toHaveLength(0);
});

test("only approved_action is active on session start and before each run", async () => {
  await hooks.session_start({}, ctx);
  expect(active).toEqual(["approved_action"]);
  await hooks.before_agent_start({}, ctx);
  expect(active).toEqual(["approved_action"]);
  expect(actions.approved_action.exposure).toBe("model-only");
});

test("a missing native executor locks startup and blocks before any paid review", async () => {
  await writeConfigFixture(
    configPath,
    JSON.stringify({ ...config, sandbox: { backend: "bwrap" } }),
  );

  const missing = join(agentRoot, "missing-executor");

  await writeFile(
    localConfigPath,
    JSON.stringify({ sandbox: { executable: process.execPath, runnerExecutable: missing } }),
  );
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
    expect(requested.at(-1).data.sandboxPlan.temporaryStorage).toEqual({
      path: "/tmp",
      lifetime: "Pi session",
      private: true,
    });
    await writeFile(join(current, "cleanup-fixture"), "temporary");

    const blocked = join(current, "inaccessible-directory");

    await mkdir(blocked);
    await writeFile(join(blocked, "fixture"), "temporary");
    await chmod(blocked, 0o000);

    const externalMode = (await stat(root)).mode;

    await symlink(root, join(current, "external-link"));
    await hooks.session_shutdown({ reason }, ctx);
    expect(await exists(current)).toBe(false);
    expect(await exists(root)).toBe(true);
    expect((await stat(root)).mode).toBe(externalMode);
    previous = current;
  }
});

test("every direct, unknown, nested, MCP, and codemode route is blocked", async () => {
  for (const toolName of [
    "bash",
    "powershell",
    "read",
    "edit",
    "write",
    "codemode",
    "tool_search",
    "mcp_exec",
    "subagent",
    "history",
    "notes",
    "new_context",
    "arbitrary",
  ]) {
    expect((await hooks.tool_call({ toolName }, ctx)).block).toBe(true);
  }

  expect(
    (await hooks.tool_call({ toolName: "approved_action", parentToolCallId: "parent" }, ctx)).block,
  ).toBe(true);
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

  expect(payload.text.format.schema.properties.requestId).toEqual({ type: "string" });
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

test("ordinary prose writes retain safety-only review and preserve submitted wording", async () => {
  const content = "These artifacts are experimental, not deployment-qualified.";
  const result = await call({
    tool: "write",
    arguments: { path: "README.md", content },
    goal: "Write project documentation",
    justification: "Document the experimental exports in the project.",
  });

  expect(result.isError).not.toBe(true);
  expect(requested[0].context.systemPrompt).not.toContain("invented-contrast");
  expect(requested[0].context.systemPrompt).not.toContain("repeated-closers");
  expect(executedRequests[0].arguments.content).toBe(content);
});

test("style review judges the immutable exact draft once and uses no network grant", async () => {
  const args = {
    tool: "writing_check",
    arguments: { text: "自転車の修理を承ります。", audience: "public" },
    goal: "Public draft",
    justification: "Review visitor copy",
  };

  responseHook = () => {
    args.arguments.text = "changed during review";
  };

  const result = await call(args);

  expect(result.isError).not.toBe(true);
  expect(requested).toHaveLength(1);
  expect(requested[0].data.action.arguments.text).toBe("自転車の修理を承ります。");
  expect(requested[0].data.action.sandbox?.network).not.toBe("host");
  expect(executedRequests[0].arguments.text).toBe("自転車の修理を承ります。");
  expect(result.details.result.checked).toBe(true);
  expect(requested[0].context.systemPrompt).toContain("EVERY language");
});

test("a valid style denial executes nothing; a corrected exact draft gets a new review", async () => {
  const args = {
    tool: "writing_check",
    arguments: { text: "Not a product. A revolution.", audience: "public" },
    goal: "Public draft",
    justification: "Review visitor copy",
  };

  mode = "deny";
  expect((await call(args)).isError).toBe(true);
  expect(requested).toHaveLength(1);
  expect(executedRequests).toHaveLength(0);
  mode = "approve";
  args.arguments.text = "Repairs take two days.";
  expect((await call(args)).isError).not.toBe(true);
  expect(requested).toHaveLength(2);
  expect(executedRequests).toHaveLength(1);
  expect(requested[0].data.requestId).not.toBe(requested[1].data.requestId);
});

test("web operations review exact input and networking before isolated execution", async () => {
  const args = {
    tool: "webfetch",
    arguments: { url: "https://example.com/" },
    goal: "Research",
    justification: "Read a public source",
  };

  responseHook = () => {
    args.arguments.url = "http://localhost/admin";
  };

  const result = await call(args);

  expect(result.isError).not.toBe(true);
  expect(requested[0].data.action.sandbox.network).toBe("host");
  expect(requested[0].data.sandboxPlan.webRuntime.execution.stdin.arguments.url).toBe(
    "https://example.com/",
  );
  expect(executedRequests[0].arguments.url).toBe("https://example.com/");
  expect(result.content).toEqual([{ type: "text", text: "Readable public page." }]);
  expect(result.details.approvalSummary).toContain("Passt zur Aufgabe");
  responseHook = undefined;
  await call(bash("printf offline-next"));
  expect(executedRequests[1].sandbox).toBeUndefined();
});

test("unrelated missing skill files cannot prevent web review; project failures name their actual stage", async () => {
  workspaceValidationFails = true;

  const search = await call({
    tool: "websearch",
    arguments: { query: "Franz Lehnert" },
    goal: "Research",
    justification: "Find public information",
  });

  expect(search.isError).not.toBe(true);
  expect(requested).toHaveLength(1);
  expect(executedRequests).toHaveLength(1);
  expect(requested[0].data.sandboxPlan.bindings).toEqual([]);
  expect(requested[0].data.action.arguments.query).toBe("Franz Lehnert");
  expect(search.details.approval.cwd).toBe(root);
  expect(search.details.approval.executionCwd).toBe("/workspace");

  const failed = await call(bash("printf project-check"));

  expect(failed.isError).toBe(true);
  expect(failed.details.technicalStage).toBe("workspace validation");
  expect(requested).toHaveLength(1);
  expect(executedRequests).toHaveLength(1);
  expect(JSON.stringify(failed.content)).toContain("workspace validation");
  expect(JSON.stringify(failed.content)).not.toContain("openai/gpt-6-luna");
});

test("large pasted reports and denial audits still permit an independently reviewed small read", async () => {
  const prompt =
    "Prüfe den Quelltext ohne Änderungen: " +
    JSON.stringify({
      tests: Array(2000).fill({
        name: "Leerer Betreff",
        success: true,
        points: "-0.000000000000000",
      }),
    });

  entries.push({ type: "message", message: { role: "user", content: prompt } });

  for (let i = 0; i < 6; i++)
    entries.push({
      type: "custom",
      customType: "auto-approval-review",
      data: {
        decision: "deny",
        reason: "Keine Zugangsdaten lesen.",
        action: bash("obsolete-command".repeat(10000)),
        sandboxPlan: { unused: "x".repeat(10000) },
      },
    });

  const code = "/* geprüfter Quelltext */".repeat(3000);
  const audit = {
    toolCallId: "prior-read",
    requestId: "prior-request",
    fingerprint: "prior-hash",
    decision: "approve",
    action: { tool: "read", arguments: { path: "reference.c" } },
  };

  entries.push({ type: "custom", customType: "auto-approval-review", data: audit });
  entries.push({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "approved_action",
      toolCallId: "prior-read",
      content: [
        { type: "text", text: "approved" },
        { type: "text", text: code },
      ],
      details: { approval: audit },
    },
  });
  await writeFile(join(root, "reference.c"), "int harmless;\n");

  const read = {
    tool: "read",
    arguments: { path: "reference.c", offset: 1, limit: 1 },
    goal: "Prüfen",
    justification: "Fehlerdiagnose",
  };
  const result = await call(read);

  expect(result.isError).not.toBe(true);

  const review = requested.filter((item) => item.data.action).at(-1);

  expect(review.data.userPromptInfo.at(-1).compressed).toBe(true);
  expect(review.data.userPrompts.at(-1)).toBe("Passt zur Aufgabe");
  expect(review.data.action).toEqual(read);
  expect(review.data.previousDenials[0].reason).toBe("Keine Zugangsdaten lesen.");
  expect(review.data.reviewedReads[0].content[0].text).toBe(code);
  expect(JSON.stringify(review.data)).not.toContain("obsolete-command");
  expect(
    review.context.messages.find((message: any) => message.role === "toolResult").content[0].text,
  ).toContain("Prüfe den Quelltext ohne Änderungen");
  expect(
    entries.some(
      (entry) => entry.customType === "auto-approval-prompt-compression" && entry.data.compressed,
    ),
  ).toBe(true);
  expect(executedRequests).toEqual([read]);
  expect(JSON.stringify(result.content)).toContain("int harmless;");
});

test.each(["flutter pub get", "dart pub get", "flutter build web --no-pub"])(
  "lookup recovery reaches the synthetic executor once with the exact approved %s request",
  async (command) => {
    entries[0].message.content =
      "Fetch client dependencies and build Flutter web in the prepared container. Network downloads require separate command approval. Do not read credentials or upload source.\n" +
      "Diagnostic line.\n".repeat(1500);
    simulatedExecution = {
      content: [{ type: "text", text: "Synthetic Flutter executor completed" }],
      details: { exitCode: 0 },
    };

    const initialStream = ctx.modelRegistry.streamSimple;
    let turn = 0;

    ctx.modelRegistry.streamSimple = ((model: any, context: any, options: any) => {
      const data = JSON.parse(context.messages[0].content);

      if (!data.action) return initialStream.call(ctx.modelRegistry, model, context, options);

      requested.push({ model, context, options, data });
      turn++;

      const content =
        turn < 3
          ? [
              {
                type: "toolCall",
                id: `read-${turn}`,
                name: "prompt_original",
                arguments: {
                  promptId: data.userPromptInfo[0].promptId,
                  operation: "head",
                  limit: turn === 1 ? 20000 : 1000,
                },
              },
            ]
          : [
              {
                type: "text",
                text: JSON.stringify({
                  requestId: data.requestId,
                  decision: "approve",
                  reason: "Scoped Flutter workflow.",
                }),
              },
            ];

      return {
        result: async () => ({
          stopReason: turn < 3 ? "toolUse" : "stop",
          usage,
          content,
        }),
      };
    }) as any;

    const request = {
      ...bash(command),
      network: command.includes("pub get"),
      sandbox: { tools: [command.startsWith("dart") ? "dart" : "flutter"] },
    };
    const result = await call(request);

    expect(result.isError).not.toBe(true);
    expect(turn).toBe(3);
    expect(executedRequests).toHaveLength(1);
    expect(executedRequests[0].arguments.command).toBe(command);
    expect(executedRequests[0].sandbox.network).toBe(request.network ? "host" : "none");
    expect(executedRequests[0].sandbox.tools).toEqual(request.sandbox.tools);
    expect(entries.some((entry) => entry.customType === "auto-approval-prompt-lookup-error")).toBe(
      true,
    );
    expect(result.details.approval.decision).toBe("approve");
  },
);

test("web denials and invalid expansions cannot execute or ask another reviewer", async () => {
  mode = "deny";

  const args = {
    tool: "websearch",
    arguments: { query: "Python documentation" },
    goal: "Research",
    justification: "Find official sources",
  };

  expect((await call(args)).isError).toBe(true);
  expect(executedRequests).toHaveLength(0);
  expect(requested).toHaveLength(1);
  mode = "approve";
  expect((await call({ ...args, sandbox: { network: "none" } })).isError).toBe(true);
  expect((await call({ ...args, arguments: { query: "secret", command: "id" } })).isError).toBe(
    true,
  );
  expect(executedRequests).toHaveLength(0);
  expect(requested).toHaveLength(1);
  expect((await hooks.tool_call({ toolName: "websearch" }, ctx)).block).toBe(true);
});

test("sandbox expansion is reviewed with the action, executed exactly, and never retained", async () => {
  const sandbox = {
    paths: [{ path: "/tmp/shared-source", access: "read" }],
    network: "host",
    environment: { BUILD_MODE: "test" },
    limits: { executionTimeoutMs: 900000 },
  };
  const args = { ...bash("printf scoped"), sandbox };

  responseHook = () => {
    args.sandbox.paths[0].path = "/tmp/changed-after-review";
  };

  const result = await call(args);

  expect(result.isError).not.toBe(true);
  expect(requested[0].data.action.sandbox.paths[0].path).toBe("/tmp/shared-source");
  expect(validatedScopes[0].paths[0].path).toBe("/tmp/shared-source");
  expect(executedRequests[0].sandbox.paths[0].path).toBe("/tmp/shared-source");
  expect(result.details.approval.sandboxPlan.requested.network).toBe("host");
  responseHook = undefined;
  await call(bash("printf default"));
  expect(validatedScopes[1]).toBeUndefined();
  expect(executedRequests[1].sandbox).toBeUndefined();
});

test("denied sandbox requests and forged disable switches never execute", async () => {
  mode = "deny";
  expect((await call({ ...bash("printf denied"), sandbox: { network: "host" } })).isError).toBe(
    true,
  );
  expect(executedRequests).toHaveLength(0);
  mode = "approve";

  const reviewed = requested.length;

  expect((await call({ ...bash("printf bypass"), sandbox: { isolation: false } })).isError).toBe(
    true,
  );
  expect(requested).toHaveLength(reviewed);
  expect(executedRequests).toHaveLength(0);
});

test("one-command network flag requires approval and expires after that process", async () => {
  mode = "deny";
  expect(
    (
      await call({
        ...bash("touch denied-network-flag"),
        network: true,
        sandbox: { tools: ["node"] },
      })
    ).isError,
  ).toBe(true);
  expect(requested[0].data.action.sandbox).toEqual({ tools: ["node"], network: "host" });
  expect(requested[0].data.action.network).toBeUndefined();
  expect(executedRequests).toHaveLength(0);
  mode = "approve";
  expect((await call({ ...bash("printf scoped-network"), network: true })).isError).not.toBe(true);
  expect(executedRequests[0].sandbox.network).toBe("host");
  await call(bash("printf subsequent-offline"));
  expect(executedRequests[1].sandbox).toBeUndefined();

  const count = requested.length;

  expect(
    (await call({ ...bash("touch conflict"), network: true, sandbox: { network: "none" } }))
      .isError,
  ).toBe(true);
  expect(
    (
      await call({
        tool: "read",
        arguments: { path: "package.json" },
        goal: "Read",
        justification: "Inspect",
        network: true,
      })
    ).isError,
  ).toBe(true);
  expect(requested).toHaveLength(count);
  expect(executedRequests).toHaveLength(2);
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
  await writeConfigFixture(configPath, '{"enabled":false}');
  expect((await call(bash("touch invalid-config"))).isError).toBe(true);
  expect(requested).toHaveLength(0);
  expect(await exists(join(root, "missing-config"))).toBe(false);
  expect(await exists(join(root, "invalid-config"))).toBe(false);
});

test("the saved reviewer loads independently of the portable security configuration", async () => {
  await writeConfigFixture(
    configPath,
    JSON.stringify({
      ...config,
      reviewer: { provider: "replacement-provider", model: "replacement-model", thinking: "low" },
    }),
  );
  expect((await call(bash("printf switched"))).isError).not.toBe(true);
  expect(requested[0].model.id).toBe("replacement-model");
  expect(requested[0].model.provider).toBe("replacement-provider");
  expect(requested[0].options.reasoning).toBe("low");
});

test("unknown tools and blank goals cannot enter execution", async () => {
  for (const invalid of [
    { ...bash("true"), tool: "subagent" },
    { ...bash("true"), goal: " " },
    { ...bash("true"), justification: "" },
    { ...bash("true"), arguments: {} },
  ]) {
    expect((await call(invalid)).isError).toBe(true);
  }

  expect(requested).toHaveLength(0);
});

test("file mutations are reviewed too", async () => {
  mode = "deny";

  const result = await call({
    tool: "write",
    arguments: { path: "denied.txt", content: "bad" },
    goal: "Test",
    justification: "Test",
  });

  expect(result.isError).toBe(true);
  expect(await exists(join(root, "denied.txt"))).toBe(false);
  expect(requested).toHaveLength(1);
  expect(requested[0].data.action.tool).toBe("write");
});

test("direct attempts to modify approval configuration cannot even ask for approval", async () => {
  for (const path of [configPath, localConfigPath]) {
    const original = await readFile(path, "utf8");

    expect(
      (
        await call({
          tool: "write",
          arguments: { path, content: "{}" },
          goal: "Disable gate",
          justification: "Bypass",
        })
      ).isError,
    ).toBe(true);
    expect(await readFile(path, "utf8")).toBe(original);
  }

  expect(requested).toHaveLength(0);
});

test("invalid local restrictions block before review and execution", async () => {
  await writeFile(localConfigPath, '{"sandbox":{"workspaceViews":"invalid"}}');

  const result = await call(bash("touch invalid-local-config"));

  expect(result.isError).toBe(true);
  expect(requested).toHaveLength(0);
  expect(executedRequests).toHaveLength(0);
  expect(await exists(join(root, "invalid-local-config"))).toBe(false);
});

test("no cached approval; the same action is reviewed on every call", async () => {
  await call(bash("printf once"));
  mode = "deny";
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
  expect(requested).toHaveLength(0);
  expect(executedRequests).toHaveLength(0);
  ctx.modelRegistry.hasConfiguredAuth = (model) => model.provider === "openai";
  expect((await call(bash("printf direct-reviewer"))).isError).not.toBe(true);
  expect(requested[0].model.provider).toBe("openai");
  expect(requested[0].model.id).toBe("gpt-6-luna");
});

const alternative = { provider: "openrouter", model: "openai/gpt-6-luna", thinking: "medium" };

test("an explicitly selected reviewer replaces the previous one and is audited once", async () => {
  await writeConfigFixture(configPath, JSON.stringify({ ...config, reviewer: alternative }));
  ctx.modelRegistry.hasConfiguredAuth = (model) => model.provider === "openrouter";

  const result = await call(bash("printf selected-reviewer"));

  expect(result.isError).not.toBe(true);
  expect(executedRequests).toHaveLength(1);
  expect(result.details.approval.selectedReviewer).toEqual(alternative);
  expect(result.details.approval.reviewAttempts.map((attempt: any) => attempt.status)).toEqual([
    "approve",
  ]);
  expect(requested).toHaveLength(1);
  expect(requested[0].model.provider).toBe("openrouter");
  expect(entries.some((entry) => entry.customType === "auto-approval-reviewer-failure")).toBe(
    false,
  );
  expect(currentApprovalStatus).toBeUndefined();
  ctx.modelRegistry.hasConfiguredAuth = () => true;
  await call(bash("printf same-selected-reviewer"));
  expect(requested[1].model.provider).toBe("openrouter");
});

test("a provider failure retains the exact action and never tries another reviewer", async () => {
  const args = bash("printf immutable-failed-action");

  responseHook = () => {
    mode = "error";
    args.arguments.command = "touch mutated-failed-action";
  };

  const result = await call(args);

  expect(result.isError).toBe(true);
  expect(executedRequests).toHaveLength(0);
  expect(requested.map((request) => request.data.action.arguments.command)).toEqual([
    "printf immutable-failed-action",
  ]);
  expect(result.usage?.totalTokens).toBe(20);
  expect(result.details.reviewAttempts).toHaveLength(1);
  expect(await exists(join(root, "mutated-failed-action"))).toBe(false);
});

test("a denial stays final after a reviewer change and never executes", async () => {
  mode = "deny";
  expect((await call(bash("touch denied-review"))).isError).toBe(true);
  expect(requested).toHaveLength(1);
  await writeConfigFixture(configPath, JSON.stringify({ ...config, reviewer: alternative }));

  const result = await call(bash("touch denied-alternative-review"));

  expect(result.isError).toBe(true);
  expect(result.details.selectedReviewer).toEqual(alternative);
  expect(result.details.decision).toBe("deny");
  expect(result.details.technicalFailure).toBeUndefined();
  expect(executedRequests).toHaveLength(0);
});

test("invalid verdicts and cancellation cannot select a different reviewer", async () => {
  mode = "mismatch";

  const invalid = await call(bash("touch wrong-verdict"));

  expect(invalid.isError).toBe(true);
  expect(requested).toHaveLength(1);
  expect(invalid.details.reviewAttempts[0].status).toBe("invalid");

  const controller = new AbortController();

  responseHook = () => controller.abort();
  expect((await call(bash("touch cancelled-review"), controller.signal)).isError).toBe(true);
  expect(requested).toHaveLength(2);
  expect(executedRequests).toHaveLength(0);
});

test("failed audit or unavailable reviewer blocks execution without alternatives", async () => {
  ctx.modelRegistry.hasConfiguredAuth = () => false;
  auditFails = true;
  expect((await call(bash("touch failed-review-audit"))).isError).toBe(true);
  expect(requested).toHaveLength(0);
  expect(executedRequests).toHaveLength(0);
  auditFails = false;

  const result = await call(bash("touch unavailable-reviewer"));

  expect(result.isError).toBe(true);
  expect(result.details.reviewAttempts).toHaveLength(1);
  expect(result.details.technicalFailure).toBe(true);
  expect(executedRequests).toHaveLength(0);
});

test("review plus execution is serialized for concurrent calls", async () => {
  const results = await Promise.all([
    call(bash("printf first >> order.txt")),
    call(bash("printf second >> order.txt")),
  ]);

  expect(
    results.every((r) => !r.isError),
    JSON.stringify(results),
  ).toBe(true);
  expect(await readFile(join(root, "order.txt"), "utf8")).toBe("firstsecond");
  expect(requested).toHaveLength(2);
});

test("symlink aliases cannot write security configuration or operator reviewer preferences", async () => {
  for (const path of [configPath, join(agentRoot, "state/model-selection/reviewer.json")]) {
    const alias = join(root, `protected-alias-${crypto.randomUUID()}.json`);
    const before = await readFile(path, "utf8");

    await symlink(path, alias);

    const result = await call({
      tool: "write",
      arguments: { path: alias, content: "{}" },
      goal: "Disable",
      justification: "Bypass via alias",
    });

    expect(result.isError).toBe(true);
    expect(requested).toHaveLength(0);
    expect(await readFile(path, "utf8")).toBe(before);
  }
});

test("approved writes and edits are independently reviewed", async () => {
  const base = { goal: "Smoke test", justification: "Create a temporary test file" };

  expect(
    (await call({ ...base, tool: "write", arguments: { path: "allowed.txt", content: "before" } }))
      .isError,
  ).not.toBe(true);
  expect(
    (
      await call({
        ...base,
        tool: "edit",
        arguments: { path: "allowed.txt", edits: [{ oldText: "before", newText: "after" }] },
      })
    ).isError,
  ).not.toBe(true);
  expect(await readFile(join(root, "allowed.txt"), "utf8")).toBe("after");
  expect(requested.map((r) => r.data.action.tool)).toEqual(["write", "edit"]);
});

test("reviewed argument snapshot cannot be mutated during review", async () => {
  const args = bash("printf original-snapshot");

  responseHook = () => {
    args.arguments.command = "touch mutated-command";
  };

  const result = await call(args);

  expect(JSON.stringify(result.content)).toContain("original-snapshot");
  expect(await exists(join(root, "mutated-command"))).toBe(false);
});

test("approval and denial remain in activity results and audit without a prompt widget", async () => {
  await hooks.session_start({}, ctx);
  expect(widgets).toEqual([undefined]);
  expect(currentApprovalStatus).toBeUndefined();
  expect(statuses).toEqual([]);
  responseHook = () => {
    expect(currentApprovalStatus).toContain("approval: openai/gpt-6-luna");
    expect(currentApprovalStatus).not.toContain("unused-backup");
    expect(currentApprovalStatus).not.toContain("medium");
    expect(currentApprovalStatus).not.toContain("→");
  };

  const approval = await call(bash("printf transparent"));

  expect(currentApprovalStatus).toBeUndefined();
  expect(JSON.stringify(approval.content)).toContain("Passt zur Aufgabe");
  expect(statuses.some((s) => s.includes("⠋") && s.includes("gpt-6-luna"))).toBe(true);
  expect(typeof approval.details.approval.reviewDurationMs).toBe("number");
  mode = "deny";

  const denial = await call(bash("printf denied"));

  expect(currentApprovalStatus).toBeUndefined();
  expect(JSON.stringify(denial.content)).toContain("Nicht vom Nutzer gewollt");
  expect(widgets).toEqual([undefined]);
  expect(entries.at(-1).data.reason).toBe("Nicht vom Nutzer gewollt");
  expect(typeof denial.details.reviewDurationMs).toBe("number");
  expect(requested[0].context.systemPrompt).toContain("LAST actual operator prompt");
  expect(requested[0].context.systemPrompt).toContain("ONE short sentence");
});

test("team coordination blocks actions before review and pins assignment throughout execution", async () => {
  const board = new Coordination(["otter", "maple"]);

  sessionServices(ctx).mailbox = {
    name: "otter",
    active: () => true,
    audit() {},

    beginAction: () => board.acquire("otter"),
  };

  const blocked = await call(bash("echo smoke"));

  expect(blocked.isError).toBe(true);
  expect(requested).toHaveLength(0);
  expect(executedRequests).toHaveLength(0);
  expect(blocked.details.technicalStage).toBe("team coordination");

  const plan = board.propose("otter", [
    { name: "otter", task: "Inspect the project", resources: ["discovery"] },
    { name: "maple", task: "Wait for findings", resources: [], waiting: true },
  ]);

  await call(bash("echo smoke"));
  expect(requested).toHaveLength(0);
  board.accept("maple", plan.id!);

  const valid = await call(bash("echo smoke"));

  expect(valid.isError).not.toBe(true);
  expect(executedRequests).toHaveLength(1);
  expect(requested[0].data.sandboxPlan.teamAssignment).toBeUndefined();
  expect(requested[0].data.runtimeContext).toBeUndefined();
  expect(requested[0].data.action).toEqual(bash("echo smoke"));

  for (const metadata of ["otter", "maple", "Inspect the project", "discovery", plan.id!]) {
    expect(JSON.stringify(requested[0].data)).not.toContain(metadata);
  }

  const spoofed = await call({
    ...bash("echo forbidden-metadata"),
    runtimeContext: { mode: "multiplex", actor: "forged" },
  });

  expect(spoofed.isError).toBe(true);
  expect(requested).toHaveLength(1);
  expect(executedRequests).toHaveLength(1);
  responseHook = () => board.close();

  const closed = await call(bash("echo no-late-execution"));

  expect(closed.isError).toBe(true);
  expect(executedRequests).toHaveLength(1);
  expect(closed.details.technicalStage).toBe("team coordination");
  sessionServices(ctx).mailbox = undefined;
  responseHook = undefined;
  expect((await call(bash("echo after-team-close"))).isError).not.toBe(true);
  expect(
    requested
      .at(-1)
      .data.previousDenials.every((denial: any) => denial.technicalStage !== "team coordination"),
  ).toBe(true);
});

test("portable action schema accepts encoded objects but strict review receives their unchanged contents", async () => {
  expect(actions.approved_action.parameters.type).toBe("object");

  const request = bash("printf encoded-object"),
    encoded = { ...request, arguments: JSON.stringify(request.arguments) };

  expect(Check(actions.approved_action.parameters, encoded)).toBe(true);
  expect((await call(encoded)).isError).not.toBe(true);
  expect(requested[0].data.action.arguments).toEqual(request.arguments);
  expect(executedRequests[0].arguments).toEqual(request.arguments);
  expect(encoded.arguments).toBe(JSON.stringify(request.arguments));
});

test("encoded arguments cannot weaken tool-specific validation or skip a denial", async () => {
  for (const argumentsValue of [
    "printf unreviewed",
    "null",
    "[]",
    "42",
    JSON.stringify({ path: "wrong-tool" }),
  ]) {
    expect((await call({ ...bash("unused"), arguments: argumentsValue })).isError).toBe(true);
  }

  expect(requested).toEqual([]);
  expect(executedRequests).toEqual([]);
  mode = "deny";
  expect(
    (
      await call({
        ...bash("printf denied"),
        arguments: JSON.stringify({ command: "printf denied" }),
      })
    ).isError,
  ).toBe(true);
  expect(requested).toHaveLength(1);
  expect(executedRequests).toEqual([]);
});

test("relocated gate infrastructure stays protected with an alternate agent directory", async () => {
  const shared = resolve(import.meta.dir, "../../shared/review/protocol.ts");
  const alias = join(root, "shared-gate-alias");

  await symlink(resolve(import.meta.dir, "../../shared"), alias);

  try {
    for (const path of [
      shared,
      join(alias, "review/new-gate.ts"),
      resolve(import.meta.dir, "../../remote/ssh.ts"),
    ]) {
      const result = await call({
        tool: "write",
        arguments: { path, content: "Unreviewed gate replacement" },
        goal: "Test protection of relocated gate infrastructure",
        justification: "Verify that an alternate agent directory cannot expose the gate",
      });

      expect(result.isError).toBe(true);
      expect(result.details.technicalStage).toBe("protected path validation");
      expect(result.details.reason).toContain("use sandbox.maintenance");
    }

    expect(requested).toEqual([]);
    expect(executedRequests).toEqual([]);
  } finally {
    await rm(alias);
  }
});

test("action reviews capture the active operator goal once and retain it in the audit", async () => {
  const services = sessionServices(ctx);
  const previous = services.operatorGoal;
  let reads = 0;

  services.operatorGoal = () => {
    reads++;

    return "Complete Flutter/Webapp UI and workflow parity";
  };

  try {
    const result = await call(bash("printf harmless"));

    expect(result.isError).not.toBe(true);
    expect(reads).toBe(1);
    expect(requested[0].data.operatorGoal).toBe("Complete Flutter/Webapp UI and workflow parity");
    expect(requested[0].data.taskContext.source).toBe("operator-goal");
    expect(result.details.approval.operatorGoal).toBe(requested[0].data.operatorGoal);
  } finally {
    services.operatorGoal = previous;
  }
});

function remoteFixture() {
  const target = {
    user: "synthetic",
    host: "test.example",
    folder: "project",
    root: "/home/synthetic/project",
    isolation: "confirmed-account" as const,
    knownHosts: "public-host-key",
    confirmation: { source: "operator-ui" as const, reason: "Remote namespaces unavailable" },
  };
  const executed: string[] = [];
  let current = true;

  sessionServices(ctx).remote = {
    target: () => target,
    cleanup: async () => {},
    prepare: (request, _config, actor, readOnly) => {
      expect(actor).toBe("test-session");
      expect(readOnly).toBe(false);

      return {
        target,
        plan: { backend: "ssh", remote: target, requested: request.sandbox ?? {} },
        assertCurrent: () => {
          if (!current) throw new Error("Remote target changed");
        },
        execute: async () => {
          expect(
            entries.some(
              (entry) =>
                entry.customType === "auto-approval-review" && entry.data.decision === "approve",
            ),
          ).toBe(true);
          executed.push(request.tool);

          return { content: [{ type: "text", text: "Remote result" }], details: {} };
        },
      };
    },
  };

  return {
    target,
    executed,
    invalidate: () => {
      current = false;
    },
  };
}

test("remote actions keep exact review and persisted verdict ahead of dispatch", async () => {
  const remote = remoteFixture();
  const result = await call({
    tool: "read",
    arguments: { path: "README.md" },
    goal: "Smoke test",
    justification: "Read remote project metadata",
  });

  expect(result.isError).not.toBe(true);
  expect(remote.executed).toEqual(["read"]);
  expect(executedRequests).toEqual([]);
  expect(requested[0].data.sandboxPlan).toMatchObject({ backend: "ssh", remote: remote.target });
  expect(result.details.approval.cwd).toBe("ssh://synthetic@test.example/home/synthetic/project");
});

test("remote denial, failed verdict persistence and changed target cannot dispatch", async () => {
  const remote = remoteFixture();

  mode = "deny";
  expect((await call(bash("printf remote"))).isError).toBe(true);
  expect(remote.executed).toEqual([]);
  mode = "approve";
  auditFails = true;
  expect((await call(bash("printf remote"))).isError).toBe(true);
  expect(remote.executed).toEqual([]);
  auditFails = false;
  responseHook = remote.invalidate;
  expect((await call(bash("printf remote"))).isError).toBe(true);
  expect(remote.executed).toEqual([]);
});

test("web requests stay local and remote credential project mounts are rejected", async () => {
  const remote = remoteFixture();
  const search = await call({
    tool: "websearch",
    arguments: { query: "public documentation" },
    goal: "Smoke test",
    justification: "Read public documentation",
  });

  expect(search.isError).not.toBe(true);
  expect(remote.executed).toEqual([]);
  expect(executedRequests.at(-1).tool).toBe("websearch");

  const auth = await call({
    tool: "credential_exec",
    arguments: { profile: "github", argv: ["status"] },
    goal: "Smoke test",
    justification: "Remote project mount must not be mapped locally",
    sandbox: { projectFiles: "read" },
  });

  expect(auth.isError).toBe(true);
  expect(JSON.stringify(auth)).toContain("remote project files");
});

test("a saved remote target with no live extension cannot fall back to local execution", async () => {
  sessionServices(ctx).remote = undefined;
  entries.push({
    type: "custom",
    customType: "remote-workspace",
    data: { host: "remote.example" },
  });

  const blocked = await call(bash("printf must-not-run-locally"));

  expect(blocked.isError).toBe(true);
  expect(JSON.stringify(blocked)).toContain("local fallback is blocked");
  expect(requested).toEqual([]);
  expect(executedRequests).toEqual([]);
  entries.push({ type: "custom", customType: "remote-workspace", data: null });
  expect((await call(bash("printf local-again"))).isError).not.toBe(true);
  expect(executedRequests).toHaveLength(1);
});

function containerFixture() {
  let current = true;
  const executed: unknown[] = [];

  sessionServices(ctx).containers = {
    async prepare(request, workspace) {
      return {
        plan: {
          backend: "lubox-engine",
          commands: request.arguments.commands,
          grants: workspace.bindings,
        },
        async assertCurrent() {
          if (!current) throw new Error("Engine helper changed");
        },
        async execute() {
          expect(
            entries.some(
              (entry) =>
                entry.customType === "auto-approval-review" && entry.data.decision === "approve",
            ),
          ).toBe(true);
          executed.push(request.arguments);

          return {
            content: [{ type: "text", text: "Synthetic container result" }],
            details: { exitCode: 0 },
          };
        },
      };
    },
  };

  return {
    executed,
    invalidate: () => {
      current = false;
    },
  };
}

const containerAction = () => ({
  tool: "container_exec",
  arguments: { argv: ["run", "sdk:cached", "true"] },
  goal: "Verify the project",
  justification: "Run the bounded application test container",
  sandbox: { projectFiles: "read", network: "none", limits: { memoryMiB: 512, cpus: 1, pids: 64 } },
});

test("container workload limits reach engine review without requiring local cgroup delegation", async () => {
  await configureGitFixture();

  const fixture = containerFixture();
  const result = await call(containerAction());

  expect(result.isError).not.toBe(true);
  expect(fixture.executed).toHaveLength(1);
  expect(executedRequests).toEqual([]);
  expect(validatedScopes.at(-1).limits).toBeUndefined();
  expect(requested[0].data.action.sandbox.limits).toEqual({ memoryMiB: 512, cpus: 1, pids: 64 });
  expect(requested[0].data.sandboxPlan.backend).toBe("lubox-engine");
  expect(result.details.approval.backend).toBe("lubox-engine");
});

test("container denial, audit failure and source change cannot dispatch to the engine", async () => {
  await configureGitFixture();

  const fixture = containerFixture();

  mode = "deny";
  expect((await call(containerAction())).isError).toBe(true);
  mode = "approve";
  auditFails = true;
  expect((await call(containerAction())).isError).toBe(true);
  auditFails = false;
  responseHook = fixture.invalidate;
  expect((await call(containerAction())).isError).toBe(true);
  expect(fixture.executed).toEqual([]);
  expect(executedRequests).toEqual([]);
});

test("review-only subagents and remote file grants cannot use the local engine", async () => {
  await configureGitFixture();

  const fixture = containerFixture();

  sessionServices(ctx).delegationMode = "review";
  expect((await call(containerAction())).isError).toBe(true);
  sessionServices(ctx).delegationMode = undefined;
  remoteFixture();
  expect((await call(containerAction())).isError).toBe(true);
  expect(fixture.executed).toEqual([]);
  expect(requested).toEqual([]);
});

test("Pi maintenance denial or failed audit cannot mutate public configuration", async () => {
  const path = join(agentRoot, "settings.json");

  await writeFile(path, "{}");

  const request = {
    tool: "write",
    arguments: { path, content: '{"editorPadding":2}' },
    goal: "Maintain the explicitly requested Pi setup",
    justification: "Change only the requested public setting",
    sandbox: { maintenance: true, paths: [{ path, access: "write" }] },
  };

  mode = "deny";
  expect((await call(request)).isError).toBe(true);
  expect(await readFile(path, "utf8")).toBe("{}");
  expect(requested[0].data.sandboxPlan.maintenance).toMatchObject({
    credentials: false,
    scope: request.sandbox.paths,
  });
  mode = "approve";
  auditFails = true;
  expect((await call(request)).isError).toBe(true);
  expect(await readFile(path, "utf8")).toBe("{}");
  expect(executedRequests).toEqual([]);
});

test("a maintenance flag cannot grant private session data or credential access", async () => {
  const path = join(agentRoot, "auth.json");
  const result = await call({
    tool: "read",
    arguments: { path },
    goal: "Test",
    justification: "A flag alone must not expose login data",
    sandbox: { maintenance: true, paths: [{ path, access: "read" }] },
  });

  expect(result.isError).toBe(true);
  expect(requested).toEqual([]);
  expect(executedRequests).toEqual([]);
});

test("missing-path creation requests remain unexecuted when review or audit fails", async () => {
  const path = join(root, "not-created-before-approval");
  const request = {
    tool: "write",
    arguments: { path, content: "approved contents" },
    goal: "Create the requested file",
    justification: "Creation is part of this one reviewed action",
    sandbox: { paths: [{ path, access: "write", create: "file" }] },
  };

  mode = "deny";
  expect((await call(request)).isError).toBe(true);
  await expect(access(path)).rejects.toThrow();
  mode = "approve";
  auditFails = true;
  expect((await call(request)).isError).toBe(true);
  await expect(access(path)).rejects.toThrow();
  expect(executedRequests).toEqual([]);
});

test("approved Pi extension maintenance executes after persisted review and keeps subsequent actions gated", async () => {
  const path = join(agentRoot, "extensions/maintenance-fixture/index.ts");

  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, "export const value = 1;\n");

  const result = await call({
    tool: "write",
    arguments: { path, content: "export const value = 2;\n" },
    goal: "Implement the requested Pi extension change",
    justification: "Narrow source maintenance without login or runtime access",
    sandbox: { maintenance: true, paths: [{ path, access: "write" }] },
  });

  expect(result.isError).not.toBe(true);
  expect(await readFile(path, "utf8")).toContain("value = 2");
  expect(
    entries.some(
      (entry) => entry.customType === "auto-approval-review" && entry.data.decision === "approve",
    ),
  ).toBe(true);
  expect(requested[0].data.sandboxPlan.maintenance.activation).toContain("restart Pi");

  const count = executedRequests.length;

  mode = "deny";
  expect((await call(bash("printf still-gated"))).isError).toBe(true);
  expect(executedRequests).toHaveLength(count);
});

function supervised() {
  const notifications: any[] = [];
  const manager = new JobManager({
    started: (job) =>
      entries.push({ type: "custom", customType: "auto-approval-job-start", data: job }),
    completed: (job, result) =>
      entries.push({
        type: "custom",
        customType: "auto-approval-job-result",
        data: {
          job,
          message: {
            role: "toolResult",
            toolName: "approved_action",
            toolCallId: job.toolCallId,
            ...result,
          },
        },
      }),
    notify: (job, result) => {
      notifications.push({ job, result });
    },
    changed() {},
    error(error) {
      throw error;
    },
  });

  sessionServices(ctx).jobs = manager;

  return { manager, notifications };
}

test("background review admits once, frees the action queue and holds its lease until cleanup", async () => {
  const { manager } = supervised();
  let started!: () => void, release!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const leases: { released: boolean }[] = [];

  sessionServices(ctx).acquireActionLease = () => {
    const lease = { released: false };

    leases.push(lease);

    return {
      assertCurrent() {},
      release() {
        expect(lease.released).toBe(false);
        lease.released = true;
      },
    };
  };

  let jobSignal: AbortSignal | undefined;

  executionGate = async (request, signal) => {
    if (request.background) {
      jobSignal = signal;
      started();
      await gate;
    }
  };

  const controller = new AbortController();
  const original = {
    ...bash("printf completed-background"),
    background: { title: "Tests", work: "Inspect the independent documentation" },
  };
  const admitted: any = await actions.approved_action.execute(
    "background",
    original,
    controller.signal,
    undefined,
    ctx,
  );

  await began;
  expect(admitted.isError).not.toBe(true);
  expect(admitted.details.result).toBeUndefined();
  expect(reviewedReceipts(entries)).toHaveLength(0);
  expect(requested[0].data.action.background).toEqual(original.background);
  expect(requested[0].data.action.sandbox.limits.maxOutputBytes).toBe(65536);
  expect(leases[0].released).toBe(false);
  controller.abort();
  expect(jobSignal?.aborted).toBe(false);

  const other: any = await actions.approved_action.execute(
    "independent",
    bash("printf independent-work"),
    undefined,
    undefined,
    ctx,
  );

  expect(other.isError).not.toBe(true);
  expect(JSON.stringify(other.content)).toContain("independent-work");
  expect(leases.map((lease) => lease.released)).toEqual([false, true]);
  release();

  const finished = await manager.wait(admitted.details.backgroundJob.id);

  expect(finished[0].job.state).toBe("succeeded");
  expect(leases.map((lease) => lease.released)).toEqual([true, true]);
  expect(reviewedReceipts(entries).at(-1)?.content).toEqual([
    { type: "text", text: "completed-background" },
  ]);
});

test("background denial, invalid tool or missing supervisor cannot start execution", async () => {
  const request = {
    ...bash("printf must-not-run"),
    background: { title: "Tests", work: "Review docs" },
  };

  expect((await call(request)).isError).toBe(true);
  expect(requested).toHaveLength(0);

  const { manager } = supervised();

  mode = "deny";
  expect((await call(request)).isError).toBe(true);
  expect(manager.list()).toHaveLength(0);
  expect(executedRequests).toHaveLength(0);
  mode = "approve";
  expect((await call({ ...request, tool: "read", arguments: { path: "file" } })).isError).toBe(
    true,
  );
  expect(
    (await call({ ...request, sandbox: { limits: { maxOutputBytes: 268435456 } } })).isError,
  ).toBe(true);
  expect(executedRequests).toHaveLength(0);
});

test("shutdown aborts background work and waits for cleanup before removing private tmp", async () => {
  const { manager, notifications } = supervised();
  let started!: () => void, cleanup!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    cleanup = resolve;
  });

  executionGate = async (_request, signal) => {
    started();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    await released;
    signal?.throwIfAborted();
  };

  const admitted: any = await call({
    ...bash("printf never"),
    background: { title: "Test", work: "Review docs" },
  });

  await began;

  const directory = temporaryStores[0];

  await access(directory);

  let closed = false;
  const closing = hooks.session_shutdown({}, ctx).then(() => {
    closed = true;
  });

  await Promise.resolve();
  expect(closed).toBe(false);
  await access(directory);
  cleanup();
  await closing;
  await expect(access(directory)).rejects.toThrow();
  expect((await manager.wait(admitted.details.backgroundJob.id))[0].job.state).toBe("cancelled");
  expect(notifications).toHaveLength(0);
});

test("operator-enabled CIP controls skip review while project commands still require it", async () => {
  const operations: unknown[] = [];
  let enabled = true;
  const target: any = {
    user: "synthetic",
    host: "cip7b0.cip.cs.fau.de",
    root,
    folder: "project",
    isolation: "bwrap",
    knownHosts: "public key",
    cip: { node: "cip-1", gpu: true, home: "/home/cip/test", tmp: "/proj/ciptmp" },
  };

  sessionServices(ctx).remote = {
    target: () => target,
    cip: {
      active: () => enabled,
      manage: async (args) => {
        operations.push(args);

        return { content: [{ type: "text", text: "pool updated" }], details: {} };
      },
    },
    prepare: async (request) => ({
      target,
      plan: { source: "executor-preflight", request },
      assertCurrent() {},
      execute: async () => {
        throw new Error("Denied remote command must not execute");
      },
    }),
    cleanup: async () => {},
  };
  registerCipTools(extensionPi);

  mode = "deny";

  await hooks.before_agent_start({}, ctx);
  expect(active).toContain("cip_nodes");
  expect(await hooks.tool_call({ toolName: "cip_nodes" }, ctx)).toBeUndefined();

  for (const args of [
    { operation: "acquire", gpuModel: "3070" },
    { operation: "release", node: "cip-2" },
    { operation: "list" },
  ])
    await actions.cip_nodes.execute("direct", args, undefined, undefined, ctx);

  expect(operations).toHaveLength(3);
  expect(requested).toHaveLength(0);
  expect((await call(bash("python train.py"))).isError).toBe(true);
  expect(requested).toHaveLength(1);
  expect(executedRequests).toHaveLength(0);
  expect(
    (await call({ ...bash("unused"), tool: "cip_nodes", arguments: { operation: "acquire" } }))
      .isError,
  ).toBe(true);
  expect(operations).toHaveLength(3);

  enabled = false;

  await hooks.before_agent_start({}, ctx);
  expect(active).not.toContain("cip_nodes");
  expect(await hooks.tool_call({ toolName: "cip_nodes" }, ctx)).toMatchObject({ block: true });
  await expect(
    actions.cip_nodes.execute("direct", { operation: "acquire" }, undefined, undefined, ctx),
  ).rejects.toThrow("Enable /cip");
  expect(operations).toHaveLength(3);
});
