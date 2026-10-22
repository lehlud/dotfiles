import { writeConfigFixture } from "./config-fixture.ts";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import autoApproval from "../index.ts";
import subagents from "../../subagents/index.ts";
import { registerOperatorInputs } from "../../conversations/operator-input.ts";
import { sessionServices } from "../../shared/session/services.ts";
import { reviewedReceipts } from "../../shared/review/receipts.ts";

const native = process.platform === "linux" && Bun.which("bwrap") ? test : test.skip;
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 4000; i++) {
    if (await check()) return;

    await new Promise((resolve) => setTimeout(resolve, 3));
  }

  throw new Error("Subagent fixture did not settle");
}

async function fixture(route: { provider?: string; api?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-sdk-"));
  const agentDir = join(directory, "agent"),
    project = join(directory, "project"),
    runner = join(directory, "runner");

  await mkdir(agentDir);
  await mkdir(project);
  await writeFile(join(project, "sample.txt"), "review evidence\n");

  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      resolve(import.meta.dir, "../runner.ts"),
      "--outfile",
      runner,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (build.exitCode) throw new Error(build.stderr.toString());

  await writeConfigFixture(
    join(agentDir, "auto-approval.json"),
    JSON.stringify({
      reviewer: { provider: "subagent-sdk-fixture", model: "review", thinking: "off" },
      recentUserPrompts: 10,
      requestTimeoutMs: 5000,
      sandbox: { backend: "bwrap" },
    }),
  );
  await writeFile(
    join(agentDir, "auto-approval.device.json"),
    JSON.stringify({ sandbox: { executable: Bun.which("bwrap"), runnerExecutable: runner } }),
  );

  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = agentDir;

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  const contexts: any[] = [],
    requests: any[] = [],
    reviews: any[] = [],
    actions = new Map<string, number>();

  const definition: Parameters<typeof runtime.registerProvider>[1] = {
    api: route.api ?? "subagent-sdk-fixture",
    apiKey: "synthetic",
    baseUrl:
      route.provider === "openai"
        ? "https://api.openai.com/v1"
        : route.provider === "openai-codex"
          ? "https://chatgpt.com/backend-api/codex"
          : "https://example.invalid",
    models: ["working", "review"].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      contextWindow: 131072,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();

      queueMicrotask(async () => {
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          stopReason: "stop",
          timestamp: Date.now(),
          usage,
        };

        try {
          if (model.id === "review") {
            const data = JSON.parse(
              String(context.messages.find((entry) => entry.role === "user")?.content),
            );

            reviews.push(data);
            message.content = [
              {
                type: "text",
                text: JSON.stringify({
                  requestId: data.requestId,
                  decision: "approve",
                  reason: "Synthetic task-scoped safety verdict",
                }),
              },
            ];
          } else {
            const body = {
              model: model.id,
              prompt_cache_key: options?.sessionId,
              input: structuredClone(context.messages),
              tools: getCurrentTools(context.messages),
            };
            const payload = (await options?.onPayload?.(body, model)) ?? body;

            requests.push({ sessionId: options?.sessionId, payload });

            const name = getCurrentSystemPrompt(context.messages).match(
              /You are subagent ([a-z]+)/u,
            )?.[1];

            if (name) {
              contexts.push({
                name,
                context: structuredClone(context),
                sessionId: options?.sessionId,
                tools: getCurrentTools(context.messages),
                payload,
              });

              const serialized = JSON.stringify(context.messages),
                stage = actions.get(name) ?? 0;

              actions.set(name, stage + 1);

              if (
                serialized.includes("HOLD-REQUEST") &&
                !serialized.includes("RESURRECT-REQUEST")
              ) {
                await new Promise<void>((done) => {
                  if (options?.signal?.aborted) done();
                  else options?.signal?.addEventListener("abort", () => done(), { once: true });
                });
              }

              if (stage === 0 && !serialized.includes("HOLD-REQUEST")) {
                message.stopReason = "toolUse";
                message.content = [
                  {
                    type: "toolCall",
                    id: `${name}-mail`,
                    name: "parent_mailbox",
                    arguments: { text: "ACTIONABLE-FINDING" },
                  },
                ];
              } else if (stage === 1 && !serialized.includes("HOLD-REQUEST")) {
                message.stopReason = "toolUse";
                message.content = [
                  {
                    type: "toolCall",
                    id: `${name}-read`,
                    name: "approved_action",
                    arguments: {
                      tool: serialized.includes("LONG-WORK")
                        ? "bash"
                        : serialized.includes("MUTATION-REQUEST")
                          ? "write"
                          : serialized.includes("TMP-WORK")
                            ? "bash"
                            : "read",
                      arguments: serialized.includes("LONG-WORK")
                        ? {
                            command:
                              "printf ready > running-marker; sleep 2; printf late > late-marker",
                            timeout: 5,
                          }
                        : serialized.includes("MUTATION-REQUEST")
                          ? { path: `${name}.txt`, content: "Approved worker change\n" }
                          : serialized.includes("TMP-WORK")
                            ? {
                                command: "printf saved > /tmp/subagent-marker; printf created",
                                timeout: 5,
                              }
                            : { path: "sample.txt" },
                      goal: "Inspect the operator-authorized project",
                      justification: "Independent review of the existing source",
                    },
                  },
                ];
              } else if (stage === 3 && serialized.includes("TMP-CHECK")) {
                message.stopReason = "toolUse";
                message.content = [
                  {
                    type: "toolCall",
                    id: `${name}-tmp-resume`,
                    name: "approved_action",
                    arguments: {
                      tool: "bash",
                      arguments: {
                        command: "test ! -e /tmp/subagent-marker && printf fresh-tmp",
                        timeout: 5,
                      },
                      goal: "Verify fresh temporary storage after resurrection",
                      justification: "Check that the previous private session state was discarded",
                    },
                  },
                ];
              } else
                message.content = [
                  {
                    type: "text",
                    text: "Independent report: sample.txt contains the expected review evidence.",
                  },
                ];
            } else message.content = [{ type: "text", text: "Parent remains available." }];
          }

          if (options?.signal?.aborted) {
            message.stopReason = "aborted";
            stream.push({ type: "error", reason: "aborted", error: message });
          } else stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = "error";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: "error", error: message });
        }
      });

      return stream;
    },
  };

  runtime.registerProvider("subagent-sdk-fixture", definition);

  if (route.provider) runtime.registerProvider(route.provider, definition);

  return createParent({
    directory,
    agentDir,
    project,
    previous,
    runtime,
    contexts,
    reviews,
    requests,
    workerProvider: route.provider ?? "subagent-sdk-fixture",
  });
}

