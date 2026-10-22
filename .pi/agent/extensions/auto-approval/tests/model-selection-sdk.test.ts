import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerModelSelection } from "../../model-selection/index.ts";
import { ModelState } from "../../shared/configuration/model-state.ts";
import { sessionServices } from "../../shared/session/services.ts";
import fastMode from "../../fast-mode/index.ts";

const resources: { directory: string; sessions: AgentSession[] }[] = [];
const previous = { provider: "openrouter", model: "review-old", thinking: "low" } as const;
const next = { provider: "openrouter", model: "vendor/review-next", thinking: "high" } as const;

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    for (const session of resource.sessions) session.dispose();

    await rm(resource.directory, { recursive: true, force: true });
  }
});

async function fixture(hold = false) {
  const directory = await mkdtemp(join(tmpdir(), "pi-selection-sdk-"));
  const resource = { directory, sessions: [] as AgentSession[] };

  resources.push(resource);

  const state = new ModelState(directory);

  state.saveReviewers([previous]);

  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const requests: any[] = [];
  const notices: string[] = [];
  const firstRequest = Promise.withResolvers<void>();
  const finishResponse = Promise.withResolvers<void>();
  const toolStarted = Promise.withResolvers<void>();
  const finishTool = Promise.withResolvers<void>();
  let toolReviewers: unknown;

  runtime.registerProvider("openrouter", {
    api: "openai-completions",
    apiKey: "synthetic",
    baseUrl: "https://example.invalid",
    models: ["working-old", "working-new", "review-old", "vendor/review-next"].map((id) => ({
      id,
      name: id,
      reasoning: true,
      thinkingLevelMap: { off: null, low: "low", high: "high" },
      input: ["text"],
      contextWindow: 65536,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();

      void (async () => {
        const body = { model: model.id };
        const payload = (await options?.onPayload?.(body, model)) ?? body;
        const number = requests.push({
          model: model.id,
          reasoning: options?.reasoning,
          payload,
          context,
        });

        firstRequest.resolve();

        if (hold && number === 1) await finishResponse.promise;

        const tool = hold && number === 1;
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: tool
            ? [{ type: "toolCall", id: "checkpoint-1", name: "checkpoint", arguments: {} }]
            : [{ type: "text", text: "Done." }],
          stopReason: tool ? "toolUse" : "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };

        stream.push({ type: "done", reason: message.stopReason, message });
      })();

      return stream;
    },
  });

  async function create(
    resume = false,
    select?: (title: string, options: string[]) => Promise<string | undefined>,
  ) {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const manager = SessionManager.inMemory(directory);

    if (resume)
      manager.appendMessage({ role: "user", content: "Existing task.", timestamp: Date.now() });

    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      noPromptTemplates: true,
      extensionFactories: [
        (pi) => registerModelSelection(pi, directory),
        fastMode,
        (pi) =>
          pi.registerTool({
            name: "checkpoint",
            label: "Checkpoint",
            description: "Synthetic held tool, no external effects",
            parameters: Type.Object({}),
            async execute(_id, _args, _signal, _update, ctx) {
              toolReviewers = sessionServices(ctx).activeReviewers?.();
              toolStarted.resolve();
              await finishTool.promise;

              return {
                content: [{ type: "text", text: "Checkpoint passed." }],
                details: undefined,
              };
            },
          }),
      ],
    });

    await loader.reload();

    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model: new ModelRegistry(runtime).find("openrouter", "working-old")!,
      thinkingLevel: "low",
      settingsManager,
      sessionManager: manager,
      resourceLoader: loader,
      tools: ["checkpoint"],
    });

    resource.sessions.push(session);
    await session.bindExtensions({
      mode: select ? "rpc" : "tui",
      uiContext: {
        setFooter() {},
        setStatus() {},
        notify: (text: string) => notices.push(text),
        select,
      } as any,
      onError: (error) => notices.push(error.error),
    });

    return session;
  }

  return {
    directory,
    state,
    runtime,
    create,
    notices,
    requests,
    firstRequest,
    finishResponse,
    toolStarted,
    finishTool,
    toolReviewers: () => toolReviewers,
  };
}

