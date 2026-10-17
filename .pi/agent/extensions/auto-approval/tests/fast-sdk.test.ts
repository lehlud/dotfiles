import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import fastMode from "../../fast-mode/index.ts";
import { registerProviderRecovery } from "../../shared/providers/stream.ts";

test.each([
  ["openai", "openai-codex-responses"],
  ["openrouter", "openai-completions"],
])("real Pi applies /fast on/off only to subsequent %s requests", async (provider, api) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-fast-sdk-"));
  const requests: any[] = [];
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  runtime.registerProvider(provider, {
    api: api as any,
    apiKey: "synthetic",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "selected",
        name: "selected",
        reasoning: false,
        input: ["text"],
        contextWindow: 65536,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();

      void (async () => {
        const body = { model: model.id, provider: { only: ["trusted"] } };
        const payload = (await options?.onPayload?.(body, model)) ?? body;

        requests.push(payload);

        const message: any = {
          role: "assistant",
          api,
          provider,
          model: model.id,
          timestamp: Date.now(),
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };

        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      })();

      return stream;
    },
  });

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: [fastMode, (pi) => registerProviderRecovery(pi)],
  });

  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model: new ModelRegistry(runtime).find(provider, "selected")!,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(directory),
    settingsManager,
    resourceLoader,
    noTools: "all",
  });

  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: { setStatus() {}, notify() {} } as any,
    });
    await session.prompt("First request");
    await session.prompt("/fast on");
    expect(requests).toHaveLength(1);
    await session.prompt("Second request");
    await session.prompt("/fast off");
    await session.prompt("Third request");
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual(requests[2]);
    expect(requests[1]).toMatchObject(
      provider === "openai"
        ? { service_tier: "priority" }
        : { provider: { only: ["trusted"], sort: "throughput" } },
    );

    const users = session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.type === "message" && entry.message.role === "user");

    expect(JSON.stringify(users)).not.toContain("/fast");
    expect(requests.every((request) => request.model === "selected")).toBe(true);
  } finally {
    session.dispose();
    await rm(directory, { recursive: true, force: true });
  }

});