async function createParent(state: any) {
  const tools = new Map<string, any>(),
    notifications: string[] = [];
  let ctx: any, terminal: ((text: string) => unknown) | undefined;
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: state.project,
    agentDir: state.agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: [
      autoApproval,
      (pi) => {
        registerOperatorInputs(pi);

        const original = pi.registerTool.bind(pi);

        pi.registerTool = ((tool: any) => {
          tools.set(tool.name, tool);
          original(tool);
        }) as any;
        subagents(pi);
        pi.on("session_start", (_event, context) => {
          ctx = context;
        });
      },
    ],
  });

  await loader.reload();

  const { session } = await createAgentSession({
    cwd: state.project,
    agentDir: state.agentDir,
    modelRuntime: state.runtime,
    model: new ModelRegistry(state.runtime).find(state.workerProvider, "working")!,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(state.project),
    settingsManager: settings,
    resourceLoader: loader,
    tools: ["approved_action", "subagent"],
  });

  await session.bindExtensions({
    mode: "tui",
    uiContext: {
      setStatus() {},
      setWidget() {},
      notify: (text: string) => notifications.push(text),
      onTerminalInput: (callback: any) => {
        terminal = callback;

        return () => {
          terminal = undefined;
        };
      },
    } as any,
  });
  await session.prompt(
    "ACTUAL-OPERATOR: inspect sample.txt and review implementation; authorized edits stay within this project.",
  );

  return {
    ...state,
    session,
    tools,
    notifications,
    ctx: () => ctx,
    key: (text: string) => terminal?.(text),
    invoke: async (args: any) =>
      tools.get("subagent").execute("parent-call", args, undefined, undefined, ctx),
    async close() {
      await sessionServices(ctx).stopSubagents?.();
      await session.abort();
      session.dispose();

      if (state.previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = state.previous;

      await rm(state.directory, { recursive: true, force: true });
    },
  };
}