test("real Pi switches main model, thinking, reviewers and speed at the next steering boundary", async () => {
  const app = await fixture(true);
  const session = await app.create(false, async (title, options) =>
    options.find((item) =>
      item.includes(title.startsWith("Approval model") ? "/vendor/review-next" : "high"),
    ),
  );
  const running = session.prompt("Complete the synthetic checkpoint.");

  await app.firstRequest.promise;
  await session.setModel(new ModelRegistry(app.runtime).find("openrouter", "working-new")!);
  session.setThinkingLevel("high");
  await session.prompt("/fast on");
  expect(app.requests[0]).toMatchObject({
    model: "working-old",
    reasoning: "low",
    payload: { model: "working-old" },
  });
  expect(app.state.working()).toEqual({
    provider: "openrouter",
    model: "working-new",
    thinking: "high",
  });
  app.finishResponse.resolve();
  await app.toolStarted.promise;
  expect(app.toolReviewers()).toEqual([previous]);
  await session.prompt("/reviewer");
  expect(app.state.reviewers()).toEqual([next]);
  expect(sessionServices(session).activeReviewers?.()).toEqual([previous]);
  app.finishTool.resolve();
  await running;
  expect(app.requests[1]).toMatchObject({
    model: "working-new",
    reasoning: "high",
    payload: { provider: { sort: "throughput" } },
  });
  expect(sessionServices(session).activeReviewers?.()).toEqual([next]);
  expect(app.notices.some((text) => text.includes("queued for next turn"))).toBe(true);

  const users = session.sessionManager
    .getBranch()
    .filter((entry: any) => entry.type === "message" && entry.message.role === "user");

  expect(JSON.stringify(users)).not.toContain("/reviewer");
  expect(JSON.stringify(users)).not.toContain("/fast");
});

test("real Pi /reviewer asks for known models and thinking without a working-model request", async () => {
  const app = await fixture();
  const prompts: { title: string; options: string[] }[] = [];
  const modelChoice = Promise.withResolvers<string | undefined>();
  const thinkingChoice = Promise.withResolvers<string | undefined>();
  const modelShown = Promise.withResolvers<void>();
  const thinkingShown = Promise.withResolvers<void>();
  const session = await app.create(false, async (title, options) => {
    prompts.push({ title, options });

    if (prompts.length === 1) {
      modelShown.resolve();

      return modelChoice.promise;
    }

    thinkingShown.resolve();

    return thinkingChoice.promise;
  });
  const command = session.prompt("/reviewer");

  await modelShown.promise;
  expect(prompts[0].options).toContain("openrouter/vendor/review-next");
  expect(app.state.reviewers()).toEqual([previous]);
  modelChoice.resolve("openrouter/vendor/review-next");
  await thinkingShown.promise;
  expect(prompts[1].options).toEqual(["✓ low", "high"]);
  expect(app.state.reviewers()).toEqual([previous]);
  thinkingChoice.resolve("high");
  await command;
  expect(app.state.reviewers()).toEqual([next]);
  expect(session.model?.id).toBe("working-old");
  expect(session.thinkingLevel).toBe("low");
  expect(app.requests).toHaveLength(0);
  expect(
    session.sessionManager.getBranch().filter((entry: any) => entry.type === "message"),
  ).toHaveLength(0);
});

test("new Pi sessions restore the last pair and reviewer chain while resume keeps its own pair", async () => {
  const app = await fixture();
  const first = await app.create();

  await first.setModel(new ModelRegistry(app.runtime).find("openrouter", "working-new")!);
  first.setThinkingLevel("high");
  await first.prompt("/reviewer add openrouter/vendor/review-next high");

  const fresh = await app.create();

  expect(fresh.model?.id).toBe("working-new");
  expect(fresh.thinkingLevel).toBe("high");
  expect(sessionServices(fresh).activeReviewers?.()).toEqual([previous, next]);
  await fresh.prompt("Check the restored choice.");
  expect(app.requests[0]).toMatchObject({ model: "working-new", reasoning: "high" });

  const resumed = await app.create(true);

  expect(resumed.model?.id).toBe("working-old");
  expect(resumed.thinkingLevel).toBe("low");
  expect(app.state.working()).toEqual({
    provider: "openrouter",
    model: "working-new",
    thinking: "high",
  });
  await fresh.prompt("/reviewer set openrouter/missing high");
  expect(app.state.reviewers()).toEqual([previous, next]);
  expect(app.notices.some((text) => text.includes("Model not found"))).toBe(true);
  await resumed.prompt("Continue the existing conversation.");
  expect(app.state.working()).toEqual({
    provider: "openrouter",
    model: "working-old",
    thinking: "low",
  });
});