native.each([
  ["openai", "openai-responses"],
  ["openai-codex", "openai-codex-responses"],
])(
  "%s parent and subagent requests share a cache key without sharing session identity, including reload/resurrection",
  async (provider, api) => {
    const state = await fixture({ provider, api });

    try {
      const parentId = state.session.sessionId;
      const rootRequest = state.requests[0];

      const userContext = JSON.stringify(
        rootRequest.payload.input.filter((entry: any) => entry.role === "user"),
      );

      expect(userContext.split("Work alone by default.").length - 1).toBe(1);
      expect(userContext).toContain("explicitly requests subagents");
      expect(JSON.stringify(state.session.sessionManager.getBranch())).not.toContain(
        "subagent-usage-instruction",
      );

      const job = (await state.invoke({ operation: "spawn", task: "CACHE-REVIEW" })).details;

      await until(
        async () =>
          (await state.invoke({ operation: "status", id: job.id })).details.state === "idle",
      );
      await until(() => !state.session.isStreaming);

      const child = state.contexts.find((item: any) => item.name === job.name);

      expect(rootRequest.payload.prompt_cache_key).toBe(parentId);
      expect(child.payload.prompt_cache_key).toBe(parentId);
      expect(child.sessionId).not.toBe(parentId);
      // Instructions survive the fork; capability declarations deliberately differ.
      expect(getSystemMessageText(child.payload.input[0])).toBe(
        getSystemMessageText(rootRequest.payload.input[0]),
      );
      expect(child.payload.tools).not.toEqual(rootRequest.payload.tools);
      expect(child.payload.tools.find((tool: any) => tool.name === "approved_action")).toEqual(
        rootRequest.payload.tools.find((tool: any) => tool.name === "approved_action"),
      );
      expect(child.tools.some((tool: any) => ["subagent", "mailbox"].includes(tool.name))).toBe(
        false,
      );
      expect(state.reviews.length).toBeGreaterThan(0);
      await state.session.reload();
      await state.invoke({ operation: "resurrect", id: job.id, text: "CONTINUE-CACHE-REVIEW" });
      await until(
        async () =>
          (await state.invoke({ operation: "status", id: job.id })).details.state === "idle",
      );

      const reopened = state.contexts.filter((item: any) => item.name === job.name).at(-1);

      expect(reopened.sessionId).toBe(child.sessionId);
      expect(reopened.payload.prompt_cache_key).toBe(parentId);
    } finally {
      await state.close();
    }
  },
);

native("subagents replace inherited goal controls with the parent's current state", async () => {
  const state = await fixture();
  let current: string | undefined = "GOAL-ONLY-WHILE-ACTIVE";

  try {
    sessionServices(state.ctx()).goalInstruction = () => current;
    state.session.sessionManager.appendCustomMessageEntry(
      "auto-approval-goal-instruction",
      current,
      false,
    );

    const job = (await state.invoke({ operation: "spawn", task: "REVIEW-GOAL-CONTEXT" })).details;

    await until(
      async () =>
        (await state.invoke({ operation: "status", id: job.id })).details.state === "idle",
    );
    await until(() => !state.session.isStreaming);

    const first = state.contexts.filter((item: any) => item.name === job.name);

    expect(JSON.stringify(first.at(-1).context)).toContain(current);

    current = undefined;
    await state.invoke({ operation: "send", id: job.id, text: "FOLLOWUP-WITHOUT-GOAL" });
    await until(
      () => state.contexts.filter((item: any) => item.name === job.name).length > first.length,
    );
    await until(
      async () =>
        (await state.invoke({ operation: "status", id: job.id })).details.state === "idle",
    );

    const last = state.contexts.filter((item: any) => item.name === job.name).at(-1);

    expect(JSON.stringify(last.context)).not.toContain("GOAL-ONLY-WHILE-ACTIVE");
    expect(JSON.stringify(last.context)).toContain("ACTUAL-OPERATOR");
    expect(JSON.stringify(last.context)).toContain("FOLLOWUP-WITHOUT-GOAL");
  } finally {
    await state.close();
  }
});

native(
  "work writes need their own approval; review mutations fail before paid review",
  async () => {
    const state = await fixture();

    try {
      const review = (
        await state.invoke({ operation: "spawn", task: "MUTATION-REQUEST review", mode: "review" })
      ).details;
      const work = (
        await state.invoke({ operation: "spawn", task: "MUTATION-REQUEST work", mode: "work" })
      ).details;

      await until(async () =>
        (await state.invoke({ operation: "list" })).details.every(
          (job: any) => job.state === "idle",
        ),
      );
      expect(state.reviews).toHaveLength(1);
      expect(state.reviews[0].action.tool).toBe("write");
      expect(await readFile(join(state.project, `${work.name}.txt`), "utf8")).toBe(
        "Approved worker change\n",
      );
      expect(
        await readFile(join(state.project, `${review.name}.txt`), "utf8").catch(() => "absent"),
      ).toBe("absent");

      const mailbox = state.contexts[0].tools.find((tool: any) => tool.name === "parent_mailbox");

      expect(Check(mailbox.parameters, { text: "Forged", from: "other", to: "*" })).toBe(false);
    } finally {
      await state.close();
    }
  },
  30000,
);

native(
  "resurrection keeps conversation identity but creates fresh private temporary storage",
  async () => {
    const state = await fixture();

    try {
      const job = (await state.invoke({ operation: "spawn", task: "TMP-WORK", mode: "work" }))
        .details;

      await until(
        async () =>
          (await state.invoke({ operation: "status", id: job.id })).details.state === "idle",
      );
      await state.invoke({ operation: "kill", id: job.id });
      await state.invoke({ operation: "resurrect", id: job.id, text: "TMP-CHECK" });
      await until(
        async () =>
          (await state.invoke({ operation: "status", id: job.id })).details.state === "idle",
      );
      expect(state.reviews).toHaveLength(2);
      expect(JSON.stringify(state.session.sessionManager.getBranch())).toContain("fresh-tmp");
    } finally {
      await state.close();
    }
  },
  30000,
);

native(
  "live-agent limits and killing a starting session cannot admit a late child run",
  async () => {
    const state = await fixture();

    try {
      const early = (await state.invoke({ operation: "spawn", task: "HOLD-REQUEST early" }))
        .details;

      await state.invoke({ operation: "kill", id: early.id });
      expect(state.contexts.some((item: any) => item.name === early.name)).toBe(false);
      await state.invoke({ operation: "resurrect", id: early.id, text: "RESURRECT-REQUEST" });
      await until(
        async () =>
          (await state.invoke({ operation: "status", id: early.id })).details.state === "idle",
      );
      await state.invoke({ operation: "kill", id: early.id });

      for (let i = 0; i < 4; i++)
        await state.invoke({ operation: "spawn", task: `HOLD-REQUEST ${i}` });

      await expect(state.invoke({ operation: "spawn", task: "excess" })).rejects.toThrow(
        "four live",
      );
    } finally {
      await state.close();
    }
  },
  30000,
);

native(
  "extension reload stops children and allows explicit resurrection from the private checkpoint",
  async () => {
    const state = await fixture();

    try {
      const job = (await state.invoke({ operation: "spawn", task: "REVIEW-RELOAD" })).details;

      await until(
        async () =>
          (await state.invoke({ operation: "status", id: job.id })).details.state === "idle",
      );
      await until(() => !state.session.isStreaming);

      const identity = state.contexts.find((item: any) => item.name === job.name).sessionId;

      await state.session.reload();
      expect((await state.invoke({ operation: "status", id: job.id })).details.state).toBe(
        "killed",
      );
      await state.invoke({ operation: "resurrect", id: job.id, text: "RELOADED-CHECKPOINT" });
      await until(
        async () =>
          (await state.invoke({ operation: "status", id: job.id })).details.state === "idle",
      );
      expect(state.contexts.filter((item: any) => item.name === job.name).at(-1).sessionId).toBe(
        identity,
      );
      await expect(
        state.invoke({ operation: "resurrect", id: "00000000-0000-0000-0000-000000000000" }),
      ).rejects.toThrow("Unknown subagent");
    } finally {
      await state.close();
    }
  },
  30000,
);

native(
  "a bounded child lifetime expires without automatic resurrection",
  async () => {
    const state = await fixture();

    try {
      const job = (
        await state.invoke({ operation: "spawn", task: "HOLD-REQUEST timeout", timeoutSeconds: 10 })
      ).details;

      await until(
        async () =>
          (await state.invoke({ operation: "status", id: job.id })).details.state === "timed-out",
      );
      await sessionServices(state.ctx()).stopSubagents?.();
      expect(state.contexts.filter((item: any) => item.name === job.name)).toHaveLength(1);
    } finally {
      await state.close();
    }
  },
  30000,
);

native(
  "delegated actions retain the parent coordination lease instead of bypassing it",
  async () => {
    const state = await fixture();
    let admitted = false,
      released = 0;

    try {
      sessionServices(state.ctx()).mailbox = {
        name: "owning-member",
        active: () => true,
        audit() {},
        beginAction() {
          if (!admitted) throw new Error("Waiting for the existing coordinated plan");

          return {
            assertCurrent() {
              if (!admitted) throw new Error("Plan changed");
            },
            release() {
              released++;
            },
          };
        },
      };

      const blocked = (await state.invoke({ operation: "spawn", task: "READ-BEFORE-PLAN" }))
        .details;

      await until(
        async () =>
          (await state.invoke({ operation: "status", id: blocked.id })).details.state === "idle",
      );
      expect(state.reviews).toHaveLength(0);
      admitted = true;

      const allowed = (await state.invoke({ operation: "spawn", task: "READ-AFTER-PLAN" })).details;

      await until(
        async () =>
          (await state.invoke({ operation: "status", id: allowed.id })).details.state === "idle",
      );
      expect(state.reviews).toHaveLength(1);
      expect(released).toBe(1);
      expect(state.reviews[0].sandboxPlan.teamAssignment).toBeUndefined();
      expect(state.reviews[0].runtimeContext).toBeUndefined();
    } finally {
      sessionServices(state.ctx()).mailbox = undefined;
      await state.close();
    }
  },
  30000,
);

native(
  "interrupt cancels a child's approved native process before it can write later output",
  async () => {
    const state = await fixture();

    try {
      const job = (await state.invoke({ operation: "spawn", task: "LONG-WORK", mode: "work" }))
        .details;

      await until(async () =>
        readFile(join(state.project, "running-marker"), "utf8").then(
          () => true,
          () => false,
        ),
      );
      state.key("\x1b");
      await sessionServices(state.ctx()).stopSubagents?.();
      expect((await state.invoke({ operation: "status", id: job.id })).details.state).toBe(
        "killed",
      );
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(await readFile(join(state.project, "late-marker"), "utf8").catch(() => "absent")).toBe(
        "absent",
      );
    } finally {
      await state.close();
    }
  },
  30000,
);

native(
  "parallel SDK subagents use authenticated parent-only mail, independent approval and read-only review mounts",
  async () => {
    const state = await fixture();

    try {
      const [one, two] = await Promise.all([
        state.invoke({ operation: "spawn", task: "REVIEW-ONE" }),
        state.invoke({ operation: "spawn", task: "REVIEW-TWO" }),
      ]);

      await until(async () =>
        (await state.invoke({ operation: "list" })).details.every(
          (job: any) => job.state === "idle",
        ),
      );
      expect(one.details.id).not.toBe(two.details.id);
      expect(state.reviews).toHaveLength(2);
      expect(
        state.reviews.every((review: any) =>
          review.userPrompts.every(
            (text: string) => !text.includes("REVIEW-ONE") && !text.includes("REVIEW-TWO"),
          ),
        ),
      ).toBe(true);
      expect(
        state.reviews.every((review: any) =>
          review.sandboxPlan.readOnlyBindings.includes(state.project),
        ),
      ).toBe(true);
      expect(
        state.contexts.every(
          (item: any) =>
            !item.tools.some((tool: any) => ["subagent", "mailbox", "bash"].includes(tool.name)),
        ),
      ).toBe(true);
      expect(reviewedReceipts(state.session.sessionManager.getBranch())).toHaveLength(2);
      expect(JSON.stringify(state.session.sessionManager.getBranch())).toContain(
        "ACTIONABLE-FINDING",
      );
      await until(() => !state.session.isStreaming);
      await state.session.prompt(`/subagents log ${one.details.name}`);
      expect(state.notifications.at(-1)).toContain("ACTIONABLE-FINDING");
      expect(state.notifications.at(-1)).toContain("review evidence");
      expect(state.notifications.at(-1)).not.toContain(two.details.name);

      const params = state.tools.get("subagent").parameters;

      expect(
        Check(params, { operation: "send", id: one.details.id, text: "message", from: "forged" }),
      ).toBe(false);
      await state.invoke({ operation: "send", id: one.details.id, text: "FOLLOWUP-ONLY-ONE" });
      await until(() =>
        state.contexts.some(
          (item: any) =>
            item.name === one.details.name &&
            JSON.stringify(item.context).includes("FOLLOWUP-ONLY-ONE"),
        ),
      );
      expect(
        state.contexts
          .filter((item: any) => item.name === two.details.name)
          .every((item: any) => !JSON.stringify(item.context).includes("FOLLOWUP-ONLY-ONE")),
      ).toBe(true);
      expect(await readFile(join(state.project, "sample.txt"), "utf8")).toBe("review evidence\n");
    } finally {
      await state.close();
    }
  },
  30000,
);

native(
  "Escape kills every running SDK child; explicit resurrection preserves ID, history and new operator constraints",
  async () => {
    const state = await fixture();

    try {
      const one = (await state.invoke({ operation: "spawn", task: "HOLD-REQUEST one" })).details;
      const two = (await state.invoke({ operation: "spawn", task: "HOLD-REQUEST two" })).details;

      await until(() => state.contexts.length >= 2);

      const before = state.contexts.find((item: any) => item.name === one.name).sessionId;

      expect(typeof before).toBe("string");

      state.key("\x1b");
      await until(async () =>
        (await state.invoke({ operation: "list" })).details.every(
          (job: any) => job.state === "killed",
        ),
      );
      await sessionServices(state.ctx()).stopSubagents?.();

      const count = state.contexts.length;

      await state.session.prompt("ACTUAL-NEW-CONSTRAINT: keep all files unchanged.");
      expect(state.contexts).toHaveLength(count);
      await state.invoke({
        operation: "resurrect",
        id: one.id,
        text: "RESURRECT-REQUEST continue",
      });
      await until(
        async () =>
          (await state.invoke({ operation: "status", id: one.id })).details.state === "idle",
      );

      const resumed = state.contexts.filter((item: any) => item.name === one.name).at(-1);

      expect(resumed.sessionId).toBe(before);
      expect(JSON.stringify(resumed.context)).toContain("ACTUAL-NEW-CONSTRAINT");
      expect((await state.invoke({ operation: "status", id: two.id })).details.state).toBe(
        "killed",
      );

      const saved = await readdir(join(state.agentDir, "subagents"));

      expect(saved.length).toBe(1);
    } finally {
      await state.close();
    }
  },
  30000,
);

native(
  "Ctrl+C cancels idle and running children without respawning them",
  async () => {
    const state = await fixture();

    try {
      const idle = (await state.invoke({ operation: "spawn", task: "REVIEW-IDLE" })).details;

      await until(
        async () =>
          (await state.invoke({ operation: "status", id: idle.id })).details.state === "idle",
      );

      const active = (await state.invoke({ operation: "spawn", task: "HOLD-REQUEST active" }))
        .details;

      await until(() => state.contexts.some((item: any) => item.name === active.name));
      state.key("\x03");
      await sessionServices(state.ctx()).stopSubagents?.();
      expect(
        (await state.invoke({ operation: "list" })).details.every(
          (job: any) => job.state === "killed",
        ),
      ).toBe(true);
    } finally {
      await state.close();
    }
  },
  30000,
);
